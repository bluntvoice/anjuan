// F1 test-only boundary. Never imported by product code and never implements legacy auth.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { startIdentityServer } from './http-fixture.js';
import passwordHash from '../../src/lib/password-hash.cjs';

export const COMPONENT_ACTOR = 'f1-isolated-component';
export function assertF1Environment() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.HOST, '127.0.0.1');
  assert(process.env.R2_RESOURCE_RESULTS && process.env.R2_NETWORK_RESULTS, 'use isolated R2 runner');
  const own = path.dirname(process.env.R2_RESOURCE_RESULTS);
  assert.equal(fs.realpathSync.native(own), path.resolve(own));
  assert.equal(path.resolve(process.env.TEMP), own);
  let cursor = own;
  while (!fs.existsSync(path.join(cursor, 'w0-fixture.json'))) {
    const parent = path.dirname(cursor);
    assert.notEqual(parent, cursor, 'synthetic run marker required');
    cursor = parent;
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(cursor, 'w0-fixture.json'))).purpose, 'anjuan-w0-synthetic-only');
  return own;
}

// Only a standalone Express app mounts this callback. No internalAuth override,
// no credential acceptance, no unsafe environment switch, no product server.
export function componentIdentity(req, _res, next) {
  assertF1Environment();
  assert.notEqual(process.env.ANJIAN_UNSAFE_NO_AUTH, '1');
  req.actor = COMPONENT_ACTOR;
  next();
}

export function assertSQLite(db) {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  const filename = db.name;
  if (filename !== ':memory:') {
    assert.equal(fs.realpathSync.native(filename), path.resolve(filename));
    assert.equal(fs.statSync(filename).nlink, 1, 'synthetic DB must not be a hard link');
  }
}

