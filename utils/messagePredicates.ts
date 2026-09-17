import type { Message, UserMessage } from '../types/message.js'

// tool_result 消息与人类回合共享 type:'user'，二者的判别字段是可选
// 的 toolUseResult。四个 PR（#23977、#24016、#24022、#24025）分别修复了
// 仅检查 type==='user' 所导致的统计错误。
export function isHumanTurn(m: Message): m is UserMessage {
  return m.type === 'user' && !m.isMeta && m.toolUseResult === undefined
}
