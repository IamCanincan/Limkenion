import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommandInfo } from '../types'

interface Props {
  commands: CommandInfo[]
  /** Current "/" input, e.g. "/mo" or "/model sonnet". */
  query: string
  /** Complete the command into the input (Tab / Enter-with-args). */
  onSelect: (command: CommandInfo) => void
  /** Complete and immediately run the command (Enter). */
  onRun: (command: CommandInfo) => void
  onClose: () => void
}

/**
 * Slash command palette — mirrors the CLI's slash-command completion:
 * typing "/" in the composer opens a filtered list; ↑↓ to navigate,
 * Enter/Tab to complete, Esc to dismiss.
 */
export function CommandPalette({ commands, query, onSelect, onRun, onClose }: Props) {
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const term = query.replace(/^\//, '').split(/\s+/)[0] ?? ''
  const filtered = useMemo(() => {
    const t = term.toLowerCase()
    if (t.length === 0) return commands
    return commands.filter(
      c =>
        c.name.toLowerCase().includes(t) ||
        c.aliases.some(a => a.toLowerCase().includes(t)),
    )
  }, [commands, term])

  // Reset selection whenever the filter changes.
  useEffect(() => {
    setIndex(0)
  }, [term])

  // Keep the selected item in view.
  useEffect(() => {
    listRef.current
      ?.querySelectorAll('[data-selected="true"]')[0]
      ?.scrollIntoView({ block: 'nearest' })
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
      } else if (e.key === 'Tab') {
        e.preventDefault()
        onSelect(filtered[index] ?? filtered[0])
      } else if (e.key === 'Enter') {
        e.preventDefault()
        // 带参数提示的命令先补全让用户补参数；无参命令直接执行。
        const cmd = filtered[index] ?? filtered[0]
        if (cmd.argumentHint) onSelect(cmd)
        else onRun(cmd)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [filtered, index, onSelect, onRun, onClose])

  if (filtered.length === 0) {
    return (
      <div className="command-palette">
        <div className="command-palette-empty">没有匹配「/{term}」的命令</div>
      </div>
    )
  }

  return (
    <div className="command-palette" ref={listRef}>
      {filtered.map((c, i) => (
        <button
          key={c.name}
          className="command-item"
          data-selected={i === index}
          onMouseEnter={() => setIndex(i)}
          onClick={() => onSelect(c)}
        >
          <span className="command-name">/{c.name}</span>
          {c.argumentHint && <span className="command-arg">{c.argumentHint}</span>}
          <span className="command-desc" title={c.description}>
            {c.description}
          </span>
          {c.aliases.length > 0 && (
            <span className="command-aliases">{c.aliases.map(a => '/' + a).join(' ')}</span>
          )}
        </button>
      ))}
      <div className="command-palette-hint">↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭</div>
    </div>
  )
}
