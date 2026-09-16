import { useEffect } from 'react'

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  /** 非空表示升级确认（shell 守卫命中 / 本回合接触过不可信内容）。 */
  escalate?: string | null
}

interface Props {
  request: PermissionRequest
  onRespond: (requestId: string, decision: 'allow' | 'always' | 'deny') => void
}

/** 危险工具（Bash/Write/Edit）的权限确认对话框 —— CLI 权限提示的 web 形态。 */
export function PermissionDialog({ request, onRespond }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onRespond(request.requestId, 'deny')
      if (e.key === 'Enter') onRespond(request.requestId, 'allow')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request.requestId, onRespond])

  const preview = (() => {
    const input = request.input
    switch (request.toolName) {
      case 'Bash':
        return String(input.command ?? '')
      case 'PowerShell':
        return `PS> ${String(input.command ?? '')}`
      case 'REPL':
        return String(input.code ?? '')
      case 'Write':
        return `文件：${String(input.file_path ?? '')}\n内容 ${String(input.content ?? '').length} 字符`
      case 'Edit':
        return `文件：${String(input.file_path ?? '')}\n替换 ${String(input.old_string ?? '').length} → ${String(input.new_string ?? '').length} 字符`
      case 'NotebookEdit':
        return `Notebook：${String(input.notebook_path ?? '')}\n模式：${String(input.edit_mode ?? 'replace')}`
      case 'CronCreate':
        return `周期：${String(input.schedule ?? '')}\n内容：${String(input.prompt ?? '').slice(0, 200)}`
      default:
        return JSON.stringify(input, null, 2).slice(0, 600)
    }
  })()

  return (
    <div className="permission-overlay">
      <div className={`permission-dialog ${request.escalate ? 'escalated' : ''}`}>
        <div className="permission-title">
          <span className="permission-tool">{request.toolName}</span> 请求执行
        </div>
        {request.escalate && (
          <div className="permission-escalate">
            升级确认：{request.escalate}
            <div className="permission-escalate-hint">
              此项不受「本会话总是允许」影响，每次都需要你确认。
            </div>
          </div>
        )}
        <pre className="permission-preview">{preview}</pre>
        <div className="permission-actions">
          <button className="perm-allow" onClick={() => onRespond(request.requestId, 'allow')}>
            允许一次
          </button>
          {!request.escalate && (
            <button className="perm-always" onClick={() => onRespond(request.requestId, 'always')}>
              本会话总是允许
            </button>
          )}
          <button className="perm-deny" onClick={() => onRespond(request.requestId, 'deny')}>
            拒绝 (Esc)
          </button>
        </div>
      </div>
    </div>
  )
}
