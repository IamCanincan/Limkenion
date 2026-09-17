# Limkenion 项目长期记忆

> **这是会话启动时自动注入的文件，必须保持精简**（超过注入上限会被截断，接力就断了）。
> 详细的分阶段记录、端点清单、命令级清单、清理日志都在同目录的 **`MEMORY-details.md`**，按需读取。
> 逐轮流水在 `YYYY-MM-DD.md`。**加内容前先想清楚该放哪一份。**

---

## 用户明确要求（优先级最高，别自作主张改）
1. **CLI + Web 双端**都要，功能语义对齐。
2. **只依赖 Node**，不引入新运行时（不要 Bun/Deno/Python）。
3. **以"高效编码"为目的** —— 取舍标准是写代码好不好用，不是功能多。
4. **只支持 DeepSeek**，不做其他供应商。
5. **尽量不要删功能；发现问题先提出来，不要擅自删。**
6. 是**本地 agent**，无云、无账号、**无网站、无邮箱**。
7. **DeepSeek 模型/价格以官网实测为准，不要凭印象写死。**
8. **API key 由用户自己输入**（`/login` 已能录入并持久化）。
9. **不要桌宠**（`buddy/` 与 `commands/buddy/` 已整块删除）。

## 项目性质
`D:\Github Repositories\Limkenion` = **CLI（React/ink REPL）+ web 界面** 的双端 agent harness。

- **CLI 侧**（仓库根）：fork 自 上游 CLI 原型，源码是 **react-compiler 编译产物**
  （`.tsx` 带 `_c(N)` / `$[N]` / `Symbol.for("react.memo_cache_sentinel")`）。
  **只能改文案 / 删整块 / 改小逻辑，不能重排结构**（见"关键陷阱"）。
- **构建**：`node scripts/build-cli.mjs` → `dist/cli.mjs`（约 27MB esbuild ESM bundle）。
- **web 侧**（`web/`）：Vite + React 18 + 自研本地 Node 服务，可构建可运行。
  **web 端不引用 CLI 源码**（只被 `web/test/drift.test.mjs` 按文件路径解析 `tools/*/`）。
- git 仓库，分支 `master`。备份在 `..\Limkenion_backup_2026-09-16.tar.gz`。

## 硬约束与每轮惯例
- **无任何在线账号 / OAuth / 订阅 / 云供应商**。登录 = 设 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`
  （OpenAI 兼容端点，默认 `https://api.deepseek.com`）。
- **模型只有两个**：`deepseek-flash`（默认/快）与 `deepseek-v4-pro`（强）。
  `utils/model/configs.ts` 的 `ALL_MODEL_CONFIGS` 是唯一模型表。
- **源码不得出现 `CC` / `上游兼容` / `内部代号`**。唯一例外是 `scripts/build-cli.mjs` 的
  `BRAND_TOKENS` 清洗名单 —— **故意保留**（它就是用来从产物里抹掉它们的）。
- **判断"是否 OpenAI 兼容模式"只许用 `isOpenAICompat()`**（`utils/model/providers.ts`）。
  **它恒返回 `true`，不是"检测"出来的** —— 上游协议已永久移除，没有"另一种模式"可回退。
  **"用哪套协议"和"有没有配 key"是两件事，绝不能混进同一个判断。**
  有没有 key 用 `hasAnyApiKeyConfigured()`（`utils/auth.ts`）。这个坑**踩过两次**。
- **每轮改完的惯例**：`node scripts/build-cli.mjs` 0 错误 → **冒烟** → `npm install -g .` → git commit
  （**不 push、不动 git config**）。
- 注释与用户可见文案用中文，代码标识符用英文；缩进 2 空格，无分号结尾。

## 环境要点
- 有 HTTP 代理（`HTTP_PROXY=http://127.0.0.1:7907`）：访问 localhost 必须 `curl --noproxy '*'`。
  Node 的 `fetch` 直连可用；**DuckDuckGo 超时，Bing 可用**。
- **非交互跑 CLI 必须先设 `LIMKENION_GIT_BASH_PATH`**：
  `C:\Users\20653\.workbuddy-ai\binaries\PortableGit\versions\1.2.0\usr\bin\bash.exe`
  否则直接报 "requires git-bash" 退出。
  **冒烟命令**：`limkenion -p "只回复两个字：收到" --no-session-persistence`
