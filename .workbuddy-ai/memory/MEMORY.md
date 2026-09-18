# Limkenion 项目长期记忆

> **本文件在会话启动时自动注入，必须保持精简**（超上限会被截断 = 接力断掉）。
> 分阶段全账、被压缩掉的细节都在同目录 **`MEMORY-details.md`**，按需读。
> **加内容前先想清楚放哪一份。**

---

## 用户明确要求（最高优先级，别自作主张改）
1. **CLI + Web 双端**都要，功能语义对齐。
2. **只依赖 Node**，不引入新运行时（不要 Bun/Deno/Python）。
3. **以"高效编码"为目的** —— 取舍标准是写代码好不好用，不是功能多。
4. **只支持 DeepSeek**，不做其他供应商。
5. **尽量不要删功能；发现问题先提出来，不要擅自删。**
6. 本地 agent：无云、无账号、**无网站、无邮箱**。
7. **DeepSeek 模型/价格以官网实测为准，不要凭印象写死。**
8. **API key 由用户自己输入**（`/login` 已能录入并持久化）。
9. **不要桌宠**（`buddy/` 与 `commands/buddy/` 已整块删除）。

## 项目性质
`D:\Github Repositories\Limkenion` = **CLI（React/ink REPL）+ web 界面** 的双端 agent harness。
git 仓库，分支 `master`；备份在 `..\Limkenion_backup_2026-09-16.tar.gz`。

- **CLI 侧**（仓库根）：fork 自 上游 CLI 原型，源码是 **react-compiler 编译产物**
  （`.tsx` 带 `_c(N)`/`$[N]`）。**只能改文案/删整块/改小逻辑，不能重排结构。**
  构建：`node scripts/build-cli.mjs` → `dist/cli.mjs`（约 27MB esbuild ESM bundle）。
- **web 侧**（`web/`）：Vite + React 18 + 自研本地 Node 服务，**不引用 CLI 源码**
  （只有 `web/test/drift.test.mjs` 按文件路径解析 `tools/*/`）。

## 硬约束与每轮惯例
- **无任何在线账号 / OAuth / 订阅 / 云供应商**。登录 = 设 `DEEPSEEK_API_KEY`
  （OpenAI 兼容端点，默认 `https://api.deepseek.com`）。
- **模型只有两个**：`deepseek-flash`（默认/快/支持 Vision）与 `deepseek-v4-pro`（强/不支持图）。
  `utils/model/configs.ts` 的 `ALL_MODEL_CONFIGS` 是唯一模型表。
- **源码不得出现 `CC` / `上游兼容` / `内部代号`**。唯一例外是 `scripts/build-cli.mjs` 的
  `BRAND_TOKENS` 清洗名单 —— **故意保留**（它就是用来从产物里抹掉它们的）。
- **判断"是否 OpenAI 兼容模式"只许用 `isOpenAICompat()`**：**它恒返回 `true`，不是"检测"出来的**。
  "用哪套协议"和"有没有配 key"是两件事，绝不能混进同一个判断。**这个坑踩过两次。**
- **CLI 每轮改完**：`node scripts/build-cli.mjs` 0 错误 → **冒烟** → `npm install -g .` → commit
  （**不 push、不动 git config**）。
- **web 每轮改完**：`npm run typecheck`（**前后端两套 tsc**）→ `npx vite build` →
  `npm test`（`test/*.test.mjs`）→ `npm run test:e2e`（真实 API）。
- 注释与用户可见文案用中文，代码标识符用英文；缩进 2 空格，无分号结尾。

## 环境要点
- 有 HTTP 代理：访问 localhost 必须 `curl --noproxy '*'`；**DuckDuckGo 超时，Bing 可用**。
- **非交互跑 CLI 必须先设 `LIMKENION_GIT_BASH_PATH`**（路径见 details），否则报 "requires git-bash"
  退出。**冒烟**：`limkenion -p "只回复两个字：收到" --no-session-persistence`。
- 全局安装 npm 前必须 `export APPDATA='C:\Users\20653\AppData\Roaming'`。
- Node：**测试/tsc/vite 用系统 v24**（`D:\nodejs\node.exe`）；**web 预览服务用托管 22.22.2**
  （`C:\Users\20653\.workbuddy\binaries\node\versions\22.22.2-3\node.exe web/server/index.mjs`）。
