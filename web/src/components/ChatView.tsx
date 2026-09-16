import type { ChatMessage } from '../types'
import { MessageItem } from './MessageItem'

interface Props {
  messages: ChatMessage[]
  streaming: boolean
}

export function ChatView({ messages, streaming }: Props) {
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
        <MessageItem key={m.id} message={m} />
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
