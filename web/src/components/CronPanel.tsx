import { useState } from 'react'
import type { CronInfo, SessionInfo } from '../types'

interface Props {
  crons: CronInfo[]
  sessions: SessionInfo[]
  activeSessionId: string | null
  onCreate: (prompt: string, schedule: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

/** 把毫秒说成人话：90_000 → "1分30秒"。 */
function humanInterval(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest === 0 ? `${m} 分` : `${m} 分 ${rest} 秒`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm === 0 ? `${h} 小时` : `${h} 小时 ${rm} 分`
}

export function CronPanel({ crons, sessions, activeSessionId, onCreate, onDelete, onClose }: Props) {
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState('5m')

  const titleOf = (id: string) => {
    const s = sessions.find(x => x.id === id)
    return s ? s.title || s.id : id
  }

  const submit = () => {
    const text = prompt.trim()
    const spec = schedule.trim()
    if (!text || !spec) return
    onCreate(text, spec)
    setPrompt('')
  }

  const mine = crons.filter(c => c.sessionId === activeSessionId)
  const others = crons.filter(c => c.sessionId !== activeSessionId)

  return (
    <div className="cron-panel">
      <div className="cron-header">
        <strong>定时任务</strong>
        <span className="cron-hint">在独立回合里按周期执行；周期写法与模型的 CronCreate 一致</span>
        <button className="mcp-btn" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="cron-create">
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={2}
          placeholder="要周期执行什么？例如：检查构建状态，有问题就报告"
        />
        <div className="cron-create-row">
          <input
            value={schedule}
            onChange={e => setSchedule(e.target.value)}
            placeholder="5m"
            title="支持 30s / 5m / 2h 或毫秒数，最小 5 秒"
          />
          <button className="mcp-btn primary" onClick={submit} disabled={!prompt.trim() || !schedule.trim()}>
            创建
          </button>
        </div>
      </div>

      {crons.length === 0 && <div className="mcp-empty">当前没有定时任务。</div>}

      {mine.length > 0 && (
        <>
          <div className="cron-group">本会话（{mine.length}）</div>
          {mine.map(c => (
            <div key={c.id} className="cron-row">
              <div className="cron-row-main">
                <span className="cron-id">{c.id}</span>
                <span className="mcp-tag">每 {humanInterval(c.everyMs)}</span>
              </div>
              <div className="cron-row-sub">{c.prompt}</div>
              <div className="cron-row-actions">
                <button className="mcp-btn danger" onClick={() => onDelete(c.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {others.length > 0 && (
        <>
          <div className="cron-group">其它会话（{others.length}）</div>
          {others.map(c => (
            <div key={c.id} className="cron-row">
              <div className="cron-row-main">
                <span className="cron-id">{c.id}</span>
                <span className="mcp-tag">每 {humanInterval(c.everyMs)}</span>
                <span className="mcp-tag">{titleOf(c.sessionId)}</span>
              </div>
              <div className="cron-row-sub">{c.prompt}</div>
              <div className="cron-row-actions">
                <button className="mcp-btn danger" onClick={() => onDelete(c.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
