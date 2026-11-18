import crypto from 'node:crypto';
import { identityError } from './identity-service.js';
import passwordHash from './password-hash.cjs';

export function createBootstrapAuthority(identity) {
  let capability = null;
  let configured = false;
  let consumed = false;
  function configure({ key, legacy = null }) {
    if (configured) throw new Error('Bootstrap authority is already configured');
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid bootstrap capability');
    if (legacy && (typeof legacy.user !== 'string' || !passwordHash.parsePasswordHash(legacy.passHash))) throw new Error('Invalid trusted legacy identity');
    configured = true;
    capability = { key: Buffer.from(key, 'hex'), legacy: legacy ? Object.freeze({ user: legacy.user, passHash: legacy.passHash }) : null };
  }
  function authorize(candidate) {
    const digest = crypto.createHash('sha256').update(typeof candidate === 'string' ? candidate : '').digest();
    const expected = crypto.createHash('sha256').update(capability ? capability.key.toString('hex') : '').digest();
    if (!capability || !crypto.timingSafeEqual(digest, expected)) throw identityError(403, 'bootstrap_forbidden', '初始化请求未获授权');
  }
  function status(key) {
    authorize(key);
    const state = identity.state();
    return { initialized: Boolean(state.initialized), legacy_required: Boolean(state.legacy_required || capability.legacy),
      legacy_available: Boolean(capability.legacy), legacy_username: capability.legacy?.user || null };
  }
  function initialize(key, input, requestId) {
    authorize(key);
    if (consumed) throw identityError(409, 'already_initialized', '管理员已初始化');
    const user = identity.bootstrap(input, { legacy: capability.legacy, requestId });
    // Keep only status readback until the trusted main process confirms the
    // configuration switch. Initialization itself is already permanently used.
    consumed = true;
    return user;
  }
  return { configure, status, initialize, revoke: () => { capability = null; } };
}
