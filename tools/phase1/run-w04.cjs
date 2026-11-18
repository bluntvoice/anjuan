'use strict';
// Explicit W04-only selection. No full-suite, elevation, install, GUI or worker entry.
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { resolveRunRoot } = require('./w0-sqlite-probe.cjs');
const root = resolveRunRoot();
const repo = path.resolve(__dirname, '../..');
const selection = process.argv.find(a => a.startsWith('--select='))?.slice(9);
const scripts = { capabilities: 'tools/phase1/test-w04-link-capabilities.js', independent: 'tools/phase1/test-w04-independent.js' };
if (!Object.hasOwn(scripts, selection)) throw new Error('explicit --select=capabilities or independent required; original link-dependent scripts require successful capability evidence');
const suite = fs.mkdtempSync(path.join(root, 'w04-' + selection + '-'));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(ANJIAN_|ANJUAN_|ANQI_|LEGALRAG_|DEEPSEEK_|DB_PATH$|HOST$|PORT$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$|R2_)/i.test(key) || /(?:TOKEN|PASSWORD|SECRET|API_KEY|PROXY)$/i.test(key)) delete env[key];
Object.assign(env, { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', TEMP: suite, TMP: suite, TMPDIR: suite,
  DB_PATH: path.join(suite, 'baseline.db'), ANJIAN_FILES_ROOT: path.join(suite, 'files'), ANJIAN_AGENT_SESSION_ROOT: path.join(suite, 'sessions'),
  R2_RESOURCE_RESULTS: path.join(suite, 'resources.jsonl'), R2_NETWORK_RESULTS: path.join(suite, 'network.jsonl'),
  R2_CLEANUP_ARCHIVE: path.join(suite, 'cleanup-archive'), NODE_OPTIONS: `--import=${pathToFileURL(path.join(__dirname, 'r2-loopback-only.js')).href}` });
fs.mkdirSync(env.ANJIAN_FILES_ROOT); fs.mkdirSync(env.ANJIAN_AGENT_SESSION_ROOT);
const fd = fs.openSync(path.join(suite, 'output.log'), 'wx');
const result = { selection, script: scripts[selection], suite, node: process.version, startedAt: new Date().toISOString() };
const child = spawn(process.execPath, [path.join(repo, scripts[selection])], { cwd: repo, env, windowsHide: true, stdio: ['ignore', fd, fd] });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', error => { result.timeoutCleanupError = String(error); child.kill(); });
    killer.on('close', code => { result.timeoutTreeKillExitCode = code; });
  } else child.kill('SIGKILL');
}, 90000);
child.on('error', error => { result.spawnError = String(error); });
child.on('close', (code, signal) => {
  clearTimeout(timer); fs.closeSync(fd);
  Object.assign(result, { finishedAt: new Date().toISOString(), actualExitCode: code, signal, timedOut });
  result.resources = fs.existsSync(env.R2_RESOURCE_RESULTS) ? fs.readFileSync(env.R2_RESOURCE_RESULTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  result.status = code === 0 && !timedOut && !result.spawnError && result.resources.length && result.resources.every(r => r.main.status === 'passed' && r.cleanup.status === 'passed') ? 'passed'
    : code === 1 && result.resources.some(r => r.main.code === 'W04_SYMLINK_CAPABILITY_BLOCKED') && result.resources.every(r => r.cleanup.status === 'passed') ? 'blocked' : 'failed';
  fs.writeFileSync(path.join(suite, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ selection, status: result.status, actualExitCode: code, suite }));
  process.exitCode = result.status === 'passed' ? 0 : 1;
});
