# Limkenion 交接文档（供下一个 agent 接力）

> 写于 2026-09-19，同日由接力 agent 复核并修正（原文三处结论有误，见第八节）。
> **本文件随仓库走**（在 `.workbuddy-ai/memory/` 下，`.gitignore` 对这个目录开了白名单）。
> 权威记忆：`MEMORY.md`（自动注入）/ `MEMORY-details.md`（按需读）/ `YYYY-MM-DD.md`（逐轮流水）。
> 本文件只作入口索引。

## 一、项目是什么
- 纯 web 的本地 AI agent 应用，模型供应商目前只接 DeepSeek（预留了多供应商扩展点）。
- 仓库里只有 `web/`：Vite + React 18 前端 + 本地 Node 服务（同端口伺服静态页与 WebSocket），
  原 CLI 源码树已删除（详见第六节）。
- CI：Gitee Go（`.workflow/ci.yml`，push 到 master 触发 typecheck + 测试 + build）。
  远程 origin 指向 Gitee（URL 内含私人 token，勿外泄、勿改动）。

## 二、功能现状（对标已全部补齐）
27 个钩子事件 × 4 种执行类型（command/prompt/agent/http）；MCP（stdio/http/sse +
elicitation/OAuth/sampling/roots/prompts/registry 搜索）；自动 compact + microcompact；
文件检查点（Write/Edit 落盘 + Bash 工作区快照）；后台 Bash（TaskOutput/TaskStop）；
出站白名单（`LIMKENION_EGRESS_ALLOWLIST`）；非回环绑定 LAN 鉴权；outputStyle 注入；
LIMKENION.md/AGENTS.md instructions 加载；回合中排队消息；localhost 预览面板（PreviewUrl + iframe）；
Computer Use（Windows PowerShell 零依赖，`LIMKENION_WEB_COMPUTER_USE=1`，非 Windows 自动禁用）；
Agent Teams 工作台（TeamPanel + 成员事件流 + teammate-idle 钩子）。

## 三、桌面分发（已提交 `c86abed`）
- **Tier C 内置 Node**：`cd web && npm run release` → `web/release/limkenion-web-0.5.0.zip`（448MB）。
  zip 内含预构建 `dist/` + `server/` + `node_modules/ws` + 三平台无终端入口 +
  **官方 Node v24.21.0 四份二进制**（win-x64 放根 `node/`；mac 两架构放
  `Limkenion.app/Contents/Resources/node/` 随 .app 移动；linux-x64 放根 `node/`）+
  `version.json` + `NEEDS_NODE.txt` + node 的 LICENSE。
- 入口链路：双击入口（原生，无需 Node）→ 优先用**包内 node** → 缺失回退系统 `node` →
  仍缺失弹 GUI 提示框（含下载地址）。
- 更新器 `web/launcher/updater.mjs`：先解到临时目录再拷贝，**跳过 `node/` 与 `.app` 内
  Resources/node**，内置 Node 不被更新覆盖。它有 13 项回归测试（`web/test/updater.test.mjs`），
  锁住两条"错了看不出来"的保证：版本比较必须数值比较（否则 0.10.0 < 0.9.0）、
  跳过 node/ 但不能误伤 `node_modules/`。
- 已知点：① 448MB 偏大；② macOS 包内未签名 node 会被 Gatekeeper 拦；
  ③ Linux 依赖官方 node 的 glibc 基线，Alpine/musl 不适用。

## 四、验证命令（改完代码必须全跑）
```bash
cd web
npm run typecheck    # tsc 前端 + server，必须 0 错误（注意：别用管道 tail 掩盖退出码）
npm test             # node --test test/*.test.mjs（354 项）
npm run test:ui      # vitest（web/src/__tests__）
npm run build        # vite build
npm run test:e2e     # 真实 API（改了 worktree / hooks / MCP / Workflow / 沙箱作用域 / 桌面入口才跑）
npm run release      # 出包验证（需联网拉 Node，可跳过）
```

## 五、git 状态（2026-09-19 13:50）
- 工作树干净；`master` 上有 **9 个未推送的提交**（按项目规矩不 push，要推需用户明确指示）：
  `c86abed` 桌面分发 · `a814077` launcher 类型错误 + 注释中文化收尾 + 后台测试加固 ·
  `bbef49f`/`531c66c`/`a365df7` 记忆 · `2012409` B28 全仓库复查 ·
  `a4bcf6d` 更新器回归防线 · `b6656d8` 非代码文本中文化 · `09a32b7` README 同步。
