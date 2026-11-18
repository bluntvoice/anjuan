import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { once } from 'node:events';

// This stream exists only in this isolated fixture, never in the production router.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjuan-auth-stream-'));
process.env.DB_PATH = path.join(root, 'stream.db');
process.env.NODE_ENV = 'production'; process.env.HOST = '127.0.0.1'; delete process.env.ANJIAN_UNSAFE_NO_AUTH;
const { db } = await import('../../src/db.js');
const { identity } = await import('../../src/lib/identity.js');
const { apiAuth } = await import('../../src/middleware/auth.js');
const password = crypto.randomBytes(24).toString('base64');
const admin = identity.bootstrap({ username: 'Admin', password });
const other = identity.createUser(admin.id, { username: 'Other', role_key: 'viewer', password });
const app = express();
app.get('/synthetic-stream', apiAuth, (req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: connected\n\n'); });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = 'http://127.0.0.1:' + server.address().port;
const readers = [];
async function stream(token) {
  const response = await fetch(address + '/synthetic-stream', { headers: { Cookie: 'anjian_sess=' + token } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); readers.push(reader); await reader.read(); return reader;
}
async function mustClose(reader) {
  let timer;
  try {
    await Promise.race([
      reader.read().then(value => assert.equal(value.done, true), () => true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Revoked authenticated stream remained open')), 3500); }),
    ]);
  } finally { clearTimeout(timer); }
}
try {
  const first = identity.login('Admin', password), second = identity.login('Admin', password);
  const a = await stream(first.token), a2 = await stream(second.token);
  const bToken = identity.login('Other', password).token;
  const b = await stream(bToken);
  identity.logout(first.token);
  await mustClose(a);
  assert(identity.session(second.token), 'Logout revokes only its own session');
  const secondAdmin = identity.createUser(admin.id, { username: 'BackupAdmin', role_key: 'admin', password });
  identity.changeUser(secondAdmin.id, admin.id, { version: admin.version, active: false });
  await mustClose(a2);
  assert(identity.session(bToken), 'Revoking another user must not revoke this session');
  const b2 = await stream(bToken);
  // Simulate revocation by another process sharing this DB: the periodic session check must close the stream.
  db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run(other.id);
  await mustClose(b); await mustClose(b2);
  console.log('authenticated streams: logout scope, user revocation and persisted-version revalidation passed');
} finally {
  for (const reader of readers) await reader.cancel().catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
}
