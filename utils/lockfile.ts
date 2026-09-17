/**
 * proper-lockfile 的懒访问器。
 *
 * proper-lockfile 依赖 graceful-fs，而 graceful-fs 在首次 require 时会
 * 猴子补丁每个 fs 方法（约 8ms）。静态导入 proper-lockfile 会把这笔开销
 * 拉进启动路径，即使根本没有加锁（例如 `--help`）。
 *
 * 请导入本模块代替直接导入 `proper-lockfile`。底层包仅在某个加锁函数首次
 * 真正被调用时才加载。
 */

import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'

type Lockfile = typeof import('proper-lockfile')

let _lockfile: Lockfile | undefined

function getLockfile(): Lockfile {
  if (!_lockfile) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _lockfile = require('proper-lockfile') as Lockfile
  }
  return _lockfile
}

export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options)
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options)
}
