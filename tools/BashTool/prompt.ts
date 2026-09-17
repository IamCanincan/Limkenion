import { feature } from 'bun:bundle'
import { prependBullets } from '../../constants/prompts.js'
import { getAttributionTexts } from '../../utils/attribution.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { shouldIncludeGitInstructions } from '../../utils/gitSettings.js'
import { getLimkenionTempDir } from '../../utils/permissions/filesystem.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import {
  getUndercoverInstructions,
  isUndercover,
} from '../../utils/undercover.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { TodoWriteTool } from '../TodoWriteTool/TodoWriteTool.js'
import { BASH_TOOL_NAME } from './toolName.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.LIMKENION_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return "可以使用 `run_in_background` 参数在后台运行命令。只有当你不立即需要结果、且愿意在命令稍后完成时收到通知时才使用它。你无需立即检查输出——命令完成时会收到通知。使用该参数时，无需在命令末尾添加 '&'。"
}

function getCommitAndPRInstructions(): string {
  // 纵深防御：即使完全禁用 git 指令，匿名隐藏指令也必须保留。
  // 归属信息剥离和模型 ID 隐藏是机械性的、始终生效的，但这条明确的
  // “别暴露你的身份”指令是防止模型在提交信息里泄露内部代号
  // 的最后一道防线。
  const undercoverSection =
    ''

  if (!shouldIncludeGitInstructions()) return undercoverSection

  // 供外部用户使用，附完整的行内说明
  const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()

  return `# 通过 git 提交更改

仅在用户明确要求时才创建提交。若不确定，先询问。当用户要求你创建新的 git 提交时，请按以下步骤谨慎操作：

你可以在单次响应中多次调用工具。当同时请求多条相互独立的命令且它们都很可能成功时，请并行发起多个工具调用以获得最佳性能。下面的编号步骤指明了哪些命令应并行处理。

Git 安全协议：
- 绝不要更新 git 配置
- 除非用户明确要求，否则绝不要运行破坏性 git 命令（push --force、reset --hard、checkout .、restore .、clean -f、branch -D）。未经授权的破坏性操作只会帮倒忙，并可能导致工作丢失，因此除非收到直接指令，最好只运行这些命令
- 除非用户明确要求，否则绝不要跳过钩子（--no-verify、--no-gpg-sign 等）
- 绝不要对 main/master 执行强制推送，若用户要求请先警告
- 关键：除非用户明确要求 git amend，否则始终创建新的提交而不是修改旧提交。当 pre-commit 钩子失败时，提交实际上没有发生——此时使用 --amend 会修改上一个提交，可能导致工作被破坏或丢失。钩子失败后应修复问题、重新暂存并创建新提交
- 暂存文件时，优先按名称添加具体文件，而不是使用 "git add -A" 或 "git add ."，否则可能意外纳入敏感文件（.env、凭据）或大型二进制文件
- 除非用户明确要求，否则绝不要提交更改。这一点非常重要——如果你过于主动地提交，用户会反感

1. 并行运行以下 bash 命令，每条都使用 ${BASH_TOOL_NAME} 工具：
  - 运行 git status 命令查看所有未跟踪文件。重要：绝不要使用 -uall 标志，它可能在大仓库中导致内存问题。
  - 运行 git diff 命令查看将被提交的已暂存和未暂存的更改。
  - 运行 git log 命令查看最近的提交信息，以便遵循此仓库的提交信息风格。
2. 分析所有已暂存的更改（既包括之前暂存的，也包括新添加的）并起草提交信息：
  - 概括更改的性质（例如：新功能、对现有功能的增强、缺陷修复、重构、测试、文档等）。确保信息准确反映更改及其目的（即 "add" 表示全新的功能，"update" 表示对现有功能的增强，"fix" 表示缺陷修复等）。
  - 不要提交可能包含机密文件的文件（.env、credentials.json 等）。若用户明确要求提交这些文件，请予以警告。
  - 起草一句简洁（1-2 句）的提交信息，聚焦于“为什么”而非“是什么”
  - 确保它准确反映更改及其目的
3. 并行运行以下命令：
   - 将相关的未跟踪文件加入暂存区。
   - 创建提交，信息${commitAttribution ? `以如下结尾：\n   ${commitAttribution}` : '.'}
   - 提交完成后运行 git status 以验证成功。
   注意：git status 依赖提交完成，因此要顺序执行。
4. 如果提交因 pre-commit 钩子失败：修复问题并创建一条新的提交

重要说明：
- 除了 git bash 命令之外，绝不要运行其他命令来读取或探索代码
- 绝不要使用 ${TodoWriteTool.name} 或 ${AGENT_TOOL_NAME} 工具
- 除非用户明确要求，否则不要推送到远程仓库
- 重要：绝不要使用带 -i 标志的 git 命令（如 git rebase -i 或 git add -i），因为需要交互式输入，而这不被支持。
- 重要：不要对 git rebase 命令使用 --no-edit，因为 --no-edit 不是 git rebase 的有效选项。
- 若没有可提交的更改（即没有未跟踪文件、也没有修改），则不要创建空提交
- 为确保格式良好，始终通过 HEREDOC 传递提交信息，例如：
<example>
git commit -m "$(cat <<'EOF'
   在此填写提交信息。${commitAttribution ? `\n\n   ${commitAttribution}` : ''}
   EOF
   )"
</example>

# 创建拉取请求
所有 GitHub 相关任务（包括处理 issue、拉取请求、检查和发布）都应通过 Bash 工具使用 gh 命令。如果给定 GitHub URL，请使用 gh 命令获取所需信息。

重要：当用户要求你创建拉取请求时，请按以下步骤谨慎操作：

1. 使用 ${BASH_TOOL_NAME} 工具并行运行以下 bash 命令，以理解当前分支相对 main 分支的最新状态：
   - 运行 git status 命令查看所有未跟踪文件（绝不要使用 -uall 标志）
   - 运行 git diff 命令查看将被提交的已暂存和未暂存的更改
   - 检查当前分支是否跟踪远程分支以及是否与远程保持同步，以便判断是否需要推送到远程
   - 运行 git log 命令以及 \`git diff [base-branch]...HEAD\`，以理解当前分支的完整提交历史（从分支偏离 base 分支时起）
2. 分析将包含在拉取请求中的所有更改，务必查看所有相关提交（不仅是最新提交，而是将包含在拉取请求中的所有提交！！！），并起草拉取请求的标题和摘要：
   - 保持 PR 标题简短（70 字符以内）
   - 使用正文/主体来承载细节，而不是标题
3. 并行运行以下命令：
   - 如有需要则创建新分支
   - 如有需要则带 -u 标志推送到远程
   - 使用 gh pr create 创建 PR，格式如下。使用 HEREDOC 传递正文以确保格式正确。
<example>
gh pr create --title "PR 标题" --body "$(cat <<'EOF'
## 摘要
<1-3 条要点>

## 测试计划
[用于测试该拉取请求的 TODO 清单……]${prAttribution ? `\n\n${prAttribution}` : ''}
EOF
)"
</example>

重要：
- 绝不要使用 ${TodoWriteTool.name} 或 ${AGENT_TOOL_NAME} 工具
- 完成后返回 PR URL，以便用户查看

# 其他常见操作
- 查看 GitHub PR 上的评论：gh api repos/foo/bar/pulls/123/comments`
}

