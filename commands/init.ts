import { feature } from 'bun:bundle'
import type { Command } from '../commands.js'
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'
import { isEnvTruthy } from '../utils/envUtils.js'

const OLD_INIT_PROMPT = `请分析此代码库并创建一份 LIMKENION.md 文件，该文件将提供给未来在本仓库中运行的 Limkenion 实例使用。

需要添加的内容：
1. 常用的命令，例如如何构建、运行 lint 与测试。包括在此代码库中开发所需的关键命令，例如如何运行单个测试。
2. 高层级的代码架构与结构，以便未来实例能更快上手。重点放在需要阅读多个文件才能理解的"全局架构"上。

使用说明：
- 如果已存在 LIMKENION.md，请对其提出改进建议。
- 当你创建初始 LIMKENION.md 时，不要重复自己，也不要包含诸如"为用户提供有帮助的错误信息""为新工具编写单元测试""切勿在代码或提交中包含敏感信息（API 密钥、token）"之类的显而易见说明。
- 避免罗列本可轻易发现的组件或文件结构。
- 不要包含通用开发实践。
- 如果存在 Cursor 规则（.cursor/rules/ 或 .cursorrules）或 Copilot 规则（.github/copilot-instructions.md），请务必纳入重要部分。
- 如果存在 README.md，请务必纳入重要部分。
- 除非你所读的其他文件中明确包含，否则不要编造诸如"Common Development Tasks""Tips for Development""Support and Documentation"之类的信息。
- 请务必以以下文本作为文件开头：

\`\`\`
# LIMKENION.md

This file provides guidance to Limkenion when working with code in this repository.
\`\`\``

