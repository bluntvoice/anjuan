import crypto from 'node:crypto';
import passwordHash from './password-hash.cjs';
import { newPasswordError } from '../../public/js/password-policy.js';
import { revokeUserConnections, revokeSessionConnections } from './auth-connections.js';

const SESSION_MS = 30 * 86400000;
const ROLL_MS = 86400000;
const ROLES = new Set(['admin', 'editor', 'viewer']);
const DUMMY_HASH = passwordHash.hashPassword(crypto.randomBytes(32).toString('base64'));
export function identityError(status, code, message) { return Object.assign(new Error(message), { status, code }); }
export function normalizedUsername(input) {
  if (typeof input !== 'string' || !input.isWellFormed()) throw identityError(400, 'username_invalid', '用户名格式不正确');
  const username = input.trim().normalize('NFC');
  if (!/^[\p{L}\p{N}_.@-]{2,64}$/u.test(username)) throw identityError(400, 'username_invalid', '用户名须为 2–64 个字母、数字或 _.@- 字符');
  return { username, normalized: username.replace(/[A-Z]/g, c => c.toLowerCase()) };
}
export function assertNewPassword(value) {
  const error = newPasswordError(value);
  if (error) throw identityError(400, 'password_invalid', error);
}
export function safeUser(row) {
  if (!row) return null;
  return Object.freeze({ id: row.id, username: row.username, display_name: row.display_name, role_key: row.role_key,
    active: Boolean(row.active), version: row.version, session_version: row.session_version });
}
const tokenDigest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export function createIdentityService(db, { clock = Date.now, onRevoke = revokeUserConnections } = {}) {
  const rawUser = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const tx = work => db.transaction(work).immediate();
  const nowIso = () => new Date(clock()).toISOString();
  function state() { return db.prepare('SELECT * FROM identity_state WHERE id=1').get(); }
  function log(actor, action, target, requestId, detail = {}) {
    db.prepare(`INSERT INTO audit_log (actor,action,entity,entity_id,detail,actor_user_id,actor_display_name,actor_kind,request_id,target_user_id)
      VALUES (?,?,'user',NULL,?,?,?,?,?,?)`).run(actor?.id || 'system', action, JSON.stringify(detail), actor?.id || null,
      actor?.display_name || 'system', actor ? 'user' : 'system', requestId || crypto.randomUUID(), target || null);
  }
  function assertActor(actorId, admin = false, expectedSessionVersion) {
    const actor = rawUser(actorId);
    if (!actor?.active) throw identityError(401, 'session_invalid', '登录已失效');
    if (expectedSessionVersion !== undefined && actor.session_version !== expectedSessionVersion) {
      throw identityError(401, 'session_invalid', '登录已失效');
    }
    if (admin && actor.role_key !== 'admin') throw identityError(403, 'forbidden', '仅管理员可管理账号');
    return actor;
  }
  function insertUser(input, { storedHash = null } = {}) {
    const { username, normalized } = normalizedUsername(input.username);
    if (!ROLES.has(input.role_key)) throw identityError(400, 'role_invalid', '角色不正确');
    if (!storedHash) assertNewPassword(input.password);
    const displayName = input.display_name === undefined ? username : input.display_name;
    if (typeof displayName !== 'string' || !displayName.isWellFormed() || Array.from(displayName).length < 1 || Array.from(displayName).length > 80 || /[\x00-\x1f\x7f]/.test(displayName)) {
      throw identityError(400, 'display_name_invalid', '显示名称须为 1–80 个字符');
    }
    const id = crypto.randomUUID(), at = nowIso();
    try {
      db.prepare(`INSERT INTO users (id,username,username_normalized,display_name,password_hash,role_key,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, username, normalized, displayName, storedHash || passwordHash.hashPassword(input.password), input.role_key, at, at);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw identityError(409, 'username_exists', '用户名已存在');
      throw error;
    }
    return rawUser(id);
  }
  function bootstrap(input, { legacy = null, requestId } = {}) {
    return tx(() => {
      const current = state();
      if (current.initialized || db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw identityError(409, 'already_initialized', '管理员已初始化');
      const requiresLegacy = current.legacy_required || legacy;
      let storedHash = null;
      if (requiresLegacy) {
        if (!legacy || !passwordHash.parsePasswordHash(legacy.passHash) || input.confirm_legacy !== true
          || typeof input.old_password !== 'string' || !passwordHash.verifyPassword(input.old_password, legacy.passHash)) {
          throw identityError(403, 'legacy_verification_required', '须确认迁移并验证原账号凭据；无法验证时停止初始化');
        }
        storedHash = legacy.passHash;
      }
      const created = insertUser({ ...input, username: legacy ? legacy.user : input.username, role_key: 'admin' }, { storedHash });
      db.prepare('DELETE FROM sessions').run();
      db.prepare('DELETE FROM user_sessions').run();
      db.prepare('UPDATE identity_state SET initialized=1, initialized_at=?, first_admin_id=? WHERE id=1 AND initialized=0').run(nowIso(), created.id);
      log(created, legacy ? 'identity.legacy-import' : 'identity.bootstrap', created.id, requestId);
      return safeUser(created);
    });
  }
  function login(username, password, requestId) {
    let normalized = null;
    try { normalized = normalizedUsername(username).normalized; } catch { /* uniform login failure */ }
    return tx(() => {
      const user = normalized ? db.prepare('SELECT * FROM users WHERE username_normalized=?').get(normalized) : null;
      const valid = typeof password === 'string' && password.isWellFormed()
        && passwordHash.verifyPassword(password, user?.password_hash || DUMMY_HASH);
      if (!valid || !user?.active || !state().initialized) return null;
      const token = crypto.randomBytes(32).toString('hex'), now = clock();
      db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now);
      db.prepare('INSERT INTO user_sessions (token_hash,user_id,session_version,created_at,expires_at,last_seen) VALUES (?,?,?,?,?,?)')
        .run(tokenDigest(token), user.id, user.session_version, now, now + SESSION_MS, now);
      log(user, 'identity.login', user.id, requestId);
      return { token, user: safeUser(user) };
    });
  }
  function session(token, { renew = false } = {}) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const digest = tokenDigest(token), now = clock();
    const row = db.prepare(`SELECT u.*, s.session_version AS issued_version, s.last_seen, s.expires_at
      FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(digest);
    if (!row?.active || row.issued_version !== row.session_version || row.expires_at <= now) return null;
    let renewed = false;
    if (renew && now - row.last_seen >= ROLL_MS) {
      const updated = db.prepare(`UPDATE user_sessions SET last_seen=?, expires_at=? WHERE token_hash=? AND expires_at>?
        AND session_version=(SELECT session_version FROM users WHERE id=user_id AND active=1)`).run(now, now + SESSION_MS, digest, now);
      if (!updated.changes) return null;
      renewed = true;
    }
    return { user: safeUser(row), tokenHash: digest, renewed };
  }
  function logout(token, { requestId, excludeResponse } = {}) {
    const found = session(token);
    if (!found) return false;
    tx(() => {
      db.prepare('DELETE FROM user_sessions WHERE token_hash=?').run(found.tokenHash);
      log(rawUser(found.user.id), 'identity.logout', found.user.id, requestId);
    });
    revokeSessionConnections(found.tokenHash, excludeResponse);
    return true;
  }
  function createUser(actorId, input, requestId, { actorSessionVersion } = {}) {
    return tx(() => {
      const actor = assertActor(actorId, true, actorSessionVersion);
      const created = insertUser(input);
      log(actor, 'identity.user-create', created.id, requestId, { role_key: created.role_key });
      return safeUser(created);
    });
  }
  function changeUser(actorId, targetId, input, { requestId, excludeResponse, selfPassword = false, actorSessionVersion } = {}) {
    const changed = tx(() => {
      const actor = assertActor(actorId, !selfPassword, actorSessionVersion);
      if (selfPassword && actorId !== targetId) throw identityError(403, 'forbidden', '只能修改本人密码');
      const target = rawUser(targetId);
      if (!target) throw identityError(404, 'user_missing', '账号不存在');
      if (!Number.isSafeInteger(input.version) || input.version !== target.version) throw identityError(409, 'version_conflict', '账号已变化，请刷新后重试');
      if (selfPassword && (typeof input.old_password !== 'string' || !passwordHash.verifyPassword(input.old_password, target.password_hash))) {
        throw identityError(403, 'old_password_invalid', '原密码不正确');
      }
      const role = input.role_key === undefined ? target.role_key : input.role_key;
      const active = input.active === undefined ? Boolean(target.active) : input.active;
      if (!ROLES.has(role) || typeof active !== 'boolean') throw identityError(400, 'user_fields_invalid', '账号状态或角色不正确');
      let nextHash = target.password_hash;
      if (input.password !== undefined) { assertNewPassword(input.password); nextHash = passwordHash.hashPassword(input.password); }
      if (selfPassword && (input.role_key !== undefined || input.active !== undefined || input.password === undefined)) {
        throw identityError(400, 'password_fields_invalid', '本人改密仅接受密码字段');
      }
      if (target.active && target.role_key === 'admin' && (!active || role !== 'admin')
        && !db.prepare("SELECT 1 FROM users WHERE active=1 AND role_key='admin' AND id<>?").get(targetId)) {
        throw identityError(409, 'last_active_admin', '必须保留至少一名启用管理员');
      }
      db.prepare(`UPDATE users SET role_key=?,active=?,password_hash=?,version=version+1,session_version=session_version+1,updated_at=? WHERE id=? AND version=?`)
        .run(role, active ? 1 : 0, nextHash, nowIso(), targetId, input.version);
      db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(targetId);
      log(actor, selfPassword ? 'identity.password-change' : input.password !== undefined ? 'identity.password-reset' : 'identity.user-update', targetId, requestId,
        { role_key: role, active, password_changed: input.password !== undefined });
      return safeUser(rawUser(targetId));
    });
    onRevoke(targetId, excludeResponse);
    return changed;
  }
  function recordLoginFailure(requestId, ip) {
    db.prepare(`INSERT INTO audit_log (actor,action,entity,detail,actor_kind,request_id)
      VALUES ('anonymous','identity.login-fail','session',?,'anonymous',?)`)
      .run(JSON.stringify({ source: crypto.createHash('sha256').update(String(ip || '')).digest('hex') }), requestId);
  }
  return { state, bootstrap, login, session, logout, createUser, changeUser, recordLoginFailure,
    getUser: id => safeUser(rawUser(id)), listUsers: (actorId, expectedSessionVersion) => { assertActor(actorId, true, expectedSessionVersion); return db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(safeUser); } };
}