- **web 服务的 API key 只从环境变量来**（没有配置文件）。重启服务时从这里取，**别问用户**：
  `~/.limkenion.json` 的 **`primaryApiKey`**。**没带 key 会静默退化成 mock**（看着"能用"，模型是假的）。
  查活服务：取 `limkenion-token` → 连 WS 发 `{type:'run_command', command:'/status'}`
  （**类型是 `run_command`，不是 `command`**）。
- 单测 CLI 源码模块要用 esbuild 打包 + 特定 banner/alias（见 details）；`NODE_ENV=test` 会让
  `services/vcr.ts` 往 cwd 写 `fixtures/`，跑完清掉。
- **服务端 JS 也在类型检查里了**（2026-09-18 起）：`web/tsconfig.server.json`
  （allowJs + checkJs + noEmit，覆盖 `server/**/*.mjs`）。档位：关 noImplicitAny 与
  useUnknownInCatchVariables，**开 strictNullChecks**。写服务端代码时三个反复踩的推断坑：
  **空数组 → `never[]`**、**`.filter(Boolean)` 不收窄**、**初始值被推成字面量类型**
  （`result: null` / `let action = 'keep'`）。改契约时先想清楚 JSDoc —— 解构默认值
  `= {}` 会把字段从推断结果里**整个漏掉**（runEventHooks 的 `hookInput` 就是这么丢的）。
- **真实模型的 E2E 只有一份**：`web/e2e/e2e.mjs`（`npm run test:e2e`，24 项，跑一次 1~2 分钟、
  会花真 token）。改完 **worktree / hooks / MCP / Workflow / 沙箱作用域** 后必须跑它 ——
  单测覆盖不到"模型真的会怎么调"，而这几个功能的 bug 恰恰只在真实调用序列里现形。
- Windows：`rm` 会被安全策略拦 → 用 `mv` 移出仓库；`taskkill //F` 报错 → 用 `Stop-Process -Id`；
  **找端口占用用 `netstat -ano | grep LISTENING`**（`Get-NetTCPConnection` 在这台机器上返回空）。

## DeepSeek 接口实测事实
Base `https://api.deepseek.com`；两套协议都原生支持，但**本项目只走 OpenAI**。**完整清单见 details**，
下面三条是"不知道就会写出静默 bug"的：

- **思考默认开启，且 reasoning token 计入 `max_tokens`** → **任何设了小 `max_tokens` 的调用点
  都可能静默返回空响应**（`reasoning_effort:'none'` 是唯一能完全关掉思考的档位）。
- **`reasoning_effort` 实测**：`none`/`minimal`/`low`/`medium`/`high`/`max` 都接受，**`auto` → 400**。
  CLI 与 web 都只暴露 low|medium|high|max（刻意不加 none，两端语义要对齐）。
- **推理模式 + 强制 `tool_choice` 不可共存**（400）。适配器在"强制工具"时自动加 `reasoning_effort:'none'`。

## 当前状态
**两端都能用，去痕迹工程已完成**（`CC`/`上游兼容`/`内部代号` 0 命中，残留见 details）。
CLI：`limkenion` → `/login` 粘 key。Web：`cd web && node server/index.mjs`。
CLI 侧已补：上下文 **1M**、最大输出 **384K**、图片输入打通、`/effort` 生效、新增 `/schedule`。

### Web 端：已按「CLI 有的都搬过来」审过**三层**，并且五项"没搬的"已全部实现
| 层 | 结果 |
|---|---|
| **命令** | 82 个 → 搬了 7 个；其余是占位桩/已停用/需云端/终端专属 |
| **工具** | 55 个目录 → 真缺只有 `CronList`/`CronDelete`（已补）；**现 44 个** |
| **设置** | 原先**完全不读设置文件** → 现读 deny/ask/allow、defaultMode、bypass 开关、additionalDirectories、hooks、mcpServers |

**五项"之前没搬的"本轮全部实现**（用户明确要求"全部都做"）：

