'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveRunRoot, runSQLiteProbe } = require('./w0-sqlite-probe.cjs');

(async () => {
  assert.equal(process.versions.electron, undefined, 'Use the ordinary Node runtime for this probe');
  const root = resolveRunRoot();
  const result = runSQLiteProbe(root, 'node');
  const migrationRoot = fs.mkdtempSync(path.join(root, 'upstream-migrations-'));
  process.env.DB_PATH = path.join(migrationRoot, 'anjian.db');
  const { db, runMigrations } = await import(pathToFileURL(path.resolve(__dirname, '../../src/db.js')).href);
  try {
    assert.equal(db.name, process.env.DB_PATH);
    assert.equal(db.pragma('user_version', { simple: true }), 32);
    runMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), 32);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    result.upstreamMigrations = { version: 32, repeated: true, integrity: true, fixture: migrationRoot };
  } finally { db.close(); }
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
