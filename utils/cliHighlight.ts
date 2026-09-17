// highlight.js 的类型定义带有 `/// <reference lib="dom" />`。SSETransport、
// mcp/client、ssh、dumpPrompts 使用的 DOM 类型（TextDecodeOptions、
// RequestInfo）之所以能通过类型检查，仅仅是因为本文件里的
// `typeof import('highlight.js')` 拉入了 lib.dom。tsconfig 只有 lib: ["ESNext"]
// ——真正修复 DOM 类型依赖是另一轮清理；本次重构保持了现状。
/// <reference lib="dom" />

import { extname } from 'path'

export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

// 由 Fallback.tsx、markdown.ts、events.ts、getLanguageName 共享的单一 promise。
// highlight.js 的导入搭便车：cli-highlight 已把它拉进模块缓存，因此第二次
// import() 是缓存命中——不会额外换入任何字节。
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

let loadedGetLanguage: typeof import('highlight.js').getLanguage | undefined

async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const cliHighlight = await import('cli-highlight')
    // 缓存命中——cli-highlight 已加载 highlight.js
    const highlightJs = await import('highlight.js')
    loadedGetLanguage = highlightJs.getLanguage
    return {
      highlight: cliHighlight.highlight,
      supportsLanguage: cliHighlight.supportsLanguage,
    }
  } catch {
    return null
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight()
  return cliHighlightPromise
}

/**
 * 例如 "foo/bar.ts" → "TypeScript"。等待共享的 cli-highlight 加载，
 * 然后读取 highlight.js 的语言注册表。所有调用方都是遥测（OTel 计数器
 * 属性、权限对话框一元事件）——它们都不会阻塞在此之上，要么即发即忘，
 * 要么调用方已处理 Promise&lt;string&gt;。
 */
export async function getLanguageName(file_path: string): Promise<string> {
  await getCliHighlightPromise()
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  return loadedGetLanguage?.(ext)?.name ?? 'unknown'
}
