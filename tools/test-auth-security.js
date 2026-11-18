import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anjian-auth-security-'));
process.env.DB_PATH = path.join(scratch, 'auth.db');
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.ANJIAN_USER = 'security-test-user';
process.env.ANJIAN_PASS_HASH = 'test-only-not-used-here';
delete process.env.ANJIAN_INTERNAL_KEY;
delete process.env.ANJIAN_UNSAFE_NO_AUTH;

const { db } = await import('../src/db.js');
const auth = await import('../src/middleware/auth.js');

const loginHash = auth.hashPassword('correct horse', { ...process.env, ANJIAN_SCRYPT_N: '' });
process.env.ANJIAN_PASS_HASH = loginHash;
const { identity } = await import('../src/lib/identity.js');
identity.bootstrap({username:'security-test-user',password:'correct horse'});
const digest=token=>crypto.createHash('sha256').update(token).digest('hex');
const responses=[];
assert.equal(auth.secretMatches('same-secret', 'same-secret'), true);
assert.equal(auth.secretMatches('short', 'a-much-longer-secret'), false);
assert.equal(auth.secretMatches(undefined, undefined), false, '缺失的凭据不能因摘要相同而放行');
assert.deepEqual(
  auth.verifyLoginCredentials('security-test-user', 'correct horse'),
  { ok: true, legacy: false }
);
assert.equal(
  auth.verifyLoginCredentials('unknown-user', 'correct horse').ok,
  false,
  '未知用户名即使配对正确密码也不得放行，但必须走同一密码校验函数'
);
assert.equal(auth.verifyLoginCredentials('security-test-user', 'wrong password').ok, false);

function responseDouble() {
  const result = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    destroy() { this.emit('close'); },
  });
  responses.push(result);
  return result;
}

const secureResponse = responseDouble();
const secureRequest = { secure: true, headers: {} };
const token=identity.login('security-test-user','correct horse').token;
auth.setSessionCookie(secureResponse,secureRequest,token);
assert.match(secureResponse.headers['set-cookie'], /; Secure$/);
assert.match(secureResponse.headers['set-cookie'], /SameSite=Lax/);
let session = db.prepare('SELECT * FROM user_sessions WHERE token_hash = ?').get(digest(token));
assert.equal(session.created_at, session.last_seen);
assert.equal(Math.abs(session.created_at - Date.now()) < 5000, true);

const plainResponse = responseDouble();
auth.setSessionCookie(plainResponse, { secure: false, headers: {} }, identity.login('security-test-user','correct horse').token);
assert.doesNotMatch(plainResponse.headers['set-cookie'], /; Secure/);

process.env.ANJIAN_STATIC_TOKEN = 'static-token-with-fixed-digest-comparison';
let staticTokenAllowed = false;
auth.apiAuth({
  secure: false,
  headers: { cookie: 'anjian_token=static-token-with-fixed-digest-comparison' },
  get() { return undefined; },
}, responseDouble(), () => { staticTokenAllowed = true; });
assert.equal(staticTokenAllowed, false, 'Phase 1 生产认证不能由正确 static token 绕过');
const wrongStaticResponse = responseDouble();
auth.apiAuth({
  secure: false,
  headers: { cookie: 'anjian_token=x' },
  get() { return undefined; },
}, wrongStaticResponse, () => assert.fail('错误 static token 不得放行'));
assert.equal(wrongStaticResponse.statusCode, 401);
delete process.env.ANJIAN_STATIC_TOKEN;

db.prepare('UPDATE user_sessions SET last_seen=?, expires_at=? WHERE token_hash=?')
  .run(Date.now() - 2 * 86400000, Date.now() + 2 * 86400000, digest(token));
const rollingResponse = responseDouble();
let passed = false;
auth.apiAuth({
  secure: true,
  headers: { cookie: `anjian_sess=${token}` },
  get() { return undefined; },
}, rollingResponse, () => { passed = true; });
assert.equal(passed, true);
assert.match(rollingResponse.headers['set-cookie'], new RegExp(`^anjian_sess=${token};`));
assert.match(rollingResponse.headers['set-cookie'], /Max-Age=2592000; Secure$/);
session = db.prepare('SELECT * FROM user_sessions WHERE token_hash = ?').get(digest(token));
assert.equal(session.expires_at - Date.now() > 29 * 86400000, true);

