import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'

/**
 * 用 sourceToolUseID 标记用户消息，使它们在工具解析完成前保持临时状态。
 * 这可以防止 "is running" 消息在 UI 中重复出现。
 */
export function tagMessagesWithToolUseID(
  messages: (UserMessage | AttachmentMessage | SystemMessage)[],
  toolUseID: string | undefined,
): (UserMessage | AttachmentMessage | SystemMessage)[] {
  if (!toolUseID) {
    return messages
  }
  return messages.map(m => {
    if (m.type === 'user') {
      return { ...m, sourceToolUseID: toolUseID }
    }
    return m
  })
}

/**
 * 从父消息中为给定工具名提取工具使用 ID。
 */
export function getToolUseIDFromParentMessage(
  parentMessage: AssistantMessage,
  toolName: string,
): string | undefined {
  const toolUseBlock = parentMessage.message.content.find(
    block => block.type === 'tool_use' && block.name === toolName,
  )
  return toolUseBlock && toolUseBlock.type === 'tool_use'
    ? toolUseBlock.id
    : undefined
}
