# Limkenion 项目长期记忆

## 项目性质
`D:\Github Repositories\Limkenion` 是一个 **CLI（Limkenion 终端 REPL）+ web 界面** 的双端 agent harness。

- **CLI 侧**（仓库根）：fork 自 上游 CLI 原型 的 React/ink CLI，源码是 **react-compiler 编译产物**
  （`.tsx` 带 `_c(N)` / `$[N]` / `Symbol.for("react.memo_cache_sentinel")` 记忆化结构）。
  **只能改字符串文案 / 删整块 / 改小逻辑，不能重排结构。**
- **构建已打通**（2026-09-16 重建，2026-09-17 复核）：`package.json` / `tsconfig.json` / `.gitignore` 已补齐，
  缺失的 174 个模块已由 `scripts/restore-missing-files.mjs` 从 `D:/下载/agent/upstream-ref-impl` 补齐改名。
  `node scripts/build-cli.mjs` → `dist/cli.mjs`（27MB，esbuild ESM bundle）**0 错误**。
- **web 侧**（`web/`）：Vite + React 18 + 自研本地服务（Node，无框架），可构建可运行。
- 仓库**是 git 仓库**（`.git`，分支 `master`）。历史备份：`..\Limkenion_backup_2026-09-16.tar.gz`，
  被移除的模块在 `..\Limkenion_removed`。

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

## 注释中文化工程（**已暂停**，2026-09-17 用户决定）
- 计划与术语表在 `.workbuddy-ai/i18n/COMMENT_I18N_PLAN.md`（原在仓库根，同日移入，不进 git），共 28 批。
- 剩余约 65k 行 / 1,472 个文件；`batches/` 40 个批次文件、`_backup/` 20 个备份已就位，恢复时直接接着跑。
- **第 69–120 行是术语表**，并行子代理提示词引用这个位置 —— 别删这个文件，它是流水线的一部分。
- 形态：**纯中文替换**（不留双语对照）；JSDoc 的 `@param`/`@returns` 标签名保留、描述翻译。
- 红线：协议字段值（`'user'`/`'assistant'`/`'tool_use'` 等）、命令名、工具名、
  枚举值、JSON 键、env 变量名、字符串里的 `//` 一律不动。术语（agent、schema、
  MCP、LSP、ANSI 等）保留原文。
- **验收靠 esbuild 指纹**：`transform({minifyWhitespace:true, minifySyntax:false,
  minifyIdentifiers:false, legalComments:'none'})`，改前改后指纹必须一致
  （不一致即动了代码，回滚该文件）。CLI 树无 tsconfig，只能语法级校验。
- 仓库**已有 `.git`**，可 `git diff` 回退；但首次执行某批前仍建议先存改前指纹基线做交叉校验。
- 规模参考：全仓 2059 个 TS/JS 文件、**无 .py 文件**；英文注释 67,677 行，
  `utils/` 独占 49%。
- 服务端模块是**单向依赖**：paths → config/bus → sessions/security/workspace →
  interactions/toolindex → engine → commands → protocol → index。新增模块别引入反向依赖
  （需要回调就用钩子，如 `onSessionDeleted`）。

## 硬约束与每轮惯例（纯本地 DeepSeek 版）
- **无任何在线账号 / OAuth / 订阅 / 云供应商**。登录 = 设置 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`
  （OpenAI 兼容端点，默认 `https://api.deepseek.com`），模型只有 `deepseek-flash`。
- **源码不得出现英文单词 `CC` / `上游兼容` / `内部代号`**（2026-09-17 复核：`内部代号` 全仓 0 命中；
  `CC|上游兼容` 仅剩 4 处中文注释提及，见未决事项）。
- 已删：`services/oauth/`、`/setup-token`、订阅/计费、云供应商真实路由。
- 保留：命令体系、plan/权限/沙箱、MCP、plugins/skills/子代理、memory(CC.md)、hooks、CI/headless、IDE 扩展。
- **每轮改完的惯例**：`node scripts/build-cli.mjs` 必须 0 错误 → `npm install -g .` → git commit
  （**切莫动 git config，不 push**）。全局命令 `limkenion` 已安装。
- `scripts/build-cli.mjs` 内置两道 post-build 清洗：品牌 token 中性化（`CCBot`/`上游` → `Limkenion*`）
  与 `oauth token` → `authorization credential`；清洗后会断言产物中无残留。改 bundle 逻辑时别绕过它。

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


## 未决事项（2026-09-17 复核）
1. **D 类"半坏残留"实测是承重的，不能直接删**：
   - `constants/oauth.ts`（203 行）：被 12+ 处导入（`main.tsx`、`services/api/*`、`assistant/sessionHistory.ts`、
     `components/mcp/MCPRemoteServerMenu.tsx` 等），导出 `getOauthConfig` / `fileSuffixForOauthConfig` /
     `OAUTH_BETA_HEADER` / scope 常量。删除会直接断构建。
   - `utils/model/bedrock.ts`（265 行）：`getInferenceProfileBackingModel` 在 `services/api/limkenion.ts:1096`
     与 `services/tokenEstimation.ts:455` 的**活路径**上被调用。
   - `commands/oauth-refresh/index.js`：已是 1 行中性 stub（`isEnabled: () => false`），由 `commands.ts:195` 导入，无害。
   - `stubs/bedrock-sdk.ts`：由 `tsconfig.json` 的 `paths` 映射 `@limkenion-ai/bedrock-sdk`，无显式 import。
   - `services/mcp/oauthPort.ts`：**正当保留**（远程 MCP OAuth），被 `services/mcp/auth.ts`、`xaaIdpLogin.ts` 使用。
2. `utils/model/{model.ts:180, modelOptions.ts:436, providers.ts:8,19}` 有 4 处中文注释里出现
   `CC` / `上游` 字样（"不回落到 CC 系 Sonnet 硬默认"等）。注释不进 bundle，构建断言不报错；
   但严格按"源码不得出现英文单词"的约束看算残留，是否改写待用户定。
3. `COMMENT_I18N_PLAN.md`（仓库根，未跟踪）是旧注释翻译计划，去留待用户定；`.workbuddy-ai/i18n/` 下
   有 40 个批次文件 + 20 个备份，注释中文化工程实际处于中途。
4. `HANDOFF.md`（已跟踪）记录源码树重建过程，内容仍准确，但提到的 174/175 缺失已补完。
5. web 端真实引擎依赖 `DEEPSEEK_API_KEY`，未设置时降级 mock（工具不会被模型调用，但可直接单测）。