const limiterIp = '203.0.113.10';
for (let attempt = 0; attempt < 5; attempt += 1) {
  const request = {
    ip: limiterIp,
    body: { username: 'same-account' },
    headers: { 'x-real-ip': `198.51.100.${attempt + 1}` },
  };
  const response = responseDouble();
  let allowed = false;
  auth.loginLimiter(request, response, () => { allowed = true; });
  assert.equal(allowed, true);
  assert.equal(request._loginIp, limiterIp, '限速来源必须使用 Express 解析后的 req.ip');
  auth.recordLoginFail(request._loginKey);
}
const lockedRequest = { ip: limiterIp, body: { username: 'same-account' }, headers: {} };
const lockedResponse = responseDouble();
auth.loginLimiter(lockedRequest, lockedResponse, () => assert.fail('第六次同源同账号不得放行'));
assert.equal(lockedResponse.statusCode, 429);
assert.match(lockedResponse.headers['retry-after'], /^\d+$/);

const otherAccount = { ip: limiterIp, body: { username: 'other-account' }, headers: {} };
let otherAllowed = false;
auth.loginLimiter(otherAccount, responseDouble(), () => { otherAllowed = true; });
assert.equal(otherAllowed, true, '不同账号应使用独立限速桶');

const internalRequest = { get() { return undefined; } };
const noInternalKeyResponse = responseDouble();
auth.internalAuth(internalRequest, noInternalKeyResponse, () => assert.fail('正常模式缺 internal key 不得放行'));
assert.equal(noInternalKeyResponse.statusCode, 403);

process.env.ANJIAN_INTERNAL_KEY = 'separate-test-key';
const wrongInternalKeyResponse = responseDouble();
auth.internalAuth(internalRequest, wrongInternalKeyResponse, () => assert.fail('错误 internal key 不得放行'));
assert.equal(wrongInternalKeyResponse.statusCode, 403);

let internalAllowed = false;
auth.internalAuth({ get(name) {
  return name === 'X-Anjian-Key' ? 'separate-test-key' : undefined;
} }, responseDouble(), () => { internalAllowed = true; });
assert.equal(internalAllowed, false, '正确 internal key 也不能绕过关闭策略');

// R3 now covers the stronger Phase 1 rule: both auto and explicit internal
// credentials are denied on every former read/write entry point.
process.env.ANJIAN_INTERNAL_KEY_SOURCE = 'electron-auto';
const electronAutoRequest = (reqPath) => ({
  path: reqPath,
  get(name) { return name === 'X-Anjian-Key' ? 'separate-test-key' : undefined; },
});

for (const allowedPath of ['/agent-proposals', '/agent-case-view', '/agent-digest']) {
  let allowed = false;
  auth.internalAuth(electronAutoRequest(allowedPath), responseDouble(), () => { allowed = true; });
  assert.equal(allowed, false, `Phase 1 的 electron-auto key 也不得放行 ${allowedPath}`);
}

for (const blockedPath of ['/digest', '/cases', '/cases/byname/张三诉李四', '/inbox']) {
  const blockedResponse = responseDouble();
  auth.internalAuth(electronAutoRequest(blockedPath), blockedResponse, () => assert.fail(`electron-auto key 不应放行 ${blockedPath}`));
  assert.equal(blockedResponse.statusCode, 403);
  assert.equal(blockedResponse.body.code, 'feature_disabled');
}

delete process.env.ANJIAN_INTERNAL_KEY_SOURCE;
// 显式配置的 key 不能恢复任何生产内部接口。
let plainKeyStillAllowed = false;
auth.internalAuth(electronAutoRequest('/digest'), responseDouble(), () => { plainKeyStillAllowed = true; });
assert.equal(plainKeyStillAllowed, false, '显式 internal key 仍须遵守全部角色关闭规则');

delete process.env.ANJIAN_INTERNAL_KEY;
process.env.ANJIAN_UNSAFE_NO_AUTH = '1';
let unsafeInternalAllowed = false;
auth.internalAuth(internalRequest, responseDouble(), () => { unsafeInternalAllowed = true; });
assert.equal(unsafeInternalAllowed, true, '显式回环测试模式应覆盖隔离测试所需的 internal 面');

for(const response of responses)response.emit('finish');
db.close();
fs.rmSync(scratch, { recursive: true, force: true });
console.log('auth security tests: user-bound hashed session + secure rolling cookie + bounded login key + closed static/internal bypass passed');
