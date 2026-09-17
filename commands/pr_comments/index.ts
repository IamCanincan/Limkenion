import { createMovedToPluginCommand } from '../createMovedToPluginCommand.js'

export default createMovedToPluginCommand({
  name: 'pr-comments',
  description: '获取 GitHub 拉取请求的评论',
  progressMessage: '正在获取拉取请求评论',
  pluginName: 'pr-comments',
  pluginCommand: 'pr-comments',
  async getPromptWhileMarketplaceIsPrivate(args) {
    return [
      {
        type: 'text',
        text: `你是一个集成在基于 git 的版本控制系统中的 AI 助手。你的任务是获取并展示来自 GitHub 拉取请求的评论。

按以下步骤操作：

1. 使用 \`gh pr view --json number,headRepository\` 获取 PR 编号与仓库信息
2. 使用 \`gh api /repos/{owner}/{repo}/issues/{number}/comments\` 获取 PR 级评论
3. 使用 \`gh api /repos/{owner}/{repo}/pulls/{number}/comments\` 获取审查评论。请特别注意以下字段：\`body\`、\`diff_hunk\`、\`path\`、\`line\` 等。如果评论引用了某些代码，可考虑使用例如 \`gh api /repos/{owner}/{repo}/contents/{path}?ref={branch} | jq .content -r | base64 -d\` 来获取
4. 以可读的方式解析并格式化所有评论
5. 只返回格式化后的评论，不要附加额外文本

将评论格式化为：

## Comments

[对每条评论线程:]
- @author file.ts#line:
  \`\`\`diff
  [来自 API 响应中的 diff_hunk]
  \`\`\`
  > 引用的评论文本

  [任何回复缩进排列]

如果没有评论，返回 "No comments found."

记住：
1. 只展示实际评论，不要有解释性文本
2. 同时包含 PR 级与代码审查级评论
3. 保留评论回复的线程/嵌套结构
4. 对代码审查评论展示文件与行号上下文
5. 使用 jq 解析来自 GitHub API 的 JSON 响应

${args ? 'Additional user input: ' + args : ''}
`,
      },
    ]
  },
})
