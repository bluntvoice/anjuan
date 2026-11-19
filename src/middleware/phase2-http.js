import { identityError } from '../lib/identity-service.js';
import { requireCaseAccess, withCaseWrite } from '../lib/phase2-access.js';
import { parseCookies } from './auth.js';
import { fields, handled } from '../routes/auth.js';

function access(write) {
  return (req, res, next) => {
    try {
      requireCaseAccess(req.user, write);
    } catch (error) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    next();
  };
}

export const caseRead = access(false);
export const caseWritePermission = access(true);

export function caseWrite(req, work) {
  return withCaseWrite(parseCookies(req).anjian_sess, work, req.requestId);
}

export function writeCaseRoute(work) {
  return handled((req, res) => {
    const result = caseWrite(req, actor => work(req, actor));
    res.status(req.method === 'POST' ? 201 : 200).json(result);
  });
}

export function caseFields(body, allowed, numeric = [], booleans = []) {
  const input = fields(body, allowed);
  for (const [key, value] of Object.entries(input)) {
    if (numeric.includes(key) || booleans.includes(key)) continue;
    if (typeof value !== 'string') throw identityError(400, 'fields_invalid', '文本字段格式不正确');
  }
  for (const key of booleans) {
    if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') {
      throw identityError(400, 'fields_invalid', '确认字段格式不正确');
    }
  }
  return input;
}

export function caseId(value) {
  if (!/^\d+$/u.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw identityError(400, 'id_invalid', '记录编号不正确');
  }
  return Number(value);
}
