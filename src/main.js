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

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
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
const UPDATE_URL = process.env.DSH_UPDATE_URL || `https://registry.npmjs.org/${DSH_PACKAGE}/latest`;
const UPDATE_FETCH_TIMEOUT_MS = 10_000;
const UPDATE_INSTALL_TIMEOUT_MS = 10 * 60_000;

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
};

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
  return null;
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
  for (const cand of candidates) {
    if (existingFile(cand)) return cand;
  }
  return null;
}

function httpProbe(port, cb) {
  const req = http.request(
    { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: PROBE_TIMEOUT_MS },
    (res) => {
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
      });
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
    log(`spawning: ${nodePath} ${binJs} web --host 127.0.0.1 --port ${port}`);
    const child = spawn(nodePath, [binJs, 'web', '--host', '127.0.0.1', '--port', String(port)], {
      env: process.env,
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

  // 3. locate the CLI
  const binJs = findDshBinJs();
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
  state.url = `http://127.0.0.1:${spawnPort}/`;
  await waitForDsh(spawnPort);
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

function fetchLatestVersion() {
  return new Promise((resolve) => {
    const lib = UPDATE_URL.startsWith('http:') ? http : https;
    const req = lib.get(
      UPDATE_URL,
      { timeout: UPDATE_FETCH_TIMEOUT_MS, headers: { accept: 'application/json' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const lib2 = String(res.headers.location).startsWith('http:') ? http : https;
          const req2 = lib2.get(res.headers.location, { timeout: UPDATE_FETCH_TIMEOUT_MS, headers: { accept: 'application/json' } }, (r2) => {
            let body2 = '';
            r2.on('data', (d) => { body2 += d; if (body2.length > 200_000) r2.destroy(); });
            r2.on('end', () => { try { resolve(JSON.parse(body2).version || null); } catch { resolve(null); } });
          });
          req2.on('timeout', () => req2.destroy());
          req2.on('error', () => resolve(null));
          return;
        }
        let body = '';
        res.on('data', (d) => {
          body += d;
          if (body.length > 200_000) req.destroy();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
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

/** 检查核心：已安装版本 + 上游最新版本。失败时相应字段为 null。 */
async function runUpdateCheck() {
  const binJs = findDshBinJs();
  const installed = binJs ? readDshVersion(binJs) : null;
  const latest = await fetchLatestVersion();
  log(`update check: installed=${installed} latest=${latest}`);
  return { installed, latest };
}

function scheduleAutoUpdateCheck() {
  if (state.updateChecked) return;
  state.updateChecked = true;
  setTimeout(async () => {
    if (state.quitting || state.smokeFinished || state.updating) return;
    try {
      const { installed, latest } = await runUpdateCheck();
      if (!installed || !latest) return; // 拿不到信息时不打扰用户
      if (compareVersions(latest, installed) <= 0) return;
      if (loadUpdateState().skipped === latest) return; // 用户已跳过该版本
      promptUpdate(installed, latest);
    } catch (err) {
      log(`auto update check failed: ${err && err.message}`);
    }
  }, 2_500);
}

function promptUpdate(installed, latest) {
  dialog
    .showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: `发现新版本 ${latest}`,
      detail: `当前安装的 DeepSeek Harness 核心版本为 ${installed}。\n上游（GitHub deepseek-ai/deepseek-harness 的 npm 发布）已有新版本 ${latest}，建议更新。`,
      buttons: ['立即更新', '稍后提醒', `跳过 ${latest}`],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) startUpdate(latest);
      else if (response === 2) saveUpdateState({ skipped: latest });
    })
    .catch(() => {});
}

function createUpdateWindow() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0b0b10;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;overflow:hidden}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
    .spinner{width:26px;height:26px;border:3px solid #33333f;border-top-color:#9aa0b4;border-radius:50%;animation:spin .9s linear infinite}
    .title{color:#e8e8ee;font-size:15px;font-weight:600}
    .sub{color:#8a8a98;font-size:12px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style></head><body><div class="wrap">
    <div class="spinner"></div><div class="title">正在更新 DeepSeek Harness</div>
    <div class="sub">正在通过 npm 同步 GitHub 最新版本，请稍候…</div>
  </div></body></html>`;
  const win = new BrowserWindow({
    width: 420,
    height: 280,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#0b0b10',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  return win;
}

function runNpmInstall(targetVersion) {
  return new Promise((resolve) => {
    // 版本号必须形如 x.y.z(-pre)，防止被上游伪造字符串注入命令
    if (!parseVersion(targetVersion)) {
      resolve({ ok: false, error: `非法版本号：${targetVersion}`, log: [] });
      return;
    }
    const base = ['install', '-g', `${DSH_PACKAGE}@${targetVersion}`, '--no-audit', '--no-fund'];

    const exec = (args) =>
      new Promise((res2) => {
        log(`npm ${args.join(' ')}`);
        const child = spawn('npm', args, {
          shell: true,
          env: process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out = [];
        const collect = (d) => {
          const clean = String(d).replace(/\x1b\[[0-9;]*m/g, '');
          for (const line of clean.split(/\r?\n/)) {
            if (line.trim()) out.push(line.trim());
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

    exec(base).then(async (first) => {
      if (!first.ok) {
        resolve(first);
        return;
      }
      // npm 的 allow-scripts 白名单可能拦下了 postinstall（原生模块构建等），
      // 按 npm 提示的精确包列表重跑一次，保证安装完整。
      const text = (first.log || []).join('\n');
      const allow = text.match(/--allow-scripts=([A-Za-z0-9@./_,-]+)/);
      if (!text.includes('allowScripts') || !allow) {
        resolve(first);
        return;
      }
      log(`allow-scripts 拦截检测到，用列表 ${allow[1]} 重装一次`);
      const second = await exec([...base, `--allow-scripts=${allow[1]}`]);
      resolve(second.ok ? second : first);
    });
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
  await waitPortFree(port);
  const binJs = findDshBinJs();
  const nodePath = findNode();
  if (!binJs || !nodePath) throw new Error('更新后未找到 dsh CLI 或 Node.js');
  state.child = await startServer(nodePath, binJs, port);
  await waitForDsh(port);
  state.ready = true;
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.loadURL(state.url);
  log(`server restarted with updated dsh at ${state.url}`);
}

async function startUpdate(targetVersion) {
  if (state.updating) return;
  state.updating = true;
  const progress = createUpdateWindow();
  const result = await runNpmInstall(targetVersion);
  if (progress && !progress.isDestroyed()) progress.destroy();
  state.updating = false;

  if (result.ok) {
    const binJs = findDshBinJs();
    const nowVer = binJs ? readDshVersion(binJs) : null;
    log(`update finished, version now: ${nowVer}`);
    if (state.child && !state.attached) {
      try {
        await restartOwnServer();
        dialog.showMessageBox({
          type: 'info',
          title: APP_NAME,
          message: '更新完成',
          detail: `DeepSeek Harness 核心已更新到 ${nowVer || targetVersion}，本地服务已自动重启，立即生效。`,
          buttons: ['好'],
        });
      } catch (err) {
        dialog.showMessageBox({
          type: 'warning',
          title: APP_NAME,
          message: '更新完成，但服务重启失败',
          detail: `核心已更新到 ${nowVer || targetVersion}。\n重启服务失败：${err.message}\n请关闭应用后重新打开。`,
          buttons: ['好'],
        });
      }
    } else {
      dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: '更新完成',
        detail: `DeepSeek Harness 核心已更新到 ${nowVer || targetVersion}。\n当前连接的是已经运行中的服务，重启该服务后生效。`,
        buttons: ['好'],
      });
    }
  } else {
    dialog.showMessageBox({
      type: 'error',
      title: APP_NAME,
      message: '更新失败',
      detail: (result.log && result.log.slice(-12).join('\n')) || result.error || '未知错误',
      buttons: ['好'],
    });
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
  if (!state.url) return false;
  const base = state.url.replace(/\/$/, '');
  return url === state.url || url.startsWith(base + '/') || url.startsWith(base + '#') || url.startsWith(base + '?');
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0b10',
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || state.smokeFinished) return;
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
          click: async () => {
            try {
              const { installed, latest } = await runUpdateCheck();
              if (!installed) {
                dialog.showMessageBox({
                  type: 'warning',
                  title: APP_NAME,
                  message: '未检测到已安装的 DeepSeek Harness 核心',
                  detail: '请先通过 npm 安装：npm install -g @deepseek-ai/dsh',
                  buttons: ['好'],
                });
              } else if (!latest) {
                dialog.showMessageBox({
                  type: 'warning',
                  title: APP_NAME,
                  message: '无法连接更新服务器',
                  detail: '请检查网络后重试。',
                  buttons: ['好'],
                });
              } else if (compareVersions(latest, installed) <= 0) {
                dialog.showMessageBox({
                  type: 'info',
                  title: APP_NAME,
                  message: `已是最新版本（${installed}）`,
                  detail: '与上游 GitHub（npm 发布）保持同步。',
                  buttons: ['好'],
                });
              } else {
                promptUpdate(installed, latest);
              }
            } catch (err) {
              dialog.showMessageBox({
                type: 'error',
                title: APP_NAME,
                message: '检查更新失败',
                detail: (err && err.message) || String(err),
                buttons: ['好'],
              });
            }
          },
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
              detail: `双击启动的 DeepSeek Harness 桌面应用\n外壳版本 ${app.getVersion()}\n核心版本 ${dshVer}\n服务地址：${state.url || '—'}\n\n更新说明：核心与 GitHub deepseek-ai/deepseek-harness\n的 npm 发布保持同步，可在「帮助 → 检查更新」手动检查。`,
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      const { installed, latest } = await runUpdateCheck();
      const target = latest || installed;
      const result = await new Promise((resolve) => {
        const args = ['install', '-g', '--prefix', updateInstallTestPrefix, `${DSH_PACKAGE}@${target}`, '--no-audit', '--no-fund'];
        const child = spawn('npm', args, { shell: true, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
        JSON.stringify({ installed, latest, target, installOk: result.ok, code: result.code, error: result.error, logTail: result.logTail }, null, 2),
        'utf8'
      );
      app.exit(result.ok ? 0 : 1);
      return;
    }

    // 测试钩子 1：只跑更新检查并输出决策，不弹窗、不建窗口
    if (updateCheckTestPath) {
      const { installed, latest } = await runUpdateCheck();
      const action = !installed
        ? 'no-dsh'
        : !latest
          ? 'no-network'
          : compareVersions(latest, installed) > 0
            ? 'update-available'
            : 'up-to-date';
      fs.writeFileSync(updateCheckTestPath, JSON.stringify({ installed, latest, action }, null, 2), 'utf8');
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
