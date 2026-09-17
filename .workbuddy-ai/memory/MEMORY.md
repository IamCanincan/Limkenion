# Limkenion 项目长期记忆

> **这是会话启动时自动注入的文件，必须保持精简**（超过注入上限会被截断，接力就断了）。
> 详细的分阶段记录、端点清单、命令级清单已移到同目录的 **`MEMORY-details.md`**，按需读取。
> 逐轮流水在 `YYYY-MM-DD.md`。

---

## 用户明确要求（优先级最高，别自作主张改）
1. **CLI + Web 双端**都要，功能语义对齐。
2. **只依赖 Node**，不引入新运行时（不要 Bun/Deno/Python）。
3. **以"高效编码"为目的** —— 取舍标准是写代码好不好用，不是功能多。
4. **只支持 DeepSeek**，不做其他供应商。
5. **尽量不要删功能；发现问题先提出来，不要擅自删。**
6. 是**本地 agent**，无云、无账号、无网站。
7. **DeepSeek 模型/价格以官网实测为准，不要凭印象写死。**
8. **API key 由用户自己输入**（`/login` 已能录入并持久化，见下）。

## 项目性质
`D:\Github Repositories\Limkenion` = **CLI（React/ink REPL）+ web 界面** 的双端 agent harness。

- **CLI 侧**（仓库根）：fork 自 上游 CLI 原型，源码是 **react-compiler 编译产物**
  （`.tsx` 带 `_c(N)` / `$[N]` / `Symbol.for("react.memo_cache_sentinel")`）。
  **只能改文案 / 删整块 / 改小逻辑，不能重排结构**（见"关键陷阱"）。
- **构建**：`node scripts/build-cli.mjs` → `dist/cli.mjs`（约 27MB esbuild ESM bundle）。
- **web 侧**（`web/`）：Vite + React 18 + 自研本地 Node 服务，可构建可运行。
- git 仓库，分支 `master`。备份在 `..\Limkenion_backup_2026-09-16.tar.gz`，移除的模块在 `..\Limkenion_removed`。

## 硬约束与每轮惯例
- **无任何在线账号 / OAuth / 订阅 / 云供应商**。登录 = 设 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`
  （OpenAI 兼容端点，默认 `https://api.deepseek.com`）。
- **模型只有两个**：`deepseek-flash`（默认/快）与 `deepseek-v4-pro`（强）。
  `utils/model/configs.ts` 的 `ALL_MODEL_CONFIGS` 是唯一模型表。
- **源码不得出现 `CC` / `上游兼容` / `内部代号`**。唯一例外是 `scripts/build-cli.mjs` 的
  `BRAND_TOKENS` 清洗名单 —— 那是**故意保留**的（它就是用来从产物里抹掉它们的）。
- **判断"是否 OpenAI 兼容模式"只许用 `isOpenAICompat()`**（`utils/model/providers.ts`）。
  **它恒返回 `true`，不是"检测"出来的** —— 上游协议在本项目已永久移除，没有"另一种模式"可回退。
  **"用哪套协议"和"有没有配 key"是两件事，绝不能混进同一个判断。**
  有没有 key 用 `hasAnyApiKeyConfigured()`（`utils/auth.ts`）。这个坑**踩过两次**。
- **每轮改完的惯例**：`node scripts/build-cli.mjs` 0 错误 → **冒烟** → `npm install -g .` → git commit
  （**不 push、不动 git config**）。
- 注释与用户可见文案用中文，代码标识符用英文；缩进 2 空格，无分号结尾。
- 官方插件市场自动安装**默认关闭**；要开得显式设 `LIMKENION_ENABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`。

## 环境要点
- 有 HTTP 代理（`HTTP_PROXY=http://127.0.0.1:7907`）：访问 localhost 必须 `curl --noproxy '*'`。
  Node 的 `fetch` 直连可用；**DuckDuckGo 超时，Bing 可用**。
