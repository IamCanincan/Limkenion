import { isPDFSupported } from '../../utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// 使用字符串常量作为工具名，以避免循环依赖
export const FILE_READ_TOOL_NAME = 'Read'

export const FILE_UNCHANGED_STUB =
  '文件自上次读取后未发生变化。本对话中此前 Read 工具结果中的内容仍然最新——请参考该内容，而无需重新读取。'

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = '从本地文件系统读取文件。'

export const LINE_FORMAT_INSTRUCTION =
  '- 结果使用 cat -n 格式返回，行号从 1 开始'

export const OFFSET_INSTRUCTION_DEFAULT =
  "- 你可以选择指定行偏移和行数限制（对长文件尤其方便），但建议不提供这些参数以读取整个文件"

export const OFFSET_INSTRUCTION_TARGETED =
  '- 当你已经确定需要文件的哪一部分时，只读取那一部分即可。对较大的文件这可能很重要。'

/**
 * 渲染 Read 工具的提示模板。调用方（FileReadTool）提供
 * 运行时计算好的部分。
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  return `从本地文件系统读取文件。你可以通过此工具直接访问任意文件。
假设此工具能够读取机器上的所有文件。如果用户提供了某个文件的路径，则假定该路径有效。读取不存在的文件也是可以的；此时会返回错误。

用法：
- file_path 参数必须是绝对路径，而非相对路径
- 默认情况下，它从文件开头读取最多 ${MAX_LINES_TO_READ} 行${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- 此工具允许 Limkenion 读取图片（如 PNG、JPG 等）。读取图片文件时，内容会以可视化方式呈现，因为 Limkenion 是多模态大语言模型。${
    isPDFSupported()
      ? '\n- 此工具可以读取 PDF 文件（.pdf）。对于大型 PDF（超过 10 页），你必须提供 pages 参数来读取特定页范围（例如 pages: "1-5"）。在未提供 pages 参数的情况下读取大型 PDF 会失败。每次请求最多 20 页。'
      : ''
  }
- 此工具可以读取 Jupyter 笔记本（.ipynb 文件），并返回包含输出的所有单元格，涵盖代码、文本和可视化内容。
- 此工具只能读取文件，不能读取目录。要读取目录，请通过 ${BASH_TOOL_NAME} 工具使用 ls 命令。
- 你经常会被要求读取截图。如果用户提供了截图的路径，请始终使用此工具查看该路径处的文件。此工具可以与所有临时文件路径配合使用。
- 如果读取的文件存在但内容为空，你将收到系统提醒警告，而非文件内容。`
}
