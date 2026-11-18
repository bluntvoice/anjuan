// Electron 主进程：把现有 Express + better-sqlite3 后端包成桌面 App，后端代码零改动。
//
// 进程模型：主进程 fork 一个 Node 子进程跑 server.js（监听 OS 分配的随机端口），
// 主窗口 loadURL('http://127.0.0.1:<port>')。后端生命周期与 renderer 解耦，崩溃隔离。
//
// 首启检测：读 userData/config.json
//   未配置 → 引导窗口（选数据目录 / 设密码 / 可选填 API key）→ 写 config.json → 启动
//   已配置 → 注入 env → fork server.js → 健康检查 → 主窗口
const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, shell } = electron;
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const IS_DEV = !app.isPackaged;
const APP_ROOT = IS_DEV ? path.resolve(__dirname, '..') : path.join(process.resourcesPath, 'app');
const { resolvePreviewLaunch, readPreviewConfig, previewSystemEnv } = require('./preview-mode.cjs');
let preview, previewNode, previewSession;
try {
  preview = resolvePreviewLaunch({ appRoot: APP_ROOT, app, env: process.env, argv: process.argv });
  if (preview) {
    // Install before application imports capture networking, updater or spawn APIs.
    previewNode = require('./preview-node.cjs').installNodeGuard(preview);
    previewSession = require('./preview-session.cjs').createSessionGuard(APP_ROOT);
    previewSession.installElectron(electron);
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previewSystemEnv(preview));
    app.setPath('userData', preview.userData);
    app.setPath('sessionData', preview.sessionData);
    for (const name of ['disable-background-networking','disable-quic','no-proxy-server']) app.commandLine.appendSwitch(name);
    app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
  }
} catch {
  console.error('WP0: preview startup rejected');
  app.exit(1);
  return;
}
const { fork } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createIdentityBackup } = require('./identity-backup.cjs');
const { assertDataPaths } = require('../src/lib/windows-data-paths.cjs');
const { verifyPassword, parsePasswordHash } = require('../src/lib/password-hash.cjs');
const http = require('node:http');
const initAutoUpdater = preview ? null : require('./updater').initAutoUpdater;
const { buildBackendEnv, shouldRedirectTestUserData } = require('./backend-env');
const { shouldPreventClose } = require('./window-policy');

// dev 环境（未签名）禁用 sandbox，避免 macOS "Operation not permitted" 刷屏。
// 打包发版后走正规签名 + sandbox；dev 只是绕过本机权限限制。
if (!app.isPackaged) app.commandLine.appendSwitch('no-sandbox');

// 仅测试用 userData 隔离开关：打包冒烟需要验证「默认 disabled / 引导流程 / 首启」
// 等行为，但绝不能碰开发者本机真实的 userData/config.json 与其指向的真实数据目录
// （里面可能是真实案件夹）。ANJIAN_TEST_USERDATA 未设置时行为与此前完全一致
// （app.getPath('userData') 走 Electron 默认规则）；只有显式设置这个环境变量、
// 指向一个调用方自建的临时目录时，才会覆盖 userData 路径——必须在 app 触碰任何
// 路径之前调用 app.setPath('userData', ...)，所以紧跟在文件顶部。
//
// 单独一个环境变量不够：任何本地非特权进程都能
// `launchctl setenv ANJIAN_TEST_USERDATA <攻击者选定的路径>`，且对之后启动的
// 全部 GUI 应用生效（不需要提权）——生产 DMG 若只认这一个变量，等于给了本机
// 任意进程一个不需要提权就能重定向 config.json（存 passHash 与 dataDir）读取
// 位置的开关：攻击者可以预置自己已知的凭据，再拿受害者真实 dataDir 去打回环
// API。command-line switch 不存在这个问题——Chromium/Electron 的命令行参数
// 只能通过启动这个进程时的 argv 传入，`launchctl setenv` 只影响环境变量继承，
// 不能给已安装应用的后续启动注入 argv（不经过修改 .app 本体或改变启动方式）。
// 这里要求两者同时出现才生效：env 变量给出目标路径，argv 开关充当"这次启动
// 确实是调用方主动构造的测试调用"的凭证，环境变量单独出现时静默忽略（保留
// 默认行为，不报错——沿用之前"未设置等价不生效"的调用惯例，只是把触发条件
// 从"设置了这一个变量"收紧成"两者都在"）。判断逻辑本身抽到 ./backend-env.js
// （不 require('electron')，可以在裸 node 下单测——见
// tools/test-electron-backend-env.js），这里只是把真实的 app.commandLine.hasSwitch
// 接进去。
const isolatedTestRun = shouldRedirectTestUserData(process.env, (name) => app.commandLine.hasSwitch(name));
if (isolatedTestRun) {
  app.setPath('userData', process.env.ANJIAN_TEST_USERDATA);
}

