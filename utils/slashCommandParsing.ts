/**
 * 解析斜杠命令的集中式工具
 */

export type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}

/**
 * 把斜杠命令输入字符串解析为其组成部分
 *
 * @param input - 原始输入字符串（应以 '/' 开头）
 * @returns 解析出的命令名、参数和 MCP 标志，无效则返回 null
 *
 * @example
 * parseSlashCommand('/search foo bar')
 * // => { commandName: 'search', args: 'foo bar', isMcp: false }
 *
 * @example
 * parseSlashCommand('/mcp:tool (MCP) arg1 arg2')
 * // => { commandName: 'mcp:tool (MCP)', args: 'arg1 arg2', isMcp: true }
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmedInput = input.trim()

  // 检查输入是否以 '/' 开头
  if (!trimmedInput.startsWith('/')) {
    return null
  }

  // 移除前导的 '/' 并按空格切分
  const withoutSlash = trimmedInput.slice(1)
  const words = withoutSlash.split(' ')

  if (!words[0]) {
    return null
  }

  let commandName = words[0]
  let isMcp = false
  let argsStartIndex = 1

  // 检查 MCP 命令（第二个词是 '(MCP)'）
  if (words.length > 1 && words[1] === '(MCP)') {
    commandName = commandName + ' (MCP)'
    isMcp = true
    argsStartIndex = 2
  }

  // 提取参数（命令名之后的所有内容）
  const args = words.slice(argsStartIndex).join(' ')

  return {
    commandName,
    args,
    isMcp,
  }
}