- `.workbuddy/`（另一运行时的目录）**已加入 `.gitignore`** —— 项目记忆统一在 `.workbuddy-ai/memory/`，
  不要再往那边写。
- `web/release/` 已在 `.gitignore` 中，勿提交。

## 六、注释中文化 —— **已收官；CLI 树已彻底删除**
- 工作树（`web/` + `scripts/`）**已 100% 中文化**。扫描结论见 `.workbuddy-ai/i18n/B28_REPORT.md`：
  只剩 44 行"不该译"的英文注释（JSDoc 类型定义、类型签名、路径示例、行内代码、事件名标记、
  eslint 指令、枚举值）。斜杠命令描述 69/69 中文；工具 description 115 中文 / 2 枚举值；
  前端 UI 只剩品牌名 `Limkenion` ×3 与术语 `token`/`Tokens` ×2。
- 原 `COMMENT_I18N_PLAN.md` 的 B2–B27 针对 CLI 树，**已作废**。
- **`archive/cli` 已彻底删除**（2026-09-19）：本地分支、worktree、**远程分支**全部移除，
  远程现只剩 `master`。删前做了两层保全（都在仓库外）：
  | 文件 | 内容 |
  |---|---|
  | `D:/Github Repositories/limkenion-archive-cli-aa1ffaf.bundle`（~16 MB） | 完整 CLI 树，含 `refs/heads/archive/cli` = `aa1ffaf` |
  | `D:/Github Repositories/limkenion-cli-i18n-wip-47pct.patch`（5 MB） | 已完成的 47% 译文（550 文件 / 11,135 块） |
  恢复：`git fetch <bundle> archive/cli:archive/cli` → `git apply <patch>`。
  **CLI 不再是待译项，也不要再从 `archive/cli` 取源码。**

**硬约束（对任何后续改动仍适用）**：
- 仓库（含全部历史）已用 git filter-repo 全量抹除**原上游品牌词**。任何新代码/注释/文档
  **绝不能把这些词带回来** —— 解释设计来源时用中性说法（如「参考通用 CLI agent 的设计」）。
- `.gitattributes`：`web/launcher/**` 锁 LF（仅 `.vbs` 锁 CRLF）、`scripts/**` 锁 LF。
- UI 文案若被测试断言匹配（`web/src/__tests__/`、`web/test/`），翻译后必须同步改测试。
- 注释与用户可见文案用中文，代码标识符用英文；缩进 2 空格，无分号结尾。

## 七、平台坑（开发机 = Windows）
- Windows 自带 GNU tar **不能解 .zip**；bsdtar 会把 `D:/...` 误判为远程主机（`host:path`）
  → tar 操作一律**相对路径 + 指定 cwd**。解 .zip 用 PowerShell `Expand-Archive`。
- `spawnSync` + `shell:true` 时注意引号转义（路径含空格如 `Github Repositories`）。
- PowerShell `[Math]::Min(1, 0.39)` 会走 int 重载截断成 0，必须写 `1.0`。
- **别从 bash 里调 PowerShell**（会被安全策略拦），用 PowerShell 工具；
  `Remove-Item` 接管道对象会报参数绑定失败，用 `-LiteralPath $f.FullName` 逐个删。
- `npm run typecheck` 的退出码别被 `| tail` 之类管道掩盖，要单独检查。

## 八、复核时修正的三处（原文有误，供参考）
1. **原文说 typecheck 通过，实际是红的**：`web/launcher/updater.mjs` 有 5 个 TS 错误。
   原因：`tsconfig.server.json` 的 include 虽只写 `server/**/*.mjs`，但 `server/static.mjs`
   **import 了** `../launcher/updater.mjs`，TS 顺 import 把 launcher/ 一并检查。
   → **往"被 import 的目录"下新增文件 = 悄悄扩大类型检查面，必须重跑 typecheck。** 已修。
2. **原文说下一任务是"源码全量翻译"，实际工作树已无待译项**（只剩不该译的类型定义等）。
3. **`.workbuddy/memory/` 是第二套记忆**（另一运行时写的），其 09-18 日志自己声明
   「统一放 `.workbuddy-ai/memory/`，不要另起一套」→ 已把本文件搬进 `.workbuddy-ai/memory/`，
   并把 `.workbuddy/` 加入 `.gitignore`。
