import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { once } from 'node:events';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runLocalMigrations } from '../../src/lib/local-migrations.js';
import { createIdentityService } from '../../src/lib/identity-service.js';
import { TestResources } from '../phase1/test-resources.js';

const resources = new TestResources(import.meta.url);
let failure;
try {
  const root = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'p2-service-')));
  const filename = path.join(root, 'service.db');
  const oldMigrations = path.join(root, 'phase1');
  fs.mkdirSync(oldMigrations);
  fs.copyFileSync(new URL('../../src/local-migrations/001_identity.sql', import.meta.url), path.join(oldMigrations, '001_identity.sql'));
  const old = resources.database(new Database(filename));
  old.pragma('foreign_keys=ON');
  const upstream = new URL('../../src/migrations/', import.meta.url);
  for (const name of fs.readdirSync(upstream).filter(name => name.endsWith('.sql')).sort()) {
    old.exec(fs.readFileSync(new URL(name, upstream), 'utf8'));
  }
  old.pragma('user_version=32');
  assert.deepEqual(runLocalMigrations(old, { directory: oldMigrations }), ['001_identity.sql']);
  const account = createIdentityService(old);
  const password = crypto.randomBytes(25).toString('base64');
  const admin = account.bootstrap({ username: 'SvcSyntheticAdmin', display_name: '合成管理', password });
  const viewer = account.createUser(admin.id, { username: 'SvcSyntheticViewer', display_name: '合成查阅', role_key: 'viewer', password });
  const editor = account.createUser(admin.id, { username: 'SvcSyntheticEditor', display_name: '合成编辑', role_key: 'editor', password });

  const caseId = old.prepare("INSERT INTO cases(name,folder_path,note) VALUES('合成既有案件','Existing','合成原备注')").run().lastInsertRowid;
  old.prepare("INSERT INTO contacts(case_id,name,role) VALUES(?,'合成既有联系人','其他')").run(caseId);
  old.prepare("INSERT INTO facts(case_id,content,created_by) VALUES(?,'合成既有事实','import')").run(caseId);
  const feeId = old.prepare("INSERT INTO fee_items(case_id,label,amount,amount_fen,status) VALUES(?,'合成旧款',100,10000,'paid')").run(caseId).lastInsertRowid;
  const agreementId = old.prepare(`INSERT INTO fee_share_agreements(case_id,direction,counterpart,rate)
    VALUES(?,'payable','合成分账对象',10)`).run(caseId).lastInsertRowid;
  old.prepare(`INSERT INTO fee_shares(case_id,agreement_id,fee_item_id,direction,counterpart,base_amount,amount,due_month)
    VALUES(?,?,?,'payable','合成分账对象',100,10,'2026-11')`).run(caseId, agreementId, feeId);
  const previousFee = old.prepare('SELECT * FROM fee_items WHERE id=?').get(feeId);
  const original = Object.fromEntries(['cases', 'contacts', 'facts', 'change_log', 'users', 'audit_log', 'fee_shares', 'fee_share_agreements'].map(table =>
    [table, old.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  old.close();

  process.env.DB_PATH = filename;
  const { db } = await import('../../src/db.js');
  resources.database(db);
  const { identity } = await import('../../src/lib/identity.js');
  const { installCaseWriteGuards, withCaseWrite } = await import('../../src/lib/phase2-access.js');
  const { upsertContactRecord } = await import('../../src/routes/contacts.js');
  const { createFactRecord } = await import('../../src/routes/legalrag.js');
  const { saveCaseFee } = await import('../../src/lib/phase2-fees.js');
  assert.deepEqual(db.prepare('SELECT id FROM local_schema_migrations ORDER BY id').pluck().all(), ['001_identity.sql', '002_case_business.sql']);
  assert.deepEqual(runLocalMigrations(db), []);
  for (const [table, prior] of Object.entries(original)) {
    const current = db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();
    if (['cases', 'contacts', 'facts'].includes(table)) {
      for (const row of current) { assert.equal(row.version, 1); delete row.version; }
    }
    assert.deepEqual(current, prior);
  }
  assert.deepEqual(db.prepare('SELECT * FROM fee_items WHERE id=?').get(feeId), previousFee);
  assert.equal(db.prepare('SELECT COUNT(*) FROM phase2_fee_terms').pluck().get(), 0);

  assert.throws(() => saveCaseFee(caseId, null, {}, admin.id), { code: 'case_forbidden' });
  assert.throws(() => createFactRecord({ caseId, payload: {}, actor: admin.id, phase2: true }), { code: 'case_forbidden' });
  installCaseWriteGuards();
  const reader = identity.login(viewer.username, password);
  const writer = identity.login(editor.username, password);
  assert.throws(() => withCaseWrite(reader.token, () => assert.fail('viewer callback ran')), { code: 'case_forbidden' });
  assert.throws(() => withCaseWrite(undefined, () => assert.fail('anonymous callback ran')), { code: 'unauthorized' });
  for (const mutate of [
    () => upsertContactRecord({ caseId, payload: { name: '合成未授权', role: '其他' }, actor: admin.id }),
    () => createFactRecord({ caseId, payload: { content: '合成未授权' }, actor: admin.id }),
    () => saveCaseFee(caseId, null, { agreed_amount: '1.00', payable_percent: '100', status: 'unpaid' }, admin.id),
  ]) assert.throws(mutate, { code: 'case_forbidden' });
  assert.throws(() => db.prepare('UPDATE cases SET note=? WHERE id=?').run('合成未授权', caseId), /case_write_forbidden/);
  assert.throws(() => withCaseWrite(writer.token, () => db.prepare('DELETE FROM cases WHERE id=?').run(caseId)), /case_write_forbidden/);
  assert.throws(() => withCaseWrite(writer.token, () =>
    upsertContactRecord({ caseId, payload: { name: '合成冒名', role: '其他' }, actor: admin.id })), { code: 'case_forbidden' });
  const committed = withCaseWrite(writer.token, actor => upsertContactRecord({
    caseId, payload: { id: 1, version: 1, note: '合成授权修订' }, actor, phase2: true,
  }));
  assert.equal(committed.row.version, 2);
  assert.equal(db.prepare("SELECT actor_user_id FROM audit_log WHERE entity='contact' ORDER BY id DESC LIMIT 1").pluck().get(), editor.id);

  const fees = { agreed_amount: '90071992547409.91', payable_percent: '0.01', status: 'unpaid' };
  const entry = withCaseWrite(writer.token, actor => saveCaseFee(caseId, null, fees, actor));
  assert.equal(entry.payable_amount, '9007199254.74');
  const full = withCaseWrite(writer.token, actor => saveCaseFee(caseId, null, { ...fees, payable_percent: '100' }, actor));
  assert.equal(full.payable_amount, '90071992547409.91');
  assert.throws(() => withCaseWrite(writer.token, actor => {
    saveCaseFee(caseId, null, { ...fees, payable_percent: '100' }, actor);
    return Promise.resolve();
  }), /synchronous/);
  assert.equal(db.prepare('SELECT count(*) FROM phase2_fee_terms').pluck().get(), 2, 'async write must roll back');
  // Swap two ordinary owned fixture files at the attachment insert boundary.
  // The filesystem operation is outside SQLite's rollback, unlike the new reference.
  const filesRoot = path.join(root, 'case-files');
  const folder = path.join(filesRoot, 'Existing');
  fs.mkdirSync(folder, { recursive: true });
  process.env.ANJIAN_FILES_ROOT = filesRoot;
  const { apiAuth, requestBoundary } = await import('../../src/middleware/auth.js');
  const { createFilesRouter } = await import('../../src/routes/files.js');
  const app = express();
  app.use(express.json({ inflate: false }));
  app.use('/api', requestBoundary, apiAuth, createFilesRouter({ phase2: true }));
  const server = resources.server(app.listen(0, '127.0.0.1'));
  await once(server, 'listening');
  const attach = () => fetch(`http://127.0.0.1:${server.address().port}/api/cases/${caseId}/attachments`, {
    method: 'POST',
    headers: { Cookie: 'anjian_sess=' + writer.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rel_path: 'material.txt' }), signal: AbortSignal.timeout(8000),
  });
  const target = path.join(folder, 'material.txt');
  const replacement = path.join(folder, 'replacement.txt');
  const retained = path.join(folder, 'prior.txt');
  fs.writeFileSync(target, 'same length A', { flag: 'wx' });
  fs.writeFileSync(replacement, 'same length B', { flag: 'wx' });
  db.function('fixture_replace_file', () => {
    fs.renameSync(target, retained);
    fs.renameSync(replacement, target);
    return 1;
  });
  db.exec(`CREATE TEMP TRIGGER fixture_replace_file BEFORE INSERT ON main.attachments
    BEGIN SELECT fixture_replace_file(); END`);
  try {
    const changed = await attach();
    await changed.text();
    assert.equal(fs.readFileSync(retained, 'utf8'), 'same length A');
    assert.equal(fs.readFileSync(target, 'utf8'), 'same length B');
    assert.equal(changed.status, 409, 'file identity changed during attachment insert');
    assert.equal(db.prepare('SELECT count(*) FROM attachments').pluck().get(), 0);
    assert.equal(db.prepare("SELECT count(*) FROM audit_log WHERE entity='attachment'").pluck().get(), 0);
  } finally {
    db.exec('DROP TRIGGER fixture_replace_file');
  }
  const retry = await attach();
  assert.equal(retry.status, 201);
  assert.equal((await retry.json()).rel_path, 'material.txt');
  assert.equal(db.prepare('SELECT count(*) FROM attachments').pluck().get(), 1);

  identity.logout(writer.token);
  assert.throws(() => withCaseWrite(writer.token, () => assert.fail('revoked callback ran')), { code: 'unauthorized' });
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log('PHASE2_SERVICE ' + JSON.stringify({ migration: '001→002 with historical rows preserved', storeGuards: true,
    actorValidation: true, readerDenied: true, asynchronousRollback: true, revokedDenied: true, exactMoney: true, attachmentReplacementRolledBack: true, integrity: true }));
} catch (error) { failure = error; throw error; }
finally { await resources.finish(failure); }
