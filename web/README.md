# Limkenion Web

Limkenion 的浏览器聊天界面。架构学习自 deepseek-harness 的 web 客户端（`apps/web` + `dsh web` 模式）：**Vite + React 单页应用，由本地服务静态伺服并承载 WebSocket 聊天协议**。

## 结构

```
web/
├── index.html            # SPA 入口（含 token 占位 meta，服务端伺服时替换）
├── vite.config.ts        # 开发代理 /ws 与 /ws-token → 8788
├── server/
│   ├── index.mjs         # 入口：装配各模块并启动（约 80 行）
│   ├── paths.mjs         # 路径解析与沙箱校验
│   ├── config.mjs        # 常量、设置（全局默认 + 会话级覆盖）
│   ├── bus.mjs           # WS 连接注册表与广播
│   ├── security.mjs      # 握手鉴权、shell 守卫、不可信内容隔离
│   ├── sessions.mjs      # 会话存储 + 磁盘持久化
│   ├── workspace.mjs     # 工作区文件索引（带缓存）
│   ├── interactions.mjs  # 权限确认 / 问答通道
│   ├── tools.mjs         # CLI 工具集镜像（45 个）
│   ├── toolindex.mjs     # 工具延迟加载
│   ├── engine.mjs        # 回合循环、子代理、定时任务
│   ├── commands.mjs      # 斜杠命令语义
│   ├── static.mjs        # HTTP 静态伺服（安全头 + token 注入）
│   ├── protocol.mjs      # WebSocket 协议
│   ├── deepseek.mjs      # DeepSeek API 客户端（SSE 流式 + 思维链）
│   ├── settings.mjs      # 设置文件（三作用域）与权限规则匹配
│   ├── hooks.mjs         # 钩子（27 事件 × 4 执行方式）
│   ├── mcp.mjs / mcpOAuth.mjs # MCP 客户端 + OAuth 2.1
│   ├── workflow.mjs      # 动态工作流（vm 沙箱脚本）
│   ├── insights.mjs      # 用量洞察与报告
│   ├── worktree.mjs      # git worktree（可按分支进入）
│   ├── checkpoints.mjs   # 文件检查点（/rewind 回滚）
│   ├── egress.mjs        # 服务端出网白名单
│   ├── requestLog.mjs    # 模型请求追踪
│   ├── crashGuard.mjs    # 进程级崩溃兜底（未捕获异常/拒绝不再打死服务）
│   ├── search.mjs        # 全局搜索（跨会话消息 + 文件名 + 标题）
│   ├── subagents.mjs     # 具名子代理（模型 + 只读工具子集）
│   └── netproxy.mjs      # shell 出网白名单代理（纯 Node，无原生依赖）
├── bin/
│   └── limkenion-web.mjs # npm bin 入口
├── test/                 # 自动化测试（node:test，46 个文件 / 487 个用例）
└── src/
    ├── main.tsx / App.tsx / api.ts / types.ts / styles.css
    └── components/       # 21 个组件（见下）
```

> `server/` 共 35 个模块；上面列出的是主要入口与近期新增的部分。

前端组件：`Sidebar`（会话列表 + 导出 + 计划徽标 + 分支启动入口）、`ChatView`、`MessageItem`（markdown + 待办清单 + 思维链 + 图片）、`ToolCallItem`（折叠 + diff）、`DiffView`、`CommandPalette`、`FileMentionPalette`（@ 引用）、`ModelSelector`、`SettingsControls`（权限模式 + 主题 + 推理强度）、`Composer`（命令/引用/图片）、`PermissionDialog`、`QuestionDialog`、`StatusBar`、`TeamPanel`（Agent Teams）、`PreviewPanel`、`RequestLogPanel`，以及近期新增的 `SearchPanel`（Cmd+K 全局搜索）、`McpPanel`（MCP 图形化管理）、`CronPanel`（定时任务界面）、`SubAgentPanel`（具名子代理）、`NewSessionDialog`（选分支启动）。

