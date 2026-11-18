import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import backup from '../../electron/identity-backup.cjs';
import atomic from '../../electron/atomic-json.cjs';
import dataPaths from '../../src/lib/windows-data-paths.cjs';
import { TestResources } from './test-resources.js';
import { assertF1Environment } from './r2-f1-contract.js';
const resources = new TestResources(import.meta.url); let primaryError;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  assertF1Environment();
  const root = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'w05-wal-'))), dataDir = path.join(root, 'data'), config = path.join(root, 'config.json');
  dataPaths.assertDataPaths({ dataDir, userData: root }); fs.mkdirSync(dataDir);
  atomic.atomicJson(config, { dataDir, synthetic: true }); process.env.DB_PATH = path.join(dataDir, 'anjian.db');
  const { db } = await import('../../src/db.js'); resources.database(db);
  db.pragma('wal_autocheckpoint=0'); db.pragma('wal_checkpoint(TRUNCATE)');
  const primary = hash(db.name);
  db.prepare("INSERT INTO cases(name,stage) VALUES ('W05 WAL-only sentinel','审理中')").run();
  assert.equal(hash(db.name), primary, 'committed sentinel must remain outside the primary file, in WAL');
  assert(fs.statSync(db.name + '-wal').size > 32); assert(fs.existsSync(db.name + '-shm'));
  const wal = hash(db.name + '-wal');
  const first = await backup.createIdentityBackup({ dataDir, configPath: config }); const manifest = backup.verifyIdentityBackup(first);
  const snapshot = resources.database(new Database(path.join(first, 'anjian.db'), { readonly: true }));
  assert.equal(snapshot.prepare('SELECT name FROM cases').get().name, 'W05 WAL-only sentinel');
  assert.equal(snapshot.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(snapshot.pragma('foreign_key_check'), []);
  assert.equal(hash(db.name), primary); assert.equal(hash(db.name + '-wal'), wal);
  const completeHash = hash(path.join(first, 'manifest.json')), parent = path.dirname(first), prior = new Set(fs.readdirSync(parent)), rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (path.basename(to) === 'manifest.json') throw new Error('W05 manifest publication failure'); return rename(from, to); };
    await assert.rejects(backup.createIdentityBackup({ dataDir, configPath: config }), /W05 manifest publication failure/);
  } finally { fs.renameSync = rename; }
  const partials = fs.readdirSync(parent).filter(n => !prior.has(n)); assert.equal(partials.length, 1);
  const partial = path.join(parent, partials[0]); assert.equal(JSON.parse(fs.readFileSync(path.join(partial, 'manifest.json'))).complete, false);
  assert.throws(() => backup.verifyIdentityBackup(partial), /不完整/);
  assert.equal(hash(path.join(first, 'manifest.json')), completeHash); assert.equal(hash(db.name), primary); assert.equal(hash(db.name + '-wal'), wal);
  const retry = await backup.createIdentityBackup({ dataDir, configPath: config }); assert(backup.verifyIdentityBackup(retry).complete);
  console.log('W05_WAL ' + JSON.stringify({ status: 'passed', runtime: { node: process.versions.node, electron: process.versions.electron || null },
    committedUncheckpointedWalIncluded: true, sourceDatabaseAndWalUnchanged: true, integrity: 'ok', foreignKeys: true,
    failedManifestNotPublished: true, oldCompletedBackupUnchanged: true, retryComplete: true, entries: manifest.entries.length }));
} catch (error) { primaryError = error; console.error(error); process.exitCode = 1; }
finally { await resources.finish(primaryError); }
