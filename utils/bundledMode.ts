/**
 * 检测当前运行时是否为 Bun。
 * 在以下情况返回 true：
 * - 通过 `bun` 命令运行 JS 文件
 * - 运行 Bun 编译的独立可执行文件
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * 检测是否为 Bun 编译的独立可执行文件。
 * 检查编译后的二进制中是否存在嵌入文件。
 */
export function isInBundledMode(): boolean {
  return (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  )
}
