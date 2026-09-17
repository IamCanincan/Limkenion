import { jsonStringify } from '../utils/slowOperations.js'

// JSON.stringify 会原样输出 U+2028/U+2029（按 ECMA-404 合法）。当输出是
// 单行 NDJSON 时，任何以 JavaScript 行终止符语义（ECMA-262 §11.3 ——
// \n \r U+2028 U+2029）切分流式的接收方，都会把 JSON 在字符串中间截断。
// ProcessTransport 现在会静默跳过非 JSON 行而不是直接崩溃（gh-28405），
// 但被截断的碎片仍然会丢失——消息会被静默丢弃。
//
// \uXXXX 形式是等价的 JSON（解析得到相同的字符串），却永远不会被任何
// 接收方误当成行终止符。这正是 ES2019 的 “Subsume JSON” 提案和 Node 的
// util.inspect 的做法。
//
// 使用带交替的单个正则：回调对每个匹配只派发一次，比两次全串扫描更省。
const JS_LINE_TERMINATORS = /\u2028|\u2029/g

function escapeJsLineTerminators(json: string): string {
  return json.replace(JS_LINE_TERMINATORS, c =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  )
}

/**
 * 供“每行一条消息”的传输使用的 JSON.stringify。转义 U+2028 LINE SEPARATOR
 * 与 U+2029 PARAGRAPH SEPARATOR，使序列化输出不会被按行拆分的接收方破坏。
 * 输出仍是合法的 JSON，且可解析为相同的值。
 */
export function ndjsonSafeStringify(value: unknown): string {
  return escapeJsLineTerminators(jsonStringify(value))
}
