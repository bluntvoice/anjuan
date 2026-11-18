import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import dataPaths from '../../src/lib/windows-data-paths.cjs';
import { TestResources, bounded } from './test-resources.js';
import { assertF1Environment } from './r2-f1-contract.js';
import { startIdentityServer } from './http-fixture.js';
import { f2Request } from './r2-f2-contract.js';
const resources = new TestResources(import.meta.url); let primaryError;
try {
  assertF1Environment(); const root = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'w05-exit-')));
  let dataDir = root; while (dataDir.length < 207) { const size = Math.min(35, 206 - dataDir.length); assert(size > 0); dataDir = path.join(dataDir, ('中文 #&-' + 'x'.repeat(40)).slice(0, size)); }
  dataPaths.assertDataPaths({ dataDir }); fs.mkdirSync(dataDir, { recursive: true });
  const backend = await startIdentityServer({ database: path.join(dataDir, 'anjian.db') }); let stopped = false;
  const stop = async () => { if (!stopped) { await backend.stop(); await assert.rejects(f2Request(backend.address, '/healthz'), e => e.code === 'ECONNREFUSED'); stopped = true; } return { pid: backend.child.pid, address: backend.address, exitCode: backend.child.exitCode, signal: backend.child.signalCode, portReleased: true }; };
  resources.cleanup('W05 IPC backend exit + port', stop, 20); resources.directory(backend.root);
  const result = await f2Request(backend.address, '/api/bootstrap/initialize', { method: 'POST', headers: { 'X-Anjuan-Bootstrap': backend.key }, body: { username: 'NormalExitSynthetic', password: crypto.randomBytes(24).toString('base64') } }); assert.equal(result.status, 201);
  const exit = once(backend.child, 'exit'); backend.child.send({ type: 'anjuan:shutdown' });
  const [code, signal] = await bounded(exit, 'normal IPC exit', 10000); assert.equal(code, 0); assert.equal(signal, null);
  await stop(); assert(fs.readFileSync(path.join(backend.root, 'server-output.log'), 'utf8').includes('received IPC'));
  const db = resources.database(new Database(path.join(dataDir, 'anjian.db')));
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.prepare('SELECT username FROM users').get().username, 'NormalExitSynthetic');
  console.log('W05_SHUTDOWN ' + JSON.stringify({ status: 'passed', node: process.versions.node, electron: process.versions.electron || null, rootLength: 207, backendExitCode: code, signal, actualIPC: true, sqlite: 'ok' }));
} catch (error) { primaryError = error; console.error(error); process.exitCode = 1; }
finally { await resources.finish(primaryError); }
