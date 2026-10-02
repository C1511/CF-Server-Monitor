/**
 * NodeSeek 每日签到（移植自独立的 nodeseek-signin-worker）
 * 直接 POST /api/attendance?random=true（"试试手气"），以返回结果为准；接口本身幂等，一天只会成功一次
 * "检查状态"使用 GET /api/attendance/board，只查询不签到
 *
 * Cookie 来源（优先级从高到低）：
 *   1. 后台「自动任务」中粘贴的 Cookie（AES-GCM 加密后存入 D1，密钥由 API_SECRET 派生）
 *   2. 环境变量 NS_COOKIE（加密 Secret）
 *
 * 代发模式：NodeSeek 已关闭 IPv6 访问，而 Workers 只能以 IPv6 发出请求。
 * 在后台指定一台服务器作为"代发服务器"后，由该服务器上的 ns-relay.sh 按时向面板领取任务、
 * 用 IPv4 发起签到并回传原始响应；结果判定、记录和通知仍在面板完成。
 *
 * 其他环境变量：
 *   NS_SIGNIN_TIME    每日签到时间（北京时间 HH:MM），默认 08:37
 *   NS_SIGNIN_RANDOM  是否使用"试试手气"，默认 true；false 时为固定奖励
 */
import { loadSiteSettings, normalizeBooleanSetting } from '../utils/settings.js';
import { sendNotification } from './notification.js';

const NS_ORIGIN = 'https://www.nodeseek.com';
const STATE_KEY = 'nodeseek_signin_state';
const COOKIE_KEY = 'nodeseek_signin_cookie';
const OPTIONS_KEY = 'nodeseek_signin_options';
const MAX_RELAY_BODY = 64 * 1024;
const MAX_HISTORY = 30;
const MAX_ATTEMPTS_PER_DAY = 3;
const MAX_COOKIE_LENGTH = 8192;
const RETRY_INTERVAL_MS = 30 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// 失败类型：cookie_invalid 需要更新 Cookie；blocked 为风控/人机验证拦截；error 为其他错误
export const FAILURE_KINDS = ['cookie_invalid', 'blocked', 'error'];

function parseSchedule(env) {
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(env.NS_SIGNIN_TIME || '').trim());
  if (timeMatch && Number(timeMatch[1]) < 24 && Number(timeMatch[2]) < 60) {
    return { hour: Number(timeMatch[1]), minute: Number(timeMatch[2]) };
  }
  return { hour: 8, minute: 37 };
}

export function getSigninConfig(env = {}) {
  const cookie = String(env.NS_COOKIE || '').trim();
  return {
    enabled: Boolean(cookie),
    cookie,
    cookieSource: cookie ? 'env' : '',
    ...parseSchedule(env),
    random: String(env.NS_SIGNIN_RANDOM ?? 'true').trim().toLowerCase() !== 'false'
  };
}

// ---------------- 后台保存的 Cookie（加密存储） ----------------

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

async function cookieKey(apiSecret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cfsm-ns-cookie-v1:${apiSecret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptCookie(apiSecret, cookie) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cookieKey(apiSecret), new TextEncoder().encode(cookie));
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(data)) };
}

async function decryptCookie(apiSecret, stored) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(stored.iv) },
    await cookieKey(apiSecret),
    base64ToBytes(stored.data)
  );
  return new TextDecoder().decode(plain);
}

async function loadStoredCookie(db) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(COOKIE_KEY).first();
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return parsed?.iv && parsed?.data ? parsed : null;
  } catch (e) {
    console.error('[nodeseek] 读取 Cookie 失败:', e);
    return null;
  }
}

async function loadSigninOptions(db) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(OPTIONS_KEY).first();
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.error('[nodeseek] 读取签到配置失败:', e);
    return {};
  }
}