## 安全边界

这是一个**能在你机器上读写文件、执行命令**的 agent 前端，默认按「只服务本机」来配置。

| 面 | 措施 |
| --- | --- |
| 监听地址 | 默认 `127.0.0.1`。需要外部访问必须显式设 `LIMKENION_WEB_HOST=0.0.0.0`，启动时会打印告警 |
| WS 鉴权 | 每次启动生成一次性 token（注入 index.html，开发模式走 `/ws-token`）；握手校验 token + Origin（浏览器必然带 Origin，非本机来源直接拒），防跨站页面驱动 agent |
| 文件沙箱 | 所有文件工具经 `safePath` 校验：拦目录穿越、盘符相对路径（`C:foo`）、Windows 保留设备名、NTFS 备用数据流 |
| shell 守卫 | 灾难性命令（`rm -rf /`、`format`、`shutdown`、fork 炸弹…）**硬拒绝**，不受权限模式与「本会话总是允许」影响；工作区外路径、家目录、凭证文件、UNC 路径触发**升级确认**（每次都重新问）；`LIMKENION_WEB_SHELL=off` 可彻底禁用 shell 类工具 |
| 提示注入隔离 | WebFetch/WebSearch 的正文用 `<untrusted-content>` 包裹，系统提示声明其为数据非指令；同一回合内接触过外部内容后，危险工具强制重新确认 |
| 静态服务 | 路径校验用「dist + 分隔符」精确判断；统一安全头（CSP、nosniff、禁 referrer、禁 iframe 嵌套） |
| 正则 DoS | Grep 的正则有长度上限 + 嵌套量词预检 + `node:vm` 3 秒超时中断 |
| shell 出网 | 三档：不限制 / `off`（指向死端口全断）/ `allowlist`（本进程内 HTTP 代理，按 `LIMKENION_EGRESS_ALLOWLIST` 按主机放行）。**纯 Node 实现，不引入原生依赖** |
| 进程韧性 | `crashGuard` 兜住未捕获异常与 Promise 拒绝（不再整个服务下线）；shell 超时**连根杀进程树**而不是只杀 shell；广播对单个坏客户端隔离 |

**已知未覆盖（别把上面的当成完整隔离）**：

- shell 守卫是**模式匹配**，不是真正的沙箱——挡得住误操作和常见写法，**挡不住刻意构造的绕过**。
- shell 出网代理只能管住**遵守代理环境变量**的客户端（`curl`/`npm`/`pip` 这类）；直连原始 socket、自定义 DNS 的程序照样能出去。真正的网络隔离需要 OS 级沙箱，Windows 下无轻量方案。
- 真要跑不可信代码，请用容器。
- **硬链接不在检测范围内**（软链接已堵）。硬链接的真实路径就是它自己，`realpath` 认不出来；唯一的线索是 `nlink > 1`，但那样会把 pnpm 这类大量使用硬链接的 `node_modules` 全误判掉，代价太大，所以不做。而且**创建硬链接本身就需要 shell 权限** —— 到了那一步，shell 能做的事已经超出文件工具的边界了。

已在纯 Node 范围内做的加固（**提高绕过成本，不改变"不是真隔离"这个事实**）：

- **文件工具是硬边界**：Read/Write/Edit/Grep/Glob 每次调用都算路径，越出「工作区根 + 额外目录」直接拒绝。
- **软链逃逸已堵**：路径看着在沙箱内、但软链指向外面时拒绝（实测原来能读到区外文件）。悬空软链同样拦——它目标不存在，`realpath` 会失败，只能靠 `lstat` + `readlink` 认出来。判定时**两边都取真实路径**，否则工作区根自己位于链接下（macOS 的 `/tmp` → `/private/tmp`、Windows junction）时区内文件会被全误判成越界。
- **脚本落地即执行会升级确认**：模型可以先写个脚本（工作区内 → 放行）再执行 `bash run.sh`——守卫看到的命令文本完全无害。现在这种情况会强制重新确认，并**把脚本开头展示出来**，避免用户对着一句 `bash run.sh` 盲签。
- 追加额外目录时，若那是工作区根的**上级目录**，会明确警告「可达范围被放大」（`/add-dir`）。

