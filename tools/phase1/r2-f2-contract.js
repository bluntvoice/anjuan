// F2 current contract only. Historical positive-key assertions are archived, not emulated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import passwordHash from '../../src/lib/password-hash.cjs';
import { startIdentityServer } from './http-fixture.js';
import { assertF1Environment, assertSQLite } from './r2-f1-contract.js';

export function f2Request(base, route, { method = 'GET', body, cookie, headers = {} } = {}) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'F2 HTTP is loopback only');
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(route, base), { method, headers: {
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
    req.setTimeout(8000, () => req.destroy(new Error('F2 native HTTP timeout')));
    req.end(encoded);
  });
}

export function recordApprovedRetirement(retainedFunction) {
  const record = JSON.parse(fs.readFileSync(new URL('./r2-38-retired-auth-contract.json', import.meta.url)));
  const text = retainedFunction.toString().replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), record.source.functionSha256LF);
  assert.equal(text, record.source.functionTextLF, 'all original historical source must remain auditable');
  assert.equal(record.assertions.length, 5);
  assert.equal(record.assertions.reduce((n, row) => n + row.evaluations, 0), 9);
  assert.equal(new Set(record.assertions.flatMap(row => row.requestIds)).size, 5);
  assert(record.assertions.every(row => row.disposition === 'retired-approved' && text.includes(row.text)));
  console.log('F2_RETIRED ' + JSON.stringify({ id: 'R2-38', status: record.status, approval: record.approval,
    sourceSha256: record.source.sha256, functionSha256LF: record.source.functionSha256LF,
    assertionIds: record.assertions.map(row => row.id), sourceAssertions: 5, expectedEvaluations: 9, historicalHttpRequests: 5,
    currentClaim: 'historical response contracts retired by explicit approval; not executed or retrospectively passed' }));
}