export function isValidServerId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// 指定代发服务器；传空值关闭代发模式，恢复由 Worker 直接签到
export async function setSigninRelay(env, serverId) {
  const options = await loadSigninOptions(env.DB);
  if (serverId === null || serverId === undefined || serverId === '') {
    delete options.relay_server_id;
  } else {
    if (!isValidServerId(serverId)) throw new Error('invalidServerId');
    options.relay_server_id = serverId;
  }
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(OPTIONS_KEY, JSON.stringify(options)).run();
  return loadSigninState(env.DB);
}

// 合并后台保存的 Cookie；解密失败（例如 API_SECRET 已更换）时回退到环境变量
export async function resolveSigninConfig(env) {
  const config = getSigninConfig(env);
  const options = await loadSigninOptions(env.DB);
  config.relayServerId = isValidServerId(options.relay_server_id) ? options.relay_server_id : '';
  const stored = await loadStoredCookie(env.DB);
  config.cookieUpdatedAt = stored?.updated_at || null;
  config.storedCookieUnreadable = false;
  if (stored && env.API_SECRET) {
    try {
      const cookie = (await decryptCookie(env.API_SECRET, stored)).trim();
      if (cookie) {
        config.cookie = cookie;
        config.cookieSource = 'admin';
        config.enabled = true;
      }
    } catch (_) {
      config.storedCookieUnreadable = true;
    }
  }
  return config;
}

function normalizeCookieInput(cookie) {
  const value = String(cookie ?? '').trim().replace(/^cookie:\s*/i, '');
  if (value.length > MAX_COOKIE_LENGTH || /[\r\n]/.test(value)) {
    throw new Error('invalidCookie');
  }
  return value;
}

async function storeCookie(env, value, now) {
  if (value) {
    const encrypted = await encryptCookie(env.API_SECRET, value);
    await env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind(COOKIE_KEY, JSON.stringify({ ...encrypted, updated_at: now })).run();
  } else {
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(COOKIE_KEY).run();
  }
}

// 后台更新 Cookie；传空值则删除，回退到环境变量
export async function setSigninCookie(env, cookie, now = Date.now()) {
  const value = normalizeCookieInput(cookie);
  await storeCookie(env, value, now);

  // 换了 Cookie 后清除失效标记，并重置今日尝试次数，让定时任务重新尝试
  const state = await loadSigninState(env.DB);
  state.login_invalid = false;
  state.failure_kind = '';
  state.error = '';
  if (state.attempts?.date === beijingDate(now)) {
    state.attempts = { date: state.attempts.date, count: 0 };
  }
  await saveSigninState(env.DB, state);
  return state;
}

// ---------------- 请求与结果判定 ----------------

