import { useState } from 'react'
import type { AskQuestion, QuestionAnswer } from '../types'

interface Props {
  requestId: string
  questions: AskQuestion[]
  onRespond: (requestId: string, answers: QuestionAnswer[]) => void
}

/**
 * AskUserQuestion 的界面形态（对齐 CLI 的问答弹窗）：
 * 单选 / 多选 / 「其他」自由输入，提交后把答案回传给服务端。
 */
export function QuestionDialog({ requestId, questions, onRespond }: Props) {
  // 每题一个选择集合；自由输入单独存
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const toggle = (qi: number, label: string, multi?: boolean) => {
    setPicked(prev => {
      const cur = prev[qi] ?? []
      if (multi) {
        return { ...prev, [qi]: cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label] }
      }
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] }
    })
  }

  const setOtherText = (qi: number, text: string) => {
    setOther(prev => ({ ...prev, [qi]: text }))
  }

  const ready = questions.every((_, qi) => {
    const hasPick = (picked[qi] ?? []).length > 0
    const hasOther = (other[qi] ?? '').trim().length > 0
    return hasPick || hasOther
  })

  const submit = () => {
    const answers: QuestionAnswer[] = questions.map((q, qi) => {
      const picks = [...(picked[qi] ?? [])]
      const free = (other[qi] ?? '').trim()
      if (free) picks.push(free)
      return { question: q.question, answer: q.multiSelect ? picks : (picks[0] ?? '') }
    })
    onRespond(requestId, answers)
  }

  return (
    <div className="permission-overlay">
      <div className="permission-dialog question-dialog">
        <div className="permission-title">需要你的选择</div>
        {questions.map((q, qi) => (
          <div key={qi} className="question-block">
            <div className="question-head">
              <span className="question-chip">{q.header}</span>
              {q.multiSelect && <span className="question-multi">可多选</span>}
            </div>
            <div className="question-text">{q.question}</div>
            <div className="question-options">
              {q.options.map(o => {
                const active = (picked[qi] ?? []).includes(o.label)
                return (
                  <button
                    key={o.label}
                    className={`question-option ${active ? 'active' : ''}`}
                    onClick={() => toggle(qi, o.label, q.multiSelect)}
                  >
                    <span className="option-label">{o.label}</span>
                    {o.description && <span className="option-desc">{o.description}</span>}
                  </button>
                )
              })}
            </div>
            <input
              className="question-other"
              placeholder="其他（自由作答）"
              value={other[qi] ?? ''}
              onChange={e => setOtherText(qi, e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && ready) submit()
              }}
            />
          </div>
        ))}
        <div className="permission-actions">
          <button className="perm-allow" disabled={!ready} onClick={submit}>
            提交
          </button>
        </div>
      </div>
    </div>
  )
}
