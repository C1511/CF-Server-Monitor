import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { deriveAgentSecret, verifyAgentSecret } from '../src/utils/agentSecret.js';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, clearLoginFailures, isLoginBlocked, recordLoginFailure } from '../src/utils/loginLimiter.js';
import { hashPassword, verifyPasswordHash, PASSWORD_HASH_ITERATIONS } from '../src/utils/common.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { handleUpdate } from '../src/handlers/update.js';
import { generateToken } from '../src/middleware/auth.js';

const API_SECRET = 'unit-test-api-secret';
const SERVER_A = '550e8400-e29b-41d4-a716-446655440001';
const SERVER_B = '550e8400-e29b-41d4-a716-446655440002';

// 基于 node:sqlite 的最小 D1 适配器
function createD1() {
  const db = new DatabaseSync(':memory:');
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { meta: { changes: Number(info.changes) } };
    }
  });
  return { prepare: sql => statement(sql) };
}

function adminRequest(body, headers = {}) {
  return new Request('https://monitor.example/admin/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers },
    body: JSON.stringify(body)
  });
}

test('agent secrets are derived per server and API_SECRET is no longer accepted by default', async () => {
  const env = { API_SECRET };
  const secretA = await deriveAgentSecret(API_SECRET, SERVER_A);
  const secretB = await deriveAgentSecret(API_SECRET, SERVER_B);

  assert.match(secretA, /^[a-f0-9]{64}$/);
  assert.notEqual(secretA, secretB);
  assert.equal(secretA, await deriveAgentSecret(API_SECRET, SERVER_A));

  assert.equal(await verifyAgentSecret(env, SERVER_A, secretA), true);
  assert.equal(await verifyAgentSecret(env, SERVER_B, secretA), false, 'cannot impersonate another server');
  assert.equal(await verifyAgentSecret(env, SERVER_A, API_SECRET), false, 'master secret rejected');
  assert.equal(await verifyAgentSecret(env, SERVER_A, undefined), false);

  const legacyEnv = { API_SECRET, ALLOW_LEGACY_AGENT_SECRET: 'true' };
  assert.equal(await verifyAgentSecret(legacyEnv, SERVER_A, API_SECRET), true, 'legacy opt-in still works');
});

test('/update rejects the master secret and accepts the derived per-server secret', async () => {
  const env = {
    API_SECRET,
    DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }), first: async () => null }) }
  };
  const post = secret => new Request('https://monitor.example/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: SERVER_A, secret, metrics: {} })
  });

  assert.equal((await handleUpdate(post(API_SECRET), env)).status, 401);
  assert.equal((await handleUpdate(post(await deriveAgentSecret(API_SECRET, SERVER_B)), env)).status, 401);
  // 鉴权通过后才会查库；空库返回 404 说明已越过密钥校验
  assert.equal((await handleUpdate(post(await deriveAgentSecret(API_SECRET, SERVER_A)), env)).status, 404);
});

test('login limiter blocks an IP after repeated failures and resets on success or window expiry', async () => {
  const db = createD1();
  const ip = '198.51.100.1';
  const now = 1_000_000;

  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
    await recordLoginFailure(db, ip, now);
  }
  assert.equal(await isLoginBlocked(db, ip, now), false);
  await recordLoginFailure(db, ip, now);
  assert.equal(await isLoginBlocked(db, ip, now), true);
  assert.equal(await isLoginBlocked(db, '198.51.100.2', now), false, 'other IPs unaffected');
  assert.equal(await isLoginBlocked(db, ip, now + LOGIN_WINDOW_MS), false, 'window expiry unblocks');

  await clearLoginFailures(db, ip);
  assert.equal(await isLoginBlocked(db, ip, now), false);
});

test('admin login returns 429 after too many failures, even with the correct password', async () => {
  const env = { API_SECRET, DB: createD1() };
  const sys = { username: 'admin', password: await hashPassword('correct-horse'), jwt_secret: 'j'.repeat(64) };

  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    const res = await handleAdminAPI(adminRequest({ action: 'login', username: 'admin', password: 'wrong' }), env, sys);
    assert.equal(res.status, 401);
  }
  const blocked = await handleAdminAPI(adminRequest({ action: 'login', username: 'admin', password: 'correct-horse' }), env, sys);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, 'tooManyLoginAttempts');

  const otherIp = await handleAdminAPI(
    adminRequest({ action: 'login', username: 'admin', password: 'correct-horse' }, { 'CF-Connecting-IP': '203.0.113.8' }),
    env,
    sys
  );
  assert.equal(otherIp.status, 200);
});

