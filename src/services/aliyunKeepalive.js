/**
 * 阿里云 ECS 保活（移植自独立的 aliyun-keepalive-worker）
 * CDT 非内地流量低于阈值时开机，达到阈值时关机；状态保存在 D1 settings 表，供前台和后台展示
 *
 * 环境变量：
 *   ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET  必填，务必以加密 Secret 方式配置
 *   ALIYUN_ECS_INSTANCE_ID                           必填
 *   ALIYUN_REGION_ID                                 默认 cn-hongkong
 *   ALIYUN_CDT_THRESHOLD_GB                          默认 190，可在后台覆盖（优先级：后台 > 环境变量 > 默认）
 *   ALIYUN_CHECK_INTERVAL_MINUTES                    默认 10（1-60）
 *   ALIYUN_BSS_ENDPOINT                              账单接口域名，默认 business.aliyuncs.com（国际站用 business.ap-southeast-1.aliyuncs.com）
 */
import { callApi } from '../utils/aliyunApi.js';
import { loadSiteSettings, normalizeBooleanSetting } from '../utils/settings.js';
import { sendNotification } from './notification.js';

const CDT_ENDPOINT = 'cdt.aliyuncs.com';
const CDT_VERSION = '2021-08-13';
const ECS_VERSION = '2014-05-26';
const BSS_VERSION = '2017-12-14';
const STATE_KEY = 'aliyun_keepalive_state';
const CONFIG_KEY = 'aliyun_keepalive_config';
export const DEFAULT_THRESHOLD_GB = 190;
export const MAX_THRESHOLD_GB = 100000;
const BILLING_INTERVAL_MS = 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_EVENTS = 30;
const WARN_PERCENT = 90;
const BYTES_PER_GB = 1024 ** 3;

export function getAliyunConfig(env = {}) {
  const accessKeyId = String(env.ALIYUN_ACCESS_KEY_ID || '').trim();
  const accessKeySecret = String(env.ALIYUN_ACCESS_KEY_SECRET || '').trim();
  const instanceId = String(env.ALIYUN_ECS_INSTANCE_ID || '').trim();
  const regionId = String(env.ALIYUN_REGION_ID || '').trim() || 'cn-hongkong';
  const thresholdRaw = String(env.ALIYUN_CDT_THRESHOLD_GB ?? '').trim();
  const thresholdGB = thresholdRaw === '' ? DEFAULT_THRESHOLD_GB : Number(thresholdRaw);
  const bssRaw = String(env.ALIYUN_BSS_ENDPOINT || '').trim().toLowerCase();
  // 只允许阿里云账单域名，避免签名请求被发往其他主机
  const bssEndpoint = /^business(\.[a-z0-9-]+)?\.aliyuncs\.com$/.test(bssRaw) ? bssRaw : 'business.aliyuncs.com';
  const interval = Number(env.ALIYUN_CHECK_INTERVAL_MINUTES);
  const intervalMinutes = Number.isInteger(interval) && interval >= 1 && interval <= 60 ? interval : 10;

  return {
    enabled: Boolean(accessKeyId && accessKeySecret && instanceId),
    accessKeyId,
    accessKeySecret,
    instanceId,
    regionId,
    thresholdGB,
    thresholdSource: thresholdRaw === '' ? 'default' : 'env',
    envThresholdGB: thresholdGB,
    intervalMinutes,
    bssEndpoint
  };
}

function maskAccessKeyId(id) {
  if (!id) return '';
  if (id.length <= 8) return '****';
  return `${id.slice(0, 4)}****${id.slice(-4)}`;
}

function roundGB(bytes) {
  return Math.round((bytes / BYTES_PER_GB) * 1000) / 1000;
}

// 与原保活脚本一致：香港及非 cn- 地域计入"非内地"，其余 cn- 地域单独计免费额度
function isNonMainlandRegion(region) {
  return !region.startsWith('cn-') || region === 'cn-hongkong';
}

