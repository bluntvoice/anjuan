import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import backup from '../../electron/identity-backup.cjs';
import atomic from '../../electron/atomic-json.cjs';
import passwordHash from '../../src/lib/password-hash.cjs';
import { startIdentityServer } from '../phase1/http-fixture.js';
import { TestResources, bounded } from '../phase1/test-resources.js';

const resources = new TestResources(import.meta.url);
const password = () => crypto.randomBytes(25).toString('base64');
let error;
const result = { runtime: process.versions.electron || process.version, node: process.versions.node, assertions: [] };

function request(server, route, { method = 'GET', cookie, body, headers = {} } = {}) {
  const payload = Buffer.isBuffer(body) ? body : body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, server.address), { method, headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(payload ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
        'Content-Length': payload.length } : {}),
      ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        const bytes = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(bytes); } catch { /* HTML or file */ }
        resolve({ status: res.statusCode, json, bytes, headers: res.headers,
          cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
      });
    });
    req.once('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('synthetic loopback timeout')));
    req.end(payload);
  });
}

function integrity(database) {
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

const root = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'anjuan-p2-')));
const dataDir = path.join(root, 'd');
const database = path.join(dataDir, 'anjian.db');
const filesRoot = path.join(dataDir, '案件夹');
fs.mkdirSync(dataDir);
const obsoletePassword = password();
const legacyCredentials = { username: 'Phase2ObsoleteEnv', hash: passwordHash.hashPassword(obsoletePassword) };
const config = path.join(root, 'config.json');
let server;
const removeLinks = [];

