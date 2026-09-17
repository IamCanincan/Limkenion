# Limkenion 详情备忘（按需读取，不自动注入）

> `MEMORY.md` 是自动注入的、必须精简。**这份是按需查的详细清单**：
> 端点清单、命令级处置、改名映射表、功能对比细节。
> 逐轮流水在 `YYYY-MM-DD.md`。

---

## 一、自有服务端点清单（历史参考 —— **170 处 URL 已于 2026-09-18 全部删除**）

留档是为了万一将来要核对"某个功能原本依赖什么"。按服务分组：

| 服务 | 依赖它的功能 |
|---|---|
| `code.limkenion.com/docs/en/*` | 各处帮助文本的文档链接：mcp、security、sandboxing、keybindings、fast-mode、cli-reference、chrome、costs、hooks、memory、network-config、data-usage、overview |
| `limkenion.ai/*` | Chrome 扩展、Web 版、Desktop 交付、账户设置（隐私/连接器/计费/用量）、OAuth 客户端元数据、下载、admin-settings |
| `platform.limkenion.com/*` | OAuth 授权流（authorize/token/code callback）、API Key 管理、买额度、llms.txt、docs |
| `limkenion.com/legal/*`、`www.limkenion.com/news/*` | 条款 / 隐私 / AUP |
| `support.limkenion.com/*` | 客服、guest passes |
| `console.statsig.com/*` | 功能开关动态配置（GrowthStatsig） |
| `limkenion.slack.com/archives/*` | **源码注释里的内部讨论链接**（9 处） |
| `limkenion.sentry.io` | 错误上报 |
| `limkenion.fedstart.com`、`*-staging.fedstart.com` | 反馈调查 |
| `mcp-proxy.limkenion.com` | 远程 MCP 代理 |
| `storage.googleapis.com/limkenion-dist-*`、`limkenion-ci-sentinel` | 插件市场分发、CI 哨兵 |
| `downloads.limkenion.ai/limkenion-releases/plugins/*` | 官方插件市场（已默认关闭） |
| `github.com/limkenions/*`、`github.com/apps/limkenion` | GitHub App 安装、GitHub Action、issue 链接、CHANGELOG |
| `json.schemastore.org/limkenion-settings.json` 等 | 编辑器 JSON schema 校验（**schemastore.org 是真实第三方服务，但那两个 schema 文件不存在**） |
| `stickermule.com/limkenioncode`、`slack.com/marketplace/*`、`apps.apple.com/app/*` | 周边商品、Slack 应用、iOS App |
| `artifactory.infra.ant.dev/*`、`*.ant.dev`、`127.0.0.1/api/*` | 内部构建 / 测试端点 |

**重要陷阱**：`github.com` 全仓 323 处，但**只有 61 处是痕迹**。其余是
「用户自己仓库的链接」与「git remote 解析」（`utils/git.ts` 解析 `github.com/owner/repo.git`）
—— **核心功能，绝不能动**。改之前必须抽样看，别按 host 一刀切。

**遗留空壳**（下一步要收）：12 个 `const *_URL = ''`、约 20 处 `<Link url="" />`、
几处悬空的 `Learn more: `。

---

## 二、命令级处置清单（2026-09-17 核实）

**① 已停用**（`isEnabled: () => false`，与 teleport/bughunter 惯例一致）
`/mobile`、`/stickers`、`/passes`、`/install-github-app`、`/release-notes`、
`/think-back`、`/thinkback-play`

**② 已本地替代**
`/feedback` 原本 POST 到 `https://127.0.0.1/api/limkenion_cli_feedback`（不存在的内部端点，
必然失败）→ 改写 `~/.limkenion/feedback/<时间戳>-<id>.json`（0600）；
同时删掉把反馈正文 `logEventTo1P` 上报第一方遥测的调用。

**③ 早就是死路径，无需处理**
`/chrome`、`/desktop`（`availability: ['limkenion-ai']` 需订阅 → 本地恒隐藏）、
`/privacy-settings`（`isConsumerSubscriber()`）、`/remote-env`（`isLimkenionAISubscriber()`）、
`/extra-usage`（`isOverageProvisioningAllowed()` 恒 false）、
`/rate-limit-options`（`isHidden: true`）、`/upgrade`、
以及 `/teleport`、`/ant-trace`、`/bughunter`、`/backfill-sessions`、`/mock-limits`、
`/reset-limits`、`/perf-issue`、`/issue`。

