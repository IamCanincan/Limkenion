import type {
  RenderableMessage,
  SystemStopHookSummaryMessage,
} from '../types/message.js'

function isLabeledHookSummary(
  msg: RenderableMessage,
): msg is SystemStopHookSummaryMessage {
  return (
    msg.type === 'system' &&
    msg.subtype === 'stop_hook_summary' &&
    msg.hookLabel !== undefined
  )
}

/**
 * 把具有相同 hookLabel（例如 PostToolUse）的连续 hook 摘要消息折叠为单个
 * 摘要。当并行工具调用各自发出自己的 hook 摘要时会发生这种情况。
 */
export function collapseHookSummaries(
  messages: RenderableMessage[],
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isLabeledHookSummary(msg)) {
      const label = msg.hookLabel
      const group: SystemStopHookSummaryMessage[] = []
      while (i < messages.length) {
        const next = messages[i]!
        if (!isLabeledHookSummary(next) || next.hookLabel !== label) break
        group.push(next)
        i++
      }
      if (group.length === 1) {
        result.push(msg)
      } else {
        result.push({
          ...msg,
          hookCount: group.reduce((sum, m) => sum + m.hookCount, 0),
          hookInfos: group.flatMap(m => m.hookInfos),
          hookErrors: group.flatMap(m => m.hookErrors),
          preventedContinuation: group.some(m => m.preventedContinuation),
          hasOutput: group.some(m => m.hasOutput),
          // 并行工具调用的 hook 会重叠；最大值最接近墙钟时间。
          totalDurationMs: Math.max(...group.map(m => m.totalDurationMs ?? 0)),
        })
      }
    } else {
      result.push(msg)
      i++
    }
  }

  return result
}
