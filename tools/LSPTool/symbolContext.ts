import { logForDebugging } from '../../utils/debug.js'
import { truncate } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { expandPath } from '../../utils/path.js'

const MAX_READ_BYTES = 64 * 1024

/**
 * 提取文件中指定位置的符号/单词。
 * 用于在工具使用消息中展示上下文。
 *
 * @param filePath - 文件路径（绝对或相对）
 * @param line - 从 0 开始的行号
 * @param character - 该行中从 0 开始的字符位置
 *
 * 注意: 这里使用同步文件 I/O，因为它是从 renderToolUseMessage（一个同步的
 * React 渲染函数）中调用的。读取被 try/catch 包裹，因此 ENOENT 等错误会优雅地回退。
 * @returns 该位置的符号，若提取失败则返回 null
 */
export function getSymbolAtPosition(
  filePath: string,
  line: number,
  character: number,
): string | null {
  try {
    const fs = getFsImplementation()
    const absolutePath = expandPath(filePath)

    // 只读取前 64KB 而不是整个文件。大多数 LSP hover/goto
    // 目标都靠近最近的编辑；64KB 大约覆盖典型代码的 1000 行。
    // 若目标行超出此窗口，则回退为 null（UI 已通过展示 `position: line:char` 处理）。
    // eslint-disable-next-line custom-rules/no-sync-fs -- 从同步的 React 渲染中调用（renderToolUseMessage）
    const { buffer, bytesRead } = fs.readSync(absolutePath, {
      length: MAX_READ_BYTES,
    })
    const content = buffer.toString('utf-8', 0, bytesRead)
    const lines = content.split('\n')

    if (line < 0 || line >= lines.length) {
      return null
    }
    // 若缓冲区被填满，说明文件在我们窗口之外仍有内容，
    // 因此最后一个被分割的元素可能在被截断的行中间。
    if (bytesRead === MAX_READ_BYTES && line === lines.length - 1) {
      return null
    }

    const lineContent = lines[line]
    if (!lineContent || character < 0 || character >= lineContent.length) {
      return null
    }

    // 提取字符位置处的单词/符号
    // 模式匹配:
    // - 标准标识符: 字母数字 + 下划线 + 美元符
    // - Rust 生命周期: 'a, 'static
    // - Rust 宏: macro_name!
    // - 运算符和特殊符号: +, -, *, 等
    // 这样更包容，以便处理各种编程语言
    const symbolPattern = /[\w$'!]+|[+\-*/%&|^~<>=]+/g
    let match: RegExpExecArray | null

    while ((match = symbolPattern.exec(lineContent)) !== null) {
      const start = match.index
      const end = start + match[0].length

      // 检查字符位置是否落在此匹配范围内
      if (character >= start && character < end) {
        const symbol = match[0]
        // 将长度限制为 30 个字符，避免符号过长
        return truncate(symbol, 30)
      }
    }

    return null
  } catch (error) {
    // 记录意外错误用于调试（权限问题、编码问题等）
    // 使用 logForDebugging，因为这是显示增强，不是关键错误
    if (error instanceof Error) {
      logForDebugging(
        `符号提取失败 ${filePath}:${line}:${character}: ${error.message}`,
        { level: 'warn' },
      )
    }
    // 仍返回 null，以便优雅地回退到位置显示
    return null
  }
}
