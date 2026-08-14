# DeepSeek Harness 桌面应用

把 DeepSeek Harness（DSH）做成双击即用的 Windows 桌面应用，图标为**黑色鲸鱼**（DeepSeek 官方鲸鱼标志改色）。

## 使用

- **双击** `dist\DeepSeek-Harness-1.0.0-portable.exe` 直接运行（绿色版，无需安装）。
- 或者运行 `dist\DeepSeek-Harness-1.0.0-setup.exe` 安装（开始菜单 + 桌面快捷方式）。

## 与 GitHub 同步更新

本应用的核心引擎是 npm 全局包 `@deepseek-ai/dsh`（上游即 GitHub 仓库
`deepseek-ai/deepseek-harness`，GitHub 更新后通过 npm 发布新版本）。
应用通过 npm registry 与 GitHub 发布保持同步：

- **启动自动检查**：窗口打开约 2.5 秒后后台检查一次，发现新版本弹出提示：
  「立即更新 / 稍后提醒 / 跳过该版本」（跳过的版本不会重复打扰）。
- **一键更新**：「立即更新」在后台执行
  `npm install -g @deepseek-ai/dsh@<新版本>`，自动处理 npm 的
  allow-scripts 脚本白名单（检测到拦截会按 npm 给出的精确列表重装一次，
  保证原生模块与子进程 helper 完整构建）。
  - 应用自己启动的服务 → 更新后**自动重启服务**，立即生效；
  - 接入的既有服务 → 提示重启该服务后生效。
- **手动检查**：菜单「帮助 → 检查更新」；「帮助 → 关于」显示外壳版本与核心版本。
- 跳过/更新状态记录在 `%APPDATA%\DeepSeek Harness\update-state.json`。

## 工作原理

应用启动时会：

1. 探测 `127.0.0.1:3080`（或 `DSH_PORT` 指定的端口）是否已有 DSH 服务：
   - **已存在** → 直接接入，窗口只是该服务的原生外壳；退出应用不会关掉它。
   - **不存在** → 自动定位本机安装的 `dsh`（全局 npm 安装），以
     `dsh web --host 127.0.0.1 --port <端口>` 方式在后台启动服务，
     就绪后打开窗口；**关闭窗口会连同服务进程一起退出**。
2. 端口被其他程序占用时，自动换一个空闲端口启动。
3. 单实例：重复双击只会聚焦已打开的窗口。

## 目录结构

```
package.json          Electron 工程与 electron-builder 打包配置
src/main.js           主进程：服务探测/启动、窗口、生命周期
src/splash.html       启动画面（黑色鲸鱼 + 加载动画）
scripts/make-icon.js  图标生成脚本（SVG → PNG/ICO，并与官方图标做形状比对）
build/icon.svg        黑色鲸鱼矢量母版
build/icon.png        512x512 图标
build/icon.ico        多尺寸 Windows 图标（16–256）
dist/                 打包产物（portable + 安装包）
```

## 开发

```powershell
npm install                 # 安装依赖（electron / electron-builder / sharp / png-to-ico）
npm run icon                # 重新生成图标
npm start                   # 开发模式运行
npm run pack                # 打包（portable + nsis）
```

开发/排障参数：

- `--smoke-test`：启动、加载页面、把结果写入 JSON 后自动退出（0=成功）。
- `--smoke-log <path>`：smoke 报告输出位置。
- `--port <n>`：指定服务端口（默认 3080，或环境变量 `DSH_PORT`）。
- `--update-check-test <path>`：只跑更新检查并写出决策 JSON（不弹窗、不建窗口）。
- `--update-install-test <prefix>`：把最新版安装到临时 prefix 验证更新命令（不触碰全局安装）。
- 环境变量 `DSH_CLI` / `DSH_NODE`：手动指定 dsh 的 `lib/bin.js` 与 `node.exe`。
- 环境变量 `DSH_UPDATE_URL`：覆盖更新检查地址（测试用）。
- 日志：`%APPDATA%\DeepSeek Harness\logs\`（main.log、cli-cache.json）。
