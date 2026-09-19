/**
 * 全局搜索：跨**会话消息** + **工作区文件名** + **会话标题**。
 *
 * 学 codex file-search 的「增量快照」思路：结果带 `complete` 标志 —— 命中数触到
 * 上限而提前收尾时 complete=false，前端可以先渲染部分结果，不必干等"全扫完"。
 *
 * 匹配规则刻意简单可预期：空格分词、全部命中才算（AND）、大小写不敏感、
 * 纯子串匹配（不引入正则，避免用户输入的正则把搜索搞挂）。
 */

import { allSessions } from './sessions.mjs'
import { listIndexedFiles } from './workspace.mjs'

export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_SEARCH_LIMIT = 200
/** 片段上下文：命中位置前后各留多少字。 */
const SNIPPET_PAD = 60

/**
 * 查询串分词（空格分隔，AND 语义）。
 * @param {string} query
 * @returns {string[]}
 */
function terms(query) {
  return String(query ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * @param {unknown} haystack
 * @param {string[]} ts
 * @returns {boolean}
 */
function matches(haystack, ts) {
  if (ts.length === 0) return false
  const h = String(haystack ?? '').toLowerCase()
  return ts.every(t => h.includes(t))
}

/**
 * 取命中位置附近的一段上下文，便于在结果里直接看懂。
 * @param {string} text
 * @param {string[]} ts
 * @returns {string}
 */
function snippet(text, ts) {
  const s = String(text ?? '')
  const lower = s.toLowerCase()
  let idx = -1
  for (const t of ts) {
    const i = lower.indexOf(t)
    if (i >= 0 && (idx < 0 || i < idx)) idx = i
  }
  if (idx < 0) return s.slice(0, SNIPPET_PAD * 2)
  const start = Math.max(0, idx - SNIPPET_PAD)
  const end = Math.min(s.length, idx + SNIPPET_PAD + (ts[0]?.length ?? 0))
  return `${start > 0 ? '…' : ''}${s.slice(start, end)}${end < s.length ? '…' : ''}`
}

/**
 * 一条消息的可搜索文本：正文 + 工具结果（工具输出常是关键信息，
 * 只搜正文会漏掉"刚才那个命令报了什么错"这类查询）。
 * @param {{text?: string, toolCalls?: unknown}} m
 * @returns {string}
 */
function messageText(m) {
  const parts = [String(m?.text ?? '')]
  for (const tc of /** @type {any[]} */ (m?.toolCalls ?? [])) {
    if (tc?.name) parts.push(String(tc.name))
    if (tc?.result != null) parts.push(String(tc.result))
  }
  return parts.join('\n')
}

/**
 * 跨会话搜消息。
 * @param {string} query
 * @param {{limit?: number}} [opts]
 */
export function searchMessages(query, { limit = DEFAULT_SEARCH_LIMIT } = {}) {
  const ts = terms(query)
  /** @type {Array<{kind:'message', sessionId:string, sessionTitle:string, messageId:string, role:string, timestamp:number|null, snippet:string}>} */
  const hits = []
  if (ts.length === 0) return { hits, complete: true }

  let scannedMessages = 0
  for (const s of allSessions()) {
    for (const m of s.messages ?? []) {
      scannedMessages++
      const text = messageText(m)
      if (!matches(text, ts)) continue
      hits.push({
        kind: 'message',
        sessionId: s.id,
        sessionTitle: s.title ?? '',
        messageId: m.id,
        role: m.role ?? 'user',
        timestamp: m.timestamp ?? null,
        snippet: snippet(String(m?.text ?? text), ts),
      })
      if (hits.length >= limit) return { hits, complete: false, scannedMessages }
    }
  }
  return { hits, complete: true, scannedMessages }
}

/**
 * 搜工作区文件名（相对路径）。
 * @param {string} query
 * @param {{limit?: number}} [opts]
 */
export async function searchFiles(query, { limit = 30 } = {}) {
  const ts = terms(query)
  /** @type {Array<{kind:'file', path:string}>} */
  const hits = []
  if (ts.length === 0) return { hits, complete: true }
  const files = await listIndexedFiles()
  for (const f of files) {
    if (!matches(f, ts)) continue
    hits.push({ kind: 'file', path: f })
    if (hits.length >= limit) return { hits, complete: false }
  }
  return { hits, complete: true }
}

/**
 * 搜会话标题。
 * @param {string} query
 * @param {{limit?: number}} [opts]
 */
export function searchSessions(query, { limit = 20 } = {}) {
  const ts = terms(query)
  /** @type {Array<{kind:'session', sessionId:string, sessionTitle:string}>} */
  const hits = []
  if (ts.length === 0) return { hits, complete: true }
  for (const s of allSessions()) {
    if (!matches(s.title ?? '', ts)) continue
    hits.push({ kind: 'session', sessionId: s.id, sessionTitle: s.title ?? '' })
    if (hits.length >= limit) return { hits, complete: false }
  }
  return { hits, complete: true }
}

/**
 * 一次搜全部（标题 → 消息 → 文件）。
 *
 * 顺序有意为之：标题最短、最像"我要找的那个会话"，其次是消息正文，
 * 文件路径放最后（量大、且通常只是顺带找）。
 *
 * @param {string} query
 * @param {{limit?: number}} [opts]
 */
export async function searchAll(query, { limit = DEFAULT_SEARCH_LIMIT } = {}) {
  const capped = Math.min(Math.max(Number(limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT)
  const ts = terms(query)
  if (ts.length === 0) {
    return { query: String(query ?? ''), hits: [], complete: true, truncated: false }
  }
  const sessions = searchSessions(query)
  const messages = searchMessages(query, { limit: capped })
  const files = await searchFiles(query)

  const hits = [...sessions.hits, ...messages.hits, ...files.hits].slice(0, capped)
  return {
    query: String(query ?? ''),
    hits,
    // 任一路被截断就如实说明"这不是全部结果"
    complete: sessions.complete && messages.complete && files.complete,
    truncated: hits.length >= capped || !messages.complete || !files.complete,
  }
}
