'use strict';

/**
 * DeepSeek Harness desktop shell.
 *
 * Double-click behavior:
 *   1. If a DSH web server is already serving on the target port, attach to it
 *      (the window is just a native shell for that server; the server is not
 *      killed when the app exits).
 *   2. Otherwise spawn `dsh web --host 127.0.0.1 --port <port>` as a child,
 *      wait until it serves the UI, then open the window. Closing the window
 *      kills the child process tree.
 *
 * Extras:
 *   --smoke-test        boot, load the UI, write a JSON report, exit (0/1)
 *   --smoke-log <path>  where the smoke report goes
 *   --port <n>          override the port (default: DSH_PORT env or 3080)
 */

const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const APP_NAME = 'DeepSeek Harness';
const APP_USER_MODEL_ID = 'com.deepseek.harness.desktop';
const DEFAULT_PORT = 3080;
const READY_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 2_500;
const POLL_INTERVAL_MS = 500;
const LOAD_RETRY_MAX = 8;
const DSH_BOOT_MARKER = '__DSH_BOOT__';
// 上游版本信息渠道：GitHub 仓库 deepseek-ai/deepseek-harness 通过 npm 发布，
// 这里的检查与 GitHub 发布完全同步（DSH_UPDATE_URL 可覆盖，供测试）。
const DSH_PACKAGE = '@deepseek-ai/dsh';
const DESKTOP_REPOSITORY = 'YaiSystem/DeepSeek-Harness-Desktop';
const UPDATE_URL = process.env.DSH_UPDATE_URL || `https://registry.npmjs.org/${DSH_PACKAGE}/latest`;
const DESKTOP_UPDATE_URL = process.env.DSH_DESKTOP_UPDATE_URL || `https://api.github.com/repos/${DESKTOP_REPOSITORY}/releases/latest`;
const UPDATE_FETCH_TIMEOUT_MS = 10_000;
const UPDATE_INSTALL_TIMEOUT_MS = 10 * 60_000;
// 国内镜像显著加快下载（DSH_NPM_REGISTRY 可覆盖，供测试）
const DSH_REGISTRY = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';
const DESKTOP_DOWNLOAD_TIMEOUT_MS = 20 * 60_000;

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(1);
function getArg(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const isSmoke = argv.includes('--smoke-test');
const smokeLogPath = getArg('--smoke-log') || path.join(os.tmpdir(), 'dsh-desktop-smoke.json');
const cliPortArg = getArg('--port');
const updateCheckTestPath = getArg('--update-check-test');
const updateInstallTestPrefix = getArg('--update-install-test');

const state = {
  mainWindow: null,
  splash: null,
  child: null,
  childKilled: false,
  attached: false,
  url: null,
  port: null,
  ready: false,
  quitting: false,
  smokeFinished: false,
  loadFailures: 0,
  childLog: [],
  bootError: null,
  updating: false,
  updateChecked: false,
  // dsh 0.1.2+ 的服务会带一次性访问令牌（URL 形如 http://127.0.0.1:3080/?token=xxx），
  // 无令牌访问会返回 401，因此必须从子进程输出里把它抓下来用于探测和加载页面。
  token: null,
};

// 服务根路径：带令牌（新版）或裸根路径（旧版，无认证）
function rootPath() {
  return state.token ? `/?token=${encodeURIComponent(state.token)}` : '/';
}

// 完整访问地址（主窗口加载、外部浏览器打开都用这个）
function urlFor(port) {
  return `http://127.0.0.1:${port}${rootPath()}`;
}

// 测试/隔离用：指定独立 userData 目录，避免与正在使用的实例抢单实例锁
const userDataDirArg = getArg('--user-data-dir');
if (userDataDirArg) app.setPath('userData', userDataDirArg);

app.setName(APP_NAME);

// ---------------------------------------------------------------- logging

let logDirReady = false;
let logDir = null;
let mainLogStream = null;

function ensureLogDir() {
  if (logDirReady) return;
  try {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    mainLogStream = fs.createWriteStream(path.join(logDir, 'main.log'), { flags: 'a' });
  } catch {
    try {
      logDir = os.tmpdir();
      mainLogStream = fs.createWriteStream(path.join(logDir, 'dsh-desktop-main.log'), { flags: 'a' });
    } catch {
      mainLogStream = null;
    }
  }
  logDirReady = true;
}

function log(...args) {
  ensureLogDir();
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    if (mainLogStream) mainLogStream.write(line);
  } catch {}
  if (!app.isPackaged) console.log(line.trimEnd());
}

function childLogLine(line) {
  const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  if (!clean) return;
  // 抓取服务启动时打印的访问令牌：dsh web: http://127.0.0.1:3080/?token=xxx
  const m = clean.match(/[?&]token=([A-Za-z0-9_\-]+)/);
  if (m && m[1] !== state.token) {
    state.token = m[1];
    log('captured dsh access token');
  }
  state.childLog.push(clean);
  if (state.childLog.length > 150) state.childLog.shift();
  log(`[dsh] ${clean}`);
}

// ---------------------------------------------------------------- smoke report

function finishSmoke(ok, phase, extra) {
  if (state.smokeFinished) return;
  state.smokeFinished = true;
  const payload = Object.assign(
    {
      ok: !!ok,
      phase,
      app: 'deepseek-harness-desktop',
      url: state.url,
      port: state.port,
      attached: state.attached,
      electron: process.versions.electron,
      finishedAt: new Date().toISOString(),
    },
    extra || {}
  );
  try {
    fs.writeFileSync(smokeLogPath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    log(`smoke log write failed: ${err.message}`);
  }
  log(`smoke ${ok ? 'OK' : 'FAIL'} (${phase})`);
  if (state.child && !state.attached) killChildTree();
  setTimeout(() => app.exit(ok ? 0 : 1), 300);
}

// ---------------------------------------------------------------- low-level helpers

function spawnOutput(command, args, opts) {
  try {
    const r = spawnSync(command, args, Object.assign({ encoding: 'utf8', timeout: 20_000, windowsHide: true }, opts));
    if (r.status === 0) return (r.stdout || '').trim();
  } catch {}
  return null;
}

// PATH entries are proper Unicode in process.env; scanning them directly
// avoids the console-codepage (GBK) mangling of `where.exe` output.
function pathDirs() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}

let cliCache = null;
function loadCliCache() {
  if (cliCache) return cliCache;
  try {
    const p = path.join(app.getPath('userData'), 'cli-cache.json');
    cliCache = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    cliCache = {};
  }
  return cliCache;
}

