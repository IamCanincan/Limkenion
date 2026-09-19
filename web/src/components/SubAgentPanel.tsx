import { useState } from 'react'
import type { SettingsScope, SubagentInfo } from '../types'

interface Props {
  subagents: SubagentInfo[]
  /** 可选模型（服务端把住"只支持 DeepSeek"，这里只负责展示/选择）。 */
  models: { value: string; label: string }[]
  onSave: (name: string, config: Record<string, unknown>, scope: SettingsScope) => void
  onDelete: (name: string, scope: SettingsScope) => void
  onClose: () => void
}

const SCOPE_LABEL: Record<SettingsScope, string> = {
  user: '全局',
  project: '项目共享',
  local: '项目私有',
}

/** 子代理可用的只读工具（与服务端 SUBAGENT_TOOLS 对齐）。 */
const READONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Sleep']

export function SubAgentPanel({ subagents, models, onSave, onDelete, onClose }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('')
  const [tools, setTools] = useState<string[]>([])
  const [scope, setScope] = useState<SettingsScope>('user')

  const startCreate = () => {
    setOpen(true)
    setName('')
    setDescription('')
    setModel('')
    setTools([])
    setScope('user')
  }

  const toggleTool = (t: string) => {
    setTools(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]))
  }

  const submit = () => {
    const key = name.trim()
    if (!key) return
    const cfg: Record<string, unknown> = { description: description.trim() }
    if (model) cfg.model = model
    if (tools.length > 0) cfg.tools = tools
    onSave(key, cfg, scope)
    setOpen(false)
  }

  return (
    <div className="mcp-panel">
      <div className="mcp-header">
        <strong>子代理</strong>
        <span className="mcp-scope-hint">具名子代理：预配模型与只读工具集，供 Agent 工具按名选用</span>
        <button className="mcp-btn" onClick={startCreate}>
          新增
        </button>
        <button className="mcp-btn" onClick={onClose}>
          关闭
        </button>
      </div>

      {subagents.length === 0 && !open && (
        <div className="mcp-empty">
          还没有具名子代理。不配也能用 —— 默认就是只读探查子代理（用当前会话的模型）。
        </div>
      )}

      <div className="mcp-list">
        {subagents.map(s => (
          <div key={s.name} className="mcp-row">
            <div className="mcp-row-main">
              <span className="mcp-name">{s.name}</span>
              <span className="mcp-tag">{SCOPE_LABEL[s.source] ?? s.source}</span>
              {s.model && <span className="mcp-tag">模型 {s.model}</span>}
              {s.tools && s.tools.length > 0 && (
                <span className="mcp-tag">工具 {s.tools.length} 个</span>
              )}
            </div>
            <div className="mcp-row-sub">{s.description || '（无描述）'}</div>
            {s.tools && s.tools.length > 0 && <div className="mcp-row-sub">限定：{s.tools.join('、')}</div>}
            <div className="mcp-row-actions">
              <button className="mcp-btn danger" onClick={() => onDelete(s.name, s.source)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {open && (
        <div className="mcp-form">
          <label>
            名称
            <input value={name} onChange={e => setName(e.target.value)} placeholder="researcher" />
          </label>
          <label>
            描述
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="只读调研员，不联网"
            />
          </label>
          <label>
            模型（留空 = 跟随当前会话）
            <select value={model} onChange={e => setModel(e.target.value)}>
              <option value="">跟随会话</option>
              {models.map(m => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="sa-tools">
            <div className="sa-tools-title">工具（不勾 = 用全部只读工具）</div>
            {READONLY_TOOLS.map(t => (
              <label key={t} className="sa-tool">
                <input type="checkbox" checked={tools.includes(t)} onChange={() => toggleTool(t)} />
                {t}
              </label>
            ))}
          </div>
          <label>
            作用域
            <select value={scope} onChange={e => setScope(e.target.value as SettingsScope)}>
              <option value="user">{SCOPE_LABEL.user}</option>
              <option value="project">{SCOPE_LABEL.project}</option>
              <option value="local">{SCOPE_LABEL.local}</option>
            </select>
          </label>
          <div className="mcp-form-actions">
            <button className="mcp-btn primary" onClick={submit} disabled={!name.trim()}>
              保存
            </button>
            <button className="mcp-btn" onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
