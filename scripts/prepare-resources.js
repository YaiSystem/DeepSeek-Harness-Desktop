'use strict';

/**
 * 打包前准备：下载内置 Node 绿色版 + 安装内置 DSH 核心到 resources/。
 * 国内网络自动使用 npmmirror 镜像。产物被 .gitignore 排除，不进仓库。
 *
 * 版本策略：
 *   目标版本 = 命令行参数 > DSH_VERSION 环境变量 > registry 最新版
 *   已装版本与目标版本不一致时自动重装，并重新生成 dsh-core.tar。
 *   （旧实现把版本号写死且"已存在就跳过"，导致内置核心永远停在旧版本。）
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const NODE_VERSION = 'v24.19.0';
const NODE_DIR_NAME = `node-${NODE_VERSION}-win-x64`;
const DSH_PACKAGE = '@deepseek-ai/dsh';
const RESOURCES = path.join(ROOT, 'resources');

const MIRROR = process.env.NODE_DOWNLOAD_MIRROR || 'https://npmmirror.com/mirrors/node';
const NPM_REGISTRY = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';

// npm 11 起默认不执行依赖的安装脚本；这些是 dsh 运行必需的原生模块与辅助脚本。
// 不显式放行会导致 koffi / node-pty 等原生二进制缺失，dsh 起来就崩。
const ALLOW_SCRIPTS = [
  '@deepseek-ai/dsh-subprocess-local',
  'koffi',
  'node-pty',
  '@google/genai',
  'protobufjs',
];

function log(msg) {
  console.log(`[prepare] ${msg}`);
}

function run(cmd, args, opts) {
  log(`${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

function readVersion(pkgJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version || '';
  } catch {
    return '';
  }
}

/** 目标版本：命令行参数 > DSH_VERSION > registry 最新版 */
function resolveTargetVersion(nodeExe, npmCli) {
  const explicit = process.argv[2] || process.env.DSH_VERSION;
  if (explicit && explicit.trim()) {
    log(`使用指定版本: ${explicit.trim()}`);
    return explicit.trim();
  }
  const out = execFileSync(
    nodeExe,
    [npmCli, 'view', DSH_PACKAGE, 'version', `--registry=${NPM_REGISTRY}`],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 }
  );
  const v = out.trim().split(/\r?\n/).pop().trim();
  log(`registry 最新版本: ${v}`);
  return v;
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

  // 2. 内置 DSH 核心（按版本判定，版本变化则重装）
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) {
    log('Node 缺少 npm，请重新解压 Node 绿色版');
    process.exit(1);
  }

  const dshDir = path.join(RESOURCES, 'dsh');
  const bundleDir = path.join(dshDir, 'bundle');
  const tarOutput = path.join(dshDir, 'dsh-core.tar');
  const dshPkg = path.join(bundleDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');

  const target = resolveTargetVersion(nodeExe, npmCli);
  const installed = readVersion(dshPkg);

  if (installed === target) {
    log(`内置核心已是最新: ${target}`);
  } else {
    log(`内置核心需要更新: ${installed || '(未安装)'} → ${target}`);
    // 清掉旧产物，避免新旧版本混用
    fs.rmSync(bundleDir, { recursive: true, force: true, maxRetries: 2 });
    fs.rmSync(tarOutput, { force: true });
    fs.mkdirSync(bundleDir, { recursive: true });

    // npm 11 起依赖安装脚本默认被拦，且 --allow-scripts 参数在 --prefix 模式下不可用，
    // 必须落到安装根的 .npmrc。缺了它 koffi / node-pty 等原生二进制不会落地，
    // 干净电脑上 dsh 一起来就会因缺原生模块崩溃。
    fs.writeFileSync(
      path.join(bundleDir, '.npmrc'),
      `allow-scripts=${ALLOW_SCRIPTS.join(',')}\n`,
      'utf8'
    );

    log(`安装 ${DSH_PACKAGE}@${target} 到 resources/dsh…`);
    run(
      nodeExe,
      [
        npmCli,
        'install',
        '--prefix', bundleDir,
        `${DSH_PACKAGE}@${target}`,
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        `--registry=${NPM_REGISTRY}`,
        '--loglevel=warn',
      ],
      { timeout: 30 * 60_000 }
    );

    const after = readVersion(dshPkg);
    if (after !== target) {
      log(`安装后版本为 ${after || '(未知)'}，与目标 ${target} 不符`);
      process.exit(1);
    }
    log(`DSH 核心就绪: ${after}`);
  }

  // 3. 打包为单文件归档（防止 NSIS 解压数万小文件时卡住进度条）
  if (fs.existsSync(bundleDir)) {
    if (fs.existsSync(tarOutput)) {
      log(`归档已存在: ${tarOutput}`);
    } else {
      log('正在生成 dsh-core.tar...');
      // 必须用 Windows 自带 tar：Git Bash 的 MSYS tar 会把 "D:\..." 当成远程主机而报
      // "Cannot connect to D: resolve failed"
      const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      run(systemTar, ['-cf', tarOutput, '-C', dshDir, 'bundle']);
      log(`dsh-core.tar 就绪: ${tarOutput}`);
    }
  }

  log('完成。现在可以执行 npm run dist 打包。');
}

main();
