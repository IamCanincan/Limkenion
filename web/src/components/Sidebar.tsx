import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, UsageStats } from '../types'

interface Props {
  sessions: SessionInfo[]
  activeSessionId: string | null
  stats: UsageStats | null
  onSelect: (id: string) => void
  onNew: () => void
  /** 打开"在 worktree 里新建"对话框（选分支）。 */
  onNewWorktree: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onExport: (id: string) => void
  /** 分叉会话（对应 CLI 的 /branch）。 */
  onFork: (id: string, title?: string) => void
  onOpenTeam: () => void
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export function Sidebar({
  sessions,
  activeSessionId,
  stats,
  onSelect,
  onNew,
  onNewWorktree,
  onOpenTeam,
  onRename,
  onDelete,
  onExport,
  onFork,
}: Props) {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // 会话搜索：CLI 的 /resume <关键词> 能按标题过滤，web 侧栏原来只能滚。
  const [query, setQuery] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const q = query.trim().toLowerCase()
  const visible = q
    ? sorted.filter(
        s =>
          s.title.toLowerCase().includes(q) ||
          (s.tags ?? []).some(t => t.toLowerCase().includes(q)),
      )
    : sorted

  const startRename = (s: SessionInfo) => {
    setRenaming(s.id)
    setRenameValue(s.title)
    setMenuFor(null)
  }

  const commitRename = () => {
    if (renaming !== null && renameValue.trim()) onRename(renaming, renameValue.trim())
    setRenaming(null)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="brand">Limkenion</span>
        <button className="new-session" onClick={onNew} title="新建会话（当前工作树）">
          ＋
        </button>
        <button className="new-session" onClick={onNewWorktree} title="在指定分支的隔离 worktree 里新建会话">
          ⑂
        </button>
        <button className="new-session" onClick={onOpenTeam} title="Agent Teams 工作台">团队</button>
      </div>
      <div className="session-search">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="搜索会话（标题 / 标签）"
          aria-label="搜索会话"
        />
        {query && (
          <button className="session-search-clear" onClick={() => setQuery('')} title="清除">
            ×
          </button>
        )}
      </div>
      <div className="session-list">
        {sorted.length === 0 && (
          <div className="session-empty">
            暂无会话
            <br />
            点击 ＋ 开始
          </div>
        )}
        {sorted.length > 0 && visible.length === 0 && (
          <div className="session-empty">没有匹配「{query.trim()}」的会话</div>
        )}
        {visible.map(s =>
          renaming === s.id ? (
            <div key={s.id} className="session-rename">
              <input
                autoFocus
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={commitRename}
              />
            </div>
          ) : (
            <div
              key={s.id}
              className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="session-title" title={s.title}>
                {s.planMode && <span className="session-badge" title="计划模式">计划</span>}
                {s.title}
              </span>
              <span className="session-meta">
                {formatTime(s.updatedAt)} · {s.messageCount} 条
                {s.tags && s.tags.length > 0 && <span className="session-tags"> #{s.tags.join(' #')}</span>}
              </span>
              <button
                className="session-menu-btn"
                title="会话操作"
                onClick={e => {
                  e.stopPropagation()
                  setMenuFor(menuFor === s.id ? null : s.id)
                }}
              >
                ⋯
              </button>
              {menuFor === s.id && (
                <div className="session-menu" ref={menuRef} onClick={e => e.stopPropagation()}>
                  <button onClick={() => startRename(s)}>重命名</button>
                  <button onClick={() => { setMenuFor(null); onFork(s.id) }}>分叉（/branch）</button>
                  <button onClick={() => { setMenuFor(null); onExport(s.id) }}>导出 Markdown</button>
                  <button className="danger" onClick={() => { setMenuFor(null); onDelete(s.id) }}>
                    删除
                  </button>
                </div>
              )}
            </div>
          ),
        )}
      </div>
      {stats && (
        <div className="sidebar-stats" title="用量统计（/cost）">
          <div className="stats-row">
            <span>Tokens</span>
            <span>↑{stats.total.inputTokens} ↓{stats.total.outputTokens}</span>
          </div>
          <div className="stats-row">
            <span>回合 / 工具</span>
            <span>{stats.turnCount} / {stats.toolCallCount}</span>
          </div>
          <div className="stats-row">
            <span>运行时长</span>
            <span>{formatUptime(stats.uptimeMs)}</span>
          </div>
        </div>
      )}
    </aside>
  )
}
