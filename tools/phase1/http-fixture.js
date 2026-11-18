import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export async function startIdentityServer({ legacy = null, database = null, r2LegacyCredentials = null, r2InternalKeySource = null } = {}) {
  assert(r2InternalKeySource === null || r2InternalKeySource === 'electron-auto', 'explicit test source must be null or electron-auto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjuan-identity-http-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ANJIAN_|LEGALRAG_|DEEPSEEK_|NODE_OPTIONS$|DB_PATH$|HOST$|PORT$)/.test(key)) delete env[key];
  const staticToken = crypto.randomBytes(32).toString('hex');
  const internalKey = crypto.randomBytes(32).toString('hex');
  Object.assign(env, { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', DB_PATH: database || path.join(root, 'anjian.db'),
    ANJIAN_FILES_ROOT: path.join(root, 'files'), ANJIAN_AGENT_SESSION_ROOT: path.join(root, 'agent-sessions'),
    ANJIAN_STATIC_TOKEN: staticToken, ANJIAN_INTERNAL_KEY: internalKey });
  if (process.env.R2_NETWORK_RESULTS) env.NODE_OPTIONS = `--import=${pathToFileURL(path.resolve(import.meta.dirname, 'r2-loopback-only.js')).href}`;
  if (r2LegacyCredentials) Object.assign(env, { ANJIAN_USER: r2LegacyCredentials.username, ANJIAN_PASS_HASH: r2LegacyCredentials.hash });
  if (r2InternalKeySource !== null) env.ANJIAN_INTERNAL_KEY_SOURCE = r2InternalKeySource;
  fs.mkdirSync(env.ANJIAN_FILES_ROOT); fs.mkdirSync(env.ANJIAN_AGENT_SESSION_ROOT);
  const child = fork(path.resolve(import.meta.dirname, '../../server.js'), [], { env, execArgv: [],
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  let timer;
  try {
    const address = await Promise.race([
      new Promise((resolve, reject) => {
        child.on('error', reject);
        child.stdout.on('data', () => { const match = stdout.match(/anjian listening on :(\d+)/); if (match) resolve(`http://127.0.0.1:${match[1]}`); });
        child.once('exit', () => reject(new Error('Identity backend exited before readiness: ' + stderr.slice(-1500))));
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Identity server startup timeout')), 20000); }),
    ]);
    clearTimeout(timer);
    const key = crypto.randomBytes(32).toString('hex');
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bootstrap IPC timeout')), 5000);
      child.on('message', message => { if (message?.type === 'anjuan:bootstrap-ready') { clearTimeout(timeout); message.ok ? resolve() : reject(new Error('Bootstrap IPC refused')); } });
    });
    child.send({ type: 'anjuan:bootstrap-capability', key, legacy });
    await ready;
    const request = async (route, { method = 'GET', body, cookie, headers = {} } = {}) => {
      const response = await fetch(address + route, { method, headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const text = await response.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json, text, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
    };
    const rawRequest = (route, headers) => new Promise((resolve, reject) => {
      const req = http.get(address + route, { headers }, response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode })); });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Raw HTTP timeout')));
    });
    return { root, database: env.DB_PATH, address, child, key, staticToken, internalKey, request, rawRequest,
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        await assert.rejects(fetch(address + '/healthz', { signal: AbortSignal.timeout(1500) }));
        fs.writeFileSync(path.join(root, 'server-output.log'), stdout + '\n' + stderr);
      } };
  } catch (error) { clearTimeout(timer); child.kill(); await exited; throw error; }
}