export async function verifyProductionContract(id, resources) {
  assertF1Environment();
  const obsoletePassword = crypto.randomBytes(24).toString('base64');
  const server = await startIdentityServer({ r2LegacyCredentials: {
    username: 'F1ObsoleteAccount', hash: passwordHash.hashPassword(obsoletePassword),
  } });
  // Windows may assign a fetch-forbidden ephemeral port (observed: 10080).
  // Use real native HTTP for this loopback probe; do not alter product ports.
  const request = (route, { method = 'GET', body, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(route, server.address), { method, headers: {
      ...(encoded === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }),
      ...(cookie ? { Cookie: cookie } : {}), ...headers,
    } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { /* non-JSON rejection */ }
        resolve({ status: response.statusCode, text, json, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('F1 native HTTP timeout')));
    req.end(encoded);
  });
  let stopped = false;
  const stop = async () => { if (!stopped) { await server.stop(); await assert.rejects(request('/healthz'), error => error.code === 'ECONNREFUSED'); stopped = true; } return { pid: server.child.pid, address: server.address, exitCode: server.child.exitCode, signal: server.child.signalCode, stopped, portReleased: true }; };
  resources.cleanup('F1 production backend + port', stop, 20);
  resources.directory(server.root);
  const db = resources.database(new Database(server.database));
  const rows = [];
  async function expect(label, route, options, status, code) {
    const response = await request(route, options);
    assert.equal(response.status, status, `${label}: ${route} ${response.text}`);
    if (code) assert.equal(response.json?.code, code, label);
    rows.push({ label, route, status, code: response.json?.code || null });
    return response;
  }
  const password = crypto.randomBytes(24).toString('base64');
  await expect('anonymous identity denied', '/api/auth/me', {}, 401);
  await expect('old static cookie denied', '/api/auth/me', { cookie: 'anjian_token=' + server.staticToken }, 401);
  await expect('old session cookie denied', '/api/auth/me', { cookie: 'anjian_sess=' + server.staticToken }, 401);
  await expect('old env login denied', '/api/login', { method: 'POST', body: { username: 'F1ObsoleteAccount', password: obsoletePassword } }, 401);
  await expect('synthetic bootstrap', '/api/bootstrap/initialize', { method: 'POST',
    headers: { 'X-Anjuan-Bootstrap': server.key }, body: { username: 'F1SyntheticAdmin', password } }, 201);
  const login = await expect('synthetic DB login', '/api/login', { method: 'POST', body: { username: 'F1SyntheticAdmin', password } }, 200);
  assert(login.cookie);
  const me = await expect('DB identity survives forged actor header', '/api/auth/me', {
    cookie: login.cookie, headers: { 'X-Anjian-Actor': 'isolated-test' },
  }, 200);
  assert.equal(me.json.user.id, login.json.user.id);
  assert.notEqual(me.json.user.id, 'isolated-test');
  const tables = ['cases', 'events', 'deadlines', 'tasks', 'worklog', 'contacts', 'facts', 'inbox', 'sessions', 'change_log'];
  const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = snapshot();
  const routes = id === 37 ? [['/internal/agent-proposals', 'POST', {
    session_id: 'f1-session', case_id: 999, proposal_id: 'f1-forbidden', payload: { title: 'synthetic forbidden write' },
    source_ref: { session_id: 'f1-session', call_id: 'f1' },
  }], ['/internal/agent-proposals', 'POST', { mode: 'direct', session_id: 'f1-session', kind: 'event', payload: { type: 'served', occurred_on: '2026-11-17' } }]]
    : id === 38 ? ['/internal/agent-case-view', '/internal/agent-digest', '/internal/digest', '/internal/cases'].map(route => [route, 'GET'])
      : [['/api/cases', 'POST', { name: 'synthetic forbidden case' }], ['/api/changes', 'GET']];
  for (const [route, method, body] of routes) {
    for (const [label, options] of [
      ['anonymous', {}], ['wrong key', { headers: { 'X-Anjian-Key': 'f1-wrong' } }],
      ['old internal key + spoofed actor', { headers: { 'X-Anjian-Key': server.internalKey, 'X-Anjian-Actor': 'web' } }],
      ['old session', { cookie: 'anjian_sess=' + server.staticToken }], ['valid DB admin', { cookie: login.cookie }],
    ]) {
      const internal = route.startsWith('/internal');
      await expect(label, route, { method, body, ...options }, internal || options.cookie === login.cookie ? 403 : 401,
        internal ? 'feature_disabled' : options.cookie === login.cookie ? 'phase1_business_closed' : undefined);
    }
    await expect('foreign Origin refused', route, { method, body, headers: { Origin: 'https://f1-invalid.example' } }, 403, 'request_origin_invalid');
    const host = await server.rawRequest(route, { Host: 'f1-invalid.example' });
    assert.equal(host.status, 403);
    rows.push({ label: 'foreign Host refused', route, status: host.status });
  }
  assert.deepEqual(snapshot(), before, 'denied calls must not change any business/change-log row');
  const audits = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  const userAudits = audits.filter(row => row.actor_kind === 'user');
  assert(userAudits.length >= 2);
  for (const row of userAudits) {
    assert.equal(row.actor, login.json.user.id);
    assert.equal(row.actor_user_id, login.json.user.id);
    assert.equal(row.target_user_id, login.json.user.id);
    assert(row.request_id);
  }
  assert(!audits.some(row => row.actor === 'isolated-test'), 'normal production auth must not invent isolated-test actor');
  const text = JSON.stringify(audits);
  for (const secret of [password, obsoletePassword, server.internalKey, server.staticToken, login.cookie, login.cookie.split('=')[1]]) {
    assert(!text.includes(secret), 'audit must redact full credentials');
  }
  await expect('logout', '/api/logout', { method: 'POST', cookie: login.cookie }, 200);
  await expect('revoked session', '/api/auth/me', { cookie: login.cookie }, 401);
  assertSQLite(db);
  console.log('F1_PRODUCTION ' + JSON.stringify({ id: `R2-${id}`, status: 'passed', rows,
    noBusinessWrites: true, auditCredentialRedaction: true, productionActor: 'DB user id', sqlite: 'ok',
    legacyCredentialScope: 'not implemented; closed feature does not prove historical scope logic' }));
  await stop();
}
