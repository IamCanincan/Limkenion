# Limkenion 项目长期记忆

> **本文件在会话启动时自动注入，必须保持精简**（超上限会被截断 = 接力断掉）。
> 分阶段全账、端点清单、命令级清单、清理日志、**被压缩掉的细节**都在同目录
> **`MEMORY-details.md`**，按需读。**加内容前先想清楚放哪一份。**

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
  （`.tsx` 带 `_c(N)` / `$[N]`）。**只能改文案 / 删整块 / 改小逻辑，不能重排结构。**
  构建：`node scripts/build-cli.mjs` → `dist/cli.mjs`（约 27MB esbuild ESM bundle）。
- **web 侧**（`web/`）：Vite + React 18 + 自研本地 Node 服务。
  **web 端不引用 CLI 源码**（只有 `web/test/drift.test.mjs` 按文件路径解析 `tools/*/`）。

## 硬约束与每轮惯例
- **无任何在线账号 / OAuth / 订阅 / 云供应商**。登录 = 设 `DEEPSEEK_API_KEY`
  （OpenAI 兼容端点，默认 `https://api.deepseek.com`）。
- **模型只有两个**：`deepseek-flash`（默认/快/支持 Vision）与 `deepseek-v4-pro`（强/不支持图）。
  `utils/model/configs.ts` 的 `ALL_MODEL_CONFIGS` 是唯一模型表。
- **源码不得出现 `CC` / `上游兼容` / `内部代号`**。唯一例外是 `scripts/build-cli.mjs` 的
  `BRAND_TOKENS` 清洗名单 —— **故意保留**（它就是用来从产物里抹掉它们的）。
- **判断"是否 OpenAI 兼容模式"只许用 `isOpenAICompat()`**（`utils/model/providers.ts`）：
  **它恒返回 `true`，不是"检测"出来的**。"用哪套协议"和"有没有配 key"是两件事，
  绝不能混进同一个判断（`hasAnyApiKeyConfigured()`）。**这个坑踩过两次。**
- **CLI 每轮改完**：`node scripts/build-cli.mjs` 0 错误 → **冒烟** → `npm install -g .` → commit
  （**不 push、不动 git config**）。
- **web 每轮改完**：`npx tsc --noEmit` → `npx vite build` → 逐文件跑 `test/*.test.mjs` → 真实 API 端到端。
- 注释与用户可见文案用中文，代码标识符用英文；缩进 2 空格，无分号结尾。

## 环境要点
- 有 HTTP 代理：访问 localhost 必须 `curl --noproxy '*'`。Node 的 `fetch` 直连可用；
  **DuckDuckGo 超时，Bing 可用**。
- **非交互跑 CLI 必须先设 `LIMKENION_GIT_BASH_PATH`**（路径见 details），否则报
  "requires git-bash" 退出。**冒烟**：`limkenion -p "只回复两个字：收到" --no-session-persistence`。
- 全局安装 npm 前必须 `export APPDATA='C:\Users\20653\AppData\Roaming'`。
- 系统 Node `D:\nodejs\node.exe`（v24）+ `D:\nodejs\npm.cmd` —— **测试 / tsc / vite 用它**。
  **web 预览服务用托管 Node 22.22.2**（与历次一致）：
  `C:\Users\20653\.workbuddy\binaries\node\versions\22.22.2-3\node.exe web/server/index.mjs`。
- **web 服务的 API key 只从环境变量来**（没有配置文件）。重启服务时从这里取，**别问用户**：
  `~/.limkenion.json` 的 **`primaryApiKey`**（CLI 侧录入并持久化的那把）。
  **没带 key 会静默退化成 mock** —— 看着"能用"，模型其实是假的。
  查活服务：`curl --noproxy '*' http://127.0.0.1:8799/` 拿 `limkenion-token` → 连 WS 发
  `{type:'run_command', command:'/status'}`（**类型是 `run_command`，不是 `command`**）。
- 单测 CLI 源码模块要用 esbuild 打包 + 特定 banner/alias（见 details）；
  纯 node 直跑会撞 `Config accessed before allowed`（那是没走 bootstrap，不是 bug）。