function enrollLink(file, type) {
  const owned = fs.lstatSync(file);
  const remove = () => {
    let current;
    try { current = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.equal(current.ino, owned.ino);
    assert.equal(current.dev, owned.dev);
    if (type === 'junction') fs.rmdirSync(file);
    else fs.unlinkSync(file);
  };
  removeLinks.push(remove);
  resources.cleanup('owned synthetic ' + type, remove, 40);
}

async function start() {
  const handle = await startIdentityServer({ database, filesRoot, r2LegacyCredentials: legacyCredentials, r2InternalKeySource: 'electron-auto' });
  resources.directory(handle.root);
  resources.cleanup('synthetic backend exit', () => handle.stop(), 20);
  return handle;
}

async function expect(label, route, options, status, code) {
  const response = await request(server, route, options);
  assert.equal(response.status, status, label);
  if (code) assert.equal(response.json?.code, code, label);
  result.assertions.push({ label, method: options?.method || 'GET', status });
  return response;
}

async function stopNormally(handle) {
  const exited = once(handle.child, 'exit');
  handle.child.send({ type: 'anjuan:shutdown' });
  const [code, signal] = await bounded(exited, 'normal IPC shutdown', 12000);
  assert.equal(code, 0);
  assert.equal(signal, null);
  await assert.rejects(request(handle, '/healthz'), { code: 'ECONNREFUSED' });
  await handle.stop();
  assert.match(fs.readFileSync(path.join(handle.root, 'server-output.log'), 'utf8'), /received IPC/);
  return code;
}

try {
  server = await start();
  const db = resources.database(new Database(database));
  try {
    const adminPassword = password();
    await expect('anonymous read', '/api/cases', {}, 401);
    await expect('old environment credentials', '/api/login', { method: 'POST',
      body: { username: legacyCredentials.username, password: obsoletePassword } }, 401);
    await expect('old static cookie', '/api/cases', { cookie: 'anjian_token=' + server.staticToken }, 401);
    await expect('old session cookie', '/api/cases', { cookie: 'anjian_sess=' + server.staticToken }, 401);
    await expect('admin initialization', '/api/bootstrap/initialize', { method: 'POST',
      body: { username: 'SyntheticP2Admin', display_name: '合成管理员', password: adminPassword },
      headers: { 'X-Anjuan-Bootstrap': server.key } }, 201);

    const login = (username, pass) => expect('login ' + username, '/api/login',
      { method: 'POST', body: { username, password: pass } }, 200);
    const admin = await login('SyntheticP2Admin', adminPassword);
    const editorPassword = password();
    const viewerPassword = password();
    const addUser = (username, role_key, pass) => expect('create ' + role_key, '/api/users',
      { cookie: admin.cookie, method: 'POST', body: { username, display_name: username, role_key, password: pass } }, 201);
    const editorUser = (await addUser('SyntheticP2Editor', 'editor', editorPassword)).json.user;
    await addUser('SyntheticP2Viewer', 'viewer', viewerPassword);
    const editor = await login('SyntheticP2Editor', editorPassword);
    const viewer = await login('SyntheticP2Viewer', viewerPassword);
    const landing = await expect('authenticated workspace', '/', { cookie: viewer.cookie }, 302);
    assert.equal(landing.headers.location, '/phase2.html');
    const html = await expect('workspace HTML', '/phase2.html', { cookie: viewer.cookie }, 200);
    assert.match(html.bytes.toString(), /<button id="new-case"[^>]* hidden/);
    assert.equal(html.headers['cache-control'], 'no-store');
    await expect('legacy finance page closed', '/finance.html', { cookie: admin.cookie }, 403);
    const options = (await expect('case procedure choices', '/api/case-options', { cookie: viewer.cookie }, 200)).json;

    const write = (name, route, user, method, body, status, code, headers) =>
      expect(name, route, { cookie: user.cookie, method, body, headers }, status, code);
    const read = (name, route, user, status = 200, code) => expect(name, route, { cookie: user.cookie }, status, code);
    const a = (await write('admin creates A', '/api/cases', admin, 'POST',
      { name: '合成案A', case_no: 'A-00', note: '仅合成', folder_path: 'Synthetic-A' }, 201)).json;
    const b = (await write('editor creates B', '/api/cases', editor, 'POST',
      { name: '合成案B', client: '合成当事人', folder_path: 'Synthetic-B', procedure: '二审' }, 201)).json;
    const pa = '/api/cases/' + a.id, pb = '/api/cases/' + b.id;
    await write('case actor field rejected', '/api/cases', editor, 'POST', { name: '合成拒绝', actor: admin.json.user.id }, 400, 'fields_invalid');
    await write('workspace duplicate', '/api/cases', editor, 'POST', { name: '重复目录', folder_path: 'Synthetic-A' }, 409);
    if (process.platform === 'win32') {
      await write('workspace duplicate Windows case-insensitive', '/api/cases', editor, 'POST',
        { name: '同目录别名', folder_path: 'synthetic-a' }, 409);
    }
    for (const name of ['CON.txt', 'name:stream', 'trailing.']) {
      await write('invalid Windows directory ' + name, '/api/cases', admin, 'POST', { name: '合成目录无效', folder_path: name }, 400);
    }
    const status = (await write('editor changes admin case status and stage', pa, editor, 'PATCH',
      { status: 'closed', stage: options.procedures[a.procedure][1], version: a.version }, 200, null,
      { 'X-Anjian-Actor': admin.json.user.id })).json;
    assert.equal(status.status, 'closed');
    assert.equal(status.version, a.version + 1);
    assert(status.stage_change_log);
    await write('stale case edit', pa, admin, 'PATCH', { status: 'active', version: a.version }, 409, 'version_conflict');
    const updatedB = (await write('admin edits editor case', pb, admin, 'PATCH',
      { court: '合成机构', version: b.version }, 200)).json;
    const race = await Promise.all([admin, editor].map((user, index) => request(server, pb, {
      method: 'PATCH', cookie: user.cookie, body: { version: updatedB.version, note: '合成并发修订 ' + index },
    })));
    assert.deepEqual(race.map(response => response.status).sort(), [200, 409]);
    result.concurrent_case_edits = race.map(response => response.status);
    const addEvent = db.prepare("INSERT INTO events(case_id,type,occurred_on) VALUES(?,?,'2026-11-18')");
    const legacyAudit = db.prepare("INSERT INTO audit_log(actor,entity,action,entity_id) VALUES('synthetic-history',?,?,?)");
    const eventA = addEvent.run(a.id, 'judgment_served').lastInsertRowid;
    legacyAudit.run('event', 'create', eventA);
    const eventB = addEvent.run(b.id, 'judgment_served').lastInsertRowid;
    legacyAudit.run('event', 'create', eventB);
    addEvent.run(b.id, 'evidence_notice');
    const versionB = db.prepare('SELECT version FROM cases WHERE id=?').pluck().get(b.id);
    const derived = (await write('case edit generates deadline and task from existing events', pb, editor, 'PATCH',
      { procedure: '一审', stage: options.procedures['一审'][0], version: versionB }, 200)).json;
    assert(derived.reconciled.deadlines.some(row => row.rule_id === 'appeal_judgment'));
    assert(derived.reconciled.tasks.length > 0);
    assert(status.templated.length > 0);
    await write('unsupported case stage', pa, admin, 'PATCH', { stage: '未知', version: status.version }, 400);
    await write('case edit requires version', pa, admin, 'PATCH', { note: '无版本' }, 400, 'version_required');

    const contact = (await write('add contact', pa + '/contacts', editor, 'POST',
      { name: '合成联系人', role: '当事人', phone: 'synthetic' }, 201)).json;
    await write('update contact', pa + '/contacts/' + contact.id, admin, 'PATCH',
      { org: '合成单位', version: contact.version }, 200);
    await write('cross-case contact', pb + '/contacts/' + contact.id, editor, 'PATCH',
      { name: '不得更新', version: contact.version + 1 }, 404, 'contact_not_found');
    await write('stale contact', pa + '/contacts/' + contact.id, editor, 'PATCH',
      { tel: 'invalid' }, 400, 'fields_invalid');
    await write('contact version conflict', pa + '/contacts/' + contact.id, editor, 'PATCH',
      { phone: 'invalid', version: contact.version }, 409, 'version_conflict');
    const fact = (await write('add fact', pa + '/facts', admin, 'POST',
      { content: '合成事实', occurred_on: '2026-11-19', source: '人工录入' }, 201)).json;
    await write('editor edits fact', pa + '/facts/' + fact.id, editor, 'PATCH',
      { note: '核对合成内容', version: fact.version }, 200);
    await write('cross-case fact', pb + '/facts/' + fact.id, editor, 'PATCH',
      { content: '不得更新', version: fact.version + 1 }, 404, 'fact_not_found');
    await write('stale fact', pa + '/facts/' + fact.id, editor, 'PATCH',
      { note: '不得更新', version: fact.version }, 409, 'version_conflict');

    const legacyFee = db.prepare(`INSERT INTO fee_items(case_id,label,amount,amount_fen,status,note)
      VALUES(?,'旧合成款',11.25,1125,'waived','原始备注')`).run(a.id).lastInsertRowid;
    legacyAudit.run('fee', 'create', legacyFee);
    legacyAudit.run('fee', 'update', legacyFee);
    const missingFee = db.prepare("INSERT INTO fee_items(case_id,label) VALUES(?,'金额待定')").run(a.id).lastInsertRowid;
    const zeroFee = db.prepare("INSERT INTO fee_items(case_id,label,amount,amount_fen) VALUES(?,'金额为零',0,0)").run(a.id).lastInsertRowid;
    const oldB = db.prepare("INSERT INTO fee_items(case_id,label) VALUES(?,'另一案件历史费用')").run(b.id).lastInsertRowid;
    legacyAudit.run('fee', 'create', oldB);
    const preservedLegacyFee = db.prepare('SELECT * FROM fee_items WHERE id=?').get(legacyFee);
    const input = { agreed_amount: '10.05', payable_percent: '50', status: 'unpaid', note: '合成备注' };
    const fee = (await write('admin adds fee', pa + '/fees', admin, 'POST', input, 201)).json;
    assert.equal(fee.payable_amount, '5.03');
    const paid = (await write('editor edits fee', pa + '/fees/' + fee.id, editor, 'PATCH',
      { ...input, payable_percent: '90', status: 'paid', version: fee.version }, 200)).json;
    assert.equal(paid.payable_amount, '9.05');
    assert.equal(paid.status, 'paid');
    await write('stale fee', pa + '/fees/' + fee.id, admin, 'PATCH', { ...input, version: fee.version }, 409, 'version_conflict');
    await write('cross-case fee', pb + '/fees/' + fee.id, admin, 'PATCH', { ...input, version: paid.version }, 404, 'fee_not_found');
    await write('historical fee sealed', pa + '/fees/' + legacyFee, admin, 'PATCH', { ...input, version: 1 }, 409, 'legacy_fee_read_only');
    await write('historical fee in another case is not found', pa + '/fees/' + oldB, editor, 'PATCH',
      { ...input, version: 1 }, 404, 'fee_not_found');
    assert.deepEqual(db.prepare('SELECT * FROM fee_items WHERE id=?').get(legacyFee), preservedLegacyFee);
    for (const [tag, extra, code] of [
      ['non-decimal amount', { agreed_amount: '1e3' }, 'fee_amount_invalid'], ['negative amount', { agreed_amount: '-0.01' }, 'fee_amount_invalid'],
      ['amount precision', { agreed_amount: '3.141' }, 'fee_amount_invalid'], ['ratio precision', { payable_percent: '90.123' }, 'fee_amount_invalid'],
      ['ratio range', { payable_percent: '100.01' }, 'fee_amount_invalid'], ['historical state', { status: 'waived' }, 'fee_status_invalid'],
      ['settlement field fails', { settlement: 'x' }, 'fields_invalid'],
    ]) await write(tag, pa + '/fees', admin, 'POST', { ...input, ...extra }, 400, code);
    const zero = (await write('zero percent', pa + '/fees', editor, 'POST', { ...input, payable_percent: '0' }, 201)).json;
    assert.equal(zero.payable_amount, '0.00');
    const feeB = (await write('full percent', pb + '/fees', editor, 'POST', { ...input, payable_percent: '100' }, 201)).json;
    assert.equal(feeB.payable_amount, '10.05');
    assert.equal(db.prepare('SELECT amount_fen FROM fee_items WHERE id=?').get(legacyFee).amount_fen, 1125);

    const upload = (name, user, status, extras = {}, rootPath = pa) => write('upload ' + name,
      rootPath + '/files?' + new URLSearchParams({ name, dir: '证据整理', ...extras }), user, 'PUT', Buffer.from('synthetic evidence'), status);
    const file = (await upload('合成甲.txt', editor, 200, { entity: 'fee', entity_id: fee.id })).json;
    assert.equal(file.attachment.case_id, a.id);
    assert.equal(file.attachment.entity_id, fee.id);
    await upload('cross-case.txt', editor, 404, { entity: 'fee', entity_id: feeB.id });
    await upload('CON.txt', editor, 400);
    await upload('a:stream', admin, 400);
    const filePath = path.join(filesRoot, 'Synthetic-A', ...file.rel_path.split('/'));
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'synthetic evidence');
    const collision = (await upload('合成甲.txt', admin, 200)).json;
    assert.notEqual(collision.rel_path, file.rel_path);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'synthetic evidence');
    assert(!fs.existsSync(path.join(path.dirname(filePath), 'cross-case.txt')));
    await write('attach existing file', pa + '/attachments', admin, 'POST', { rel_path: file.rel_path }, 201);
    await write('cross-case attachment target', pa + '/attachments', admin, 'POST',
      { rel_path: file.rel_path, entity: 'fee', entity_id: feeB.id }, 404, 'attachment_target_missing');
    const download = (base, relative) => base + '/file?' + new URLSearchParams({ path: relative });
    const fileHead = await expect('authenticated file HEAD', download(pa, file.rel_path),
      { method: 'HEAD', cookie: viewer.cookie }, 200);
    assert.equal(fileHead.bytes.length, 0);
    assert.equal(fileHead.headers['cache-control'], 'no-store');
    await read('file cannot be read from different case', download(pb, file.rel_path), viewer, 404);
    await read('invalid relative path rejected', download(pa, '../Synthetic-B/test.txt'), admin, 404);
    await expect('unsafe compressed request rejected', pa, { method: 'PATCH', cookie: editor.cookie,
      headers: { 'Content-Encoding': 'gzip' }, body: { version: status.version, note: '合成' } }, 415);

    const protectedFile = path.join(root, 'outside.txt');
    fs.writeFileSync(protectedFile, 'outside synthetic case');
    const hard = path.join(filesRoot, 'Synthetic-A', 'hard.txt');
    fs.linkSync(protectedFile, hard);
    enrollLink(hard, 'hardlink');
    await read('multi-link file refused', download(pa, 'hard.txt'), viewer, 404);
    if (process.platform === 'win32') {
      const junction = path.join(filesRoot, 'Synthetic-A', 'redirected');
      fs.symlinkSync(root, junction, 'junction');
      enrollLink(junction, 'junction');
      await read('real junction refused', download(pa, 'redirected/outside.txt'), viewer, 404);
      for (const kind of ['file', 'dir']) {
        const link = path.join(filesRoot, 'Synthetic-A', 'explicit-' + kind);
        try {
          fs.symlinkSync(kind === 'file' ? protectedFile : root, link, kind);
          enrollLink(link, kind + ' symlink');
          await read('real ' + kind + ' symlink refused',
            download(pa, kind === 'file' ? 'explicit-file' : 'explicit-dir/outside.txt'), viewer, 404);
          result['native_symlink_' + kind] = 'passed';
        } catch (e) {
          if (!['EPERM', 'EACCES'].includes(e.code)) throw e;
          result['native_symlink_' + kind] = 'blocked: ' + e.code;
        }
      }
    }
    const finance = path.join(filesRoot, 'Synthetic-A', '财务凭证');
    fs.mkdirSync(finance);
    fs.writeFileSync(path.join(finance, 'closed.txt'), 'historical synthetic voucher');
    await read('voucher subtree remains closed', download(pa, '财务凭证/closed.txt'), admin, 404);
    const rootList = await read('file listing hides closed and linked files', pa + '/files', viewer);
    assert(!rootList.json.dirs.includes('财务凭证'));
    assert(!rootList.json.files.some(row => row.name === 'hard.txt'));
    assert.equal(Object.hasOwn(rootList.json, 'legalrag_enabled'), false);

    const tables = ['cases', 'contacts', 'facts', 'fee_items', 'phase2_fee_terms', 'attachments', 'tasks', 'worklog', 'change_log'];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
    const before = snapshot();
    for (const [label, route, method, body] of [
      ['create case', '/api/cases', 'POST', { name: '拒绝目标' }],
      ['edit case', pa, 'PATCH', { version: status.version, status: 'active' }],
      ['add contact', pa + '/contacts', 'POST', { name: '拒绝目标', role: '其他' }],
      ['edit contact', pa + '/contacts/' + contact.id, 'PATCH', { version: contact.version + 1, note: '拒绝目标' }],
      ['add fact', pa + '/facts', 'POST', { content: '拒绝目标' }],
      ['edit fact', pa + '/facts/' + fact.id, 'PATCH', { version: fact.version + 1, content: '拒绝目标' }],
      ['add fee', pa + '/fees', 'POST', input],
      ['edit fee', pa + '/fees/' + fee.id, 'PATCH', { ...input, version: paid.version }],
      ['attach file', pa + '/attachments', 'POST', { rel_path: file.rel_path }],
    ]) await write('viewer denied ' + label, route, viewer, method, body, 403, 'case_forbidden', { 'X-Anjian-Actor': admin.json.user.id });
    await upload('viewer-denied.txt', viewer, 403);
    assert(!fs.existsSync(path.join(path.dirname(filePath), 'viewer-denied.txt')));
    await read('editor denied audit', pa + '/audit', editor, 403, 'audit_forbidden');
    await read('viewer denied audit', pa + '/audit', viewer, 403, 'audit_forbidden');
    for (const user of [admin, editor, viewer]) {
      const role = user.json.user.role_key;
      const listing = (await read(role + ' reads both cases', '/api/cases', user)).json;
      assert.deepEqual(listing.map(row => row.id).sort(), [a.id, b.id]);
      await read(role + ' reads editor detail', pb, user);
      await read(role + ' reads admin detail', pa, user);
      await read(role + ' reads contacts', pa + '/contacts', user);
      await read(role + ' reads facts', pa + '/facts', user);
      assert.equal((await read(role + ' reads file', download(pa, file.rel_path), user)).bytes.toString(), 'synthetic evidence');
      const fares = (await read(role + ' reads fees', pa + '/fees', user)).json;
      assert.deepEqual(fares.totals, { unpaid_fen: '0', paid_fen: '905', legacy_count: 3 });
      assert.equal(fares.items.find(row => row.id === missingFee).recorded_amount, null);
      assert.equal(fares.items.find(row => row.id === zeroFee).recorded_amount, '0.00');
      const old = fares.items.find(row => row.id === legacyFee);
      assert.deepEqual([old.legacy, old.recorded_amount, old.payable_percent, old.payable_amount, old.status], [true, '11.25', null, null, 'waived']);
      assert(!fares.items.some(row => Object.hasOwn(row, 'settlement') || Object.hasOwn(row, 'amount_fen')));
    }
    assert.deepEqual(snapshot(), before);

    const audits = (await read('admin reads case audit', pa + '/audit', admin)).json.items;
    for (const entity of ['case', 'contact', 'fact', 'simple-fee', 'file', 'attachment', 'worklog']) {
      assert(audits.some(row => row.entity === entity && [admin.json.user.id, editorUser.id].includes(row.actor)), entity);
    }
    const auditB = (await read('admin reads other case audit', pb + '/audit', admin)).json.items;
    const assertAudit = (rows, entity, action, entityId, actor) => {
      assert(rows.some(row => row.entity === entity && row.action === action && row.entity_id === entityId &&
        (actor === undefined || row.actor === actor)), `${entity}/${action}/${entityId}`);
    };
    assertAudit(audits, 'event', 'create', eventA);
    assertAudit(auditB, 'event', 'create', eventB);
    assertAudit(audits, 'fee', 'create', legacyFee);
    assertAudit(audits, 'fee', 'update', legacyFee);
    assertAudit(auditB, 'fee', 'create', oldB);
    for (const task of status.templated) assertAudit(audits, 'task', 'create', task.id, editorUser.id);
    for (const task of derived.reconciled.tasks) assertAudit(auditB, 'task', 'derive-task', task.id, editorUser.id);
    for (const row of derived.reconciled.deadlines) assertAudit(auditB, 'deadline', 'derive-deadline', row.id, editorUser.id);
    const auditOrigin = db.prepare("SELECT actor_user_id, actor_kind FROM audit_log WHERE entity='deadline' AND action='derive-deadline'")
      .get();
    assert.deepEqual(auditOrigin, { actor_user_id: editorUser.id, actor_kind: 'user' });
    assert(!audits.some(row => row.entity === 'event' && row.entity_id === eventB));
    assert(!audits.some(row => row.entity === 'fee' && row.entity_id === oldB));
    assert(!audits.some(row => row.action === 'derive-deadline' || row.action === 'derive-task'));
    assert(!auditB.some(row => row.entity === 'event' && row.entity_id === eventA));
    assert(!auditB.some(row => row.entity === 'fee' && row.entity_id === legacyFee));

    const excluded = [
      legacyAudit.run('file', 'legalrag-queue', file.attachment.id).lastInsertRowid,
      legacyAudit.run('fee_file', 'link', legacyFee).lastInsertRowid,
    ];
    const recycled = addEvent.run(b.id, 'evidence_notice').lastInsertRowid;
    excluded.push(legacyAudit.run('event', 'create', recycled).lastInsertRowid);
    db.prepare('DELETE FROM events WHERE id=?').run(recycled);
    excluded.push(legacyAudit.run('event', 'delete', recycled).lastInsertRowid);
    db.prepare("INSERT INTO events(id,case_id,type,occurred_on) VALUES(?,?,'evidence_notice','2026-11-18')").run(recycled, a.id);
    const reusedAudit = legacyAudit.run('event', 'create', recycled).lastInsertRowid;
    const addedA = [reusedAudit];
    const addedB = [];
    db.transaction(() => {
      for (let index = 0; index < 102; index += 1) {
        addedA.push(legacyAudit.run('case', 'update', a.id).lastInsertRowid);
        addedB.push(legacyAudit.run('case', 'update', b.id).lastInsertRowid);
      }
    })();
    for (const [route, initial, added] of [[pa, audits, addedA], [pb, auditB, addedB]]) {
      const first = (await read('audit first page', route + '/audit', admin)).json;
      assert.equal(first.items.length, 100);
      assert.equal(first.next_before, first.items.at(-1).id);
      const second = (await read('audit second page', route + '/audit?before=' + first.next_before, admin)).json;
      assert.equal(second.next_before, null);
      const actualIds = [...first.items, ...second.items].map(row => row.id);
      assert.deepEqual(actualIds, [...initial.map(row => row.id), ...added].sort((left, right) => right - left));
      assert(!excluded.some(id => actualIds.includes(id)));
      assert.deepEqual(Object.keys(first.items[0]).sort(), ['action', 'actor', 'at', 'entity', 'entity_id', 'id']);
    }
    const emptyPage = (await read('audit exhausted cursor', pa + '/audit?before=1', admin)).json;
    assert.deepEqual(emptyPage, { items: [], next_before: null });
    await read('invalid audit cursor', pa + '/audit?before=0', admin, 400, 'id_invalid');
    await read('duplicate audit cursor', pa + '/audit?before=2&before=3', admin, 400, 'id_invalid');

    const caseEdit = db.prepare("SELECT * FROM audit_log WHERE entity='case' AND action='update' AND entity_id=?").get(a.id);
    assert.equal(caseEdit.actor, editorUser.id);
    assert.equal(caseEdit.actor_user_id, editorUser.id);
    assert.equal(caseEdit.actor_kind, 'user');
    assert.match(caseEdit.request_id, /^[a-f0-9-]{36}$/);
    const caseChanges = db.prepare("SELECT DISTINCT actor FROM change_log WHERE case_id=? AND field='status'").all(a.id);
    assert.deepEqual(caseChanges, [{ actor: editorUser.id }]);

    const beforeRollback = snapshot();
    db.exec("CREATE TRIGGER synthetic_abort_upload BEFORE INSERT ON audit_log WHEN NEW.action='upload' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    try {
      await upload('rollback.txt', editor, 500);
      assert(!fs.existsSync(path.join(path.dirname(filePath), 'rollback.txt')));
      assert.deepEqual(snapshot(), beforeRollback);
    } finally { db.exec('DROP TRIGGER synthetic_abort_upload'); }
    await upload('rollback.txt', editor, 200);

    db.exec("CREATE TRIGGER synthetic_abort_fee BEFORE INSERT ON audit_log WHEN NEW.entity='simple-fee' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    try {
      const prior = snapshot();
      await write('fee rollback on audit failure', pa + '/fees', admin, 'POST', input, 500);
      assert.deepEqual(snapshot(), prior);
    } finally { db.exec('DROP TRIGGER synthetic_abort_fee'); }

    db.exec("CREATE TRIGGER synthetic_abort_case BEFORE INSERT ON audit_log WHEN NEW.entity='case' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    try {
      const prior = snapshot();
      await write('case rollback on audit failure', '/api/cases', admin, 'POST',
        { name: 'Rollback case', folder_path: 'Synthetic-rollback' }, 500);
      assert(!fs.existsSync(path.join(filesRoot, 'Synthetic-rollback')));
      assert.deepEqual(snapshot(), prior);
    } finally { db.exec('DROP TRIGGER synthetic_abort_case'); }

    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('agent_enabled','true')").run();
    const beforeClosed = snapshot();
    for (const [method, route, body] of [
      ['GET', '/api/digest'], ['GET', '/api/agent/config'], ['POST', pa + '/agent/start', {}], ['POST', '/api/agent/global/start', {}],
      ['POST', pa + '/files/process', {}], ['GET', '/api/legalrag/status'], ['GET', '/api/settings'],
      ['GET', '/api/fees/overview'], ['POST', '/api/fees/' + fee.id + '/settlements/confirm', {}],
      ['GET', '/api/changes'], ['GET', '/api/reminders'], ['DELETE', pa], ['DELETE', '/api/attachments/' + file.attachment.id],
      ['PUT', pa + '/workspace', {}], ['DELETE', pa + '/fees/' + fee.id],
    ]) await expect('closed ' + route, route, { method, cookie: admin.cookie, body }, 403, 'phase1_business_closed');
    await expect('old internal key rejected', '/internal/agent-proposals', { method: 'POST', body: {}, cookie: admin.cookie,
      headers: { 'X-Anjian-Key': server.internalKey } }, 403, 'feature_disabled');
    await expect('origin guard still rejects off-origin write', '/api/cases', { method: 'POST', cookie: admin.cookie,
      body: { name: '拒绝目标' }, headers: { Origin: 'http://example.invalid' } }, 403, 'request_origin_invalid');
    assert.deepEqual(snapshot(), beforeClosed);
    assert.deepEqual(fs.readdirSync(path.join(server.root, 'agent-sessions')), []);

    await expect('logout revokes session', '/api/logout', { method: 'POST', cookie: viewer.cookie }, 200);
    await read('revoked viewer cannot read file', download(pa, file.rel_path), viewer, 401);
    await write('admin demotes editor', '/api/users/' + editorUser.id, admin, 'PATCH',
      { role_key: 'viewer', version: editorUser.version }, 200);
    await write('demotion revokes editor old token', pa, editor, 'PATCH',
      { status: 'active', version: status.version }, 401);
    const demoted = await login('SyntheticP2Editor', editorPassword);
    await write('demoted account cannot write', pa, demoted, 'PATCH',
      { status: 'active', version: status.version }, 403, 'case_forbidden');

    integrity(db);
    // Remove only the fixture link entries before exercising the product backup inventory.
    for (const remove of removeLinks) remove();
    atomic.atomicJson(config, { dataDir, synthetic: true });
    const backupRoot = await backup.createIdentityBackup({ dataDir, configPath: config });
    const manifest = backup.verifyIdentityBackup(backupRoot);
    assert(manifest.entries.some(row => row.path.endsWith(file.rel_path)));
    const backed = new Database(path.join(backupRoot, 'anjian.db'), { readonly: true });
    try {
      integrity(backed);
      assert.deepEqual(backed.prepare('SELECT * FROM phase2_fee_terms ORDER BY fee_id').all(),
        db.prepare('SELECT * FROM phase2_fee_terms ORDER BY fee_id').all());
      assert.equal(backed.prepare('SELECT version FROM cases WHERE id=?').get(a.id).version, status.version);
    } finally { backed.close(); }
    result.backup = 'snapshot verified, case fields and fee terms included';
    result.backend_exit_codes = [await stopNormally(server)];
    server = await start();
    const relogin = await login('SyntheticP2Admin', adminPassword);
    assert.equal((await read('case after restart', pa, relogin)).json.case.status, 'closed');
    assert.equal((await read('fee after restart', pa + '/fees', relogin)).json.totals.paid_fen, '905');
    assert.equal((await read('file after restart', download(pa, file.rel_path), relogin)).bytes.toString(), 'synthetic evidence');
    await expect('stored Agent enable remains closed on restart', pa + '/agent/start',
      { method: 'POST', cookie: relogin.cookie, body: {} }, 403, 'phase1_business_closed');
    assert.deepEqual(fs.readdirSync(path.join(server.root, 'agent-sessions')), []);
    result.backend_exit_codes.push(await stopNormally(server));
    integrity(db);
  } finally { db.close(); }
  // Windows cannot rename an open SQLite database when another handle denies deletion.
  const reopened = database + '.reopened';
  fs.renameSync(database, reopened);
  fs.renameSync(reopened, database);
  result.sqlite = 'integrity and foreign key checks passed; database rename after shutdown passed';
  console.log('PHASE2_HTTP ' + JSON.stringify(result));
} catch (failure) { error = failure; throw failure; }
finally { await resources.finish(error); }