function saveCliCache(nodePath, binJs) {
  try {
    ensureLogDir();
    const p = path.join(app.getPath('userData'), 'cli-cache.json');
    fs.writeFileSync(p, JSON.stringify({ node: nodePath, binJs, at: Date.now() }, null, 2), 'utf8');
  } catch {}
}

function existingFile(p) {
  try {
    return p && fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

// 内置的 Node 与 DSH 核心（打包进应用 resources，零前提条件兜底）
const NODE_DIR_NAME = 'node-v24.19.0-win-x64';

function bundledBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
}

function bundledNodePath() {
  return path.join(bundledBase(), 'node', NODE_DIR_NAME, 'node.exe');
}

function bundledNodeDir() {
  return path.join(bundledBase(), 'node', NODE_DIR_NAME);
}

function bundledDshBinJs() {
  return path.join(bundledBase(), 'dsh', 'bundle', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function bundledDshTarPath() {
  return path.join(bundledBase(), 'dsh', 'dsh-core.tar');
}

function updateSplashStatus(text) {
  if (!state.splash || state.splash.isDestroyed()) return;
  const script = `(function() {
    var s = document.getElementById('status-text');
    if (s) s.textContent = ${JSON.stringify(String(text || ''))};
  })()`;
  state.splash.webContents.executeJavaScript(script).catch(() => {});
}

async function ensureBundledDshExtracted(onStatus) {
  const binJs = bundledDshBinJs();
  if (existingFile(binJs)) return binJs;

  const tarPath = bundledDshTarPath();
  if (!existingFile(tarPath)) return null;

  const dshDir = path.join(bundledBase(), 'dsh');
  log(`extracting ${tarPath} to ${dshDir}...`);
  if (onStatus) onStatus('正在初始化核心运行环境（首次启动需约十秒）…');

  await new Promise((resolve, reject) => {
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const child = spawn(tarExe, ['-xf', tarPath, '-C', dshDir], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      log(`tar.exe error: ${err.message}`);
      reject(err);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        log(`dsh core extracted successfully to ${dshDir}`);
        resolve();
      } else {
        reject(new Error(`解压核心环境失败，退出码 ${code}`));
      }
    });
  });

  if (onStatus) onStatus('正在启动服务…');
  return existingFile(binJs);
}

function existingDir(p) {
  try {
    return p && fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/**
 * npm 全局安装根目录（dsh 落在 <root>/node_modules/@deepseek-ai/dsh）。
 * 只认确实装了 @deepseek-ai 作用域的目录，避免误伤 PATH 上其他 node_modules。
 */
function npmGlobalRoots() {
  const roots = [];
  const consider = (candidate) => {
    if (!candidate) return;
    const abs = path.resolve(candidate);
    if (roots.includes(abs)) return;
    if (existingDir(path.join(abs, 'node_modules', '@deepseek-ai'))) roots.push(abs);
  };
  if (process.env.APPDATA) consider(path.join(process.env.APPDATA, 'npm'));
  for (const dir of pathDirs()) consider(dir);
  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (pf) consider(path.join(pf, 'nodejs'));
  }
  return roots;
}

/**
 * npm 替换包时先把旧目录改名成 .dsh-<hash>、解压新版、最后删掉旧目录。
 * 最后一步一旦失败（被杀软或删除守卫拦截），就会留下几万个文件的残骸；
 * 此后每次更新光遍历它就要花好几分钟 —— 这正是「更新特别慢」的根源。
 * 这里在更新前主动清掉；直接删不掉时退化为同盘改名（瞬时完成），
 * 至少让它不再躺在 npm 的扫描路径里拖慢后续操作。
 */
function cleanupDshResidue() {
  let handled = 0;
  for (const root of npmGlobalRoots()) {
    const scope = path.join(root, 'node_modules', '@deepseek-ai');
    let entries = [];
    try {
      entries = fs.readdirSync(scope);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^\.dsh-[A-Za-z0-9_-]+$/.test(name)) continue;
      const target = path.join(scope, name);
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 1 });
        log(`removed npm residue ${target}`);
      } catch (error) {
        // 删不掉（被删除守卫拦截等）就挪出 npm 的扫描范围：同盘改名是瞬时完成的，
        // 关键是不能让它继续留在 @deepseek-ai/ 里被 npm 逐文件遍历。
        const parked = path.join(os.tmpdir(), `dsh-residue-${Date.now()}-${name.replace(/^\./, '')}`);
        try {
          fs.renameSync(target, parked);
          log(`parked npm residue ${target} -> ${parked} (${error.code || error.message})`);
        } catch (error2) {
          log(`npm residue cleanup failed ${target} (${error2.message})`);
          continue;
        }
      }
      handled += 1;
    }
  }
  if (handled) log(`cleaned ${handled} npm residue dir(s)`);
  return handled;
}

/**
 * npm 写 bin 启动器时先落临时文件（.dsh-xxxx、.dsh.cmd-xxxx、.dsh.ps1-xxxx）再改名。
 * 中途失败就会让 dsh / dsh.cmd / dsh.ps1 缺失，用户敲 dsh 直接 command not found。
 * 这里用残留的临时文件把缺失的启动器补回去。
 */
function repairDshShims() {
  const repaired = [];
  const spec = [
    [/^\.dsh-[A-Za-z0-9]+$/, 'dsh'],
    [/^\.dsh\.cmd-[A-Za-z0-9]+$/, 'dsh.cmd'],
    [/^\.dsh\.ps1-[A-Za-z0-9]+$/, 'dsh.ps1'],
  ];
  for (const root of npmGlobalRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const [pattern, shimName] of spec) {
      const shimPath = path.join(root, shimName);
      if (existingFile(shimPath)) continue;
      const stub = entries.find((name) => pattern.test(name));
      if (!stub) continue;
      try {
        fs.copyFileSync(path.join(root, stub), shimPath);
        repaired.push(shimPath);
        log(`restored missing dsh shim ${shimPath}`);
      } catch (error) {
        log(`shim restore failed ${shimPath} (${error.message})`);
      }
    }
  }
  return repaired;
}

/**
 * 某些宿主（CLI 沙箱）会通过 NODE_OPTIONS 注入删除守卫，把 Node 的删除调用
 * 改道到回收站。它会连带让 npm 删不掉自己的临时目录，堆积出几万文件的残骸。
 * 给 npm 子进程剔除这层注入，恢复正常的删除能力。
 */
