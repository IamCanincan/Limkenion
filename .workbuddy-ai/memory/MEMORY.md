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

## DeepSeek 接口实测结论（2026-09-17，务必以实测为准，别凭旧资料）
Base：`https://api.deepseek.com`

| 接口 | 结论 |
|---|---|
| `GET /models` | 只有两个模型：**`deepseek-flash`**、**`deepseek-v4-pro`** |
| `POST /chat/completions` | OpenAI 协议。同一次响应里可同时有 `reasoning_content` 与 `tool_calls`；usage 带 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（自动前缀缓存）；**流式默认就返回 usage**，不需要 `stream_options.include_usage` |
| `POST /上游兼容/v1/messages` | **存在且完整**。认 `x-api-key` + `上游兼容-version`；接受 `system` 块数组（含 `cache_control`）、`tools`（`input_schema`）、`betas` 字段；返回原生 上游 结构：`thinking`（带 `signature`）+ `text` + `tool_use`，`stop_reason: "tool_use"`，usage 带 `cache_creation_input_tokens` / `cache_read_input_tokens` |
| `POST /上游兼容/v1/messages/count_tokens` | **可用**，返回 `{"input_tokens":N}` |
| 上游 端点流式 | **完整 SSE**：`message_start` / `content_block_start` / `ping` / `content_block_delta`（`thinking_delta` 等），与 上游 原生事件格式一致 |
| 注意 | 上游 端点**未显式请求 thinking 也会返回 thinking 块**，说明 deepseek-flash 的推理是默认开的 |
| `reasoning_effort: "none"` | **能关闭思考链**（实测：返回内容只剩 text 块）。是关推理的唯一手段 |
| 推理模式 + 强制 tool_choice | **不可共存**！会返回 `400 Thinking mode does not support this tool_choice`。要强制工具必须先关推理 |

**结论**：整个代码库本来就是按 上游 协议写的，DeepSeek 又原生支持该协议 ——
所以"实现一个 上游 协议的 client"能一次性修好所有旁路调用。
**但用户 2026-09-17 明确只要 OpenAI 一条路**（见下），该方案已搁置，留作备选。

## 协议路线：只走 OpenAI（2026-09-17 用户拍板）
用户先答"两种都支持"，随后改口**"我现在只要 openai"**。所以：
- 保持 `services/api/openai-compat.ts` 作为唯一的协议适配层，不引入 上游 客户端。
- 判断兼容模式**只许用 `isOpenAICompat()`**（`utils/model/providers.ts`），
  绝不要硬比 `process.env.LIMKENION_API_PROVIDER === 'openai'`（那是 26d53b0 修过的坑）。
- **不要给每个调用点各加一套协议分支** —— 兼容分支要加在"统一入口"上
  （如 `utils/sideQuery.ts` 一处就覆盖了 7+ 个功能）。

### 已完成的兼容改造（commit 754c0d8）
| 文件 | 做了什么 |
|---|---|
| `utils/sideQuery.ts` | 加兼容分支走 `queryOpenAICompatOnce`，返回 BetaMessage 形状。客户端获取延后到 systemBlocks 之后，兼容模式不再走账号前置检查 |
| `services/api/openai-compat.ts` | `toolChoice` 翻译（auto/any/none/强制工具）、`stopSequences`、补齐 `id`/`type` 成 BetaMessage；**强制工具时强制 `reasoning_effort:'none'`**；key 解析在环境变量后回落到 `primaryApiKey` |
| `utils/model/providers.ts` | 新增 `OPENAI_COMPAT_MODELS`（deepseek-flash / deepseek-v4-pro）、`getOpenAICompatSmallFastModel()` |
| `utils/model/model.ts` | `getSmallFastModel()` 兼容模式返回 deepseek-flash（原来返回改名后的上游 ID，发出去必 404） |
| `utils/model/modelOptions.ts` | `/model` 列出两个真实模型而非只有"默认" |
| `services/tokenEstimation.ts` | 兼容模式用 `max_tokens=1` 最小请求读 `usage.prompt_tokens` 精确计数 |
| `components/ConsoleOAuthFlow.tsx` | `/login` 从"只显示提示"改成真输入框：录入 → 校验格式 → `saveApiKey()` 写 `primaryApiKey` → 发最小请求验证；环境变量已设时提示其优先级更高 |

**key 存储**：`saveApiKey()`（`utils/auth.ts:1114`）已存在，写全局配置的 `primaryApiKey`，
Windows 上就是写配置文件。不需要另造轮子。

