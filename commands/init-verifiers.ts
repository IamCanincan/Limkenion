import type { Command } from '../commands.js'

const command = {
  type: 'prompt',
  name: 'init-verifiers',
  description:
    '为代码变更的自动化验证创建 verifier 技能',
  contentLength: 0, // 动态内容
  progressMessage: '正在分析你的项目并创建 verifier 技能',
  source: 'builtin',
  async getPromptForCommand() {
    return [
      {
        type: 'text',
        text: `使用 TodoWrite 工具来跟踪你在这项多步骤任务中的进度。

## 目标

创建一个或多个可由 Verify agent 使用的 verifier 技能，用于自动验证该项目或文件夹中的代码变更。如果项目有不同的验证需求（例如既有 Web UI 又有 API 端点），你可以创建多个 verifier。

**不要为单元测试或类型检查创建 verifier。** 这些已由标准的构建/测试工作流处理，无需专门的 verifier 技能。聚焦功能性验证：Web UI（Playwright）、CLI（Tmux）与 API（HTTP）verifier。

## Phase 1: 自动检测

分析该项目，检测各个子目录里有什么。项目可能包含多个需要不同验证方式的子项目或区域（例如一个仓库里同时有 Web 前端、API 后端与共享库）。

1. **扫描顶层目录**以识别不同的项目区域：
   - 在子目录中查找单独的 package.json、Cargo.toml、pyproject.toml、go.mod
   - 在不同文件夹中识别不同的应用类型

2. **对每个区域，检测：**

   a. **项目类型与技术栈**
      - 主要语言与框架
      - 包管理器（npm、yarn、pnpm、pip、cargo 等）

   b. **应用类型**
      - Web 应用（React、Next.js、Vue 等）→ 建议基于 Playwright 的 verifier
      - CLI 工具 → 建议基于 Tmux 的 verifier
      - API 服务（Express、FastAPI 等）→ 建议基于 HTTP 的 verifier

   c. **既有验证工具**
      - 测试框架（Jest、Vitest、pytest 等）
      - E2E 工具（Playwright、Cypress 等）
      - package.json 中的开发服务器脚本

   d. **开发服务器配置**
      - 如何启动开发服务器
      - 它运行在什么 URL 上
      - 什么文本表示它就绪了

3. **已安装的验证包**（针对 Web 应用）
   - 检查是否安装了 Playwright（查看 package.json 的 dependencies/devDependencies）
   - 检查 MCP 配置（.mcp.json）是否含浏览器自动化工具：
     - Playwright MCP server
     - Chrome DevTools MCP server
     - Limkenion Chrome Extension MCP（通过 Limkenion 的 Chrome 扩展使用 browser-use）
   - 对 Python 项目，检查 playwright、pytest-playwright

## Phase 2: 验证工具设置

基于 Phase 1 中检测到的内容，帮助用户设置合适的验证工具。

### 针对 Web 应用

1. **如果浏览器自动化工具已安装/配置**，询问用户想用哪个：
   - 使用 AskUserQuestion 呈现检测到的选项
   - 例如："I found Playwright and Chrome DevTools MCP configured. Which would you like to use for verification?"

2. **如果未检测到浏览器自动化工具**，询问是否要安装/配置一个：
   - 使用 AskUserQuestion："No browser automation tools detected. Would you like to set one up for UI verification?"
   - 可提供的选项：
     - **Playwright**（推荐）- 完整的浏览器自动化库，支持无头运行，非常适合 CI
     - **Chrome DevTools MCP** - 通过 MCP 使用 Chrome DevTools Protocol
     - **Limkenion Chrome Extension** - 使用 Limkenion Chrome 扩展进行浏览器交互（需要在 Chrome 中安装该扩展）
     - **None** - 跳过浏览器自动化（仅使用基本的 HTTP 检查）

3. **如果用户选择安装 Playwright**，根据包管理器运行相应命令：
   - 对 npm: \`npm install -D @playwright/test && npx playwright install\`
   - 对 yarn: \`yarn add -D @playwright/test && yarn playwright install\`
   - 对 pnpm: \`pnpm add -D @playwright/test && pnpm exec playwright install\`
   - 对 bun: \`bun add -D @playwright/test && bun playwright install\`

4. **如果用户选择 Chrome DevTools MCP 或 Limkenion Chrome Extension**：
   - 这些需要 MCP 服务器配置，而不是安装包
   - 询问是否要你将 MCP 服务器配置添加到 .mcp.json
   - 对 Limkenion Chrome Extension，告知他们需要从 Chrome Web Store 安装该扩展

5. **MCP 服务器设置**（如适用）：
   - 如果用户选择了基于 MCP 的选项，在 .mcp.json 中配置相应条目
   - 更新 verifier 技能的 allowed-tools 以使用合适的 mcp__* 工具

### 针对 CLI 工具

1. 检查 asciinema 是否可用（运行 \`which asciinema\`）
2. 如果不可用，告知用户 asciinema 有助于录制验证会话，但它是可选的
3. Tmux 通常是系统预装的，只需确认它可用

### 针对 API 服务

1. 检查 HTTP 测试工具是否可用：
   - curl（通常系统预装）
   - httpie（\`http\` 命令）
2. 通常无需安装

## Phase 3: 交互式问答

根据 Phase 1 检测到的区域，你可能需要创建多个 verifier。对每个不同区域，使用 AskUserQuestion 工具确认：

1. **Verifier 名称** - 基于检测结果建议一个名称，但让用户选择：

   如果只有一个项目区域，使用简单格式：
   - 用于 Web UI 测试的 "verifier-playwright"
   - 用于 CLI/终端测试的 "verifier-cli"
   - 用于 HTTP API 测试的 "verifier-api"

   如果有多个项目区域，使用 \`verifier-<project>-<type>\` 格式：
   - 用于前端 Web UI 的 "verifier-frontend-playwright"
   - 用于后端 API 的 "verifier-backend-api"
   - 用于管理后台的 "verifier-admin-playwright"

   \`<project>\` 部分应为子目录或项目区域的短标识符（例如文件夹名或包名）。

   允许自定义名称，但 MUST 在名称中包含 "verifier"——Verify agent 通过查找文件夹名中的 "verifier" 来发现技能。

2. **基于类型的项目专属问题**：

   对 Web 应用（playwright）：
   - Dev server 命令（例如 "npm run dev"）
   - Dev server URL（例如 "http://localhost:3000"）
   - 就绪信号（服务器就绪时出现的文本）

   对 CLI 工具：
   - 入口点命令（例如 "node ./cli.js" 或 "./target/debug/myapp"）
   - 是否用 asciinema 录制

   对 API：
   - API 服务器命令
   - 基础 URL

3. **认证与登录**（针对 Web 应用与 API）：

   使用 AskUserQuestion 询问："Does your app require authentication/login to access the pages or endpoints being verified?"
   - **不需要认证** - 应用可公开访问，无需登录
   - **需要登录** - 验证继续前应用需要认证
   - **部分页面需要认证** - 公开与已认证路由混合

   如果用户选择需要登录（或部分），提出后续问题：
   - **登录方式**：用户如何登录？
     - 基于表单的登录（登录页上的用户名/密码）
     - API 令牌/密钥（作为 header 或 query 参数传递）
     - OAuth/SSO（基于重定向的流程）
     - 其他（让用户描述）
   - **测试凭据**：verifier 应使用什么凭据？
     - 询问登录 URL（例如 "/login"、"http://localhost:3000/auth"）
     - 询问测试用户名/邮箱与密码，或 API 密钥
     - 注意：建议用户对机密使用环境变量（例如 \`TEST_USER\`、\`TEST_PASSWORD\`）而非硬编码
   - **登录后指示器**：如何确认登录成功？
     - URL 重定向（例如重定向到 "/dashboard"）
     - 出现某元素（例如 "Welcome" 文本、用户头像）
     - 设置了 Cookie/令牌

## Phase 4: 生成 Verifier 技能

**所有 verifier 技能都创建在项目根目录的 \`.limkenion/skills/\` 目录下。** 这确保它们在 Limkenion 于项目中运行时自动加载。

将技能文件写入 \`.limkenion/skills/<verifier-name>/SKILL.md\`。

### 技能模板结构

\`\`\`markdown
---
name: <verifier-name>
description: <description based on type>
allowed-tools:
  # Tools appropriate for the verifier type
---

# <Verifier Title>

You are a verification executor. You receive a verification plan and execute it EXACTLY as written.

## Project Context
<Project-specific details from detection>

## Setup Instructions
<How to start any required services>

## Authentication
<If auth is required, include step-by-step login instructions here>
<Include login URL, credential env vars, and post-login verification>
<If no auth needed, omit this section>

## Reporting

Report PASS or FAIL for each step using the format specified in the verification plan.

## Cleanup

After verification:
1. Stop any dev servers started
2. Close any browser sessions
3. Report final summary

## Self-Update

If verification fails because this skill's instructions are outdated (dev server command/port/ready-signal changed, etc.) — not because the feature under test is broken — or if the user corrects you mid-run, use AskUserQuestion to confirm and then Edit this SKILL.md with a minimal targeted fix.
\`\`\`

### 各类允许的工具

**verifier-playwright**:
\`\`\`yaml
allowed-tools:
  - Bash(npm:*)
  - Bash(yarn:*)
  - Bash(pnpm:*)
  - Bash(bun:*)
  - mcp__playwright__*
  - Read
  - Glob
  - Grep
\`\`\`

**verifier-cli**:
\`\`\`yaml
allowed-tools:
  - Tmux
  - Bash(asciinema:*)
  - Read
  - Glob
  - Grep
\`\`\`

**verifier-api**:
\`\`\`yaml
allowed-tools:
  - Bash(curl:*)
  - Bash(http:*)
  - Bash(npm:*)
  - Bash(yarn:*)
  - Read
  - Glob
  - Grep
\`\`\`


## Phase 5: 确认创建

写入技能文件后，告知用户：
1. 每个技能创建在哪里（总是在 \`.limkenion/skills/\` 中）
2. Verify agent 如何发现它们——文件夹名必须包含 "verifier"（不区分大小写）才能自动发现
3. 他们可以编辑这些技能进行自定义
4. 他们可以再次运行 /init-verifiers 为其他区域添加更多 verifier
5. 如果 verifier 检测到自身指令已过时（dev server 命令错误、就绪信号有变等），它会主动提供自我更新
`,
      },
    ]
  },
} satisfies Command

export default command
