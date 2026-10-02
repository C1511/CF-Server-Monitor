import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  buildPublicView,
  DEFAULT_THRESHOLD_GB,
  resolveAliyunConfig,
  setAliyunThreshold,
  summarizeAccountBalance,
  summarizeBillOverview,
  decideKeepaliveAction,
  runAliyunKeepalive,
  runAliyunKeepaliveIfDue,
  setAliyunKeepalivePaused,
  summarizeCdtTraffic
} from '../src/services/aliyunKeepalive.js';
import {
  beijingDate,
  buildSigninAdminView,
  buildSigninPublicView,
  resolveSigninConfig,
  runNodeseekSignin,
  formatRelayText,
  getRelayTask,
  loadSigninState,
  reportRelayResult,
  runNodeseekSigninIfDue,
  sanitizeCookie,
  setSigninCookie,
  setSigninRelay
} from '../src/services/nodeseekSignin.js';
import { deriveAgentSecret } from '../src/utils/agentSecret.js';

const GB = 1024 ** 3;

function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
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

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    return handler(u, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function aliyunEnv(overrides = {}) {
  return {
    DB: createD1(),
    ALIYUN_ACCESS_KEY_ID: 'LTAI5tTestKeyId1234',
    ALIYUN_ACCESS_KEY_SECRET: 'secret',
    ALIYUN_ECS_INSTANCE_ID: 'i-test',
    ALIYUN_CDT_THRESHOLD_GB: '180',
    ...overrides
  };
}

function aliyunHandler({ trafficGB = 50, status = 'Stopped', fail = null, billingFail = false } = {}) {
  return u => {
    const action = u.searchParams.get('Action');
    if (fail) return Response.json({ Code: 'InvalidAccessKeyId', Message: fail }, { status: 400 });
    if (action === 'ListCdtInternetTraffic') {
      return Response.json({
        TrafficDetails: [
          { BusinessRegionId: 'cn-hongkong', Traffic: trafficGB * GB },
          { BusinessRegionId: 'cn-shanghai', Traffic: 2 * GB }
        ]
      });
    }
    if (action === 'QueryAccountBalance') {
      if (billingFail) return Response.json({ Success: false, Code: 'NotAuthorized', Message: 'no bss permission' });
      return Response.json({ Success: true, Data: { AvailableAmount: '1,234.50', AvailableCashAmount: '1,200.00', CreditAmount: '0.00', Currency: 'CNY' } });
    }
    if (action === 'QueryBillOverview') {
      if (billingFail) return Response.json({ Success: false, Code: 'NotAuthorized', Message: 'no bss permission' });
      return Response.json({ Success: true, Data: { BillingCycle: u.searchParams.get('BillingCycle'), Items: { Item: [
        { ProductCode: 'ecs', ProductName: '云服务器 ECS', PretaxAmount: 10.5, PretaxGrossAmount: 12, DeductedByCoupons: 1.5, OutstandingAmount: 0 },
        { ProductCode: 'ecs', ProductName: '云服务器 ECS', PretaxAmount: 2.25, PretaxGrossAmount: 2.25, DeductedByCoupons: 0, OutstandingAmount: 0 },
        { ProductCode: 'cdt', ProductName: '云数据传输', PretaxAmount: 3.1, PretaxGrossAmount: 3.1, DeductedByCoupons: 0, OutstandingAmount: 0 },
        { ProductCode: 'oss', ProductName: '对象存储 OSS', PretaxAmount: 0, PretaxGrossAmount: 0 }
      ] } } });
    }
    if (action === 'DescribeInstances') {
      return Response.json({
        Instances: { Instance: [{ InstanceId: 'i-test', InstanceName: 'hk-1', Status: status, Cpu: 2, Memory: 1024, RegionId: 'cn-hongkong', PublicIpAddress: { IpAddress: ['1.2.3.4'] } }] }
      });
    }
    return Response.json({ RequestId: 'ok' });
  };
}

const actions = calls => calls.map(c => c.url.searchParams.get('Action')).filter(Boolean);

test('CDT traffic counts Hong Kong as non-mainland and mainland separately', () => {
  const summary = summarizeCdtTraffic({
    TrafficDetails: [
      { BusinessRegionId: 'cn-hongkong', Traffic: 10 * GB },
      { BusinessRegionId: 'cn-hongkong', Traffic: 5 * GB },
      { BusinessRegionId: 'ap-southeast-1', Traffic: 1 * GB },
      { BusinessRegionId: 'cn-beijing', Traffic: 3 * GB }
    ]
  });
  assert.equal(summary.non_mainland_gb, 16);
  assert.equal(summary.mainland_gb, 3);
  assert.equal(summary.regions[0].region, 'cn-hongkong');
  assert.equal(summary.regions[0].gb, 15);
});

test('keepalive decision matches the original script rules', () => {
  assert.equal(decideKeepaliveAction('Stopped', 10, 180).type, 'start');
  assert.equal(decideKeepaliveAction('Running', 10, 180).type, 'none');
  assert.equal(decideKeepaliveAction('Running', 180, 180).type, 'stop');
  assert.equal(decideKeepaliveAction('Stopped', 200, 180).type, 'none');
  assert.equal(decideKeepaliveAction('Starting', 10, 180).type, 'none');
});

test('keepalive starts a stopped instance under the threshold and records the event', async () => {
  const env = aliyunEnv();
  const f = mockFetch(aliyunHandler({ trafficGB: 50, status: 'Stopped' }));
  try {
    const state = await runAliyunKeepalive(env, { trigger: 'cron', now: 1000 });
    assert.ok(actions(f.calls).includes('StartInstances'));
    assert.equal(state.ecs.status, 'Starting');
    assert.equal(state.cdt.non_mainland_gb, 50);
    assert.equal(state.cdt.mainland_gb, 2);
    assert.equal(state.last_action.type, 'start');
    assert.equal(state.events[0].type, 'start');
  } finally {
    f.restore();
  }
});

test('keepalive stops a running instance at the threshold, and refresh never acts', async () => {
  const env = aliyunEnv();
  let f = mockFetch(aliyunHandler({ trafficGB: 181, status: 'Running' }));
  try {
    await runAliyunKeepalive(env, { apply: false, now: 1000 });
    assert.equal(actions(f.calls).includes('StopInstances'), false, 'refresh only');
    await runAliyunKeepalive(env, { now: 2000 });
    assert.ok(actions(f.calls).includes('StopInstances'));
  } finally {
    f.restore();
  }
});

test('paused keepalive does not start or stop the instance', async () => {
  const env = aliyunEnv();
  await setAliyunKeepalivePaused(env, true, 500);
  const f = mockFetch(aliyunHandler({ trafficGB: 10, status: 'Stopped' }));
  try {
    const state = await runAliyunKeepalive(env, { now: 1000 });
    assert.equal(actions(f.calls).includes('StartInstances'), false);
    assert.equal(state.last_decision.reason, '自动保活已暂停');
    assert.equal(state.events[0].type, 'pause');
  } finally {
    f.restore();
  }
});

test('repeated identical API errors are logged once', async () => {
  const env = aliyunEnv();
  const f = mockFetch(aliyunHandler({ fail: 'bad key' }));
  try {
    await runAliyunKeepalive(env, { now: 1000 });
    const state = await runAliyunKeepalive(env, { now: 2000 });
    assert.match(state.error, /bad key/);
    assert.equal(state.events.filter(e => e.type === 'error').length, 1);
  } finally {
    f.restore();
  }
});

test('keepalive cron respects the check interval', async () => {
  const env = aliyunEnv({ ALIYUN_CHECK_INTERVAL_MINUTES: '10' });
  const f = mockFetch(aliyunHandler({ trafficGB: 10, status: 'Running' }));
  try {
    assert.ok(await runAliyunKeepaliveIfDue(env, 0 + 10 * 60000));
    assert.equal(await runAliyunKeepaliveIfDue(env, 10 * 60000 + 5 * 60000), null);
    assert.ok(await runAliyunKeepaliveIfDue(env, 20 * 60000));
    assert.equal(await runAliyunKeepaliveIfDue({ DB: env.DB }, 99 * 60000), null, 'disabled without credentials');
  } finally {
    f.restore();
  }
});

test('public keepalive view hides instance id, IP and error details', async () => {
  const env = aliyunEnv();
  const f = mockFetch(aliyunHandler({ trafficGB: 90, status: 'Running' }));
  try {
    const state = await runAliyunKeepalive(env, { now: 1000 });
    const view = buildPublicView(env, state);
    const json = JSON.stringify(view);
    assert.equal(view.cdt.percent, 50);
    assert.equal(json.includes('i-test'), false);
    assert.equal(json.includes('1.2.3.4'), false);
    assert.equal(json.includes('LTAI'), false);
  } finally {
    f.restore();
  }
});

test('threshold defaults to 190 GB; admin override beats env var and can be reset', async () => {
  assert.equal(DEFAULT_THRESHOLD_GB, 190);
  const env = aliyunEnv({ ALIYUN_CDT_THRESHOLD_GB: undefined });
  let config = await resolveAliyunConfig(env);
  assert.equal(config.thresholdGB, 190);
  assert.equal(config.thresholdSource, 'default');

  const envWithVar = { ...env, ALIYUN_CDT_THRESHOLD_GB: '150' };
  config = await resolveAliyunConfig(envWithVar);
  assert.deepEqual([config.thresholdGB, config.thresholdSource], [150, 'env']);

  await setAliyunThreshold(envWithVar, 175.5);
  config = await resolveAliyunConfig(envWithVar);
  assert.deepEqual([config.thresholdGB, config.thresholdSource], [175.5, 'custom']);

  await setAliyunThreshold(envWithVar, null);
  config = await resolveAliyunConfig(envWithVar);
  assert.deepEqual([config.thresholdGB, config.thresholdSource], [150, 'env']);
});

test('threshold rejects invalid values', async () => {
  const env = aliyunEnv();
  for (const bad of [0, -5, 'abc', 1e9, true, NaN]) {
    await assert.rejects(setAliyunThreshold(env, bad), /invalidThreshold/, String(bad));
  }
});

test('changing the threshold recomputes the stored percentage and drives the next decision', async () => {
  const env = aliyunEnv({ ALIYUN_CDT_THRESHOLD_GB: undefined });
  const f = mockFetch(aliyunHandler({ trafficGB: 185, status: 'Running' }));
  try {
    let state = await runAliyunKeepalive(env, { now: 1000 });
    assert.equal(actions(f.calls).includes('StopInstances'), false, '185 < 190: keep running');
    assert.equal(state.cdt.threshold_gb, 190);

    ({ state } = await setAliyunThreshold(env, 180, 2000));
    assert.equal(state.cdt.threshold_gb, 180);
    assert.equal(state.cdt.percent, 102.8);
    assert.equal(state.events[0].type, 'config');
    assert.match(state.events[0].message, /190 GB → 180 GB/);

    await runAliyunKeepalive(env, { now: 3000 });
    assert.ok(actions(f.calls).includes('StopInstances'), '185 >= 180: stop');
  } finally {
    f.restore();
  }
});

test('billing summaries parse comma amounts and group bill items by product', () => {
  const balance = summarizeAccountBalance({ Data: { AvailableAmount: '1,234.50', AvailableCashAmount: '1,200.00', CreditAmount: '', Currency: 'CNY' } });
  assert.deepEqual(balance, { currency: 'CNY', available_amount: 1234.5, available_cash_amount: 1200, credit_amount: 0 });

  const overview = summarizeBillOverview({ Data: { Items: { Item: [
    { ProductCode: 'ecs', ProductName: 'ECS', PretaxAmount: 10.5, PretaxGrossAmount: 12, DeductedByCoupons: 1.5 },
    { ProductCode: 'ecs', ProductName: 'ECS', PretaxAmount: 2.25, PretaxGrossAmount: 2.25 },
    { ProductCode: 'cdt', ProductName: 'CDT', PretaxAmount: 3.1, PretaxGrossAmount: 3.1 },
    { ProductCode: 'oss', ProductName: 'OSS', PretaxAmount: 0, PretaxGrossAmount: 0 }
  ] } } });
  assert.equal(overview.month_pretax_amount, 15.85);
  assert.equal(overview.month_gross_amount, 17.35);
  assert.deepEqual(overview.products.map(p => [p.name, p.pretax_amount]), [['ECS', 12.75], ['CDT', 3.1]]);
});

test('billing refreshes hourly, uses the Beijing billing month, and failures never break keepalive', async () => {
  const env = aliyunEnv();
  // 2026-09-30 17:00 UTC = 北京时间 2026-10-01 01:00
  const t0 = Date.UTC(2026, 8, 30, 17, 0);
  let f = mockFetch(aliyunHandler({ trafficGB: 10, status: 'Running' }));
  try {
    const state = await runAliyunKeepalive(env, { now: t0 });
    assert.equal(state.billing.available_amount, 1234.5);
    assert.equal(state.billing.month_pretax_amount, 15.85);
    assert.equal(state.billing.billing_cycle, '2026-10');
    const billingCalls = () => actions(f.calls).filter(a => a === 'QueryBillOverview').length;
    assert.equal(billingCalls(), 1);
    assert.equal(f.calls.find(c => c.url.searchParams.get('Action') === 'QueryBillOverview').url.hostname, 'business.aliyuncs.com');

    await runAliyunKeepalive(env, { now: t0 + 10 * 60000 });
    assert.equal(billingCalls(), 1, 'not refreshed within the hour');
    await runAliyunKeepalive(env, { apply: false, forceBilling: true, now: t0 + 20 * 60000 });
    assert.equal(billingCalls(), 2, 'manual refresh forces billing');
  } finally {
    f.restore();
  }

  const env2 = aliyunEnv();
  f = mockFetch(aliyunHandler({ trafficGB: 10, status: 'Stopped', billingFail: true }));
  try {
    const state = await runAliyunKeepalive(env2, { now: t0 });
    assert.ok(actions(f.calls).includes('StartInstances'), 'keepalive still acts');
    assert.equal(state.error, '');
    assert.match(state.billing_error, /no bss permission/);
    assert.equal(state.events.some(e => e.type === 'error'), false);
  } finally {
    f.restore();
  }
});

test('BSS endpoint only accepts Aliyun billing hosts', async () => {
  const intl = await resolveAliyunConfig(aliyunEnv({ ALIYUN_BSS_ENDPOINT: 'business.ap-southeast-1.aliyuncs.com' }));
  assert.equal(intl.bssEndpoint, 'business.ap-southeast-1.aliyuncs.com');
  const evil = await resolveAliyunConfig(aliyunEnv({ ALIYUN_BSS_ENDPOINT: 'business.aliyuncs.com.evil.example' }));
  assert.equal(evil.bssEndpoint, 'business.aliyuncs.com');
});

test('public view includes billing only for logged-in admins', async () => {
  const env = aliyunEnv();
  const f = mockFetch(aliyunHandler({ trafficGB: 10, status: 'Running' }));
  try {
    const state = await runAliyunKeepalive(env, { now: 1000 });
    assert.equal(buildPublicView(env, state).billing, null);
    const admin = buildPublicView(env, state, { includeBilling: true });
    assert.equal(admin.billing.available_amount, 1234.5);
    assert.equal(admin.billing.month_pretax_amount, 15.85);
  } finally {
    f.restore();
  }
});

// ---------------- NodeSeek 签到 ----------------

// 2026-10-02 00:40 UTC = 北京时间 08:40
const AFTER_SCHEDULE = Date.UTC(2026, 9, 2, 0, 40);
const BEFORE_SCHEDULE = Date.UTC(2026, 9, 2, 0, 20);

const CHALLENGE_HTML = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
const LOGIN_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录 - NodeSeek</title></head><body></body></html>';
const SPA_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>NodeSeek</title></head><body></body></html>';

function nsHandler({
  signed = false,
  attendance = { success: true, message: '获得鸡腿 7 个', gain: 7, current: 120 },
  attendanceHtml = null,
  attendanceStatus = 200
} = {}) {
  return (u, init) => {
    if (u.pathname === '/api/attendance/board') {
      return Response.json({ success: true, record: signed ? { gain: 5, rank: 12 } : null, memberList: [] });
    }
    if (u.pathname === '/api/attendance' && init.method === 'POST') {
      if (attendanceHtml) return new Response(attendanceHtml, { status: attendanceStatus, headers: { 'Content-Type': 'text/html' } });
      return Response.json(attendance, { status: attendanceStatus });
    }
    return new Response('not found', { status: 404 });
  };
}

test('signin posts directly and records gain; the board is not needed for a real run', async () => {
  const env = { DB: createD1(), NS_COOKIE: 'session=abc', API_SECRET: 's' };
  const f = mockFetch(nsHandler());
  try {
    const state = await runNodeseekSignin(env, { now: AFTER_SCHEDULE });
    assert.equal(f.calls.some(c => c.url.pathname === '/api/attendance/board'), false);
    const post = f.calls.find(c => c.init.method === 'POST');
    assert.equal(post.url.searchParams.get('random'), 'true');
    assert.equal(post.init.headers.Cookie, 'session=abc');
    assert.deepEqual([state.today.status, state.today.gain, state.today.current], ['success', 7, 120]);
    assert.equal(state.failure_kind, '');
  } finally {
    f.restore();
  }
});

test('already-signed reply counts as done; dry run only reads the board', async () => {
  let f = mockFetch(nsHandler({ attendance: { success: false, message: '今天已完成签到，请勿重复操作' } }));
  try {
    const state = await runNodeseekSignin({ DB: createD1(), NS_COOKIE: 'c', API_SECRET: 's' }, { now: AFTER_SCHEDULE });
    assert.equal(state.today.status, 'already');
    assert.equal(state.history[0].status, 'already');
  } finally {
    f.restore();
  }

  f = mockFetch(nsHandler({ signed: true }));
  try {
    const state = await runNodeseekSignin({ DB: createD1(), NS_COOKIE: 'c', API_SECRET: 's' }, { dryRun: true, now: AFTER_SCHEDULE });
    assert.equal(f.calls.some(c => c.init.method === 'POST'), false);
    assert.equal(state.today.status, 'already');
    assert.equal(state.attempts.count, 0, 'dry run does not use up attempts');
  } finally {
    f.restore();
  }
});

test('failures are classified: expired cookie vs blocked vs HTML page with its title', async () => {
  const cases = [
    [{ attendance: { success: false, status: 404, message: 'USER NOT FOUND' }, attendanceStatus: 500 }, 'cookie_invalid', /USER NOT FOUND/],
    [{ attendanceHtml: LOGIN_HTML }, 'cookie_invalid', /登录 - NodeSeek/],
    [{ attendanceHtml: CHALLENGE_HTML, attendanceStatus: 403 }, 'blocked', /人机验证页 「Just a moment\.\.\.」/],
    [{ attendanceHtml: SPA_HTML }, 'blocked', /「NodeSeek」 \(HTTP 200\)/],
    [{ attendance: { success: false, message: 'high risk action' } }, 'blocked', /high risk action/],
    [{ attendance: { success: false, message: 'something else' } }, 'error', /something else/]
  ];
  for (const [handlerOptions, kind, pattern] of cases) {
    const f = mockFetch(nsHandler(handlerOptions));
    try {
      const state = await runNodeseekSignin({ DB: createD1(), NS_COOKIE: 'c', API_SECRET: 's' }, { now: AFTER_SCHEDULE });
      assert.equal(state.today.status, 'failed', kind);
      assert.equal(state.failure_kind, kind, String(pattern));
      assert.equal(state.login_invalid, kind === 'cookie_invalid');
      assert.match(state.error, pattern);
    } finally {
      f.restore();
    }
  }
});

test('cookie set in admin is encrypted at rest, overrides NS_COOKIE and resets today\'s attempts', async () => {
  const db = createD1();
  const env = { DB: db, NS_COOKIE: 'env-cookie=1', API_SECRET: 'secret-A' };

  let f = mockFetch(nsHandler({ attendance: { success: false, message: 'USER NOT FOUND' } }));
  try {
    for (let i = 0; i < 3; i++) await runNodeseekSignin(env, { now: AFTER_SCHEDULE + i * 31 * 60000 });
    assert.equal(await runNodeseekSigninIfDue(env, AFTER_SCHEDULE + 4 * 31 * 60000), null, 'retries exhausted');
  } finally {
    f.restore();
  }

  const state = await setSigninCookie(env, ' admin-cookie=xyz; other=1 ', AFTER_SCHEDULE + 130 * 60000);
  assert.equal(state.login_invalid, false);
  assert.equal(state.attempts.count, 0);

  const raw = (await db.prepare("SELECT value FROM settings WHERE key = 'nodeseek_signin_cookie'").first()).value;
  assert.equal(raw.includes('admin-cookie'), false, 'not stored in plaintext');

  const config = await resolveSigninConfig(env);
  assert.deepEqual([config.cookie, config.cookieSource], ['admin-cookie=xyz; other=1', 'admin']);
  const adminView = buildSigninAdminView(config, state, AFTER_SCHEDULE);
  assert.equal(JSON.stringify(adminView).includes('admin-cookie'), false, 'cookie never returned');
  assert.equal(adminView.config.cookie_source, 'admin');

  f = mockFetch(nsHandler());
  try {
    const result = await runNodeseekSigninIfDue(env, AFTER_SCHEDULE + 131 * 60000);
    assert.equal(result.today.status, 'success', 'cron retries with the new cookie');
    assert.equal(f.calls.at(-1).init.headers.Cookie, 'admin-cookie=xyz; other=1');
  } finally {
    f.restore();
  }

  // API_SECRET 更换后无法解密，回退到环境变量
  const rotated = await resolveSigninConfig({ ...env, API_SECRET: 'secret-B' });
  assert.deepEqual([rotated.cookie, rotated.cookieSource, rotated.storedCookieUnreadable], ['env-cookie=1', 'env', true]);

  await setSigninCookie(env, '');
  assert.equal((await resolveSigninConfig(env)).cookieSource, 'env', 'clearing reverts to NS_COOKIE');
  await assert.rejects(setSigninCookie(env, 'a=1\r\nInjected: x'), /invalidCookie/);
  await assert.rejects(setSigninCookie(env, 'x'.repeat(9000)), /invalidCookie/);
});

test('signin can be enabled purely from the admin cookie, without NS_COOKIE', async () => {
  const env = { DB: createD1(), API_SECRET: 's' };
  assert.equal((await resolveSigninConfig(env)).enabled, false);
  await setSigninCookie(env, 'only-admin=1');
  const config = await resolveSigninConfig(env);
  assert.equal(config.enabled, true);
  assert.equal(buildSigninPublicView(config, null, AFTER_SCHEDULE).enabled, true);
});

test('signin cron waits for the scheduled Beijing time, stops after success and caps retries', async () => {
  const env = { DB: createD1(), NS_COOKIE: 'session=abc', API_SECRET: 's' };
  let f = mockFetch(nsHandler());
  try {
    assert.equal(await runNodeseekSigninIfDue(env, BEFORE_SCHEDULE), null);
    assert.equal((await runNodeseekSigninIfDue(env, AFTER_SCHEDULE)).today.status, 'success');
    assert.equal(await runNodeseekSigninIfDue(env, AFTER_SCHEDULE + 3600000), null, 'already done today');
  } finally {
    f.restore();
  }

  const env2 = { DB: createD1(), NS_COOKIE: 'session=abc', API_SECRET: 's' };
  f = mockFetch(nsHandler({ attendance: { success: false, message: 'high risk action' } }));
  try {
    assert.ok(await runNodeseekSigninIfDue(env2, AFTER_SCHEDULE));
    assert.equal(await runNodeseekSigninIfDue(env2, AFTER_SCHEDULE + 10 * 60000), null, 'waits 30 min before retry');
    assert.ok(await runNodeseekSigninIfDue(env2, AFTER_SCHEDULE + 31 * 60000));
    assert.ok(await runNodeseekSigninIfDue(env2, AFTER_SCHEDULE + 62 * 60000));
    assert.equal(await runNodeseekSigninIfDue(env2, AFTER_SCHEDULE + 93 * 60000), null, 'max 3 attempts per day');
  } finally {
    f.restore();
  }
});

test('signin public view shows 14-day history, streak, monthly gain and failure kind', async () => {
  const env = { DB: createD1(), NS_COOKIE: 'c', API_SECRET: 's' };
  const f = mockFetch(nsHandler());
  try {
    const day = 86400000;
    await runNodeseekSignin(env, { now: AFTER_SCHEDULE - 2 * day });
    await runNodeseekSignin(env, { now: AFTER_SCHEDULE - day });
    const state = await runNodeseekSignin(env, { now: AFTER_SCHEDULE });
    const view = buildSigninPublicView(await resolveSigninConfig(env), state, AFTER_SCHEDULE);
    assert.equal(view.history.length, 14);
    assert.equal(view.history[13].date, beijingDate(AFTER_SCHEDULE));
    assert.equal(view.streak, 3);
    assert.equal(view.month_gain, 14, 'Sep 30 not counted in October');
    assert.equal(view.failure_kind, '');
    assert.equal(JSON.stringify(view).includes('session'), false);
  } finally {
    f.restore();
  }
});

// ---------------- 账单站点探测 ----------------

test('billing falls back to the international site on AuthSiteFail and remembers it', async () => {
  const env = aliyunEnv();
  const handler = aliyunHandler({ trafficGB: 10, status: 'Running' });
  const f = mockFetch((u, init) => {
    if (u.hostname === 'business.aliyuncs.com') {
      return Response.json({ Code: 'AuthSiteFail', Message: 'auth site failed.' }, { status: 400 });
    }
    return handler(u, init);
  });
  try {
    let state = await runAliyunKeepalive(env, { now: 1000, forceBilling: true });
    assert.equal(state.billing_error, '');
    assert.equal(state.billing.endpoint, 'business.ap-southeast-1.aliyuncs.com');
    assert.equal(state.billing.available_amount, 1234.5);

    const before = f.calls.filter(c => c.url.hostname === 'business.aliyuncs.com').length;
    state = await runAliyunKeepalive(env, { now: 2000, forceBilling: true });
    assert.equal(f.calls.filter(c => c.url.hostname === 'business.aliyuncs.com').length, before, 'remembered site is tried first');
  } finally {
    f.restore();
  }
});

test('an explicitly configured billing endpoint is not second-guessed', async () => {
  const env = aliyunEnv({ ALIYUN_BSS_ENDPOINT: 'business.aliyuncs.com' });
  const handler = aliyunHandler({ trafficGB: 10, status: 'Running' });
  const f = mockFetch((u, init) => {
    if (u.hostname === 'business.aliyuncs.com') {
      return Response.json({ Code: 'AuthSiteFail', Message: 'auth site failed.' }, { status: 400 });
    }
    return handler(u, init);
  });
  try {
    const state = await runAliyunKeepalive(env, { now: 1000, forceBilling: true });
    assert.match(state.billing_error, /AuthSiteFail/);
    assert.equal(f.calls.some(c => c.url.hostname === 'business.ap-southeast-1.aliyuncs.com'), false);
  } finally {
    f.restore();
  }
});

test('Cloudflare clearance cookies are stripped before calling NodeSeek', async () => {
  assert.equal(
    sanitizeCookie('colorscheme=light; session=s1; pjwt=p1; cf_clearance=abc.def-1.2; __cf_bm=x; _cfuvid=y; fog=z'),
    'colorscheme=light; session=s1; pjwt=p1; fog=z'
  );
  const env = { DB: createD1(), NS_COOKIE: 'session=s1; cf_clearance=abc', API_SECRET: 's' };
  const f = mockFetch(nsHandler());
  try {
    await runNodeseekSignin(env, { now: AFTER_SCHEDULE });
    assert.equal(f.calls.at(-1).init.headers.Cookie, 'session=s1');
  } finally {
    f.restore();
  }
});

test('billing sends the RegionId matching each site and reports every site tried', async () => {
  const env = aliyunEnv();
  const handler = aliyunHandler({ trafficGB: 10, status: 'Running' });
  let f = mockFetch((u, init) => {
    if (u.hostname === 'business.aliyuncs.com') {
      return Response.json({ Code: 'AuthSiteFail', Message: 'auth site failed.' }, { status: 400 });
    }
    return handler(u, init);
  });
  try {
    await runAliyunKeepalive(env, { now: 1000, forceBilling: true });
    const region = host => f.calls.find(c => c.url.hostname === host && c.url.searchParams.get('Action') === 'QueryAccountBalance').url.searchParams.get('RegionId');
    assert.equal(region('business.aliyuncs.com'), 'cn-hangzhou');
    assert.equal(region('business.ap-southeast-1.aliyuncs.com'), 'ap-southeast-1');
  } finally {
    f.restore();
  }

  f = mockFetch((u, init) => {
    if (u.hostname.startsWith('business.')) {
      return Response.json({ Code: 'AuthSiteFail', Message: 'auth site failed.' }, { status: 400 });
    }
    return handler(u, init);
  });
  try {
    const state = await runAliyunKeepalive(aliyunEnv(), { now: 1000, forceBilling: true });
    assert.match(state.billing_error, /已尝试：business\.aliyuncs\.com、business\.ap-southeast-1\.aliyuncs\.com/);
  } finally {
    f.restore();
  }
});

test('billing also treats NotApplicable site mismatch as a reason to try the other site', async () => {
  const handler = aliyunHandler({ trafficGB: 10, status: 'Running' });
  const f = mockFetch((u, init) => {
    if (u.hostname === 'business.aliyuncs.com' && u.searchParams.get('Action') === 'QueryBillOverview') {
      return Response.json({ Code: 'NotApplicable', Message: 'You are not authorized to call the API operation. Please check whether the caller site matches the API domain regionId.' }, { status: 400 });
    }
    return handler(u, init);
  });
  try {
    const state = await runAliyunKeepalive(aliyunEnv(), { now: 1000, forceBilling: true });
    assert.equal(state.billing_error, '');
    assert.equal(state.billing.endpoint, 'business.ap-southeast-1.aliyuncs.com');
  } finally {
    f.restore();
  }
});

// ---------------- 签到代发 ----------------

const IPV6_PAGE = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>提醒，ipv6已关闭 | NodeSeek</title></head><body></body></html>';

async function relayEnv() {
  const env = { DB: createD1(), NS_COOKIE: 'session=s1; cf_clearance=zzz', API_SECRET: 'relay-test-secret' };
  await setSigninRelay(env, 'srv-hk');
  return env;
}

test('relay task: only the designated server gets work, respects schedule unless forced', async () => {
  const env = await relayEnv();
  assert.equal((await getRelayTask(env, 'other', { now: AFTER_SCHEDULE })).reason, 'not_relay');
  assert.equal((await getRelayTask(env, 'srv-hk', { now: BEFORE_SCHEDULE })).reason, 'too_early');

  const forced = await getRelayTask(env, 'srv-hk', { now: BEFORE_SCHEDULE, force: true });
  assert.equal(forced.due, true);
  assert.equal(forced.cookie, 'session=s1', 'Cloudflare cookies stripped');
  assert.equal(forced.attempt, 1);

  await setSigninRelay(env, null);
  assert.equal((await getRelayTask(env, 'srv-hk', { now: AFTER_SCHEDULE })).reason, 'not_relay', 'disabled');
});

test('relay mode stops the Worker from signing in by itself', async () => {
  const env = await relayEnv();
  const f = mockFetch(nsHandler());
  try {
    assert.equal(await runNodeseekSigninIfDue(env, AFTER_SCHEDULE), null);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test('relay report: success finishes the day; IPv6 page / risk retries; expired cookie does not retry', async () => {
  let env = await relayEnv();
  let r = await reportRelayResult(env, 'srv-hk', '200', JSON.stringify({ success: true, message: '获得鸡腿 6 个', gain: 6, current: 99 }), AFTER_SCHEDULE);
  assert.deepEqual([r.done, r.retry, r.kind], [true, false, 'success']);
  let state = await loadSigninState(env.DB);
  assert.deepEqual([state.today.status, state.today.gain, state.today.trigger], ['success', 6, 'relay']);
  assert.equal((await getRelayTask(env, 'srv-hk', { now: AFTER_SCHEDULE + 60000 })).reason, 'done');

  env = await relayEnv();
  r = await reportRelayResult(env, 'srv-hk', '200', IPV6_PAGE, AFTER_SCHEDULE);
  assert.deepEqual([r.done, r.retry, r.kind], [false, true, 'blocked']);
  assert.match(r.message, /ipv6已关闭/);
  r = await reportRelayResult(env, 'srv-hk', '200', JSON.stringify({ success: false, message: 'high risk action' }), AFTER_SCHEDULE + 600000);
  assert.deepEqual([r.retry, r.kind], [true, 'blocked']);
  r = await reportRelayResult(env, 'srv-hk', '0', 'curl: (28) timed out', AFTER_SCHEDULE + 1200000);
  assert.deepEqual([r.retry, r.kind], [false, 'error'], 'third attempt: no more retries');
  assert.equal((await getRelayTask(env, 'srv-hk', { now: AFTER_SCHEDULE + 1300000 })).reason, 'max_attempts');

  env = await relayEnv();
  r = await reportRelayResult(env, 'srv-hk', '500', JSON.stringify({ success: false, status: 404, message: 'USER NOT FOUND' }), AFTER_SCHEDULE);
  assert.deepEqual([r.done, r.retry, r.kind], [false, false, 'cookie_invalid']);
  assert.equal((await loadSigninState(env.DB)).login_invalid, true);

  assert.equal((await reportRelayResult(env, 'intruder', '200', '{}', AFTER_SCHEDULE)).done, false);
});

test('relay text format is one key=value per line without injected newlines', () => {
  assert.equal(formatRelayText({ due: true, reason: undefined, message: 'a\nb\r\nc' }), 'due=true\nmessage=a b c\n');
});

test('relay HTTP routes authenticate with the relay server\'s own secret', async () => {
  const { default: worker } = await import('../src/index.js');
  const env = await relayEnv();
  const good = await deriveAgentSecret(env.API_SECRET, 'srv-hk');
  const call = (path, headers, body = '') => worker.fetch(new Request(`https://board.example${path}`, { method: 'POST', headers, body }), env, { waitUntil() {} });

  let res = await call('/relay/nodeseek/task?force=1', { 'X-Relay-Id': 'srv-hk', 'X-Relay-Secret': 'wrong' });
  assert.equal(res.status, 401);
  res = await call('/relay/nodeseek/task?force=1', { 'X-Relay-Id': 'srv-hk', 'X-Relay-Secret': env.API_SECRET });
  assert.equal(res.status, 401, 'master secret is not accepted');

  res = await call('/relay/nodeseek/task?force=1', { 'X-Relay-Id': 'srv-hk', 'X-Relay-Secret': good });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^due=true$/m);
  assert.match(text, /^cookie=session=s1$/m);

  res = await call('/relay/nodeseek/report', { 'X-Relay-Id': 'srv-hk', 'X-Relay-Secret': good, 'X-Relay-Status': '200' }, JSON.stringify({ success: true, message: 'ok', gain: 3 }));
  assert.match(await res.text(), /^done=1$/m);
});

test('3xx responses are classified by redirect target, not by the generic page title', async () => {
  const page = '<html><head><title>303 See Other</title></head><body><center>303 See Other</center></body></html>';
  const cases = [
    ['/signIn.html?redirect=%2Fboard', 'cookie_invalid'],
    ['https://www.nodeseek.com/cdn-cgi/challenge-platform/h/b', 'blocked'],
    ['/somewhere-else', 'error'],
    ['', 'error']
  ];
  for (const [location, kind] of cases) {
    const env = await relayEnv();
    const r = await reportRelayResult(env, 'srv-hk', '303', page, AFTER_SCHEDULE, { location });
    assert.equal(r.kind, kind, location);
    if (location) assert.ok(r.message.includes(location.slice(0, 40)), r.message);
  }
});

test('forced relay runs ignore the daily attempt cap', async () => {
  const env = await relayEnv();
  for (let i = 0; i < 3; i++) await reportRelayResult(env, 'srv-hk', '200', '{"success":false,"message":"x"}', AFTER_SCHEDULE + i);
  assert.equal((await getRelayTask(env, 'srv-hk', { now: AFTER_SCHEDULE + 10 })).reason, 'max_attempts');
  assert.equal((await getRelayTask(env, 'srv-hk', { now: AFTER_SCHEDULE + 10, force: true })).due, true);
});

test('refreshed cookie from the relay is stored only when the check-in succeeds', async () => {
  let env = await relayEnv();
  await reportRelayResult(env, 'srv-hk', '200', '{"success":false,"message":"x"}', AFTER_SCHEDULE, { refreshedCookie: 'session=s1; pjwt=new' });
  assert.equal((await resolveSigninConfig(env)).cookieSource, 'env', 'failure: not stored');

  await reportRelayResult(env, 'srv-hk', '200', '{"success":true,"message":"ok","gain":2}', AFTER_SCHEDULE + 1, { refreshedCookie: 'session=s1; pjwt=new' });
  const config = await resolveSigninConfig(env);
  assert.deepEqual([config.cookieSource, config.cookie], ['admin', 'session=s1; pjwt=new']);
  const raw = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'nodeseek_signin_cookie'").first()).value;
  assert.equal(raw.includes('pjwt=new'), false, 'encrypted at rest');
  assert.ok((await loadSigninState(env.DB)).cookie_refreshed_at);

  env = await relayEnv();
  await reportRelayResult(env, 'srv-hk', '200', '{"success":true,"message":"ok"}', AFTER_SCHEDULE, { refreshedCookie: 'bad\r\ncookie' });
  assert.equal((await resolveSigninConfig(env)).cookieSource, 'env', 'invalid cookie ignored');
});