## 去痕迹工程（2026-09-17 用户下达，进行中）
用户要求：**删去 CC / 上游 及其模型（Sonnet/Opus/Haiku）的痕迹；Limkenion 没有任何网站与云服务。**
模型那层用户已明确 **"全部都改"**（含内部标识符）。网站/云服务那层用户要先看清单再定。

### 实测规模（已排除 node_modules/dist/.git/web/node_modules/_backup）
| 类别 | 规模 |
|---|---|
| `CC` / `上游兼容` | 16 处 / 2 文件 —— **已处理**（`build-cli.mjs` 的 BRAND_TOKENS 必须保留） |
| `limkenion.ai` | 169 处 / 62 文件 |
| `limkenion.com` | 86 处 / 54 文件 |
| `github.com/limkenions/*` + `github.com/apps/limkenion` | 61 处 / 29 文件 |
| `sonnet` / `opus` / `haiku` | **1442 处 / 125 文件** |

**重要陷阱**：`github.com` 全仓 323 处，但**只有 61 处是痕迹**。其余是
「用户自己仓库的链接」与「git remote 解析」（`utils/git.ts` 解析 `github.com/owner/repo.git`）
—— **核心功能，绝不能动**。改之前必须抽样看，别按 host 一刀切。
同理 `octopus` 是普通单词，别被 `opus` 误伤。

### 自有服务端点清单（按服务分组）
- `code.limkenion.com/docs/en/*`（~30）—— 各处帮助文本的文档链接：mcp、security、sandboxing、
  keybindings、fast-mode、cli-reference、chrome、costs、hooks、memory、network-config、data-usage、overview
- `limkenion.ai/*`（~40）—— Chrome 扩展、Web 版(code)、Desktop 交付、账户设置
  （privacy / connectors / billing / usage）、OAuth 客户端元数据、下载、admin-settings
- `platform.limkenion.com/*`（~10）—— OAuth 授权流（authorize / token / code callback）、
  settings/keys、settings/billing、buy_credits、llms.txt、docs
- `limkenion.com/legal/*`、`www.limkenion.com/news/*`（~8）—— 条款 / 隐私 / AUP
- `support.limkenion.com/*`（3）—— 客服、guest passes
- `console.statsig.com/*`（3）—— 功能开关动态配置（GrowthBook/Statsig）
- `limkenion.slack.com/archives/*`（9）—— **源码注释里的内部讨论链接**
- `limkenion.sentry.io`（1）—— 错误上报
- `limkenion.fedstart.com` / `*-staging.fedstart.com`（2）—— 反馈调查
- `mcp-proxy.limkenion.com`（1）—— 远程 MCP 代理
- `storage.googleapis.com/limkenion-dist-*`、`limkenion-ci-sentinel`（3）—— 插件市场分发、CI 哨兵
- `downloads.limkenion.ai/limkenion-releases/plugins/*`（1）—— 官方插件市场（已默认关闭）
- `github.com/limkenions/*`、`github.com/apps/limkenion`（61）—— GitHub App 安装、GitHub Action、
  issue 链接、CHANGELOG
- `json.schemastore.org/limkenion-settings.json`、`www.schemastore.org/limkenion-keybindings.json`（3）
  —— 编辑器 JSON schema 校验
- `stickermule.com/limkenioncode`、`slack.com/marketplace/...`、`apps.apple.com/app/...`（3）—— 周边/Slack/iOS
- `artifactory.infra.ant.dev/*`、`*.ant.dev`、`127.0.0.1/api/*`（~10）—— 内部构建/测试端点

### 依赖这些服务、因而"光删链接会留空壳"的功能
远程 agent（`skills/bundled/scheduleRemoteAgents.ts` 11 处）、GitHub App
（`constants/github-app.ts` + `commands/install-github-app/*` 共 18 处）、Chrome 扩展
（`components/LimkenionInChromeOnboarding.tsx`、`utils/limkenionInChrome/*`、`commands/chrome/chrome.tsx`）、
Desktop 交付（`components/DesktopHandoff.tsx`、`utils/desktopDeepLink.ts`）、
超额计费（`commands/extra-usage/*`、`commands/review/ultrareviewCommand.tsx`）、
隐私设置（`commands/privacy-settings/*`）、遥测上报（`services/analytics/firstPartyEventLoggingExporter.ts`）、
插件市场自动安装（`utils/plugins/officialMarketplaceGcs.ts`，已默认关闭）。

