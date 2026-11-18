'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { shouldRedirectTestUserData, TEST_USERDATA_ACK_SWITCH } = require('./backend-env');

const SWITCH = 'anjian-preview';
const SEAL = 'electron/preview-seal.json';
const MARKER = '.anjuan-wp0.json';
const AUTOMATION = 'wp0-automation';
const USER = 'wp0-user-preview';
const BOOT_FILES = [
  'electron/main.js', 'electron/backend-env.js', 'electron/preview-mode.cjs',
  'electron/preview-node.cjs', 'electron/preview-session.cjs', 'electron/preview-backend.cjs',
  'electron/preload.js', 'electron/onboarding.html', 'electron/onboarding.js', 'electron/updater.js',
  'public/js/password-policy.js', 'public/assets/anjian-icon.png', 'server.js',
  'src/lib/private-key-file.js', 'src/lib/secret-box.js',
];
const idPattern = /^[0-9a-f]{32}$/;

function check(condition, reason) {
  if (!condition) throw new Error('WP0: ' + reason);
}

function samePath(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function checkPath(file, directory, { systemBinary = false } = {}) {
  check(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file
    && /^[a-z]:\\[^:]*$/i.test(file) && !file.split('\\').some(part => /[. ]$/.test(part)), 'nonlocal path');
  const st = fs.lstatSync(file);
  check(!st.isSymbolicLink() && (directory ? st.isDirectory() : st.isFile() && (systemBinary || st.nlink === 1))
    && samePath(fs.realpathSync.native(file), file), 'linked or unexpected path');
  return st;
}

function readJson(file) {
  check(checkPath(file, false).size <= 65536, 'oversized metadata');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha(file) {
  checkPath(file, false);
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function inspectData(directory) {
  checkPath(directory, true);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inspectData(file);
    else checkPath(file, false);
  }
}

function readPreviewConfig(preview) {
  checkPath(preview.userData, true);
  const file = path.join(preview.userData, 'config.json');
  let cfg;
  try { cfg = readJson(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    check(fs.readdirSync(preview.dataDir).length === 0, 'unclaimed data directory');
    return null;
  }
  check(cfg && typeof cfg === 'object' && !Array.isArray(cfg) && cfg.dataDir === preview.dataDir
    && (cfg.identityVersion === 1 && Object.keys(cfg).sort().join(',') === 'dataDir,identityVersion'
      || cfg.identityVersion === 0 && cfg.bootstrapPending === true
      && Object.keys(cfg).sort().join(',') === 'bootstrapPending,dataDir,identityVersion'), 'untrusted preview configuration');
  if (cfg.identityVersion === 1) checkPath(path.join(preview.dataDir, 'anjian.db'), false);
  return cfg;
}

function validateSealedDirectory(appRoot, root, runId, { forWindow = false } = {}) {
  check(require(path.join(appRoot, 'package.json')).anjuanPreviewCandidate === true, 'not a preview candidate');
  const seal = readJson(path.join(appRoot, SEAL));
  check(seal.version === 1 && seal.electron === '43.8.1' && idPattern.test(seal.runId)
    && seal.runId === runId && seal.root === root, 'preview seal mismatch');
  check(seal.purpose === (forWindow ? USER : AUTOMATION) && seal.gui === forWindow, 'preview purpose or GUI gate mismatch');
  check(Object.keys(seal.files || {}).sort().join('\n') === [...BOOT_FILES].sort().join('\n'), 'incomplete source seal');
  for (const name of BOOT_FILES) check(sha(path.join(appRoot, name)) === seal.files[name], 'source seal mismatch: ' + name);
  checkPath(root, true);
  check(!appRoot.toLowerCase().startsWith(root.toLowerCase() + path.sep)
    && !root.toLowerCase().startsWith(appRoot.toLowerCase() + path.sep)
    && !samePath(root, appRoot), 'package and data overlap');
  const marker = readJson(path.join(root, MARKER));
  check(Object.keys(marker).sort().join(',') === 'purpose,root,runId,version'
    && marker.version === 1 && marker.root === root && marker.runId === runId && marker.purpose === seal.purpose,
    'preview marker mismatch');
  const userData = path.join(root, 'user');
  const dataDir = path.join(root, 'data');
  const sessionData = path.join(root, 'session');
  const temp = path.join(root, 'tmp');
  for (const dir of [userData, sessionData, temp]) checkPath(dir, true);
  inspectData(dataDir);
  checkPath(seal.systemRoot, true);
  checkPath(path.join(seal.systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), false, { systemBinary: true });
  const preview = Object.freeze({ appRoot, root, runId, purpose: seal.purpose, gui: seal.gui, userData, dataDir, sessionData, temp,
    systemRoot: seal.systemRoot });
  readPreviewConfig(preview);
  return preview;
}

function resolvePreviewLaunch({ appRoot, app, env, argv, forWindow = true, versions = process.versions }) {
  const candidate = require(path.join(appRoot, 'package.json')).anjuanPreviewCandidate === true;
  const hasSwitch = name => app.commandLine.hasSwitch(name);
  if (!candidate && !fs.existsSync(path.join(appRoot, SEAL)) && env.ANJIAN_PREVIEW === undefined
    && env.ANJIAN_PREVIEW_RUN_ID === undefined && !hasSwitch(SWITCH)) return null;
  check(candidate && app.isPackaged && process.platform === 'win32' && process.arch === 'x64'
    && versions.electron === '43.8.1', 'unapproved runtime');
  check(shouldRedirectTestUserData(env, hasSwitch) && env.ANJIAN_PREVIEW === '1' && hasSwitch(SWITCH), 'preview requires both launch gates');
  check(argv.length === 3 && argv.slice(1).sort().join(',') === ['--' + SWITCH, '--' + TEST_USERDATA_ACK_SWITCH].sort().join(','),
    'unexpected arguments (debugging is forbidden)');
  for (const name of ['remote-debugging-port','remote-debugging-pipe','inspect','inspect-brk','no-sandbox','disable-web-security']) {
    check(!hasSwitch(name), 'incompatible runtime switch');
  }
  check(!Object.keys(env).some(k => /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ASAR|ELECTRON_EXTRA_LAUNCH_ARGS|ANJIAN_UNSAFE_NO_AUTH)$/i.test(k) && env[k]),
    'incompatible launch environment');
  return validateSealedDirectory(appRoot, env.ANJIAN_TEST_USERDATA, env.ANJIAN_PREVIEW_RUN_ID, { forWindow });
}

function previewSystemEnv(preview) {
  const system32 = path.join(preview.systemRoot, 'System32');
  return {
    SystemRoot: preview.systemRoot, WINDIR: preview.systemRoot, SystemDrive: path.parse(preview.systemRoot).root.slice(0, 2),
    PATH: system32, ComSpec: path.join(system32, 'cmd.exe'),
    USERPROFILE: preview.userData, HOME: preview.userData, APPDATA: preview.userData, LOCALAPPDATA: preview.userData,
    TEMP: preview.temp, TMP: preview.temp,
  };
}

module.exports = { SWITCH, SEAL, MARKER, AUTOMATION, USER, BOOT_FILES, check, checkPath, samePath, sha,
  resolvePreviewLaunch, validateSealedDirectory, readPreviewConfig, previewSystemEnv };
