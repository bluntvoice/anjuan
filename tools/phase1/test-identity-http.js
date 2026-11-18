import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { startIdentityServer } from './http-fixture.js';

const server = await startIdentityServer();
const password = crypto.randomBytes(24).toString('base64');
const db = new Database(server.database);
let matrixRequests = 0;
try {
  assert.equal((await server.request('/api/auth/me')).status, 401);
  assert.equal((await server.request('/api/bootstrap/status')).status, 403);
  assert.equal((await server.request('/api/bootstrap/status', { headers: { 'X-Anjuan-Bootstrap': 'forged' } })).status, 403);
  const initial = { method: 'POST', body: { username: 'Admin', password }, headers: { 'X-Anjuan-Bootstrap': server.key } };
  const race = await Promise.all([server.request('/api/bootstrap/initialize', initial), server.request('/api/bootstrap/initialize', initial)]);
  assert.equal(race.filter(r => r.status === 201).length, 1, 'Concurrent initialization must create exactly one administrator');
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal((await server.request('/api/bootstrap/initialize', initial)).status, 409, 'Consumed initialization capability must not create another user');
  assert.equal((await server.request('/api/bootstrap/status', { headers: initial.headers })).json.initialized, true,
    'Trusted status readback remains available for a failed configuration switch');
  const login = async username => {
    const response = await server.request('/api/login', { method: 'POST', body: { username, password } });
    assert.equal(response.status, 200); assert(response.cookie); return response;
  };
  const admin = await login('admin');
  assert.match(admin.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  for (const role of ['editor', 'viewer', 'admin']) {
    const created = await server.request('/api/users', { method: 'POST', cookie: admin.cookie,
      body: { username: role + 'Account', display_name: role, role_key: role, password } });
    assert.equal(created.status, 201);
  }
  const editor = await login('editorAccount'), viewer = await login('viewerAccount'), admin2 = await login('adminAccount');
  assert.notEqual(admin.json.user.id, admin2.json.user.id);
  assert.equal((await server.request('/api/users', { cookie: viewer.cookie })).status, 403);
  assert.equal((await server.request('/api/users', { method: 'POST', cookie: editor.cookie, body: {} })).status, 403);
  const me = await server.request('/api/auth/me?user_id=' + viewer.json.user.id, { cookie: editor.cookie, headers: { 'X-Anjian-Actor': viewer.json.user.id } });
  assert.equal(me.json.user.id, editor.json.user.id);
  const inventory = JSON.parse(fs.readFileSync(new URL('../../docs/phase0/evidence/endpoint-permissions.json', import.meta.url)));
  for (const session of [admin, editor, viewer]) {
    for (const route of inventory.filter(r => r.file !== 'src/routes/auth.js')) {
      const url = route.path.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, 'synthetic-missing-id');
      const response = await server.request(url, { method: route.method, cookie: session.cookie,
        body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) ? {} : undefined });
      assert.equal(response.status, 403, `${session.json.user.role_key} must be denied ${route.method} ${url}`);
      matrixRequests++;
      if (route.method === 'GET') {
        assert.equal((await server.request(url, { method: 'HEAD', cookie: session.cookie })).status, 403);
        matrixRequests++;
      }
    }
  }
  assert.equal((await server.request('/api/auth/me', { cookie: 'anjian_token=' + server.staticToken })).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0, 'Bootstrap must invalidate old sessions');
  const obsoleteToken = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions(token,expires_at) VALUES (?,datetime('now','+1 day'))").run(obsoleteToken);
  assert.equal((await server.request('/api/auth/me', { cookie: 'anjian_sess=' + obsoleteToken })).status, 401,
    'A valid-looking legacy session must not authenticate a new user');
  assert.equal((await server.request('/internal/cases', { headers: { 'X-Anjian-Key': server.internalKey } })).status, 403);
  const rejectedOrigin = await server.request('/api/users', { method: 'POST', cookie: admin.cookie, body: {}, headers: { Origin: 'https://untrusted.example' } });
  assert.equal(rejectedOrigin.status, 403);
  // fetch normalizes Host in this Node version; use a real raw Host header.
  assert.equal((await server.rawRequest('/api/auth/me', { Cookie: admin.cookie, Host: 'untrusted.example' })).status, 403);
  const failed1 = await server.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'incorrect' } });
  const failed2 = await server.request('/api/login', { method: 'POST', body: { username: 'unknown', password: 'incorrect' } });
  assert.deepEqual(failed1.json, failed2.json); assert.equal(failed1.status, 401);
  const viewerId = viewer.json.user.id;
  const beforeAudit = db.prepare('SELECT max(id) AS id FROM audit_log').get().id;
  const disabled = await server.request('/api/users/' + viewerId, { method: 'PATCH', cookie: admin.cookie,
    headers: { 'X-Anjian-Actor': editor.json.user.id }, body: { active: false, version: viewer.json.user.version } });
  assert.equal(disabled.status, 200);
  const audit = db.prepare('SELECT * FROM audit_log WHERE id>? ORDER BY id LIMIT 1').get(beforeAudit);
  assert.equal(audit.actor_user_id, admin.json.user.id); assert.equal(audit.target_user_id, viewerId);
  assert.equal((await server.request('/api/auth/me', { cookie: viewer.cookie })).status, 401);
  assert.equal((await server.request('/api/users/' + viewerId, { method: 'PATCH', cookie: admin.cookie, body: { active: true, version: 1 } })).status, 409);
  assert.equal((await server.request('/api/users/' + viewerId, { method: 'PATCH', cookie: admin.cookie, body: { active: true, version: 2, user_id: editor.json.user.id } })).status, 400);
  const passwordChanged = await server.request('/api/auth/change-password', { method: 'POST', cookie: editor.cookie,
    body: { old_password: password, password: '😀'.repeat(12), version: editor.json.user.version } });
  assert.equal(passwordChanged.status, 200); assert.match(passwordChanged.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await server.request('/api/auth/me', { cookie: editor.cookie })).status, 401);
  const adminRace = await Promise.all([
    server.request('/api/users/' + admin.json.user.id, { method: 'PATCH', cookie: admin.cookie, body: { role_key: 'viewer', version: 1 } }),
    server.request('/api/users/' + admin2.json.user.id, { method: 'PATCH', cookie: admin2.cookie, body: { role_key: 'viewer', version: 1 } }),
  ]);
  assert.equal(adminRace.filter(r => r.status === 200).length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE active=1 AND role_key='admin'").get().n, 1);
  const remaining = adminRace[0].status === 200 ? admin2 : admin;
  const logout = await server.request('/api/logout', { method: 'POST', cookie: remaining.cookie });
  assert.equal(logout.status, 200);
  assert.equal((await server.request('/api/auth/me', { cookie: remaining.cookie })).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1,
    'Only the deliberately injected obsolete row remains; new logins never write legacy sessions');
  assert.equal(db.prepare('SELECT token FROM sessions').get().token, obsoleteToken);
  console.log(JSON.stringify({ test: 'identity HTTP', initializationRace: true, businessMatrixRequests: matrixRequests,
    adminAlsoDenied: true, csrfAndHost: true, userIdAudit: true, revocation: true, lastAdminRace: true, logout: true }));
} finally { db.close(); await server.stop(); }
