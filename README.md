# Limkenion

一个最小的终端编程助手。三个包、约 1.2 万行 TypeScript（浏览器界面另有约 7 千行原生 JS/CSS）、零运行时依赖。

仓库：<https://github.com/IamCanincan/Limkenion>

设计目标是只保留「调用模型 + 操作本机文件」这条最短路径：不做 TUI（交互模式就是朴素的逐行
REPL）、不接多供应商、不埋遥测、不引运行时依赖。上下文压缩、审批、计划模式、钩子这些是后来
按需要加的，但都落在同一套「纯函数 + 事件」的骨架上，核心包（`packages/core`，约 5 千行）一个
下午能读完。

## 安装与运行

需要 Node.js >= 22.19。发布只发生在 GitHub，不需要 npm 账号。

### 方式一：从 Release 全局安装

把 Release 附件 `limkenion-<版本>.tgz` 的下载地址交给 npm 即可。
这个包自带全部依赖，不经过 npm registry：

```bash
npm install -g https://github.com/IamCanincan/Limkenion/releases/download/v1.0.0/limkenion-1.0.0.tgz

limkenion auth login     # 输入一次 API Key，存到本地，之后不用再设环境变量
limkenion web
```

要装别的版本，把上面地址里的两处 `1.0.0` 换成对应版本号即可（附件名与标签都带版本）；
Release 页面上能直接复制当前版本的地址。

密钥优先级是 `--api-key` 参数 > 环境变量 `DEEPSEEK_API_KEY` > 本地保存的密钥，
`limkenion auth status` 会告诉你当前生效的是哪一把。

不想装到全局，也可以让 npx 临时下载运行（注意要显式给出 bin 名字，
直接 `npx <tarball>` 不会执行）：

```bash
npx --yes --package=https://github.com/IamCanincan/Limkenion/releases/download/v1.0.0/limkenion-1.0.0.tgz limkenion web
```

### 方式二：解压即用

下载 Release 里的 `limkenion-<版本>.zip`（Windows）或 `.tar.gz`（Linux/macOS），
解压到任意位置——路径含中文也可以，启动器用自身所在目录定位入口：

```powershell
.\limkenion.cmd                        # 交互模式
.\limkenion.cmd web                    # 浏览器界面
.\limkenion.cmd "给这个仓库补一个 LICENSE"
```

把解压目录加进 PATH 就能直接敲 `limkenion`。这条路径完全不涉及 npm。

### 方式三：从源码跑

```bash
git clone https://github.com/IamCanincan/Limkenion.git
cd Limkenion
npm install --ignore-scripts
npm run build
npm run limkenion web
```

`npm run build` 准备构建产物；`npm run limkenion` 直接用这些产物，不会重新构建。
想跳过构建、用 tsx 直接跑源码，用 `./limkenion-test.sh`（PowerShell 下是
`./limkenion-test.ps1`）。

### 常用命令

```bash
limkenion                               # 交互模式
limkenion "给这个仓库补一个 LICENSE"       # 执行一条指令后退出
cat error.log | limkenion -p "分析这个报错"  # 从标准输入读取指令
limkenion web                           # 浏览器界面，http://127.0.0.1:4887
limkenion review --base main            # 多 agent 代码评审（有 blocker 退出码 1，可当 CI 门禁）
limkenion search "RepeatGuard"          # 搜历史会话（找到 0 / 没找到 1）
limkenion doctor                        # 环境体检：版本、目录权限、密钥来源、接口可达性、配置分层
limkenion self update --from <源码目录>   # 改自己：过门禁 → 打包 → 退出后安装，失败自动回滚
```

在任意项目里运行时，工作目录及上级目录的 `AGENTS.md` 会自动注入系统提示词，
项目约定不用每次重复交代。

完整参数见 [packages/cli/README.md](packages/cli/README.md)。

## 结构

依赖方向单向，`cli` -> `core` -> `ai`，没有环，也没有隐式注册。

| 包 | 目录 | 职责 | 规模 |
|----|------|------|------|
| [limkenion-ai](packages/ai) | `packages/ai` | DeepSeek 流式对话客户端、消息与工具类型 | 约 600 行 |
| [limkenion-core](packages/core) | `packages/core` | Agent 主循环、系统提示词、文件/命令工具与运行期状态（待办、目标、交付物、后台任务、子代理） | 约 3500 行 |
| [limkenion](packages/cli) | `packages/cli` | 命令行入口、纯文本 REPL、会话持久化、浏览器界面 | 约 2400 行 |

其中浏览器界面是一组手写的 HTML/CSS/原生 JS 加一个 `node:http` 服务器，同样没有构建步骤、
没有前端依赖。多个会话可以并行生成。

## Agent 怎么工作

一次用户输入变成这样一个循环：

```
用户消息 -> 调用模型 -> 模型要求调用工具 -> 依次执行 -> 结果回灌 -> 再次调用模型
                                        ↑                              |
                                        └──────── 直到模型不再要求 ─────┘
```