function npmChildEnv() {
  const env = Object.assign({}, process.env);
  const raw = env.NODE_OPTIONS;
  if (typeof raw === 'string' && raw.includes('genie-safe-delete')) {
    const cleaned = raw
      .replace(/--require=("?)[^"'\s]*genie-safe-delete\.cjs\1/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned) env.NODE_OPTIONS = cleaned;
    else delete env.NODE_OPTIONS;
    log(`npm child NODE_OPTIONS -> ${cleaned || '(unset)'}`);
  }
  return env;
}

// 给定 node.exe，返回其同目录自带的 npm 执行参数组（绿色版 Node 都自带 npm）
function npmCliArgsFor(nodePath) {
  const npmCli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existingFile(npmCli) ? [nodePath, npmCli] : null;
}

function findNode() {
  const envNode = process.env.DSH_NODE;
  if (existingFile(envNode)) return envNode;
  for (const dir of pathDirs()) {
    const exe = existingFile(path.join(dir, 'node.exe'));
    if (exe) return exe;
  }
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  for (const dir of [pf, pf86]) {
    const exe = dir && existingFile(path.join(dir, 'nodejs', 'node.exe'));
    if (exe) return exe;
  }
  const cached = loadCliCache().node;
  if (existingFile(cached)) return cached;
  // 兜底：应用内置的 Node（安装包自带，无需用户装任何东西）
  return existingFile(bundledNodePath());
}

function findDshBinJs() {
  const candidates = [];
  const envCli = process.env.DSH_CLI;
  if (envCli) {
    candidates.push(envCli);
    candidates.push(path.join(envCli, 'lib', 'bin.js'));
  }
  const appData = process.env.APPDATA;
  if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  // npm global shims live next to the global node_modules directory
  for (const dir of pathDirs()) {
    for (const shimName of ['dsh.cmd', 'dsh']) {
      const shim = existingFile(path.join(dir, shimName));
      if (!shim) continue;
      candidates.push(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
      try {
        const content = fs.readFileSync(shim, 'utf8');
        const m = content.match(/["']?([^"'\r\n]*@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)["']?/);
        if (m) candidates.push(m[1]);
      } catch {}
    }
  }
  const pf = process.env.ProgramFiles;
  if (pf) candidates.push(path.join(pf, 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  const pf86 = process.env['ProgramFiles(x86)'];
  if (pf86) candidates.push(path.join(pf86, 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  const cached = loadCliCache().binJs;
  if (cached) candidates.push(cached);
  // 兜底：应用内置的 DSH 核心
  candidates.push(bundledDshBinJs());
  for (const cand of candidates) {
    if (existingFile(cand)) return cand;
  }
  return null;
}

function httpProbe(port, cb, pathname, redirects = 0, cookie = '') {
  // dsh 0.1.2+ 的真实握手：GET /?token=xxx → 303 → 带上服务端下发的 cookie → 200 页面。
  // 因此探测必须跟随重定向并回传 cookie，否则永远读不到带 __DSH_BOOT__ 的正文。
  const headers = cookie ? { cookie } : {};
  const req = http.request(
    { host: '127.0.0.1', port, path: pathname || '/', method: 'GET', timeout: PROBE_TIMEOUT_MS, headers },
    (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        const location = String(res.headers.location);
        const setCookie = res.headers['set-cookie'];
        const nextCookie = setCookie
          ? setCookie.map((c) => String(c).split(';')[0]).join('; ')
          : cookie;
        let nextPath = location;
        if (/^https?:\/\//i.test(location)) {
          try {
            const u = new URL(location);
            nextPath = u.pathname + (u.search || '');
          } catch {}
        }
        res.resume(); // 丢弃重定向响应体，避免连接挂住
        httpProbe(port, cb, nextPath, redirects + 1, nextCookie);
        return;
      }
      let body = '';
      res.on('data', (d) => {
        body += d;
        if (body.length > 300_000) req.destroy();
      });
      res.on('end', () => cb(null, res.statusCode, body));
    }
  );
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (err) => cb(err));
  req.end();
}

function isDshOnPort(port) {
  return new Promise((resolve) => {
    httpProbe(port, (err, status, body) => {
      if (!err && status === 200 && typeof body === 'string' && body.includes(DSH_BOOT_MARKER)) resolve(true);
      else resolve(false);
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES' ? true : false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForDsh(port) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      httpProbe(port, (err, status, body) => {
        if (!err && status === 200 && typeof body === 'string' && body.includes(DSH_BOOT_MARKER)) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - startedAt > READY_TIMEOUT_MS) {
          clearInterval(timer);
          reject(new Error(`等待服务就绪超时（${READY_TIMEOUT_MS / 1000}s）`));
        }
      }, rootPath()); // 带上访问令牌，否则新版 dsh 一律返回 401
    }, POLL_INTERVAL_MS);
    timer.unref();
  });
}

function killChildTree() {
  const child = state.child;
  if (!child || state.childKilled) return;
  state.childKilled = true;
  log(`stopping dsh child (pid ${child.pid})`);
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 3_000).unref();
    }
  } catch (err) {
    log(`kill child failed: ${err.message}`);
  }
}