## 功能对照（CLI ⇄ Web）

| 功能 | CLI | Web |
| --- | --- | --- |
| 聊天/流式回复 | REPL | 聊天视图 |
| 思维链展示 | 折叠块 | 「思考中…」折叠块（`reasoning_content`） |
| 工具调用展示 | 转录流 | 回合过程折叠 + 展开 |
| **工具集** | `tools/` 目录 | **45 个镜像**（`LS` / `CronList` / `CronDelete` / `Workflow` 等为 web 补充） |
| 权限确认 | 危险工具提示 | 弹窗（允许一次/本会话总是/拒绝，升级确认时隐藏「总是允许」） |
| 权限模式 | `/permissions` | 顶栏选择器 + `/permissions`（default / acceptEdits / plan / bypassPermissions） |
| 计划模式 | EnterPlanMode / ExitPlanMode | `/plan` + 顶栏横幅 + 工具门控 |
| 反问用户 | AskUserQuestion | 问答弹窗（单选/多选/其他自由作答） |
| 文件改动预览 | diff 视图 | Write/Edit/NotebookEdit 的 unified diff（带体积上限） |
| TodoWrite 任务清单 | 待办面板 | 消息内常驻清单 |
| 任务跟踪 | Task* 工具 | Task* 工具 + `/tasks` |
| 子代理 | Agent 工具 | Agent 工具（只读子代理，过程可见为 `Agent·<工具>`）+ **具名子代理**（可预配模型与只读工具子集） |
| 斜杠命令 | 命令补全 | 命令面板（注册表 83 条，其中 50 条在 web 有真实语义） |
| @ 文件引用 | @ 补全 | @ 补全（服务端索引工作区文件） |
| 图片输入 | 粘贴图片 | 粘贴/选择图片（base64 → 多模态 content parts） |
| 模型切换 | `/model` | 顶栏模型选择器 + `/model` |
| 主题 | `/theme` | 顶栏主题选择器 + `/theme`（**6 套配色**：暗色/亮色/纸墨/经典暖色/青瓷/墨夜蓝 + 跟随系统） |
| 会话管理 | `/resume` `/rename` | 侧栏新建/切换/重命名/删除 + 磁盘持久化 |
| 会话导出 | 转录复制 | `/export` + 侧栏菜单（下载 Markdown） |
| 用量统计 | `/cost` | 侧栏统计面板 + `/cost` |
| 中断回合 | Esc | 输入框停止按钮 + cancel 协议 |
| 定时任务 | CronCreate | CronCreate + `/cron` + **定时任务界面**（按周期/内容建、分会话查看、删除；会话删除时自动清理） |

### Web 端新增能力（CLI 无对应）