export function beijingDate(now) {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function beijingMinutesOfDay(now) {
  const d = new Date(now + BEIJING_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function formatTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// cf_clearance 等 Cloudflare 验证 Cookie 绑定浏览器的 IP 与 User-Agent，从 Workers 发出时不匹配，
// 带上反而容易触发人机验证，因此发送前剔除，只保留站点自身的登录 Cookie
const CLOUDFLARE_COOKIE_RE = /^(cf_clearance|__cf_bm|__cflb|_cfuvid|cf_chl_\w*)$/i;

export function sanitizeCookie(cookie) {
  return String(cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part && !CLOUDFLARE_COOKIE_RE.test(part.split('=')[0].trim()))
    .join('; ');
}

function nsHeaders(config) {
  return {
    Cookie: sanitizeCookie(config.cookie),
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Origin: NS_ORIGIN,
    Referer: `${NS_ORIGIN}/board`
  };
}

class SigninError extends Error {
  constructor(message, kind = 'error') {
    super(message);
    this.kind = kind;
  }
}

function htmlTitle(text) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  return match ? match[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

// 非 JSON 响应：区分 Cloudflare 人机验证页与其他页面，并带上页面标题便于排查
export function classifyHtmlResponse(status, text) {
  const title = htmlTitle(text);
  const isChallenge = /just a moment|attention required|cf-chl|challenge-platform|cf_chl_opt|turnstile/i.test(text)
    || /just a moment|attention required|请稍候|安全验证|人机验证/i.test(title);
  const label = title ? `「${title}」` : '(无标题)';
  if (isChallenge) {
    return new SigninError(`被 NodeSeek / Cloudflare 风控拦截，返回了人机验证页 ${label} (HTTP ${status})`, 'blocked');
  }
  if (status === 401 || /登录|sign ?in|login/i.test(title)) {
    return new SigninError(`登录已失效，返回了登录页 ${label} (HTTP ${status})`, 'cookie_invalid');
  }
  return new SigninError(`返回了网页而不是接口数据 ${label} (HTTP ${status})，可能被拦截或接口有变化`, 'blocked');
}

function isAuthMessage(message) {
  return /USER NOT FOUND|未登录|登录|login|unauthori[sz]ed|未授权/i.test(String(message || ''));
}

function isRiskMessage(message) {
  return /high risk|risk|风控|验证/i.test(String(message || ''));
}

async function requestJson(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw classifyHtmlResponse(resp.status, text);
  }
  if (resp.status === 401 || resp.status === 403) {
    const message = data?.message || `HTTP ${resp.status}`;
    throw new SigninError(`请求被拒绝：${message}`, isAuthMessage(message) || resp.status === 401 ? 'cookie_invalid' : 'blocked');
  }
  return data;
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// board 返回 record 表示今日已有签到记录（仅"检查状态"使用）
export function parseBoard(data) {
  if (data?.success === false) {
    const message = data.message || '未知错误';
    throw new SigninError(`查询签到状态失败：${message}`, isAuthMessage(message) ? 'cookie_invalid' : 'error');
  }
  const record = data?.record && typeof data.record === 'object' ? data.record : null;
  return {
    signed: Boolean(record),
    gain: toNumberOrNull(record?.gain),
    rank: toNumberOrNull(record?.rank)
  };
}

export function parseAttendance(data) {
  const message = String(data?.message || '');
  if (data?.success === true) {
    return { status: 'success', gain: toNumberOrNull(data.gain), current: toNumberOrNull(data.current), message };
  }
  if (/已完成签到|已经签到|已签到|重复/.test(message)) {
    return { status: 'already', gain: toNumberOrNull(data?.gain), current: toNumberOrNull(data?.current), message };
  }
  if (isAuthMessage(message)) {
    throw new SigninError(`登录已失效：${message}`, 'cookie_invalid');
  }
  if (isRiskMessage(message)) {
    throw new SigninError(`签到被风控拦截：${message}`, 'blocked');
  }
  throw new SigninError(`签到失败：${message || '未知错误'}`, 'error');
}

// 接口返回 3xx 时按跳转目标判断原因（页面标题只有 "303 See Other"，不足以判断）
export function classifyRedirect(status, location) {
  const target = String(location || '').trim().slice(0, 200);
  const where = target ? `跳转到 ${target}` : '未提供跳转地址';
  if (/sign_?in|login|登录/i.test(target)) {
    return new SigninError(`登录已失效：接口返回 HTTP ${status}，${where}`, 'cookie_invalid');
  }
  if (/challenge|cdn-cgi|captcha|verify|turnstile|risk|block/i.test(target)) {
    return new SigninError(`被风控拦截：接口返回 HTTP ${status}，${where}`, 'blocked');
  }
  return new SigninError(`接口返回 HTTP ${status} 重定向，${where}`, 'error');
}

// 解读签到接口的原始响应（Worker 直连与服务器代发共用）
export function interpretAttendanceResponse(status, text, { location = '' } = {}) {
  if (status >= 300 && status < 400) {
    throw classifyRedirect(status, location);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw classifyHtmlResponse(status, text);
  }
  if (status === 401 || status === 403) {
    const message = data?.message || `HTTP ${status}`;
    throw new SigninError(`请求被拒绝：${message}`, isAuthMessage(message) || status === 401 ? 'cookie_invalid' : 'blocked');
  }
  return parseAttendance(data);
}

// ---------------- 状态 ----------------

export async function loadSigninState(db) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(STATE_KEY).first();
    const parsed = row?.value ? JSON.parse(row.value) : null;
    if (parsed && typeof parsed === 'object') return { history: [], ...parsed };
  } catch (e) {
    console.error('[nodeseek] 读取签到状态失败:', e);
  }
  return { history: [] };
}

async function saveSigninState(db, state) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(STATE_KEY, JSON.stringify(state)).run();
}

function upsertHistory(state, entry) {
  const history = (state.history || []).filter(item => item.date !== entry.date);
  state.history = [entry, ...history].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_HISTORY);
}

