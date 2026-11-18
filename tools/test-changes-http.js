import { TestResources } from './phase1/test-resources.js';
import { assertF1Environment, verifyProductionContract, assertSQLite } from './phase1/r2-f1-contract.js';
// 变更记录 HTTP（R7 · migration 024）：GET /api/changes 的读取面 + 写入路径是否真的都留痕。
//
// 这一层验的是迁移测试验不到的东西：应用层的 withChangeContext 到底包住了哪些写口。
// 剧本刻意走 HTTP（而不是直接 SQL），因为「引擎派生的期限也带 rule_id」「删期限之后
// 那条删除记录仍能按 case_id 查到」这两件事，只有把 records.js / engine.js / 触发器
// 串起来跑才成立。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = new TestResources(import.meta.url);
let primaryError;
try {
assertF1Environment();
const { unsafeNoAuthAllowed, resolveStartupConfig } = await import('../src/lib/startup-config.js');
const unsafeFixtureEnv = { NODE_ENV: 'test', HOST: '127.0.0.1', ANJIAN_UNSAFE_NO_AUTH: '1' };
assert.equal(unsafeNoAuthAllowed(unsafeFixtureEnv), true);
for (const overrides of [{ NODE_ENV: 'production' }, { NODE_ENV: 'Production' }, { HOST: '0.0.0.0' }, { ANJIAN_UNSAFE_NO_AUTH: '' }, { ANJIAN_UNSAFE_NO_AUTH: 'true' }]) {
  assert.equal(unsafeNoAuthAllowed({ ...unsafeFixtureEnv, ...overrides }), false);
}
assert.throws(() => resolveStartupConfig({ ...unsafeFixtureEnv, NODE_ENV: 'production' }, { identityMode: true }), /production 禁止/);
console.log('F1_UNSAFE_PREDICATE ' + JSON.stringify({ passed: true, positive: 1, negative: 5, productionStartupRejected: true,
  limitation: 'product predicate allows any explicit non-production loopback unsafe instance; synthetic-root restriction is supplied by this test runner' }));
await verifyProductionContract(78, resources);
const scratch = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-changes-http-')));
const dbPath = path.join(scratch, 'changes.db');
const logPath = path.join(scratch, 'server.log');
const port = 44000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const log = resources.file(fs.openSync(logPath, 'w'));
const child = resources.child(spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    ANJIAN_UNSAFE_NO_AUTH: '1',
  },
  stdio: ['ignore', log, log],
}));
let db;

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function request(method, route, body, expected = 200) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Anjian-Actor': 'forged-real-user' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  assert.equal(response.status, expected, `${method} ${route}: ${response.status} ${raw}`);
  return data;
}

const changes = (query) => request('GET', `/api/changes?${query}`);

