import { useEffect, useMemo, useState } from 'react'
import type { ChatMessage, ToolCall } from '../types'
import { ToolCallItem } from './ToolCallItem'

/** TodoWrite 的清单载荷，渲染成任务列表（CLI TodoWrite 功能的 web 形态）。 */
interface TodoPayload {
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
}

function TodoList({ toolCall }: { toolCall: ToolCall }) {
  let payload: TodoPayload | null = null
  try {
    payload = JSON.parse(toolCall.inputDetail ?? '{}') as TodoPayload
  } catch {
    payload = null
  }
  if (!payload?.todos?.length) return null
  const STATUS_ICON: Record<string, string> = {
    pending: '○',
    in_progress: '◐',
    completed: '●',
  }
  const done = payload.todos.filter(t => t.status === 'completed').length
  return (
    <div className="todo-list">
      <div className="todo-header">
        任务清单（{done}/{payload.todos.length}）
      </div>
      {payload.todos.map((t, i) => (
        <div key={i} className={`todo-item ${t.status}`}>
          <span className="todo-icon">{STATUS_ICON[t.status]}</span>
          <span className="todo-content">{t.content}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Minimal markdown-ish renderer: fenced code blocks, inline code,
 * bold, and paragraphs. Deliberately dependency-free; swap in a full
 * renderer (e.g. markdown-it) when richer output is needed.
 */
function renderInline(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const token = m[0]
    if (token.startsWith('`')) {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>)
    } else {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    }
    last = m.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function Markdownish({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: { type: 'code' | 'text'; content: string; lang?: string }[] = []
    const lines = text.split('\n')
    let i = 0
    let buf: string[] = []
    const flush = () => {
      if (buf.length > 0) {
        out.push({ type: 'text', content: buf.join('\n') })
        buf = []
      }
    }
    while (i < lines.length) {
      const fence = lines[i].match(/^```(\w*)/)
      if (fence) {
        flush()
        const lang = fence[1] || undefined
        const code: string[] = []
        i++
        while (i < lines.length && !lines[i].startsWith('```')) {
          code.push(lines[i])
          i++
        }
        i++ // skip closing fence
        out.push({ type: 'code', content: code.join('\n'), lang })
      } else {
        buf.push(lines[i])
        i++
      }
    }
    flush()
    return out
  }, [text])

  return (
    <div className="markdownish">
      {blocks.map((b, idx) =>
        b.type === 'code' ? (
          <pre key={idx} className="code-block" data-lang={b.lang ?? ''}>
            <code>{b.content}</code>
          </pre>
        ) : (
          <p key={idx}>{renderInline(b.content)}</p>
        ),
      )}
    </div>
  )
}

function formatUsage(m: ChatMessage): string | null {
  if (!m.usage) return null
  return `↑${m.usage.inputTokens} ↓${m.usage.outputTokens} tokens`
}

/** DeepSeek 思维链（reasoning_content）：流式时展开滚动，完成后折叠。 */
function ReasoningBlock({
  reasoning,
  streaming,
}: {
  reasoning: string
  streaming?: boolean
}) {
  const [open, setOpen] = useState(streaming ?? false)
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])
  return (
    <div className={`reasoning ${streaming ? 'streaming' : ''}`}>
      <button className="reasoning-toggle" onClick={() => setOpen(o => !o)}>
        <span className={`chevron ${open ? 'open' : ''}`}>▸</span>
        {streaming ? (
          <span>
            <span className="spinner inline" /> 思考中…
          </span>
        ) : (
          <span>思维链（{reasoning.length} 字）</span>
        )}
      </button>
      {open && <div className="reasoning-body">{reasoning}</div>}
    </div>
  )
}

export function MessageItem({ message }: { message: ChatMessage }) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolCalls = message.toolCalls ?? []
  // TodoWrite 单独拎出来常驻展示（与 CLI 的待办清单一致），其余工具进折叠区。
  const todoCalls = toolCalls.filter(t => t.name === 'TodoWrite')
  const otherCalls = toolCalls.filter(t => t.name !== 'TodoWrite')
  const runningCount = otherCalls.filter(t => t.status === 'running').length
  const doneCount = otherCalls.length - runningCount
  const usage = formatUsage(message)

  if (message.role === 'user') {
    return (
      <div className="message user">
        {message.images && message.images.length > 0 && (
          <div className="message-images">
            {message.images.map((img, i) => (
              <a key={i} href={img.dataUrl} target="_blank" rel="noreferrer" title={img.name}>
                <img src={img.dataUrl} alt={img.name} />
              </a>
            ))}
          </div>
        )}
        {message.text && <div className="message-bubble">{message.text}</div>}
      </div>
    )
  }

  if (message.role === 'system') {
    return <div className="message system">{message.text}</div>
  }

  return (
    <div className="message assistant">
      {message.reasoning && (
        <ReasoningBlock reasoning={message.reasoning} streaming={message.reasoningStreaming} />
      )}
      {todoCalls.map(tc => (
        <TodoList key={tc.id} toolCall={tc} />
      ))}
      {/* Turn process: non-todo tool calls folded by default once complete
          (learned from deepseek-harness's turn process folding). */}
      {otherCalls.length > 0 && (
        <div className="turn-process">
          <button className="turn-process-toggle" onClick={() => setToolsOpen(o => !o)}>
            <span className={`chevron ${toolsOpen ? 'open' : ''}`}>▸</span>
            {runningCount > 0 ? (
              <span>
                <span className="spinner inline" /> 正在执行工具（{doneCount}/{otherCalls.length}）
              </span>
            ) : (
              <span>
                已完成 {otherCalls.length} 个工具调用 · {Math.round(
                  otherCalls.reduce((acc, t) => acc + (t.durationMs ?? 0), 0) / 1000,
                )}
                s
              </span>
            )}
          </button>
          {(toolsOpen || runningCount > 0) && (
            <div className="tool-call-list">
              {otherCalls.map(tc => (
                <ToolCallItem key={tc.id} toolCall={tc} defaultOpen={tc.status === 'running'} />
              ))}
            </div>
          )}
        </div>
      )}
      {(message.text || message.streaming) && <Markdownish text={message.text} />}
      {message.streaming && <span className="cursor">▋</span>}
      {usage && <div className="message-usage">{usage}</div>}
    </div>
  )
}