async function notifyFailure(env, message) {
  try {
    const settings = await loadSiteSettings(env.DB);
    const webhook = normalizeBooleanSetting(settings?.notification_webhook_enabled) === 'true'
      && String(settings?.notification_webhook_url || '').trim();
    if (!webhook && !String(settings?.tg_bot_token || '').trim()) return;
    const err = await sendNotification(settings, message, {
      event: 'NodeSeek 签到失败',
      emoji: '❌',
      clients: ['NodeSeek'],
      count: 1,
      message
    });
    if (err) console.warn('[nodeseek] 通知发送失败:', err);
  } catch (e) {
    console.error('[nodeseek] 通知发送异常:', e);
  }
}

function startAttempt(state, date, now, { countAttempt }) {
  if (state.attempts?.date !== date) {
    state.attempts = { date, count: 0 };
  }
  if (countAttempt) {
    state.attempts.count += 1;
  }
  state.attempts.last_at = now;
  state.last_checked_at = now;
}

function recordSuccess(state, date, result, now, trigger) {
  state.today = { date, ...result, rank: result.rank ?? null, at: now, trigger };
  state.login_invalid = false;
  state.failure_kind = '';
  state.error = '';
  if (state.today.status === 'success' || state.today.status === 'already') {
    upsertHistory(state, { date, status: state.today.status, gain: state.today.gain });
  }
}

async function recordFailure(env, state, error, { date, now, trigger, dryRun, relay = false }) {
  const message = error?.message || String(error);
  const kind = FAILURE_KINDS.includes(error?.kind) ? error.kind : 'error';
  console.error('[nodeseek] 签到失败:', kind, message);
  state.login_invalid = kind === 'cookie_invalid';
  state.failure_kind = kind;
  if (!dryRun) {
    state.today = { date, status: 'failed', gain: null, rank: null, current: null, message, at: now, trigger };
    upsertHistory(state, { date, status: 'failed', gain: null });
    // 同一错误只通知一次
    if (state.error !== message) {
      const hint = kind === 'cookie_invalid'
        ? '\n请在后台「自动任务」中粘贴新的 Cookie'
        : (kind === 'blocked'
          ? (relay ? '\n代发服务器的 IP 也被风控，Cookie 不一定失效' : '\nWorkers 出口 IP 可能被风控，Cookie 不一定失效')
          : '');
      await notifyFailure(env, `${message}${hint}`);
    }
  }
  state.error = message;
  return kind;
}

/**
 * 由 Worker 直接执行一次签到（未启用代发模式时）
 * @param {boolean} options.dryRun 只查询今日状态，不签到
 */
