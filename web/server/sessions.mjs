/**
 * 会话存储 + 磁盘持久化。
 *
 * 原先纯内存，服务重启即失忆。现在把会话写到 `~/.limkenion-web/sessions.json`
 * （可用 LIMKENION_WEB_STATE_DIR 覆盖），启动时恢复；写入做 800ms 防抖，避免频繁落盘。
 *
 * 不可序列化的运行时状态（cancelled、Set 形式的 allowedTools/enabledTools）单独处理：
 * 持久化时转数组，恢复时转回 Set；cancelled 不落盘。
 *
 * 会话删除时通过 onSessionDeleted 钩子通知外部（引擎据此清理定时器），
 * 这样 sessions 不需要反向依赖引擎。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { broadcast } from './bus.mjs'

/** 状态目录：默认 ~/.limkenion-web。 */
export const STATE_DIR = process.env.LIMKENION_WEB_STATE_DIR ?? join(homedir(), '.limkenion-web')
const STATE_FILE = join(STATE_DIR, 'sessions.json')
const MAX_PERSISTED_SESSIONS = 50

const sessions = new Map()
const deleteHooks = []

/** 注册会话删除回调（引擎用它清理定时器）。 */
export function onSessionDeleted(fn) {
  deleteHooks.push(fn)
}

function newSessionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 新建会话对象（不落库，供反序列化复用）。 */
function blankSession(id) {
  return {
    id: id ?? newSessionId(),
    title: '新会话',
    updatedAt: Date.now(),
    messages: [],
    cancelled: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    turnCount: 0,
    toolCallCount: 0,
    todos: [],
    tasks: [],
    team: { name: null, members: [], log: [] },
    settings: {},
    planMode: false,
    filesChanged: [],
    tags: [],
    allowedTools: new Set(),
    enabledTools: new Set(),
  }
}

export function createSession() {
  const session = blankSession()
  sessions.set(session.id, session)
  schedulePersist()
  return session
}

export function getSession(id) {
  return sessions.get(id)
}

export function allSessions() {
  return sessions.values()
}

export function sessionCount() {
  return sessions.size
}

export function sessionInfo(s) {
  return {
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    planMode: Boolean(s.planMode),
    tags: s.tags ?? [],
  }
}

export function allSessionInfo() {
  return [...sessions.values()].map(sessionInfo)
}

/** 广播会话列表变化（前端侧栏据此刷新）。 */
export function broadcastSessions() {
  broadcast(() => ({ type: 'sessions_changed', sessions: allSessionInfo() }))
}

export function deleteSession(id) {
  const s = sessions.get(id)
  if (!s) return false
  s.cancelled = true
  sessions.delete(id)
  for (const fn of deleteHooks) {
    try {
      fn(id)
    } catch { /* 钩子异常不影响删除 */ }
  }
  if (sessions.size === 0) createSession()
  schedulePersist()
  return true
}

/** 汇总统计（跨全部会话）。 */
export function collectStats(session, startedAt) {
  let total = { inputTokens: 0, outputTokens: 0 }
  let turnCount = 0
  let toolCallCount = 0
  for (const s of sessions.values()) {
    total.inputTokens += s.usage.inputTokens
    total.outputTokens += s.usage.outputTokens
    turnCount += s.turnCount
    toolCallCount += s.toolCallCount
  }
  return {
    total,
    session: session?.usage ?? { inputTokens: 0, outputTokens: 0 },
    sessionCount: sessions.size,
    turnCount,
    toolCallCount,
    uptimeMs: Date.now() - startedAt,
  }
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

let persistTimer = null
let persistDisabled = false

/** 防抖落盘。 */
export function schedulePersist() {
  if (persistDisabled || persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistNow()
  }, 800)
  persistTimer.unref?.()
}

function serialize(s) {
  return {
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    // 只保留最近 200 条消息，避免状态文件无限膨胀
    messages: s.messages.slice(-200),
    usage: s.usage,
    turnCount: s.turnCount,
    toolCallCount: s.toolCallCount,
    todos: s.todos ?? [],
    tasks: s.tasks ?? [],
    team: s.team ?? { name: null, members: [], log: [] },
    settings: s.settings ?? {},
    planMode: Boolean(s.planMode),
    filesChanged: s.filesChanged ?? [],
    tags: s.tags ?? [],
    allowedTools: [...(s.allowedTools ?? [])],
    enabledTools: [...(s.enabledTools ?? [])],
  }
}

/** 立即落盘（进程退出前也会调用）。 */
export async function persistNow() {
  if (persistDisabled) return
  try {
    await mkdir(STATE_DIR, { recursive: true })
    const list = [...sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_PERSISTED_SESSIONS)
      .map(serialize)
    await writeFile(STATE_FILE, JSON.stringify({ version: 1, sessions: list }, null, 1), 'utf8')
  } catch (err) {
    // 落盘失败不应影响服务运行，只提示一次
    persistDisabled = true
    console.warn(`会话持久化失败，已停用（${STATE_FILE}）：`, String(err))
  }
}

/** 启动时恢复会话。 */
export async function loadPersisted() {
  let raw
  try {
    raw = await readFile(STATE_FILE, 'utf8')
  } catch {
    return 0
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.sessions) ? parsed.sessions : []
    let restored = 0
    for (const item of list) {
      if (!item?.id) continue
      const s = blankSession(item.id)
      s.title = typeof item.title === 'string' ? item.title : '新会话'
      s.updatedAt = Number(item.updatedAt) || Date.now()
      s.messages = Array.isArray(item.messages) ? item.messages : []
      s.usage = item.usage ?? s.usage
      s.turnCount = Number(item.turnCount) || 0
      s.toolCallCount = Number(item.toolCallCount) || 0
      s.todos = Array.isArray(item.todos) ? item.todos : []
      s.tasks = Array.isArray(item.tasks) ? item.tasks : []
      s.team = item.team ?? s.team
      s.settings = item.settings ?? {}
      s.planMode = Boolean(item.planMode)
      s.filesChanged = Array.isArray(item.filesChanged) ? item.filesChanged : []
      s.tags = Array.isArray(item.tags) ? item.tags : []
      s.allowedTools = new Set(Array.isArray(item.allowedTools) ? item.allowedTools : [])
      s.enabledTools = new Set(Array.isArray(item.enabledTools) ? item.enabledTools : [])
      // 计划模式不跨进程恢复，避免重启后模型仍被静默限制
      s.planMode = false
      sessions.set(s.id, s)
      restored++
    }
    return restored
  } catch (err) {
    console.warn(`会话状态文件解析失败，忽略（${STATE_FILE}）：`, String(err))
    return 0
  }
}

export { STATE_FILE }