export function summarizeCdtTraffic(data = {}) {
  const byRegion = new Map();
  for (const item of data.TrafficDetails || []) {
    const region = String(item?.BusinessRegionId || '');
    const bytes = Number(item?.Traffic) || 0;
    byRegion.set(region, (byRegion.get(region) || 0) + bytes);
  }

  let nonMainlandBytes = 0;
  let mainlandBytes = 0;
  const regions = [];
  for (const [region, bytes] of byRegion) {
    const nonMainland = isNonMainlandRegion(region);
    if (nonMainland) nonMainlandBytes += bytes;
    else mainlandBytes += bytes;
    regions.push({ region, gb: roundGB(bytes), non_mainland: nonMainland });
  }
  regions.sort((a, b) => b.gb - a.gb);

  return {
    non_mainland_gb: roundGB(nonMainlandBytes),
    mainland_gb: roundGB(mainlandBytes),
    regions
  };
}

export function summarizeInstance(instance = {}) {
  const publicIps = instance.PublicIpAddress?.IpAddress || [];
  return {
    instance_id: instance.InstanceId || '',
    name: instance.InstanceName || '',
    status: instance.Status || 'Unknown',
    instance_type: instance.InstanceType || '',
    cpu: Number(instance.Cpu) || 0,
    memory_mb: Number(instance.Memory) || 0,
    region: instance.RegionId || '',
    zone: instance.ZoneId || '',
    os: instance.OSName || '',
    public_ip: publicIps[0] || instance.EipAddress?.IpAddress || '',
    internet_charge_type: instance.InternetChargeType || '',
    instance_charge_type: instance.InstanceChargeType || '',
    bandwidth_out_mbps: Number(instance.InternetMaxBandwidthOut) || 0,
    stopped_mode: instance.StoppedMode || '',
    creation_time: instance.CreationTime || '',
    expired_time: instance.ExpiredTime || ''
  };
}

export function isValidThresholdGB(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_THRESHOLD_GB;
}

async function loadOverrides(db) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(CONFIG_KEY).first();
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.error('[aliyun] 读取保活配置失败:', e);
    return {};
  }
}

// 合并后台保存的覆盖配置
export async function resolveAliyunConfig(env) {
  const config = getAliyunConfig(env);
  const overrides = await loadOverrides(env.DB);
  if (isValidThresholdGB(overrides.threshold_gb)) {
    config.thresholdGB = Number(overrides.threshold_gb);
    config.thresholdSource = 'custom';
  }
  return config;
}

