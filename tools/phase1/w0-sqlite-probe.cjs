'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function resolveRunRoot(argv = process.argv) {
  const index = argv.indexOf('--run-root');
  assert(index >= 0 && argv[index + 1], 'Explicit --run-root is required');
  const root = path.resolve(argv[index + 1]);
  assert.equal(root, fs.realpathSync.native(root), 'Run root must be a real directory');
  assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'w0-fixture.json'), 'utf8')).purpose, 'anjuan-w0-synthetic-only');
  return root;
}

function runSQLiteProbe(runRoot, runtime) {
  const Database = require('better-sqlite3');
  const own = fs.mkdtempSync(path.join(runRoot, `sqlite-${runtime}-`));
  const databases = [];
  try {
    for (const name of [':memory:', path.join(own, 'probe.db')]) {
      const db = new Database(name);
      databases.push(db);
      db.pragma('foreign_keys = ON');
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
      if (name !== ':memory:') assert.equal(db.pragma('journal_mode = WAL', { simple: true }), 'wal');
      db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))');
      db.prepare('INSERT INTO parent (id) VALUES (?)').run(1);
      db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run(1, 1);
      assert.throws(() => db.prepare('INSERT INTO child VALUES (?, ?)').run(2, 99), /FOREIGN KEY/);
      assert.throws(db.transaction(() => {
        db.prepare('INSERT INTO parent VALUES (?)').run(2);
        throw new Error('injected-rollback');
      }), /injected-rollback/);
      assert.equal(db.prepare('SELECT count(*) AS n FROM parent').get().n, 1);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    }
    return {
      runtime, versions: { node: process.versions.node, electron: process.versions.electron || null, modules: process.versions.modules, napi: process.versions.napi },
      arch: process.arch, platform: process.platform,
      sqlite: databases[0].prepare('SELECT sqlite_version() AS version').get().version,
      moduleVersion: require('better-sqlite3/package.json').version,
      nativeModules: Object.keys(require.cache).filter(name => name.endsWith('.node')),
      memoryAndDisk: true, transactions: true, foreignKeys: true, wal: true, integrity: true, fixture: own,
    };
  } finally {
    for (const db of databases) if (db.open) db.close();
  }
}
module.exports = { resolveRunRoot, runSQLiteProbe };
