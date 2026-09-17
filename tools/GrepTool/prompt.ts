import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
  return `基于 ripgrep 的强大搜索工具

  用法：
  - 搜索任务始终使用 ${GREP_TOOL_NAME}。绝不要将 \`grep\` 或 \`rg\` 作为 ${BASH_TOOL_NAME} 命令调用。${GREP_TOOL_NAME} 工具已针对正确的权限和访问进行了优化。
  - 支持完整的正则表达式语法（例如 "log.*Error"、"function\\s+\\w+"）
  - 使用 glob 参数（例如 "*.js"、"**/*.tsx"）或 type 参数（例如 "js"、"py"、"rust"）过滤文件
  - 输出模式："content" 显示匹配行，"files_with_matches" 仅显示文件路径（默认），"count" 显示匹配计数
  - 需要多轮搜索的开放式搜索请使用 ${AGENT_TOOL_NAME} 工具
  - 模式语法：使用 ripgrep（而非 grep）——字面量花括号需要转义（用 \`interface\\{\\}\` 可在 Go 代码中找到 \`interface{}\`）
  - 多行匹配：默认情况下模式仅在单行内匹配。对于跨行的模式（如 \`struct \\{[\\s\\S]*?field\`），请使用 \`multiline: true\`
`
}