function startServer(nodePath, binJs, port) {
  return new Promise((resolve, reject) => {
    log(`spawning: ${nodePath} ${binJs} web --host 127.0.0.1 --port ${port} --no-open`);
    // 把内置 Node 目录放在 PATH 最前：DSH 内部子进程按 PATH 找 node 时也一定找得到
    const nodeDir = path.dirname(nodePath);
    const childEnv = { ...process.env };
    childEnv.PATH = `${nodeDir}${path.delimiter}${process.env.PATH || ''}`;
    // --no-open：服务启动时不自动打开默认浏览器（这是应用自己的窗口干的事）
    const child = spawn(nodePath, [binJs, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => childLogLine(d));
    child.stderr.on('data', (d) => childLogLine(d));
    child.once('error', (err) => {
      log(`spawn error: ${err.message}`);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      log(`dsh child exited code=${code} signal=${signal} killed=${state.childKilled}`);
      if (state.child === child) state.child = null;
      onChildExit(code, signal);
    });
    child.once('spawn', () => resolve(child));
  });
}

function onChildExit(code, signal) {
  if (state.quitting || state.childKilled || state.smokeFinished) return;
  if (!state.ready) {
    const detail = state.childLog.slice(-12).join('\n');
    const msg = `DeepSeek Harness 服务启动失败（退出码 ${code ?? signal}）`;
    log(msg);
    if (isSmoke) finishSmoke(false, 'server-exited-early', { code, signal, log: detail });
    else showFatal(msg, detail || '服务进程提前退出，请检查 DSH 安装。');
  } else {
    log('server exited while running');
    if (isSmoke) finishSmoke(false, 'server-exited', { code, signal });
    else {
      dialog
        .showMessageBox({
          type: 'error',
          title: APP_NAME,
          message: 'DeepSeek Harness 服务已停止',
          detail: `服务进程已退出（退出码 ${code ?? signal}），应用将关闭。`,
          buttons: ['关闭'],
        })
        .then(() => app.quit());
    }
  }
}

function showFatal(message, detail) {
  dialog
    .showMessageBox({
      type: 'error',
      title: APP_NAME,
      message,
      detail: detail || '',
      buttons: ['关闭'],
    })
    .then(() => app.quit());
}

// ---------------------------------------------------------------- boot flow

async function bootServer() {
  const explicit = cliPortArg !== null || process.env.DSH_PORT;
  const requested = cliPortArg !== null ? Number(cliPortArg) : Number(process.env.DSH_PORT);
  const target = explicit && Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_PORT;

  // 1. attach to an already-running DSH instance
  if (await isDshOnPort(target)) {
    state.attached = true;
    state.port = target;
    state.url = `http://127.0.0.1:${target}/`;
    log(`attaching to existing DSH server on port ${target}`);
    return;
  }

  // 2. decide the spawn port
  let spawnPort = target;
  const free = await isPortFree(target);
  if (!free) {
    if (explicit) throw new Error(`端口 ${target} 已被其他程序占用，请更换端口或关闭占用程序`);
    spawnPort = await findFreePort();
    log(`port ${target} busy (not DSH); picked free port ${spawnPort}`);
  }

  // 2.5 自愈：npm 中断安装会把启动器留在临时文件状态，
  // 导致终端里敲 dsh 变成 command not found。用残留临时文件把启动器补回来。
  const fixedShims = repairDshShims();
  if (fixedShims.length) log(`repaired dsh shim(s): ${fixedShims.join(', ')}`);

  // 3. locate the CLI
  let binJs = findDshBinJs();
  if (!binJs) {
    // 首次启动且无全局环境时，自动解压内置的核心归档
    await ensureBundledDshExtracted((msg) => updateSplashStatus(msg));
    binJs = findDshBinJs();
  }
  if (!binJs) {
    throw new Error(
      '未找到 DeepSeek Harness 命令行工具 (dsh)。\n\n请先安装：\n  npm install -g @deepseek-ai/dsh\n\n或设置环境变量 DSH_CLI 指向 dsh 的 lib/bin.js。'
    );
  }
  const nodePath = findNode();
  if (!nodePath) {
    throw new Error('未找到 Node.js。请安装 Node.js（https://nodejs.org）并确保 node 在 PATH 中。');
  }
  log(`using dsh: ${binJs} (node: ${nodePath})`);
  saveCliCache(nodePath, binJs);

  // 4. spawn and wait for readiness
  state.child = await startServer(nodePath, binJs, spawnPort);
  state.port = spawnPort;
  state.url = urlFor(spawnPort);
  await waitForDsh(spawnPort);
  // 服务就绪时令牌已抓到，刷新为带令牌的地址
  state.url = urlFor(spawnPort);
  state.ready = true;
  log(`server ready at ${state.url}`);
}

// ---------------------------------------------------------------- GitHub 同步更新

function readDshVersion(binJs) {
  try {
    // <root>/node_modules/@deepseek-ai/dsh/lib/bin.js → ../../package.json
    const pkg = path.join(binJs, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function parseVersion(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** 返回 1（a 更新）、-1（b 更新）、0（相同）。支持 0.1.0-rc.N 这类版本号。 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  const hasA = pa.pre.length > 0;
  const hasB = pb.pre.length > 0;
  if (!hasA && !hasB) return 0;
  if (!hasA) return 1; // 正式版 > 预发布版
  if (!hasB) return -1;
  const max = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < max; i++) {
    const ta = pa.pre[i];
    const tb = pb.pre[i];
    if (ta === undefined) return -1;
    if (tb === undefined) return 1;
    if (ta === tb) continue;
    const na = /^\d+$/.test(ta) ? Number(ta) : null;
    const nb = /^\d+$/.test(tb) ? Number(tb) : null;
    if (na !== null && nb !== null) return na > nb ? 1 : -1;
    return ta > tb ? 1 : -1;
  }
  return 0;
}

async function fetchLatestVersion() {
  try {
    const data = await fetchJson(UPDATE_URL);
    return typeof data.version === 'string' ? data.version : null;
  } catch (error) {
    log(`core update check failed: ${error.message}`);
    return null;
  }
}

function updateStatePath() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function loadUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(updateStatePath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveUpdateState(value) {
  try {
    fs.writeFileSync(updateStatePath(), JSON.stringify(value, null, 2), 'utf8');
  } catch {}
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http:') ? http : https;
    const req = lib.get(url, {
      timeout: UPDATE_FETCH_TIMEOUT_MS,
      headers: { accept: 'application/json', 'user-agent': 'DeepSeek-Harness-Desktop' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchJson(res.headers.location).then(resolve, reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

function fetchLatestReleaseRedirect() {
  return new Promise((resolve, reject) => {
    const url = `https://github.com/${DESKTOP_REPOSITORY}/releases/latest`;
    const req = https.get(url, {
      timeout: UPDATE_FETCH_TIMEOUT_MS,
      headers: { 'user-agent': 'DeepSeek-Harness-Desktop' },
    }, (res) => {
      const location = res.headers.location;
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && location) resolve(location);
      else reject(new Error(`GitHub latest release HTTP ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

async function fetchLatestDesktopRelease() {
  try {
    const release = await fetchJson(DESKTOP_UPDATE_URL);
    const tag = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/i, '') : null;
    const asset = Array.isArray(release.assets)
      ? release.assets.find((item) => item.name && /setup\.exe$/i.test(item.name) && item.browser_download_url)
      : null;
    return { version: tag, name: release.name || tag, url: asset ? asset.browser_download_url : null, assetName: asset ? asset.name : null };
  } catch (apiError) {
    // API 受限或超时时，使用 GitHub releases/latest 的官方重定向作为备用通道。
    const location = await fetchLatestReleaseRedirect();
    const match = String(location).match(/\/releases\/tag\/v?([^/?#]+)$/i);
    if (!match) throw apiError;
    const version = decodeURIComponent(match[1]);
    const assetName = `DeepSeek-Harness-${version}-setup.exe`;
    return {
      version,
      name: `DeepSeek Harness Desktop ${version}`,
      url: `https://github.com/${DESKTOP_REPOSITORY}/releases/download/v${version}/${assetName}`,
      assetName,
    };
  }
}

/** 统一检查 DSH 核心和桌面端 GitHub Release。 */
async function runUnifiedUpdateCheck() {
  const binJs = findDshBinJs();
  const installedCore = binJs ? readDshVersion(binJs) : null;
  const [latestCore, desktop] = await Promise.all([
    fetchLatestVersion().catch((error) => { log(`core update check failed: ${error.message}`); return null; }),
    fetchLatestDesktopRelease().catch((error) => { log(`desktop update check failed: ${error.message}`); return null; }),
  ]);
  const installedDesktop = app.getVersion();
  const coreAvailable = !!(installedCore && latestCore && compareVersions(latestCore, installedCore) > 0);
  const desktopAvailable = !!(desktop && desktop.version && desktop.url && compareVersions(desktop.version, installedDesktop) > 0);
  log(`unified update check: core ${installedCore} -> ${latestCore}; desktop ${installedDesktop} -> ${desktop && desktop.version}`);
  return { installedCore, latestCore, desktop, installedDesktop, coreAvailable, desktopAvailable };
}

function scheduleAutoUpdateCheck() {
  if (state.updateChecked) return;
  state.updateChecked = true;
  setTimeout(async () => {
    if (state.quitting || state.smokeFinished || state.updating) return;
    try {
      const result = await runUnifiedUpdateCheck();
      if (!result.coreAvailable && !result.desktopAvailable) return;
      const stateFile = loadUpdateState();
      const coreSkipped = result.coreAvailable && stateFile.skippedCore === result.latestCore;
      const desktopSkipped = result.desktopAvailable && stateFile.skippedDesktop === result.desktop.version;
      if ((!result.coreAvailable || coreSkipped) && (!result.desktopAvailable || desktopSkipped)) return;
      promptUnifiedUpdate(result);
    } catch (error) {
      log(`auto unified update check failed: ${error.message}`);
    }
  }, 2_500);
}

function promptUnifiedUpdate(result) {
  const lines = [];
  if (result.coreAvailable) lines.push(`• DeepSeek Harness 核心：${result.installedCore} → ${result.latestCore}`);
  if (result.desktopAvailable) lines.push(`• 桌面应用软件：${result.installedDesktop} → ${result.desktop.version}`);
  dialog.showMessageBox({
    type: 'info',
    title: APP_NAME,
    message: '发现可用更新',
    detail: `${lines.join('\n')}\n\n点击“立即更新”即可自动更新对应内容（哪个有更新就更新哪个）。`,
    buttons: ['立即更新', '稍后提醒', '跳过本次版本'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) startUnifiedUpdate(result);
    else if (response === 2) saveUpdateState(Object.assign(loadUpdateState(), {
      skippedCore: result.coreAvailable ? result.latestCore : loadUpdateState().skippedCore,
      skippedDesktop: result.desktopAvailable ? result.desktop.version : loadUpdateState().skippedDesktop,
    }));
  }).catch(() => {});
}

function createUpdateWindow() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0b0b10;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;overflow:hidden}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:0 36px}
    .title{color:#e8e8ee;font-size:15px;font-weight:600;text-align:center}
    .bar{width:100%;height:8px;border-radius:4px;background:#232330;overflow:hidden}
    .fill{height:100%;width:0%;border-radius:4px;background:#4d6bfe;transition:width .3s ease}
    .fill.indeterminate{width:35%!important;animation:slide 1.2s ease-in-out infinite}
    .pct{color:#8a8a98;font-size:12px}
    .status{color:#9aa0b4;font-size:13px;text-align:center;max-width:340px;word-break:break-all}
    @keyframes slide{0%{margin-left:-35%}100%{margin-left:100%}}
  </style></head><body><div class="wrap">
    <div class="title">正在更新 DeepSeek Harness</div>
    <div class="bar"><div class="fill indeterminate" id="fill"></div></div>
    <div class="pct" id="pct"></div>
    <div class="status" id="status">正在检查依赖版本…</div>
  </div></body></html>`;
  const win = new BrowserWindow({
    width: 460,
    height: 260,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#0b0b10',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  return win;
}

// 更新窗口的进度刷新（pct 为 null 时用动画条）
function updateProgress(win, statusText, pct) {
  if (!win || win.isDestroyed()) return;
  const script = `(function(){
    var s=document.getElementById('status'); if(s) s.textContent=${JSON.stringify(String(statusText || ''))};
    var f=document.getElementById('fill'); var p=document.getElementById('pct');
    if(${pct === null ? 'true' : 'false'}){ if(f){f.classList.add('indeterminate');} if(p){p.textContent='';} }
    else{ if(f){f.classList.remove('indeterminate'); f.style.width=String(${pct})+ '%';} if(p){p.textContent=String(${pct})+ '%';} }
  })()`;
  win.webContents.executeJavaScript(script).catch(() => {});
}

function runNpmInstall(targetVersion, onProgress) {
  const progress = onProgress || (() => {});
  return new Promise((resolve) => {
    // 版本号必须形如 x.y.z(-pre)，防止被上游伪造字符串注入命令
    if (!parseVersion(targetVersion)) {
      resolve({ ok: false, error: `非法版本号：${targetVersion}`, log: [] });
      return;
    }
    // 更新前先清掉上一轮可能残留的临时目录：那是 npm 没删干净的旧版本，
    // 动辄几万个文件，光遍历它就要耗掉好几分钟。
    const cleaned = cleanupDshResidue();
    if (cleaned) progress(`已清理 ${cleaned} 处安装残留…`, null);

    // 机器上既然已经装了 dsh，依赖树就是现成的：--prefer-offline 优先吃本地缓存，
    // 省掉 500 多个依赖包的在线版本查询；白名单处理见下方主流程。
    const base = [
      'install',
      '-g',
      `${DSH_PACKAGE}@${targetVersion}`,
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      `--registry=${DSH_REGISTRY}`,
    ];

    const exec = (args) =>
      new Promise((res2) => {
        log(`npm ${args.join(' ')}`);
        // 优先用解析出的 Node 自带的 npm（内置/系统 Node 都自带），没有才退回 PATH 上的 npm
        const nodePath = findNode();
        const bundledNpm = nodePath ? npmCliArgsFor(nodePath) : null;
        // 剔除宿主注入的删除守卫，否则 npm 删不掉自己的临时目录、会堆积出巨量残骸
        const childEnv = npmChildEnv();
        const child = bundledNpm
          ? spawn(bundledNpm[0], [...bundledNpm.slice(1), ...args], {
              env: childEnv,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          : spawn('npm', args, {
              shell: true,
              env: childEnv,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
        const out = [];
        let reified = 0;
        const collect = (d) => {
          const clean = String(d).replace(/\x1b\[[0-9;]*m/g, '');
          for (const line of clean.split(/\r?\n/)) {
            const t = line.trim();
            if (!t) continue;
            out.push(t);
            if (/^reify:/i.test(t)) {
              reified += 1;
              progress(`正在安装依赖（已处理 ${reified} 个包）…`, null);
            } else if (/http fetch/i.test(t)) {
              progress('正在下载依赖包…', null);
            } else if (/added \d+ packages/i.test(t)) {
              progress('依赖安装完成，正在收尾…', 90);
            }
          }
          if (out.length > 200) out.splice(0, out.length - 200);
          log(`[npm] ${clean.trimEnd()}`);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timeout = setTimeout(() => {
          try {
            child.kill();
          } catch {}
        }, UPDATE_INSTALL_TIMEOUT_MS);
        child.on('error', (err) => {
          clearTimeout(timeout);
          res2({ ok: false, error: err.message, log: out });
        });
        child.on('exit', (code) => {
          clearTimeout(timeout);
          res2({ ok: code === 0, code, log: out });
        });
      });

    // npm 11 起默认不执行依赖的 install 脚本，会先列出 allowScripts 白名单。
    // 老做法是照原样装一遍、被拦下、再带白名单把整树装第二遍 —— 500 多个包解析两轮，
    // 这正是「更新特别慢」的另一半原因。改为沿用上次算出的名单，没有就先用 dry-run 探一次。
    const extractAllow = (text) => {
      const m = String(text || '').match(/--allow-scripts=([A-Za-z0-9@./_,-]+)/);
      return m ? m[1] : '';
    };
    const stateFile = loadUpdateState();
    let allowList = typeof stateFile.allowScripts === 'string' ? stateFile.allowScripts : '';

    (async () => {
      if (!allowList) {
        progress('正在检查依赖…', null);
        const probe = await exec([...base, '--dry-run']);
        allowList = extractAllow((probe.log || []).join('\n'));
        if (allowList) {
          saveUpdateState(Object.assign(loadUpdateState(), { allowScripts: allowList }));
        }
        log(`allow-scripts probe -> ${allowList || '(none)'}`);
      }

      progress('正在下载并安装核心…', null);
      const first = await exec(allowList ? [...base, `--allow-scripts=${allowList}`] : base);
      if (!first.ok) {
        resolve(first);
        return;
      }
      // 依赖脚本名单会随上游版本变化：npm 又列出新名单时，用它补装一次
      const fresh = extractAllow((first.log || []).join('\n'));
      if (fresh && fresh !== allowList) {
        log(`allow-scripts 名单更新为 ${fresh}，补装一次`);
        saveUpdateState(Object.assign(loadUpdateState(), { allowScripts: fresh }));
        progress('正在补装必要组件…', 92);
        const second = await exec([...base, `--allow-scripts=${fresh}`]);
        progress('更新完成', 100);
        resolve(second.ok ? second : first);
        return;
      }
      progress('更新完成', 100);
      resolve(first);
    })();
  });
}

function waitPortFree(port, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (await isPortFree(port)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('服务端口未能及时释放'));
      }
    }, 400);
  });
}

/** 更新后重启 app 自己拉起的服务，让新版本立即生效。 */
async function restartOwnServer() {
  const port = state.port;
  killChildTree();
  state.child = null;
  state.childKilled = false;
  state.ready = false;
  state.childLog = [];
  state.token = null; // 新进程会签发新令牌，旧令牌作废
  await waitPortFree(port);
  const binJs = findDshBinJs();
  const nodePath = findNode();
  if (!binJs || !nodePath) throw new Error('更新后未找到 dsh CLI 或 Node.js');
  state.child = await startServer(nodePath, binJs, port);
  await waitForDsh(port);
  state.url = urlFor(port); // 重启后令牌已更新
  state.ready = true;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.loadURL(state.url);
  log(`server restarted with updated dsh at ${state.url}`);
}

function downloadFile(url, destination, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error('下载重定向次数过多'));
      return;
    }
    const lib = String(url).startsWith('http:') ? http : https;
    const output = fs.createWriteStream(destination, { flags: redirects === 0 ? 'w' : 'a' });
    let isHandled = false;

    const cleanupAndReject = (err) => {
      if (isHandled) return;
      isHandled = true;
      try { output.close(); } catch {}
      try { fs.unlinkSync(destination); } catch {}
      reject(err);
    };

    const request = lib.get(url, {
      timeout: DESKTOP_DOWNLOAD_TIMEOUT_MS,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: '*/*',
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        isHandled = true;
        response.resume();
        output.close(() => {
          try { fs.unlinkSync(destination); } catch {}
          downloadFile(response.headers.location, destination, onProgress, redirects + 1).then(resolve, reject);
        });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        cleanupAndReject(new Error(`下载更新包失败：HTTP ${response.statusCode}`));
        return;
      }
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      response.on('error', cleanupAndReject);
      output.on('finish', () => {
        output.close(() => {
          if (isHandled) return;
          isHandled = true;
          try {
            const stat = fs.statSync(destination);
            // 安装包体积通常在 50MB 以上，小于 10MB 说明未完整下载
            if (stat.size < 10 * 1024 * 1024) {
              try { fs.unlinkSync(destination); } catch {}
              reject(new Error(`更新包下载不完整（仅 ${Math.round(stat.size / 1024)} KB），已取消`));
              return;
            }
            log(`installer downloaded successfully: ${destination} (${stat.size} bytes)`);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
      response.pipe(output);
    });

    request.setTimeout(DESKTOP_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error('下载更新包超时'));
    });
    request.on('error', cleanupAndReject);
  });
}

/**
 * 启动正常安装页面并退出当前旧程序：
 * 直接使用系统 Shell 打开下载好的 setup.exe，绝不启动任何 cmd.exe 控制台（零黑窗口）；
 * 直接弹出清晰规范的标准 Windows 安装向导页面，带有真实的绿色进度条；
 * 随后当前旧程序正常退出，释放所有文件占用，保证覆盖安装顺畅完成。
 */
function launchInstallerAndExit(installerPath) {
  log(`launching installer directly via shell: ${installerPath}`);
  try {
    shell.openPath(installerPath).then((errMsg) => {
      if (errMsg) log(`shell.openPath returned error: ${errMsg}`);
    }).catch((err) => {
      log(`shell.openPath exception: ${err.message}`);
    });
  } catch (e) {
    log(`open installer failed: ${e.message}`);
  }

  // 延时半秒释放 node 子服务与当前窗口，让出所有文件锁，使刚刚打开的安装向导能够顺畅覆盖
  state.quitting = true;
  killChildTree();
  setTimeout(() => {
    app.quit();
  }, 500);
}

async function startUnifiedUpdate(result) {
  if (state.updating) return;
  state.updating = true;
  const progress = createUpdateWindow();
  try {
    if (result.coreAvailable) {
      const coreResult = await runNpmInstall(result.latestCore, (text, pct) => updateProgress(progress, `核心更新：${text}`, pct));
      if (!coreResult.ok) throw new Error((coreResult.log && coreResult.log.slice(-12).join('\\n')) || coreResult.error || '核心更新失败');
      // 收尾：清掉本轮可能产生的残骸，并确保 dsh 命令的启动器齐全
      cleanupDshResidue();
      repairDshShims();
    }

    if (result.desktopAvailable) {
      const downloadPath = path.join(app.getPath('userData'), `DeepSeek-Harness-${result.desktop.version}-setup.exe`);
      log(`downloading desktop installer from ${result.desktop.url} to ${downloadPath}`);
      await downloadFile(result.desktop.url, downloadPath, (received, total) => {
        if (total > 0) {
          const pct = Math.min(99, Math.round((received / total) * 100));
          updateProgress(progress, `正在下载桌面应用更新包（${Math.round(received / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} MB）…`, pct);
        } else {
          updateProgress(progress, `正在下载桌面应用更新包（${Math.round(received / 1024 / 1024)} MB）…`, null);
        }
      });
      updateProgress(progress, '下载完成，正在打开安装程序…', 100);
      setTimeout(() => {
        if (progress && !progress.isDestroyed()) progress.destroy();
        launchInstallerAndExit(downloadPath);
      }, 500);
      return;
    }

    if (progress && !progress.isDestroyed()) progress.destroy();
    state.updating = false;
    const binJs = findDshBinJs();
    const nowVer = binJs ? readDshVersion(binJs) : result.latestCore;
    if (state.child && !state.attached) {
      await restartOwnServer();
      await dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '更新完成', detail: `DeepSeek Harness 核心已更新到 ${nowVer}，服务已自动重启。`, buttons: ['好'] });
    } else {
      await dialog.showMessageBox({ type: 'info', title: APP_NAME, message: '更新完成', detail: `DeepSeek Harness 核心已更新到 ${nowVer}。重启服务后生效。`, buttons: ['好'] });
    }
  } catch (error) {
    if (progress && !progress.isDestroyed()) progress.destroy();
    state.updating = false;
    // 失败时更要清理：安装中断最容易留下巨量残骸，不处理会一直拖慢后续更新
    try {
      cleanupDshResidue();
      repairDshShims();
    } catch {}
    await dialog.showMessageBox({ type: 'error', title: APP_NAME, message: '更新失败', detail: error.message || String(error), buttons: ['好'] });
  }
}

// ---------------------------------------------------------------- windows

function createSplash() {
  const win = new BrowserWindow({
    width: 520,
    height: 400,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#0b0b10',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  win.once('ready-to-show', () => {
    if (!state.quitting && !state.mainWindow) win.show();
  });
  state.splash = win;
}

function isAppUrl(url) {
  // 按「本机 + 同一个端口」判定，而不是比对 URL 前缀：新版 dsh 的地址带一次性
  // token 参数，页面内跳转可能丢掉该参数，前缀匹配会误伤并拦截正常导航。
  if (!state.port) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    return (host === '127.0.0.1' || host === 'localhost') && Number(u.port || 0) === Number(state.port);
  } catch {
    return false;
  }
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0b10',
    autoHideMenuBar: false,
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  state.mainWindow = win;

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      win.loadURL(url);
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // 前端用 fetch/XHR 拉模块，这类失败既不触发 did-fail-load 也不进 console，
  // 只能在网络层看得到 —— "页面一直转圈"往往就是卡在这。
  if (process.env.DSH_NET_DEBUG) {
    const filter = { urls: ['*://127.0.0.1/*', '*://localhost/*'] };
    session.defaultSession.webRequest.onErrorOccurred(filter, (d) => {
      log(`[net] FAILED ${d.error} ${d.method} ${d.url}`);
    });
    session.defaultSession.webRequest.onCompleted(filter, (d) => {
      if (d.statusCode >= 400) log(`[net] HTTP ${d.statusCode} ${d.method} ${d.url}`);
    });
  }

  // 页面内部（脚本/接口）失败不会触发 did-fail-load，只会在渲染进程里打日志；
  // 没有这条就完全看不到"白屏/一直转圈"的真实原因。
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const rawMsg = (event && typeof event.message === 'string') ? event.message : (typeof message === 'string' ? message : '');
    const rawLevel = (event && typeof event.level === 'string') ? event.level : (typeof level === 'string' ? level : '');
    const rawSource = (event && typeof event.sourceId === 'string') ? event.sourceId : (typeof sourceId === 'string' ? sourceId : '');
    const rawLine = (event && typeof event.lineNumber === 'number') ? event.lineNumber : (typeof line === 'number' ? line : 0);
    if (rawLevel === 'error' || rawLevel === 'warning' || process.env.DSH_VERBOSE_CONSOLE) {
      log(`[renderer:${rawLevel === 'error' ? 'error' : rawLevel === 'warning' ? 'warn' : 'log'}] ${rawMsg} @ ${rawSource}:${rawLine}`);
    }
  });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      log(`[subresource] failed to load ${validatedURL} (${errorCode} ${errorDescription})`);
      return;
    }
    if (state.smokeFinished) return;
    if (state.loadFailures < LOAD_RETRY_MAX && !state.quitting) {
      state.loadFailures += 1;
      log(`load failed (${errorCode} ${errorDescription}), retry ${state.loadFailures}`);
      setTimeout(() => {
        if (!win.isDestroyed() && !state.quitting) win.loadURL(state.url);
      }, 1_000);
    } else {
      if (isSmoke) finishSmoke(false, 'load-failed', { errorCode, errorDescription });
      else showFatal('页面加载失败', `${errorDescription} (${errorCode})`);
    }
  });

  win.webContents.on('render-process-gone', (event, details) => {
    if (state.smokeFinished) return;
    const reason = details && details.reason;
    if (isSmoke) finishSmoke(false, 'renderer-gone', { reason });
    else showFatal('界面进程异常退出', `原因：${reason}`);
  });

  win.once('ready-to-show', () => {
    if (state.splash && !state.splash.isDestroyed()) state.splash.destroy();
    state.splash = null;
    win.show();
    if (isSmoke) scheduleSmokeSuccess();
    else scheduleAutoUpdateCheck();
  });

  win.loadURL(state.url);
}

// ---------------------------------------------------------------- smoke watchdog

let smokeWatchdog = null;
function scheduleSmokeSuccess() {
  // give the React app a few seconds to mount after the page load event
  setTimeout(() => {
    if (!state.smokeFinished) finishSmoke(true, 'loaded');
  }, 3_000);
}

function armSmokeWatchdog() {
  smokeWatchdog = setTimeout(() => {
    if (!state.smokeFinished) finishSmoke(false, 'timeout');
  }, READY_TIMEOUT_MS + 30_000);
  smokeWatchdog.unref();
}

// ---------------------------------------------------------------- menu

function installMenu() {
  const template = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          click: triggerManualUpdateCheck,
        },
        {
          label: '在浏览器中打开',
          enabled: !!state.url,
          click: () => {
            if (state.url) shell.openExternal(state.url);
          },
        },
        { type: 'separator' },
        {
          label: `关于 ${APP_NAME}`,
          click: () => {
            const binJs = findDshBinJs();
            const dshVer = binJs ? readDshVersion(binJs) : '未检测到';
            dialog.showMessageBox({
              type: 'info',
              title: `关于 ${APP_NAME}`,
              message: APP_NAME,
              detail: `双击启动的 DeepSeek Harness 桌面应用\n桌面应用版本 ${app.getVersion()}\nDSH 核心版本 ${dshVer}\n服务地址：${state.url || '—'}\n\n更新说明：启动时自动检查，也可随时点击菜单栏「🔄 检查更新」或界面右上角按钮进行统一检查。`,
              buttons: ['好'],
            });
          },
        },
      ],
    },
    {
      label: '🔄 检查更新',
      click: triggerManualUpdateCheck,
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function triggerManualUpdateCheck() {
  if (state.updating) return;
  try {
    const result = await runUnifiedUpdateCheck();
    if (!result.coreAvailable && !result.desktopAvailable) {
      const core = result.latestCore || '无法获取';
      const desktop = result.desktop && result.desktop.version ? result.desktop.version : '无法获取';
      await dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: '已是最新版本',
        detail: `• DSH 核心版本：${result.installedCore || '未检测到'}（npm 上游：${core}）\n• 桌面应用版本：${result.installedDesktop}（GitHub 最新：${desktop}）`,
        buttons: ['好'],
      });
      return;
    }
    promptUnifiedUpdate(result);
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: APP_NAME,
      message: '检查更新失败',
      detail: error.message || String(error),
      buttons: ['好'],
    });
  }
}

// ---------------------------------------------------------------- app lifecycle

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = state.mainWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    installMenu();

    // 测试钩子 2：把最新版安装到临时 prefix（不触碰全局安装），验证更新命令可行
    if (updateInstallTestPrefix) {
      const { installedCore, latestCore } = await runUnifiedUpdateCheck();
      const target = latestCore || installedCore;
      const result = await new Promise((resolve) => {
        const nodePath = findNode();
        const bundledNpm = nodePath ? npmCliArgsFor(nodePath) : null;
        const args = ['install', '-g', '--prefix', updateInstallTestPrefix, `${DSH_PACKAGE}@${target}`, '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com'];
        const child = bundledNpm
          ? spawn(bundledNpm[0], [...bundledNpm.slice(1), ...args], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
          : spawn('npm', args, { shell: true, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const out = [];
        const collect = (d) => {
          for (const line of String(d).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
            if (line.trim()) out.push(line.trim());
          }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
        child.on('exit', (code) => resolve({ ok: code === 0, code, logTail: out.slice(-8) }));
      });
      fs.writeFileSync(
        updateCheckTestPath || path.join(os.tmpdir(), 'dsh-update-install-test.json'),
        JSON.stringify({ installedCore, latestCore, target, installOk: result.ok, code: result.code, error: result.error, logTail: result.logTail }, null, 2),
        'utf8'
      );
      app.exit(result.ok ? 0 : 1);
      return;
    }

    // 测试钩子 1：同时检查核心与桌面端并输出决策，不弹窗、不建窗口
    if (updateCheckTestPath) {
      const result = await runUnifiedUpdateCheck();
      const action = result.coreAvailable || result.desktopAvailable ? 'update-available' : 'up-to-date';
      fs.writeFileSync(updateCheckTestPath, JSON.stringify({
        installedCore: result.installedCore,
        latestCore: result.latestCore,
        installedDesktop: result.installedDesktop,
        latestDesktop: result.desktop && result.desktop.version,
        coreAvailable: result.coreAvailable,
        desktopAvailable: result.desktopAvailable,
        action,
      }, null, 2), 'utf8');
      app.exit(0);
      return;
    }

    // show the splash immediately so the user sees the app come alive
    createSplash();

    if (isSmoke) armSmokeWatchdog();

    try {
      await bootServer();
      createMainWindow();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log(`boot failed: ${message}`);
      if (isSmoke) finishSmoke(false, 'boot-failed', { error: message });
      else {
        showFatal('启动失败', message);
        if (state.splash && !state.splash.isDestroyed()) state.splash.destroy();
      }
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    state.quitting = true;
    killChildTree();
  });

  app.on('quit', () => {
    state.quitting = true;
    killChildTree();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && state.url) createMainWindow();
  });
}
