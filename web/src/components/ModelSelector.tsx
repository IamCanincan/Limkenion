import { useEffect, useRef, useState } from 'react'
import type { ModelInfo } from '../types'

interface Props {
  models: ModelInfo[]
  current: string
  onSelect: (value: string) => void
}

/** 模型选择器 —— CLI 中 /model 命令的 web 对应物。 */
export function ModelSelector({ models, current, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const currentModel = models.find(m => m.value === current)
  const label = currentModel?.label ?? current

  return (
    <div className="model-selector" ref={ref}>
      <button className="model-selector-btn" onClick={() => setOpen(o => !o)} title="切换模型（/model）">
        <span className="model-dot" />
        {label}
        <span className="model-caret">▾</span>
      </button>
      {open && (
        <div className="model-menu">
          {models.map(m => (
            <button
              key={m.value}
              className={`model-item ${m.value === current ? 'active' : ''}`}
              onClick={() => {
                onSelect(m.value)
                setOpen(false)
              }}
            >
              <span className="model-item-label">{m.label}</span>
              <span className="model-item-desc">{m.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
