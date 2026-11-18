// W03 mapping only: original R2-33/63/95 deep component tests remain unchanged.
// This test never enables the legacy unsafe bypass or internal-key authentication.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { startIdentityServer } from './http-fixture.js';
import { TestResources } from './test-resources.js';
import passwordHash from '../../src/lib/password-hash.cjs';

const id = Number(process.argv[process.argv.indexOf('--case') + 1]);
assert([33, 63, 95].includes(id), 'explicit original case ID required');
const resources = new TestResources(import.meta.url);
let primaryError;
try {
  const obsoletePassword = crypto.randomBytes(24).toString('base64');
  const server = await startIdentityServer({ r2LegacyCredentials: { username: 'ObsoleteEnvAccount', hash: passwordHash.hashPassword(obsoletePassword) } });
  resources.cleanup('production backend exit + loopback port release', () => server.stop(), 20);
  const db = resources.database(new Database(server.database));
  const password = crypto.randomBytes(24).toString('base64');
  const rows = [];
  async function expect(label, route, options, status, code) {
    const response = await server.request(route, options);
    assert.equal(response.status, status, `${label}: ${route}`);
    if (code) assert.equal(response.json.code, code, label);
    rows.push({ label, route, method: options?.method || 'GET', status: response.status, code: response.json?.code || null });
    return response;
  }
  await expect('anonymous identity refused', '/api/auth/me', {}, 401);
  await expect('anonymous business refused', '/api/digest', {}, 401);
  await expect('legacy static token is not a DB identity', '/api/auth/me', { cookie: 'anjian_token=' + server.staticToken }, 401);
  await expect('legacy environment account cannot login', '/api/login', { method: 'POST', body: { username: 'ObsoleteEnvAccount', password: obsoletePassword } }, 401);
  const initialization = await expect('database administrator initialization', '/api/bootstrap/initialize', {
    method: 'POST', body: { username: 'R2SyntheticAdmin', password }, headers: { 'X-Anjuan-Bootstrap': server.key },
  }, 201);
  assert(initialization.json);
  const login = await expect('database identity login', '/api/login', { method: 'POST', body: { username: 'R2SyntheticAdmin', password } }, 200);
  assert(login.cookie);
  await expect('valid identity can use identity endpoint', '/api/auth/me', { cookie: login.cookie }, 200);
  const tables = ['cases', 'events', 'deadlines', 'tasks', 'worklog', 'contacts', 'facts', 'sessions'];
  const counts = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const before = counts();
  if (id === 33) {
    await expect('authenticated digest remains closed', '/api/digest', { cookie: login.cookie }, 403, 'phase1_business_closed');
    await expect('legacy session cannot authenticate', '/api/auth/me', { cookie: 'anjian_sess=' + server.staticToken }, 401);
  } else {
    const routes = id === 63 ? [
      ['/internal/agent-proposals', 'POST', { mode: 'direct', kind: 'task', session_id: 'synthetic-session', payload: { title: 'must not write' } }],
    ] : [
      ['/internal/agent-case-resolve', 'POST', { session_id: 'synthetic-global', parties: ['虚构'] }],
      ['/internal/agent-case-select', 'POST', { session_id: 'synthetic-global', case_id: 1 }],
      ['/internal/agent-case-view?session_id=synthetic-global', 'GET'],
      ['/internal/agent-digest?session_id=synthetic-global', 'GET'],
    ];
    for (const [route, method, body] of routes) {
      await expect('no internal key grants access', route, { method, body }, 403, 'feature_disabled');
      await expect('old internal key cannot bypass closed gate', route, { method, body,
        headers: { 'X-Anjian-Key': server.internalKey, 'X-Anjian-Actor': 'dsh-agent' } }, 403, 'feature_disabled');
      await expect('administrator cannot open internal feature', route, { method, body, cookie: login.cookie }, 403, 'feature_disabled');
    }
    await expect('business write remains closed', '/api/cases', { method: 'POST', body: { name: 'must not create' }, cookie: login.cookie }, 403, 'phase1_business_closed');
  }
  assert.deepEqual(counts(), before, 'rejected business/internal requests must not write rows');
  const audits = db.prepare('SELECT action,detail FROM audit_log ORDER BY id').all();
  assert(audits.length > 0, 'real bootstrap/login audit evidence is required');
  const auditText = JSON.stringify(audits);
  const sessionToken = login.cookie.slice(login.cookie.indexOf('=') + 1);
  for (const secret of [password, obsoletePassword, server.internalKey, server.staticToken, login.cookie, sessionToken]) assert(!auditText.includes(secret), 'audit must not contain credentials');
  await expect('logout succeeds', '/api/logout', { method: 'POST', cookie: login.cookie }, 200);
  await expect('logged out session is revoked', '/api/auth/me', { cookie: login.cookie }, 401);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({ id: `R2-${id}`, scope: 'production identity and disabled-feature mapping only', rows, counts: before,
    auditRedaction: true, sqliteIntegrity: true, legacyDeepComponentAssertions: 'retained, not covered by this mapping' }));
} catch (error) { primaryError = error; throw error; }
finally { await resources.finish(primaryError); }