### 模型层改名映射（计划，待执行）
`ALL_MODEL_CONFIGS`（`utils/model/configs.ts`，118 行，11 个 ModelKey × 4 provider）
→ 收敛为只有 `deepseekFlash` / `deepseekV4Pro`。ModelKey 引用只有 **32 处**，可控。
- `getDefaultHaikuModel` → `getDefaultSmallFastModel`；`getDefaultSonnetModel` / `getDefaultOpusModel`
  → `getDefaultMainModel`（各 16 处调用）
- `isNonCustomOpusModel` → `isNonCustomMainModel`（9 处）
- `queryHaiku` → `querySmallFastModel`（18 处）
- `opusplan` / `sonnetplan` / `haiku` 别名 → 从别名表移除（13 处）
- `seven_day_opus` / `seven_day_sonnet` 限流键、`migrateSonnet*` 迁移函数 → 纯服务端概念，删除

### 命令级处置清单（2026-09-17 核实）
用户决定：**云服务直接停用，能本地替代的替代。**

**① 已停用（commit 2f7288d，用 `isEnabled: () => false`，与 teleport/bughunter 惯例一致）**
`/mobile`、`/stickers`、`/passes`、`/install-github-app`、`/release-notes`、
`/think-back`、`/thinkback-play`

**② 已本地替代**
`/feedback` 原本 POST 到 `https://127.0.0.1/api/limkenion_cli_feedback`（不存在的内部端点，
必然失败）→ 改写 `~/.limkenion/feedback/<时间戳>-<id>.json`（0600）；
同时删掉把反馈正文 `logEventTo1P` 上报第一方遥测的调用（无云服务 + 那是用户原文）。

**③ 早就是死路径，无需处理**
`/chrome`、`/desktop`（`availability: ['limkenion-ai']` 需订阅 → 本地恒隐藏）、
`/privacy-settings`（`isConsumerSubscriber()`）、`/remote-env`（`isLimkenionAISubscriber()`）、
`/extra-usage`（`isOverageProvisioningAllowed()` 恒 false）、
`/rate-limit-options`（`isHidden: true`）、`/upgrade`、
以及 `/teleport`、`/ant-trace`、`/bughunter`、`/backfill-sessions`、`/mock-limits`、
`/reset-limits`、`/perf-issue`、`/issue`。

**④ 千万别误删 —— 功能是本地能力，只是带了个文档链接**
- **`/web` 是本地 Web UI 服务器**（`http://localhost:${port}`），是本仓库 `web/` 交付物的一部分，
  **必须保留**。
- `/fast`、`/memory` —— 只是 "Learn more: <Link>"，删链接即可。
- `/ide` —— IDE 集成本地可用；只有 JetBrains 插件下载链接指向不存在的 docs。
- `/mcp` —— 本地 MCP 保留；只有远程 MCP 代理（`mcp-proxy.limkenion.com`）没了。

### 关键陷阱：`availability` 字段的实际语义
`commands.ts:meetsAvailabilityRequirement()` 决定命令是否可见，在 `isEnabled()` **之前**运行：
- `availability: ['limkenion-ai']` → 要求 `isLimkenionAISubscriber()` → **本地恒 false → 隐藏**
- `availability: ['console']` → 要求 `!subscriber && !isUsing3PServices() && isFirstPartyLimkenionBaseUrl()`
  → **本地反而恒 true → 可见**（未设 `LIMKENION_BASE_URL` 时 `isFirstPartyLimkenionBaseUrl()` 返回 true）

判断"某命令本地是否可见"必须同时看 `availability` 和 `isEnabled` 两个条件，
只看其中一个会得出错误结论（我第一遍就错了）。

### 模型层改名映射（阶段一已完成，commit 6028b9b）
**阶段一：数据层收敛（已完成）**
- `configs.ts`：11 个上游模型配置 → `deepseekFlash` / `deepseekV4Pro`。
  `ModelConfig` 从 `Record<APIProvider, ModelName>` 简化为 `{ firstParty }`。
- `modelStrings.ts`：去掉 provider 取值与整套 Bedrock 分支。
- `modelCost.ts`：定价换成 DeepSeek 官方价（见下）。
- 38 处失效模型键引用（`.opus46` / `.sonnet46` / `.haiku45` …）批量改名。
- `getPublicModelDisplayName` 重写（原本重复 case 导致 deepseek-flash 显示成 "Sonnet 4.6"）。
- 键映射：`opus4x` → `deepseekV4Pro`；`sonnet4x` / `haiku4x` → `deepseekFlash`。