export async function runNodeseekSignin(env, { dryRun = false, trigger = 'cron', now = Date.now() } = {}) {
  const config = await resolveSigninConfig(env);
  if (!config.enabled) return { enabled: false };

  const state = await loadSigninState(env.DB);
  const date = beijingDate(now);
  startAttempt(state, date, now, { countAttempt: !dryRun });

  try {
    if (dryRun) {
      const board = parseBoard(await requestJson(`${NS_ORIGIN}/api/attendance/board?page=1`, {
        headers: nsHeaders(config)
      }));
      const previous = state.today?.date === date ? state.today : null;
      if (board.signed) {
        recordSuccess(state, date, {
          status: previous?.status === 'success' ? 'success' : 'already',
          gain: board.gain ?? previous?.gain ?? null,
          rank: board.rank,
          current: previous?.current ?? null,
          message: previous?.message || '今日已签到'
        }, previous?.at || now, previous?.trigger || trigger);
      } else {
        recordSuccess(state, date, { status: 'pending', gain: null, current: null, message: 'Cookie 有效，今日尚未签到' }, now, trigger);
      }
    } else {
      const resp = await fetch(`${NS_ORIGIN}/api/attendance?random=${config.random}`, {
        method: 'POST',
        headers: nsHeaders(config)
      });
      recordSuccess(state, date, interpretAttendanceResponse(resp.status, await resp.text()), now, trigger);
    }
  } catch (e) {
    await recordFailure(env, state, e, { date, now, trigger, dryRun });
  }

  await saveSigninState(env.DB, state);
  return state;
}

// 由每分钟的 Cron 调用：到点后签到，失败每 30 分钟重试，每天最多 3 次
export async function runNodeseekSigninIfDue(env, now = Date.now()) {
  const config = await resolveSigninConfig(env);
  if (!config.enabled || config.relayServerId) return null;
  if (beijingMinutesOfDay(now) < config.hour * 60 + config.minute) return null;

  const state = await loadSigninState(env.DB);
  const date = beijingDate(now);
  if (state.today?.date === date && ['success', 'already'].includes(state.today.status)) return null;

  const attempts = state.attempts?.date === date ? state.attempts : { count: 0 };
  if (attempts.count >= MAX_ATTEMPTS_PER_DAY) return null;
  if (attempts.last_at && now - attempts.last_at < RETRY_INTERVAL_MS && attempts.count > 0) return null;

  return runNodeseekSignin(env, { trigger: 'cron', now });
}

// ---------------- 代发服务器接口 ----------------

/**
 * 代发服务器领取任务；调用方需先校验该服务器的上报密钥
 * @param {boolean} options.force 手动执行时忽略签到时间（仍不会重复签到）
 */
export async function getRelayTask(env, serverId, { force = false, now = Date.now() } = {}) {
  const config = await resolveSigninConfig(env);
  if (!config.relayServerId || config.relayServerId !== serverId) return { due: false, reason: 'not_relay' };
  if (!config.enabled) return { due: false, reason: 'no_cookie' };

  const state = await loadSigninState(env.DB);
  const date = beijingDate(now);
  state.relay_seen_at = now;
  await saveSigninState(env.DB, state);

  if (state.today?.date === date && ['success', 'already'].includes(state.today.status)) {
    return { due: false, reason: 'done' };
  }
  const attempts = state.attempts?.date === date ? state.attempts.count : 0;
  // 手动 --force 执行用于排查，不受每日次数上限限制
  if (!force && attempts >= MAX_ATTEMPTS_PER_DAY) return { due: false, reason: 'max_attempts' };
  if (!force && beijingMinutesOfDay(now) < config.hour * 60 + config.minute) return { due: false, reason: 'too_early' };

  return { due: true, cookie: sanitizeCookie(config.cookie), random: config.random, attempt: attempts + 1 };
}

