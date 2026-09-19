import type { ChatMessage } from '../types'
import { MessageItem } from './MessageItem'

interface Props {
  messages: ChatMessage[]
  streaming: boolean
  /** 搜索跳转过来要高亮的那条消息（短暂闪烁提示）。 */
  highlightId?: string | null
}

export function ChatView({ messages, streaming, highlightId }: Props) {
  return (
    <div className="chat-view">
      {messages.length === 0 && (
        <div className="chat-empty">
          <div className="chat-empty-logo">L</div>
          <div className="chat-empty-title">Limkenion</div>
          <div className="chat-empty-hint">在下方输入框开始对话</div>
        </div>
      )}
      {messages.map(m => (
        // data-message-id：全局搜索命中后据此定位并滚动到这条消息
        <div key={m.id} data-message-id={m.id} className={m.id === highlightId ? 'msg-flash' : undefined}>
          <MessageItem message={m} />
        </div>
      ))}
      {streaming && (
        <div className="streaming-indicator">
          <span className="spinner" />
          正在思考…
        </div>
      )}
    </div>
  )
}
