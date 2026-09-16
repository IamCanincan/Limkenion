import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  /** 工作区内的候选文件（相对路径，POSIX 分隔符）。 */
  files: string[]
  /** "@" 之后已输入的内容。 */
  query: string
  /** 选中某个文件后把它插入输入框。 */
  onSelect: (path: string) => void
  onClose: () => void
}

/**
 * @ 文件引用补全 —— 对齐 CLI 的 @ 提及：输入 @ 后按路径片段过滤工作区文件，
 * ↑↓ 选择、Tab/Enter 补全、Esc 关闭。
 */
export function FileMentionPalette({ files, query, onSelect, onClose }: Props) {
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const t = query.toLowerCase()
    if (t.length === 0) return files.slice(0, 12)
    const scored = files
      .map(f => {
        const lower = f.toLowerCase()
        const base = lower.split('/').pop() ?? lower
        if (lower.startsWith(t)) return { f, s: 0 }
        if (base.startsWith(t)) return { f, s: 1 }
        if (base.includes(t)) return { f, s: 2 }
        if (lower.includes(t)) return { f, s: 3 }
        return null
      })
      .filter((x): x is { f: string; s: number } => x !== null)
      .sort((a, b) => a.s - b.s || a.f.length - b.f.length)
    return scored.slice(0, 12).map(x => x.f)
  }, [files, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelectorAll('[data-selected="true"]')[0]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (filtered.length === 0) {
        if (e.key === 'Escape') onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex(i => (i + 1) % filtered.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex(i => (i - 1 + filtered.length) % filtered.length)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        onSelect(filtered[index] ?? filtered[0])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [filtered, index, onSelect, onClose])

  if (files.length === 0) {
    return (
      <div className="command-palette">
        <div className="command-palette-empty">工作区文件索引为空（服务端尚未返回列表）</div>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="command-palette">
        <div className="command-palette-empty">没有匹配「@{query}」的文件</div>
      </div>
    )
  }

  return (
    <div className="command-palette" ref={listRef}>
      {filtered.map((f, i) => {
        const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : ''
        const base = f.slice(dir.length)
        return (
          <button
            key={f}
            className="command-item"
            data-selected={i === index}
            onMouseEnter={() => setIndex(i)}
            onClick={() => onSelect(f)}
          >
            <span className="command-name">@{base}</span>
            <span className="command-desc">{dir}</span>
          </button>
        )
      })}
      <div className="command-palette-hint">↑↓ 选择 · Tab/Enter 引用 · Esc 关闭</div>
    </div>
  )
}
