'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check } = require('./preview-mode.cjs');
const { denied, HOST } = require('./preview-node.cjs');

function isBackendURL(raw, port) {
  if (!port || typeof raw !== 'string' || /[\\\s]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    const authority = HOST + ':' + port;
    return url.protocol === 'http:' && url.hostname === HOST && Number(url.port || '80') === port
      && !url.username && !url.password && raw.match(/^http:\/\/([^/?#]+)/)?.[1] === authority;
  } catch { return false; }
}

function lock(object, name) {
  if (typeof object?.[name] === 'function') Object.defineProperty(object, name, { value: denied, configurable: false, writable: false });
}

function createSessionGuard(appRoot) {
  const local = ['electron/onboarding.html', 'electron/onboarding.js', 'public/js/password-policy.js',
    'public/assets/anjian-icon.png'].map(file => pathToFileURL(path.join(appRoot, file)).href);
  const sessions = new WeakSet();
  const contents = new WeakSet();
  let port = null;
  let revoked = false;

  function allowRequest(details) {
    if (revoked || details.resourceType === 'webSocket') return false;
    return isBackendURL(details.url, port) || (details.method === 'GET' && local.includes(details.url));
  }

  function installSession(session) {
    if (sessions.has(session)) return;
    session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowRequest(details) }));
    // Electron replaces the previous listener on registration, including registration with null.
    lock(session.webRequest, 'onBeforeRequest');
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    for (const api of ['setPermissionRequestHandler','setPermissionCheckHandler','setDevicePermissionHandler',
      'setProxy','fetch','resolveHost','downloadURL','createInterruptedDownload']) lock(session, api);
    session.on('will-download', event => event.preventDefault());
    sessions.add(session);
  }

  function installContents(wc) {
    if (contents.has(wc)) return;
    installSession(wc.session);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    lock(wc, 'setWindowOpenHandler');
    lock(wc, 'downloadURL');
    lock(wc, 'openDevTools');
    const navigate = (event, url) => {
      const target = event.url ?? url;
      if (revoked || !(target === local[0] || isBackendURL(target, port))) event.preventDefault();
    };
    for (const name of ['will-frame-navigate','will-navigate','will-redirect']) wc.on(name, navigate);
    wc.on('will-attach-webview', event => event.preventDefault());
    contents.add(wc);
  }

  function installElectron({ app, net, shell, utilityProcess }) {
    for (const name of ['request','fetch','resolveHost']) lock(net, name);
    for (const name of ['openExternal','openPath','showItemInFolder','trashItem']) lock(shell, name);
    lock(utilityProcess, 'fork');
    function protect(action) {
      try { action(); } catch { revoked = true; port = null; app.exit(1); }
    }
    app.on('session-created', ses => protect(() => installSession(ses)));
    app.on('web-contents-created', (_event, wc) => protect(() => installContents(wc)));
  }

  return Object.freeze({ installElectron, installSession, installContents,
    trustPort(value) {
      check(!revoked && !port && Number.isInteger(value) && value > 0 && value <= 65535, 'cannot trust backend origin');
      port = value;
    },
    revoke() { revoked = true; port = null; },
  });
}

module.exports = { createSessionGuard, isBackendURL };
