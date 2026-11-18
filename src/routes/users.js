import { Router } from 'express';
import { apiAuth, setSessionCookie } from '../middleware/auth.js';
import { identity } from '../lib/identity.js';
import { fields, handled } from './auth.js';

const r = Router();
r.use('/users', apiAuth, (req, res, next) => {
  if (req.user?.role_key !== 'admin') return res.status(403).json({ error: '仅管理员可管理账号', code: 'forbidden' });
  next();
});
r.get('/users', handled((req, res) => res.json({ users: identity.listUsers(req.user.id, req.user.session_version) })));
r.post('/users', handled((req, res) => {
  const input = fields(req.body, ['username', 'display_name', 'role_key', 'password']);
  const user = identity.createUser(req.user.id, input, req.requestId, { actorSessionVersion: req.user.session_version });
  res.status(201).json({ user });
}));
function modify(req, res, allowed) {
  const input = fields(req.body, allowed);
  const user = identity.changeUser(req.user.id, req.params.id, input, { requestId: req.requestId, excludeResponse: res, actorSessionVersion: req.user.session_version });
  if (req.params.id === req.user.id) setSessionCookie(res, req, '', 0);
  res.json({ user, login_required: req.params.id === req.user.id });
}
r.patch('/users/:id', handled((req, res) => modify(req, res, ['version', 'active', 'role_key'])));
r.post('/users/:id/reset-password', handled((req, res) => {
  if (typeof req.body?.password !== 'string') return res.status(400).json({ error: '请输入新密码', code: 'password_invalid' });
  modify(req, res, ['version', 'password']);
}));
export default r;
