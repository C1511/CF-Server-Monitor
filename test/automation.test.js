import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  buildPublicView,
  decideKeepaliveAction,
  runAliyunKeepalive,
  runAliyunKeepaliveIfDue,
  setAliyunKeepalivePaused,
  summarizeCdtTraffic
} from '../src/services/aliyunKeepalive.js';
import {
  beijingDate,
  buildSigninPublicView,
  runNodeseekSignin,
  runNodeseekSigninIfDue
} from '../src/services/nodeseekSignin.js';

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

function aliyunHandler({ trafficGB = 50, status = 'Stopped', fail = null } = {}) {
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

// ---------------- NodeSeek 签到 ----------------

// 2026-10-02 00:40 UTC = 北京时间 08:40
const AFTER_SCHEDULE = Date.UTC(2026, 9, 2, 0, 40);
const BEFORE_SCHEDULE = Date.UTC(2026, 9, 2, 0, 20);

function nsHandler({ signed = false, attendance = { success: true, message: '获得鸡腿 7 个', gain: 7, current: 120 }, boardStatus = 200 } = {}) {
  return (u, init) => {
    if (u.pathname === '/api/attendance/board') {
      if (boardStatus !== 200) return new Response('<html>login</html>', { status: boardStatus });
      return Response.json({ success: true, record: signed ? { gain: 5, rank: 12 } : null, memberList: [] });
    }
    if (u.pathname === '/api/attendance' && init.method === 'POST') {
      return Response.json(attendance);
    }
    return new Response('not found', { status: 404 });
  };
}

test('signin posts once when not yet signed and records gain', async () => {
  const env = { DB: createD1(), NS_COOKIE: 'session=abc' };
  const f = mockFetch(nsHandler());
  try {
    const state = await runNodeseekSignin(env, { now: AFTER_SCHEDULE });
    const post = f.calls.find(c => c.init.method === 'POST');
    assert.ok(post);
    assert.equal(post.url.searchParams.get('random'), 'true');
    assert.equal(post.init.headers.Cookie, 'session=abc');
    assert.equal(state.today.status, 'success');
    assert.equal(state.today.gain, 7);
    assert.equal(state.today.current, 120);
  } finally {
    f.restore();
  }
});

test('signin skips the POST when the board shows today is already signed, and dry run never posts', async () => {
  const env = { DB: createD1(), NS_COOKIE: 'session=abc' };
  let f = mockFetch(nsHandler({ signed: true }));
  try {
    const state = await runNodeseekSignin(env, { now: AFTER_SCHEDULE });
    assert.equal(f.calls.some(c => c.init.method === 'POST'), false);
    assert.equal(state.today.status, 'already');
    assert.equal(state.today.gain, 5);
  } finally {
    f.restore();
  }

  const env2 = { DB: createD1(), NS_COOKIE: 'session=abc' };
  f = mockFetch(nsHandler());
  try {
    const state = await runNodeseekSignin(env2, { dryRun: true, now: AFTER_SCHEDULE });
    assert.equal(f.calls.some(c => c.init.method === 'POST'), false);
    assert.equal(state.today.status, 'pending');
  } finally {
    f.restore();
  }
});

test('signin reports an expired cookie and risk-control failures', async () => {
  const env = { DB: createD1(), NS_COOKIE: 'session=old' };
  let f = mockFetch(nsHandler({ boardStatus: 403 }));
  try {
    const state = await runNodeseekSignin(env, { now: AFTER_SCHEDULE });
    assert.equal(state.today.status, 'failed');
    assert.match(state.error, /登录可能已失效|风控/);
  } finally {
    f.restore();
  }

  f = mockFetch(nsHandler({ attendance: { success: false, message: 'high risk action' } }));
  try {
    const state = await runNodeseekSignin({ DB: createD1(), NS_COOKIE: 'x' }, { now: AFTER_SCHEDULE });
    assert.equal(state.today.status, 'failed');
    assert.match(state.today.message, /high risk action/);
  } finally {
    f.restore();
  }
});

test('signin cron waits for the scheduled Beijing time, stops after success and caps retries', async () => {
  const env = { DB: createD1(), NS_COOKIE: 'session=abc' };
  let f = mockFetch(nsHandler());
  try {
    assert.equal(await runNodeseekSigninIfDue(env, BEFORE_SCHEDULE), null);
    assert.equal((await runNodeseekSigninIfDue(env, AFTER_SCHEDULE)).today.status, 'success');
    assert.equal(await runNodeseekSigninIfDue(env, AFTER_SCHEDULE + 3600000), null, 'already done today');
  } finally {
    f.restore();
  }

  const env2 = { DB: createD1(), NS_COOKIE: 'session=abc' };
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

test('signin public view shows 14-day history, streak and monthly gain', async () => {
  const env = { DB: createD1(), NS_COOKIE: 'c' };
  const f = mockFetch(nsHandler());
  try {
    const day = 86400000;
    await runNodeseekSignin(env, { now: AFTER_SCHEDULE - 2 * day });
    await runNodeseekSignin(env, { now: AFTER_SCHEDULE - day });
    const state = await runNodeseekSignin(env, { now: AFTER_SCHEDULE });
    const view = buildSigninPublicView(env, state, AFTER_SCHEDULE);
    assert.equal(view.history.length, 14);
    assert.equal(view.history[13].date, beijingDate(AFTER_SCHEDULE));
    assert.equal(view.streak, 3);
    assert.equal(view.month_gain, 14, 'Sep 30 not counted in October');
    assert.equal(JSON.stringify(view).includes('session'), false);
  } finally {
    f.restore();
  }
});
