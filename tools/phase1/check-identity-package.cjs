'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveRunRoot } = require('./w0-sqlite-probe.cjs');
const root = resolveRunRoot();
const config = JSON.parse(fs.readFileSync(path.join(root, 'w0-windows.json'), 'utf8'));
assert.equal(path.dirname(config.directories.output), root);
const packageRoot = path.join(config.directories.output, 'win-unpacked');
const appRoot = path.join(packageRoot, 'resources/app');
const executable = path.join(packageRoot, config.productName + '.exe');
const pe = fs.readFileSync(executable);
const peOffset = pe.readUInt32LE(0x3c);
assert.equal(pe.toString('ascii', peOffset, peOffset + 4), 'PE\0\0');
assert.equal(pe.readUInt16LE(peOffset + 4), 0x8664, 'Windows x64 PE is required');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const required = ['server.js', 'src/db.js', 'src/middleware/auth.js', 'src/routes/auth.js', 'src/routes/users.js',
  'src/lib/identity-service.js', 'src/lib/identity-bootstrap.js', 'src/lib/local-migrations.js', 'src/local-migrations/001_identity.sql',
  'src/lib/secret-box.js', 'src/lib/private-key-file.js',
  'electron/main.js', 'electron/backend-env.js', 'electron/identity-backup.cjs', 'electron/preload.js', 'electron/onboarding.js', 'electron/onboarding.html',
  'public/login.html', 'public/users.html', 'public/js/users.js', 'public/js/password-policy.js'];
const source = path.resolve(__dirname, '../..');
const manifest = required.map(file => {
  const packaged = fs.readFileSync(path.join(appRoot, file));
  assert.equal(sha(packaged), sha(fs.readFileSync(path.join(source, file))), `Packaged source differs: ${file}`);
  return { file, bytes: packaged.length, sha256: sha(packaged) };
});
function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'Unexpected package reparse point');
    if (entry.isDirectory()) inspect(file);
    else assert(!/^(?:\.env|secret\.key)$|\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/.test(entry.name), 'Unexpected private/runtime data in package');
  }
}
inspect(appRoot);
const code = `const {createRequire}=require('node:module'); const req=createRequire(${JSON.stringify(path.join(appRoot, 'package.json'))}); console.log(JSON.stringify(req('./tools/phase1/w0-sqlite-probe.cjs').runSQLiteProbe(${JSON.stringify(root)},'phase1-packaged-electron-node')));`;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_OPTIONS;
const native = spawnSync(executable, ['-e', code], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
assert.equal(native.status, 0, native.stderr);
const nativeResult = JSON.parse(native.stdout.trim());
assert(nativeResult.nativeModules.every(file => file.startsWith(appRoot + path.sep)));
const result = { architecture: 'Windows x64', executableSha256: sha(pe), sourceManifest: manifest, sourceMatches: true, privateRuntimeDataAbsent: true, nativeResult, formalInstaller: false, published: false };
fs.writeFileSync(path.join(root, 'phase1-package-check.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ packagedSources: manifest.length, sourceMatches: true, architecture: 'x64', sqliteLoadedFromPackage: true }));