let mainWindow = null;
let backendProc = null;
let quitting = false;
let backendBootstrap = null;
let selectedDataDir = null;
let initializationRunning = false;

// ── 配置读写（userData/config.json）─────────────────────────────────
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  if (preview) return readPreviewConfig(preview);
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

const { atomicJson } = require('./atomic-json.cjs');
function writeConfig(cfg) { atomicJson(configPath(), cfg); }
function backendRequest(route, body) {
  if (!backendBootstrap) return Promise.reject(new Error('后端尚未就绪'));
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = preview ? previewNode.requestBootstrap : http.request;
    const req = request({ hostname: '127.0.0.1', port: backendBootstrap.port, path: '/api' + route,
      method: data ? 'POST' : 'GET', headers: { 'X-Anjuan-Bootstrap': backendBootstrap.key,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
      let response = ''; res.on('data', chunk => { response += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(response);
          if (res.statusCode >= 400) reject(new Error(result.error || '初始化请求失败')); else resolve(result);
        } catch { reject(new Error('初始化响应无效')); }
      });
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('初始化请求超时')));
    if (data) req.write(data); req.end();
  });
}

// ── 选一个空闲端口 ──────────────────────────────────────────────────
// 不用 PORT=0：server.js 打印的是 env PORT 而非 server.address().port，
// PORT=0 时会打印 ":0" 导致主进程拿不到真实端口。预选一个空闲端口传进去即可（后端零改动）。
const net = require('node:net');
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── fork 后端子进程 ─────────────────────────────────────────────────
// server.js 监听 PORT，stdout 会打印 "anjian listening on :<port>"。
async function startBackend(config) {
  assertDataPaths({ dataDir: config.dataDir, userData: app.getPath('userData') });
  if (preview) {
    const checked = readPreviewConfig(preview);
    if (!checked || config.dataDir !== checked.dataDir) throw new Error('WP0: untrusted backend config');
    const key = crypto.randomBytes(32).toString('hex');
    const port = await previewNode.startBackend(key, child => {
      backendProc = child;
      child.stdout.resume();
      child.stderr.resume();
    }, stopPreview);
    backendBootstrap = { key, port };
    return port;
  }
  const port = await pickFreePort();
  const key = crypto.randomBytes(32).toString('hex');
  const env = buildBackendEnv({ baseEnv: process.env, config, port });
  return new Promise((resolve, reject) => {
    const proc = fork(path.join(APP_ROOT, 'server.js'), [], {
      env,
      cwd: APP_ROOT,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
    });
    backendProc = proc;
    backendBootstrap = { key, port };
    const legacy = config.user && parsePasswordHash(config.passHash) ? { user: config.user, passHash: config.passHash } : null;
    const authorityReady = new Promise((ready, fail) => {
      const timer = setTimeout(() => fail(new Error('可信初始化通道超时')), 15000);
      proc.on('message', message => {
        if (message?.type !== 'anjuan:bootstrap-ready') return;
        clearTimeout(timer);
        if (message.ok) ready(); else fail(new Error('可信初始化通道未建立'));
      });
      proc.once('exit', () => { clearTimeout(timer); fail(new Error('初始化期间后端退出')); });
    });
    authorityReady.catch(reject);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (IS_DEV) process.stdout.write(text);
    });
    proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[backend] ${chunk}`);
    });
    proc.on('exit', (code) => {
      if (backendProc === proc) backendProc = null;
      reject(new Error(`后端退出（code ${code}）`));
    });

    // 轮询 /healthz 直到就绪（最多等 15 秒——首启要跑 migration + 节假日装载）
    const waitReady = async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) throw new Error('后端未能启动，原配置已保留');
        if (await healthzOk(port)) {
          proc.send({ type: 'anjuan:bootstrap-capability', key, legacy });
          await authorityReady;
          return resolve(port);
        }
        await sleep(300);
      }
      reject(new Error('后端健康检查超时（15s）'));
    };
    waitReady().catch(reject);
  });
}

function stopPreview() {
  previewSession.revoke();
  previewNode.revoke();
  backendBootstrap = null;
  if (backendProc && (backendProc.exitCode !== null || backendProc.signalCode !== null)) backendProc = null;
  if (!quitting) app.quit();
}

function healthzOk(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 主窗口 ──────────────────────────────────────────────────────────
function createMainWindow(port) {
  if (preview) previewSession.trustPort(port);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 390,
    title: '案卷',
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset',
    }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      ...(preview && { sandbox: true, devTools: false, webviewTag: false }),
    },
  });

  if (preview) previewSession.installContents(mainWindow.webContents);
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // ── 给 macOS 红绿灯让位（只住 Electron 侧，网页版一像素不动）────────────
  // titleBarStyle:'hiddenInset' 让网页内容顶到 y=0，而 nav.js 注入的 .topnav 也是
  // sticky top:0——结果红绿灯直接压在「案齐」logo 上。这里用 insertCSS 把顶栏左推 80px，
  // 并把顶栏空白处设为可拖拽窗口（交互元素逐类排除，否则点不动导航/按钮/下拉/输入框）。
  //
  // 🔴 必须每次 dom-ready 重注入：本应用是多页站（今日/案件/日历/费用…都是整页加载），
  // insertCSS 的作用域是当前文档，只注一次的话点一下导航样式就没了。
  // 补丁刻意不进 public/css/style.css——那会让浏览器访问的网页版也多出 80px 左边距。
  if (process.platform === 'darwin') {
    // !important 是必须的：style.css 的 `.topnav{padding: 0 var(--page-pad)}` 是**简写**，
    // 与注入规则同特异性（0,1,0），简写会把 padding-left 一并重置——实测不加就完全不生效。
    const TRAFFIC_LIGHT_CSS = '.topnav{padding-left:80px!important;-webkit-app-region:drag}'
      + '.topnav a,.topnav button,.topnav select,.topnav input{-webkit-app-region:no-drag}';
    mainWindow.webContents.on('dom-ready', () => {
      mainWindow.webContents.insertCSS(TRAFFIC_LIGHT_CSS);
    });
  }

  // 外链在系统浏览器打开，不抢 App 内导航
  if (!preview) {
    const backendOrigin = `http://127.0.0.1:${port}`;
    mainWindow.webContents.on('will-navigate', (event, url) => {
      try { if (new URL(url).origin !== backendOrigin) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (target.origin === backendOrigin) return { action: 'allow' };
        if (target.protocol === 'https:' || target.protocol === 'http:') shell.openExternal(url);
      } catch { /* Invalid and non-web external destinations remain denied. */ }
      return { action: 'deny' };
    });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('close', (event) => {
    if (shouldPreventClose(process.platform, quitting)) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // 打包后启动自动更新检查（dev 跳过）
  // The same explicit env + argv gate used for isolated userData also prevents
  // W0 unpacked probes from contacting the production update service.
  if (preview) return;
  if (!isolatedTestRun) initAutoUpdater(mainWindow);
}

// ── 引导窗口 ────────────────────────────────────────────────────────
function createOnboardingWindow() {
  onboardingWin = new BrowserWindow({
    width: 560,
    height: 620,
    resizable: false,
    title: '案卷 · 初始设置',
    minimizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      ...(preview && { sandbox: true, devTools: false, webviewTag: false }),
    },
  });
  const trustedURL = pathToFileURL(path.join(__dirname, 'onboarding.html')).href;
  if (preview) previewSession.installContents(onboardingWin.webContents);
  else {
    onboardingWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    onboardingWin.webContents.on('will-navigate', (event, url) => { if (url !== trustedURL) event.preventDefault(); });
  }
  onboardingWin.loadURL(trustedURL);
  onboardingWin.on('closed', () => {
    onboardingWin = null;
    // 引导没完成就关窗 = 放弃启动
    if (!mainWindow) app.quit();
  });
  return onboardingWin;
}

// ── IPC：引导页调用 ────────────────────────────────────────────────
// 选数据目录（原生文件夹选择器，renderer 无权直接调）
const DATA_DIR_NAME = '案卷数据';

function assertOnboardingSender(event) {
  const expected = pathToFileURL(path.join(__dirname, 'onboarding.html')).href;
  if (!onboardingWin || event.sender !== onboardingWin.webContents
    || event.senderFrame !== onboardingWin.webContents.mainFrame || event.senderFrame.url !== expected) {
    throw new Error('引导请求来源不正确');
  }
}
function onboardingContext() {
  const config = readConfig();
  if (!config) return { mode: 'fresh', dataDir: preview ? preview.dataDir : selectedDataDir };
  if (config.bootstrapPending === true && config.dataDir) return { mode: 'fresh', dataDir: config.dataDir, pending: true };
  if (config.user && parsePasswordHash(config.passHash)) return { mode: 'legacy', dataDir: config.dataDir, username: config.user };
  return { mode: 'blocked', message: '配置来源或旧凭据无法验证，请保留资料并核查迁移方案' };
}
ipcMain.handle('onboarding:context', event => { assertOnboardingSender(event); return onboardingContext(); });
ipcMain.handle('onboarding:chooseDir', async event => {
  assertOnboardingSender(event);
  if (readConfig()) throw new Error('已有配置的目录不能在初始化中改写');
  if (preview) return preview.dataDir;
  const result = await dialog.showOpenDialog(onboardingWin, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: isolatedTestRun ? app.getPath('userData') : path.join(app.getPath('home'), 'Documents', DATA_DIR_NAME),
  });
  if (result.canceled) return null;
  const picked = result.filePaths[0];
  selectedDataDir = path.basename(picked) === DATA_DIR_NAME ? picked : path.join(picked, DATA_DIR_NAME);
  return selectedDataDir;
});
let onboardingWin = null;
ipcMain.handle('onboarding:complete', async (event, input) => {
  assertOnboardingSender(event);
  if (initializationRunning) throw new Error('初始化正在进行，请等待结果');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['username','password','old_password','confirm_legacy'].includes(key))) throw new Error('初始化字段不正确');
  initializationRunning = true;
  try {
    const context = onboardingContext();
    if (context.mode === 'blocked') throw new Error(context.message);
    let config = readConfig();
    assertDataPaths({ dataDir: context.mode === 'legacy' ? config.dataDir : (context.pending || preview ? context.dataDir : selectedDataDir), userData: app.getPath('userData') });
    if (context.mode === 'legacy') {
      if (input.confirm_legacy !== true || typeof input.old_password !== 'string' || !verifyPassword(input.old_password, config.passHash)) {
        throw new Error('请确认旧程序已退出，并验证原账号密码');
      }
      const journalPath = path.join(app.getPath('userData'), 'identity-migration.json');
      let journal = null;
      try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch {}
      const configDigest = crypto.createHash('sha256').update(fs.readFileSync(configPath())).digest('hex');
      if (!journal || journal.dataDir !== config.dataDir || journal.configDigest !== configDigest) {
        const backup = await createIdentityBackup({ dataDir: config.dataDir, configPath: configPath() });
        journal = { dataDir: config.dataDir, configDigest, backup, status: 'backup-complete' };
        atomicJson(journalPath, journal);
      } else require('./identity-backup.cjs').verifyIdentityBackup(journal.backup);
    } else {
      const dataDir = context.pending || preview ? context.dataDir : selectedDataDir;
      if (!dataDir) throw new Error('请先通过文件夹选择器选择数据目录');
      if (!context.pending && fs.existsSync(path.join(dataDir, 'anjian.db'))) throw new Error('所选目录已有数据库，不能未经验证接管');
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error('数据根不能是重解析点');
      config = { dataDir, bootstrapPending: true, identityVersion: 0 };
      if (!context.pending) writeConfig(config);
    }
    const port = backendProc ? backendBootstrap.port : await startBackend(config);
    const status = await backendRequest('/bootstrap/status');
    if (!status.initialized) {
      if (status.legacy_required && !status.legacy_available) throw new Error('旧数据缺少可验证身份，停止初始化');
      await backendRequest('/bootstrap/initialize', context.mode === 'legacy'
        ? { old_password: input.old_password, confirm_legacy: true }
        : { username: input.username, password: input.password });
    }
    const cleaned = { ...config, identityVersion: 1 };
    delete cleaned.user; delete cleaned.passHash; delete cleaned.bootstrapPending;
    writeConfig(cleaned);
    backendProc.send({ type: 'anjuan:bootstrap-revoke' });
    backendBootstrap = null;
    createMainWindow(port);
    if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close();
    return { ok: true };
  } catch (error) {
    if (preview) stopPreview();
    throw error;
  } finally { initializationRunning = false; }
});
async function openInitialWindow() {
  const config = readConfig();
  if (!config || config.identityVersion !== 1) return createOnboardingWindow();
  try {
    const port = await startBackend(config);
    const status = await backendRequest('/bootstrap/status');
    if (!status.initialized) throw new Error('身份库未完成初始化，不能自动重建管理员');
    backendProc.send({ type: 'anjuan:bootstrap-revoke' });
    backendBootstrap = null;
    createMainWindow(port);
  } catch (error) {
    if (preview) stopPreview();
    else { dialog.showErrorBox('案卷启动失败', error.message || String(error)); app.quit(); }
  }
}

// ── App 生命周期 ────────────────────────────────────────────────────
// 单实例锁：防止多开导致端口/数据竞争
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (preview) previewSession.installSession(electron.session.defaultSession);
    return openInitialWindow();
  }).catch(() => preview ? stopPreview() : app.quit());

  // macOS 下关掉所有窗口不退出（dock 常驻）；其它平台退出
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (mainWindow && process.platform === 'darwin') mainWindow.show();
    else if (BrowserWindow.getAllWindows().length === 0 && !quitting) openInitialWindow();
  });

  // 退出时 kill 后端子进程（否则成为孤儿进程占着端口）
  app.on('before-quit', event => {
    if (preview) { previewSession.revoke(); previewNode.revoke(); }
    if (quitting || !backendProc) { quitting = true; return; }
    event.preventDefault(); quitting = true;
    const owned = backendProc;
    const timer = setTimeout(() => { if (owned.exitCode === null) owned.kill(); }, 10000);
    owned.once('exit', code => {
      clearTimeout(timer); backendProc = null;
      console.log(`anjuan backend stopped (code=${code})`);
      app.quit();
    });
    if (owned.connected) owned.send({ type: 'anjuan:shutdown' }); else owned.kill();
  });
}