- **非交互跑 CLI 必须先设 `LIMKENION_GIT_BASH_PATH`**：
  `C:\Users\20653\.workbuddy-ai\binaries\PortableGit\versions\1.2.0\usr\bin\bash.exe`
  否则直接报 "requires git-bash" 退出。
  **冒烟命令**：`limkenion -p "只回复两个字：收到" --no-session-persistence`
- **全局安装 npm 前必须** `export APPDATA='C:\Users\20653\AppData\Roaming'`
  （Git Bash 里 `APPDATA` 为空，否则 prefix 会被解析到 `<cwd>\${APPDATA}\npm`）。
- 系统 Node `D:\nodejs\node.exe`（v24）+ `D:\nodejs\npm.cmd`；托管 Node/Python 在
  `C:\Users\20653\.workbuddy-ai\binaries\`。
- **单测某个源码模块**：用 esbuild 打成单文件再 node 跑，必须带
  `--banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"`
  与 `--alias:bun:bundle=./bun-bundle-stub.ts --tsconfig=./tsconfig.json`。
  纯 node 直跑会撞 `Config accessed before allowed` —— 那是没走 bootstrap，不是 bug。
- `NODE_ENV=test` 会让 `services/vcr.ts` 写 `fixtures/*.json` 到 cwd，跑完记得 `rm -rf fixtures`。

## DeepSeek 接口实测事实（2026-09-17/18，别凭旧资料）
Base：`https://api.deepseek.com`。OpenAI 协议 + 上游 协议**都原生支持**
（但本项目只走 OpenAI，用户拍板）。

- **`GET /models` 只有两个模型**：`deepseek-flash`、`deepseek-v4-pro`。
- **usage 字段**：`prompt_tokens` / `completion_tokens` / `total_tokens`，
  外加 `prompt_tokens_details.cached_tokens`（= `prompt_cache_hit_tokens`）、
  `prompt_cache_miss_tokens`、`completion_tokens_details.reasoning_tokens`。
  **适配器读 `prompt_tokens_details.cached_tokens` 是对的**（实测命中 896）。
- **思考模式默认开启，且 reasoning token 计入 `max_tokens` 配额**：
  ```
  默认 + max_tokens=16  →  正文 = ""    （推理 token = 16，答案被吃光）
  reasoning_effort='none' → 正文 = "正常回答"
  ```
  所以**任何设了小 `max_tokens` 的调用点都可能静默返回空响应**。
- **推理模式 + 强制 tool_choice 不可共存**：返回 `400 Thinking mode does not support this tool_choice`。
  适配器因此在"强制工具"时自动加 `reasoning_effort: 'none'`。
- **官方能力**：上下文 **1M**、最大输出 **384K**；`deepseek-flash` **支持 Vision**（v4-pro 不支持）。
- **价格会变，所以代码里不写死定价** —— `utils/modelCost.ts` 已整体删除，`/cost` 只报 token 数。

## 当前进度与下一步（接力关键）
### 去痕迹工程（用户下达，**进行中**）
目标：删去 CC / 上游 及其模型（Sonnet/Opus/Haiku）的痕迹；Limkenion 无网站无云服务。

**已完成**：
- 品牌词：源码 0 命中（除 build 脚本清洗名单）
- 云服务命令：停用 7 个（`/mobile` `/stickers` `/passes` `/install-github-app` `/release-notes`
  `/think-back` `/thinkback-play`），`/feedback` 改为写本地文件
- 模型表：11 个上游模型 × 4 provider → 2 个 DeepSeek 模型
- 定价表：整体删除
- 6 个模型版本迁移函数：整文件删除
- 2 个硬关掉的死模块：`services/mockRateLimits.ts`（719 行）、
  `utils/model/modelCapabilities.ts`（118 行）—— 整文件删除
- **自有服务 URL：170 处 / 99 文件全部删除**
- 模型相关函数改名（66 处）：`getDefaultHaikuModel`→`getDefaultSmallFastModel`、
  `getDefaultSonnetModel`→`getDefaultMainModel`、`getDefaultOpusModel`→`getDefaultStrongModel`、
  `isNonCustomOpusModel`→`isNonCustomStrongModel`、`queryHaiku`→`querySmallFastModel`

