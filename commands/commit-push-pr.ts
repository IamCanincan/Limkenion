import type { Command } from '../commands.js'
import {
  getAttributionTexts,
  getEnhancedPRAttribution,
} from '../utils/attribution.js'
import { getDefaultBranch } from '../utils/git.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import { getUndercoverInstructions, isUndercover } from '../utils/undercover.js'

const ALLOWED_TOOLS = [
  'Bash(git checkout --branch:*)',
  'Bash(git checkout -b:*)',
  'Bash(git add:*)',
  'Bash(git status:*)',
  'Bash(git push:*)',
  'Bash(git commit:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr merge:*)',
  'ToolSearch',
  'mcp__slack__send_message',
  'mcp__limkenion_ai_Slack__slack_send_message',
]

function getPromptContent(
  defaultBranch: string,
  prAttribution?: string,
): string {
  const { commit: commitAttribution, pr: defaultPrAttribution } =
    getAttributionTexts()
  // 使用提供的 PR 署名，否则回退到默认值
  const effectivePrAttribution = prAttribution ?? defaultPrAttribution
  const safeUser = process.env.SAFEUSER || ''
  const username = process.env.USER || ''

  let prefix = ''
  let reviewerArg = ' and `--reviewer limkenions/limkenion`'
  let addReviewerArg = ' (and add `--add-reviewer limkenions/limkenion`)'
  let changelogSection = `

## Changelog
<!-- CHANGELOG:START -->
[If this PR contains user-facing changes, add a changelog entry here. Otherwise, remove this section.]
<!-- CHANGELOG:END -->`
  let slackStep = `

5. 创建/更新 PR 之后，检查用户的 LIMKENION.md 是否提及要向 Slack 频道发帖。如果提及，用 ToolSearch 搜索 "slack send message" 相关工具。如果 ToolSearch 找到 Slack 工具，询问用户是否希望你将 PR 链接发布到相关 Slack 频道。只有用户确认后才发布。如果 ToolSearch 无结果或报错，则静默跳过此步骤——不要提及失败，不要尝试变通方案，也不要尝试其他替代做法。`
  

  return `${prefix}## Context

- \`SAFEUSER\`: ${safeUser}
- \`whoami\`: ${username}
- \`git status\`: !\`git status\`
- \`git diff HEAD\`: !\`git diff HEAD\`
- \`git branch --show-current\`: !\`git branch --show-current\`
- \`git diff ${defaultBranch}...HEAD\`: !\`git diff ${defaultBranch}...HEAD\`
- \`gh pr view --json number 2>/dev/null || true\`: !\`gh pr view --json number 2>/dev/null || true\`

## Git 安全协议

- 绝不更新 git 配置
- 除非用户明确要求，绝不运行破坏性/不可逆的 git 命令（如 push --force、hard reset 等）
- 除非用户明确要求，绝不跳过钩子（--no-verify、--no-gpg-sign 等）
- 绝不 force push 到 main/master，如果用户要求请在执行前警告他
- 不要提交可能包含机密文件的文件（.env、credentials.json 等）
- 绝不使用带 -i 标志的 git 命令（如 git rebase -i 或 git add -i），因为它们需要交互式输入，而交互式输入不受支持

## 你的任务

分析将要纳入该拉取请求的所有更改，确保查看所有相关提交（不仅仅是最近一次提交，而是上面 git diff ${defaultBranch}...HEAD 输出中会纳入该 PR 的全部提交）。

根据上述更改：
1. 若当前位于 ${defaultBranch} 则新建分支（分支名前缀使用上文的 SAFEUSER，若 SAFEUSER 为空则回退到 whoami，例如 \`username/feature-name\`）
2. 使用 heredoc 语法创建一条提交，消息内容恰当${commitAttribution ? `，以下面示例中展示的署名文本结尾` : ''}：
\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.${commitAttribution ? `\n\n${commitAttribution}` : ''}
EOF
)"
\`\`\`
3. 将分支推送到 origin
4. 如果该分支已经存在 PR（检查上面的 gh pr view 输出），使用 \`gh pr edit\` 更新 PR 标题和正文，使其匹配当前 diff${addReviewerArg}。否则使用 heredoc 语法 + \`gh pr create\` 创建拉取请求${reviewerArg}。
   - 重要：保持 PR 标题简短（不超过 70 字符）。详细信息放在正文中。
\`\`\`
gh pr create --title "Short, descriptive title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]${changelogSection}${effectivePrAttribution ? `\n\n${effectivePrAttribution}` : ''}
EOF
)"
\`\`\`

你有能力在一条响应中调用多个工具。你必须在单条消息中完成上述全部操作。${slackStep}

完成后返回 PR 链接，这样用户就能看到它。`
}

const command = {
  type: 'prompt',
  name: 'commit-push-pr',
  description: '提交、推送并打开拉取请求（PR）',
  allowedTools: ALLOWED_TOOLS,
  get contentLength() {
    // 用一个伪分支名估算内容长度
    return getPromptContent('main').length
  },
  progressMessage: 'creating commit and PR',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    // 获取默认分支与增强的 PR 署名
    const [defaultBranch, prAttribution] = await Promise.all([
      getDefaultBranch(),
      getEnhancedPRAttribution(context.getAppState),
    ])
    let promptContent = getPromptContent(defaultBranch, prAttribution)

    // 若提供了参数则附加用户指令
    const trimmedArgs = args?.trim()
    if (trimmedArgs) {
      promptContent += `\n\n## Additional instructions from user\n\n${trimmedArgs}`
    }

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
      '/commit-push-pr',
    )

    return [{ type: 'text', text: finalContent }]
  },
} satisfies Command

export default command
