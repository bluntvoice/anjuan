import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import backup from '../../electron/identity-backup.cjs';
import { runLocalMigrations } from '../../src/lib/local-migrations.js';
import { createIdentityService } from '../../src/lib/identity-service.js';
import passwordHash from '../../src/lib/password-hash.cjs';
import { assertPrivateWindowsAcl } from './windows-acl-test-utils.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjuan-backup-'));
const dataDir = path.join(root, 'old-data'); fs.mkdirSync(dataDir);
const configPath = path.join(root, 'config.json');
const password = '旧密码';
const passHash = passwordHash.hashPassword(password);
fs.writeFileSync(configPath, JSON.stringify({ dataDir, user: 'LegacyAdmin', passHash }));
fs.writeFileSync(path.join(dataDir, 'secret.key'), crypto.randomBytes(32));
fs.mkdirSync(path.join(dataDir, '案件夹', '虚构案件'), { recursive: true });
fs.writeFileSync(path.join(dataDir, '案件夹', '虚构案件', '测试材料.txt'), 'synthetic attachment');
const db = new Database(path.join(dataDir, 'anjian.db'));
const migrations = path.resolve(import.meta.dirname, '../../src/migrations');
for (const name of fs.readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
db.pragma('user_version = 32'); db.pragma('journal_mode = WAL');
db.prepare("INSERT INTO cases(name) VALUES ('虚构案件')").run();
db.prepare("INSERT INTO audit_log(actor,action,entity,detail) VALUES ('historic-unknown','legacy','case','preserve')").run();
try {
  const target = await backup.createIdentityBackup({ dataDir, configPath });
  const manifest = backup.verifyIdentityBackup(target);
  assert(manifest.entries.some(e => e.path === 'secret.key'));
  assert(manifest.entries.some(e => e.path === 'config.json'));
  assert(manifest.entries.some(e => e.path.endsWith('测试材料.txt')));
  if (process.platform === 'win32') {
    assertPrivateWindowsAcl(path.join(target, 'secret.key'));
    assertPrivateWindowsAcl(path.join(target, 'config.json'));
  }
  runLocalMigrations(db, { legacyDatabase: true });
  const identity = createIdentityService(db);
  identity.bootstrap({ old_password: password, confirm_legacy: true }, { legacy: { user: 'LegacyAdmin', passHash } });
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  const restored = fs.mkdtempSync(path.join(root, 'restored-old-'));
  // Restore only to this newly created synthetic directory, never over the source.
  for (const entry of manifest.entries) {
    const destination = path.join(restored, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(target, entry.path), destination, fs.constants.COPYFILE_EXCL);
  }
  const restoredDb = new Database(path.join(restored, 'anjian.db'), { readonly: true });
  assert.equal(restoredDb.prepare('SELECT name FROM cases').get().name, '虚构案件');
  assert.equal(restoredDb.prepare("SELECT actor FROM audit_log WHERE action='legacy'").get().actor, 'historic-unknown');
  assert.equal(restoredDb.prepare("SELECT 1 FROM sqlite_master WHERE name='users'").get(), undefined, 'Old program receives the full pre-migration schema');
  assert.equal(restoredDb.pragma('integrity_check', { simple: true }), 'ok'); restoredDb.close();
  assert(fs.readFileSync(path.join(restored, 'secret.key')).equals(fs.readFileSync(path.join(dataDir, 'secret.key'))));
  assert(fs.readFileSync(path.join(restored, 'config.json')).equals(fs.readFileSync(configPath)));
  assert.equal(fs.readFileSync(path.join(restored, '案件夹', '虚构案件', '测试材料.txt'), 'utf8'), 'synthetic attachment');
  fs.appendFileSync(path.join(target, 'secret.key'), 'tampered');
  assert.throws(() => backup.verifyIdentityBackup(target), /校验失败/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1, 'Restore rehearsal must not overwrite the migrated source');
  console.log('identity backup: coherent DB/files/config/key snapshot, old-schema restore, history and tamper rejection passed');
} finally { db.close(); }
