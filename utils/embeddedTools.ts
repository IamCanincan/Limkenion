import { isEnvTruthy } from './envUtils.js'

/**
 * 此构建是否在 bun 二进制中内嵌了 bfs/ugrep（仅 ant-native）。
 *
 * 为 true 时：
 * - Limkenion 的 Bash shell 中的 `find` 和 `grep` 由 shell 函数遮蔽，
 *   这些函数以 argv0='bfs' / argv0='ugrep' 调用 bun 二进制（与内嵌
 *   ripgrep 相同的技巧）
 * - 专门的 Glob/Grep 工具会从工具注册表中移除
 * - 指引 Limkenion 避开 find/grep 的提示指引会被省略
 *
 * 在 scripts/build-with-plugins.ts 中作为构建时 define 为 ant-native 构建设置。
 */
export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  const e = process.env.LIMKENION_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * 包含内嵌搜索工具的 bun 二进制的路径。
 * 仅当 hasEmbeddedSearchTools() 为 true 时才有意义。
 */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
