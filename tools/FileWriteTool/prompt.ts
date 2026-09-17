import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export const FILE_WRITE_TOOL_NAME = 'Write'
export const DESCRIPTION = '将文件写入本地文件系统。'

function getPreReadInstruction(): string {
  return `\n- 如果是已存在的文件，你必须先使用 ${FILE_READ_TOOL_NAME} 工具读取其内容。若未先读取文件，此工具会失败。`
}

export function getWriteToolDescription(): string {
  return `将文件写入本地文件系统。

用法：
- 如果提供路径处已有文件，此工具将覆盖之。${getPreReadInstruction()}
- 修改已存在的文件请优先使用 Edit 工具 \u2014 它只发送差异。仅当创建新文件或完全重写时才使用此工具。
- 除非用户明确要求，绝不要创建文档文件（*.md）或 README 文件。
- 仅当用户明确提出时使用 emoji。除非被要求，不要往文件里写入 emoji。`
}
