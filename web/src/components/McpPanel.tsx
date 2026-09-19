import { useState } from 'react'
import type { McpServerInfo, SettingsScope } from '../types'

interface Props {
  servers: McpServerInfo[]
  onSave: (name: string, config: Record<string, unknown>, scope: SettingsScope) => void
  onDelete: (name: string, scope: SettingsScope) => void
  onClose: () => void
}

const SCOPE_LABEL: Record<SettingsScope, string> = {
  user: '全局（~/.limkenion）',
  project: '项目共享（.limkenion/settings.json）',
  local: '项目私有（settings.local.json）',
}

/** 把整行参数切成数组（支持引号包裹含空格的参数）。 */
function splitArgs(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** 解析可选的小 JSON（env / headers）；空着就返回 undefined（不写这个键）。 */
function parseMaybeJson(text: string): Record<string, string> | undefined {
  const s = text.trim()
  if (!s) return undefined
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

export function McpPanel({ servers, onSave, onDelete, onClose }: Props) {
  const [editing, setEditing] = useState<McpServerInfo | null>(null)
  const [creating, setCreating] = useState(false)

  const [name, setName] = useState('')
  const [transport, setTransport] = useState('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [scope, setScope] = useState<SettingsScope>('user')

  const startCreate = () => {
    setEditing(null)
    setCreating(true)
    setName('')
    setTransport('stdio')
    setCommand('')
    setArgs('')
    setUrl('')
    setEnvText('')
    setHeadersText('')
    setScope('user')
  }

  const startEdit = (s: McpServerInfo) => {
    setCreating(false)
    setEditing(s)
    setName(s.name)
    setTransport(s.transport || 'stdio')
    setCommand(s.command ?? '')
    setArgs((s.args ?? []).join(' '))
    setUrl(s.url ?? '')
    setEnvText(s.env && Object.keys(s.env).length ? JSON.stringify(s.env, null, 1) : '')
    setHeadersText(s.headers && Object.keys(s.headers).length ? JSON.stringify(s.headers, null, 1) : '')
    setScope(s.source ?? 'user')
  }

  const submit = () => {
    const cfg: Record<string, unknown> = { type: transport }
    if (transport === 'stdio') {
      cfg.command = command.trim()
      cfg.args = splitArgs(args)
    } else {
      cfg.url = url.trim()
    }
    const env = parseMaybeJson(envText)
    if (env) cfg.env = env
    const headers = parseMaybeJson(headersText)
    if (headers) cfg.headers = headers

    onSave(name.trim(), cfg, scope)
    setCreating(false)
    setEditing(null)
  }

  const open = creating || editing !== null

  return (
    <div className="mcp-panel">
      <div className="mcp-header">
        <strong>MCP 服务器</strong>
        <span className="mcp-scope-hint">作用域决定写进哪个设置文件</span>
        <button className="mcp-btn" onClick={startCreate}>
          新增
        </button>
        <button className="mcp-btn" onClick={onClose}>
          关闭
        </button>
      </div>

      {servers.length === 0 && !open && (
        <div className="mcp-empty">
          还没有配置 MCP 服务器。点「新增」加一个，或直接在设置文件里写 mcpServers。
        </div>
      )}

      <div className="mcp-list">
        {servers.map(s => (
          <div key={s.name} className="mcp-row">
            <div className="mcp-row-main">
              <span className="mcp-name">{s.name}</span>
              <span className="mcp-tag">{s.transport}</span>
              <span className="mcp-tag">{SCOPE_LABEL[s.source] ?? s.source}</span>
              <span className={`mcp-state mcp-state-${s.state}`}>{s.state}</span>
            </div>
            <div className="mcp-row-sub">
              {s.command ? `${s.command} ${(s.args ?? []).join(' ')}`.trim() : s.url || '（无命令/地址）'}
            </div>
            {s.serverInfo && <div className="mcp-row-sub">服务端：{s.serverInfo}</div>}
            {s.problem && <div className="mcp-row-sub mcp-warn">不可用：{s.problem}</div>}
            {s.error && <div className="mcp-row-sub mcp-warn">错误：{s.error}</div>}
            {s.state === 'connected' && s.tools.length > 0 && (
              <div className="mcp-row-sub">工具 {s.tools.length} 个：{s.tools.slice(0, 6).join('、')}</div>
            )}
            <div className="mcp-row-actions">
              <button className="mcp-btn" onClick={() => startEdit(s)}>
                编辑
              </button>
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
            <input value={name} onChange={e => setName(e.target.value)} disabled={editing !== null} />
          </label>
          <label>
            传输
            <select value={transport} onChange={e => setTransport(e.target.value)}>
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>
          {transport === 'stdio' ? (
            <>
              <label>
                命令
                <input value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" />
              </label>
              <label>
                参数（空格分隔）
                <input value={args} onChange={e => setArgs(e.target.value)} placeholder="-y @xxx/server ." />
              </label>
            </>
          ) : (
            <label>
              地址
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://.../mcp" />
            </label>
          )}
          <label>
            环境变量（JSON，可留空）
            <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={2} />
          </label>
          <label>
            请求头（JSON，可留空）
            <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} rows={2} />
          </label>
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
            <button
              className="mcp-btn"
              onClick={() => {
                setCreating(false)
                setEditing(null)
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