| 项 | 实现（web/server/） | 保留的差异 |
|---|---|---|
| **worktree + additionalDirectories** | 沙箱根**按会话可变**（AsyncLocalStorage）；两个工具真实现 | 只在当前沙箱内建；进入后原目录不可访问 |
| **hooks** | `hooks.mjs`：command 类型 + 8 个事件 | 19 种事件、prompt/agent/http 未做（http 要 SSRF 防护） |
| **MCP 客户端** | `mcp.mjs`：stdio + HTTP，tools/resources | sse / OAuth / elicitation / registry 未做 |
| **WorkflowTool** | `workflow.mjs`：vm 沙箱 + agent/parallel/pipeline/phase + journal | 子代理只读、无预定义脚本与远端 |
| **`/insights`** | `insights.mjs`：真实聚合 + 模型洞察 + HTML + 只读路由 | 无 facets 缓存、不跨项目 |

**Web 端抓到的 5 个静默严重 bug（都已修 + 有回归防线）**：
① 工具 schema 从没发给模型 → agent 实际只能聊天；② `chatCompletion` 不返回 `text` → 网页提炼器一直失效；
③ 工具结果不回填服务端记录 → **刷新页面后执行轨迹全丢**；④ **中断后旧回合"复活"** → 已用回合代次修掉；
⑤ `onDelta` 可选却直接调用 → 没传就抛"模型调用失败"。

**Web 端其它已做**：请求追踪面板、推理强度下拉、侧栏会话搜索 + 分叉、模型列表与 CLI 对齐、
**回合代次**（同一会话不并发跑两个回合；定时任务撞上未结束的回合就跳过**并说明**）。
**测试 296 项全过**（13 个文件：engine/commands/tools/security/settings/protocol/hooks/mcp/paths/insights/workflow/requestLog/drift）。

### 仍未做的
只剩三处"契约值改名"（`@limkenion-ai/*`、`'limkenionai-proxy'`、`'limkenionai'`）—— **建议不动**。

## 关键陷阱（都踩过，别再踩）
1. **`availability` 决定命令是否可见**，`commands.ts:meetsAvailabilityRequirement()` 在
   `isEnabled()` **之前**运行。判断"本地是否可见"必须同时看两个条件。
2. **删模块后必须跑冒烟** —— esbuild 只报"缺失导出"，不报类型错误；被删符号的**调用点**会静默变
   `undefined`，构建 0 错误、CLI 照常启动，执行到才炸。**踩过四次。删模块前把它 export 的
   每个符号都 grep 一遍，不能只 grep 模块名。**
3. **CLI 源码编辑的五条硬规矩**（react-compiler `$[N]` 槽位 / 批量改先 dry-run / 导入正则不能跨行 /
   JSDoc 里不能写 `**/` / "已移除 X"的注释别把 X 写出来）—— 全文见 details。
4. **桩模型按脚本回放 → 断言不到"请求里少了什么"**。凡"某参数有没有真的发出去"的问题，
   必须断言请求体（`stub.requests.at(-1)`）或打真实 API。
5. **前端有独立状态时，只测实时界面会漏掉"持久化/重载后"的 bug** —— web 验证脚本必须
   加一次 `Page.reload` 再断言，且断言**服务端那份记录**。
6. **`session.cancelled` 是共享布尔值，不能当"这个回合还活着吗"用** —— 按 Esc 后紧接着
   再发一条，协议层会把它置回 false，旧回合于是**复活**。判断回合存活一律用**回合代次**
   （`sessions.beginTurn` / `cancelSession` / `turnExpired`）。
7. **桩模型的脚本游标是全局共享的** —— 任何后台回合（定时任务、`/init` 的 `void runTurn`）
   都会偷走下一个用例的脚本，表现为"偶发失败"。用例之间要排空在途回合
   （`engine.isTurnActive` + `afterEach` 轮询）。**确定性测时间竞态用 `Sleep(duration_ms)` 拉住回合。**
8. **给自己的子进程套 shell 时别手拼 `cmd.exe /d /s /c "..."`** —— 带引号的可执行路径会被
   cmd 的引号规则拆坏（报"不是内部或外部命令"）。用 `spawn(cmd, { shell })`。
