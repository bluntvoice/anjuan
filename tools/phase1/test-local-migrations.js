import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runLocalMigrations } from '../../src/lib/local-migrations.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjuan-local-migration-'));
const repo = path.resolve(import.meta.dirname, '../..');
function upstream() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const name of fs.readdirSync(path.join(repo, 'src/migrations')).filter(n => n.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(repo, 'src/migrations', name), 'utf8'));
  db.pragma('user_version = 32');
  return db;
}
const db = upstream();
const failureDb = upstream();
try {
  db.prepare("INSERT INTO audit_log (actor,action,entity,detail) VALUES ('old-actor','historic','case','preserve')").run();
  db.prepare("INSERT INTO sessions (token,expires_at) VALUES ('synthetic-legacy',datetime('now','+1 day'))").run();
  assert.deepEqual(runLocalMigrations(db, { legacyDatabase: true }), ['001_identity.sql']);
  assert.deepEqual(runLocalMigrations(db), []);
  assert.equal(db.pragma('user_version', { simple: true }), 32);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  const historical = db.prepare("SELECT * FROM audit_log WHERE action='historic'").get();
  assert.equal(historical.actor, 'old-actor'); assert.equal(historical.actor_user_id, null);
  assert.equal(db.prepare('SELECT legacy_required FROM identity_state').get().legacy_required, 1);
  const insert = db.prepare('INSERT INTO users (id, username, username_normalized, display_name, password_hash, role_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('stable-admin', 'Admin', 'admin', 'Admin', 'synthetic', 'admin', 'now', 'now');
  assert.throws(() => insert.run('other', 'ADMIN', 'admin', 'Other', 'synthetic', 'viewer', 'now', 'now'), /UNIQUE/);
  assert.throws(() => insert.run('bad-role', 'bad', 'bad', 'Bad', 'synthetic', 'owner', 'now', 'now'), /CHECK/);
  assert.throws(() => db.prepare("UPDATE users SET id='different' WHERE id='stable-admin'").run(), /user_id_immutable/);
  assert.throws(() => db.prepare("UPDATE users SET active=0 WHERE id='stable-admin'").run(), /last_active_admin/);
  assert.throws(() => db.prepare("UPDATE users SET role_key='viewer' WHERE id='stable-admin'").run(), /last_active_admin/);
  assert.throws(() => db.prepare("DELETE FROM users WHERE id='stable-admin'").run(), /user_hard_delete_disabled/);
  assert.throws(() => db.prepare('INSERT INTO user_sessions VALUES (?, ?, ?, ?, ?, ?)').run('a'.repeat(64), 'missing', 1, 1, 100, 1), /FOREIGN KEY/);
  fs.copyFileSync(path.join(repo, 'src/local-migrations/001_identity.sql'), path.join(scratch, '001_identity.sql'));
  fs.appendFileSync(path.join(scratch, '001_identity.sql'), '\n-- changed\n');
  assert.throws(() => runLocalMigrations(db, { directory: scratch }), /checksum mismatch/);
  fs.writeFileSync(path.join(scratch, '001_identity.sql'), 'CREATE TABLE half_identity(id TEXT); INSERT INTO missing_table VALUES (1);');
  assert.throws(() => runLocalMigrations(failureDb, { directory: scratch }), /missing_table/);
  assert.equal(failureDb.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='half_identity'").get().n, 0);
  assert.equal(failureDb.prepare('SELECT count(*) AS n FROM local_schema_migrations').get().n, 0);
  db.prepare("UPDATE local_schema_migrations SET id='999_unknown.sql'").run();
  assert.throws(() => runLocalMigrations(db), /Unknown applied/);
  failureDb.pragma('user_version = 33');
  assert.throws(() => runLocalMigrations(failureDb), /Unsupported upstream/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log('local migrations: constraints, stable identity, legacy sessions, history, idempotence, checksum and atomic rollback passed');
} finally {
  db.close(); failureDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
