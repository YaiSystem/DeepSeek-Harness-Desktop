# DeepSeek Harness Desktop

DeepSeek Harness 桌面版：把原本需要敲命令才能用的 DeepSeek Harness 做成了 Windows 桌面应用，双击图标就能用。

## 是什么

DeepSeek Harness 是一个 AI 编程助手，官方以命令行工具的形式发布，使用前要先在终端里执行命令。这个项目给它加了桌面外壳，变成普通 Windows 软件：双击打开、窗口里对话、关闭退出。

## 优势

- 不用记命令：双击图标自动完成启动，不需要接触终端
- 自动管理服务：本地没有服务在运行，应用会自动拉起来；已经跑着就直接接进去用
- 自动更新：打开应用时检查新版本，有更新弹窗提示，点一下就能升级
- 全中文：界面提示和工具说明都是中文
- 图标是黑色的 DeepSeek 鲸鱼

## 安装前提条件

1. 已安装 Node.js（https://nodejs.org）
2. 已安装 DeepSeek Harness 命令行工具，在终端执行：

   ```
   npm install -g @deepseek-ai/dsh
   ```

## 安装

从 [Releases](https://github.com/YaiSystem/DeepSeek-Harness-Desktop/releases) 页面下载最新的 `DeepSeek-Harness-x.x.x-setup.exe`，双击安装，完成后桌面和开始菜单会出现 DeepSeek Harness 图标。

第一次打开时 Windows 可能提示「已保护你的电脑」，点「更多信息 → 仍要运行」即可（应用未做代码签名）。

## 使用

双击桌面图标，稍等几秒进入对话界面。发现新版本时应用会提示更新，点「立即更新」即可；也可以在菜单「帮助 → 检查更新」里手动检查。

## 常见问题

**关掉窗口会影响正在跑的服务吗？**

应用自己拉起的服务会一起关闭；接入的已有服务不受影响。

**双击后一直停在启动画面？**

先确认上面安装前提条件里的两项都装好了。

## 开发者

打包：`npm install` 之后执行 `npm run pack`。
