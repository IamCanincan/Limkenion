import type { ConnectionState, Settings, TokenUsage } from '../types'

interface Props {
  state: ConnectionState
  sessionCount: number
  lastUsage: TokenUsage | null
  settings: Settings | null
  planMode: boolean
  error: string | null
}

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: '连接中…',
  open: '已连接',
  closed: '已断开（自动重连中）',
}

const ENGINE_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  mock: 'mock（未设 DEEPSEEK_API_KEY）',
}

export function StatusBar({ state, sessionCount, lastUsage, settings, planMode, error }: Props) {
  return (
    <footer className="status-bar">
      <span className={`conn-dot ${state}`} />
      <span>{STATE_LABEL[state]}</span>
      <span className="sep">·</span>
      <span>{sessionCount} 个会话</span>
      {settings && (
        <>
          <span className="sep">·</span>
          <span>引擎 {ENGINE_LABEL[settings.engine] ?? settings.engine}</span>
        </>
      )}
      {planMode && (
        <>
          <span className="sep">·</span>
          <span className="status-plan">计划模式</span>
        </>
      )}
      {lastUsage && (
        <>
          <span className="sep">·</span>
          <span>
            上一回合 ↑{lastUsage.inputTokens} ↓{lastUsage.outputTokens} tokens
          </span>
        </>
      )}
      {error && <span className="status-error">{error}</span>}
      <span className="spacer" />
      <span className="brand-foot">Limkenion</span>
    </footer>
  )
}