export async function verifyF2ProductionContract(resources) {
  assertF1Environment();
  for (const source of [null, 'electron-auto']) {
    const obsoletePassword = crypto.randomBytes(24).toString('base64');
    const server = await startIdentityServer({ r2InternalKeySource: source,
      r2LegacyCredentials: { username: 'F2ObsoleteAccount', hash: passwordHash.hashPassword(obsoletePassword) } });
    let stopped = false;
    const request = (route, options) => f2Request(server.address, route, options);
    const stop = async () => {
      if (!stopped) { await server.stop(); await assert.rejects(request('/healthz'), error => error.code === 'ECONNREFUSED'); stopped = true; }
      return { pid: server.child.pid, address: server.address, exitCode: server.child.exitCode, signal: server.child.signalCode, stopped, portReleased: true };
    };
    resources.cleanup(`F2 production ${source || 'explicit-key'} backend + port`, stop, 20);
    resources.directory(server.root);
    const db = resources.database(new Database(server.database));
    const rows = [], responseBodies = [];
    async function expect(label, route, options, status, code) {
      const response = await request(route, options);
      assert.equal(response.status, status, `${label}: ${route}`);
      if (code) assert.equal(response.json?.code, code, `${label}: exact current rejection reason`);
      if (route.startsWith('/internal') && code === 'feature_disabled') assert.notEqual(response.json?.code, 'electron_auto_key_scoped');
      rows.push({ label, route, method: options?.method || 'GET', status: response.status, code: response.json?.code || null });
      responseBodies.push(response.text);
      return response;
    }
    await expect('anonymous identity denied', '/api/auth/me', {}, 401);
    await expect('legacy static cookie denied', '/api/auth/me', { cookie: 'anjian_token=' + server.staticToken }, 401);
    await expect('legacy session cookie denied', '/api/auth/me', { cookie: 'anjian_sess=' + server.staticToken }, 401);
    await expect('legacy environment login denied', '/api/login', { method: 'POST', body: { username: 'F2ObsoleteAccount', password: obsoletePassword } }, 401);
    const password = crypto.randomBytes(24).toString('base64');
    await expect('synthetic DB bootstrap', '/api/bootstrap/initialize', { method: 'POST',
      headers: { 'X-Anjuan-Bootstrap': server.key }, body: { username: 'F2SyntheticAdmin', password } }, 201);
    const login = await expect('synthetic DB login', '/api/login', { method: 'POST', body: { username: 'F2SyntheticAdmin', password } }, 200);
    assert(login.cookie);
    const me = await expect('forged actor cannot replace DB identity', '/api/auth/me', {
      cookie: login.cookie, headers: { 'X-Anjian-Actor': 'forged-f2-user' },
    }, 200);
    assert.equal(me.json.user.id, login.json.user.id);
    db.prepare("INSERT INTO cases(name,stage) VALUES ('F2 合成本案','审理中'),('F2 合成他案','审理中')").run();
    const tables = ['cases', 'events', 'deadlines', 'tasks', 'worklog', 'contacts', 'facts', 'inbox', 'sessions', 'change_log'];
    const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const auditBefore = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    const routes = [
      ...['/internal/agent-case-view', '/internal/agent-digest', '/internal/digest', '/internal/cases'].map(route => [route, 'GET']),
      ['/internal/agent-proposals', 'POST', { mode: 'direct', session_id: 'f2-forged-session', case_id: 1, kind: 'task', payload: { title: 'must not write' } }],
      ['/api/cases', 'POST', { name: 'must not create' }], ['/api/digest', 'GET'],
    ];
    for (const [route, method, body] of routes) {
      for (const [label, options] of [
        ['anonymous', {}], ['wrong internal key', { headers: { 'X-Anjian-Key': 'wrong-f2-key' } }],
        ['old internal key + forged actor/source', { headers: { 'X-Anjian-Key': server.internalKey, 'X-Anjian-Actor': 'forged-f2-user', 'X-Anjian-Key-Source': 'electron-auto' } }],
        ['legacy session', { cookie: 'anjian_sess=' + server.staticToken }],
        ['valid synthetic admin', { cookie: login.cookie }],
        ['valid admin plus old key', { cookie: login.cookie, headers: { 'X-Anjian-Key': server.internalKey } }],
      ]) {
        const internal = route.startsWith('/internal');
        const authenticated = options.cookie === login.cookie;
        await expect(label, route, { method, body, ...options }, internal || authenticated ? 403 : 401,
          internal ? 'feature_disabled' : authenticated ? 'phase1_business_closed' : undefined);
      }
      await expect('foreign Origin refused', route, { method, body, headers: { Origin: 'https://f2-invalid.example' } }, 403, 'request_origin_invalid');
      await expect('foreign Host refused', route, { method, body, headers: { Host: 'f2-invalid.example' } }, 403, 'request_origin_invalid');
    }
    assert.deepEqual(snapshot(), before, 'denied requests cannot alter any seeded business/change-log row');
    assert.deepEqual(db.prepare('SELECT * FROM audit_log ORDER BY id').all(), auditBefore, 'denied business requests cannot rewrite identity audit');
    const userAudits = auditBefore.filter(row => row.actor_kind === 'user');
    assert(userAudits.length >= 2);
    for (const row of userAudits) {
      assert.equal(row.actor, login.json.user.id);
      assert.equal(row.actor_user_id, login.json.user.id);
      assert.equal(row.target_user_id, login.json.user.id);
      assert(row.request_id);
    }
    await expect('logout', '/api/logout', { method: 'POST', cookie: login.cookie }, 200);
    await expect('revoked session denied', '/api/auth/me', { cookie: login.cookie }, 401);
    assert.equal(db.prepare('SELECT count(*) AS n FROM user_sessions').get().n, 0);
    const secrets = [password, obsoletePassword, server.internalKey, server.staticToken, server.key, login.cookie, login.cookie.split('=')[1]];
    const auditText = JSON.stringify(db.prepare('SELECT * FROM audit_log ORDER BY id').all());
    for (const secret of secrets) {
      assert(!auditText.includes(secret), 'audit must redact full credentials');
      assert(responseBodies.every(text => !text.includes(secret)), 'response bodies must not disclose secrets');
    }
    assertSQLite(db);
    console.log('F2_PRODUCTION ' + JSON.stringify({ id: 'R2-38', status: 'passed', configuredKeySource: source,
      nodeEnv: 'production', unsafe: false, rows, noBusinessWrites: true, auditIdentityAndRedaction: true,
      responseSecretRedaction: true, sessionRevocation: true, sqlite: 'ok',
      scope: 'current closed production endpoints, not historical positive-key authentication' }));
    await stop();
  }
}
