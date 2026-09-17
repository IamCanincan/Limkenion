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