**待办（按优先级）**：
1. **两处待用户拍板的行为变更**（我没动）：
   - `utils/context.ts` 的 `MODEL_CONTEXT_WINDOW_DEFAULT = 200_000`，DeepSeek 官方是 **1M**
   - 同文件 `MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000`，官方最大输出 **384K**
2. **三处"保守但可能不对"的判定**（改造前就有，我没改行为）：
   - `modelSupportsStructuredOutputs` 对 DeepSeek 返回 false，但官方支持 JSON 输出
   - `utils/context.ts` 的上下文窗口与最大输出沿用上游保守值（见上）
3. **三处"契约值"改名需用户拍板**（我没动，因为影响面超出"文案"）：
   - `'limkenionai-proxy'`（40+ 处）—— MCP 传输类型，**出现在 SDK 输出 schema 里**
     （`entrypoints/sdk/coreSchemas.ts`、`services/mcp/types.ts`），改名等于改 SDK 契约
   - `'limkenion-ai'`（连字符）—— **`CommandAvailability` 枚举值**，就是判断命令可见性的那个字段
   - `'limkenionai'` —— MCP 配置作用域（10 处）
   - `'limkenion.ai'` —— 认证来源枚举（读写成对，5 处）
   - `@limkenion.com` —— 邮件地址（会写进 git 提交 trailer，3 处）
4. **与参照实现的功能缺口**（用户还没定做不做）：
   - `/effort` 命令是**空操作**（写的是 `utils/effort.ts` 的 `effortLevel`，没接到 API）；
     真正生效的是 `/model low|medium|high`。**没有"关闭思考"的入口**。
   - **图片输入**：`deepseek-flash` 支持 Vision，但适配器 `blockToText()` 对 image 块返回空串，
     **图片被静默丢弃**。
   - **本地定时任务**：原调度依赖云端（已停用），无本地替代。

### 痕迹清理总账（2026-09-18 收官）
| 类别 | 结果 |
|---|---|
| `CC` / `上游兼容` / `内部代号` | **0 命中**（唯一例外是 build 脚本的清洗名单，故意保留） |
| 自有服务 URL / 域名 | 170 + 151（裸域名）+ 87（注释）+ 53 → **8 处**（1 处假阳性 + 7 处契约值/邮件） |
| `sonnet` / `opus` / `haiku` | 1442 → **10 处**（全是同名巧合：章鱼精灵 / git 参数 / 词表 / 文件扩展名） |
| 整文件删除 | 4 个（`mockRateLimits` 719 行、`modelCapabilities` 118 行、`product.ts` 139 行、`modelOptions` 净删 447 行） |
| 云服务命令 | 停用 7 个；`/feedback` 改本地文件 |

### 模型名痕迹：**已清完**（1442 → 11 处，其中 10 处是合法保留）
剩下 10 处**刻意不动**，全是同名巧合：
| 位置 | 为什么保留 |
|---|---|
| `buddy/sprites.ts`、`buddy/types.ts` 的 `octopus`（5 处） | 桌宠的**章鱼精灵** |
| `utils/shell/readOnlyCommandValidation.ts` 的 `'--octopus'` | **git 的真实参数**（`git merge-base --octopus`） |
| `utils/words.ts` 的 `'octopus'` / `'sonnet'`（2 处） | **随机词表**里的英文单词 |
| `constants/files.ts` 的 `'.opus'` | **音频文件扩展名** |

**教训：批量改名前必须区分"同名巧合"。** 这轮里 `octopus`（桌宠/git 参数/词表）、
`.opus`（文件扩展名）、`sonnet`（词表单词）都差点被误伤。

**URL 空壳清理已全部完成**：`constants/product.ts`（整个远程会话模块）整文件删除；
`/feedback` 的"去 GitHub 提 issue" 断路径（54 行）删除；26 处 `<Link url="" />` 与
悬空的 `Learn more:` / `For help:` 文案全部清掉；一批空括号与悬空文案修好。

