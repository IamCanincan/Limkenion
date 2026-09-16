import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, UsageStats } from '../types'

interface Props {
  sessions: SessionInfo[]
  activeSessionId: string | null
  stats: UsageStats | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onExport: (id: string) => void
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
  onRename,
  onDelete,
  onExport,
}: Props) {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

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
        <button className="new-session" onClick={onNew} title="新建会话">
          ＋
        </button>
      </div>
      <div className="session-list">
        {sorted.length === 0 && (
          <div className="session-empty">
            暂无会话
            <br />
            点击 ＋ 开始
          </div>
        )}
        {sorted.map(s =>
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
