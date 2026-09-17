/**
 * 模型请求日志（内存环形缓冲）。
 *
 * 记录每次模型调用的耗时、状态、token 用量，供 Web 端的「请求追踪」面板查看。
 *
 * 设计取舍：
 * - **只在内存里**，进程重启即清空 —— 本构建无云服务，不上报、不落盘，
 *   也不写进会话文件（避免把调试数据混进用户的对话记录）。
 * - 环形缓冲，只保留最近 MAX_ENTRIES 条，防止长会话把内存吃满。
 * - 记录**失败**的请求同样重要 —— 排查"为什么卡住"时，失败的那条往往是关键。
 */

const MAX_ENTRIES = 500

/** @type {Array<{id:number, at:number, durationMs:number, model:string, ok:boolean, code:string|null, error:string|null, inputTokens:number, outputTokens:number, sessionId:string|null}>} */
const entries = []
let nextId = 1

/**
 * 记录一次模型请求。
 * @param {{at?:number, durationMs:number, model:string, ok:boolean, code?:string|null,
 *          error?:string|null, inputTokens?:number, outputTokens?:number, sessionId?:string|null}} e
 */
export function recordRequest(e) {
  const entry = {
    id: nextId++,
    at: e.at ?? Date.now(),
    durationMs: e.durationMs,
    model: e.model ?? '',
    ok: Boolean(e.ok),
    code: e.code ?? null,
    // 错误信息截断，避免把超长堆栈塞进面板
    error: e.error ? String(e.error).slice(0, 300) : null,
    inputTokens: e.inputTokens ?? 0,
    outputTokens: e.outputTokens ?? 0,
    sessionId: e.sessionId ?? null,
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  return entry
}

/** 最近的请求记录（新的在前）。 */
export function listRequests(limit = 200) {
  const n = Math.max(1, Math.min(Number(limit) || 200, MAX_ENTRIES))
  return entries.slice(-n).reverse()
}

/** 清空记录。 */
export function clearRequests() {
  const n = entries.length
  entries.length = 0
  return n
}

/** 汇总（面板顶部的统计条用）。 */
export function requestSummary() {
  let ok = 0
  let failed = 0
  let totalMs = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const e of entries) {
    if (e.ok) ok++
    else failed++
    totalMs += e.durationMs
    inputTokens += e.inputTokens
    outputTokens += e.outputTokens
  }
  const n = entries.length
  return {
    count: n,
    ok,
    failed,
    avgMs: n > 0 ? Math.round(totalMs / n) : 0,
    maxMs: n > 0 ? Math.max(...entries.map(e => e.durationMs)) : 0,
    inputTokens,
    outputTokens,
  }
}