| 能力 | 说明 |
| --- | --- |
| **全局搜索**（Cmd+K / Ctrl+K） | 跨**全部会话**的消息全文 + 会话标题 + 工作区文件名；空格分词 AND、大小写不敏感；命中直接切会话并滚动/闪烁定位。结果带 `complete` 标志（触顶截断时如实说明，不假装是全部） |
| **MCP 图形化管理** | 界面增删改 MCP Server（stdio / http / sse），按 **user / project / local 三作用域**写进对应设置文件；显示状态、不可用原因与工具数 |
| **定时任务界面** | 按内容 + 周期（`30s` / `5m` / `2h` / 毫秒 / rrule）建任务，按本会话/其它会话分组查看与删除 |
| **分支 / Worktree 启动** | 新会话可指定分支，在**隔离 worktree** 里起（分支已存在则检出、不存在则以 HEAD 新建）。**刻意不支持"选分支但用当前工作树"** —— 那等于偷偷 checkout 你的工作树 |
| **具名子代理** | 预配置名子代理的**模型**与**只读工具子集**，供 `Agent` 工具按名选用。工具只能是只读集的子集（`Write`/`Bash` 一律拒），配置面不能变成提权口子 |
| **6 套配色主题** | 暗色（基准）/ 亮色 / 纸墨 / 经典暖色 / 青瓷 / 墨夜蓝 + 跟随系统；只覆盖 CSS 变量 |
| **shell 出网 allowlist** | `LIMKENION_WEB_SHELL_NET=allowlist` 时起本进程内 HTTP 代理，按 `LIMKENION_EGRESS_ALLOWLIST` 放行（详见下方安全边界） |
| **钩子输出上下文预算** | 钩子要进上下文的输出超 8000 字即落盘到 `hook_outputs/`，只留截断版 + 指针，防止话多的钩子撑爆上下文 |

### 工具集（45 个）

| 分类 | 工具 |
| --- | --- |
| 文件 | Read / Write / Edit / NotebookEdit / Glob / Grep / LS |
| 执行 | Bash / PowerShell / REPL |
| 网络 | WebFetch / WebSearch |
| 协作 | Agent / TeamCreate / TeamDelete / SendMessage / SendUserMessage |
| 任务 | TodoWrite / TaskCreate / TaskGet / TaskList / TaskUpdate / TaskStop / TaskOutput |
| 流程 | PlanEnter / PlanExit / AskUserQuestion / Sleep / CronCreate / CronList / CronDelete / Workflow |
| 配置 / 元 | Config / Skill / ToolSearch / StructuredOutput |
| MCP | mcp / McpPrompt / McpRegistrySearch / ListMcpResourcesTool / ReadMcpResource / McpAuth |
| 预览 | PreviewUrl |
| 工作区 | EnterWorktree / ExitWorktree |

（`PlanEnter` / `PlanExit` 即 EnterPlanMode / ExitPlanMode：工具名归一化到新名，模型输出旧名或权限规则写旧名都能识别。）

**工具延迟加载**：20 个常驻工具每轮随请求发出，其余 25 个默认不发，模型通过 `ToolSearch` 检索后按会话启用。45 份 schema 全量约 11K 字符，常驻集约 6K —— 省掉约 45% 的固定开销。用 `/tools` 查看分组。

MCP / worktree 这类工具依赖本机能力：未配置、或平台不支持时返回**明确的不可用说明**，而不是静默失败。

**危险工具**（执行前弹窗确认）：Bash、PowerShell、REPL、Write、Edit、NotebookEdit、CronCreate、CronDelete、EnterWorktree、ExitWorktree、Workflow。

## 运行

```bash
cd web
npm install

# 开发（两个终端）
npm run serve   # 本地服务：http://localhost:8788
npm run dev     # Vite 热更新：http://localhost:5173（/ws 与 /ws-token 已代理）

# 生产
npm run build   # 构建到 web/dist
npm run serve   # http://localhost:8788 直接伺服构建产物
```

CLI 构建恢复后，也可在 REPL 里执行 `/web` 命令启动（见 `commands/web/`）。

## 全局安装

```bash
cd web && npm run build          # 先构建 dist（全局安装不会装 devDependencies）
npm install -g .                 # 装成全局命令（本地目录会创建软链，改动即时生效）
limkenion-web                    # 任意目录可用，默认端口 8788
```

打包成可分发副本（不依赖源码目录）：

```bash
cd web && npm pack               # 产出 limkenion-web-<version>.tgz（含 dist，不含源码映射）
npm install -g ./limkenion-web-0.6.0.tgz
```

运行时只依赖 `ws`（已在 `dependencies`）；React/Vite 等构建依赖在 `devDependencies`，因为 `dist/` 随包分发。

