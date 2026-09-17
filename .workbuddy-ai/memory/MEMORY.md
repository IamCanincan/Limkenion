# Limkenion 项目长期记忆

## 用户明确要求（2026-09-17 复述，优先级最高）
1. **CLI + Web 双端**都要，功能语义对齐。
2. **只依赖 Node**，不引入新运行时（不要 Bun/Deno/Python）。
3. **以"高效编码"为目的** —— 判断取舍的标准是写代码好不好用，不是功能多。
4. **只支持 DeepSeek**，不做其他供应商。
5. **尽量不要删功能；发现问题先提出来，不要擅自删。**（这条覆盖了早先"保持现状"的口径：
   现在是"不删 + 先报告"）
6. 是**本地 agent**，无云、无账号。
7. **DeepSeek 模型以官网/接口为准，不要凭印象写死。**
   2026-09-17 实测 `GET https://api.deepseek.com/models` 返回两个：
   **`deepseek-flash`** 与 **`deepseek-v4-pro`**（`deepseek-flash` 确实存在）。
8. **API key 由用户自己输入** —— 所以 `/login` 应该真的能录入并持久化 key，
   而不是现在这样只显示"去设环境变量"。
9. 参照实现在 `D:\下载\agent\`：`pi`（首选简单参照）、`deepseek-harness`、`codex`、
   `opencode`、`deepseek-reasonix`、`upstream-ref-impl`（本仓库缺失模块的来源）、
   `CC-code-source-code-leak`。

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
- **源码不得出现英文单词 `CC` / `上游兼容` / `内部代号`**。2026-09-17 已清干净：
  `内部代号` 全仓 0 命中；`CC|上游兼容` 仅 `scripts/build-cli.mjs` 的 `BRAND_TOKENS` 清洗名单
  还含（**故意保留**，它就是用来从产物里抹掉它们的）。
- 已删：`services/oauth/`、`/setup-token`、订阅/计费、云供应商真实路由。
- 保留：命令体系、plan/权限/沙箱、MCP、plugins/skills/子代理、memory(CC.md)、hooks、CI/headless、IDE 扩展。
- **判断"是否 OpenAI 兼容模式"只许用 `isOpenAICompat()`**（`utils/model/providers.ts`），
  不要硬比 `process.env.LIMKENION_API_PROVIDER === 'openai'`。
  2026-09-17 踩过：三处硬比导致只设 `DEEPSEEK_API_KEY` 时 queryModel 落到已移除的上游 SDK 路径，
  每次请求必报"上游 client 已移除"（commit 26d53b0 已修）。
  `isOpenAICompat()` 的取 key 顺序必须与 `services/api/openai-compat.ts` 的 `getConfig()` 保持一致。
- 上游 SDK 已不存在（`types/llm-protocol.ts` 里的 `Limkenion` 只是会抛错的占位类），
  **任何非兼容路径都是死路**，`.beta` / `.messages` 一碰就抛。
- 官方插件市场自动安装**默认关闭**（云端源不存在）；要开得显式设
  `LIMKENION_ENABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`。
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
- **非交互跑 CLI 必须先设 `LIMKENION_GIT_BASH_PATH`**：本机 bash 在
  `C:\Users\20653\.workbuddy-ai\binaries\PortableGit\versions\1.2.0\usr\bin\bash.exe`（不在系统 PATH），
  否则 `limkenion -p "..."` 直接报 "requires git-bash" 退出。
  冒烟命令：`limkenion -p "只回复两个字：收到" --no-session-persistence`。
- **单测某个源码模块**（如 `services/api/errors.ts` 的错误映射）：用 esbuild 打成单文件再 node 跑，
  `--banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"`
  **不能省**（否则 execa/cross-spawn 的 `Dynamic require` 直接炸），
  同时带上 `--alias:bun:bundle=./bun-bundle-stub.ts` 与 `--tsconfig=./tsconfig.json`。
  纯 node 直跑会撞 `Config accessed before allowed` —— 那是没走 bootstrap，不是 bug，别误判。
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
2. **已解决（2026-09-17，commit dd8eb9c）**：`utils/model/` 4 处中文注释里的 `CC`/`上游`
   已改写为中性表述。源码中现仅 `scripts/build-cli.mjs` 的 `BRAND_TOKENS` 清洗名单含这些词 ——
   那是**故意保留**的（它就是用来从产物里抹掉它们的），改动时别删。
3. **已解决（2026-09-17）**：`COMMENT_I18N_PLAN.md` 移入 `.workbuddy-ai/i18n/`（不进 git），
   注释中文化工程按用户决定**暂停**。
4. `HANDOFF.md`（已跟踪）记录源码树重建过程，开头已补"现状补充"块（commit 4cdae44）。
5. web 端真实引擎依赖 `DEEPSEEK_API_KEY`，未设置时降级 mock（工具不会被模型调用，但可直接单测）。
6. **`/login` 不做实际登录**：`components/ConsoleOAuthFlow.tsx` 只显示"设环境变量后重启"并等 Enter，
   不写 key。2026-09-17 已把其中那句假的"已连接 DeepSeek"改成实话。
   若要让 /login 真能录入并持久化 key，需另开一轮（要动 .tsx 结构，注意 react-compiler 记忆化）。
7. 用户机器上的 `DEEPSEEK_API_KEY`（尾号 06ae）2026-09-17 被 DeepSeek 判为 invalid
   （`curl https://api.deepseek.com/models` 直接 401）—— 属凭据问题，非代码问题。
   **key 值不要写进任何记忆文件**。
