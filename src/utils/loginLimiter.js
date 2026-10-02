/**
 * 登录失败限流：按客户端 IP 统计失败次数，存储在 D1 中（Worker 内存无法跨实例共享）
 * 同一 IP 在窗口期内失败 LOGIN_MAX_FAILURES 次后，窗口结束前拒绝继续尝试
 */

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const readyDatabases = new WeakSet();

async function ensureTable(db) {
  if (readyDatabases.has(db)) return;
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL)'
  ).run();
  readyDatabases.add(db);
}

// 表可能被"重建数据库"等操作删除：遇到 no such table 时重建并重试一次
async function withTable(db, fn) {
  await ensureTable(db);
  try {
    return await fn();
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) throw e;
    readyDatabases.delete(db);
    await ensureTable(db);
    return fn();
  }
}

export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function isLoginBlocked(db, ip, now = Date.now()) {
  try {
    const row = await withTable(db, () =>
      db.prepare('SELECT failures, window_start FROM login_attempts WHERE ip = ?').bind(ip).first()
    );
    if (!row) return false;
    if (now - Number(row.window_start) >= LOGIN_WINDOW_MS) return false;
    return Number(row.failures) >= LOGIN_MAX_FAILURES;
  } catch (e) {
    console.error('[login-limiter] check failed:', e);
    return false;
  }
}

export async function recordLoginFailure(db, ip, now = Date.now()) {
  try {
    await withTable(db, () => db.prepare(`
      INSERT INTO login_attempts (ip, failures, window_start) VALUES (?, 1, ?)
      ON CONFLICT(ip) DO UPDATE SET
        failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
        window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END
    `).bind(ip, now, now, LOGIN_WINDOW_MS, now, LOGIN_WINDOW_MS, now).run());
    // 顺带清理过期记录，避免表无限增长
    await db.prepare('DELETE FROM login_attempts WHERE window_start < ?').bind(now - LOGIN_WINDOW_MS).run();
  } catch (e) {
    console.error('[login-limiter] record failed:', e);
  }
}

export async function clearLoginFailures(db, ip) {
  try {
    await withTable(db, () => db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run());
  } catch (e) {
    console.error('[login-limiter] clear failed:', e);
  }
}