function parseAmount(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function summarizeAccountBalance(data = {}) {
  const d = data.Data || {};
  return {
    currency: d.Currency || 'CNY',
    available_amount: parseAmount(d.AvailableAmount),
    available_cash_amount: parseAmount(d.AvailableCashAmount),
    credit_amount: parseAmount(d.CreditAmount)
  };
}

// 按产品汇总本月账单：PretaxAmount 为优惠后应付，PretaxGrossAmount 为原价
export function summarizeBillOverview(data = {}) {
  const byProduct = new Map();
  for (const item of data.Data?.Items?.Item || []) {
    const name = item.ProductName || item.ProductCode || '-';
    const entry = byProduct.get(name) || { code: item.ProductCode || '', name, pretax_amount: 0, gross_amount: 0, coupon_amount: 0, outstanding_amount: 0 };
    entry.pretax_amount += parseAmount(item.PretaxAmount);
    entry.gross_amount += parseAmount(item.PretaxGrossAmount);
    entry.coupon_amount += parseAmount(item.DeductedByCoupons);
    entry.outstanding_amount += parseAmount(item.OutstandingAmount);
    byProduct.set(name, entry);
  }
  const products = [...byProduct.values()]
    .map(p => ({
      ...p,
      pretax_amount: round2(p.pretax_amount),
      gross_amount: round2(p.gross_amount),
      coupon_amount: round2(p.coupon_amount),
      outstanding_amount: round2(p.outstanding_amount)
    }))
    .filter(p => p.pretax_amount || p.gross_amount)
    .sort((a, b) => b.pretax_amount - a.pretax_amount || b.gross_amount - a.gross_amount);
  return {
    month_pretax_amount: round2(products.reduce((sum, p) => sum + p.pretax_amount, 0)),
    month_gross_amount: round2(products.reduce((sum, p) => sum + p.gross_amount, 0)),
    month_outstanding_amount: round2(products.reduce((sum, p) => sum + p.outstanding_amount, 0)),
    products
  };
}

function beijingMonth(now) {
  return new Date(now + BEIJING_OFFSET_MS).toISOString().slice(0, 7);
}

export function decideKeepaliveAction(status, usedGB, thresholdGB) {
  if (usedGB < thresholdGB) {
    return status === 'Stopped'
      ? { type: 'start', reason: `CDT ${usedGB.toFixed(2)} GB < 阈值 ${thresholdGB} GB` }
      : { type: 'none', reason: `CDT 未达阈值，实例状态 ${status}` };
  }
  return status === 'Running'
    ? { type: 'stop', reason: `CDT ${usedGB.toFixed(2)} GB ≥ 阈值 ${thresholdGB} GB` }
    : { type: 'none', reason: `CDT 已达阈值，实例状态 ${status}` };
}

function credentials(config) {
  return { accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret };
}

function callEcs(config, action, params) {
  return callApi({
    endpoint: `ecs.${config.regionId}.aliyuncs.com`,
    version: ECS_VERSION,
    action,
    params: { RegionId: config.regionId, ...params },
    ...credentials(config)
  });
}

async function callBss(config, action, params = {}) {
  const data = await callApi({
    endpoint: config.bssEndpoint,
    version: BSS_VERSION,
    action,
    params,
    ...credentials(config)
  });
  // 账单接口出错时也可能返回 HTTP 200
  if (data?.Success === false) {
    throw new Error(`${action} 调用失败: ${data.Code} - ${data.Message}`);
  }
  return data;
}

async function fetchBilling(config, now) {
  const billingCycle = beijingMonth(now);
  const [balance, overview] = await Promise.all([
    callBss(config, 'QueryAccountBalance'),
    callBss(config, 'QueryBillOverview', { BillingCycle: billingCycle })
  ]);
  return {
    checked_at: now,
    billing_cycle: billingCycle,
    ...summarizeAccountBalance(balance),
    ...summarizeBillOverview(overview)
  };
}

async function fetchCdtTraffic(config) {
  const data = await callApi({
    endpoint: CDT_ENDPOINT,
    version: CDT_VERSION,
    action: 'ListCdtInternetTraffic',
    ...credentials(config)
  });
  return summarizeCdtTraffic(data);
}

async function fetchInstance(config) {
  const data = await callEcs(config, 'DescribeInstances', {
    InstanceIds: JSON.stringify([config.instanceId])
  });
  const instance = data.Instances?.Instance?.[0];
  if (!instance) {
    throw new Error(`未找到 ECS 实例 ${config.instanceId}`);
  }
  return summarizeInstance(instance);
}

export async function loadKeepaliveState(db) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(STATE_KEY).first();
    const parsed = row?.value ? JSON.parse(row.value) : null;
    if (parsed && typeof parsed === 'object') {
      return { events: [], ...parsed };
    }
  } catch (e) {
    console.error('[aliyun] 读取保活状态失败:', e);
  }
  return { events: [], paused: false };
}

async function saveKeepaliveState(db, state) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(STATE_KEY, JSON.stringify(state)).run();
}

function addEvent(state, event) {
  state.events = [event, ...(state.events || [])].slice(0, MAX_EVENTS);
}

function hasNotificationChannel(settings) {
  if (normalizeBooleanSetting(settings?.notification_webhook_enabled) === 'true') {
    return Boolean(String(settings?.notification_webhook_url || '').trim());
  }
  return Boolean(String(settings?.tg_bot_token || '').trim());
}

async function notify(env, title, emoji, message, instanceName) {
  try {
    const settings = await loadSiteSettings(env.DB);
    if (!hasNotificationChannel(settings)) return;
    const err = await sendNotification(settings, message, {
      event: title,
      emoji,
      clients: [instanceName || '阿里云 ECS'],
      count: 1,
      message
    });
    if (err) console.warn('[aliyun] 通知发送失败:', err);
  } catch (e) {
    console.error('[aliyun] 通知发送异常:', e);
  }
}