test('password hashes use 100k PBKDF2 iterations and older hashes are flagged for rehash', async () => {
  assert.equal(PASSWORD_HASH_ITERATIONS, 100000);
  const hash = await hashPassword('pw');
  assert.match(hash, /^pbkdf2_sha256\$100000\$/);
  assert.deepEqual(
    { valid: (await verifyPasswordHash('pw', hash)).valid, rehash: (await verifyPasswordHash('pw', hash)).needsRehash },
    { valid: true, rehash: false }
  );

  const legacy = hash.replace('$100000$', '$50000$');
  // 用 50000 次迭代重新生成，模拟旧版本存储的哈希
  const parts = legacy.split('$');
  const salt = Uint8Array.from(parts[2].match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 50000 }, key, 256));
  const legacyHash = `pbkdf2_sha256$50000$${parts[2]}$${Array.from(bits, b => b.toString(16).padStart(2, '0')).join('')}`;
  const result = await verifyPasswordHash('pw', legacyHash);
  assert.equal(result.valid, true);
  assert.equal(result.needsRehash, true);
  assert.equal((await verifyPasswordHash('nope', legacyHash)).needsRehash, false);
});

test('admin get_settings no longer exposes API_SECRET', async () => {
  const sys = { username: 'admin', password: await hashPassword('pw'), jwt_secret: 'k'.repeat(64) };
  const env = { API_SECRET, DB: createD1() };
  const token = await generateToken(env, sys);
  const auth = { Authorization: `Bearer ${token}` };

  const settingsRes = await handleAdminAPI(adminRequest({ action: 'get_settings' }, auth), env, sys, async () => ({ ...sys }));
  const settingsBody = await settingsRes.json();
  assert.equal(settingsRes.status, 200);
  assert.equal('api_secret' in settingsBody, false);
  assert.equal(JSON.stringify(settingsBody).includes(API_SECRET), false);
});

test('theme preview rejects branch refs and only accepts commit-pinned theme URLs', async () => {
  const sys = { username: 'admin', password: await hashPassword('pw'), jwt_secret: 'm'.repeat(64) };
  const env = { API_SECRET, DB: createD1() };
  const token = await generateToken(env, sys);
  const auth = { Authorization: `Bearer ${token}` };

  const res = await handleAdminAPI(
    adminRequest({ action: 'start_theme_preview', theme_url: 'https://github.com/owner/theme/tree/main' }, auth),
    env,
    sys
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalidThemeUrl');
});

test('login limiter recovers when its table is dropped (e.g. database rebuild)', async () => {
  const db = createD1();
  const ip = '198.51.100.9';
  await recordLoginFailure(db, ip, 1000);
  await db.prepare('DROP TABLE login_attempts').run();
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    await recordLoginFailure(db, ip, 1000);
  }
  assert.equal(await isLoginBlocked(db, ip, 1000), true);
});

test('changing the admin password rotates jwt_secret, invalidates old tokens and issues a new one', async () => {
  const db = createD1();
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
  const env = { API_SECRET, DB: db };
  const sys = { username: 'admin', password: await hashPassword('old-password'), jwt_secret: 'n'.repeat(64) };
  const oldToken = await generateToken(env, sys);
  const oldJwtSecret = sys.jwt_secret;

  const sameAsApiSecret = await handleAdminAPI(
    adminRequest({ action: 'save_settings', settings: { password: API_SECRET } }, { Authorization: `Bearer ${oldToken}` }),
    env,
    sys
  );
  assert.equal(sameAsApiSecret.status, 400);
  assert.equal((await sameAsApiSecret.json()).error, 'passwordSameAsApiSecret');

  const res = await handleAdminAPI(
    adminRequest({ action: 'save_settings', settings: { password: 'new-password' } }, { Authorization: `Bearer ${oldToken}` }),
    env,
    sys
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token, 'a fresh token is returned');
  assert.match(res.headers.get('Set-Cookie') || '', /cfsm_auth=/);
  assert.notEqual(sys.jwt_secret, oldJwtSecret);

  const withOld = await handleAdminAPI(adminRequest({ action: 'get_settings' }, { Authorization: `Bearer ${oldToken}` }), env, sys, async () => ({ ...sys }));
  assert.equal(withOld.status, 401, 'old token rejected');
  const withNew = await handleAdminAPI(adminRequest({ action: 'get_settings' }, { Authorization: `Bearer ${body.token}` }), env, sys, async () => ({ ...sys }));
  assert.equal(withNew.status, 200, 'new token accepted');

  const stored = JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'site_options'").first()).value);
  assert.equal(stored.jwt_secret, sys.jwt_secret);
  assert.equal((await verifyPasswordHash('new-password', stored.password)).valid, true);
});
