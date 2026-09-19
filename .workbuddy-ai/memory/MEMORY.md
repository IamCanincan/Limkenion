# Limkenion 项目长期记忆

> 本文件自动注入，**必须精简**（超上限会被截断 = 接力断掉）。
> 分阶段全账 / 细节清单 → 同目录 **`MEMORY-details.md`**；逐轮流水 → `YYYY-MM-DD.md`；
> 最新交接 → 同目录 **`HANDOFF.md`**。**加内容前先想清楚放哪一份。**

---

## 用户明确要求（最高优先级，别自作主张改）
1. **只做 web 界面**：CLI 已停止维护，工作树与 git 分支（本地 + 远程）均已删除。
2. **只依赖 Node**，不引入新运行时（不要 Bun/Deno/Python/Electron）。
3. **以"高效编码"为目的** —— 取舍标准是写代码好不好用。
4. **只支持 DeepSeek**（预留多供应商扩展点，但不做其他供应商）。
5. **尽量不要删功能；发现问题先提出来，不要擅自删。**
6. 本地 agent：无云、无账号、**无网站、无邮箱**。
7. **不写死单价/换算金额**（计费层已整体删除，只展示 token/时长/行数）。
8. **API key 由用户自己输入**（`/login` 录入并持久化）。**不要桌宠。**

