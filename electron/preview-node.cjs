'use strict';

const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const { check, checkPath, previewSystemEnv, samePath } = require('./preview-mode.cjs');
const { buildPreviewBackendEnv } = require('./backend-env');

const HOST = '127.0.0.1';
const ACL_SCRIPT = '157f9077bc30dc64c93f55cc2307888e2ec44ec4ee5bbc2e18677ce4bd39b7fd';
function denied() {
  throw Object.assign(new Error('WP0 blocked an unapproved capability'), { code: 'WP0_DENIED' });
}
let installed = false;

function installNodeGuard(preview, { onListen, onClosed } = {}) {
  check(!installed, 'duplicate network guard');
  installed = true;
  const backend = typeof onListen === 'function';
  const cp = require('node:child_process');
  const net = require('node:net');
  const http = require('node:http');
  const https = require('node:https');
  const tls = require('node:tls');
  const dns = require('node:dns');
  const dgram = require('node:dgram');
  const http2 = require('node:http2');
  const workers = require('node:worker_threads');
  const rawFork = cp.fork;
  const rawExec = cp.execFileSync;
  const rawRequest = http.request;
  const rawConnect = net.Socket.prototype.connect;
  const rawListen = net.Server.prototype.listen;
  let port = null;
  let forked = false;
  let listening = false;
  let bindingLoopback = false;
  let bootstrapRequest = false;
  const activeRequests = new Set();

  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (!bootstrapRequest || !options || typeof options !== 'object' || options.path
      || options.host !== HOST || Number(options.port) !== port) denied();
    return rawConnect.apply(this, args);
  };
  net.Server.prototype.listen = function (...args) {
    if (!backend || listening || args.length !== 3 || (args[0] !== 0 && args[0] !== '0')
      || args[1] !== HOST || typeof args[2] !== 'function') denied();
    listening = true;
    this.once('listening', () => {
      const address = this.address();
      check(address && address.address === HOST && Number.isInteger(address.port) && address.port > 0, 'invalid backend listener');
      onListen(address.port);
    });
    if (onClosed) this.once('close', onClosed);
    bindingLoopback = true;
    try { return rawListen.call(this, 0, HOST, args[2]); }
    finally { bindingLoopback = false; }
  };

  http.request = http.get = https.request = https.get = tls.connect = http2.connect = denied;
  net.connect = net.createConnection = function (...args) {
    if (!bootstrapRequest) denied();
    return new net.Socket().connect(...args);
  };
  dgram.createSocket = dgram.Socket.prototype.bind = dgram.Socket.prototype.connect = dgram.Socket.prototype.send = denied;
  for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(api)) {
      if (/^(?:lookup|resolve|reverse|setServers)/.test(key) && typeof api[key] === 'function') api[key] = denied;
    }
  }
  // net.Server.listen uses dns.lookup even for a literal. Resolve just its
  // synchronous, scoped bind call without calling the system resolver.
  dns.lookup = (host, options, callback) => {
    if (!bindingLoopback || host !== HOST || options?.all !== true || typeof callback !== 'function') denied();
    queueMicrotask(() => callback(null, [{ address: HOST, family: 4 }]));
  };
  globalThis.fetch = async () => denied();
  globalThis.WebSocket = denied;
  workers.Worker = denied;
  for (const name of ['spawn','spawnSync','fork','exec','execSync','execFile']) cp[name] = denied;

  const powershell = path.join(preview.systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  cp.execFileSync = function (file, args, options) {
    const dest = options?.env?.ANJUAN_PRIVATE_KEY_FILE;
    if (file !== powershell || !Array.isArray(args) || args.length !== 4 || args[0] !== '-NoProfile'
      || args[1] !== '-NonInteractive' || args[2] !== '-EncodedCommand' || typeof args[3] !== 'string'
      || args[3].length > 8192 || createHash('sha256').update(Buffer.from(args[3], 'base64')).digest('hex') !== ACL_SCRIPT
      || typeof dest !== 'string') denied();
    const name = path.basename(dest);
    const folder = path.dirname(dest);
    const keyFile = samePath(folder, preview.dataDir) && /^(?:secret\.key|\.secret\.key\.tmp-[0-9a-f]{16})$/.test(name);
    const configFile = !backend && samePath(folder, preview.userData) && /^\.config-[0-9a-f-]{36}\.tmp$/.test(name);
    if (!keyFile && !configFile) denied();
    checkPath(powershell, false, { systemBinary: true });
    checkPath(folder, true);
    checkPath(dest, false);
    return rawExec(powershell, args, {
      env: { ...previewSystemEnv(preview), ANJUAN_PRIVATE_KEY_FILE: dest, PSModulePath: path.join(path.dirname(powershell), 'Modules') },
      encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore','pipe','pipe'],
    });
  };
  syncBuiltinESMExports();

  function revoke() {
    port = null;
    for (const req of activeRequests) req.destroy();
  }

  function requestBootstrap(options, callback) {
    check(!backend && port && options.hostname === HOST && options.port === port, 'untrusted bootstrap endpoint');
    check((options.method === 'GET' && options.path === '/api/bootstrap/status')
      || (options.method === 'POST' && options.path === '/api/bootstrap/initialize'), 'unapproved bootstrap route');
    bootstrapRequest = true;
    try {
      const req = rawRequest({ hostname: HOST, port, path: options.path, method: options.method, headers: options.headers, agent: false }, callback);
      activeRequests.add(req);
      req.once('close', () => activeRequests.delete(req));
      return req;
    } finally {
      bootstrapRequest = false;
    }
  }

  function startBackend(key, onChild, onFailure) {
    check(!backend && !forked, 'unexpected preview fork');
    forked = true;
    const nonce = randomBytes(16).toString('hex');
    const entry = path.join(preview.appRoot, 'electron/preview-backend.cjs');
    const child = rawFork(entry, [], {
      env: buildPreviewBackendEnv(preview, nonce), execPath: process.execPath, cwd: preview.appRoot,
      execArgv: [], windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'],
    });
    onChild(child);
    return new Promise((resolve, reject) => {
      let state = 'starting';
      const timer = setTimeout(() => fail('backend readiness timeout'), 15000);
      const fail = reason => {
        if (state === 'failed') return;
        state = 'failed';
        clearTimeout(timer);
        revoke();
        reject(new Error('WP0: ' + reason));
        onFailure();
      };
      child.once('exit', () => fail('backend exited'));
      child.once('disconnect', () => fail('backend disconnected'));
      child.once('error', () => fail('backend error'));
      child.on('message', message => {
        if (state === 'starting' && message?.type === 'anjuan:preview-guard-ready' && message.nonce === nonce) {
          state = 'guarded';
        } else if (state === 'guarded' && message?.type === 'anjuan:preview-listening' && message.nonce === nonce
          && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
          state = 'authenticating';
          port = message.port;
          child.send({ type: 'anjuan:bootstrap-capability', key, legacy: null }, error => { if (error) fail('bootstrap IPC failed'); });
        } else if (state === 'authenticating' && message?.type === 'anjuan:bootstrap-ready' && message.ok === true) {
          state = 'ready';
          clearTimeout(timer);
          resolve(port);
        } else if (state !== 'failed') {
          fail('unexpected backend readiness message');
        }
      });
    });
  }

  return Object.freeze({ requestBootstrap, startBackend, revoke });
}

module.exports = { installNodeGuard, denied, HOST };
