import { getPastedTextRefNumLines } from 'src/history.js'
import type { PastedContent } from 'src/utils/config.js'

const TRUNCATION_THRESHOLD = 10000 // 超过此字符数即截断
const PREVIEW_LENGTH = 1000 // 开头和结尾显示保留的字符数

type TruncatedMessage = {
  truncatedText: string
  placeholderContent: string
}

/**
 * 判断输入文本是否应被截断。若是，则添加一个
 * 截断文本占位符并返回
 *
 * @param text 输入文本
 * @param nextPasteId 使用的引用 id
 * @returns 要显示的新文本以及（如适用）分离的占位符内容。
 */
export function maybeTruncateMessageForInput(
  text: string,
  nextPasteId: number,
): TruncatedMessage {
  // 如果文本足够短，则原样返回
  if (text.length <= TRUNCATION_THRESHOLD) {
    return {
      truncatedText: text,
      placeholderContent: '',
    }
  }

  // 计算在开头和结尾各保留多少文本
  const startLength = Math.floor(PREVIEW_LENGTH / 2)
  const endLength = Math.floor(PREVIEW_LENGTH / 2)

  // 提取我们将保留的部分
  const startText = text.slice(0, startLength)
  const endText = text.slice(-endLength)

  // 计算将被截断掉的行数
  const placeholderContent = text.slice(startLength, -endLength)
  const truncatedLines = getPastedTextRefNumLines(placeholderContent)

  // 创建与粘贴文本类似的占位符引用
  const placeholderId = nextPasteId
  const placeholderRef = formatTruncatedTextRef(placeholderId, truncatedLines)

  // 组合各部分与占位符
  const truncatedText = startText + placeholderRef + endText

  return {
    truncatedText,
    placeholderContent,
  }
}

function formatTruncatedTextRef(id: number, numLines: number): string {
  return `[...已截断文本 #${id} +${numLines} 行...]`
}

export function maybeTruncateInput(
  input: string,
  pastedContents: Record<number, PastedContent>,
): { newInput: string; newPastedContents: Record<number, PastedContent> } {
  // 获取截断内容的下一可用 ID
  const existingIds = Object.keys(pastedContents).map(Number)
  const nextPasteId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1

  // 应用截断
  const { truncatedText, placeholderContent } = maybeTruncateMessageForInput(
    input,
    nextPasteId,
  )

  if (!placeholderContent) {
    return { newInput: input, newPastedContents: pastedContents }
  }

  return {
    newInput: truncatedText,
    newPastedContents: {
      ...pastedContents,
      [nextPasteId]: {
        id: nextPasteId,
        type: 'text',
        content: placeholderContent,
      },
    },
  }
}
