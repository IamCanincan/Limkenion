/**
 * 工作目录（worktree）模式现在对所有用户无条件启用。
 *
 * 此前由 GrowthBook 标志 'limkenion_worktree_mode' 控制，但
 * CACHED_MAY_BE_STALE 模式在首次启动时、缓存填充前会返回默认值（false），
 * 从而静默吞掉 --worktree。参见 。
 */
export function isWorktreeModeEnabled(): boolean {
  return true
}