**④ 千万别误删 —— 功能是本地能力，只是带了个文档链接**
- **`/web` 是本地 Web UI 服务器**（`http://localhost:${port}`），是本仓库 `web/` 交付物的一部分，
  **必须保留**。它的名字里有 "Web" 但跟 limkenion.ai 无关。
- `/fast`、`/memory` —— 只是 "Learn more: <Link>"，删链接即可。
- `/ide` —— IDE 集成本地可用；只有 JetBrains 插件下载链接指向不存在的 docs。
- `/mcp` —— 本地 MCP 保留；只有远程 MCP 代理没了。

---

## 三、模型层改名映射

### 阶段一：数据层（已完成）
- `configs.ts`：11 个上游模型配置（各 × 4 provider）→ `deepseekFlash` / `deepseekV4Pro`。
  `ModelConfig` 从 `Record<APIProvider, ModelName>` 简化为 `{ firstParty }`。
- `modelStrings.ts`：去掉 provider 取值与整套 Bedrock 分支。
- 38 处失效模型键引用（`.opus46` / `.sonnet46` / `.haiku45` …）批量改名。
- 键映射：`opus4x` → `deepseekV4Pro`；`sonnet4x` / `haiku4x` → `deepseekFlash`。
- `getPublicModelDisplayName` 重写（原本重复 case 导致 `deepseek-flash` 显示成 "Sonnet 4.6"，
  那就是欢迎屏上那个名字的来源）。

### 阶段二·第一批：函数改名（已完成）
| 原 | 现 | 处数 |
|---|---|---|
| `getDefaultHaikuModel` | `getDefaultSmallFastModel` | 7 |
| `getDefaultSonnetModel` | `getDefaultMainModel` | 16 |
| `getDefaultOpusModel` | `getDefaultStrongModel` | 16 |
| `isNonCustomOpusModel` | `isNonCustomStrongModel` | 9 |
| `queryHaiku` | `querySmallFastModel` | 18 |

**当前默认值**：主模型与快模型 = `deepseek-flash`，强模型 = `deepseek-v4-pro`。

### 阶段二·第二批：删除（已完成）
- 6 个模型版本迁移函数整文件删除：`migrateFennecToOpus`、`migrateLegacyOpusToCurrent`、
  `migrateOpusToOpus1m`、`migrateSonnet1mToSonnet45`、`migrateSonnet45ToSonnet46`、
  `resetProToOpusDefault`。它们把旧上游模型设置改写成更新的上游模型 ID —— 在 DeepSeek 下
  **可能把用户设置改成不存在的模型名**；且都被订阅判定挡着，本地恒 false。
- `seven_day_opus` / `seven_day_sonnet` 两档限流全删（服务端响应头里的按模型分档窗口，
  DeepSeek 不发）。涉及 8 个文件，含用户可见的「Opus 限额」「Sonnet 限额」标签。

### 剩余（未做）
- `opusplan` / `sonnetplan` / `haiku` 别名（13 处）—— `opusplan` 的语义是"plan 模式用强模型"，
  在 DeepSeek 下仍成立（v4-pro 用于 plan、flash 其余），**别简单删掉，要改名或重映射**。
- 注释/字符串里零散的模型名（约 980 处）。
- 改名一律用 `\b` 边界，**别误伤 `octopus`**。

---

## 四、与参照实现（`D:\下载\agent`）的功能对比

**参照物**：
- `upstream-ref-impl` —— 上游 CLI 原型 **桌面端工作台**（底座同源，最有参考价值）
- `deepseek-harness`（`dsh`）—— DeepSeek **官方** agent harness，插件化 + Web UI
- `deepseek-reasonix` —— DeepSeek agent CLI，配置驱动 + 单二进制分发

**我们已有**（核实过）：computerUse、workflows、swarm/Agent Teams、teleport、agents、
plugins、memdir、MCP、skills、hooks、沙箱、5 档权限模式、子代理、后台任务、会话管理
（resume/fork/rewind）、本地 Web UI、IDE 集成、headless/print、SDK。

**我们缺的**（按值得补的程度排序）：
1. **思考模式暴露不全** —— `/effort` 是空操作、没有"关闭思考"入口（见 MEMORY.md）
2. **视觉/图片输入** —— `deepseek-flash` 官方支持，但适配器 `blockToText()` 丢图
3. **本地定时任务** —— 原调度依赖云端（已停用），无本地替代
4. 桌面端 App、IM 接入（upstream-ref-impl 有 8 个平台）、模型请求追踪面板、单二进制分发、VS Code 扩展
5. 图片生成（属云端，不建议做）、多供应商（用户已明确只做 DeepSeek）