**react-compiler 里删 JSX 元素是安全的**（重要经验）：`tN = <JSX>` 这种记忆化
**表达式内部**删元素**不会**改变 `$[N]` 槽位数量 —— 只有删掉整个
`if ($[N] !== x) {...}` 赋值块才会移动后续下标。所以改 JSX 内容可以放心做。

### 其它
- **`/login` 已能真正录入并持久化 key**（`components/ConsoleOAuthFlow.tsx` → `saveApiKey()`）。
  注意**环境变量优先级高于 `/login` 存的 key**（已实测）。
- **密钥一律不要写进仓库或记忆文件。** `D:\下载\agent\新建 文本文档.txt` 里那个 key
  用户选择自己处理，**不要动、不要复制**。
- 注释中文化工程**已暂停**（用户决定）。计划与术语表在 `.workbuddy-ai/i18n/COMMENT_I18N_PLAN.md`
  （**第 69–120 行是术语表**，别删这个文件，它是流水线的一部分）。
- 双端对齐由 `web/test/drift.test.mjs` 守；web 端沙箱固定为工作区根；
  危险工具执行前必须弹窗确认；服务默认只绑 `127.0.0.1`。

## 关键陷阱（这些坑都踩过，别再踩）
### 1. `availability` 字段的语义（决定命令是否可见）
`commands.ts:meetsAvailabilityRequirement()` 在 `isEnabled()` **之前**运行：
- `availability: ['limkenion-ai']` → 要求订阅 → **本地恒隐藏**
- `availability: ['console']` → `!订阅 && !三方云 && isFirstPartyLimkenionBaseUrl()`
  → 未设 `LIMKENION_BASE_URL` 时最后一项恒 true → **本地反而可见**

**判断"某命令本地是否可见"必须同时看 `availability` 和 `isEnabled` 两个条件。**

### 2. 删模块 / 改数据表后必须跑冒烟（esbuild 不查类型）
esbuild **只报"缺失导出/模块解析失败"，不报类型错误**。删掉模块后它的**函数调用点**会静默变
`undefined`，构建 0 错误、CLI 照常启动，只在执行到那行才炸。**这个坑踩了三次。**

**规则：删模块前把它 `export` 的每个符号都 grep 一遍，不能只 grep 模块名。**

### 3. 判断死模块：看入口函数开头有没有 `if (true) return false`
`grep -rn "if (true)" --include='*.ts' .` 就能捞出这类硬开关。别只看调用点就以为功能还活着。

### 4. react-compiler 产物里删代码要小心 `$[N]` 槽位
删掉被记忆化的代码会**移动后续槽位下标**，破坏编译器输出，而构建不报错。
**安全做法**：先确认目标段落不在 `$[N]` 区块内；若在，**保留槽位、只改值**。

### 5. 批量改代码前先 dry-run
脚本必须支持 dry-run，打印 before/after 人眼过一遍再 `--apply`。
真实教训：一版清理脚本把 `url: 'https://...'` 吃成 `url''`（**语法错误**），dry-run 拦住了。

### 6. JSDoc 里不能写 `**/`
`/** ... **/login ... */` 中的 `*/` 会提前闭合注释块，esbuild 报错、整个构建挂掉。

## 承重的"半坏残留"（看着像死的，其实是活的，**别删**）
- `constants/oauth.ts`（203 行）：被 12+ 处导入，删除直接断构建。
- `utils/model/bedrock.ts`（265 行）：`getInferenceProfileBackingModel` 在活路径上被调用。
- `services/mcp/oauthPort.ts`（78 行）：远程 MCP OAuth 用，正当保留。
- `stubs/bedrock-sdk.ts`：由 `tsconfig.json` 的 `paths` 映射，无显式 import。
- `commands/oauth-refresh/index.js`：1 行中性 stub（`isEnabled: () => false`），无害。

## 服务端模块地图（web/server/）
单向依赖：paths → config/bus → sessions/security/workspace → interactions/toolindex →
engine → commands → protocol → index。**新增模块别引入反向依赖**（需要回调就用钩子）。
