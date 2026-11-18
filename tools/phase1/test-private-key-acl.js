import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeWindowsPrivateTempFile, readWindowsPrivateFile, protectWindowsPrivateFile } from '../../src/lib/private-key-file.js';
import { readActualWindowsAcl, assertPrivateWindowsAcl } from './windows-acl-test-utils.js';

if (process.platform !== 'win32') throw new Error('This test requires a real Windows ACL runner; use test-secret-box.js for POSIX');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anjuan-private-key-acl-'));
const parentBefore = readActualWindowsAcl(root).sddl;
const key = crypto.randomBytes(32);
try {
  const file = path.join(root, '密钥 [literal].key');
  writeWindowsPrivateTempFile(file, key);
  assertPrivateWindowsAcl(file);
  assert(readWindowsPrivateFile(file).equals(key));
  const old = path.join(root, 'old-inherited.key');
  fs.writeFileSync(old, key);
  assert(readWindowsPrivateFile(old).equals(key), 'Existing key bytes must not rotate during ACL hardening');
  assertPrivateWindowsAcl(old);
  assert.equal(readActualWindowsAcl(root).sddl, parentBefore, 'Parent directory ACL must remain unchanged');
  const failed = path.join(root, 'failed-before-secret.key');
  assert.throws(() => writeWindowsPrivateTempFile(failed, key, candidate => {
    assert.equal(fs.statSync(candidate).size, 0, 'No secret bytes may precede ACL protection');
    throw new Error('injected-acl-failure');
  }), /injected-acl-failure/);
  assert.equal(fs.existsSync(failed), false, 'ACL failure must remove only the empty owned temporary file');
  assert.throws(() => protectWindowsPrivateFile(root), /普通文件/);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const junction = path.join(root, 'junction'); fs.symlinkSync(outside, junction, 'junction');
  assert.throws(() => protectWindowsPrivateFile(junction), /普通文件/);
  fs.unlinkSync(junction);
  console.log('Windows private key ACL: independent readback, no parent change, existing-byte preservation, fail-before-write and reparse rejection passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
