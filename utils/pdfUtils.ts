import { getMainLoopModel } from './model/model.js'

// 特别处理的文档扩展名
export const DOCUMENT_EXTENSIONS = new Set(['pdf'])

/**
 * 把页数范围字符串解析为 firstPage/lastPage 数字。
 * 支持的格式：
 * - "5" → { firstPage: 5, lastPage: 5 }
 * - "1-10" → { firstPage: 1, lastPage: 10 }
 * - "3-" → { firstPage: 3, lastPage: Infinity }
 *
 * 输入无效时返回 null（非数字、为零、范围倒置）。
 * 页数是 1 起始的。
 */
export function parsePDFPageRange(
  pages: string,
): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim()
  if (!trimmed) {
    return null
  }

  // "N-" 开放区间
  if (trimmed.endsWith('-')) {
    const first = parseInt(trimmed.slice(0, -1), 10)
    if (isNaN(first) || first < 1) {
      return null
    }
    return { firstPage: first, lastPage: Infinity }
  }

  const dashIndex = trimmed.indexOf('-')
  if (dashIndex === -1) {
    // 单页："5"
    const page = parseInt(trimmed, 10)
    if (isNaN(page) || page < 1) {
      return null
    }
    return { firstPage: page, lastPage: page }
  }

  // 区间："1-10"
  const first = parseInt(trimmed.slice(0, dashIndex), 10)
  const last = parseInt(trimmed.slice(dashIndex + 1), 10)
  if (isNaN(first) || isNaN(last) || first < 1 || last < 1 || last < first) {
    return null
  }
  return { firstPage: first, lastPage: last }
}

/**
 * 检查当前模型是否支持 PDF 阅读。
 * PDF 文档块在所有提供方（1P、Vertex、Bedrock、Foundry）上都可用。
 * Haiku 3 是唯一先于 PDF 支持存在的模型；使用它的用户会回退到页面抽取路径
 * （poppler-utils）。子串匹配覆盖所有提供方 ID 格式（Bedrock 前缀、Vertex 的
 * @日期）。
 */
export function isPDFSupported(): boolean {
  return !getMainLoopModel().toLowerCase().includes('limkenion-3-haiku')
}

/**
 * 检查文件扩展名是否为 PDF 文档。
 * @param ext 文件扩展名（带或不带前导点）
 */
export function isPDFExtension(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.slice(1) : ext
  return DOCUMENT_EXTENSIONS.has(normalized.toLowerCase())
}
