import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  buildSingboxAdminView,
  buildSingboxConnView,
  canonicalJson,
  clearSingboxConns,
  MAX_CONN_RECORDS,
  reportSingboxConns,
  setSingboxConnLog,
  pollSingboxRoute,
  reportSingbox,
  saveSingboxRoute,
  setSingboxServer,
  validateRoute
} from '../src/services/singboxRoute.js';
import {
  editorToRoute,
  emptyRow,
  routeToEditor,
  ruleToRow,
  rowToRule
} from '../src/frontend/utils/singboxRules.js';

function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO servers VALUES ('srv-hk', '阿里云香港')");
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => db.prepare(sql).run(...params)
  });
  return { prepare: sql => statement(sql) };
}

const T0 = Date.UTC(2026, 9, 3, 0, 0, 0);

async function singboxEnv() {
  const env = { DB: createD1() };
  await setSingboxServer(env, 'srv-hk');
  return env;
}

function syncReport(route, extra = {}) {
  return JSON.stringify({
    event: 'sync',
    singbox_version: '1.12.9',
    config_path: '/etc/sing-box/config.json',
    inbounds: [{ tag: 'anytls-in', type: 'anytls' }],
    outbounds: [{ tag: 'direct', type: 'direct' }, { tag: 'warp', type: 'socks' }],
    route,
    ...extra
  });
}

test('only the selected server can poll and report', async () => {
  const env = await singboxEnv();
  assert.equal((await pollSingboxRoute(env, 'other', '', T0)).status, 403);
  assert.equal((await reportSingbox(env, 'other', syncReport({}), T0)).status, 403);
  assert.equal((await pollSingboxRoute(env, 'srv-hk', '', T0)).status, 204, 'nothing saved yet');
  await setSingboxServer(env, null);
  assert.equal((await pollSingboxRoute(env, 'srv-hk', '', T0)).status, 403, 'disabled');
});

test('switching servers drops the saved route so it is never pushed to another machine', async () => {
  const env = await singboxEnv();
  await saveSingboxRoute(env, { final: 'direct' }, T0);
  await setSingboxServer(env, 'srv-hk');
  assert.ok((await buildSingboxAdminView(env)).desired, 'same server keeps it');
  await setSingboxServer(env, 'srv-jp');
  assert.equal((await buildSingboxAdminView(env)).desired, null);
  assert.equal((await pollSingboxRoute(env, 'srv-jp', '', T0)).status, 204);
});

test('report stores tags and the current route, never other fields', async () => {
  const env = await singboxEnv();
  const route = { rules: [{ action: 'sniff' }], final: 'direct' };
  const result = await reportSingbox(env, 'srv-hk', syncReport(route, { password: 'x', inbounds: [{ tag: 'anytls-in', type: 'anytls', password: 'secret' }] }), T0);
  assert.equal(result.status, 200);
  const view = await buildSingboxAdminView(env);
  assert.deepEqual(view.state.inbounds, [{ tag: 'anytls-in', type: 'anytls' }]);
  assert.deepEqual(view.state.current_route, route);
  assert.equal(view.state.singbox_version, '1.12.9');
  assert.equal(view.sync, 'none');
  assert.ok(!JSON.stringify(view).includes('secret'));
  assert.equal((await reportSingbox(env, 'srv-hk', 'not json', T0)).status, 400);
});

test('save -> poll -> apply success flow, unchanged content keeps the version', async () => {
  const env = await singboxEnv();
  await reportSingbox(env, 'srv-hk', syncReport({ final: 'direct' }), T0);
  const route = { rules: [{ domain_suffix: ['openai.com'], action: 'route', outbound: 'warp' }], final: 'direct' };
  const desired = await saveSingboxRoute(env, route, T0 + 1000);
  assert.match(desired.rev, /^v1-[0-9a-f]{12}$/);
  assert.equal((await buildSingboxAdminView(env)).sync, 'pending');

  const poll = await pollSingboxRoute(env, 'srv-hk', '', T0 + 2000);
  assert.equal(poll.status, 200);
  assert.equal(poll.rev, desired.rev);
  assert.deepEqual(poll.route, route);

  await reportSingbox(env, 'srv-hk', syncReport(route, { event: 'apply', rev: desired.rev, ok: true, message: 'ok' }), T0 + 3000);
  assert.equal((await pollSingboxRoute(env, 'srv-hk', desired.rev, T0 + 4000)).status, 204);
  const view = await buildSingboxAdminView(env);
  assert.equal(view.sync, 'applied');
  assert.equal(view.state.applied_rev, desired.rev);

  // 键顺序不同但内容相同：不生成新版本
  const same = await saveSingboxRoute(env, { final: 'direct', rules: [{ outbound: 'warp', action: 'route', domain_suffix: ['openai.com'] }] }, T0 + 5000);
  assert.equal(same.rev, desired.rev);

  // 服务器上被手动修改
  await reportSingbox(env, 'srv-hk', syncReport({ ...route, final: 'warp' }), T0 + 6000);
  assert.equal((await buildSingboxAdminView(env)).sync, 'drift');
});

