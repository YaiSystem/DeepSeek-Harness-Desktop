'use strict';

/**
 * 打包前准备：下载内置 Node 绿色版 + 安装内置 DSH 核心到 resources/。
 * 国内网络自动使用 npmmirror 镜像。产物被 .gitignore 排除，不进仓库。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const NODE_VERSION = 'v24.19.0';
const NODE_DIR_NAME = `node-${NODE_VERSION}-win-x64`;
const DSH_PACKAGE = '@deepseek-ai/dsh';
const DSH_VERSION = '0.1.1-rc.2';
const RESOURCES = path.join(ROOT, 'resources');

const MIRROR = process.env.NODE_DOWNLOAD_MIRROR || 'https://npmmirror.com/mirrors/node';

function log(msg) {
  console.log(`[prepare] ${msg}`);
}

function run(cmd, args, opts) {
  log(`${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

function main() {
  fs.mkdirSync(RESOURCES, { recursive: true });

  // 1. 内置 Node 绿色版
  const nodeDir = path.join(RESOURCES, 'node', NODE_DIR_NAME);
  const nodeExe = path.join(nodeDir, 'node.exe');
  if (!fs.existsSync(nodeExe)) {
    const zipUrl = `${MIRROR}/${NODE_VERSION}/${NODE_DIR_NAME}.zip`;
    const zipPath = path.join(os.tmpdir(), `${NODE_DIR_NAME}.zip`);
    log(`下载 Node ${NODE_VERSION} 绿色版: ${zipUrl}`);
    run('curl.exe', ['-L', '--fail', '-o', zipPath, zipUrl], { timeout: 10 * 60_000 });
    log('解压 Node 绿色版…');
    run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${path.join(RESOURCES, 'node')}' -Force`,
    ]);
    fs.unlinkSync(zipPath);
    log('Node 就绪');
  } else {
    log(`Node 已存在: ${nodeExe}`);
  }

  // 2. 内置 DSH 核心
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) {
    log('Node 缺少 npm，请重新解压 Node 绿色版');
    process.exit(1);
  }
  const dshDir = path.join(RESOURCES, 'dsh');
  const dshPkg = path.join(dshDir, 'bundle', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(dshPkg)) {
    log(`安装 ${DSH_PACKAGE}@${DSH_VERSION} 到 resources/dsh…`);
    run(nodeExe, [npmCli, 'install', '--prefix', path.join(dshDir, 'bundle'), `${DSH_PACKAGE}@${DSH_VERSION}`, '--no-audit', '--no-fund', '--loglevel=warn'], { timeout: 20 * 60_000 });
    log('DSH 核心就绪');
  } else {
    log(`DSH 核心已存在: ${dshDir}`);
  }

  // 3. 将核心精简并打包为单文件归档 dsh-core.tar（防止 NSIS 安装时解压三万个小文件卡死进度条）
  const tarOutput = path.join(dshDir, 'dsh-core.tar');
  const bundleDir = path.join(dshDir, 'bundle');
  if (fs.existsSync(bundleDir) && !fs.existsSync(tarOutput)) {
    log('正在精简核心依赖并生成 dsh-core.tar...');
    run('tar.exe', ['-cf', tarOutput, '-C', dshDir, 'bundle']);
    log(`dsh-core.tar 就绪: ${tarOutput}`);
  }

  log('完成。现在可以执行 npm run pack 打包。');
}

main();
