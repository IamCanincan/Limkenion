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

**2026-09-19 下午新增 9 项**（都是 web 端界面/能力，CLI 无对应）：全局搜索（Cmd+K，跨会话
消息+标题+文件名，结果带 `complete`）；MCP 图形化管理（增删改 + user/project/local 三作用域）；
定时任务界面（周期解析与模型的 CronCreate 共用 `tools.parseIntervalMs()`）；分支/worktree
启动（新会话选分支进隔离 worktree，分支名过 `validateBranchName()` 防注入，**刻意不支持
"选分支但用当前工作树"**）；具名子代理（只覆盖模型与**只读工具集的子集**，Write/Bash 一律拒）；
6 套配色（纸墨/经典暖色/青瓷/墨夜蓝 等，只覆盖 CSS 变量）；shell 出网 allowlist
（本进程内 HTTP 代理，`LIMKENION_WEB_SHELL_NET=allowlist`）；权限规则显式 `key:pattern`
（裸 specifier 仍不猜 → unsupported）；钩子输出上下文预算（超 8000 字落盘 `hook_outputs/`）。

**2026-09-19 下午新增 8 项韧性**：进程崩溃兜底（未捕获拒绝不再打死服务）· WS 单条消息异常隔离 ·
广播对坏客户端隔离 · HTTP 顶层兜底 · shell 超时**连根杀进程树**（含后台任务上限）·
资源上限（输出截断 / 并行上限）· 会话删除清检查点、截图不留残 · 关停完整性（closeAll + clearTimers）。