**阶段二：内部标识符改名（未做）** —— 剩 1258 处 / 120 文件
- `getDefaultHaikuModel` → `getDefaultSmallFastModel`（16 处调用）
- `getDefaultSonnetModel` → `getDefaultMainModel`（16 处）
- `getDefaultOpusModel` → `getDefaultStrongModel`（16 处）
- `isNonCustomOpusModel` → `isNonCustomStrongModel`（9 处）
- `queryHaiku` → `querySmallFastModel`（18 处）
- `opusplan` / `sonnetplan` / `haiku` 别名 → 从别名表移除（13 处）
- `seven_day_opus` / `seven_day_sonnet` 限流键、`migrateSonnet*` 迁移函数 → 纯服务端概念，删

### DeepSeek 官方定价（2026-09-17 核对，USD / 1M tokens）
来源 `https://api-docs.deepseek.com/quick_start/pricing`。峰时为 UTC 周一至周五
01:00-04:00 与 06:00-10:00，**其余时段为半价**。代码里取**峰时价**作保守上界。

| | 输入(缓存命中) | 输入(未命中) | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.006 | 0.3 | 1.2 |
| `deepseek-v4-pro` | 0.044 | 1.32 | 3.96 |

DeepSeek 前缀缓存**自动**、不收写入费 → `promptCacheWriteTokens` 记 0；无 web search 计费。

### 顺带纠正：`deepseek-flash` **支持 Vision**
官方模型表里 Vision 一栏 flash 是 ✓、v4-pro 是 ✗。我之前说"两边都没有视觉"是错的。
但 `openai-compat.ts` 的 `blockToText()` 对 `image` 块返回空串 —— 也就是说**图片会被静默丢掉**。
若要用上这个能力，得改适配器的图片翻译（OpenAI 协议走 `image_url`）。
另外官方还给出：上下文 1M、最大输出 384K、thinking 可开关、上游 端点同样可用。

### 定价：**已整体删除**（2026-09-17，commit 7ccfc45）
用户："定价删了吧，ds 价格老是变。"
- `utils/modelCost.ts` **整个文件已删**（ModelCosts / COST_* 档位 / MODEL_COSTS /
  getModelCosts / calculateUSDCost / calculateCostFromTokens / formatModelPricing /
  getModelPricingString / getDefaultModelCostTier）。
- `/cost` 只报它真正知道的东西：API 时长、墙钟时长、代码增删行数、按模型的 token 用量。
  **不要再往里加美元金额** —— DeepSeek 价格会变，写死就是错的。
- 模型选择器 / `/fast` / 模型描述里的 " · $x/$y per Mtok" 后缀已移除。
- `cost-tracker.ts` 的 `ModelUsage.costUSD` 字段**保留但恒为 0** —— 它是 SDK/会话输出契约
  的一部分，删掉会破坏下游读取。
- 遥测里的估算金额字段（classifierCostUSD 等）置为 `undefined`。

### 模型相关函数改名（阶段二·第一批，commit a361330）
| 现在 | 改成 | 处数 |
|---|---|---|
| `getDefaultHaikuModel` | `getDefaultSmallFastModel` | 7 |
| `getDefaultSonnetModel` | `getDefaultMainModel` | 16 |
| `getDefaultOpusModel` | `getDefaultStrongModel` | 16 |
| `isNonCustomOpusModel` | `isNonCustomStrongModel` | 9 |
| `queryHaiku` | `querySmallFastModel` | 18 |

**阶段二剩余（未做）**：`opusplan` / `sonnetplan` / `haiku` 别名（13 处）、
`seven_day_opus` / `seven_day_sonnet` 限流键（33 处）、`migrateSonnet*` 迁移函数（10 处），
以及注释/字符串里零散的模型名。改名一律用 `\b` 边界，**别误伤 `octopus`**。

### 阶段二·第二批：删除迁移与按模型分档限流（commit 见 git log）
- **删掉 6 个模型版本迁移函数**（整文件）：`migrateFennecToOpus`、`migrateLegacyOpusToCurrent`、
  `migrateOpusToOpus1m`、`migrateSonnet1mToSonnet45`、`migrateSonnet45ToSonnet46`、
  `resetProToOpusDefault`。它们把旧上游模型设置改写成更新的上游模型 ID —— 在 DeepSeek 下
  可能把用户设置改成不存在的模型名；而且都被 `isProSubscriber()` 之类挡着，本地恒 false。
  `main.tsx` 的导入与调用一并移除。
- **删掉 `seven_day_opus` / `seven_day_sonnet` 两档限流**（服务端响应头里的按模型分档窗口，
  DeepSeek 不发）。涉及 `limkenionAiLimits`（含用户可见的「Opus 限额」「Sonnet 限额」标签）、
  `api/usage`、`api/errors`、SDK 输出 schema、`Settings/Usage`、`rateLimitMessages`、
  `mockRateLimits`、`rateLimitMocking`。

