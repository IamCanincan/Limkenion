# Limkenion 桌面启动器（纯 Node · 零依赖 · 跨平台无终端）

把本地 Node 服务 + 浏览器界面包装成「双击即用、全程不弹终端」的桌面入口。
底层仍是 `web/` 那套 Vite 前端 + Node 服务，**没有引入 Electron / Chromium，也不需要打包**。

> ⚠️ **使用前必读**：本启动器已**内置 Node.js（MIT 许可，许可证见 `node/LICENSE`）**，
> 解压即双击可用，**无需安装 Node**。仅当内置 Node 被误删、且系统也未安装 Node 时，双击才会弹图形提示框引导安装（不会静默崩溃）。
> 若想先确认，根目录 `NEEDS_NODE.txt` 也写明了这一点。

## 前提
- **已内置 Node.js（MIT 许可），零安装即可运行**。三个平台入口优先使用包内 Node：
  - Windows：`node\win-x64\node.exe`
  - macOS：`Limkenion.app/Contents/Resources/node/<架构>/node`（随 .app 一起移动）
  - Linux：`node/linux-x64/node`
  - 包内 Node 缺失时回退系统 `node`，仍缺失才弹图形提示框。
- 前端已构建（首次运行若 `dist/` 缺失，启动器会自动执行一次 `npm run build`）。

## 各平台用法

### Windows
双击 **`limkenion.vbs`** 即可。
- 用 WScript 以「隐藏窗口」样式运行 `launcher.mjs`，**不会弹出任何 cmd / PowerShell 黑框**。
- 第一次使用若 `dist/` 未构建，会在后台构建（稍等几秒浏览器自动打开）。
- 想放开始菜单/任务栏：右键 `limkenion.vbs` → 发送到「桌面快捷方式」或固定。

### macOS
把 **`Limkenion.app`** 拖进「应用程序」文件夹，双击打开。
- Finder 直接执行 `Contents/MacOS/limkenion`，**不会打开 Terminal**。
- 首次需赋予可执行权限（仓库里已带，若被清掉就跑一次）：
  ```bash
  chmod +x Limkenion.app/Contents/MacOS/limkenion
  ```
- 若系统提示「无法验证的开发者」，右键 → 打开，或在「系统设置 → 隐私与安全性」里允许。

### Linux
给 `limkenion.sh` 和 `limkenion.desktop` 加执行权限，再把 `.desktop` 放到应用菜单或桌面：
```bash
chmod +x limkenion.sh limkenion.desktop
# 安装到当前用户应用菜单：
cp limkenion.desktop ~/.local/share/applications/
# 或放到桌面：
cp limkenion.desktop ~/Desktop/
```
- `.desktop` 里 `Terminal=false`，双击**不弹终端**。
- 若桌面环境拦截，右键 `.desktop` → 「允许启动」。

## 行为说明
- **单实例**：服务已在跑时，双击只打开浏览器、不会起第二个服务。
- **退出**：关掉浏览器标签页不会杀服务（会话已落盘）。要停服务，结束 `launcher.mjs` / 服务进程即可（Windows 任务管理器，mac/Linux `pkill -f server/index.mjs`）。
- **日志**：服务输出写在同目录 `limkenion.log`，便于排查。
- **Computer Use / 预览面板 / Teams 工作台** 全部照常，因为底层仍是本地 Node 服务。

## 可选增强（未做，按需再加）
- 系统托盘常驻 + 快速退出：加 `systray`（纯 Node，三平台通用）。
- 免装 Node 的独立 exe：用 `pkg`/`nexe` 把 Node 运行时缝进去（需处理 ESM 动态 import 兼容）。
- 安装包分发（NSIS/dmg/AppImage）：需 Electron-builder 类工具，届时就不再是纯 Node 方案。

## 安装与更新（一份 zip 三平台通用）
- **出包**：在 `web/` 下 `npm install && npm run build`，然后 `npm run release`（= `node ../scripts/package-release.mjs`），
  在 `web/release/` 生成 `limkenion-web-<版本>.zip`。zip 内含预构建 `dist/`、`server/`、仅 `ws` 的 `node_modules`、**内置的官方 Node 二进制（MIT 许可）**、三个平台入口与 `version.json`，**一份包 Windows/macOS/Linux 通用，用户无需安装 Node**（出包时会从 nodejs.org 拉取最新 LTS 的 Node 二进制打进包）。
- **更新**：界面右上角「检查更新」按钮 → 服务端 `/api/check-update` 比对 `version.json` → 有新版本时点一下即下载覆盖并自动重启。
  - 更新源通过环境变量 `LIMKENION_UPDATE_URL` 指定（指向一份 `version.json`，含 `version` 与 `assetUrl` 下载地址）。未配置时按钮提示「已是最新 / 未配置更新源」。
  - 启动器每次启动也会自检（同样需 `LIMKENION_UPDATE_URL`）；设 `LIMKENION_AUTO_UPDATE=1` 可开启静默自动更新。
  - 出包时设 `LIMKENION_RELEASE_URL=<zip 下载地址>` 会把下载地址写进 `version.json`，省去手动配置。