try {
  await waitReady();
  db = resources.database(new Database(dbPath));
  db.pragma('foreign_keys = ON');

  const caseId = db.prepare("INSERT INTO cases(name,stage) VALUES ('张三诉李四合同纠纷（变更记录）','审理中')").run().lastInsertRowid;
  const otherCaseId = db.prepare("INSERT INTO cases(name,stage) VALUES ('另案（变更记录）','审理中')").run().lastInsertRowid;
  const sqlSeedRows = db.prepare('SELECT * FROM change_log ORDER BY id').all();
  assert.equal(sqlSeedRows.length, 2);
  assert.ok(sqlSeedRows.every(item => item.actor === 'system' && item.entity === 'case' && item.action === 'insert'), '直接 SQL 造数没有 HTTP 身份上下文，应为 system');

  // ---- 引擎派生：POST 一个送达事件，规则应派生期限，且这些期限的留痕要带 rule_id ----
  const ev = await request('POST', `/api/cases/${caseId}/events`, { type: 'served', occurred_on: '2026-09-01' });
  const derived = db.prepare('SELECT id,name,rule_id FROM deadlines WHERE case_id=? ORDER BY id').all(caseId);
  assert.ok(derived.length >= 1, 'served 事件应派生期限（否则本剧本的前提不成立）');
  const answer = derived.find((d) => d.rule_id);
  assert.ok(answer, '派生期限应带 rule_id');

  let page = await changes(`case_id=${caseId}&limit=200`);
  const derivedLog = page.items.find((item) => item.entity === 'deadline' && item.entity_id === answer.id && item.action === 'insert');
  assert.ok(derivedLog, '派生期限的插入必须留痕');
  assert.equal(derivedLog.case_id, caseId);
  assert.equal(derivedLog.rule_id, answer.rule_id, '留痕要能回溯「哪条规则算出来的」');
  assert.equal(derivedLog.actor, 'isolated-test', '显式回环非生产 unsafe 测试分支产生 actor，不能采信请求头');
  assert.equal(derivedLog.new_value, answer.name, 'insert 带人类可读标签');
  assert.equal(derivedLog.field, null);

  // ---- 修改期限：逐列留痕 ----
  // 注意这里是「两条」而不是「一条」：把 status 改成 done 会连带写 done_at，
  // 底账记的是真实发生的列级改动，不是「用户点了几个按钮」。
  const beforeUpdate = (await changes(`case_id=${caseId}&entity=deadline&limit=200`)).items.length;
  await request('PATCH', `/api/deadlines/${answer.id}`, { status: 'done' });
  page = await changes(`case_id=${caseId}&entity=deadline&limit=200`);
  const freshRows = page.items.slice(0, page.items.length - beforeUpdate);
  assert.deepEqual(freshRows.map((item) => item.field).sort(), ['done_at', 'status']);
  assert.ok(freshRows.every((item) => item.action === 'update' && item.entity_id === answer.id && item.case_id === caseId));
  assert.ok(freshRows.every((item) => item.actor === 'isolated-test'), 'PATCH 走 HTTP，应是隔离 apiAuth 的 req.actor 而不是 system');
  const statusRow = freshRows.find((item) => item.field === 'status');
  assert.equal(statusRow.old_value, 'pending');
  assert.equal(statusRow.new_value, 'done');
  assert.equal(statusRow.rule_id, null, '人工改状态不由规则引起，不该挂规则 id');

  // 值没变的写入不留痕
  const beforeEmptyWrite = (await changes(`case_id=${caseId}&limit=200`)).items.length;
  await request('PATCH', `/api/deadlines/${answer.id}`, { status: 'done' });
  assert.equal((await changes(`case_id=${caseId}&limit=200`)).items.length, beforeEmptyWrite, '空写不该留痕');

  // ---- 待办：完成动作会连带写一条工作日志，两条都要留痕且同属本案 ----
  const task = await request('POST', '/api/tasks', { case_id: caseId, title: '提交委托材料' });
  await request('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
  const taskLogs = (await changes(`case_id=${caseId}&entity=task&limit=200`)).items;
  assert.ok(taskLogs.some((item) => item.action === 'insert' && item.new_value === '提交委托材料'), '待办新增带标题');
  assert.ok(taskLogs.some((item) => item.action === 'update' && item.field === 'status' && item.new_value === 'done'), '待办完成留痕');
  const worklogLogs = (await changes(`case_id=${caseId}&entity=worklog&limit=200`)).items;
  assert.ok(worklogLogs.some((item) => item.action === 'insert'), '完成待办连带写的工作日志也要留痕');

  // ---- 案件字段修改：PATCH /cases/:id 也要留痕 ----
  await request('PATCH', `/api/cases/${caseId}`, { note: '改一笔备注' });
  assert.ok(
    (await changes(`case_id=${caseId}&entity=case&limit=200`)).items.some((item) => item.field === 'note' && item.new_value === '改一笔备注'),
    '案件字段修改要留痕',
  );

  // ---- 加 case_id 的核心动机：期限被删掉之后，那条删除记录仍能按案件查到 ----
  // 反面参照：同一时刻按 entity+entity_id 查是查得到的（id 还在底账里），
  // 但如果当初没落 case_id，案件页就再也取不到这条——源行没了，没有别的路回到案件。
  const removed = answer.id;
  await request('DELETE', `/api/deadlines/${removed}`);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM deadlines WHERE id=?').get(removed).c, 0, '期限已从业务表消失');
  const afterDelete = await changes(`case_id=${caseId}&limit=200`);
  const deleteRecord = afterDelete.items.find((item) => item.entity === 'deadline' && item.entity_id === removed && item.action === 'delete');
  assert.ok(deleteRecord, '删除记录必须还能按 case_id 取到（这正是加 case_id 的动机）');
  assert.equal(deleteRecord.case_id, caseId);
  assert.ok(deleteRecord.old_value, 'delete 要留下行标签，否则不知道删掉的是哪条');

  // ---- 案件隔离：另案的变更不会串进本案 ----
  await request('POST', '/api/worklog', { case_id: otherCaseId, content: '另案的日志' });
  const mine = (await changes(`case_id=${caseId}&limit=200`)).items;
  assert.ok(mine.every((item) => item.case_id === caseId), '按 case_id 取到的行必须全属本案');
  const theirs = (await changes(`case_id=${otherCaseId}&limit=200`)).items;
  assert.ok(theirs.length >= 1);
  assert.ok(theirs.every((item) => item.case_id === otherCaseId));
  assert.ok(mine.filter(item => item.entity !== 'case' || item.action !== 'insert').every(item => item.actor === 'isolated-test'));
  assert.ok(theirs.filter(item => item.entity !== 'case' || item.action !== 'insert').every(item => item.actor === 'isolated-test'), '另案 HTTP 操作保留同一隔离来源，不能串案');
  assert.ok(!JSON.stringify([...mine, ...theirs]).includes('forged-real-user'), '请求方不能覆盖审计主体');

  // ---- 参数校验：审计面宁可报错，不静默纠正 ----
  await request('GET', '/api/changes?limit=201', undefined, 400);
  await request('GET', '/api/changes?limit=0', undefined, 400);
  await request('GET', '/api/changes?limit=abc', undefined, 400);
  await request('GET', '/api/changes?entity=casee', undefined, 400);
  await request('GET', '/api/changes?case_id=0', undefined, 400);
  await request('GET', '/api/changes?case_id=x', undefined, 400);
  await request('GET', '/api/changes?entity_id=-3', undefined, 400);
  await request('GET', '/api/changes?before=0', undefined, 400);
  // 空串表示不筛选，不是错误
  assert.ok((await changes(`case_id=${caseId}&entity=&limit=200`)).items.length >= 1);

  // ---- 游标分页：翻完不重不漏，且末页 next_before 为 null ----
  const all = (await changes(`case_id=${caseId}&limit=200`)).items;
  const httpRows = db.prepare('SELECT * FROM change_log WHERE id>? ORDER BY id').all(sqlSeedRows.at(-1).id);
  assert.ok(httpRows.length > 5);
  assert.ok(httpRows.every(item => item.actor === 'isolated-test'), '每条 HTTP 产生的留痕都要有准确来源');
  assert.ok(all.length > 5, `本案应有足够多的变更可用于翻页（实得 ${all.length}）`);
  const collected = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard++) {
    const q = `case_id=${caseId}&limit=3${cursor === null ? '' : `&before=${cursor}`}`;
    const p = await changes(q);
    assert.ok(p.items.length <= 3);
    collected.push(...p.items.map((item) => item.id));
    if (p.next_before === null) break;
    cursor = p.next_before;
  }
  assert.deepEqual(collected, all.map((item) => item.id), '游标翻页结果应与一次取齐完全相同（不重不漏）');

  // next_before 要能自己回答「还有没有」：取满整页不等于还有下一页。
  const exact = await changes(`case_id=${caseId}&limit=${all.length}`);
  assert.equal(exact.items.length, all.length);
  assert.equal(exact.next_before, null, '恰好取满且确实到底时应给 null，不该让前端多打一次空请求');
  const partial = await changes(`case_id=${caseId}&limit=${all.length - 1}`);
  assert.equal(partial.next_before, partial.items[partial.items.length - 1].id);

  // ---- 底账不可改：连直连数据库也删不掉 ----
  assert.throws(() => db.prepare("UPDATE change_log SET actor='x' WHERE id=1").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM change_log WHERE id=1').run(), /append-only/);

  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assertSQLite(db);
  console.log('F1_ACTOR ' + JSON.stringify({ id: 'R2-78', status: 'passed', actor: 'isolated-test',
    source: 'unchanged apiAuth unsafeNoAuthAllowed: explicit switch + non-production + loopback',
    productionIdentity: 'separately verified DB user id and user audit fields; business remains closed',
    crossCase: true, appendOnly: true, originalAuditMatrix: true, sqlite: 'ok' }));
  console.log('changes HTTP tests: change_log read API + engine-derived rule_id + case_id attribution (incl. after delete) + case isolation + cursor pagination + param validation + append-only passed');
} finally {




  // Owned resources are closed in the outer finally before directory removal.
}

} catch (error) {
  primaryError = error;
  console.error(error);
  process.exitCode = 1;
} finally {
  await resources.finish(primaryError);
}
