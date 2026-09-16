import { useEffect, useState } from 'react'
import type { ToolCall } from '../types'
import { DiffView } from './DiffView'

const STATUS_LABEL: Record<ToolCall['status'], string> = {
  running: '运行中',
  done: '完成',
  error: '失败',
}

export function ToolCallItem({
  toolCall,
  defaultOpen = false,
}: {
  toolCall: ToolCall
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (toolCall.status === 'running') setOpen(true)
  }, [toolCall.status])

  return (
    <div className={`tool-call ${toolCall.status}`}>
      <button className="tool-call-header" onClick={() => setOpen(o => !o)}>
        <span className={`chevron ${open ? 'open' : ''}`}>▸</span>
        <span className="tool-name">{toolCall.name}</span>
        <span className="tool-input" title={toolCall.input}>
          {toolCall.input}
        </span>
        <span className={`tool-status ${toolCall.status}`}>
          {toolCall.status === 'running' ? (
            <span className="spinner inline" />
          ) : (
            STATUS_LABEL[toolCall.status]
          )}
          {toolCall.durationMs !== undefined && toolCall.status !== 'running' && (
            <span className="tool-duration"> {Math.round(toolCall.durationMs)}ms</span>
          )}
        </span>
      </button>
      {open && (
        <div className="tool-call-body">
          {toolCall.diff && (
            <div className="tool-section">
              <div className="tool-section-label">改动</div>
              <DiffView diff={toolCall.diff} />
            </div>
          )}
          {toolCall.inputDetail && (
            <div className="tool-section">
              <div className="tool-section-label">输入</div>
              <pre>
                <code>{toolCall.inputDetail}</code>
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div className="tool-section">
              <div className="tool-section-label">结果</div>
              <pre>
                <code>{toolCall.result}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
