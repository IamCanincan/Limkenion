import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit } from '../types'

interface Props {
  hits: SearchHit[]
  /** false = 命中数触顶被截断（服务端提前收尾），这里如实提示"不是全部"。 */
  complete: boolean
  truncated: boolean
  /** 查询变化回调（组件内已做防抖，不必调用方再去抖）。 */
  onQuery: (query: string) => void
  onPick: (hit: SearchHit) => void
  onClose: () => void
}

/** 命中项的一行摘要。 */
function hitLabel(hit: SearchHit): { title: string; detail: string } {
  if (hit.kind === 'message') {
    const role = hit.role === 'user' ? '我' : hit.role === 'assistant' ? '助手' : '系统'
    return { title: hit.sessionTitle || hit.sessionId, detail: `${role}：${hit.snippet}` }
  }
  if (hit.kind === 'session') {
    return { title: hit.sessionTitle || hit.sessionId, detail: '会话标题匹配' }
  }
  return { title: hit.path, detail: '文件' }
}

export function SearchPanel({ hits, complete, truncated, onQuery, onPick, onClose }: Props) {
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // 防抖：跨会话搜索要扫全部消息，别每敲一个字就发一次。
  useEffect(() => {
    const t = setTimeout(() => onQuery(q), 150)
    return () => clearTimeout(t)
  }, [q, onQuery])

  const rows = useMemo(() => hits.map(hitLabel), [hits])

  useEffect(() => {
    setIndex(0)
  }, [hits])

  useEffect(() => {
    listRef.current?.querySelectorAll('[data-selected="true"]')[0]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (rows.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex(i => (i + 1) % rows.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex(i => (i - 1 + rows.length) % rows.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const hit = hits[index] ?? hits[0]
        if (hit) onPick(hit)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [rows, hits, index, onPick, onClose])

  const typed = q.trim().length > 0

  return (
    <div className="search-panel">
      <input
        className="search-input"
        autoFocus
        value={q}
        placeholder="搜索全部会话的消息、文件名、会话标题…"
        onChange={e => setQ(e.target.value)}
      />
      <div className="search-results" ref={listRef}>
        {!typed && <div className="search-empty">输入关键词开始搜索（Esc 关闭）</div>}
        {typed && rows.length === 0 && <div className="search-empty">没有匹配「{q.trim()}」</div>}
        {rows.map((r, i) => (
          <div
            key={`${r.title}-${i}`}
            className={`search-row ${i === index ? 'selected' : ''}`}
            data-selected={i === index}
            onMouseEnter={() => setIndex(i)}
            onClick={() => {
              const hit = hits[i]
              if (hit) onPick(hit)
            }}
          >
            <div className="search-row-title">{r.title}</div>
            <div className="search-row-detail">{r.detail}</div>
          </div>
        ))}
      </div>
      <div className="search-footer">
        {truncated || !complete ? '结果已截断，只显示一部分' : `共 ${rows.length} 条`}
        <span className="search-hint">↑↓ 选择 · Enter 跳转 · Esc 关闭</span>
      </div>
    </div>
  )
}