const NEW_INIT_PROMPT = `为当前仓库搭建一份精简的 LIMKENION.md（并可选择搭配 skills 与 hooks）。LIMKENION.md 会被加载进每一个 Limkenion 会话中，因此必须保持简洁——只包含缺少它 Limkenion 就会犯错的内容。

## 阶段 1：询问要搭建哪些内容

使用 AskUserQuestion 了解用户想要什么：

- "Which LIMKENION.md files should /init set up?"
  选项："Project LIMKENION.md" | "Personal LIMKENION.local.md" | "Both project + personal"
  项目说明："Team-shared instructions checked into source control — architecture, coding standards, common workflows."
  个人说明："Your private preferences for this project (gitignored, not shared) — your role, sandbox URLs, preferred test data, workflow quirks."

- "Also set up skills and hooks?"
  选项："Skills + hooks" | "Skills only" | "Hooks only" | "Neither, just LIMKENION.md"
  skills 说明："On-demand capabilities you or Limkenion invoke with \`/skill-name\` — good for repeatable workflows and reference knowledge."
  hooks 说明："Deterministic shell commands that run on tool events (e.g., format after every edit). Limkenion can't skip them."

## 阶段 2：探索代码库

启动一个子代理来勘察代码库，并让其阅读关键文件以理解项目：清单文件（package.json、Cargo.toml、pyproject.toml、go.mod、pom.xml 等）、README、Makefile/构建配置、CI 配置、已有的 LIMKENION.md、.limkenion/rules/、AGENTS.md、.cursor/rules 或 .cursorrules、.github/copilot-instructions.md、.windsurfrules、.clinerules、.mcp.json。

需要检测：
- 构建、测试与 lint 命令（尤其是非常规命令）
- 使用的语言、框架与包管理器
- 项目结构（带 workspace 的 monorepo、多模块或单一项目）
- 与语言默认约定不同的代码风格规则
- 不明显但易踩坑的要点、必需的环境变量或工作流怪癖
- 已有的 .limkenion/skills/ 与 .limkenion/rules/ 目录
- 格式化器配置（prettier、biome、ruff、black、gofmt、rustfmt，或类似 \`npm run format\` / \`make fmt\` 的统一格式脚本）
- Git worktree 使用情况：运行 \`git worktree list\` 检查本仓库是否有多个 worktree（仅当用户想要个人 LIMKENION.local.md 时才相关）

记下仅凭代码无法判断的内容——这些会成为访谈问题。

## 阶段 3：填补空白

使用 AskUserQuestion 收集撰写优质 LIMKENION.md 与 skills 所需的其余信息。只问代码无法回答的问题。

如果用户选择了项目 LIMKENION.md 或两者：询问代码库实践——非常规命令、易踩坑的点、分支/PR 约定、必需的运行环境设置、测试怪癖。跳过 README 已有或清单文件中显而易见的内容。不要将任何选项标记为"推荐"——这涉及的是团队的协作方式，而非最佳实践。

如果用户选择了个人 LIMKENION.local.md 或两者：询问用户本人，而不是代码库。不要将任何选项标记为"推荐"——这涉及的是个人偏好，而非最佳实践。问题示例：
  - 他们在团队中的角色是什么？（例如"后端工程师""数据科学家""新入职员工培训"）
  - 他们对代码库及其语言/框架的熟悉程度如何？（以便 Limkenion 校准讲解的深度）
  - 他们是否有个人 sandbox 的 URL、测试账号、API 密钥路径或 Limkenion 应当知晓的本地环境细节？
  - 仅当阶段 2 发现存在多个 git worktree 时：询问他们的 worktree 是嵌套在主仓库内（例如 \`.limkenion/worktrees/<name>/\`），还是平级/外部（例如 \`../myrepo-feature/\`）。若嵌套，向上查找文件时能自动找到主仓库的 LIMKENION.local.md——无需特殊处理。若平级/外部，个人内容应放在主目录下的文件中（例如 \`~/.limkenion/<project-name>-instructions.md\`），每个 worktree 配一个单行 LIMKENION.local.md 存根来导入它：\`@~/.limkenion/<project-name>-instructions.md\`。切勿将该导入放进项目 LIMKENION.md——那会把个人引用写进团队共享文件。
  - 是否有沟通偏好？（例如"说话简洁""始终解释权衡""结尾不要做总结"）

**根据阶段 2 的发现综合出一份提案**——例如存在格式化器时搭建 format-on-edit 钩子，存在测试时建议 \`/verify\` skill，针对补充回答中是行为准则而非工作流的内容添加 LIMKENION.md 备注。每一项都挑选最匹配的产物类型，**受阶段 1 关于 skills+hooks 的选择约束**：

  - **Hook**（更严格）——作用于工具事件的确定性 shell 命令；Limkenion 无法跳过。适合机械、快速、每次编辑都执行的步骤：格式化、lint、对改动文件跑快速测试。
  - **Skill**（按需）——你想要时由你或 Limkenion 通过 \`/skill-name\` 调用。适合不需要每次编辑都执行的流程：深度校验、会话报告、部署。
  - **LIMKENION.md note**（更宽松）——会影响 Limkenion 的行为但不强制。适合沟通/思考偏好："编码前先规划""说话简洁""解释权衡"。

  **把阶段 1 关于 skills+hooks 的选择作为硬性过滤条件**：若用户选了"Skills only"，把你原本想建议的 hook 降级为 skill 或 LIMKENION.md note。若为"Hooks only"，把 skills 降级为 hooks（在机制允许时）或 notes。若为"Neither"，则一切变成 LIMKENION.md note。绝不提议用户未选择加入的产物类型。

**通过 AskUserQuestion 的 \`preview\` 字段展示提案，而不是作为单独的文字消息**——对话框会覆盖你的输出，因此之前的文字会被隐藏。\`preview\` 字段会在侧边面板中渲染 markdown（类似 plan 模式）；\`question\` 字段仅限纯文本。将其组织为：

  - \`question\`：短小直白，例如"Does this proposal look right?"
  - 每个选项都配一个 \`preview\`，内容为完整的 markdown 提案。"Looks good — proceed" 选项的 preview 展示全部内容；逐项移除的选项其 preview 展示移除后剩余的内容。
  - **保持 preview 紧凑——预览框会被截断且无法滚动。** 每项一行、项间无空行、无标题。示例 preview 内容：

    • **Format-on-edit hook** (automatic) — \`ruff format <file>\` via PostToolUse
    • **/verify skill** (on-demand) — \`make lint && make typecheck && make test\`
    • **LIMKENION.md note** (guideline) — "run lint/typecheck/test before marking done"

  - 选项标签保持简短（"Looks good""Drop the hook""Drop the skill"）——工具会自动添加一个"Other"自由文本选项，因此不要自行添加兜底项。

**根据通过的提案构建偏好队列。** 每条：{type: hook|skill|note, description, target file, 任何来自阶段 2 的细节，如实际的测试/格式化命令}。阶段 4–7 会消费此队列。

## 阶段 4：编写 LIMKENION.md（若用户选择了项目或两者）

在项目根目录写一份精简的 LIMKENION.md。每一行都必须通过这项测试："移除这一行是否会导致 Limkenion 犯错？"若不会，则删掉。

**消费阶段 3 偏好队列中目标为 LIMKENION.md 的 \`note\` 条目**（团队级备注）——把每条作为一句话加进最相关的章节。这些是用户希望 Limkenion 遵循但不强求保证的行为（例如"实现前先提方案""重构时解释权衡"）。把面向个人的备注留到阶段 5。

包含：
- Limkenion 无法自行猜出的构建/测试/lint 命令（非常规脚本、flag 或步骤序列）
- 与语言默认约定**不同**的代码风格规则（例如"优先使用 type 而非 interface"）
- 测试说明与怪癖（例如"用以下命令运行单个测试：pytest -k 'test_name'"）
- 仓库礼仪（分支命名、PR 约定、提交风格）
- 必需的 env var 或环境搭建步骤
- 不明显易踩坑的点或架构决策
- 已有 AI 编码工具配置中的重要部分（AGENTS.md、.cursor/rules、.cursorrules、.github/copilot-instructions.md、.windsurfrules、.clinerules）

排除：
- 逐文件的结构或组件清单（Limkenion 可以通过阅读代码库自行发现）
- Limkenion 已经知道的标准语言约定
- 笼统建议（"写好代码""处理错误"）
- 详尽的 API 文档或长引用——改用 \`@path/to/import\` 语法（例如 \`@docs/api-reference.md\`）按需内联内容，而不用撑大 LIMKENION.md
- 频繁变化的信息——用 \`@path/to/import\` 引用来源，让 Limkenion 始终读到最新版本
- 冗长的教程或操作指南（移到单独文件，用 \`@path/to/import\` 引用，或放进 skill）
- 清单文件中显而易见的命令（例如标准"npm test""cargo test""pytest"）

要具体："Use 2-space indentation in TypeScript" 优于 "Format code properly."

不要重复自己，也不要编造诸如"Common Development Tasks"或"Tips for Development"之类的章节——只纳入你在阅读文件时明确找到的信息。

在文件开头加上：

\`\`\`
# LIMKENION.md

This file provides guidance to Limkenion when working with code in this repository.
\`\`\`

如果 LIMKENION.md 已存在：阅读它，提出具体的改动（以 diff 形式），并解释每项改动为何能改进它。不要静默覆盖。

对于含多种关注点的项目，建议把指令组织到 \`.limkenion/rules/\` 下的多个独立聚焦文件中（例如 \`code-style.md\`、\`testing.md\`、\`security.md\`）。这些文件会随 LIMKENION.md 自动加载，并可用 \`paths\` frontmatter 限定到特定文件路径。

对于含不同子目录的项目（monorepo、多模块项目等）：提及可为模块专属指令添加子目录级别的 LIMKENION.md 文件（当 Limkenion 在这些目录中工作时会自动加载）。如果用户需要，提出为其创建。

## 阶段 5：编写 LIMKENION.local.md（若用户选择了个人或两者）

在项目根目录写一份精简的 LIMKENION.local.md。该文件会随 LIMKENION.md 自动加载。创建后，把 \`LIMKENION.local.md\` 加入项目的 .gitignore，使其保持私有。

**消费阶段 3 偏好队列中目标为 LIMKENION.local.md 的 \`note\` 条目**（个人级备注）——每条写成一句话。若用户在阶段 1 只选了个人，这里就是 note 条目的唯一消费方。

包含：
- 用户的角色与对代码库的熟悉程度（以便 Limkenion 校准讲解）
- 个人 sandbox 的 URL、测试账号或本地环境细节
- 个人工作流或沟通偏好

保持简短——只包含能让 Limkenion 对该用户的回复明显更好的内容。

若阶段 2 发现存在多个 git worktree，且用户确认使用平级/外部 worktree（而非嵌套在主仓库内）：向上查找文件时不能从所有 worktree 找到同一个 LIMKENION.local.md。应把实际个人内容写入 \`~/.limkenion/<project-name>-instructions.md\`，并让 LIMKENION.local.md 成为引用它的单行存根：\`@~/.limkenion/<project-name>-instructions.md\`。用户可将该单行存根复制到每个平级 worktree。切勿把该导入放进项目 LIMKENION.md。若 worktree 嵌套在主仓库内（例如 \`.limkenion/worktrees/\`），则无需特殊处理——主仓库的 LIMKENION.local.md 会被自动找到。

如果 LIMKENION.local.md 已存在：阅读它，提出具体的补充，不要静默覆盖。

## 阶段 6：建议并创建 skills（若用户选择了"Skills + hooks"或"Skills only"）

Skills 能让 Limkenion 按需使用能力，而不撑大每个会话。

**首先，消费阶段 3 偏好队列中的 \`skill\` 条目。** 每条排队的 skill 偏好都会变成一个按用户描述定制的 SKILL.md。对每条：
- 依据偏好为其命名（例如"verify-deep""session-report""deploy-sandbox"）
- 正文使用用户在访谈中的原话，再加上阶段 2 发现的任何内容（测试命令、报告格式、部署目标）。若该偏好对应某个已有的内置 skill（例如 \`/verify\`），就写一个在其之上叠加用户特定约束的项目级 skill——并告知用户内置的那个仍然存在，他们这个是附加的。
- 若偏好描述不完整，追问一个简短问题（例如"verify-deep 应该运行哪个测试命令？"）

**然后，在队列之外进一步建议 skills**，当你发现：
- 针对特定任务而需要的参考知识（某个子系统的约定、模式、风格指南）
- 用户希望直接触发的可复用工作流（部署、修复 issue、发布流程、校验改动）

对每个建议的 skill，提供：名称、一句话用途，以及它为何适合本仓库。

若 \`.limkenion/skills/\` 下已有 skills，先审视它们。不要覆盖已有 skills——只建议能与之互补的新内容。

在 \`.limkenion/skills/<skill-name>/SKILL.md\` 创建每个 skill：

\`\`\`yaml
---
name: <skill-name>
description: <what the skill does and when to use it>
---

<Instructions for Limkenion>
\`\`\`

默认情况下，用户（通过 \`/<skill-name>\`）和 Limkenion 都可以调用 skills。对于带副作用的流程（例如 \`/deploy\`、\`/fix-issue 123\`），添加 \`disable-model-invocation: true\`，让只有用户能触发它，并用 \`$ARGUMENTS\` 接收输入。

## 阶段 7：建议其他优化

告知用户：既然 LIMKENION.md 与 skills（若已选择）都已就位，你接下来会建议一些额外的优化。

检查环境，并就你发现的每一项缺口进行询问（使用 AskUserQuestion）：

- **GitHub CLI**：运行 \`which gh\`（Windows 上为 \`where gh\`）。若缺失且项目使用 GitHub（用 \`git remote -v\` 检查是否指向 github.com），询问用户是否要安装。解释 GitHub CLI 能让 Limkenion 直接帮助你完成提交、拉取请求、issue 与代码审查。

- **Linting**：若阶段 2 未发现 lint 配置（对于项目所用语言没有 .eslintrc、ruff.toml、.golangci.yml 等），询问用户是否希望 Limkenion 为此代码库搭建 linting。解释 linting 能尽早发现问题，并让 Limkenion 对自己产生的编辑得到快速反馈。

- **提案来源的 hooks**（若用户选择了"Skills + hooks"或"Hooks only"）：消费阶段 3 偏好队列中的 \`hook\` 条目。若阶段 2 发现了格式化器且队列中没有格式化钩子，则提供 format-on-edit 作为兜底。若用户在阶段 1 选择了"Neither"或"Skills only"，直接跳过整个要点。

  对每条 hook 偏好（来自队列或格式化兜底）：

  1. 目标文件：依据阶段 1 的 LIMKENION.md 选择取默认值——项目 → \`.limkenion/settings.json\`（团队共享、需提交）；个人 → \`.limkenion/settings.local.json\`。仅当用户在阶段 1 选择了"both"或偏好存在歧义时才询问。一次性询问全部 hooks，而不是逐个问。

  2. 从偏好中挑选事件与 matcher：
     - "after every edit" → 使用 matcher 为 \`Write|Edit\` 的 \`PostToolUse\`
     - "when Limkenion finishes" / "before I review" → \`Stop\` 事件（在每一轮结束时触发——包括只读轮）
     - "before running bash" → 使用 matcher 为 \`Bash\` 的 \`PreToolUse\`
     - "before committing"（字面意义的 git-commit 门禁）→ **不是 hooks.json 里的 hook。** Matcher 无法按命令内容过滤 Bash，因此无法只针对 \`git commit\`。应把它引导到 git pre-commit 钩子（\`.git/hooks/pre-commit\`、husky、pre-commit 框架）——并提出帮忙编写。若用户实际想表达的是"在我审阅并提交 Limkenion 的输出之前"，那属于 \`Stop\`——请追问以消除歧义。
     若偏好存在歧义，请追问。

  3. **加载 hook 参考**（每次 \`/init\` 只一次，在首个 hook 之前）：以 \`skill: 'update-config'\` 调用 Skill 工具，args 以 \`[hooks-only]\` 开头，后跟一行概括你要构建的内容——例如 \`[hooks-only] Constructing a PostToolUse/Write|Edit format hook for .limkenion/settings.json using ruff\`。这把 hooks schema 与校验流程加载进上下文。后续 hooks 复用即可——不要重复调用。

  4. 遵循该 skill 的 **"Constructing a Hook"** 流程：去重检查 → 为当前项目构造 → 用 pipe-test 验证原始内容 → 包装 → 写 JSON → 用 \`jq -e\` 校验 → 实机验证（针对可触发 matcher 的 \`Pre|PostToolUse\`）→ 清理 → 交接。目标文件与事件/matcher 来自上面的第 1–2 步。

每个"是"都要先落地再继续。

## 阶段 8：总结与后续步骤

回顾已搭建的内容——写入了哪些文件、每个文件包含了哪些要点。提醒用户这些文件只是起点：他们应该审阅并微调，也可随时再次运行 \`/init\` 重新扫描。

然后告知用户：你将基于所发现的，介绍更多关于优化其代码库与 Limkenion 配置的提议。把这些整理成一份单一的、格式良好的待办清单，其中每一项都与该仓库相关。把影响最大的项放在最前面。

构建清单时，逐步核对以下检查且只纳入适用的项：
- 若检测到前端代码（React、Vue、Svelte 等）：\`/plugin install frontend-design@limkenion-plugins-official\` 可为 Limkenion 提供设计原则与组件模式，使其产出精致的 UI；\`/plugin install playwright@limkenion-plugins-official\` 可让 Limkenion 启动真实浏览器、对自己构建的内容截图，并自行修复视觉 bug。
- 若你在阶段 7 发现了缺口（缺少 GitHub CLI、缺少 linting）而用户表示不需要：在这里列出它们，并一行说明每项为何有用。
- 若测试缺失或很少：建议搭建测试框架，让 Limkenion 能校验自身的改动。
- 为帮助你借助 evals 创建 skills 并优化现有 skills，Limkenion 有一个官方的 skill-creator 插件可安装。用 \`/plugin install skill-creator@limkenion-plugins-official\` 安装，然后运行 \`/skill-creator <skill-name>\` 来新建或精修任意现有 skill。（始终包含此项。）
- 用 \`/plugin\` 浏览官方插件——它们捆绑了 skills、agents、hooks 与 MCP servers，你可能会觉得有帮助。你也可以创建自己的自定义插件与他人分享。（始终包含此项。）`

const command = {
  type: 'prompt',
  name: 'init',
  get description() {
    return feature('NEW_INIT') &&
      ((isEnvTruthy(process.env.LIMKENION_NEW_INIT)))
      ? '初始化新的 LIMKENION.md 文件及可选 skills/hooks，并附带代码库文档'
      : '初始化一个新的带代码库文档的 LIMKENION.md 文件'
  },
  contentLength: 0, // 动态内容
  progressMessage: '正在分析你的代码库',
  source: 'builtin',
  async getPromptForCommand() {
    maybeMarkProjectOnboardingComplete()

    return [
      {
        type: 'text',
        text:
          feature('NEW_INIT') &&
          ((isEnvTruthy(process.env.LIMKENION_NEW_INIT)))
            ? NEW_INIT_PROMPT
            : OLD_INIT_PROMPT,
      },
    ]
  },
} satisfies Command

export default command
