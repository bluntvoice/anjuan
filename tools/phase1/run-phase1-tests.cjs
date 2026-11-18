'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveRunRoot } = require('./w0-sqlite-probe.cjs');

// This runner only creates new synthetic fixtures. It never cleans an existing
// run root, launches a GUI, requests elevation, or installs dependencies.
const runRoot = resolveRunRoot();
const suiteRoot = fs.mkdtempSync(path.join(runRoot, 'phase1-suite-'));
const repository = path.resolve(__dirname, '../..');
const tests = [
  'tools/test-password-hash.js',
  'tools/test-startup-config.js',
  'tools/test-window-policy.js',
  'tools/test-electron-backend-env.js',
  'tools/test-trust-proxy.js',
  'tools/test-cn-datetime.js',
  'tools/test-reminder-plan.js',
  'tools/test-migration-032.js',
  'tools/test-auth-security.js',
  'tools/phase1/test-local-migrations.js',
  'tools/phase1/test-identity-service.js',
  'tools/phase1/test-identity-http.js',
  'tools/phase1/test-auth-revocation-streams.js',
  'tools/phase1/test-identity-backup.js',
  'tools/phase1/test-private-key-acl.js',
  'tools/test-secret-box.js',
];
const record = { startedAt: new Date().toISOString(), suiteRoot, node: process.version, results: [] };
for (const script of tests) {
  const label = path.basename(script).replace(/\.[^.]+$/, '');
  const own = fs.mkdtempSync(path.join(suiteRoot, label + '-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ANJIAN_|ANJUAN_|LEGALRAG_|DEEPSEEK_|DB_PATH$|HOST$|PORT$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0',
    TEMP: own, TMP: own, TMPDIR: own,
    DB_PATH: path.join(own, 'baseline.db'),
    ANJIAN_FILES_ROOT: path.join(own, 'files'),
    ANJIAN_AGENT_SESSION_ROOT: path.join(own, 'agent-sessions'),
  });
  fs.mkdirSync(env.ANJIAN_FILES_ROOT); fs.mkdirSync(env.ANJIAN_AGENT_SESSION_ROOT);
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [path.join(repository, script)], {
    cwd: repository, env, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  const log = path.join(own, 'output.log');
  fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''));
  const entry = { script, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status,
    signal: result.signal, error: result.error?.code || null, log };
  record.results.push(entry);
  fs.writeFileSync(path.join(suiteRoot, 'results.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ script, exitCode: entry.exitCode, error: entry.error }));
}
record.finishedAt = new Date().toISOString();
record.passed = record.results.every(result => result.exitCode === 0 && !result.error);
fs.writeFileSync(path.join(suiteRoot, 'results.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ suiteRoot, passed: record.passed, count: record.results.length }));
process.exitCode = record.passed ? 0 : 1;