## 项目性质与交付形态
`D:\Github Repositories\Limkenion` = **纯 web 项目**，分支 `master`，远程 origin = Gitee。
- **web/**：Vite + React 18 + 自研本地 Node 服务（同端口伺服静态页 + WebSocket），
  完全自包含（引擎/会话/工具/钩子/定时任务/MCP/Workflow/Teams），**零外部进程依赖**。
- **桌面分发 = Tier C 内置 Node**：`cd web && npm run release` 出一份三平台通用 zip
  （实测 448MB）。入口链路：包内 node 优先 → 系统 node 回退 → 都缺弹 GUI 提示。
  更新器 `web/launcher/updater.mjs` 跳过 `node/`，不覆盖内置 Node。`web/release/` 已 ignore。
- CI：Gitee Go（`.workflow/ci.yml`，push master 触发 typecheck + test + build）。

## 仓库红线
- **品牌词已全历史抹除**（`upstream-brand`/`upstream-brand`/`upstream-brand` 及变体，filter-repo 重写 + 强推；
  备份 bundle 在仓库外）。**任何新代码/注释/文档不得带回这些词**，
  解释设计来源用中性说法（如"参考通用 CLI agent 的设计"）。源码当前 **0 命中**。
- `.gitattributes`：`web/launcher/**` 锁 **LF**（仅 `.vbs` 锁 CRLF）、`scripts/**` 锁 LF。
- 记忆统一放 `.workbuddy-ai/memory/`（`.gitignore` 对该目录开了白名单）；
  `.workbuddy/` 是另一运行时的目录，已 ignore，**不要往那边写**。

## 硬约束与每轮惯例
- **无任何在线账号 / OAuth / 订阅 / 云供应商**。登录 = 设 `DEEPSEEK_API_KEY`
  （OpenAI 兼容端点，默认 `https://api.deepseek.com`）。
- **模型只有两个**：`deepseek-flash`（默认/快/支持 Vision）、`deepseek-v4-pro`（强/不支持图）。
- **判断"是否 OpenAI 兼容模式"只许用 `isOpenAICompat()`**：**它恒返回 `true`**，
  不是"检测"出来的。"用哪套协议"和"有没有配 key"是两件事，绝不能混进同一个判断。
- **每轮改完必跑四件套**（在 `web/`，用系统 node v24）：
  `npm run typecheck`（前端 + server 两套 tsc，**别用管道掩盖退出码**）→ `npm test`
  → `npm run test:ui`（vitest）→ `npm run build`（vite）。
  改了 **worktree / hooks / MCP / Workflow / 沙箱作用域 / 桌面入口** → 还要跑
  `npm run test:e2e`（真实 API，会花真 token，24 项 / 约 1 分钟）。
  改完 commit（**不 push、不动 git config** —— 要 push 必须用户明确说）。
- 注释与用户可见文案用中文，代码标识符用英文；缩进 2 空格，无分号结尾。

## 环境要点
- 有 HTTP 代理：访问 localhost 必须 `curl --noproxy '*'`；**DuckDuckGo 超时，Bing 可用**。
- Node：**测试/tsc/vite/E2E 用系统 v24**（`D:\nodejs\node.exe`）；
  **web 预览服务用托管 22.22.2**（`C:\Users\20653\.workbuddy\binaries\node\versions\22.22.2-3\node.exe web/server/index.mjs`）。
- **API key 从 `~/.limkenion.json` 的 `primaryApiKey` 取，别问用户**；
  web 服务只认环境变量，**没带 key 会静默退化成 mock**（看着"能用"，模型是假的）。
  查活服务：取 `limkenion-token` → 连 WS 发 `{type:'run_command', command:'/status'}`。
- Windows：`rm` 被安全策略拦 → 用 `mv` 移出仓库；**别从 bash 调 PowerShell**（用 PowerShell 工具）；
  `Remove-Item` 接管道对象会报参数绑定失败，用 `-LiteralPath $f.FullName` 逐个删；
  tar 一律**相对路径 + 指定 cwd**（bsdtar 把 `D:/...` 误判成远程主机）；
  Windows GNU tar **不解 .zip** → 用 PowerShell `Expand-Archive`。
- **服务端 JS 也在类型检查里**（`web/tsconfig.server.json`：allowJs + checkJs + noEmit，
  关 noImplicitAny / useUnknownInCatchVariables，**开 strictNullChecks**）。
  三个反复踩的推断坑：**空数组 → `never[]`**、**`.filter(Boolean)` 不收窄**、
  **初始值被推成字面量类型**（`result: null` / `let action = 'keep'`）。改契约时留意 JSDoc ——
  解构默认值 `= {}` 会把字段从推断结果里**整个漏掉**（runEventHooks 的 `hookInput` 就这么丢的）。

## DeepSeek 接口实测事实（不知道就会写出静默 bug）
Base `https://api.deepseek.com`；两套协议都原生支持，但**本项目只走 OpenAI**。
- **思考默认开启，且 reasoning token 计入 `max_tokens`** → **任何设了小 `max_tokens` 的调用点
  都可能静默返回空响应**（`reasoning_effort:'none'` 是唯一能完全关掉思考的档位）。
- **`reasoning_effort`**：`none`/`minimal`/`low`/`medium`/`high`/`max` 都接受，**`auto` → 400**。
  对外只暴露 low|medium|high|max（刻意不加 none）。
- **推理模式 + 强制 `tool_choice` 不可共存**（400）。适配器在"强制工具"时自动加 `reasoning_effort:'none'`。

## 当前状态（第 29 轮，2026-09-19 13:55）
**纯 web 项目，工作区干净、无待办技术债。** 对标能力已全部补齐：
- **钩子 27 事件 × 4 执行类型**（command/prompt/agent/http）；**MCP** stdio/http/sse +
  elicitation/OAuth 2.1/sampling/roots/prompts/registry 搜索；**自动 compact + microcompact**；
  **文件检查点**（/rewind 连文件回滚）；**后台 Bash**（TaskOutput/TaskStop）；
  **出站白名单** `LIMKENION_EGRESS_ALLOWLIST`；非回环绑定 LAN 鉴权；outputStyle 注入；
  LIMKENION.md/AGENTS.md instructions 加载；回合中排队消息；**localhost 预览面板**（PreviewUrl + iframe）；
  **Computer Use**（Windows PowerShell 零依赖，`LIMKENION_WEB_COMPUTER_USE=1`，非 Windows 自动禁用）；
  **Agent Teams 工作台**（TeamPanel + 成员事件流 + teammate-idle 钩子）；
  worktree + additionalDirectories（沙箱根**按会话可变**，AsyncLocalStorage）；
  WorkflowTool（vm 沙箱）；`/insights`。
- **验证基线**：typecheck 0 / **354 项测试 350 过 0 失败 4 跳过** / vitest 6/6 / build 通过 /
  **真实 E2E 24/24**（2026-09-19 实测）。
- **明确不做**（CC 生态专属，用户拍板）：插件/技能市场。
- **注释中文化：工作树已 100% 完成**（只剩 44 行 JSDoc 类型定义/枚举值/路径示例等不该译的行）。
  `.workbuddy-ai/i18n/COMMENT_I18N_PLAN.md` 的 B1–B28 计划**已过期**（B2–B27 针对已删的 CLI 树）。
- **CLI 树已彻底删除**（2026-09-19，用户拍板）：本地分支 + worktree + 远程分支全删，
  远程现只剩 `master`。两层保全在仓库外：bundle `limkenion-archive-cli-aa1ffaf.bundle`（~16 MB）
  + 47% 译文补丁 `limkenion-cli-i18n-wip-47pct.patch`（5 MB）。
  恢复：`git fetch <bundle> archive/cli:archive/cli` → `git apply <patch>`。详见 details 附八。

## 关键陷阱（都踩过，别再踩）
1. **删模块后必须跑冒烟** —— esbuild 只报"缺失导出"，不报类型错误；被删符号的**调用点**会静默变
   `undefined`，构建 0 错误、服务照常启动，执行到才炸。**删模块前把它 export 的每个符号都 grep 一遍。**
2. **`availability` 决定命令是否可见**，`commands.ts:meetsAvailabilityRequirement()` 在
   `isEnabled()` **之前**运行。判断"本地是否可见"必须同时看两个条件。
3. **`session.cancelled` 是共享布尔值，不能当"这个回合还活着吗"用** —— 按 Esc 后再发一条，
   协议层会把它置回 false，旧回合**复活**。判断回合存活一律用**回合代次**
   （`sessions.beginTurn` / `cancelSession` / `turnExpired`）。
4. **作用域要"每次调用重新解析"，不能在回合开头算一次** —— `EnterWorktree` 换掉
   `session.workspaceRoot` 后 AsyncLocalStorage 已进的那层不会更新，同一回合紧跟着的 Write
   还写老树，而 EnterWorktree 自己报成功（用户完全看不出来）。钩子进程的 cwd **和** 钩子输入
   JSON 的 `cwd` 都必须在作用域内构造（收**构造函数**而非收对象）。
5. **模块加载时的快照会漏掉运行时注册的东西** —— `DEFERRED_TOOL_NAMES` 原是常量，
   MCP 工具注册后**永远进不了延迟清单**。凡"运行时会长大的集合"，导出**函数**不要导出快照。
6. **用 shell 启动的子进程，超时不能只 `child.kill()`** —— 那只杀 shell，脚本进程活下来占着
   stdout 管道 → `close` 永不触发 → **整个回合挂死**。要**不等 close 直接结算** + 杀进程树。
7. **`ws?.readyState === ws.OPEN` 是假保护** —— 可选链只短路它自己那一段，右侧 `ws.OPEN`
   照样求值，ws 为 null 时抛 TypeError。**可选链不等于空值检查。**
8. **`npm test` 必须显式写 `node --test test/*.test.mjs`** —— 只写 `node --test` 会 glob 到
   `test/fixtures/`，把 MCP 桩服务当测试文件跑（全套 15 分钟 → 21 秒）。
9. **`node:vm` 不是安全边界**（工作流脚本）：挡得住 `require`/`process`（靠不注入），
   挡不住同步死循环 —— 只有顶层同步段能用 `runInContext({timeout})` 兜住。**把限制写进文案。**
10. **往"被 import 的目录"下新增文件 = 悄悄扩大类型检查面** —— `tsconfig.server.json` 的 include 是
    `server/**/*.mjs`，但 `server/static.mjs` import 了 `../launcher/updater.mjs`，TS 顺 import 一起检查，
    于是新加的 `launcher/` 直接让 typecheck 红了 5 个错。**加了新目录/新文件，一定要重跑 typecheck。**
> 陷阱 9–15 的完整版（测试桩游标、断言对象、E2E 抖动、子进程 shell 引号…）
> 见 `MEMORY-details.md` **附六**。

## 服务端模块地图（web/server/）
单向依赖：paths → config/bus → sessions/security/workspace → interactions/toolindex →
engine → commands → protocol → index。**新增模块别引入反向依赖**（要回调就用 `ctx` 注入）。
- `sessions.mjs`：会话存储 + 落盘 + **回合代次** + 沙箱根字段。
- `hooks.mjs` / `mcp.mjs` / `workflow.mjs` / `insights.mjs` / `worktree.mjs` / `computer.mjs` /
  `teams.mjs`。它们的宿主能力**一律经 `ctx` 注入**（`runSubAgent`/`callMcpTool`/`runWorkflow`…），
  **不要让 `tools.mjs` 反向 import 这些模块**（会成环）。
- `static.mjs`：静态页 + 只读路由（`/insights` 文件名走白名单正则，不接受路径拼接）
  + `GET /api/check-update` / `POST /api/update`。

## 接力提示
**新 agent 上手**：① 读本文件 → ② 读同目录 **`HANDOFF.md`** → ③ 按需读 `MEMORY-details.md`
→ ④ 改 `web/` 前加载 **`limkenion-web-verify`** 技能。CLI 技能已随归档失效。
**用户偏好**：不要反复问"选哪个"；说"继续"就是接着干。愿意为真功能付代价（安全边界/子系统重做
都已明确授权做过）；但**没被要求时不要擅自扩大权限边界**。
**当前没有待办技术债**；`master` 有若干**未推送**提交（用户不让 push，要推需明确指示）。