test('failed apply is reported; saving the same content again creates a new version to retry', async () => {
  const env = await singboxEnv();
  await reportSingbox(env, 'srv-hk', syncReport({}), T0);
  const desired = await saveSingboxRoute(env, { final: 'warp' }, T0);
  await reportSingbox(env, 'srv-hk', syncReport({}, { event: 'apply', rev: desired.rev, ok: false, message: 'sing-box check failed' }), T0 + 1000);
  const view = await buildSingboxAdminView(env);
  assert.equal(view.sync, 'failed');
  assert.equal(view.state.error, 'sing-box check failed');
  assert.equal(view.state.events[0].type, 'error');

  const retry = await saveSingboxRoute(env, { final: 'warp' }, T0 + 2000);
  assert.match(retry.rev, /^v2-/);
  assert.equal((await buildSingboxAdminView(env)).sync, 'pending');
});

test('route validation rejects bad shapes and unknown outbounds', async () => {
  assert.equal(validateRoute([]).error, 'routeMustBeObject');
  assert.equal(validateRoute({ rules: {} }).error, 'routeRulesInvalid');
  assert.equal(validateRoute({ rule_set: [1] }).error, 'routeRuleSetInvalid');
  assert.equal(validateRoute({ final: 1 }).error, 'routeFinalInvalid');
  const unknown = validateRoute({ rules: [{ outbound: 'nope' }], rule_set: [{ download_detour: 'gone' }], final: 'direct' }, ['direct']);
  assert.equal(unknown.error, 'routeUnknownOutbound');
  assert.equal(unknown.detail, 'nope, gone');
  assert.ok(validateRoute({ rules: [{ outbound: 'nope' }] }).valid, 'outbounds unknown until the server reports');

  const env = await singboxEnv();
  await reportSingbox(env, 'srv-hk', syncReport({}), T0);
  await assert.rejects(saveSingboxRoute(env, { final: 'nope' }), /routeUnknownOutbound/);
});

test('editor: simple rules become rows, everything else stays JSON', () => {
  assert.deepEqual(
    (({ type, values, action }) => ({ type, values, action }))(ruleToRow({ domain_suffix: 'google.com', outbound: 'warp' })),
    { type: 'domain_suffix', values: 'google.com', action: 'out:warp' }
  );
  assert.equal(ruleToRow({ action: 'sniff' }).type, 'any');
  assert.equal(ruleToRow({ protocol: 'dns', action: 'hijack-dns' }).action, 'act:hijack-dns');
  const geo = ruleToRow({ rule_set: ['geosite-netflix', 'geosite-disney'], action: 'route', outbound: 'warp' });
  assert.equal(geo.type, 'geosite');
  assert.equal(geo.values, 'netflix\ndisney');
  assert.equal(ruleToRow({ rule_set: ['geosite-cn', 'my-list'], outbound: 'direct' }).type, 'rule_set');
  assert.equal(ruleToRow({ domain: ['a.com'], invert: true, outbound: 'direct' }).type, 'json');
  assert.equal(ruleToRow({ type: 'logical', mode: 'and', rules: [], outbound: 'direct' }).type, 'json');
  assert.equal(ruleToRow({ action: 'reject', method: 'drop' }).type, 'json');
  assert.equal(ruleToRow({ action: 'route-options', udp_timeout: '5m' }).type, 'json');
});