- **全局安装 npm 前必须** `export APPDATA='C:\Users\20653\AppData\Roaming'`
  （Git Bash 里 `APPDATA` 为空，否则 prefix 会被解析到 `<cwd>\${APPDATA}\npm`）。
- 系统 Node `D:\nodejs\node.exe`（v24）+ `D:\nodejs\npm.cmd`。
- **单测某个源码模块**：用 esbuild 打成单文件再 node 跑，必须带
  `--banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"`
  与 `--alias:bun:bundle=./bun-bundle-stub.ts --tsconfig=./tsconfig.json`。
  纯 node 直跑会撞 `Config accessed before allowed` —— 那是没走 bootstrap，不是 bug。
- `NODE_ENV=test` 会让 `services/vcr.ts` 写 `fixtures/*.json` 到 cwd，跑完记得 `rm -rf fixtures`。

## DeepSeek 接口实测事实（别凭旧资料）
Base：`https://api.deepseek.com`。**OpenAI 协议与 上游 协议（`/上游兼容`）都原生支持**，
但本项目**只走 OpenAI**（用户拍板）。

- **`GET /models` 只有两个**：`deepseek-flash`、`deepseek-v4-pro`。
- **思考模式默认开启，且 reasoning token 计入 `max_tokens` 配额**：
  ```
  默认 + max_tokens=16  →  正文 = ""    （推理 token = 16，答案被吃光）
  reasoning_effort='none' → 正文 = "正常回答"
  ```
  **任何设了小 `max_tokens` 的调用点都可能静默返回空响应。**
- **推理模式 + 强制 `tool_choice` 不可共存**：返回 `400 Thinking mode does not support this tool_choice`。
  **两个端点都一样报错** —— 这是 DeepSeek **模型**的限制，不是 OpenAI 端点独有的，
  换 上游 端点解决不了。适配器因此在"强制工具"时自动加 `reasoning_effort: 'none'`。
- **官方能力**：上下文 **1M**、最大输出 **384K**；`deepseek-flash` **支持 Vision**（v4-pro 不支持，
  且 v4-pro 对图片**不报错、会瞎猜**）。
- **价格会变，所以代码里不写死定价** —— `utils/modelCost.ts` 已整体删除，`/cost` 只报 token 数。
- **两个端点实测几乎等价**：思考都默认开、缓存命中数都能拿到（字段名不同：
  `prompt_cache_hit_tokens` vs `cache_read_input_tokens`）。
  **唯一实质差异**：上游 端点的 thinking 块带 `signature`，多轮可原样传回；
  我们这条路径拿不到签名，组装下一轮时丢弃 thinking（OpenAI 协议本来也不该回传）。

## 当前状态与待办
**能用。** 开新终端 → `limkenion` → `/login` 粘贴 key → 就能干活。
构建 0 错误、冒烟通过、工作区干净。

**去痕迹工程：已完成。** 总账见 `MEMORY-details.md`。要点：
`CC`/`上游兼容`/`内部代号` **0 命中**；自有服务 URL/域名 170+151+87+53 → **8 处**
（1 处假阳性 + 7 处契约值/邮件）；`sonnet`/`opus`/`haiku` 1442 → **10 处**（全是同名巧合）。

**已修的三处功能**：上下文窗口 200K→**1M**、最大输出 64K→**384K**、**图片输入打通**
（实测 flash 能看见图）。

**已补的三处功能**：`/effort` 不再是空操作、新增 `/schedule` 命令、结构化输出打通。
**Web 端已补齐 CLI 可搬的命令**（`/effort` `/branch` `/rewind` `/btw` `/init` `/schedule` `/workflows`），
并修掉两个静默严重 bug（工具 schema 从没发给模型、`chatCompletion` 不返回 text）。
`reasoning_effort` 实测：`none` 是唯一能关思考的取值，但 CLI 只暴露 low|medium|high|max，
**web 对齐这四档、故意不加 none**。
**Web 端新增「请求追踪」面板**（`web/server/requestLog.mjs` + `RequestLogPanel.tsx`）——
记录每次模型请求的耗时/状态/token，内存环形缓冲、不上报不落盘。
顺带修掉一个真 bug：web 端的模型列表原本有 4 个（含 2 个已退役别名）且默认用别名，
**与 CLI 不一致**，已对齐成 `deepseek-flash` / `deepseek-v4-pro`。

