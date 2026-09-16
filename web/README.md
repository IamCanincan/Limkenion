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
│   ├── tools.mjs         # CLI 工具集镜像（41 个）
│   ├── toolindex.mjs     # 工具延迟加载
│   ├── engine.mjs        # 回合循环、子代理、定时任务
│   ├── commands.mjs      # 斜杠命令语义
│   ├── static.mjs        # HTTP 静态伺服（安全头 + token 注入）
│   ├── protocol.mjs      # WebSocket 协议
│   └── deepseek.mjs      # DeepSeek API 客户端（SSE 流式 + 思维链）
├── bin/
│   └── limkenion-web.mjs # npm bin 入口
├── test/                 # 自动化测试（node:test，130 个用例）
└── src/
    ├── main.tsx / App.tsx / api.ts / types.ts / styles.css
    └── components/       # 13 个组件（见下）
```

前端组件：`Sidebar`（会话列表 + 导出 + 计划徽标）、`ChatView`、`MessageItem`（markdown + 待办清单 + 思维链 + 图片）、`ToolCallItem`（折叠 + diff）、`DiffView`、`CommandPalette`、`FileMentionPalette`（@ 引用）、`ModelSelector`、`SettingsControls`（权限模式 + 主题）、`Composer`（命令/引用/图片）、`PermissionDialog`、`QuestionDialog`、`StatusBar`。

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

**已知未覆盖**：shell 守卫是模式匹配，不是真正的沙箱隔离——足够挡住误操作和常见注入，但挡不住刻意构造的绕过。真要跑不可信代码请用容器。

## 功能对照（CLI ⇄ Web）

| 功能 | CLI | Web |
| --- | --- | --- |
| 聊天/流式回复 | REPL | 聊天视图 |
| 思维链展示 | 折叠块 | 「思考中…」折叠块（`reasoning_content`） |
| 工具调用展示 | 转录流 | 回合过程折叠 + 展开 |
| **工具集** | `tools/` 目录 42 个 | **41 个镜像**（`LS` 为 web 补充） |
| 权限确认 | 危险工具提示 | 弹窗（允许一次/本会话总是/拒绝，升级确认时隐藏「总是允许」） |
| 权限模式 | `/permissions` | 顶栏选择器 + `/permissions`（default / acceptEdits / plan / bypassPermissions） |
| 计划模式 | EnterPlanMode / ExitPlanMode | `/plan` + 顶栏横幅 + 工具门控 |
| 反问用户 | AskUserQuestion | 问答弹窗（单选/多选/其他自由作答） |
| 文件改动预览 | diff 视图 | Write/Edit/NotebookEdit 的 unified diff（带体积上限） |
| TodoWrite 任务清单 | 待办面板 | 消息内常驻清单 |
| 任务跟踪 | Task* 工具 | Task* 工具 + `/tasks` |
| 子代理 | Agent 工具 | Agent 工具（只读子代理，过程可见为 `Agent·<工具>`） |
| 斜杠命令 | 命令补全 | 命令面板（注册表 77 条，31 条有真实语义） |
| @ 文件引用 | @ 补全 | @ 补全（服务端索引工作区文件） |
| 图片输入 | 粘贴图片 | 粘贴/选择图片（base64 → 多模态 content parts） |
| 模型切换 | `/model` | 顶栏模型选择器 + `/model` |
| 主题 | `/theme` | 顶栏主题选择器 + `/theme`（暗色/亮色/跟随系统） |
| 会话管理 | `/resume` `/rename` | 侧栏新建/切换/重命名/删除 + 磁盘持久化 |
| 会话导出 | 转录复制 | `/export` + 侧栏菜单（下载 Markdown） |
| 用量统计 | `/cost` | 侧栏统计面板 + `/cost` |
| 中断回合 | Esc | 输入框停止按钮 + cancel 协议 |
| 定时任务 | CronCreate | CronCreate + `/cron`（会话删除时自动清理） |

### 工具集（41 个）

| 分类 | 工具 |
| --- | --- |
| 文件 | Read / Write / Edit / NotebookEdit / Glob / Grep / LS |
| 执行 | Bash / PowerShell / REPL |
| 网络 | WebFetch / WebSearch |
| 协作 | Agent / TeamCreate / TeamDelete / SendMessage / SendUserMessage |
| 任务 | TodoWrite / TaskCreate / TaskGet / TaskList / TaskUpdate / TaskStop / TaskOutput |
| 流程 | EnterPlanMode / ExitPlanMode / AskUserQuestion / Sleep / CronCreate |
| 配置 | Config / Skill / ToolSearch / StructuredOutput |
| 降级 | LSP / mcp / ListMcpResourcesTool / ReadMcpResource / McpAuth / RemoteTrigger / EnterWorktree / ExitWorktree |

**工具延迟加载**：20 个常驻工具每轮随请求发出，其余 21 个默认不发，模型通过 `ToolSearch` 检索后按会话启用。41 份 schema 全量约 11K 字符，常驻集约 6K —— 省掉约 45% 的固定开销。用 `/tools` 查看分组。

**降级工具**在 web 沙箱内没有对应基础设施（语言服务器、MCP 客户端、远端会话、git worktree），调用会返回明确的不可用说明，而不是静默失败。

**危险工具**（执行前弹窗确认）：Bash、PowerShell、REPL、Write、Edit、NotebookEdit、CronCreate。

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
- 在 CLI 源码树内（含软链安装）启动：工作区为该仓库根，斜杠命令注册表扫描到 77 条。
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

服务端 → 客户端：`hello`、`commands`、`models`/`model_changed`、`settings`、`stats`、`session_messages`、`user_message`、`assistant_start` / `assistant_delta` / `assistant_reasoning`、`tool_call` / `tool_result`（含 diff）、`turn_complete` / `turn_cancelled`、`command_result`、`permission_request`（含 `escalate` 原因）、`question_request`、`plan_mode_changed`、`notice`、`session_export`、`files`、`sessions_changed`、`session_deleted`、`error`。

引擎为 **agent 模式**：模型 ⇄ 工具多轮迭代（上限 20 轮），危险工具执行前弹窗确认。回合事件广播给所有连接（前端按 `sessionId` 过滤），因此第二个标签页也能看到权限/问答弹窗。

**会话持久化**：会话写入 `~/.limkenion-web/sessions.json`（800ms 防抖），重启自动恢复；计划模式不跨进程恢复，避免重启后模型被静默限制。

## 测试

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（130 个用例）
npm run build       # vite build
```

测试分五组：

| 文件 | 覆盖 |
| --- | --- |
| `paths.test.mjs` | 沙箱越界、盘符相对路径、保留设备名、备用数据流 |
| `security.test.mjs` | 15 种灾难性命令硬拒绝、升级确认触发、握手鉴权、不可信内容包裹 |
| `tools.test.mjs` | 41 个工具实现、ReDoS 防护、输出头尾截断、diff 上限、降级工具 |
| `engine.test.mjs` | **用本地桩模型真实跑通「模型 → tool_call → 权限 → 执行 → 回灌」全链路**，含拒绝、总是允许、计划模式、shell 守卫、不可信升级、取消、定时任务、子代理 |
| `protocol.test.mjs` | 子进程启动真实服务：鉴权拒绝、`/ws-token`、路径穿越、安全头、命令往返、会话级设置隔离、重启恢复 |
| `drift.test.mjs` | 解析 CLI 源码的 `inputSchema`，逐参数比对镜像 schema，防止手抄漂移 |

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