function monthKey(now) {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * 执行一次保活检查
 * @param {object} options.apply   是否按规则开关机；false 时只刷新数据
 * @param {string} options.trigger cron | manual
 */
export async function runAliyunKeepalive(env, { apply = true, trigger = 'cron', now = Date.now(), forceBilling = false } = {}) {
  if (!getAliyunConfig(env).enabled) return { enabled: false };
  const config = await resolveAliyunConfig(env);

  const state = await loadKeepaliveState(env.DB);
  state.attempted_at = now;

  try {
    if (!Number.isFinite(config.thresholdGB) || config.thresholdGB <= 0) {
      throw new Error(`ALIYUN_CDT_THRESHOLD_GB 配置无效: ${env.ALIYUN_CDT_THRESHOLD_GB}`);
    }

    const [cdt, ecs] = await Promise.all([fetchCdtTraffic(config), fetchInstance(config)]);
    const usedGB = cdt.non_mainland_gb;
    const percent = Math.round((usedGB / config.thresholdGB) * 1000) / 10;
    state.cdt = { ...cdt, threshold_gb: config.thresholdGB, percent };
    state.ecs = ecs;
    state.checked_at = now;
    state.error = '';

    // 每月首次达到 90% 时提醒一次
    const month = monthKey(now);
    if (percent >= WARN_PERCENT && percent < 100 && state.warned_month !== month) {
      state.warned_month = month;
      const message = `CDT 非内地流量已用 ${usedGB.toFixed(2)} GB，达到阈值 ${config.thresholdGB} GB 的 ${percent}%`;
      addEvent(state, { at: now, type: 'warn', trigger, message });
      await notify(env, '阿里云 CDT 流量预警', '⚠️', message, ecs.name);
    }

    if (!apply) {
      state.last_decision = { type: 'none', reason: '仅刷新数据' };
    } else if (state.paused) {
      state.last_decision = { type: 'none', reason: '自动保活已暂停' };
    } else {
      const decision = decideKeepaliveAction(ecs.status, usedGB, config.thresholdGB);
      state.last_decision = decision;

      if (decision.type === 'start') {
        await callEcs(config, 'StartInstances', { 'InstanceId.1': config.instanceId });
        state.ecs.status = 'Starting';
      } else if (decision.type === 'stop') {
        await callEcs(config, 'StopInstances', { 'InstanceId.1': config.instanceId, ForceStop: 'false' });
        state.ecs.status = 'Stopping';
      }

      if (decision.type !== 'none') {
        const verb = decision.type === 'start' ? '已启动' : '已停止';
        const message = `${verb} ECS ${ecs.name || config.instanceId}：${decision.reason}`;
        state.last_action = { type: decision.type, at: now, trigger, reason: decision.reason };
        addEvent(state, { at: now, type: decision.type, trigger, message });
        await notify(env, decision.type === 'start' ? '阿里云 ECS 已开机' : '阿里云 ECS 已关机', decision.type === 'start' ? '▶️' : '⏹️', message, ecs.name);
      }
    }
  } catch (e) {
    const message = e?.message || String(e);
    console.error('[aliyun] 保活检查失败:', message);
    // 同一错误只记录、通知一次，避免每 10 分钟刷屏
    if (state.error !== message) {
      addEvent(state, { at: now, type: 'error', trigger, message });
      await notify(env, '阿里云保活检查失败', '❌', message, state.ecs?.name);
    }
    state.error = message;
    state.error_at = now;
  }

  // 账单数据每小时更新一次；失败不影响保活，也不推送通知
  if (forceBilling || !state.billing_attempted_at || now - Number(state.billing_attempted_at) >= BILLING_INTERVAL_MS) {
    state.billing_attempted_at = now;
    try {
      state.billing = await fetchBilling(config, now);
      state.billing_error = '';
    } catch (e) {
      state.billing_error = e?.message || String(e);
      console.error('[aliyun] 账单查询失败:', state.billing_error);
    }
  }

  await saveKeepaliveState(env.DB, state);
  return state;
}

// 由每分钟的 Cron 调用，按配置间隔执行
export async function runAliyunKeepaliveIfDue(env, now = Date.now()) {
  const config = getAliyunConfig(env);
  if (!config.enabled) return null;
  const state = await loadKeepaliveState(env.DB);
  const elapsed = now - Number(state.attempted_at || 0);
  // 留 30 秒余量，避免 Cron 触发时间抖动导致跳过一轮
  if (elapsed < config.intervalMinutes * 60000 - 30000) return null;
  return runAliyunKeepalive(env, { trigger: 'cron', now });
}

export async function setAliyunKeepalivePaused(env, paused, now = Date.now()) {
  const state = await loadKeepaliveState(env.DB);
  if (Boolean(state.paused) !== Boolean(paused)) {
    state.paused = Boolean(paused);
    addEvent(state, {
      at: now,
      type: paused ? 'pause' : 'resume',
      trigger: 'manual',
      message: paused ? '已暂停自动保活' : '已恢复自动保活'
    });
    await saveKeepaliveState(env.DB, state);
  }
  return state;
}

/**
 * 后台修改阈值；传 null 恢复为环境变量/默认值
 * 修改后立即重算已保存的用量百分比，开关机在下一次检查时按新阈值执行
 */
export async function setAliyunThreshold(env, value, now = Date.now()) {
  const before = await resolveAliyunConfig(env);
  const overrides = await loadOverrides(env.DB);
  if (value === null || value === undefined || value === '') {
    delete overrides.threshold_gb;
  } else {
    if (!isValidThresholdGB(value)) {
      throw new Error('invalidThreshold');
    }
    overrides.threshold_gb = Math.round(Number(value) * 100) / 100;
  }
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(CONFIG_KEY, JSON.stringify(overrides)).run();

  const after = await resolveAliyunConfig(env);
  const state = await loadKeepaliveState(env.DB);
  if (after.thresholdGB !== before.thresholdGB) {
    if (state.cdt) {
      state.cdt.threshold_gb = after.thresholdGB;
      state.cdt.percent = Math.round((state.cdt.non_mainland_gb / after.thresholdGB) * 1000) / 10;
    }
    addEvent(state, {
      at: now,
      type: 'config',
      trigger: 'manual',
      message: `阈值 ${before.thresholdGB} GB → ${after.thresholdGB} GB`
    });
    await saveKeepaliveState(env.DB, state);
  }
  return { config: after, state };
}

// 后台完整视图（仍不返回 AccessKey Secret）；config 为 resolveAliyunConfig 的结果
export function buildAdminView(config, state) {
  return {
    enabled: config.enabled,
    config: {
      region_id: config.regionId,
      instance_id: config.instanceId,
      threshold_gb: config.thresholdGB,
      threshold_source: config.thresholdSource,
      env_threshold_gb: config.envThresholdGB,
      default_threshold_gb: DEFAULT_THRESHOLD_GB,
      interval_minutes: config.intervalMinutes,
      access_key_id: maskAccessKeyId(config.accessKeyId),
      has_access_key_secret: Boolean(config.accessKeySecret)
    },
    state: state || null
  };
}

// 前台摘要：不含实例 ID、公网 IP、AccessKey 和错误详情
export function buildPublicView(env, state, { includeBilling = false } = {}) {
  const config = getAliyunConfig(env);
  if (!config.enabled || !state?.cdt) {
    return { enabled: config.enabled, ready: false };
  }
  return {
    enabled: true,
    ready: true,
    checked_at: state.checked_at || null,
    paused: Boolean(state.paused),
    has_error: Boolean(state.error),
    cdt: {
      used_gb: state.cdt.non_mainland_gb,
      mainland_gb: state.cdt.mainland_gb,
      threshold_gb: state.cdt.threshold_gb,
      percent: state.cdt.percent
    },
    ecs: state.ecs ? {
      status: state.ecs.status,
      instance_type: state.ecs.instance_type,
      cpu: state.ecs.cpu,
      memory_mb: state.ecs.memory_mb,
      region: state.ecs.region
    } : null,
    last_action: state.last_action ? { type: state.last_action.type, at: state.last_action.at } : null,
    // 账户余额与消费仅对已登录管理员返回
    billing: includeBilling && state.billing ? {
      currency: state.billing.currency,
      available_amount: state.billing.available_amount,
      month_pretax_amount: state.billing.month_pretax_amount,
      checked_at: state.billing.checked_at
    } : null
  };
}
