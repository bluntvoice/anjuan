'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, validateSealedDirectory } = require('./preview-mode.cjs');
const { buildPreviewBackendEnv } = require('./backend-env');
const { installNodeGuard } = require('./preview-node.cjs');

async function start() {
  const env = process.env;
  const nonce = env.ANJIAN_PREVIEW_NONCE;
  check(process.connected && process.platform === 'win32' && process.arch === 'x64'
    && process.versions.electron === '43.8.1' && process.argv.length === 2
    && !process.execArgv.length && /^[0-9a-f]{32}$/.test(nonce), 'untrusted backend entry');
  const appRoot = path.resolve(__dirname, '..');
  const preview = validateSealedDirectory(appRoot, env.ANJIAN_PREVIEW_ROOT, env.ANJIAN_PREVIEW_RUN_ID,
    { forWindow: env.ANJIAN_PREVIEW_GUI === '1' });
  const expected = buildPreviewBackendEnv(preview, nonce);
  for (const [name, value] of Object.entries(expected)) check(env[name] === value, 'backend environment mismatch: ' + name);
  // Windows may add variables to the child's environment. Keep only the verified entries.
  for (const name of Object.keys(env)) delete env[name];
  Object.assign(env, expected);
  process.once('disconnect', () => process.exit(1));
  installNodeGuard(preview, {
    onListen: port => process.send({ type: 'anjuan:preview-listening', nonce, port }),
    onClosed: () => { if (process.connected) process.send({ type: 'anjuan:preview-listener-closed', nonce }); },
  });
  process.send({ type: 'anjuan:preview-guard-ready', nonce });
  await import(pathToFileURL(path.join(appRoot, 'server.js')).href);
}

start().catch(error => {
  console.error(error.message?.startsWith('WP0:') ? error.message : 'WP0: guarded backend startup failed');
  process.exit(1);
});
