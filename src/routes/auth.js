import crypto from 'node:crypto';
import { Router } from 'express';
import { identity } from '../lib/identity.js';
import { createBootstrapAuthority } from '../lib/identity-bootstrap.js';
import { identityError } from '../lib/identity-service.js';
import { apiAuth, destroySession, setSessionCookie, loginLimiter, recordLoginFail, clearLoginFail } from '../middleware/auth.js';

export const bootstrapAuthority = createBootstrapAuthority(identity);
export function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw identityError(400, 'fields_invalid', '请求字段不正确');
  }
  return body;
}
export function handled(work) {
  return (req, res, next) => {
    try { work(req, res); }
    catch (error) {
      if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      next(error);
    }
  };
}
const r = Router();
r.post('/login', loginLimiter, handled((req, res) => {
  const input = fields(req.body, ['username', 'password']);
  const found = identity.login(input.username, input.password, crypto.randomUUID());
  if (!found) {
    recordLoginFail(req._loginKey);
    identity.recordLoginFailure(crypto.randomUUID(), req.ip);
    return res.status(401).json({ error: '用户名或密码不对' });
  }
  clearLoginFail(req._loginKey);
  setSessionCookie(res, req, found.token);
  res.json({ ok: true, user: found.user });
}));
r.post('/logout', handled((req, res) => {
  req.requestId = crypto.randomUUID();
  destroySession(req, res);
  res.json({ ok: true });
}));
r.get('/auth/me', apiAuth, (req, res) => res.json({ user: req.user }));
r.post('/auth/change-password', apiAuth, handled((req, res) => {
  const input = fields(req.body, ['old_password', 'password', 'version']);
  identity.changeUser(req.user.id, req.user.id, input, { requestId: req.requestId, excludeResponse: res, selfPassword: true, actorSessionVersion: req.user.session_version });
  setSessionCookie(res, req, '', 0);
  res.json({ ok: true, login_required: true });
}));
r.get('/bootstrap/status', handled((req, res) => {
  res.json(bootstrapAuthority.status(req.get('X-Anjuan-Bootstrap')));
}));
r.post('/bootstrap/initialize', loginLimiter, handled((req, res) => {
  const input = fields(req.body, ['username', 'display_name', 'password', 'old_password', 'confirm_legacy']);
  try {
    const user = bootstrapAuthority.initialize(req.get('X-Anjuan-Bootstrap'), input, crypto.randomUUID());
    clearLoginFail(req._loginKey);
    res.status(201).json({ user });
  } catch (error) { recordLoginFail(req._loginKey); throw error; }
}));
export default r;
