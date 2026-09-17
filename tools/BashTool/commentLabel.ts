/**
 * 如果 bash 命令的第一行是 `# comment`（而非 `#!` shebang），
 * 返回去除 `#` 前缀后的注释文本。否则返回 undefined。
 *
 * 在整屏模式下，这就是非冗长的工具使用标签以及折叠组 ⎿ 提示——
 * 它是 Limkenion 写给人读的内容。
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  return firstLine.replace(/^#+\s*/, '') || undefined
}
