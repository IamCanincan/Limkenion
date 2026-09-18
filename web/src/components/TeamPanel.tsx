import { useState } from 'react'
import type { TeamInfo } from '../types'

interface Props {
  sessionId: string
  team: TeamInfo | null
  /** 每个成员的事件流（team_event 广播按成员聚合）。 */
  streams: Record<string, Record<string, unknown>[]>
  onSend: (member: string, text: string) => void
  onClose: () => void
}

function eventLine(p: Record<string, unknown>): string {
  if (p.type === 'tool_call') return `🔧 ${String(p.name ?? '')}`
  if (p.type === 'tool_result') return `↳ ${String(p.result ?? '').slice(0, 200)}`
  if (p.type === 'notice') return `ℹ️ ${String(p.text ?? '')}`
  if (p.type === 'assistant_delta') return String(p.delta ?? '')
  return JSON.stringify(p).slice(0, 200)
}

/**
 * Agent Teams 工作台：左边成员列表（状态点），右边选中成员的执行流，
 * 底部输入框直接给该成员派活（独立只读回合）。
 */
export function TeamPanel({ sessionId, team, streams, onSend, onClose }: Props) {
  const [selected, setSelected] = useState<string | null>(team?.members?.[0]?.name ?? null)
  const [draft, setDraft] = useState('')

  const members = team?.members ?? []
  const selectedMember = members.find(m => m.name === selected) ?? null
  const stream = selected ? (streams[selected] ?? []) : []

  const submit = () => {
    if (!selected || draft.trim().length === 0) return
    onSend(selected, draft.trim())
    setDraft('')
  }

  return (
    <div className="permission-overlay">
      <div className="team-panel">
        <div className="permission-title">
          团队「{team?.name ?? '（未创建）'}」
          <button className="preview-btn" title="关闭" onClick={onClose}>✕</button>
        </div>
        {members.length === 0 ? (
          <div className="team-empty">
            当前会话没有团队。让模型调用 TeamCreate 创建成员（如 {'{"name":"review","members":["a","b"]}'}），然后在这里派活。
          </div>
        ) : (
          <div className="team-body">
            <div className="team-members">
              {members.map(m => (
                <button
                  key={m.name}
                  className={`team-member ${m.name === selected ? 'active' : ''}`}
                  onClick={() => setSelected(m.name)}
                >
                  <span className={`team-dot ${m.status === 'busy' ? 'busy' : 'idle'}`} />
                  <span>{m.name}</span>
                  <span className="team-status">{m.status === 'busy' ? '工作中' : '空闲'}</span>
                </button>
              ))}
            </div>
            <div className="team-detail">
              {selectedMember ? (
                <>
                  <div className="team-stream" data-testid="team-stream">
                    {stream.length === 0 && <div className="team-empty">该成员还没有执行记录。在下方输入内容派活。</div>}
                    {stream.map((p, i) => (
                      <div key={i} className="team-stream-line">{eventLine(p)}</div>
                    ))}
                  </div>
                  <div className="team-input-row">
                    <input
                      className="team-input"
                      placeholder={`给「${selectedMember.name}」派活（回车发送）`}
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') submit() }}
                      disabled={selectedMember.status === 'busy'}
                    />
                    <button className="perm-allow" onClick={submit} disabled={selectedMember.status === 'busy' || draft.trim().length === 0}>
                      派活
                    </button>
                  </div>
                </>
              ) : (
                <div className="team-empty">选择一个成员</div>
              )}
            </div>
          </div>
        )}
        <div className="team-session-hint">会话 {sessionId}</div>
      </div>
    </div>
  )
}