---

## 五、去痕迹工程总账（2026-09-18 收官）

| 类别 | 结果 |
|---|---|
| `CC` / `上游兼容` / `内部代号` | **0 命中**（唯一例外是 build 脚本的 `BRAND_TOKENS` 清洗名单，故意保留） |
| 自有服务 URL / 域名 | 170（带 scheme）+ 151（裸域名）+ 87（注释行）+ 53 → **8 处**（1 处假阳性 + 7 处契约值/邮件） |
| `sonnet` / `opus` / `haiku` | 1442 → **10 处**（全是同名巧合） |
| 整文件删除 | 4 个：`services/mockRateLimits.ts`（719 行）、`utils/model/modelCapabilities.ts`（118 行）、`constants/product.ts`（139 行）、`utils/modelCost.ts` |
| `modelOptions.ts` | 整文件重写，514 → 63 行（净删 447） |
| 云服务命令 | 停用 7 个：`/mobile` `/stickers` `/passes` `/install-github-app` `/release-notes` `/think-back` `/thinkback-play`；`/feedback` 改本地文件 |

### 那 10 处 `sonnet/opus/haiku` 为什么保留（全是同名巧合）
| 位置 | 为什么保留 |
|---|---|
| `utils/shell/readOnlyCommandValidation.ts` 的 `'--octopus'` | **git 的真实参数**（`git merge-base --octopus`） |
| `utils/words.ts` 的 `'octopus'` / `'sonnet'` | **随机词表**里的英文单词 |
| `constants/files.ts` 的 `'.opus'` | **音频文件扩展名** |

**教训：批量改名前必须区分"同名巧合"。** 这轮里 `octopus`（桌神精灵 / git 参数 / 词表单词）
三种完全不同的用途都出现过，只看 grep 计数就动手会误伤。

### 那 8 处域名为什么保留
| 位置 | 为什么保留 |
|---|---|
| `bootstrap/state.ts` 的 `'limkenion.commit.count'` | **假阳性** —— 指标名，`limkenion.com` 只是它的前缀 |
| `utils/auth.ts` + `cli/handlers/auth.ts` + `statusNoticeDefinitions.tsx` 的 `'limkenion.ai'` | **认证来源的枚举值**，读写成对 |
| `@limkenion.com`（3 处） | **邮件地址**（会写进 git 提交 trailer）—— 已在 2026-09-18 按用户要求删除 |

### 模型层改名映射（完整表）
**阶段一：数据层**
- `configs.ts`：11 个上游模型配置（各 × 4 provider）→ `deepseekFlash` / `deepseekV4Pro`。
  `ModelConfig` 从 `Record<APIProvider, ModelName>` 简化为 `{ firstParty }`。
- `modelStrings.ts`：去掉 provider 取值与整套 Bedrock 分支。
- 38 处失效模型键引用（`.opus46` / `.sonnet46` / `.haiku45` …）批量改名。
- 键映射：`opus4x` → `deepseekV4Pro`；`sonnet4x` / `haiku4x` → `deepseekFlash`。

**阶段二·第一批：函数改名**
| 原 | 现 | 处数 |
|---|---|---|
| `getDefaultHaikuModel` | `getDefaultSmallFastModel` | 7 |
| `getDefaultSonnetModel` | `getDefaultMainModel` | 16 |
| `getDefaultOpusModel` | `getDefaultStrongModel` | 16 |
| `isNonCustomOpusModel` | `isNonCustomStrongModel` | 9 |
| `queryHaiku` | `querySmallFastModel` | 18 |

**阶段二·第二批：删除**
- 6 个模型版本迁移函数整文件删除（`migrateFennecToOpus` / `migrateLegacyOpusToCurrent` /
  `migrateOpusToOpus1m` / `migrateSonnet1mToSonnet45` / `migrateSonnet45ToSonnet46` /
  `resetProToOpusDefault`）
- `seven_day_opus` / `seven_day_sonnet` 两档限流全删
- 别名表：`MODEL_ALIASES` → `deepseek-flash` / `deepseek-v4-pro` / `proplan`；
  `MODEL_FAMILY_ALIASES` 清空。`opusplan` → `proplan`（**重映射而非删除** ——
  它的语义是"plan 模式用强模型"，在 DeepSeek 下仍成立）

### 源码冗余清理（2026-09-18）
**① 删 8 个零引用的死文件**：`cli/transports/ccrClient.ts`、`cli/transports/transportUtils.ts`、
`services/api/firstTokenDate.ts`、`utils/model/check1mAccess.ts`、`utils/taggedId.ts`、
`utils/workflows/ultracode.ts`、`constants/sessionIdCompat.ts`、`utils/sessionIdCompat.ts`