test('editor: rows convert back, geosite adds the official rule-set, other fields are kept', () => {
  const base = {
    rules: [{ action: 'sniff' }, { type: 'logical', mode: 'or', rules: [{ port: 22 }], action: 'reject' }],
    rule_set: [{ tag: 'geosite-cn', type: 'local', format: 'binary', path: 'cn.srs' }],
    default_domain_resolver: 'local',
    final: 'direct'
  };
  const editor = routeToEditor(base);
  assert.deepEqual(editor.rows.map(r => r.type), ['any', 'json']);
  editor.rows.push({ ...emptyRow('warp'), type: 'geosite', values: 'netflix, cn\nopenai' });
  editor.rows.push({ ...emptyRow('direct'), type: 'port', values: '80\n443' });

  const route = editorToRoute(base, editor.rows, 'warp');
  assert.equal(route.default_domain_resolver, 'local');
  assert.equal(route.final, 'warp');
  assert.deepEqual(route.rules[0], { action: 'sniff' });
  assert.deepEqual(route.rules[1], base.rules[1]);
  assert.deepEqual(route.rules[2], { rule_set: ['geosite-netflix', 'geosite-cn', 'geosite-openai'], action: 'route', outbound: 'warp' });
  assert.deepEqual(route.rules[3], { port: [80, 443], action: 'route', outbound: 'direct' });
  assert.deepEqual(route.rule_set.map(s => s.tag), ['geosite-cn', 'geosite-netflix', 'geosite-openai'], 'existing geosite-cn untouched');
  assert.equal(route.rule_set[1].url, 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-netflix.srs');

  // 未修改时转换结果与原 route 一致（包括旧版省略 action、单个值写成字符串的规则）
  const legacy = { ...base, rules: [...base.rules, { domain_suffix: 'google.com', outbound: 'warp' }] };
  const roundTrip = routeToEditor(legacy);
  assert.equal(canonicalJson(editorToRoute(legacy, roundTrip.rows, roundTrip.final)), canonicalJson(legacy));
  roundTrip.rows[2].values += '\nyoutube.com';
  assert.deepEqual(editorToRoute(legacy, roundTrip.rows, roundTrip.final).rules[2], { domain_suffix: ['google.com', 'youtube.com'], action: 'route', outbound: 'warp' });
});

test('editor: invalid rows report their index', () => {
  assert.throws(() => rowToRule({ type: 'domain', values: ' ', action: 'out:direct' }, 2), e => e.index === 2 && e.code === 'singboxRowEmpty');
  assert.throws(() => rowToRule({ type: 'port', values: '70000', action: 'out:direct' }), e => e.code === 'singboxRowInvalidPort');
  assert.throws(() => rowToRule({ type: 'json', json: '{bad' }), e => e.code === 'singboxRowInvalidJson');
  assert.throws(() => rowToRule({ type: 'geosite', values: 'a b', action: 'out:direct' }), e => e.code === 'singboxRowInvalidName');
  assert.throws(() => rowToRule({ type: 'any', values: '', action: '' }), e => e.code === 'singboxRowNoAction');
});

function conn(host, out, extra = {}) {
  return {
    start: '2026-10-03T00:00:00Z', end: '2026-10-03T00:00:05Z',
    in: 'anytls/anytls-in', net: 'tcp', src: '1.2.3.4', host, ip: '', port: '443',
    rule: out === 'direct' ? 'final' : `domain_suffix=${host} => route(${out})`,
    chain: [out], up: 100, down: 2000, ...extra
  };
}

test('connection log: records, active list and daily summary per outbound / host', async () => {
  const env = await singboxEnv();
  assert.equal((await reportSingboxConns(env, 'other', '{}', T0)).status, 403);
  assert.equal((await reportSingboxConns(env, 'srv-hk', 'nope', T0)).status, 400);

  const body = {
    closed: [conn('netflix.com', 'warp'), conn('netflix.com', 'warp'), conn('example.com', 'direct'), { host: '' }],
    active: [conn('openai.com', 'warp', { end: undefined })],
    totals: { up: 5000, down: 90000 }
  };
  assert.equal((await reportSingboxConns(env, 'srv-hk', JSON.stringify(body), T0)).saved, 3, 'invalid record dropped');
  const view = await buildSingboxConnView(env, T0);
  assert.equal(view.enabled, true);
  assert.equal(view.server.name, '阿里云香港');
  assert.equal(view.records.length, 3);
  assert.equal(view.records[0].out, view.records[0].chain[0]);
  assert.equal(view.active[0].host, 'openai.com');
  assert.deepEqual(view.totals, { up: 5000, down: 90000 });
  assert.equal(view.stats.count, 3);
  assert.deepEqual(view.stats.outbounds.map(o => [o.tag, o.count]), [['warp', 2], ['direct', 1]]);
  assert.deepEqual(view.stats.hosts[0], { host: 'netflix.com', count: 2, up: 200, down: 4000, out: 'warp' });

  // 第二天汇总重新计数，记录保留
  const nextDay = T0 + 24 * 3600 * 1000;
  await reportSingboxConns(env, 'srv-hk', JSON.stringify({ closed: [conn('a.com', 'warp')], active: [] }), nextDay);
  const later = await buildSingboxConnView(env, nextDay);
  assert.equal(later.stats.count, 1);
  assert.equal(later.records.length, 4);

  await clearSingboxConns(env);
  assert.equal((await buildSingboxConnView(env, nextDay)).records.length, 0);
});

test('connection log: capped, can be turned off, and dropped when switching servers', async () => {
  const env = await singboxEnv();
  const many = Array.from({ length: MAX_CONN_RECORDS + 50 }, (_, i) => conn(`h${i}.com`, 'warp'));
  await reportSingboxConns(env, 'srv-hk', JSON.stringify({ closed: many }), T0);
  const full = await buildSingboxConnView(env, T0, { limit: 5000 });
  assert.equal(full.records.length, MAX_CONN_RECORDS);
  assert.equal(full.records_total, MAX_CONN_RECORDS);

  assert.equal((await pollSingboxRoute(env, 'srv-hk', '', T0)).connLog, true, 'on by default');
  await setSingboxConnLog(env, false);
  assert.equal((await pollSingboxRoute(env, 'srv-hk', '', T0)).connLog, false);
  assert.equal((await reportSingboxConns(env, 'srv-hk', JSON.stringify({ closed: [conn('x.com', 'warp')] }), T0)).ignored, true);
  assert.equal((await buildSingboxConnView(env, T0)).recording, false);

  await setSingboxServer(env, 'srv-jp');
  assert.equal((await pollSingboxRoute(env, 'srv-jp', '', T0)).connLog, false, 'switch keeps the setting');
  assert.equal((await buildSingboxConnView(env, T0)).records.length, 0, 'old server records dropped');
  await setSingboxServer(env, null);
  assert.equal((await buildSingboxConnView(env, T0)).enabled, false);
});

test('connection view: returns one page at a time and filters on the server', async () => {
  const env = await singboxEnv();
  const closed = Array.from({ length: 120 }, (_, i) => conn(i % 3 === 0 ? `v${i}.netflix.com` : `s${i}.example.com`, i % 3 === 0 ? 'warp' : 'direct'));
  await reportSingboxConns(env, 'srv-hk', JSON.stringify({ closed, active: [conn('chat.openai.com', 'warp')] }), T0);

  const first = await buildSingboxConnView(env, T0);
  assert.equal(first.records.length, 50, 'default page');
  assert.equal(first.records_matched, 120);
  assert.equal(first.records_total, 120);
  assert.equal((await buildSingboxConnView(env, T0, { limit: 100 })).records.length, 100);
  assert.equal((await buildSingboxConnView(env, T0, { limit: 'abc' })).records.length, 50, 'bad limit falls back');

  const warp = await buildSingboxConnView(env, T0, { out: 'warp' });
  assert.equal(warp.records_matched, 40);
  assert.ok(warp.records.every(r => r.out === 'warp'));
  assert.equal(warp.records_total, 120, 'total ignores the filter');

  const search = await buildSingboxConnView(env, T0, { q: 'NETFLIX' });
  assert.equal(search.records_matched, 40, 'case-insensitive, matches host and rule');
  assert.equal(search.active_matched, 0);
  assert.equal((await buildSingboxConnView(env, T0, { q: 'openai' })).active.length, 1);
  assert.equal((await buildSingboxConnView(env, T0, { q: 'nothing-here' })).records.length, 0);
});