**待办（都要用户拍板）**：
1. **三处"契约值"改名**（我建议不动，改了会碰坏别的东西且用户看不到）：
   `@limkenion-ai/*`（npm 包作用域，41 处）、`'limkenionai-proxy'`（MCP 传输类型，
   写在 SDK 输出 schema 里，40+ 处）、`'limkenionai'`（MCP 配置作用域，写在设置文件里，10 处）
2. **`/effort` 没有"关闭思考"的入口**（只有 low/medium/high，没有 none）
3. 可选的桌面端 / IM 接入等产品级功能（**不算"DS 接入"的缺口**）

## 关键陷阱（这些坑都踩过，别再踩）
### 1. `availability` 字段的语义（决定命令是否可见）
`commands.ts:meetsAvailabilityRequirement()` 在 `isEnabled()` **之前**运行：
- `availability: ['cloud-subscriber']`（原 `'limkenion-ai'`）→ 要求订阅 → **本地恒隐藏**
- `availability: ['console']` → 未设 `LIMKENION_BASE_URL` 时恒 true → **本地反而可见**

**判断"某命令本地是否可见"必须同时看 `availability` 和 `isEnabled` 两个条件。**

### 2. 删模块 / 改数据表后必须跑冒烟（esbuild 不查类型）
esbuild **只报"缺失导出/模块解析失败"，不报类型错误**。删掉模块后它的**函数调用点**会静默变
`undefined`，构建 0 错误、CLI 照常启动，只在执行到那行才炸。**这个坑踩了四次。**

**规则：删模块前把它 `export` 的每个符号都 grep 一遍，不能只 grep 模块名。**

### 3. 判断死模块的三种方法
- 入口函数开头有没有 `if (true) return false`
- **它读的数据有没有写入方**（只读不写 = 死路径）
- 有没有 `feature('X')` 且 X 在 `bun-bundle-stub.ts` 的 `UNSUPPORTED_UPSTREAM_FEATURES` 里

### 4. react-compiler 产物里删代码
删**表达式内部**的元素 → **不改变 `$[N]` 槽位数量**，安全；
删整个 `if ($[N] !== x) {...}` 赋值块 → 会移动后续下标，危险。

### 5. 批量改代码前先 dry-run；批量删声明要用语法校验兜底
dry-run 已救过三次（`url: 'https://...'` 被吃成 `url''`、`1M` 的 `1` 被当版本号、
`api.远端服务` 半截词）。
**批量删声明靠正则算边界必然有漏网**（踩过三次：参数括号被当声明体、漏了 `|` 行延续、
跨行返回类型）—— 最后用 **esbuild 的 `transform()` 逐文件语法校验**，
失败就 `git checkout` 回退那一个。

### 6. 导入扫描的正则不能跨行
`[^'"]+` 会让注释里的 `from` 一路吞到很后面的引号，把中间的 import 行整个吃掉。
必须用 `[^'"\n]+`。

### 7. JSDoc 里不能写 `**/`
`/** ... **/login ... */` 中的 `*/` 会提前闭合注释块，esbuild 报错、整个构建挂掉。

### 8. 写"已经移除了 X"的注释时别把 X 原样写出来
自指涉的痕迹，踩过两次（HANDOFF.md、`aliases.ts`）。

## 承重的"半坏残留"（看着像死的，其实是活的，**别删**）
- `constants/oauth.ts`（203 行）：被 12+ 处导入，删除直接断构建。
- `utils/model/bedrock.ts`（265 行）：`getInferenceProfileBackingModel` 在活路径上被调用。
- `services/mcp/oauthPort.ts`（78 行）：远程 MCP OAuth 用，正当保留。
- `stubs/bedrock-sdk.ts`：由 `tsconfig.json` 的 `paths` 映射，无显式 import。
- `commands/oauth-refresh/index.js`：1 行中性 stub（`isEnabled: () => false`），无害。
- `bun-bundle-stub.ts`：**esbuild 的 `--alias:bun:bundle` 指向它**，`feature()` 由它实现。
- `entrypoints/sdk/`（23 个未使用导出）：**SDK 输出格式的公开定义**，有意保留。
- `stubs/{chrome-mcp,computer-use-mcp-*}.ts`：由 `tsconfig.json` 的 `paths` 映射。
- `.workbuddy-ai/i18n/`（34MB）：暂停中的注释中文化工程的**工作产物**，删了流水线没法恢复。

## 服务端模块地图（web/server/）
单向依赖：paths → config/bus → sessions/security/workspace → interactions/toolindex →
engine → commands → protocol → index。**新增模块别引入反向依赖**（需要回调就用钩子）。
