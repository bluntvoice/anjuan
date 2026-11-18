import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { TestResources, bounded } from './test-resources.js';

const resources = new TestResources(import.meta.url);
let primaryError;
try {
  const own = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'r2-resource-contract-')));
  const db = resources.database(new Database(path.join(own, 'test.db')));
  db.exec('CREATE TABLE fixture(id INTEGER PRIMARY KEY)');
  const fd = resources.file(fs.openSync(path.join(own, 'child.log'), 'wx'));
  const child = resources.child(spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', fd, fd] }));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const server = resources.server(http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ready\n\n'); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const response = await fetch(address, { signal: controller.signal });
  const reader = resources.stream(response.body.getReader(), controller);
  assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
  await resources.finish();
  assert.equal(db.open, false);
  assert.equal(server.listening, false);
  assert.equal(fs.existsSync(own), false);
  assert.throws(() => fs.fstatSync(fd), /EBADF/);
  assert(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(fetch(address, { signal: AbortSignal.timeout(1000) }));

  // Injected failures verify reporting behavior, not a weakened resource assertion.
  // Keep these ledgers separate so expected failures cannot contaminate the real run result.
  const originalLedger = process.env.R2_RESOURCE_RESULTS;
  const ledger = path.join(os.tmpdir(), 'expected-cleanup-failures.jsonl');
  process.env.R2_RESOURCE_RESULTS = ledger;
  try {
    const main = new Error('injected primary failure');
    const failed = new TestResources(import.meta.url);
    let nextCleanupRan = false;
    failed.cleanup('injected close failure', () => { throw new Error('injected cleanup failure'); });
    failed.cleanup('subsequent independent cleanup', () => { nextCleanupRan = true; });
    await failed.finish(main); // original main remains the caller's primary error
    assert(nextCleanupRan);
    assert.equal(main.message, 'injected primary failure');
    const record = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1));
    assert.equal(record.main.status, 'failed'); assert.equal(record.cleanup.status, 'failed');
    const cleanupOnly = new TestResources(import.meta.url);
    cleanupOnly.cleanup('injected cleanup-only failure', () => { throw new Error('cleanup-only'); });
    await assert.rejects(cleanupOnly.finish(), AggregateError);
    await assert.rejects(bounded(new Promise(() => {}), 'injected blocked close', 20), /timeout/);
  } finally {
    if (originalLedger === undefined) delete process.env.R2_RESOURCE_RESULTS;
    else process.env.R2_RESOURCE_RESULTS = originalLedger;
  }
  console.log(JSON.stringify({ test: 'W00 resources', realHttpAndSse: true, sqliteClosed: true, ownedChildClosed: true,
    logClosed: true, fixtureRemoved: true, portReleased: true, primaryAndCleanupSeparated: true, cleanupContinuesAfterError: true,
    cleanupOnlyFailureRejects: true, boundedTimeout: true, expectedFailureLedger: ledger }));
} catch (error) { primaryError = error; console.error(error); process.exitCode = 1; }
finally { if (primaryError) await resources.finish(primaryError); }
