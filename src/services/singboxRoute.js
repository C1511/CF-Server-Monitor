/**
 * sing-box 分流规则在线管理
 *
 * 面板只保存期望的 route 段（rules / rule_set / final 等），由被控服务器上以 root 运行的
 * singbox-agent.sh 每隔几秒向面板轮询：版本有变化时拉取 route，替换本机配置中的 route 段，
 * 执行 sing-box check 后重启服务，失败自动回滚，并把结果和当前配置摘要（入站/出站 tag、当前 route）回传。
 *
 * 面板不会拿到配置中的密码、证书等敏感字段：服务器只回传 inbounds/outbounds 的 tag 与类型，以及 route 段。
 */

const OPTIONS_KEY = 'singbox_route_options';
const DESIRED_KEY = 'singbox_route_desired';
const STATE_KEY = 'singbox_route_state';
export const MAX_ROUTE_BYTES = 256 * 1024;
export const MAX_REPORT_BYTES = 512 * 1024;
const MAX_EVENTS = 20;
const MAX_TAGS = 200;
const MAX_MESSAGE_LENGTH = 2000;
// 轮询非常频繁，"最后在线时间"最多每分钟写一次 D1
const SEEN_WRITE_INTERVAL_MS = 60 * 1000;
const TAG_PATTERN = /^[^\u0000-\u001f]{1,128}$/;
const REV_PATTERN = /^v\d{1,9}-[0-9a-f]{12}$/;

export function isValidServerId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

async function loadJson(db, key, fallback) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    console.error(`[singbox] 读取 ${key} 失败:`, e);
    return fallback;
  }
}

async function saveJson(db, key, value) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, JSON.stringify(value)).run();
}

export async function loadSingboxOptions(db) {
  const options = await loadJson(db, OPTIONS_KEY, {});
  return { server_id: isValidServerId(options.server_id) ? options.server_id : '' };
}

export async function loadSingboxDesired(db) {
  const desired = await loadJson(db, DESIRED_KEY, null);
  return desired?.route && REV_PATTERN.test(desired.rev || '') ? desired : null;
}

export async function loadSingboxState(db) {
  return { events: [], ...await loadJson(db, STATE_KEY, {}) };
}

// 指定运行 sing-box 的服务器；传空值关闭。
// 换服务器时清空上一台的状态和面板保存的 route（出站各不相同，不能下发给另一台）
export async function setSingboxServer(env, serverId) {
  const options = await loadSingboxOptions(env.DB);
  const next = serverId === null || serverId === undefined ? '' : String(serverId);
  if (next && !isValidServerId(next)) throw new Error('invalidServerId');
  if (next !== options.server_id) {
    await saveJson(env.DB, OPTIONS_KEY, { server_id: next });
    await saveJson(env.DB, STATE_KEY, { events: [] });
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(DESIRED_KEY).run();
  }
}

// ---------------- route 校验与规范化 ----------------

// 递归按 key 排序后序列化，用于比较内容是否一致
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function routeHash(route) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(route)));
  return Array.from(new Uint8Array(digest).slice(0, 6), b => b.toString(16).padStart(2, '0')).join('');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 收集 route 中引用的出站 tag（规则的 outbound、final、rule_set 的 download_detour）
export function referencedOutbounds(route) {
  const tags = new Set();
  if (typeof route.final === 'string' && route.final) tags.add(route.final);
  for (const rule of Array.isArray(route.rules) ? route.rules : []) {
    if (isPlainObject(rule) && typeof rule.outbound === 'string' && rule.outbound) tags.add(rule.outbound);
  }
  for (const set of Array.isArray(route.rule_set) ? route.rule_set : []) {
    if (isPlainObject(set) && typeof set.download_detour === 'string' && set.download_detour) tags.add(set.download_detour);
  }
  return [...tags];
}

/**
 * 校验面板提交的 route；sing-box check 不会检查出站 tag 是否存在（运行时才报错），
 * 所以在已知服务器出站列表时提前拦截写错的 tag
 */
export function validateRoute(route, knownOutbounds = []) {
  if (!isPlainObject(route)) return { valid: false, error: 'routeMustBeObject' };
  if (JSON.stringify(route).length > MAX_ROUTE_BYTES) return { valid: false, error: 'routeTooLarge' };
  if (route.rules !== undefined && (!Array.isArray(route.rules) || !route.rules.every(isPlainObject))) {
    return { valid: false, error: 'routeRulesInvalid' };
  }
  if (route.rule_set !== undefined && (!Array.isArray(route.rule_set) || !route.rule_set.every(isPlainObject))) {
    return { valid: false, error: 'routeRuleSetInvalid' };
  }
  if (route.final !== undefined && typeof route.final !== 'string') {
    return { valid: false, error: 'routeFinalInvalid' };
  }
  if (knownOutbounds.length) {
    const known = new Set(knownOutbounds);
    const unknown = referencedOutbounds(route).filter(tag => !known.has(tag));
    if (unknown.length) return { valid: false, error: 'routeUnknownOutbound', detail: unknown.join(', ') };
  }
  return { valid: true };
}

function pushEvent(state, event) {
  state.events = [event, ...(state.events || [])].slice(0, MAX_EVENTS);
}

