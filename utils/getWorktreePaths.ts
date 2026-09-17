import { sep } from 'path'
import { logEvent } from '../services/analytics/index.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'

/**
 * 返回当前 git 仓库所有 worktree 的路径。
 * 若 git 不可用、不在 git 仓库中，或只有一个 worktree，
 * 则返回空数组。
 *
 * 此版本包含分析跟踪，并使用 CLI 的 gitExe() 解析器。想要不依赖 CLI 的
 * 可移植版本，请使用 getWorktreePathsPortable()。
 *
 * @param cwd 运行命令的目录
 * @returns worktree 绝对路径数组
 */
export async function getWorktreePaths(cwd: string): Promise<string[]> {
  const startTime = Date.now()

  const { stdout, code } = await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'list', '--porcelain'],
    {
      cwd,
      preserveOutputOnError: false,
    },
  )

  const durationMs = Date.now() - startTime

  if (code !== 0) {
    logEvent('limkenion_worktree_detection', {
      duration_ms: durationMs,
      worktree_count: 0,
      success: false,
    })
    return []
  }

  // 解析 porcelain 输出——以 "worktree " 开头的行包含路径
  // 例如：
  // worktree /Users/foo/repo
  // HEAD abc123
  // branch refs/heads/main
  //
  // worktree /Users/foo/repo-wt1
  // HEAD def456
  // branch refs/heads/feature
  const worktreePaths = stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).normalize('NFC'))

  logEvent('limkenion_worktree_detection', {
    duration_ms: durationMs,
    worktree_count: worktreePaths.length,
    success: true,
  })

  // 对 worktree 排序：当前 worktree 在前，然后按字母序
  const currentWorktree = worktreePaths.find(
    path => cwd === path || cwd.startsWith(path + sep),
  )
  const otherWorktrees = worktreePaths
    .filter(path => path !== currentWorktree)
    .sort((a, b) => a.localeCompare(b))

  return currentWorktree ? [currentWorktree, ...otherWorktrees] : otherWorktrees
}
