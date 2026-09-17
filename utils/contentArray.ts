/**
 * 用于把块插入内容数组中、使其相对于 tool_result 块定位的工具。
 * 由 API 层用于在用户消息中正确定位补充内容（例如缓存编辑指令）。
 *
 * 放置规则：
 * - 若存在 tool_result 块：插入到最后一个之后
 * - 否则：插入到最后一个块之前
 * - 若插入的块会成为最后一个元素，则追加一段文本续接块（某些 API 要求
 *   提示不以非文本内容结尾）
 */

/**
 * 在最后一个 tool_result 块之后把块插入内容数组。
 * 原地修改数组。
 *
 * @param content - 要修改的内容数组
 * @param block - 要插入的块
 */
export function insertBlockAfterToolResults(
  content: unknown[],
  block: unknown,
): void {
  // 找到最后一个 tool_result 块之后的位置
  let lastToolResultIndex = -1
  for (let i = 0; i < content.length; i++) {
    const item = content[i]
    if (
      item &&
      typeof item === 'object' &&
      'type' in item &&
      (item as { type: string }).type === 'tool_result'
    ) {
      lastToolResultIndex = i
    }
  }

  if (lastToolResultIndex >= 0) {
    const insertPos = lastToolResultIndex + 1
    content.splice(insertPos, 0, block)
    // 若插入的块现在是最后一个，则追加一段文本续接
    if (insertPos === content.length - 1) {
      content.push({ type: 'text', text: '.' })
    }
  } else {
    // 没有 tool_result 块——插入到最后一个块之前
    const insertIndex = Math.max(0, content.length - 1)
    content.splice(insertIndex, 0, block)
  }
}
