import chalk from 'chalk'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'

// OSC 8 超链接转义序列
// 格式：\e]8;;URL\e\\TEXT\e]8;;\e\\
// 使用 \x07（BEL）作为终结符，兼容性更广泛
export const OSC8_START = '\x1b]8;;'
export const OSC8_END = '\x07'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
}

/**
 * 使用 OSC 8 转义序列创建可点击的超链接。
 * 若终端不支持超链接，则回退为纯文本。
 *
 * @param url - 要链接到的 URL
 * @param content - 可选，作为链接文本显示的显示内容（仅当支持超链接时）。
 *                  若提供且支持超链接，该文本显示为可点击的链接。
 *                  若不支持超链接，则忽略 content，仅显示 URL。
 * @param options - 可选，用于测试的覆盖（supportsHyperlinks）
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!hasSupport) {
    return url
  }

  // 应用基本 ANSI 蓝色——wrap-ansi 会在跨行时保留它
  // RGB 颜色（如主题颜色）不会被 wrap-ansi 与 OSC 8 一起保留
  const displayText = content ?? url
  const coloredText = chalk.blue(displayText)
  return `${OSC8_START}${url}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
}