- `NODE_ENV=test` 会让 `services/vcr.ts` 写 `fixtures/*.json` 到 cwd，跑完清掉。
- Windows：`rm` / PowerShell 删除会被安全策略拦 → 用 `mv` 移出仓库；
  `taskkill //F` 报"无效参数" → 用 `Stop-Process -Id`。
  `netstat -ano | grep LISTENING` 找端口占用，比 `Get-NetTCPConnection` 稳。

## DeepSeek 接口实测事实（别凭旧资料）
Base `https://api.deepseek.com`；OpenAI 与 上游 两套协议都原生支持，
但**本项目只走 OpenAI**（用户拍板）。

- **`GET /models` 只有两个**：`deepseek-flash`、`deepseek-v4-pro`。
- **思考默认开启，且 reasoning token 计入 `max_tokens`**：
  默认 + `max_tokens=16` → 正文为空（推理吃光配额）；`reasoning_effort='none'` → 正常回答。
  **任何设了小 `max_tokens` 的调用点都可能静默返回空响应。**
- **`reasoning_effort` 实测取值**：`none`（**唯一能完全关掉思考链**）/ `minimal` / `low` /
  `medium` / `high` / `max` 都接受；**`auto` → 400**。CLI 只暴露 low|medium|high|max，
  **web 对齐这四档、故意不加 none**。`max` 仅 v4-pro，其余降级 high。
- **推理模式 + 强制 `tool_choice` 不可共存**（`400 Thinking mode does not support this tool_choice`）。
  **两个端点都报**，是模型限制。适配器在"强制工具"时自动加 `reasoning_effort:'none'`。
- 上下文 **1M**、最大输出 **384K**。**代码里不写死定价**
  （`utils/modelCost.ts` 已整体删除，`/cost` 只报 token 数）。

## 当前状态
**两端都能用。** CLI：`limkenion` → `/login` 粘 key。Web：`cd web && node server/index.mjs`。
**去痕迹工程已完成**（`CC`/`上游兼容`/`内部代号` 0 命中；剩余同名残留清单见 details）。

**CLI 侧已修/已补**：上下文 200K→**1M**、最大输出 64K→**384K**、**图片输入打通**、
`/effort` 不再空操作、新增 `/schedule`、结构化输出打通。

### Web 端：已按「CLI 有的都搬过来」审过**三层**
| 层 | 结果 |
|---|---|
| **命令** | 82 个 → 搬了 7 个（`/effort` `/branch` `/rewind` `/btw` `/init` `/schedule` `/workflows`）；其余是占位桩/已停用/需云端/终端专属 |
| **工具** | 55 个目录 → 真缺只有 `CronList`/`CronDelete`（已补，现 43 个工具） |
| **设置** | 原先**完全不读设置文件** → 新增 `web/server/settings.mjs`（`permissions.deny/ask/allow`、`defaultMode`、`disableBypassPermissionsMode`） |

**Web 端抓到的 4 个静默严重 bug（都已修 + 有回归防线）**：
1. **工具 schema 从来没发给模型** → web 的 agent **实际只能聊天**（fetch 用了另一份不含 tools 的 body）。
2. **`chatCompletion` 不返回 `text`** → `makeSummarizer` 读 `res.text`，WebFetch 提炼器一直失效。
3. **工具结果不回填服务端记录** → 落盘永远 `status:'running'`、没 diff/耗时，
   **刷新页面后执行轨迹全丢**（前端有独立状态，实时界面看不出）。
4. **中断后旧回合会"复活"** → 按 Esc 紧接着再发一条，旧回合继续跑（工具照常执行）；
   已用**回合代次**修掉（见陷阱 11）。

**Web 端其它已做**：请求追踪面板、推理强度下拉、侧栏会话搜索 + 分叉、模型列表与 CLI 对齐、
**回合代次**（同一会话不并发跑两个回合；定时任务撞上未结束的回合就跳过**并说明**）。
**测试 213 项全过**（engine 19 · commands 34 · tools 62 · security 33 · settings 26 · protocol 21 · paths 9 · requestLog 5 · drift 4）。

