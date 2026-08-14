# DeepSeek Harness Desktop 🐳

把 DeepSeek Harness 装进一个真正的 Windows 桌面应用——**双击黑鲸鱼图标就能用**，不用敲命令、不用开终端。

DeepSeek Harness 本身是一个命令行工具，这个项目给它包了一层桌面外壳，让它变成普通用户也能直接使用的软件。

## 🎁 功能亮点

| 功能 | 说明 |
|---|---|
| 🖱 双击即用 | 双击图标自动完成所有准备工作，几秒后直接进入对话界面 |
| 🐳 黑色鲸鱼图标 | 由 DeepSeek 官方鲸鱼标志改色而来，应用图标、任务栏、安装包全程统一 |
| 🔄 自动更新 | 每次打开都会检查上游版本（与官方 GitHub 仓库的发布完全同步），发现新版本弹窗提示，一键升级 |
| 🇨🇳 全中文 | 界面提示、工具简介、参数说明、推理过程全部中文 |
| 🔌 智能接入 | 已经有服务在运行就直接接进去用；没有就自动拉起；端口被占用会自动换一个空闲端口 |
| 🪟 单实例 | 重复双击只会把已打开的窗口调到前台，不会开出一堆窗口 |
| 🧹 干净退出 | 应用自己拉起的服务会跟着窗口一起退出，不留后台残留 |

## 📥 下载与安装

前往 [Releases](https://github.com/YaiSystem/DeepSeek-Harness-Desktop/releases) 页面，下载最新的 `DeepSeek-Harness-x.x.x-setup.exe`：

1. 双击运行安装程序
2. 安装完成后，桌面和开始菜单都会出现「DeepSeek Harness」
3. 双击图标即可使用

> 💡 第一次运行如果 Windows SmartScreen 提示「已保护你的电脑」，这是未签名应用的正常提示：点「更多信息 → 仍要运行」即可。

## 🚀 使用

1. 双击桌面的「DeepSeek Harness」图标
2. 看到黑色鲸鱼启动画面，稍等几秒
3. 主窗口打开后，像使用网页版一样开始对话即可

**关于更新**：上游（GitHub 官方仓库）发布新版本后，打开应用时会弹出更新提示，点「立即更新」等待完成即可；也可以随时在菜单「帮助 → 检查更新」手动检查。

## ❓ 常见问题

**打开时提示「Windows 已保护你的电脑」？**
应用未做代码签名，这是正常提示，选择「仍要运行」。

**点了「立即更新」后提示「重启服务后生效」？**
说明当前窗口连接的是另一个已经在运行的服务，更新已下载完成，重启那个服务后即生效。

**双击后一直停在启动画面？**
应用需要本机装有 Node.js 和 DeepSeek Harness 命令行工具。首次使用前请在终端执行：
```
npm install -g @deepseek-ai/dsh
```

**为什么有时打开很快、有时要等？**
如果电脑上已经有服务在运行，应用会直接接入（打开很快）；否则需要先帮你把服务拉起来（会多等几秒）。这是正常现象。

**关掉窗口会把我正在跑的服务关掉吗？**
如果是应用自己拉起的服务，会一起关闭；如果是接入的已有服务，不会动它。

## 🛠 开发者

重新打包：

```powershell
npm install
npm run icon    # 重新生成黑色鲸鱼图标
npm run pack    # 打包安装版
```

国内网络打包时建议先设置镜像：
```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```