工具分两类。**动文件与命令的**：`bash`、`read`、`write`、`edit`、`grep`、`glob`（搜索用内置能力实现，
跨平台行为一致，也更容易限定范围与输出上限）。**记运行期状态的**：`todo_write` / `todo_read`（待办清单）、
`goal_write` / `goal_read`（这一轮的目标，四态）、`present`（交付物清单：路径 + 一句话，只记账不搬运）、
`job_start` / `job_list` / `job_kill`（后台任务：进程按进程组起、输出落文件）、
`subagent_start` / `subagent_list` / `subagent_read` / `subagent_stop`（子代理：一次独立的模型循环，
深度上限 1）。它们不碰文件系统，只改会话内的状态，界面上各有落点（输入框上方的 dock、对话流里的卡片、
顶栏的下拉）。

工具只增该增的：工具越多、提示词越长，模型选错的概率越高；每加一个都要能说清「什么时候用、什么时候别用」
（例如子代理那条写着「别拿它干一句话能说清的事——它比直接做贵」）。

工具顺序执行而不是并发执行：四个里面有三个会改文件，并发会让「读到的内容」和
「写回的内容」错位，而顺序执行在这个规模下代价可以忽略。

## 明确不做的事

| 能力 | 为什么不做 |
|------|-----------|
| TUI / 差分渲染 | 纯文本 REPL 足够，且不承担终端兼容性负担 |
| 扩展 / 插件系统 | 需要新工具就直接实现 `AgentTool` 并传进 `tools` |
| 遥测 | 没有服务端，也没有人看 |
| 多供应商 | 只要兼容 OpenAI 的 `/chat/completions`，改 `--base-url` 即可 |
| 上下文压缩 | 超出窗口时由调用方裁剪 `agent.messages`，不猜用户意图 |
| 权限系统 | 工具以进程权限直接执行；需要隔离就用容器或沙箱 |
| 会话分支 / fork | 会话就是一份可读的 JSONL 文件 |

## 输出约定

模型正文走 **stdout**，思维链、工具活动、状态与错误走 **stderr**。
因此输出可以直接管道给别的程序：

```bash
limkenion -p "总结这个仓库" > summary.md
```

## 开发

```bash
npm install --ignore-scripts  # 安装依赖，不跑生命周期脚本
npm run check                 # 格式化、静态检查、类型检查、脚本单测
npm test                      # 跑所有包的测试
npm run build                 # 编译三个包到 dist/
npm run release:package       # 打包成解压即用的发布包
./limkenion-test.sh           # 从源码运行 CLI
```

开发约定见 [AGENTS.md](AGENTS.md)。

## 打包发布

发布只发生在 GitHub：一条命令产出全部产物，传到 Release 附件即可。

```bash
npm run release:package              # 先构建再打包
npm run release:package -- --skip-build   # 直接用现有 dist
```

产物在 `release/`：

| 产物 | 大小 | 说明 |
|------|------|------|
| `limkenion-<版本>.tgz` | 自包含 | npm 兼容包，`npm install -g <附件 URL>` 用 |
| `limkenion-<版本>/` | 约 620KB | 解压即用的目录，直接运行 `limkenion.cmd` |
| `limkenion-<版本>.zip` | 约 295KB | Windows 友好 |
| `limkenion-<版本>.tar.gz` | 约 120KB | Linux/macOS |

**`.tgz` 是怎么做到的**：它把 `limkenion-core` 与 `limkenion-ai` 内联进包内的
`node_modules/`，配合 `package.json` 里的 `bundleDependencies` 告诉 npm「这两个已随包附带，
别去 registry 拉」。所以使用者不需要 npm 账号，也不需要这三个包先发布到 registry——
安装过程完全不联网（已实测：`npm install -g <tgz> --offline` 只装 1 个包）。

**解压包**里只有三个包的 `package.json` 与 `dist/`，加三个启动器（`limkenion.cmd`、
`limkenion.ps1`、`limkenion`）和一份中文 `README.md`。启动器都用自身所在目录定位入口，
因此可以解压到任意路径，包括含中文的路径。

**前提**：使用者已安装 Node.js >= 22.19。

**为什么不做单文件可执行**：`node:sea` 与 `bun build --compile` 产出的单文件在 80MB 以上，
还要额外改造前端静态资源的读取方式（现在是从磁盘按相对路径读）。本项目 dist 总共不到 500KB，
用目录包更划算。真要单文件，得先把 `src/web/public/` 的资源内嵌进二进制并让服务器优先用内嵌副本。

### 发布到 npm（可选，目前不用）

`npm run publish` 仍在，但只在你想同时发到 npm registry 时才需要：发布前要 `npm login`，
而且上游依赖必须先存在于 registry。三条命令：

```bash
npm run publish:dry    # 只校验三个包的打包内容，不上传
npm run publish        # 构建、检查、然后依次发布
```

`--provenance` 只在 GitHub Actions 里带上（它要 CI 的 OIDC 令牌，本地发布会失败）。

## 配置

`packages/cli/package.json` 里的 `limkenionConfig` 决定应用名与配置目录：

```json
{
  "limkenionConfig": {
    "name": "limkenion",
    "configDir": ".limkenion"
  }
}
```

同时改 `bin` 字段就能整体改名。它影响 CLI 前缀、配置路径（`~/.limkenion/agent`）
与环境变量前缀（`LIMKENION_*`）。

## 许可证

MIT。完整许可证见 [LICENSE](LICENSE)。
