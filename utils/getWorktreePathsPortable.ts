import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFileCb)

/**
 * 仅使用 child_process 的可移植 worktree 检测——无需分析、无引导依赖、
 * 无需 execa。用于 listSessionsImpl.ts（SDK）以及任何需要 worktree 路径
 * 却不想拉入 CLI 依赖链（execa → cross-spawn → which）的场所。
 */
export async function getWorktreePathsPortable(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd, timeout: 5000 },
    )
    if (!stdout) return []
    return stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).normalize('NFC'))
  } catch {
    return []
  }
}