// 后台保存期望的 route，生成新版本号；内容未变化时不生成新版本
export async function saveSingboxRoute(env, route, now = Date.now()) {
  const state = await loadSingboxState(env.DB);
  const known = Array.isArray(state.outbounds) ? state.outbounds.map(o => o.tag) : [];
  const result = validateRoute(route, known);
  if (!result.valid) {
    const error = new Error(result.error);
    error.detail = result.detail;
    throw error;
  }
  const hash = await routeHash(route);
  const desired = await loadSingboxDesired(env.DB);
  if (desired && desired.hash === hash && state.failed_rev !== desired.rev) return desired;
  const version = (desired?.version || 0) + 1;
  const next = { version, hash, rev: `v${version}-${hash}`, route, updated_at: now };
  await saveJson(env.DB, DESIRED_KEY, next);
  pushEvent(state, { at: now, type: 'config', rev: next.rev, message: 'saved' });
  await saveJson(env.DB, STATE_KEY, state);
  return next;
}

// ---------------- 服务器接口 ----------------

/**
 * 服务器轮询；调用方需先校验该服务器的上报密钥
 * 返回 { status: 204 } 表示无需变更；否则返回需要应用的 route
 */
export async function pollSingboxRoute(env, serverId, appliedRev, now = Date.now()) {
  const options = await loadSingboxOptions(env.DB);
  if (!options.server_id || options.server_id !== serverId) return { status: 403, error: 'not_selected' };

  const [desired, state] = await Promise.all([loadSingboxDesired(env.DB), loadSingboxState(env.DB)]);
  if (!state.seen_at || now - state.seen_at >= SEEN_WRITE_INTERVAL_MS) {
    state.seen_at = now;
    await saveJson(env.DB, STATE_KEY, state);
  }
  if (!desired || desired.rev === String(appliedRev || '').trim()) return { status: 204 };
  return { status: 200, rev: desired.rev, route: desired.route };
}

function cleanText(value, max = MAX_MESSAGE_LENGTH) {
  return String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '').slice(0, max);
}

function cleanTags(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(item => isPlainObject(item) && typeof item.tag === 'string' && TAG_PATTERN.test(item.tag))
    .slice(0, MAX_TAGS)
    .map(item => ({ tag: item.tag, type: cleanText(item.type, 32) }));
}

/**
 * 服务器回传：应用结果（event=apply）或配置摘要同步（event=sync）
 * body 为 JSON：{ event, rev, ok, message, singbox_version, config_path, inbounds, outbounds, route }
 */
export async function reportSingbox(env, serverId, bodyText, now = Date.now()) {
  const options = await loadSingboxOptions(env.DB);
  if (!options.server_id || options.server_id !== serverId) return { status: 403, error: 'not_selected' };
  if (String(bodyText || '').length > MAX_REPORT_BYTES) return { status: 413, error: 'too_large' };

  let report;
  try {
    report = JSON.parse(bodyText);
  } catch (_) {
    return { status: 400, error: 'invalid_json' };
  }
  if (!isPlainObject(report)) return { status: 400, error: 'invalid_json' };

  const state = await loadSingboxState(env.DB);
  state.seen_at = now;
  state.reported_at = now;
  state.singbox_version = cleanText(report.singbox_version, 64);
  state.config_path = cleanText(report.config_path, 256);
  state.inbounds = cleanTags(report.inbounds);
  state.outbounds = cleanTags(report.outbounds);
  if (isPlainObject(report.route)) {
    state.current_route = report.route;
    state.current_hash = await routeHash(report.route);
  } else {
    state.current_route = null;
    state.current_hash = '';
  }

  const rev = REV_PATTERN.test(String(report.rev || '')) ? report.rev : '';
  if (report.event === 'apply' && rev) {
    const message = cleanText(report.message);
    if (report.ok === true) {
      state.applied_rev = rev;
      state.applied_at = now;
      if (state.failed_rev === rev) state.failed_rev = '';
      state.error = '';
      pushEvent(state, { at: now, type: 'success', rev, message: message || 'applied' });
    } else {
      state.failed_rev = rev;
      state.error = message || 'apply failed';
      pushEvent(state, { at: now, type: 'error', rev, message: state.error });
    }
  } else if (report.event === 'sync' && report.message) {
    pushEvent(state, { at: now, type: 'sync', rev: '', message: cleanText(report.message, 200) });
  }

  await saveJson(env.DB, STATE_KEY, state);
  return { status: 200, ok: true };
}

// ---------------- 视图 ----------------

export async function buildSingboxAdminView(env) {
  const [options, desired, state] = await Promise.all([
    loadSingboxOptions(env.DB),
    loadSingboxDesired(env.DB),
    loadSingboxState(env.DB)
  ]);
  let sync = 'none';
  if (desired) {
    if (state.applied_rev === desired.rev) {
      sync = state.current_hash && state.current_hash !== desired.hash ? 'drift' : 'applied';
    } else if (state.failed_rev === desired.rev) {
      sync = 'failed';
    } else {
      sync = 'pending';
    }
  }
  return {
    config: options,
    desired,
    sync,
    state: {
      seen_at: state.seen_at || null,
      reported_at: state.reported_at || null,
      applied_rev: state.applied_rev || '',
      applied_at: state.applied_at || null,
      failed_rev: state.failed_rev || '',
      error: state.error || '',
      singbox_version: state.singbox_version || '',
      config_path: state.config_path || '',
      inbounds: state.inbounds || [],
      outbounds: state.outbounds || [],
      current_route: state.current_route || null,
      current_hash: state.current_hash || '',
      events: state.events || []
    }
  };
}