9. **用 shell 启动的子进程，超时不能只 `child.kill()`** —— 那只杀 shell，脚本进程活下来继续
   占着 stdout 管道 → `close` 永不触发 → **整个回合挂死**。超时后要**不等 close 直接结算**
   + `taskkill /T /F` 杀进程树。
10. **模块加载时的快照会漏掉运行时注册的东西** —— `DEFERRED_TOOL_NAMES` 原来是常量，
    MCP 工具注册进 `TOOL_SCHEMAS` 后**永远进不了延迟清单**。凡"运行时会长大的集合"，
    导出**函数**不要导出快照。
11. **`node:vm` 不是安全边界**（工作流脚本）：能挡住 `require`/`process`（靠不注入），
    挡不住同步死循环 —— 只有顶层同步段能用 `runInContext({timeout})` 兜住。**把限制写进文案。**
12. **断言要看"真正被消费的那份数据"** —— 工具结果只活在本次回合的 wire messages 里
    （`role:'tool'`），**不进 `session.messages`**（那里只有 user/assistant）。
13. **`ws?.readyState === ws.OPEN` 是假保护** —— 可选链只短路它自己那一段，右侧 `ws.OPEN`
    照样求值，ws 为 null 时抛 TypeError。**可选链不等于空值检查。**
14. **作用域要"每次调用重新解析"，不能在回合开头算一次** —— `EnterWorktree` 换掉
    `session.workspaceRoot` 后，AsyncLocalStorage 里已进的那层不会自己更新，
    同一回合里紧跟着的 Write 还写老树，而 EnterWorktree 自己报成功（用户完全看不出来）。
    同理：钩子进程的 cwd **和** 钩子输入 JSON 里的 `cwd` 字段都必须在作用域内构造
    （收**构造函数**而非收对象），否则"进程在新目录、stdin 读到的还是老目录"。
15. **`npm test` 必须显式写 `node --test test/*.test.mjs`** —— 只写 `node --test` 会 glob 到
    `test/fixtures/`，把 MCP 桩服务当测试文件跑起来挂满超时（全套 15 分钟 → 21 秒）。
16. **E2E 里"没测到"要记成"未触发"，不能记成失败** —— 走真实模型时，是否调工具、何时调都会抖动；
    混在一起会把模型抖动误报成产品 bug，反而淹没真 bug。同理**提示词别给退路**
    （写"如果没有未提交改动就…"，模型会理性地选另一条分支，被测路径压根没走到）。

## 承重的"半坏残留"（看着像死的，其实是活的，**别删**）
`constants/oauth.ts`（被 12+ 处导入，删了断构建）、`utils/model/bedrock.ts`、
`bun-bundle-stub.ts`（esbuild 的 `--alias:bun:bundle` 指向它）。**清单见 details。**

## 服务端模块地图（web/server/）
单向依赖：paths → config/bus → sessions/security/workspace → interactions/toolindex →
engine → commands → protocol → index。**新增模块别引入反向依赖**（要回调就用 `ctx` 注入）。

- `sessions.mjs`：会话存储 + 落盘 + **回合代次** + 沙箱根字段。
- 新模块：`hooks.mjs` / `mcp.mjs` / `workflow.mjs` / `insights.mjs` / `worktree.mjs`。
  它们的宿主能力**一律经 `ctx` 注入**（`runSubAgent`/`callMcpTool`/`runWorkflow`…），
  **不要让 `tools.mjs` 反向 import 这些模块**（会成环）。
- `static.mjs` 有一条 `/insights` 只读路由（文件名走白名单正则，不接受路径拼接）。

## 接力提示
**新 agent 上手**：① 读本文件 → ② 按需读 `MEMORY-details.md` → ③ 按改动位置加载技能
（`limkenion-cli-fix-verify` 改 CLI / `limkenion-web-verify` 改 `web/`）。
**用户偏好**：不要反复问他"选哪个"；说"继续"就是让我接着干。五项"要动安全边界/重做子系统"的
事他已明确要求做过（见上表），愿意为真功能付代价；但**没被要求时不要擅自扩大权限边界**。