27 个钩子事件 × 4 种执行类型（command/prompt/agent/http）；MCP（stdio/http/sse +
elicitation/OAuth/sampling/roots/prompts/registry 搜索）；自动 compact + microcompact；
文件检查点（Write/Edit 落盘 + Bash 工作区快照）；后台 Bash（TaskOutput/TaskStop）；
出站白名单（`LIMKENION_EGRESS_ALLOWLIST`）；非回环绑定 LAN 鉴权；outputStyle 注入；
LIMKENION.md/AGENTS.md instructions 加载；回合中排队消息；localhost 预览面板（PreviewUrl + iframe）；
（Computer Use 已于 2026-09-19 按用户要求**整体删除**）；
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
npm test             # node --test test/*.test.mjs（469 项）
npm run test:ui      # vitest（web/src/__tests__）
npm run build        # vite build
npm run test:e2e     # 真实 API（改了 worktree / hooks / MCP / Workflow / 沙箱作用域 / 桌面入口才跑）
npm run release      # 出包验证（需联网拉 Node，可跳过）
```
**推送前建议先跑**（在**仓库根目录**，不是 web/）：
```bash
node scripts/ci-sim.mjs    # 用纯净工作树跑一遍 CI 序列（见第七点五节）
```

## 五、git 状态（2026-09-19 20:20 更新：**已推送，与远程同步**）
- 工作树干净；**本地与 `origin/master` 完全同步**（领先 0 / 落后 0）。
- 18:13 首次推送 63 个提交；此后到 20:20 又陆续推了自查修复与 CI 改动，
  最新为 `3673e03`（ci-sim 脚本 + 文档）。**推送需用户明确指示**这条规矩不变。
- 2026-09-19 18:13 经用户明确指示执行了 `git push origin master`：
  一次推了 **63 个提交**（`faa232a..59ad3d9`），此前这批**从未过 CI**（Gitee Go 只在 push
  时触发，`.workflow/ci.yml` 跑 typecheck + test + build）。
  → push 后建议去看一眼 Gitee Go 的流水线结果（本地四件套 + E2E 24/24 已全绿，但 CI 是独立环境）。
- 规矩不变：**不 push、不动 git config**，要推必须用户明确说。
- 2026-09-19 当天新增：上午桌面分发 + 注释中文化收尾那批（见上），
  **下午又合了 8 项韧性 + 9 项功能 + 文档对齐**，测试数 381 → **452**。
  功能：`4d4e89f` 钩子输出预算 · `e5be038` 全局搜索 · `e11be82` 权限 key:pattern ·
  `01a4bdf` MCP 图形化管理 · `24d5abb` 定时任务界面 · `d770121` 分支/worktree 启动 ·
  `4e39e96` 6 套配色 · `b6614c1` 具名子代理 · `cffdc3b` shell 出网 allowlist ·
  `5e39ced` README 对齐。韧性：`1c3a945` 进程崩溃兜底 · `a6aa359` WS 消息隔离 ·
  `249d073` 广播隔离 · `58dbb85` HTTP 顶层兜底 · `8dc3bc6` 进程树 kill ·
  `3eba7ae` 资源上限 · `55326e7` 残留清理 · `6b88c41` 关停完整性。
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

## 七点五、2026-09-19 晚：CI 三轮排查 + 自查 7 处（重要，别重走弯路）

### CI 三次失败，三个完全不同的原因

| 轮次 | 现象 | 根因 |
|---|---|---|
| 1、2 | `step ... exited with code 1`，无细节 | **环境里根本没有 node/npm**（`node: command not found`）|
| 3 | 同上但拿到细节 | **真代码问题**（见下 3 条）|

**Gitee Go 的两个坑（记住）**：
- `build@nodejs` 的 `nodeVersion` **不可信**：官方文档只列到 15.12；写 `'22'` 时插件装不上
  Node。现在 `.workflow/ci.yml` 是**自己在脚本里下载 Node 22.22.2** 解到 `/opt` 并前置 PATH
  （`nodeVersion: '14.16.0'` 只为让插件不报错，实际不用它）。
- 容器镜像名 `ubuntu:plugin-24` 里的 **24 是插件版本，不是 Node 版本** —— 别对着它猜。
- **CI 结果查不到**：v5 API 没有流水线端点（4 个端点全 Not Found），网页需登录。
  只能让用户贴日志。为此 ci.yml 里加了 `|| fail '<名字>'` 诊断，失败会打印
  「❌ 失败于：X」，并打了 `node -v`。

### 第 3 轮暴露的 3 个真问题（全是"本地有 dist、CI 全新检出没有"）

1. `startServer` 就绪判定写的 `if (res.ok)` → 没 dist 时 `/` 是 404 → 15s 超时
   "服务未就绪"，**但日志里服务明明起来了**。→ 改为"只要有 HTTP 响应就算就绪"。
2. `fetchToken` 从 `dist/index.html` 正则取 token → 没 dist 就拿不到 → WS 握手 **403**，
   报错完全指不到根因。→ 改用 `/ws-token` 接口，彻底去掉对 dist 的依赖。
3. `mcpOAuth.openBrowser`：`spawn` **不因命令不存在而抛错**，ENOENT 是异步 `'error'` 事件，
   `try/catch` 接不住 → 未捕获异常打死进程（容器无 `xdg-open`）。→ 挂 `child.on('error')`。

另外：静态服务那几条用例**本来就需要 dist**，所以 ci.yml 里把 `npm run build` 移到
`npm test` **之前**；并给它们加了"dist 未构建则明说跳过"。

### 自查 7 处（都是白天赶功能漏掉的边界）

| # | 问题 | 性质 |
|---|---|---|
| 1 | 出网开关漏了 Windows shell 工具那条路径（`execFile` 没传 `shellNetEnv`）｜**安全**：设了 `off` 仍能出网 |
| 2 | 定时周期无上限 → 超大值被 `setInterval` 当成 **1ms** | 可用性：每毫秒起回合 |
| 3 | MCP 服务器名无校验（`__` 会把反解切错 / 长度超 64 害整请求 400）| 可用性 |
| 4 | 具名子代理找不到却说"已执行"（实际直接 return 没跑）| **诚实性**（+ 只有 typecheck 抓到的 TS2345）|
| 5 | 钩子预算是"每条各一份" → N 条叠加照样撑爆 | 防护形同虚设（+ 我的测试阈值太松是"假绿"）|
| 6 | 权限规则工具名没归一化（`EnterPlanMode` ≠ `PlanEnter`）| **安全：deny 静默失效** |
| 7 | 同名 worktree 换分支 → 静默带进错的分支 | 静默错误行为 |

**规律**：漏的全是边界 —— 输入校验、数值上下限、别名/归一化、横切控制是否覆盖所有路径，
以及"**操作其实没成功却说成功了**"。

### `scripts/ci-sim.mjs`（新增，仓库根目录执行）

用 `git archive HEAD | tar -x` 导出纯净工作树（不含 dist/ 与 node_modules/），
再按 CI 顺序跑 install → typecheck → build → test → test:ui。
**以后验证"会不会在 CI 上红"，先本地跑它**，别推一次等一次。
已处理的 Windows 坑：tar 的 `-C` 不建目录且 bsdtar 会误判 `D:/...`；
npm 是 `npm.cmd`，`shell:true` 会触发 DEP0190 → 改用 `cmd.exe /d /s /c` 且参数分开传。

### 多端统一性（2026-09-19 盘点结论）

核心能力**完全统一**；真正的平台差异只有 2 项，且都会明确报错而非静默失败：
① Windows shell 工具（仅 win，平台固有）。（Computer Use 已于 2026-09-19 整体删除，不再讨论移植。）
- **macOS 从未实机验证过**（linux 有 CI 覆盖一部分）—— 这是当前最大的验证缺口。

## 八点五、还剩什么（2026-09-19 18:10 盘点，均未做，需用户拍板）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| ~~62 个提交未推送~~ | **已解决** | 已推送。CI 三轮排查后，`3673e03` 这轮跑的是最终状态（详见第七点五节）。**结果需用户从 Gitee 页面确认** —— 没有 API 可查 |
| **macOS 实机验证** | **最大验证缺口** | 三平台入口齐备（.vbs / .app / .sh+.desktop），但 mac **从未实机跑过**；linux 有 CI 覆盖。有机器的话优先补这个 |
| 内置终端 | **建议不做** | 需 PTY（`node-pty` 之类原生模块），与"只依赖 Node"硬约束冲突；会让分发包从"内置 Node zip"变成要编译原生扩展 |
| OS 级平台沙箱 | 大工程 | 现在的 shell 守卫是模式匹配、出网代理只管得住遵守代理环境变量的客户端，两者**都不是真隔离**（已写进 README 的"已知未覆盖"）。真隔离要 Job Object / seccomp 之类，Windows 下无轻量方案 |
| sessions 内存上限 | 建议维持现状 | 加淘汰会真丢数据；且会话由用户主动创建，量级有限。要做必须先补"按需从磁盘重载"能力 |
| E2E 覆盖今天的新功能 | 部分欠账 | 今天新增的搜索 / MCP / 定时 / 子代理 / 分支 / 出网都有**模块级 + 协议级**测试，但不在那 24 项 E2E 里（E2E 依赖真实模型，UI 类功能放这里不合适） |
| `npm run release` 实包验证 | 可跳过 | 需联网拉官方 Node（448MB）。updater 有 13 项回归测试兜着 |

**已收官、不要再做**：注释中文化（工作树 100%，只剩 44 行"不该译"的类型定义/枚举值）；
CLI 树（已彻底删除，bundle 与 47% 译文补丁都在仓库外，见第六节）。

## 八、复核时修正的三处（原文有误，供参考）
1. **原文说 typecheck 通过，实际是红的**：`web/launcher/updater.mjs` 有 5 个 TS 错误。
   原因：`tsconfig.server.json` 的 include 虽只写 `server/**/*.mjs`，但 `server/static.mjs`
   **import 了** `../launcher/updater.mjs`，TS 顺 import 把 launcher/ 一并检查。
   → **往"被 import 的目录"下新增文件 = 悄悄扩大类型检查面，必须重跑 typecheck。** 已修。
2. **原文说下一任务是"源码全量翻译"，实际工作树已无待译项**（只剩不该译的类型定义等）。
3. **`.workbuddy/memory/` 是第二套记忆**（另一运行时写的），其 09-18 日志自己声明
   「统一放 `.workbuddy-ai/memory/`，不要另起一套」→ 已把本文件搬进 `.workbuddy-ai/memory/`，
   并把 `.workbuddy/` 加入 `.gitignore`。
