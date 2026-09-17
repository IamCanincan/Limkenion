import type { Command } from '../commands.js'
import { getAttributionTexts } from '../utils/attribution.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import { getUndercoverInstructions, isUndercover } from '../utils/undercover.js'

const ALLOWED_TOOLS = [
  'Bash(git add:*)',
  'Bash(git status:*)',
  'Bash(git commit:*)',
]

function getPromptContent(): string {
  const { commit: commitAttribution } = getAttributionTexts()

  let prefix = ''
  

  return `${prefix}## 上下文

- 当前 git 状态：!\`git status\`
- 当前 git diff（已暂存与未暂存的更改）：!\`git diff HEAD\`
- 当前分支：!\`git branch --show-current\`
- 最近的提交：!\`git log --oneline -10\`

## Git 安全协议

- 永远不要更新 git config
- 除非用户明确要求，否则永远不要跳过 hooks（--no-verify、--no-gpg-sign 等）
- 关键：始终创建新提交。除非用户明确要求，否则永远不要使用 git commit --amend
- 不要提交可能包含机密（.env、credentials.json 等）的文件。如果用户特别要求提交这些文件，请提醒他们
- 如果没有要提交的更改（即没有未跟踪文件，也没有修改），不要创建空提交
- 永远不要使用带 -i 标志的 git 命令（如 git rebase -i 或 git add -i），因为它们需要交互输入，而这是不支持的

## 你的任务

基于以上更改，创建一次 git 提交：

1. 分析所有已暂存的更改并起草提交消息：
   - 参考上面的最近提交，以遵循该仓库的提交消息风格
   - 概括更改的性质（新功能、增强、缺陷修复、重构、测试、文档等）
   - 确保消息准确反映更改及其目的（例如 "add" 表示全新功能，"update" 表示对既有功能的增强，"fix" 表示缺陷修复等）
   - 起草一条专注于"为什么"而非"是什么"的简洁（1-2 句）提交消息

2. 暂存相关文件并使用 HEREDOC 语法创建提交：
\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.${commitAttribution ? `\n\n${commitAttribution}` : ''}
EOF
)"
\`\`\`

你有能力在一次回复中调用多个工具。在单条消息中暂存并创建提交。不要使用任何其他工具，也不要做任何其他事情。除了这些工具调用外，不要发送任何其他文本或消息。`
}

const command = {
  type: 'prompt',
  name: 'commit',
  description: '创建一次 Git 提交',
  allowedTools: ALLOWED_TOOLS,
  contentLength: 0, // 动态内容
  progressMessage: '正在创建提交',
  source: 'builtin',
  async getPromptForCommand(_args, context) {
    const promptContent = getPromptContent()
    const finalContent = await executeShellCommandsInPrompt(
      promptContent,
      {
        ...context,
        getAppState() {
          const appState = context.getAppState()
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                command: ALLOWED_TOOLS,
              },
            },
          }
        },
      },
      '/commit',
    )

    return [{ type: 'text', text: finalContent }]
  },
} satisfies Command

export default command