**② 删 355 个"导出了但没人用"的符号**（192 文件，-4083 行）。
保留 `entrypoints/sdk/` 的 23 个（SDK 输出格式的公开定义）。

**边界识别的三个坑**：① 参数列表的圆括号被当成声明体 → 只删签名留下函数体；
② 漏了联合类型的行延续符号 `|`；③ 跨行返回类型。
**最终方案**：逐文件用 esbuild 的 `transform()` 做语法校验，失败就 `git checkout` 回退。
202 个改动文件里 10 个被自动回退。

## 六、三处功能修复（2026-09-18 用户拍板）
- `MODEL_CONTEXT_WINDOW_DEFAULT` 200K → **1M**（`utils/context.ts`）—— 长对话不再被过早压缩
- `MAX_OUTPUT_TOKENS_UPPER_LIMIT` 64K → **384K**（默认值保持 32K，那是策略值）
- **图片输入打通**（`services/api/openai-compat.ts`）：新增 `imageBlockToOpenAIPart()` 与
  `contentToOpenAIContent()`，把 image block 翻成 OpenAI 的 `image_url` part。
  没图片时仍返回字符串，有图片时返回 content part 数组。
  **实测**：`deepseek-flash` 能看见图（纯红图答"红色"），`deepseek-v4-pro` 看不见（答"白色"，不报错）。

## 七、三处功能补充（2026-09-18 用户拍板"都加"）
- **`/effort` 不再是空操作**：`getRuntimeReasoningEffort()` 补上第三层回落
  `运行时 set > REASONING_EFFORT env > 设置文件里的 effortLevel > 空`。
- **新增 `/schedule` 命令**（`commands/schedule/`）：列出/删除本地定时任务。
  `isEnabled` 挂 `isKairosCronEnabled()`。
- **结构化输出打通**：`modelSupportsStructuredOutputs` → true，
  **且** `toOpenAITools()` 转发 `strict: true`（**只改前者没用** —— 适配器原本不转发）。

### 更正：本地定时任务其实一直都有
`tools/ScheduleCronTool/`（`CronCreate`/`CronDelete`/`CronList`）+ `utils/cronScheduler.ts` +
`utils/cronTasks.ts`（存 `.limkenion/scheduled_tasks.json`）+ `hooks/useScheduledTasks.ts`。
**是开着的**：`feature('AGENT_TRIGGERS')` 不在 `bun-bundle-stub.ts` 的
`UNSUPPORTED_UPSTREAM_FEATURES` 里 → 返回 true。真正没的只是 `/schedule` 命令入口。

## 八、与参照实现的差距：API 接入层几乎无差别（实测）
`D:\下载\agent\upstream-ref-impl` 接 DeepSeek 用 **上游 端点**
（`src/server/config/providerPresets.json`：`baseUrl: https://api.deepseek.com/上游兼容`、
`apiFormat: 上游兼容`、`main: deepseek-v4-pro[1m]`）；我们走 OpenAI 端点。

| 能力 | OpenAI 端点（我们） | 上游 端点（upstream-ref-impl） |
|---|---|---|
| 思考模式 | 默认开启，`reasoning_content` | 默认开启，`thinking` 块 |
| 思考签名 | ❌ 无 | ✅ 有 `signature` |
| 提示缓存 | `prompt_cache_hit_tokens` | `cache_read_input_tokens` |
| 显式缓存断点 | ❌ 不发 `cache_control` | ✅ 支持 |
| 强制工具 + 推理 | ❌ 400 | ❌ **400（同样报错）** |
| 视觉 | ✅ flash 支持 | ✅ |

**两个关键纠正（都实测过）**：
1. **"强制工具 + 推理"的 400 冲突是两个端点共有的** —— 那是 DeepSeek **模型**的限制。
   **换端点并不能解决它。**
2. **提示缓存在两个端点上都能拿到命中数**，只是字段名不同。我们并没有"缺缓存"。

**唯一实质差异**：上游 端点的 thinking 块带 `signature`，多轮时可原样传回；
我们这条路径拿不到签名，所以 `toOpenAIMessages` 直接丢弃 thinking
（OpenAI 协议本来也不该回传 `reasoning_content`）。

**结论：真正的差距不在 API 层，而在功能层**（upstream-ref-impl 是完整桌面工作台）。
按用户"只支持 DeepSeek"的决定，多供应商那条不算缺口。
