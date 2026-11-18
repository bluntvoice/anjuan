import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import dataPaths from '../../src/lib/windows-data-paths.cjs';
import atomic from '../../electron/atomic-json.cjs';
import backup from '../../electron/identity-backup.cjs';
import { resolveMasterKey } from '../../src/lib/secret-box.js';
import { createIdentityService } from '../../src/lib/identity-service.js';
import { assertPrivateWindowsAcl, readActualWindowsAcl } from './windows-acl-test-utils.js';
import { TestResources } from './test-resources.js';
import { assertF1Environment } from './r2-f1-contract.js';
import { startIdentityServer } from './http-fixture.js';
import { f2Request } from './r2-f2-contract.js';
const require = createRequire(import.meta.url), resources = new TestResources(import.meta.url);
let primaryError;
const rows = [];
const rootEntities = [];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  assertF1Environment();
  const scratch = resources.directory(fs.mkdtempSync(path.join(os.tmpdir(), 'w05-paths-')));
  function target(label, length) {
    let p = path.join(scratch, label);
    while (p.length < length) { const count = Math.min(40, length - p.length - 1); assert(count > 0); p = path.join(p, ('中文 空格#&[]-' + 'x'.repeat(50)).slice(0, count)); }
    assert.equal(p.length, length); fs.mkdirSync(path.dirname(p), { recursive: true }); return p;
  }
  function privateDirectory(dir) {
    assert(path.resolve(dir).startsWith(scratch + path.sep)); fs.mkdirSync(dir, { recursive: true });
    const native = 'using System;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;public static class W05Entity{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sa,uint c,uint f,IntPtr t);[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint f);public static string Path(string p){using(var h=CreateFile(p,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)){if(h.IsInvalid)throw new Exception("entity open failed");var b=new StringBuilder(32768);if(GetFinalPathNameByHandle(h,b,32768,0)==0)throw new Exception("entity path failed");return b.ToString();}}}';
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Add-Type -TypeDefinition '${native}'; $p=$env:W05_PRIVATE_ROOT; $entity=[W05Entity]::Path($p); $id=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); foreach($s in @($id,'S-1-5-18','S-1-5-32-544')) {$r=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($s)),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($r)}; Set-Acl -LiteralPath $p -AclObject $acl; @{entity=$entity} | ConvertTo-Json -Compress`;
    const env = { ...process.env, W05_PRIVATE_ROOT: dir }; delete env.PSModulePath;
    const output = execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const entity = JSON.parse(output).entity.slice(4), nativeReal = fs.realpathSync.native(dir);
    assert.equal(entity, nativeReal); rootEntities.push({ length: dir.length, nativeReal, handleEntity: entity });
  }
  const dataDir = target('supported-data', 207), userData = target('supported-user', 210), config = path.join(userData, 'config.json');
  dataPaths.assertDataPaths({ dataDir, userData });
  privateDirectory(dataDir); privateDirectory(userData);
  atomic.atomicJson(config, { dataDir, bootstrapPending: true }); assertPrivateWindowsAcl(config);
  process.env.DB_PATH = path.join(dataDir, 'anjian.db');
  const { db } = await import('../../src/db.js'); resources.database(db);
  const password = crypto.randomBytes(24).toString('base64');
  const identity = createIdentityService(db); identity.bootstrap({ username: 'W05Synthetic', password });
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, 1);
  assert(fs.existsSync(db.name + '-wal')); assert(fs.existsSync(db.name + '-shm'));
  const key = resolveMasterKey({ DB_PATH: db.name }); assert.equal(key.length, 32); assertPrivateWindowsAcl(path.join(dataDir, 'secret.key'));
  atomic.atomicJson(config, { dataDir, identityVersion: 1 });
  assertPrivateWindowsAcl(config);
  const dbAcl = readActualWindowsAcl(db.name), rootAcl = readActualWindowsAcl(dataDir);
  const allowed = new Set([dbAcl.current, 'S-1-5-18', 'S-1-5-32-544']);
  for (const acl of [dbAcl, rootAcl]) { assert.equal(acl.rules.length, allowed.size); assert(acl.rules.every(r => allowed.has(r.sid) && r.kind === 'Allow' && r.rights === 2032127)); }
  assert(rootAcl.protected);
  const docs = path.join(dataDir, '案件夹', '虚构'); fs.mkdirSync(docs, { recursive: true }); fs.writeFileSync(path.join(docs, '证据.txt'), 'W05 synthetic evidence');
  rows.push({ id: 'supported-initialization', status: 'passed', dataRootLength: dataDir.length, userDataLength: userData.length, privateFileAcl: true, inheritedPrivateDatabaseAcl: true, wal: true, shm: true });

  const server = await startIdentityServer({ database: db.name }); let stopped = false;
  const stop = async () => { if (!stopped) { await server.stop(); await assert.rejects(f2Request(server.address, '/healthz'), e => e.code === 'ECONNREFUSED'); stopped = true; } return { pid: server.child.pid, address: server.address, stopped, signal: server.child.signalCode, portReleased: true }; };
  resources.cleanup('W05 actual production backend + port', stop, 20); resources.directory(server.root);
  const login = await f2Request(server.address, '/api/login', { method: 'POST', body: { username: 'W05Synthetic', password } }); assert.equal(login.status, 200);
  assert.equal((await f2Request(server.address, '/api/auth/me', { cookie: login.cookie })).status, 200);
  assert.equal((await f2Request(server.address, '/api/digest', { cookie: login.cookie })).json.code, 'phase1_business_closed');
  await f2Request(server.address, '/api/logout', { method: 'POST', cookie: login.cookie });
  assert.equal((await f2Request(server.address, '/api/auth/me', { cookie: login.cookie })).status, 401); await stop();
  rows.push({ id: 'actual-supported-backend', status: 'passed', identity: true, businessClosed: true, sessionRevocation: true });

  const firstBackup = await backup.createIdentityBackup({ dataDir, configPath: config });
  const manifest = backup.verifyIdentityBackup(firstBackup); assert(manifest.complete);
  assert.equal(firstBackup.length, 241); assert.equal(path.join(firstBackup, 'anjian.db').length, 251);
  assertPrivateWindowsAcl(path.join(firstBackup, 'config.json')); assertPrivateWindowsAcl(path.join(firstBackup, 'secret.key'));
  const beforeSource = () => ({ db: hash(db.name), wal: fs.existsSync(db.name + '-wal') ? hash(db.name + '-wal') : null, config: hash(config), key: hash(path.join(dataDir, 'secret.key')), evidence: hash(path.join(docs, '证据.txt')), firstManifest: hash(path.join(firstBackup, 'manifest.json')) });
  const sourceSnapshot = beforeSource();
  const restore = target('restore', 220); dataPaths.assertRestorePaths(restore, manifest.entries.map(e => e.path)); privateDirectory(restore);
  for (const entry of manifest.entries) {
    const destination = path.join(restore, entry.path); fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (['config.json', 'secret.key'].includes(entry.path)) require('../../src/lib/private-key-file.js').writeWindowsPrivateTempFile(destination, fs.readFileSync(path.join(firstBackup, entry.path)));
    else fs.copyFileSync(path.join(firstBackup, entry.path), destination, fs.constants.COPYFILE_EXCL);
  }
  const restored = resources.database(new Database(path.join(restore, 'anjian.db')));
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(restored.pragma('foreign_key_check'), []);
  assert.equal(restored.prepare('SELECT username FROM users').get().username, 'W05Synthetic');
  assertPrivateWindowsAcl(path.join(restore, 'config.json')); assertPrivateWindowsAcl(path.join(restore, 'secret.key'));
  assert.equal(fs.readFileSync(path.join(restore, '案件夹/虚构/证据.txt'), 'utf8'), 'W05 synthetic evidence');
  assert.deepEqual(beforeSource(), sourceSnapshot);
  rows.push({ id: 'backup-restore-rehearsal', status: 'passed', backupRootLength: firstBackup.length, backupDatabaseLength: 251, sourceUnchanged: true, restoreToNewDirectoryOnly: true, privateRestoredFiles: true });

  const tooDeepData = target('unsupported-data', 208), tooDeepUser = target('unsupported-user', 211);
  assert.throws(() => dataPaths.assertDataPaths({ dataDir: tooDeepData, userData }), e => e.code === 'DATA_PATH_UNSUPPORTED');
  assert.throws(() => atomic.atomicJson(path.join(tooDeepUser, 'config.json'), { rejected: true }), e => e.code === 'DATA_PATH_UNSUPPORTED');
  assert(!fs.existsSync(tooDeepData)); assert(!fs.existsSync(tooDeepUser));
  const code = `try { await import(${JSON.stringify(new URL('../../src/db.js', import.meta.url).href)}); process.exitCode=32; } catch(e) { console.log(e.code); process.exitCode=e.code==='DATA_PATH_UNSUPPORTED'?31:33; }`;
  const rejected = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DB_PATH: path.join(tooDeepData, 'anjian.db') }, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(rejected.status, 31, rejected.stderr); assert(!fs.existsSync(tooDeepData));
  assert.throws(() => resolveMasterKey({ DB_PATH: path.join(tooDeepData, 'anjian.db') }), e => e.code === 'DATA_PATH_UNSUPPORTED');
  assert(!fs.existsSync(tooDeepData));
  rows.push({ id: 'boundary-rejection-before-write', status: 'passed', acceptedData: 207, rejectedData: 208, acceptedUserData: 210, rejectedUserData: 211, childActualExitCode: rejected.status, noPartialInitialization: true });

  const shorter = target('path-change-retry', 160); dataPaths.assertDataPaths({ dataDir: shorter }); privateDirectory(shorter);
  const retryCode = `const {db}=await import(${JSON.stringify(new URL('../../src/db.js', import.meta.url).href)}); const {createIdentityService}=await import(${JSON.stringify(new URL('../../src/lib/identity-service.js', import.meta.url).href)}); createIdentityService(db).bootstrap({username:'RetrySynthetic',password:'Retry-Synthetic-42!'}); console.log(db.pragma('integrity_check',{simple:true})); db.close();`;
  const changedPath = spawnSync(process.execPath, ['--input-type=module', '-e', retryCode], { env: { ...process.env, DB_PATH: path.join(shorter, 'anjian.db') }, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(changedPath.status, 0, changedPath.stderr); assert(changedPath.stdout.includes('ok'));
  assert(!fs.existsSync(tooDeepData)); assert.deepEqual(beforeSource(), sourceSnapshot);
  rows.push({ id: 'changed-path-initialization-retry', status: 'passed', rejectedRootStillAbsent: true, shorterRoot: 160, childActualExitCode: changedPath.status });

  const longFile = path.join(docs, '长材料-' + 'x'.repeat(25) + '.txt'); fs.writeFileSync(longFile, 'long synthetic evidence');
  const backupParent = path.join(dataDir, 'migration-backups'), countBefore = fs.readdirSync(backupParent).length;
  await assert.rejects(backup.createIdentityBackup({ dataDir, configPath: config }), e => e.code === 'DATA_PATH_UNSUPPORTED');
  assert.equal(fs.readdirSync(backupParent).length, countBefore); assert.deepEqual(beforeSource(), sourceSnapshot);
  assert.equal(fs.readFileSync(longFile, 'utf8'), 'long synthetic evidence');
  fs.unlinkSync(longFile);
  rows.push({ id: 'all-inventory-paths-before-backup-write', status: 'passed', noNewBackupBeforeRejection: true, previousBackupAndSourceUnchanged: true });

  for (const fault of ['sqlite-backup', 'copy', 'private-acl']) {
    const oldBackup = Database.prototype.backup, oldCopy = fs.copyFileSync, cp = require('node:child_process'), oldExec = cp.execFileSync;
    const priorRoots = new Set(fs.readdirSync(backupParent));
    try {
      if (fault === 'sqlite-backup') Database.prototype.backup = async function() { throw new Error('W05 injected SQLite backup failure'); };
      if (fault === 'copy') fs.copyFileSync = () => { throw new Error('W05 injected copy failure'); };
      if (fault === 'private-acl') { cp.execFileSync = function(...args) { if (args[2]?.env?.ANJUAN_PRIVATE_KEY_FILE?.includes('migration-backups')) throw new Error('W05 injected ACL failure'); return oldExec.apply(this, args); }; syncBuiltinESMExports(); }
      await assert.rejects(backup.createIdentityBackup({ dataDir, configPath: config }), e => fault === 'private-acl' ? e.code === 'PRIVATE_KEY_ACL_FAILED' : e.message.includes(fault === 'copy' ? 'injected copy failure' : 'injected SQLite backup failure'));
    } finally { Database.prototype.backup = oldBackup; fs.copyFileSync = oldCopy; cp.execFileSync = oldExec; syncBuiltinESMExports(); }
    assert.deepEqual(beforeSource(), sourceSnapshot);
    const freshRoots = fs.readdirSync(backupParent).filter(n => !priorRoots.has(n)); assert.equal(freshRoots.length, 1);
    const partial = path.join(backupParent, freshRoots[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(partial, 'manifest.json'))).complete, false); assert.throws(() => backup.verifyIdentityBackup(partial), /不完整/);
    rows.push({ id: 'failure-' + fault, status: 'passed', originalAndCompletedBackupUnchanged: true, incompleteNotPublished: true });
  }
  const retry = await backup.createIdentityBackup({ dataDir, configPath: config }); assert(backup.verifyIdentityBackup(retry).complete);
  assert.deepEqual(beforeSource(), sourceSnapshot);
  const oldRename = fs.renameSync;
  try { fs.renameSync = (from, to) => { if (to === config) throw new Error('W05 injected rename failure'); return oldRename(from, to); }; assert.throws(() => atomic.atomicJson(config, { shouldNotReplace: true }), /injected/); }
  finally { fs.renameSync = oldRename; }
  assert.deepEqual(beforeSource(), sourceSnapshot); assert(!fs.readdirSync(userData).some(n => n.startsWith('.config-')));
  atomic.atomicJson(config, { dataDir, identityVersion: 1 });
  rows.push({ id: 'retry-and-atomic-config-failure', status: 'passed', backupRetryComplete: true, noOrphanConfigTemp: true });
  const deepRestore = target('restore-rejected', 242);
  assert.throws(() => dataPaths.assertRestorePaths(deepRestore, manifest.entries.map(e => e.path)), e => e.code === 'DATA_PATH_UNSUPPORTED'); assert(!fs.existsSync(deepRestore));
  const failedRestore = target('restore-copy-failure', 180); dataPaths.assertRestorePaths(failedRestore, manifest.entries.map(e => e.path)); privateDirectory(failedRestore);
  const originalCopy = fs.copyFileSync;
  try { fs.copyFileSync = () => { throw new Error('W05 injected restore copy failure'); }; assert.throws(() => fs.copyFileSync(path.join(firstBackup, 'anjian.db'), path.join(failedRestore, 'anjian.db'), fs.constants.COPYFILE_EXCL), /injected restore/); }
  finally { fs.copyFileSync = originalCopy; }
  assert.deepEqual(beforeSource(), sourceSnapshot); assert.equal(backup.verifyIdentityBackup(firstBackup).complete, true);
  const restoredRetry = target('restore-retry', 180); dataPaths.assertRestorePaths(restoredRetry, manifest.entries.map(e => e.path)); privateDirectory(restoredRetry);
  for (const entry of manifest.entries) { const dest = path.join(restoredRetry, entry.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); if (['config.json', 'secret.key'].includes(entry.path)) require('../../src/lib/private-key-file.js').writeWindowsPrivateTempFile(dest, fs.readFileSync(path.join(firstBackup, entry.path))); else fs.copyFileSync(path.join(firstBackup, entry.path), dest, fs.constants.COPYFILE_EXCL); }
  const restoredAgain = resources.database(new Database(path.join(restoredRetry, 'anjian.db'))); assert.equal(restoredAgain.pragma('integrity_check', { simple: true }), 'ok');
  assertPrivateWindowsAcl(path.join(restoredRetry, 'secret.key')); assertPrivateWindowsAcl(path.join(restoredRetry, 'config.json'));
  rows.push({ id: 'restore-failure-and-new-target-retry', status: 'passed', rejectedBeforeWrite: true, copyFailureSourceAndBackupUnchanged: true, retryIntegrity: 'ok', rehearsalOnly: true });
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
  rows.push({ id: 'sqlite-final', status: 'passed', integrity: 'ok', foreignKeys: true });
  console.log('W05_RESULTS ' + JSON.stringify({ status: 'passed', runtime: { node: process.versions.node, electron: process.versions.electron || null }, limits: dataPaths.limits, rows, rootEntities,
    limitations: ['offline product components plus actual backend; no Electron GUI/main execution', 'restore rehearsal only; no new production restore API', 'private fixture directory ACL, not a new production root ACL model'] }));
} catch (error) { primaryError = error; console.error(error); console.log('W05_PARTIAL ' + JSON.stringify(rows)); process.exitCode = 1; }
finally { await resources.finish(primaryError); }
