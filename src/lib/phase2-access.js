import { db, withChangeContext, withImmediateTransaction } from '../db.js';
import { identity } from './identity.js';
import { identityError } from './identity-service.js';

const WRITERS = new Set(['admin', 'editor']);
const READERS = new Set(['admin', 'editor', 'viewer']);
let activeActor = null;
let guarded = false;

export function requireCaseAccess(user, write = false) {
  if (!user) throw identityError(401, 'unauthorized', '请先登录');
  if (!(write ? WRITERS : READERS).has(user.role_key)) {
    throw identityError(403, 'case_forbidden', '当前账号没有此案件操作权限');
  }
}

export function installCaseWriteGuards() {
  if (guarded) return;
  db.function('phase2_case_write_allowed', () => Number(activeActor !== null));
  const tables = ['cases', 'events', 'deadlines', 'tasks', 'worklog',
    'contacts', 'facts', 'attachments', 'fee_items', 'phase2_fee_terms'];
  for (const table of tables) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const allowed = operation === 'DELETE' ? '0' : 'phase2_case_write_allowed()';
      db.exec(`CREATE TEMP TRIGGER phase2_guard_${table}_${operation}
        BEFORE ${operation} ON main.${table} WHEN ${allowed} = 0 BEGIN
          SELECT RAISE(ABORT, 'case_write_forbidden');
        END`);
    }
  }
  guarded = true;
}

// Always re-read the database session before entering a synchronous write.
export function withCaseWrite(token, work, requestId) {
  if (activeActor !== null) throw new Error('Nested case write scope');
  return withImmediateTransaction(() => {
    const user = identity.session(token)?.user;
    requireCaseAccess(user, true);
    activeActor = user.id;
    try {
      return withChangeContext({ actor: user.id, authenticatedUser: user, requestId }, () => {
        const result = work(user.id);
        if (typeof result?.then === 'function') throw new TypeError('Case write must be synchronous');
        return result;
      });
    } finally {
      activeActor = null;
    }
  });
}

// Legacy isolated fixtures run without the product guards.
export function assertCaseWriteActor(actor, phase2 = false) {
  if ((phase2 || guarded) && (activeActor === null || activeActor !== actor)) {
    throw identityError(403, 'case_forbidden', '案件写入缺少有效身份');
  }
}

export function requireVersion(input, row) {
  if (!Number.isSafeInteger(input) || input < 1) {
    throw identityError(400, 'version_required', '请提供当前记录版本');
  }
  if (input !== row.version) {
    throw identityError(409, 'version_conflict', '记录已更新，请刷新后重试');
  }
}