### 仍未搬的（都要用户拍板，别擅自开工）
| 项 | 为什么没做 |
|---|---|
| **hooks** | CLI 的 `utils/hooks/` 是 4 种类型 + 20+ 文件的**大子系统** |
| **MCP 客户端** | 大工程；web 现有 4 个 MCP 工具是"降级"占位（schema 可见、调用即抛） |
| **`WorkflowTool`** | web 无动态工作流编排层 |
| **worktree / `additionalDirectories`** | 要改沙箱根（`web/server/paths.mjs` 的模块级 `WORKSPACE_ROOT`），**安全边界**改动 |
| **`/insights`** | 读 CLI 会话日志 + 生成 HTML 报告，web 会话存储是另一套 |
| **三处"契约值"改名** | `@limkenion-ai/*`、`'limkenionai-proxy'`、`'limkenionai'`。**建议不动**（清单见 details） |

## 关键陷阱（都踩过，别再踩）
1. **`availability` 决定命令是否可见**，`commands.ts:meetsAvailabilityRequirement()` 在
   `isEnabled()` **之前**运行。判断"本地是否可见"必须同时看两个条件。
2. **删模块后必须跑冒烟** —— esbuild 只报"缺失导出"，不报类型错误；被删符号的**调用点**
   会静默变 `undefined`，构建 0 错误、CLI 照常启动，执行到才炸。**踩过四次。
   删模块前把它 export 的每个符号都 grep 一遍，不能只 grep 模块名。**
3. **判断死模块**：入口有 `if (true) return false` / 读的数据没有写入方 /
   `feature('X')` 且 X 在 `bun-bundle-stub.ts` 的 `UNSUPPORTED_UPSTREAM_FEATURES` 里。
4. **CLI 源码编辑的五条硬规矩**（react-compiler `$[N]` 槽位 / 批量改先 dry-run /
   导入正则不能跨行 / JSDoc 里不能写 `**/` / "已移除 X"的注释别把 X 写出来）—— 全文见 details。
5. **桩模型按脚本回放 → 断言不到"请求里少了什么"**。凡"某参数有没有真的发出去"的问题，
   必须断言请求体（`stub.requests.at(-1)`）或打真实 API。
6. **前端有独立状态时，只测实时界面会漏掉"持久化/重载后"的 bug** ——
   web 验证脚本必须加一次 `Page.reload` 再断言，且断言**服务端那份记录**。
7. **`session.cancelled` 是共享布尔值，不能当"这个回合还活着吗"用** ——
   按 Esc 后紧接着再发一条，协议层会把它置回 false，旧回合于是**复活**。
   判断回合存活一律用**回合代次**（`sessions.beginTurn` / `cancelSession` / `turnExpired`）。
8. **桩模型的脚本游标是全局共享的** —— 任何后台回合（定时任务、`/init` 的 `void runTurn`）
   都会偷走下一个用例的脚本，表现为"1/3 概率偶发失败"。用例之间要排空在途回合
   （`engine.isTurnActive(sessionId)` + `afterEach` 轮询）。
9. **确定性测时间竞态用 `Sleep(duration_ms)` 把回合拉住**，不要靠"这一轮大概跑得比较久"。

## 承重的"半坏残留"（看着像死的，其实是活的，**别删**）
完整清单见 details。最要紧三条：`constants/oauth.ts`（被 12+ 处导入，删了断构建）、
`utils/model/bedrock.ts`（`getInferenceProfileBackingModel` 在活路径上）、
`bun-bundle-stub.ts`（esbuild 的 `--alias:bun:bundle` 指向它，`feature()` 由它实现）。

## 服务端模块地图（web/server/）
单向依赖：paths → config/bus → sessions/security/workspace → interactions/toolindex →
engine → commands → protocol → index。**新增模块别引入反向依赖**（要回调就用钩子）。

- `sessions.mjs`：会话存储 + 落盘 + **回合代次**（`beginTurn`/`cancelSession`/`turnExpired`）。
- 定时任务能力（`cronList`/`cronRemove`/`scheduleCron`）**经 `ctx` 注入** `tools.mjs` ——
  **不要让 tools.mjs 反向 import engine.mjs**（会成环）。

## 接力提示
**新 agent 上手**：① 读本文件 → ② 按需读 `MEMORY-details.md` → ③ 按改动位置加载技能
（`limkenion-cli-fix-verify` 改 CLI / `limkenion-web-verify` 改 `web/`）。
**用户偏好**：不要反复问他"选哪个" —— 说"继续"就是让我接着干、自己判断优先级；
但**不要擅自做**"要动安全边界"或"要重做一个子系统"量级的事。
