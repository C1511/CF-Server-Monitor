/**
 * NodeSeek 每日签到（移植自独立的 nodeseek-signin-worker）
 * 先查 GET /api/attendance/board 确认今日是否已签，未签再 POST /api/attendance?random=true（"试试手气"）
 *
 * 环境变量：
 *   NS_COOKIE         必填，NodeSeek 登录 Cookie 整串，务必以加密 Secret 方式配置
 *   NS_SIGNIN_TIME    每日签到时间（北京时间 HH:MM），默认 08:37
 *   NS_SIGNIN_RANDOM  是否使用"试试手气"，默认 true；false 时为固定奖励
 */
import { loadSiteSettings, normalizeBooleanSetting } from '../utils/settings.js';
import { sendNotification } from './notification.js';

const NS_ORIGIN = 'https://www.nodeseek.com';
const STATE_KEY = 'nodeseek_signin_state';
const MAX_HISTORY = 30;
const MAX_ATTEMPTS_PER_DAY = 3;
const RETRY_INTERVAL_MS = 30 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export function getSigninConfig(env = {}) {
  const cookie = String(env.NS_COOKIE || '').trim();
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(env.NS_SIGNIN_TIME || '').trim());
  let hour = 8;
  let minute = 37;
  if (timeMatch && Number(timeMatch[1]) < 24 && Number(timeMatch[2]) < 60) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
  }
  return {
    enabled: Boolean(cookie),
    cookie,
    hour,
    minute,
    random: String(env.NS_SIGNIN_RANDOM ?? 'true').trim().toLowerCase() !== 'false'
  };
}

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

function nsHeaders(config) {
  return {
    Cookie: config.cookie,
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    Origin: NS_ORIGIN,
    Referer: `${NS_ORIGIN}/board`
  };
}

class SigninError extends Error {
  constructor(message, { loginInvalid = false } = {}) {
    super(message);
    this.loginInvalid = loginInvalid;
  }
}

async function requestJson(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    // 非 JSON 一般是登录页或 Cloudflare 风控页
  }
  if (resp.status === 401 || resp.status === 403) {
    const message = data?.message || `HTTP ${resp.status}`;
    throw new SigninError(`登录可能已失效或被风控拦截：${message}`, { loginInvalid: resp.status === 401 });
  }
  if (!data) {
    throw new SigninError(`返回了非 JSON 内容 (HTTP ${resp.status})，登录可能已失效：${text.slice(0, 120)}`, { loginInvalid: true });
  }
  return data;
}

function isLoginMessage(message) {
  return /登录|login|unauthorized|未授权/i.test(String(message || ''));
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// board 返回 record 表示今日已有签到记录
export function parseBoard(data) {
  if (data?.success === false) {
    throw new SigninError(`查询签到状态失败：${data.message || '未知错误'}`, { loginInvalid: isLoginMessage(data.message) });
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
  if (/已完成签到|已经签到|重复/.test(message)) {
    return { status: 'already', gain: null, current: toNumberOrNull(data?.current), message };
  }
  throw new SigninError(`签到失败：${message || '未知错误'}`, { loginInvalid: isLoginMessage(message) });
}

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

/**
 * 执行一次签到
 * @param {boolean} options.dryRun 只查询今日状态，不签到
 */
export async function runNodeseekSignin(env, { dryRun = false, trigger = 'cron', now = Date.now() } = {}) {
  const config = getSigninConfig(env);
  if (!config.enabled) return { enabled: false };

  const state = await loadSigninState(env.DB);
  const date = beijingDate(now);
  if (state.attempts?.date !== date) {
    state.attempts = { date, count: 0 };
  }
  if (!dryRun) {
    state.attempts.count += 1;
  }
  state.attempts.last_at = now;
  state.last_checked_at = now;

  try {
    const board = parseBoard(await requestJson(`${NS_ORIGIN}/api/attendance/board?page=1`, {
      headers: nsHeaders(config)
    }));
    state.login_invalid = false;
    state.error = '';

    if (board.signed) {
      const previous = state.today?.date === date ? state.today : null;
      state.today = {
        date,
        status: previous?.status === 'success' ? 'success' : 'already',
        gain: board.gain ?? previous?.gain ?? null,
        rank: board.rank,
        current: previous?.current ?? null,
        message: previous?.message || '今日已签到',
        at: previous?.at || now,
        trigger: previous?.trigger || trigger
      };
    } else if (dryRun) {
      state.today = { date, status: 'pending', gain: null, rank: null, current: null, message: 'Cookie 有效，今日尚未签到', at: now, trigger };
    } else {
      const result = parseAttendance(await requestJson(`${NS_ORIGIN}/api/attendance?random=${config.random}`, {
        method: 'POST',
        headers: nsHeaders(config)
      }));
      state.today = { date, ...result, rank: null, at: now, trigger };
    }

    if (state.today.status === 'success' || state.today.status === 'already') {
      upsertHistory(state, { date, status: state.today.status, gain: state.today.gain });
    }
  } catch (e) {
    const message = e?.message || String(e);
    console.error('[nodeseek] 签到失败:', message);
    state.login_invalid = Boolean(e?.loginInvalid);
    if (!dryRun) {
      state.today = { date, status: 'failed', gain: null, rank: null, current: null, message, at: now, trigger };
      upsertHistory(state, { date, status: 'failed', gain: null });
      // 同一天同一错误只通知一次
      if (state.error !== message) {
        await notifyFailure(env, `${message}${state.login_invalid ? '\n请重新导出 Cookie 并更新 NS_COOKIE' : ''}`);
      }
    }
    state.error = message;
  }

  await saveSigninState(env.DB, state);
  return state;
}

// 由每分钟的 Cron 调用：到点后签到，失败每 30 分钟重试，每天最多 3 次
export async function runNodeseekSigninIfDue(env, now = Date.now()) {
  const config = getSigninConfig(env);
  if (!config.enabled) return null;
  if (beijingMinutesOfDay(now) < config.hour * 60 + config.minute) return null;

  const state = await loadSigninState(env.DB);
  const date = beijingDate(now);
  if (state.today?.date === date && ['success', 'already'].includes(state.today.status)) return null;

  const attempts = state.attempts?.date === date ? state.attempts : { count: 0 };
  if (attempts.count >= MAX_ATTEMPTS_PER_DAY) return null;
  if (attempts.last_at && now - attempts.last_at < RETRY_INTERVAL_MS && attempts.count > 0) return null;

  return runNodeseekSignin(env, { trigger: 'cron', now });
}

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

export function buildSigninPublicView(env, state, now = Date.now()) {
  const config = getSigninConfig(env);
  if (!config.enabled) return { enabled: false };
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
    login_invalid: Boolean(state?.login_invalid)
  };
}

export function buildSigninAdminView(env, state, now = Date.now()) {
  const config = getSigninConfig(env);
  return {
    ...buildSigninPublicView(env, state, now),
    enabled: config.enabled,
    config: {
      schedule: `${formatTime(config.hour, config.minute)}（北京时间）`,
      random: config.random,
      has_cookie: config.enabled
    },
    detail: state?.today || null,
    attempts: state?.attempts || null,
    error: state?.error || '',
    last_checked_at: state?.last_checked_at || null,
    history_30: state?.history || []
  };
}
