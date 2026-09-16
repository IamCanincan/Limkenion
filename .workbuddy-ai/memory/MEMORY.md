# Limkenion 项目长期记忆

## 项目性质
`D:\Github Repositories\Limkenion` 是一个 **CLI（Limkenion 终端 REPL）+ web 界面** 的双端 agent harness。

- **CLI 侧**（仓库根）：部分还原的 TypeScript 源码树，1830 个 `.ts/.tsx`。
  **当前无法 typecheck / 构建**：无 `package.json` / `tsconfig.json` / `.gitignore`，
  1060 处 `src/*` 路径别名导入没有 tsconfig 映射，且 **175 个被导入的模块文件缺失**
  （`types/message.ts`、`types/tools.ts`、`utils/taskSummary.ts`、`cli/transports/Transport.ts` 等）。
  缺失是源码树本身不完整，不是某次删除造成的（比对过 19:45 的备份包）。
- **web 侧**（`web/`）：Vite + React 18 + 自研本地服务（Node，无框架），**可构建可运行**，是当前主交付物。
- 仓库**不是 git 仓库**（无 `.git`）。被移除的模块放在同级 `..\Limkenion_removed`，
  备份包在 `..\Limkenion_backup_2026-09-16.tar.gz`。

## 项目约定
- **双端功能必须对齐**：CLI `tools/` 目录与 `commands/` 目录是能力基准，
  web 端要镜像全部工具与命令语义；终端专属的（登录/Git/IDE/MCP 等）必须给出**明确不可用原因**，
  不能静默失败或含糊带过。
- **对齐准确性由 `web/test/drift.test.mjs` 守**：它解析 CLI `tools/*/` 的 `inputSchema` 逐参数比对镜像 schema。
  改了 web 端工具参数名，这个测试会立刻发现漂移。CLI 源码树缺失时自动跳过。
- web 端沙箱固定为工作区根（`LIMKENION_WEB_WORKSPACE`，默认 CLI 源码根），所有文件工具做路径越界校验。
- 危险工具执行前必须弹窗确认：Bash、PowerShell、REPL、Write、Edit、NotebookEdit、CronCreate。
- **服务默认只绑 127.0.0.1**，WS 握手要一次性 token + Origin 校验；改动协议层时别把这两道去掉。
- **shell 守卫与不可信内容升级确认优先级最高**：不受 `bypassPermissions` 与「本会话总是允许」影响。
- 注释与用户可见文案用中文，代码标识符用英文；缩进 2 空格，无分号结尾（与既有风格一致）。
- 服务端模块是**单向依赖**：paths → config/bus → sessions/security/workspace →
  interactions/toolindex → engine → commands → protocol → index。新增模块别引入反向依赖
  （需要回调就用钩子，如 `onSessionDeleted`）。

## 服务端模块地图（web/server/）
`index.mjs` 只做装配启动；`paths.mjs` 路径与沙箱；`config.mjs` 常量与设置；
`bus.mjs` 连接注册表与广播；`security.mjs` 鉴权/shell 守卫/注入隔离；
`sessions.mjs` 会话与持久化；`workspace.mjs` 文件索引缓存；`interactions.mjs` 权限与问答；
`tools.mjs` 工具集（41 个，含 schema）；`toolindex.mjs` 延迟加载；
`engine.mjs` 回合循环与子代理与定时；`commands.mjs` 斜杠命令；`static.mjs` HTTP；`protocol.mjs` WS。


## 环境要点
- 本机有 HTTP 代理（`HTTP_PROXY=http://127.0.0.1:7907`）：
  - 访问 localhost 必须 `curl --noproxy '*'`，否则拿到代理的 502。
  - Node 的 `fetch` 直连可用；**DuckDuckGo 被墙/超时，Bing 可用**（WebSearch 以 Bing 为数据源）。
- 机器上**没有 agent-browser**，且不允许全局 npm 安装。
  验证 React 组件能否渲染的替代方案：esbuild 打包成 **CJS** + `react-dom/server` 的 `renderToString`。
- 托管 Node：`C:\Users\20653\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe`
- 托管 Python：`C:\Users\20653\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe`
- 系统 Node：`D:\nodejs\node.exe`（v24.20.0）+ `D:\nodejs\npm.cmd`（npm 11.19.0）。

## 全局命令 limkenion-web
- 已全局安装，是**软链**：`C:\Users\20653\AppData\Roaming\npm\node_modules\limkenion-web`
  → `D:\Github Repositories\Limkenion\web`，源码改动即时生效，无需重装。
- 用户级全局 bin 目录 `C:\Users\20653\AppData\Roaming\npm` 已在 PATH。
- **Git Bash 里 `APPDATA` 为空**，直接跑 npm 会把 prefix 解析成
  `<cwd>\${APPDATA}\npm`。用系统 npm 做全局操作前必须
  `export APPDATA='C:\Users\20653\AppData\Roaming'`。
- 打包分发：`cd web && npm pack` → 30 个文件（含预构建 `dist`，排除 `.map`）；
  运行时仅依赖 `ws`，已在 `dependencies`（React/Vite 等构建依赖在 `devDependencies`）。


## 未决事项
1. 仓库无 `.gitignore`，一旦 `git init` 会把 `web/node_modules`（69MB）与 `web/dist` 一起纳入。
2. CLI 侧若要恢复构建，需补那 175 个缺失模块，或加 `tsconfig.json` 把 `src/*` 映射到根目录。
3. web 端真实引擎依赖 `DEEPSEEK_API_KEY`，未设置时降级 mock（工具不会被模型调用，但可直接单测）。