### 又发现的死模块（`if (true) return false` 硬关掉，可整体删）
- `services/mockRateLimits.ts`（719 行）：`shouldProcessMockLimits()` 开头就是
  `if (true) return false`。删除需同时处理 `services/rateLimitMocking.ts` 与
  `utils/auth.ts` 的引用（`getMockSubscriptionType` / `shouldUseMockSubscription`）。
- `utils/model/modelCapabilities.ts`：`isModelCapabilitiesEligible()` 同样开头 `if (true) return false`。

**教训：判断"某功能是不是死的"最快的方法就是看它入口函数开头有没有 `if (true) return false`。
这个仓库里这种硬关断有好几处，别只看调用点就下结论。**

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
- **`isOpenAICompat()` 恒返回 `true`，不是"检测"出来的。** 上游协议在本项目里已永久移除，
  不存在"另一种模式"可回退。**同一个坑踩了两次**：第二版把它写成"检测到 key 才算兼容模式"，
  于是用户把 key 清空后 → false → 全仓库又回落到已删除的上游路径，
  表现为每次请求报"上游 client 已移除"，且欢迎屏模型名变回上游的 `Sonnet 4.6`。
  **"用哪套协议"和"有没有配 key"是两件事，绝不能混进同一个判断。**
  有没有 key 用 `hasAnyApiKeyConfigured()`（`utils/auth.ts`）。
- **"有没有配 key"统一用 `hasAnyApiKeyConfigured()`**：覆盖环境变量 + apiKeyHelper +
  `/login` 存到全局配置的 `primaryApiKey`。别各自去读 `process.env` ——
  `interactiveHelpers.tsx` 的启动向导原本就是这么写的，导致用户 `/login` 存了 key
  每次启动还被弹向导。
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
7. **密钥现状（2026-09-17 晚）**：用户要求"把密钥都删了，以后自己输"，已完成：
   - 注册表 `HKCU\Environment` 里的 `DEEPSEEK_API_KEY` —— 用户自行删除，已确认不存在
   - `~/.limkenion.json` 的 `customApiKeyResponses.rejected` 里有 1 条 key 片段 —— 已清空
     （备份在 `~/.limkenion.json.bak-20260917`）
   - `primaryApiKey` 本来就没存过
   - **下一步由用户自己在 `/login` 里输入 key。**
   - `D:\下载\agent\新建 文本文档.txt` 里还有一个有效 key —— 用户选择**自己处理**，
     **不要动这个文件**，也不要把内容复制到任何地方。
   - **key 值、key 片段一律不要写进仓库或记忆文件。**
   - 注意：环境变量优先级高于 `/login` 保存的 key（已实测确认），
     所以用户若又设了环境变量，`/login` 录的会被盖住。

## 上一轮差距盘点的两处更正（2026-09-17）
早先我按"裸调 `client.beta`"列出 12 处受影响能力，实测后有两处**本来就是死路径**，不必修：
- `utils/model/modelCapabilities.ts:93` 的 `models.list` —— `isModelCapabilitiesEligible()`
  开头就是 `if (true) return false`，整个函数早已硬关掉。
- `services/limkenionAiLimits.ts:209` 的配额检查 —— `checkQuotaStatus()` 被
  `shouldProcessRateLimits(isLimkenionAISubscriber())` 拦住，本地模式恒 false（除非设了 mock 开关）。

**教训**：报"某功能坏了"之前，先确认那条路真的可达（找守卫/短路条件），别只看调用点存在。

## 踩过的构建坑
- **JSDoc 里不能写 `**/`**：`/** ... **/login ... */` 中的 `*/` 会提前闭合注释块，
  esbuild 报 `Expected ";" but found "..."`，整个构建挂掉。
  写 `/login` 就好，别在块注释里给路径加 markdown 粗体。

## 测试相关
- `NODE_ENV=test` 会让 `services/vcr.ts` 的 `shouldUseVCR()` 返回 true，
  于是把 API 结果写成 `fixtures/*.json` 到 cwd。**正常 CLI 运行不写**。
  跑完单测记得 `rm -rf fixtures`，别误提交。它也不在 `.gitignore` 里（待用户定是否加）。
- 单测 React 组件模块能否加载（防循环依赖）比"渲染测试"性价比高：
  `import` 一下打印 `typeof`，撞循环依赖会立刻暴露。