**路径解析**：启动时按「`LIMKENION_CLI_ROOT` → 包内相对位置 → 当前工作目录」取第一个含 `commands/` 的目录作为 CLI 源码根。
- 在 CLI 源码树内（含软链安装）启动：工作区为该仓库根，斜杠命令注册表扫描到 83 条。
- 在任意目录启动（副本安装）：工作区即当前目录，命令注册表仅含 `web` 自带命令，并打印提示。
- 用 `LIMKENION_WEB_WORKSPACE` 可显式指定沙箱根。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LIMKENION_WEB_PORT` | `8788` | 服务端口 |
| `LIMKENION_WEB_HOST` | `127.0.0.1` | 监听地址；设为 `0.0.0.0` 会暴露到局域网并打印告警 |
| `LIMKENION_WEB_WORKSPACE` | CLI 源码根 | 文件工具沙箱根 |
| `LIMKENION_CLI_ROOT` | 自动探测 | 命令注册表扫描来源 |
| `LIMKENION_WEB_STATE_DIR` | `~/.limkenion-web` | 会话持久化目录 |
| `LIMKENION_WEB_SHELL` | 启用 | 设为 `off` 彻底禁用 Bash/PowerShell/REPL |
| `LIMKENION_WEB_SHELL_NET` | 不限制 | shell 子进程的出网开关：`off`=指向死端口全断；`allowlist`=走本进程内白名单代理（按 `LIMKENION_EGRESS_ALLOWLIST` 放行） |
| `LIMKENION_EGRESS_ALLOWLIST` | 不限制 | 逗号分隔的主机名，`*.` 前缀按后缀匹配；**服务端出网与 shell 代理共用同一套规则** |
| `LIMKENION_WEB_HOOK_CONTEXT_CHARS` | `8000` | 钩子输出进上下文的字符预算，超出落盘到 `hook_outputs/` 并只留截断版 + 指针 |
| `LIMKENION_WEB_MAX_MEMORY_SESSIONS` | `30` | 内存里最多保留多少个会话的**消息**；超出后最久未用的会话消息被卸载（**数据仍在磁盘**，访问时自动读回）。会话条目本身始终保留，不会从侧边栏消失。上限刻意小于持久化的 50 条，避免卸载到没落盘的会话 |
| `LIMKENION_CONFIG_DIR` | `~/.limkenion` | 用户级设置目录（权限规则 / hooks / mcpServers / subagents 都从这里读） |
| `LIMKENION_WEB_SEARCH_ENDPOINT` | Bing | WebSearch 数据源 |
| `DEEPSEEK_API_KEY` | 无 | 设置后启用真实引擎，否则降级 mock |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API 地址 |

## 聊天协议（WebSocket /ws）

握手：`ws://host:port/ws?token=<一次性 token>`。token 从 `index.html` 的 meta 或 `GET /ws-token` 获取。

客户端 → 服务端：

| 消息 | 说明 |
| --- | --- |
| `new_session` | 新建会话 |
| `select_session` | 切换会话，服务端回放历史消息 |
| `rename_session` / `delete_session` | 会话重命名/删除 |
| `user_message` | 发送用户消息（可带 `images`；以 `/` 开头走命令通道） |
| `cancel` | 中断当前回合 |
| `get_models` / `set_model` | 查询/切换模型（可带 `sessionId`，会话级） |
| `get_settings` / `set_setting` | 查询/修改设置（`theme` / `permissionMode`，会话级） |
| `get_stats` | 查询用量统计 |
| `export_session` | 导出会话为 Markdown |
| `list_files` | 拉取工作区文件索引（供 @ 补全） |
| `run_command` | 直接执行斜杠命令 |
| `permission_response` | 回应危险工具的权限请求 |
| `question_response` | 回应 AskUserQuestion 的作答 |
| `get_requests` / `clear_requests` | 拉取 / 清空模型请求追踪 |
| `search` | 全局搜索（跨会话消息 + 标题 + 文件名） |
| `mcp_list` / `mcp_save` / `mcp_delete` | MCP 图形化管理（按作用域写设置文件） |
| `cron_list` / `cron_create` / `cron_delete` | 定时任务界面 |
| `git_branches` | 拉分支列表（新会话选分支启动用） |
| `subagent_list` / `subagent_save` / `subagent_delete` | 具名子代理管理 |
| `new_session`（带 `worktree` / `branch`） | 在指定分支的隔离 worktree 里起新会话 |

