// Real native capability probes only; junction/hardlink never substitute for symlink assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TestResources } from './test-resources.js';
import { assertF1Environment } from './r2-f1-contract.js';
const resources = new TestResources(import.meta.url);
let primaryError;
try {
  assertF1Environment();
  const scratch = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'w04-native-capabilities-')));
  const targetDir = path.join(scratch, 'synthetic-target'); fs.mkdirSync(targetDir);
  const targetFile = path.join(targetDir, 'sentinel.txt'); fs.writeFileSync(targetFile, 'W04 synthetic target unchanged');
  const rows = [];
  for (const kind of ['file-symlink', 'directory-symlink', 'junction', 'hardlink']) {
    const link = path.join(scratch, kind);
    const target = kind === 'file-symlink' || kind === 'hardlink' ? targetFile : targetDir;
    try {
      if (kind === 'hardlink') fs.linkSync(target, link);
      else fs.symlinkSync(target, link, kind === 'file-symlink' ? 'file' : kind === 'directory-symlink' ? 'dir' : 'junction');
    } catch (error) {
      rows.push({ kind, status: 'blocked', code: error.code, errno: error.errno, syscall: error.syscall, message: error.message, target, link });
      continue;
    }
    const enrolled = fs.lstatSync(link);
    resources.cleanup(`owned ${kind} unlink only`, () => {
      const current = fs.lstatSync(link);
      assert.equal(current.dev, enrolled.dev); assert.equal(current.ino, enrolled.ino);
      if (kind === 'junction') { assert(current.isSymbolicLink()); fs.rmdirSync(link); }
      else { assert(kind === 'hardlink' ? current.isFile() && current.nlink === 2 : current.isSymbolicLink()); fs.unlinkSync(link); }
      assert.equal(fs.readFileSync(targetFile, 'utf8'), 'W04 synthetic target unchanged');
      return { path: link, removedLinkOnly: true, targetUnchanged: true };
    }, 40);
    if (kind === 'hardlink') {
      const targetStat = fs.statSync(targetFile);
      assert.equal(enrolled.ino, targetStat.ino); assert.equal(enrolled.dev, targetStat.dev); assert.equal(enrolled.nlink, 2);
      rows.push({ kind, status: 'passed', capabilityOnly: true, nlink: enrolled.nlink, productBoundary: 'not-started; not a symlink substitute' });
    } else {
      assert(enrolled.isSymbolicLink()); assert.equal(fs.realpathSync.native(link), fs.realpathSync.native(target));
      const query = spawnSync('fsutil.exe', ['reparsepoint', 'query', link], { encoding: 'utf8', windowsHide: true });
      const tag = kind === 'junction' ? 'a0000003' : 'a000000c';
      assert.equal(query.status, 0, 'native reparse-tag inspection required');
      assert(query.stdout.toLowerCase().includes(tag), 'real native link kind must match its own result');
      rows.push({ kind, status: 'passed', capabilityOnly: true, nativeReparseTag: '0x' + tag, query: query.stdout,
        productBoundary: 'not-started; capability result only' });
    }
  }
  console.log('W04_CAPABILITIES ' + JSON.stringify({ scratch, rows, nativeSymlinkReady: rows.slice(0, 2).every(row => row.status === 'passed') }));
  if (rows.slice(0, 2).some(row => row.status !== 'passed')) throw Object.assign(new Error('current ordinary token cannot create/verify required real file and directory symlinks'), { code: 'W04_SYMLINK_CAPABILITY_BLOCKED' });
} catch (error) { primaryError = error; console.error(error); process.exitCode = 1; }
finally { await resources.finish(primaryError); }