// 代发服务器回传 NodeSeek 的原始响应，由面板判定结果
export async function reportRelayResult(env, serverId, httpStatus, body, now = Date.now(), { location = '', refreshedCookie = '' } = {}) {
  const config = await resolveSigninConfig(env);
  if (!config.relayServerId || config.relayServerId !== serverId) {
    return { done: false, retry: false, kind: 'error', message: '该服务器不是签到代发服务器' };
  }

  const state = await loadSigninState(env.DB);
  const date = beijingDate(now);
  startAttempt(state, date, now, { countAttempt: true });
  state.relay_reported_at = now;

  let kind = '';
  try {
    const status = Number(httpStatus);
    if (!Number.isInteger(status) || status <= 0) {
      throw new SigninError(`代发服务器请求 NodeSeek 失败：${String(body || '').slice(0, 200) || '无响应'}`, 'error');
    }
    recordSuccess(state, date, interpretAttendanceResponse(status, String(body || '').slice(0, MAX_RELAY_BODY), { location }), now, 'relay');
  } catch (e) {
    kind = await recordFailure(env, state, e, { date, now, trigger: 'relay', dryRun: false, relay: true });
  }
  const done = ['success', 'already'].includes(state.today?.status);
  // 只在签到成功时采用刷新后的 Cookie，避免用异常响应里的 Cookie 覆盖可用的旧值
  if (done && refreshedCookie) {
    try {
      const value = normalizeCookieInput(refreshedCookie);
      if (value && value !== config.cookie) {
        await storeCookie(env, value, now);
        state.cookie_refreshed_at = now;
      }
    } catch (e) {
      console.warn('[nodeseek] 忽略无效的刷新 Cookie:', e?.message || e);
    }
  }
  await saveSigninState(env.DB, state);

  return {
    done,
    retry: !done && kind !== 'cookie_invalid' && state.attempts.count < MAX_ATTEMPTS_PER_DAY,
    kind: done ? state.today.status : kind,
    message: state.today?.message || ''
  };
}

// 代发脚本使用的纯文本格式：每行 key=value，值中不含换行
export function formatRelayText(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, ' ')}`)
    .join('\n') + '\n';
}

// ---------------- 视图 ----------------

function recentHistory(state, now, days) {
  const byDate = new Map((state?.history || []).map(item => [item.date, item]));
  const list = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = beijingDate(now - i * 86400000);
    const item = byDate.get(date);
    list.push({ date, status: item?.status || 'none', gain: item?.gain ?? null });
  }
  return list;
}

function streakDays(history) {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const status = history[i].status;
    if (status === 'success' || status === 'already') {
      streak++;
    } else if (i === history.length - 1 && status === 'none') {
      continue; // 今天还没到签到时间，不打断连续天数
    } else {
      break;
    }
  }
  return streak;
}

function buildTodayView(state, date) {
  if (state?.today?.date === date) {
    return { status: state.today.status, gain: state.today.gain, current: state.today.current, at: state.today.at };
  }
  return { status: 'none', gain: null, current: null, at: null };
}

// config 为 resolveSigninConfig 的结果
export function buildSigninPublicView(config, state, now = Date.now()) {
  if (!config?.enabled) return { enabled: false };
  const history = recentHistory(state, now, 14);
  const monthPrefix = beijingDate(now).slice(0, 7);
  const monthGain = (state?.history || [])
    .filter(item => item.date.startsWith(monthPrefix) && Number.isFinite(item.gain))
    .reduce((sum, item) => sum + item.gain, 0);
  return {
    enabled: true,
    schedule: formatTime(config.hour, config.minute),
    today: buildTodayView(state, beijingDate(now)),
    history,
    streak: streakDays(history),
    month_gain: monthGain,
    login_invalid: Boolean(state?.login_invalid),
    failure_kind: state?.failure_kind || ''
  };
}

export function buildSigninAdminView(config, state, now = Date.now()) {
  return {
    ...buildSigninPublicView(config, state, now),
    enabled: Boolean(config?.enabled),
    config: {
      schedule: `${formatTime(config.hour, config.minute)}（北京时间）`,
      random: config.random,
      has_cookie: Boolean(config.cookie),
      cookie_source: config.cookieSource || '',
      cookie_updated_at: config.cookieUpdatedAt || null,
      stored_cookie_unreadable: Boolean(config.storedCookieUnreadable),
      relay_server_id: config.relayServerId || ''
    },
    relay_seen_at: state?.relay_seen_at || null,
    relay_reported_at: state?.relay_reported_at || null,
    detail: state?.today || null,
    attempts: state?.attempts || null,
    error: state?.error || '',
    last_checked_at: state?.last_checked_at || null,
    history_30: state?.history || []
  };
}
