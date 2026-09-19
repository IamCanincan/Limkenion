import { useState } from 'react'

interface Props {
  /** 已有分支（用于补全；不是 git 仓库时为空）。 */
  branches: string[]
  onCreate: (branch: string, worktreeName: string) => void
  onCancel: () => void
}

/**
 * 在**指定分支的隔离 worktree** 里开一个新会话。
 *
 * 刻意不提供"选分支但用当前工作树"这一项：那等于偷偷 checkout 你的工作树，
 * 会把没提交的改动搅在一起。要分支就走隔离 worktree —— 这是唯一安全的形式。
 */
export function NewSessionDialog({ branches, onCreate, onCancel }: Props) {
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')

  const submit = () => {
    const b = branch.trim()
    if (!b) return
    onCreate(b, name.trim())
  }

  return (
    <div className="nsd-panel">
      <div className="nsd-header">
        <strong>在 worktree 里新建会话</strong>
        <button className="mcp-btn" onClick={onCancel}>
          取消
        </button>
      </div>

      <label className="nsd-label">
        分支（已存在则检出，不存在则以当前 HEAD 新建）
        <input
          list="nsd-branches"
          value={branch}
          onChange={e => setBranch(e.target.value)}
          placeholder="feature/xxx"
          autoFocus
        />
        <datalist id="nsd-branches">
          {branches.map(b => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </label>

      <label className="nsd-label">
        worktree 目录名（可留空，自动随机）
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="留空自动命名"
        />
      </label>

      <div className="nsd-note">
        新会话的沙箱根会切到这个 worktree —— 原目录不再可访问，这是隔离的本意。
        <br />
        未受版本控制的目录（如 node_modules）不会被带过来，跑构建前可能要装依赖。
      </div>

      <div className="nsd-actions">
        <button className="mcp-btn primary" onClick={submit} disabled={!branch.trim()}>
          创建
        </button>
        <button className="mcp-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
