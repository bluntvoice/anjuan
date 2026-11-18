// W04 partial evidence only. No symlink substitute; original link-dependent HTTP successors remain unstarted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { TestResources } from './test-resources.js';
import { assertF1Environment, assertSQLite } from './r2-f1-contract.js';
import { f2Request } from './r2-f2-contract.js';
import { startIdentityServer } from './http-fixture.js';
import { normalizeCaseDirectoryName, resolveCaseDirectory, resolveCaseDirectoryForCase, inspectSecureDirectory,
  inspectSecureFile, openSecureFile, listSecureDirectory, walkSecureFiles, writeUniqueSecureFile } from '../../src/lib/secure-files.js';
const resources = new TestResources(import.meta.url);
let primaryError;
try {
  assertF1Environment();
  const scratch = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'w04-independent-')));
  const files = path.join(scratch, 'files'), outside = path.join(scratch, 'synthetic-outside');
  fs.mkdirSync(files); fs.mkdirSync(outside);
  const sentinel = path.join(outside, 'sentinel.txt'); fs.writeFileSync(sentinel, 'outside unchanged');
  const rows = [];
  function check(id, original, work) { work(); rows.push({ id, original, status: 'passed' }); }
  check('names', 'test-secure-files.js: normalization', () => {
    for (const invalid of ['', ' ', '.', '..', '.隐藏案', '../逃逸', 'a/b', 'a\\b', '/绝对', '坏\0名', '坏\n名']) assert.equal(normalizeCaseDirectoryName(invalid), null);
    assert.equal(normalizeCaseDirectoryName(' 示例案件 '), '示例案件');
  });
  const caseRoot = path.join(files, '示例案件'); fs.mkdirSync(path.join(caseRoot, '法院文书'), { recursive: true });
  const originalFile = path.join(caseRoot, '法院文书', '正常材料.txt'); fs.writeFileSync(originalFile, 'original inode');
  const context = resolveCaseDirectory(files, '示例案件');
  check('read-list-walk', 'test-secure-files.js: ordinary authoritative-root positives', () => {
    assert(context.exists); assert(inspectSecureDirectory(context, '法院文书').stat.isDirectory());
    assert(inspectSecureFile(context, '法院文书/正常材料.txt').stat.isFile());
    assert.deepEqual(listSecureDirectory(context, '法院文书').files.map(f => f.name), ['正常材料.txt']);
    assert.deepEqual(walkSecureFiles(context), ['法院文书/正常材料.txt']);
  });
  check('traversal-no-write', 'additional non-link containment negatives; not symlink evidence', () => {
    for (const rel of ['../../synthetic-outside/sentinel.txt', '/absolute', '法院文书\\正常材料.txt', '../other']) {
      assert.throws(() => openSecureFile(context, rel), error => error.code === 'invalid_path');
    }
    assert.throws(() => writeUniqueSecureFile(context, '../synthetic-outside', 'must-not-write.txt', Buffer.from('denied')), error => error.code === 'invalid_path');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside unchanged');
    assert.equal(fs.existsSync(path.join(outside, 'must-not-write.txt')), false);
  });
  check('exclusive-writes', 'test-secure-files.js: normal duplicate-name write', () => {
    const first = writeUniqueSecureFile(context, '法院文书', '上传材料.pdf', Buffer.from('one'));
    const second = writeUniqueSecureFile(context, '法院文书', '上传材料.pdf', Buffer.from('two'));
    assert.equal(first.relativePath, '法院文书/上传材料.pdf'); assert.equal(second.relativePath, '法院文书/上传材料(2).pdf');
    assert.equal(fs.readFileSync(first.absolute, 'utf8'), 'one'); assert.equal(fs.readFileSync(second.absolute, 'utf8'), 'two');
  });
  check('inode-read-after-replacement', 'test-secure-files.js: already-open fd remains bound to original inode', () => {
    const opened = openSecureFile(context, '法院文书/正常材料.txt');
    try {
      fs.renameSync(originalFile, originalFile + '.old'); fs.writeFileSync(originalFile, 'replacement');
      assert.equal(fs.readFileSync(opened.fd, 'utf8'), 'original inode');
    } finally { fs.closeSync(opened.fd); }
  });
  check('stale-directory', 'test-secure-files.js: renamed/recreated case directory invalidates old context', () => {
    fs.renameSync(caseRoot, caseRoot + '-old'); fs.mkdirSync(caseRoot);
    assert.throws(() => inspectSecureDirectory(context), error => error.code === 'path_changed');
  });
  check('fallback-authority', 'test-secure-files-folder-fallback.js: non-link prefix only', () => {
    const name = '同名案件夹', missing = '失效主指针';
    const sameName = path.join(files, name); fs.mkdirSync(sameName); fs.writeFileSync(path.join(sameName, '证据.txt'), 'fallback');
    const fallback = resolveCaseDirectoryForCase(files, { name, folder_path: missing });
    assert(fallback.exists); assert.equal(fallback.name, name); assert.equal(fallback.caseRoot, fs.realpathSync.native(sameName));
    assert.equal(fallback.fallbackFrom, missing); assert.equal(fallback.fallbackNotice, `原案件夹“${missing}”不存在，已临时回落到同名目录“${name}”`);
    assert.equal(fs.readFileSync(path.join(fallback.caseRoot, '证据.txt'), 'utf8'), 'fallback');
    assert.equal(fs.existsSync(path.join(files, missing)), false);
    fs.mkdirSync(path.join(files, missing));
    const primary = resolveCaseDirectoryForCase(files, { name, folder_path: missing });
    assert.equal(primary.name, missing); assert.equal(primary.fallbackFrom, undefined);
    fs.rmdirSync(path.join(files, missing)); fs.writeFileSync(path.join(files, missing), 'ordinary file is not a directory');
    assert.throws(() => resolveCaseDirectoryForCase(files, { name, folder_path: missing }), error => error.code === 'not_directory');
    const none = resolveCaseDirectoryForCase(files, { name: '同名也无', folder_path: '主指针也无' });
    assert.equal(none.exists, false); assert.equal(none.name, '主指针也无'); assert.equal(none.fallbackFrom, undefined);
  });
  process.env.DB_PATH = path.join(scratch, 'component.db');
  const { db } = await import('../../src/db.js'); resources.database(db);
  const { loadAgentConfig } = await import('../../src/agent/config.js');
  assert.deepEqual(loadAgentConfig(), { enabled: false }, 'default configuration rejects agent capability without creating any worker');
  assertSQLite(db);
  console.log('W04_NONLINK ' + JSON.stringify({ status: 'passed', rows, defaultAgentConfig: { enabled: false }, sqlite: 'ok',
    limitation: 'independent selected non-link component assertions; original R2-20/R2-58 scripts and HTTP successors not executed' }));

  const backend = await startIdentityServer();
  const request = (route, options) => f2Request(backend.address, route, options);
  let stopped = false;
  const stop = async () => {
    if (!stopped) { await backend.stop(); await assert.rejects(request('/healthz'), error => error.code === 'ECONNREFUSED'); stopped = true; }
    return { pid: backend.child.pid, address: backend.address, stopped, signal: backend.child.signalCode, portReleased: true };
  };
  resources.cleanup('W04 production backend and port', stop, 20); resources.directory(backend.root);
  const productionDb = resources.database(new Database(backend.database));
  const password = crypto.randomBytes(24).toString('base64');
  const init = await request('/api/bootstrap/initialize', { method: 'POST', headers: { 'X-Anjuan-Bootstrap': backend.key }, body: { username: 'W04SyntheticAdmin', password } });
  assert.equal(init.status, 201);
  const login = await request('/api/login', { method: 'POST', body: { username: 'W04SyntheticAdmin', password } }); assert.equal(login.status, 200); assert(login.cookie);
  const productionRows = [];
  const tables = ['cases', 'settings', 'events', 'deadlines', 'tasks', 'worklog', 'inbox', 'change_log'];
  const snapshot = () => Object.fromEntries(tables.map(table => [table, productionDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = snapshot();
  for (const [route, method, body] of [
    ['/api/settings', 'GET'], ['/api/settings', 'PUT', { agent_enabled: true }], ['/api/agent/status', 'GET'],
    ['/api/cases/1/agent/start', 'POST', {}], ['/api/cases/1/files', 'GET'], ['/api/cases/1/file?path=sentinel.txt', 'GET'],
    ['/api/cases/1/files?name=denied.txt', 'PUT', { content: 'denied' }],
  ]) {
    for (const [identity, options, status] of [
      ['anonymous', {}, 401], ['old key', { headers: { 'X-Anjian-Key': backend.internalKey } }, 401],
      ['synthetic DB admin', { cookie: login.cookie }, 403],
    ]) {
      const response = await request(route, { method, body, ...options }); assert.equal(response.status, status);
      if (status === 403) assert.equal(response.json.code, 'phase1_business_closed');
      productionRows.push({ route, method, identity, status: response.status, code: response.json?.code || null });
    }
  }
  assert.deepEqual(snapshot(), before, 'closed file/agent/settings calls must not write business state');
  assert.equal(productionDb.prepare("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'agent%'").get().n, 0);
  assert.deepEqual(fs.readdirSync(path.join(backend.root, 'agent-sessions')), []);
  const auditText = JSON.stringify(productionDb.prepare('SELECT * FROM audit_log').all());
  for (const secret of [password, backend.internalKey, backend.key, login.cookie, login.cookie.split('=')[1]]) assert(!auditText.includes(secret));
  assertSQLite(productionDb);
  console.log('W04_PRODUCTION_CLOSED ' + JSON.stringify({ status: 'passed', rows: productionRows, noBusinessWrites: true,
    noAgentAuditOrSessionFiles: true, sqlite: 'ok', limitation: 'production closed/default-deny evidence only; no Agent worker or open file business capability' }));
  await stop();
} catch (error) { primaryError = error; console.error(error); process.exitCode = 1; }
finally { await resources.finish(primaryError); }
