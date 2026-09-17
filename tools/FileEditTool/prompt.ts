import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

function getPreReadInstruction(): string {
  return `\n- 在编辑之前，你必须在会话中至少使用一次 \`${FILE_READ_TOOL_NAME}\` 工具。若未先读取文件就尝试编辑，该工具会报错。 `
}

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  const prefixFormat = isCompactLinePrefixEnabled()
    ? '行号 + 制表符'
    : '空格 + 行号 + 箭头'
  const minimalUniquenessHint =
    ''
  return `在文件中执行精确的字符串替换。

用法：${getPreReadInstruction()}
- 从 Read 工具输出中编辑文本时，确保保留“行号前缀之后”出现的精确缩进（制表符/空格）。行号前缀格式为：${prefixFormat}。其后才是真正的文件内容，用于匹配。绝对不要把行号前缀的任何部分包含在 old_string 或 new_string 中。
- 优先编辑代码库中已有的文件。除非确有需要，否则绝不写新文件。
- 仅当用户明确提出时使用 emoji。除非被要求，不要往文件里加入 emoji。
- 如果 \`old_string\` 在文件中不唯一，编辑将失败。要么提供更大、上下文更丰富的字符串使其唯一，要么使用 \`replace_all\` 替换 \`old_string\` 的每一处实例。${minimalUniquenessHint}
- 用 \`replace_all\` 在文件中替换和重命名字符串。比如要重命名某个变量时，这个参数很有用。`
}
