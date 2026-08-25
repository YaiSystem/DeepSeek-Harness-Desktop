'use strict';

/**
 * 安全启动器：
 *
 * 在 Electron 宿主环境（如 WorkBuddy、VSCode 等）的终端里直接跑 `electron .` 时，
 * 会继承宿主进程注入的 ELECTRON_RUN_AS_NODE=1，导致 electron.exe 以纯 Node 模式
 * 启动、require('electron') 返回路径字符串、app 为 undefined 而崩溃。
 *
 * 本脚本在拉起 electron 之前清除该变量，保证任何终端下 `npm start` 都能正常启动。
 * 等价于双击打包后的 exe（桌面进程不会继承该变量，因此不受影响）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

delete process.env.ELECTRON_RUN_AS_NODE;

const electronExe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const args = ['.', ...process.argv.slice(2)];

const child = spawn(electronExe, args, { stdio: 'inherit', env: process.env });

child.on('error', (err) => {
  console.error(`无法启动 electron: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
