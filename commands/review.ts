import type { ContentBlockParam } from '../types/llm-protocol.js'
import type { Command } from '../commands.js'
import { isUltrareviewEnabled } from './review/ultrareviewEnabled.js'

// 法务希望在用户触发前先看到明确的表面名称加上文档链接，
// 因此描述中带有 "Limkenion on the web" 和 URL。
const CCR_TERMS_URL = ''

const LOCAL_REVIEW_PROMPT = (args: string) => `
      你是一名资深代码审查者。按以下步骤操作：

      1. 如果 args 中未提供 PR 编号，运行 \`gh pr list\` 显示开放的 PR
      2. 如果提供了 PR 编号，运行 \`gh pr view <number>\` 获取 PR 详情
      3. 运行 \`gh pr diff <number>\` 获取 diff
      4. 分析改动并提供一次全面的代码审查，内容包括：
         - 该 PR 做了什么的总览
         - 代码质量与风格的评估
         - 具体的改进建议
         - 任何潜在问题或风险

      让你的审查简明但全面。聚焦于：
      - 代码正确性
      - 遵循项目约定
      - 性能影响
      - 测试覆盖
      - 安全考量

      用清晰的分段和要点来格式化你的审查。

      PR 编号：${args}
    `

const review: Command = {
  type: 'prompt',
  name: 'review',
  description: '审查拉取请求（PR）',
  progressMessage: '正在审查拉取请求',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: LOCAL_REVIEW_PROMPT(args) }]
  },
}

// /ultrareview 是进入远程 bughunter 路径的唯一入口——
// /review 始终保持在本地。local-jsx 类型会在免费审查耗尽时
// 渲染超额权限对话框。
const ultrareview: Command = {
  type: 'local-jsx',
  name: 'ultrareview',
  description: `约 10–20 分钟 · 查找并验证你分支中的缺陷。在 Limkenion on the web 上运行。参见 ${CCR_TERMS_URL}`,
  isEnabled: () => isUltrareviewEnabled(),
  load: () => import('./review/ultrareviewCommand.js'),
}

export default review
export { ultrareview }
