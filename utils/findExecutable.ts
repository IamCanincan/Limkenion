import { whichSync } from './which.js'

/**
 * 通过搜索 PATH 查找可执行文件，类似于 `which`。
 * 取代 spawn-rx 的 findActualExecutable，以避免引入 rxjs（约 313 KB）。
 *
 * 返回 { cmd, args } 以匹配 spawn-rx 的 API 形状。
 * `cmd` 找到时为解析后的路径，否则为原始名称。
 * `args` 始终是对传入 args 的透传。
 */
export function findExecutable(
  exe: string,
  args: string[],
): { cmd: string; args: string[] } {
  const resolved = whichSync(exe)
  return { cmd: resolved ?? exe, args }
}