服务端 → 客户端：`hello`、`commands`、`models`/`model_changed`、`settings`、`stats`、`session_messages`、`user_message`、`assistant_start` / `assistant_delta` / `assistant_reasoning`、`tool_call` / `tool_result`（含 diff）、`turn_complete` / `turn_cancelled`、`command_result`、`permission_request`（含 `escalate` 原因）、`question_request`、`plan_mode_changed`、`notice`、`session_export`、`files`、`sessions_changed`、`session_deleted`、`team`、`preview_open`、`requests`、`search_results`、`mcp_servers`、`crons`、`git_branches`、`subagents`、`error`。

其中 `search_results` / `mcp_servers` / `crons` / `subagents` 在**增删改之后也会重新推一份**，前端直接拿新清单刷新即可，不必自己再拉一次。

引擎为 **agent 模式**：模型 ⇄ 工具多轮迭代（上限 20 轮），危险工具执行前弹窗确认。回合事件广播给所有连接（前端按 `sessionId` 过滤），因此第二个标签页也能看到权限/问答弹窗。

**会话持久化**：会话写入 `~/.limkenion-web/sessions.json`（800ms 防抖），重启自动恢复；计划模式不跨进程恢复，避免重启后模型被静默限制。

## 测试

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（45+ 个文件 / 454 个用例）
npm run test:ui     # vitest（前端组件）
npm run build       # vite build
```

### 推送前：在本地跑一遍 CI

```bash
node scripts/ci-sim.mjs        # 在**仓库根目录**执行
```

它会用 `git archive` 导出一份**纯净工作树**（不含 `dist/` 与 `node_modules/`），
然后按 CI 的顺序跑 `install → typecheck → build → test → test:ui`。

CI 是全新检出、本地不是 —— 这个差异正是"本地全绿、CI 红"最主要的来源
（踩过：就绪判定要求 `/` 返回 200，而没构建时是 404；token 又是从
`dist/index.html` 里取的）。与其推一次等一次，不如本地先跑一遍。
加 `--skip-install` 可跳过装依赖（临时目录已有 node_modules 时）。

**Node 版本**：服务本体在 Node 20 上也能跑（`npm test` 已用 Node 20.18 验证通过），
但 **`npm run test:ui` 需要 Node 22.12+** —— vitest 5 的 engines 是
`^22.12.0 || ^24.0.0 || >=26.0.0`，它依赖 Node 22.12+ 才有的 `require(ESM)`；
在 Node 20 上会以 `ERR_REQUIRE_ESM` / `Failed to start forks worker` 失败。
所以 CI（`.workflow/ci.yml`）用的是 **Node 22**。本地开发建议 22 或 24。

测试分五组：

| 文件 | 覆盖 |
| --- | --- |
| `paths.test.mjs` | 沙箱越界、盘符相对路径、保留设备名、备用数据流 |
| `security.test.mjs` | 15 种灾难性命令硬拒绝、升级确认触发、握手鉴权、不可信内容包裹 |
| `tools.test.mjs` | 47 个工具实现、ReDoS 防护、输出头尾截断、diff 上限、平台不支持时的明确报错 |
| `engine.test.mjs` | **用本地桩模型真实跑通「模型 → tool_call → 权限 → 执行 → 回灌」全链路**，含拒绝、总是允许、计划模式、shell 守卫、不可信升级、取消、定时任务、子代理 |
| `protocol.test.mjs` | 子进程启动真实服务：鉴权拒绝、`/ws-token`、路径穿越、安全头、命令往返、会话级设置隔离、重启恢复 |
| `drift.test.mjs` | 解析 CLI 源码的 `inputSchema`，逐参数比对镜像 schema，防止手抄漂移 |
| `crash-guard.test.mjs` | 未捕获的拒绝/异常不再打死进程；**用"不装兜底"的对照子进程反向证明测试有效** |
| `bus.test.mjs` | 广播韧性：单个客户端发送失败不影响其它客户端，死客户端被移出 |
| `bash-timeout.test.mjs` | Bash 成功路径秒回、超时立即结算（不等 close）、超时连根杀**进程树** |
| `bash-background.test.mjs` | 后台任务并发上限（超限明确拒绝，不静默堆积） |
| `search.test.mjs` / `search-protocol.test.mjs` | 全局搜索：分词 AND、大小写不敏感、工具结果可搜、截断报告；协议级真连 WS |
| `hooks-output-budget.test.mjs` | 钩子输出超预算落盘，小输出不误伤；`additionalContext` 同样覆盖 |
| `mcp-manage*.test.mjs` | MCP 图形化管理：只写指定作用域、结构化清单、不在该作用域时删除返回 false |
| `cron-*.test.mjs` | 周期解析（界面与模型共用一套）；协议级建/删/查 |
| `worktree-*.test.mjs` | 分支列举、按已存在/新分支建 worktree、命名空间行为不变、**分支名注入被拒** |
| `subagents*.test.mjs` | 具名子代理：工具只能是只读集的子集、模型白名单、删除作用域语义 |
| `netproxy.test.mjs` | shell 出网代理：真 socket 走 CONNECT，白名单内建隧道 / 外 403 / 未就绪 fail closed |
| `theme-consistency.test.mjs` | 每个配色都有 CSS 块且覆盖同一套调色板变量（防"能选但切过去没变化"） |
| `permission-specifier.test.mjs` | 权限规则 `key:pattern`；裸 specifier 仍不猜；老行为不回退 |
| `resource-cleanup.test.mjs` | 会话删除清检查点；截图临时文件不留残 |

`engine.test.mjs` 通过 `DEEPSEEK_BASE_URL` 指向本地桩服务（回放 SSE），因此**不需要真实 API key** 就能验证完整链路。

## 关于「与 CLI 对齐」的准确性

web 端的工具 schema 是**读 CLI 源码手抄**的，而 CLI 源码树当前缺 175 个模块、**无法构建运行**。因此对齐基准是「源码」而非「运行中的 CLI」，两者可能不一致。

为控制这个风险，`drift.test.mjs` 会直接解析 CLI `tools/*/` 下的 `inputSchema` 并逐参数比对，一旦两侧参数名不一致就失败。这套检查已经抓出并修正了一批真实漂移：

- `Grep`：CLI 用 `glob` / `head_limit` / `output_mode`，镜像曾写成 `include` / `limit`
- `Edit` 缺 `replace_all`；`Read` 缺 `pages`；`Glob` 缺 `path`
- `TaskStop` 参数名写成了 `taskId`（CLI 是 `task_id`）；`Skill` 写成 `commandName`（CLI 是 `skill`）
- `TeamCreate` 写成 `name`（CLI 是 `team_name`）；`CronCreate` 写成 `schedule`（CLI 是 `cron`）
- MCP 工具名写成 `MCPTool`（CLI 是 `mcp`）

CLI 恢复构建后，建议再加一层「真实 CLI 跑同一批任务、比对工具调用序列」的端到端对照。

## 本地校验提示

本机若配置了 HTTP 代理，用 curl 访问 localhost 需加 `--noproxy '*'`，否则会拿到代理返回的 502 而非真实服务状态。