// SandboxManager 会合并来自多个来源（设置分层、默认值、CLI 标志）的配置，
// 且不去重，因此像 ~/.cache 这样的路径会在 allowOnly 中出现 3 次。
// 在拼入提示词前先在此去重——只影响模型所见内容，不影响沙箱强制执行。
// 启用沙箱时，每次请求可节省约 150-200 个 token。
function dedup<T>(arr: T[] | undefined): T[] | undefined {
  if (!arr || arr.length === 0) return arr
  return [...new Set(arr)]
}

function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''
  }

  const fsReadConfig = SandboxManager.getFsReadConfig()
  const fsWriteConfig = SandboxManager.getFsWriteConfig()
  const networkRestrictionConfig = SandboxManager.getNetworkRestrictionConfig()
  const allowUnixSockets = SandboxManager.getAllowUnixSockets()
  const ignoreViolations = SandboxManager.getIgnoreViolations()
  const allowUnsandboxedCommands =
    SandboxManager.areUnsandboxedCommandsAllowed()

  // 将按 UID 变化的临时目录字面量（如 /private/tmp/limkenion-1001/）替换为
  // "$TMPDIR"，使提示词对所有用户完全一致——避免破坏
  // 跨用户的全局提示词缓存。沙箱会在运行时设置 $TMPDIR。
  const limkenionTempDir = getLimkenionTempDir()
  const normalizeAllowOnly = (paths: string[]): string[] =>
    [...new Set(paths)].map(p => (p === limkenionTempDir ? '$TMPDIR' : p))

  const filesystemConfig = {
    read: {
      denyOnly: dedup(fsReadConfig.denyOnly),
      ...(fsReadConfig.allowWithinDeny && {
        allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
      }),
    },
    write: {
      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
      denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
    },
  }

  const networkConfig = {
    ...(networkRestrictionConfig?.allowedHosts && {
      allowedHosts: dedup(networkRestrictionConfig.allowedHosts),
    }),
    ...(networkRestrictionConfig?.deniedHosts && {
      deniedHosts: dedup(networkRestrictionConfig.deniedHosts),
    }),
    ...(allowUnixSockets && { allowUnixSockets: dedup(allowUnixSockets) }),
  }

  const restrictionsLines = []
  if (Object.keys(filesystemConfig).length > 0) {
    restrictionsLines.push(`Filesystem: ${jsonStringify(filesystemConfig)}`)
  }
  if (Object.keys(networkConfig).length > 0) {
    restrictionsLines.push(`Network: ${jsonStringify(networkConfig)}`)
  }
  if (ignoreViolations) {
    restrictionsLines.push(
      `Ignored violations: ${jsonStringify(ignoreViolations)}`,
    )
  }

  const sandboxOverrideItems: Array<string | string[]> =
    allowUnsandboxedCommands
      ? [
          '除非有充分理由，否则你应始终默认在沙箱内运行命令。在满足以下条件之前，不要尝试把 `dangerouslyDisableSandbox` 设为 `true`：',
          [
            '用户*明确*要求你绕过沙箱',
            '某条具体命令刚刚失败，而你发现沙箱限制是导致失败的原因。注意，命令失败的原因有很多，与沙箱无关（文件缺失、参数错误、网络问题等）。',
          ],
          '由沙箱导致的失败迹象包括：',
          [
            '文件/网络操作报 “Operation not permitted” 错误',
            '对允许目录之外的特定路径拒绝访问',
            '对未在白名单中的主机连接网络失败',
            'Unix 套接字连接错误',
          ],
          '当你发现由沙箱导致的失败迹象时：',
          [
            "立即用 `dangerouslyDisableSandbox: true` 重试（不要询问，直接做）",
            '简要说明很可能由哪种沙箱限制导致了失败。务必提及用户可以使用 `/sandbox` 命令来管理限制。',
            '这会提示用户授权',
          ],
          '对每条用 `dangerouslyDisableSandbox: true` 执行的命令都要单独看待。即使你近期已用过该设置运行命令，仍应默认在沙箱内执行后续命令。',
          '不要建议把 ~/.bashrc、~/.zshrc、~/.ssh/* 等敏感路径或凭证文件加入沙箱允许列表。',
        ]
      : [
          '所有命令都必须在沙箱模式下运行——`dangerouslyDisableSandbox` 参数已被策略禁用。',
          '任何情况下命令都不能脱离沙箱运行。',
          '如果命令因沙箱限制而失败，应与用户协作调整沙箱设置，而不是绕过。',
        ]

  const items: Array<string | string[]> = [
    ...sandboxOverrideItems,
    '对于临时文件，始终使用 `$TMPDIR` 环境变量。在沙箱模式下，TMPDIR 会自动设置为正确的沙箱可写目录。不要直接使用 `/tmp`——请改用 `$TMPDIR`。',
  ]

  return [
    '',
    '## 命令沙箱',
    '默认情况下，你的命令将在沙箱中运行。该沙箱控制命令在没有明确覆盖时可访问或修改哪些目录和网络主机。',
    '',
    '该沙箱有以下限制：',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

export function getSimplePrompt(): string {
  // Ant-native 构建会在 Limkenion 的 shell 中将 find/grep 别名为内嵌的 bfs/ugrep，
  // 因此我们不引导用户避开它们（同时 Glob/Grep 工具会被移除）。
  const embedded = hasEmbeddedSearchTools()

  const toolPreferenceItems = [
    ...(embedded
      ? []
      : [
          `文件搜索：使用 ${GLOB_TOOL_NAME}（而不是 find 或 ls）`,
          `内容搜索：使用 ${GREP_TOOL_NAME}（而不是 grep 或 rg）`,
        ]),
    `读取文件：使用 ${FILE_READ_TOOL_NAME}（而不是 cat/head/tail）`,
    `编辑文件：使用 ${FILE_EDIT_TOOL_NAME}（而不是 sed/awk）`,
    `写入文件：使用 ${FILE_WRITE_TOOL_NAME}（而不是 echo >/cat <<EOF）`,
    '通信：直接输出文本（而不是 echo/printf）',
  ]

  const avoidCommands = embedded
    ? '`cat`、`head`、`tail`、`sed`、`awk` 或 `echo`'
    : '`find`、`grep`、`cat`、`head`、`tail`、`sed`、`awk` 或 `echo`'

  const multipleCommandsSubitems = [
    `如果各命令相互独立且可并行运行，请在单条消息中多次调用 ${BASH_TOOL_NAME} 工具。例如：若需运行 "git status" 和 "git diff"，就在一条消息中并行发送两次 ${BASH_TOOL_NAME} 调用。`,
    `如果各命令相互依赖且必须顺序执行，请在单条 ${BASH_TOOL_NAME} 调用中使用 '&&' 将它们串联起来。`,
    "只有在需要顺序执行命令、且不关心前面命令是否失败时，才使用 ';'。",
    '不要用换行分隔命令（换行在带引号的字符串中是可以的）。',
  ]

  const gitSubitems = [
    '优先创建新提交，而不是改写已有提交。',
    '在执行破坏性操作（如 git reset --hard、git push --force、git checkout --）之前，考虑是否有能达到相同目的的更安全方案。只有在万不得已时才使用破坏性操作。',
    '除非用户明确要求，否则不要跳过钩子（--no-verify）或绕过签名（--no-gpg-sign、-c commit.gpgsign=false）。如果钩子失败，请排查并修复根本原因。',
  ]

  const sleepSubitems = [
    '不要在不必要之间插入 sleep——直接运行即可。',
    ...(feature('MONITOR_TOOL')
      ? [
          '使用 Monitor 工具流式接收后台进程的事件（stdout 的每一行都是一条通知）。若想“等待完成”这种一次性场景，则改用带 run_in_background 的 Bash。',
        ]
      : []),
    '如果命令运行时间较长，且你想在它完成时收到通知——使用 `run_in_background`。无需 sleep。',
    '不要用 sleep 循环重试失败的命令——请诊断根本原因。',
    '如果正在等待你用 `run_in_background` 启动的后台任务，完成时会收到通知——不要轮询。',
    ...(feature('MONITOR_TOOL')
      ? [
          '`sleep N` 作为首条命令且 N ≥ 2 时会被阻止。若你需要延迟（限流、刻意留出节奏），请控制在 2 秒以内。',
        ]
      : [
          '如果必须轮询外部进程，请使用检查命令（如 `gh run view`）而不是先 sleep。',
          '如果必须 sleep，请保持较短时长（1-5 秒），以免阻塞用户。',
        ]),
  ]
  const backgroundNote = getBackgroundUsageNote()

  const instructionItems: Array<string | string[]> = [
    '如果命令将创建新目录或新文件，请先使用本工具运行 `ls`，确认父目录存在且位置正确。',
    '对于含空格的路径，在命令中用双引号引用（例如：cd "path with spaces/file.txt"）。',
    '尽量在整个会话中通过使用绝对路径、避免使用 `cd` 来维持当前工作目录。如果用户明确要求，可以使用 `cd`。',
    `可以指定可选的超时时间（以毫秒计，最大 ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} 分钟）。默认情况下，命令会在 ${getDefaultTimeoutMs()}ms（${getDefaultTimeoutMs() / 60000} 分钟）后超时。`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    '当需要发出多条命令时：',
    multipleCommandsSubitems,
    '关于 git 命令：',
    gitSubitems,
    '避免不必要的 `sleep` 命令：',
    sleepSubitems,
    ...(embedded
      ? [
          // bfs（支撑 `find`）对 -regex 使用 Oniguruma，会选择
          // 第一个匹配的备选项（最优先），而 GNU find 使用 POSIX 的
          // 最长优先。当较短的备选项是较长备选项的前缀时，会静默丢失匹配。
          "使用带交替的 `find -regex` 时，把最长的备选项放在前面。示例：用 `'.*\\.\\(tsx\\|ts\\)'` 而不用 `'.*\\.\\(ts\\|tsx\\)'`——后者会静默跳过 `.tsx` 文件。",
        ]
      : []),
  ]

  return [
    '执行给定的 bash 命令并返回其输出。',
    '',
    '工作目录会在命令之间保持，但 shell 状态不会。shell 环境从用户的配置文件（bash 或 zsh）初始化。',
    '',
    `重要事项：除非有明确指示，或已验证专门的工具无法完成你的任务，否则避免使用本工具运行 ${avoidCommands} 命令。应改用更适合的专门工具，这样能提供更好的用户体验：`,
    '',
    ...prependBullets(toolPreferenceItems),
    `虽然 ${BASH_TOOL_NAME} 工具也能做类似的事，但最好还是使用内置工具，因为它们能提供更好的用户体验，也更容易审核工具调用和授予权限。`,
    '',
    '# 使用说明',
    ...prependBullets(instructionItems),
    getSimpleSandboxSection(),
    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
  ].join('\n')
}
