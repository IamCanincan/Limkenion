/**
 * 会话存储 + 磁盘持久化。
 *
 * 原先纯内存，服务重启即失忆。现在把会话写到 `~/.limkenion-web/sessions.json`
 * （可用 LIMKENION_WEB_STATE_DIR 覆盖），启动时恢复；写入做 800ms 防抖，避免频繁落盘。
 *
 * 不可序列化的运行时状态（cancelled、turnSeq、Set 形式的 allowedTools/enabledTools）单独处理：
 * 持久化时转数组，恢复时转回 Set；cancelled 不落盘，turnSeq 每次进程启动从 0 重来
 * （回合都是进程内的，跨进程沿用旧代次没有意义）。
 *
 * 会话删除时通过 onSessionDeleted 钩子通知外部（引擎据此清理定时器），
 * 这样 sessions 不需要反向依赖引擎。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
    turnSeq: 0,
    // 沙箱根按会话（进入 git worktree 后会变）。见 paths.mjs —— 注意它**必须落盘**，
    // 否则刷新页面/重启服务之后，会话还在 worktree 里工作文件却写回了原目录。
    workspaceRoot: null,
    workspaceAdditions: [],
    worktree: null,
  }
}

// ---------------------------------------------------------------------------
// 回合代次（运行时状态，不落盘）
// ---------------------------------------------------------------------------

/**
 * 开始一个回合：推进代次并返回"我这一代"。
 *
 * 为什么需要代次，而不是只看 `cancelled`：它是个**共享的布尔值**。
 * 用户按 Esc 中断之后马上再发一条，协议层会把 `cancelled` 置回 false ——
 * 此时**上一个回合会"复活"**，和新回合同时跑：两边都往同一个会话里写消息，
 * 被中断那一轮的工具还会继续执行（写文件、跑命令），而用户以为已经停了。
 *
 * 代次把"谁在跑"变成回合自己的属性：代次对不上 = 这个回合已过期，
 * 无论它正卡在哪个 await 上，下次边界检查就会停下。
 */
export function beginTurn(session) {
  session.turnSeq = (session.turnSeq ?? 0) + 1
  return session.turnSeq
}

/** 中断会话：置标志并推进代次，让在途回合立刻过期。 */
export function cancelSession(session) {
  if (!session) return
  session.cancelled = true
  session.turnSeq = (session.turnSeq ?? 0) + 1
}

/** 该回合是否已过期（被中断，或被后来的回合顶掉）。 */
export function turnExpired(session, seq) {
  return (session.turnSeq ?? 0) !== seq
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

/**
 * 从某个会话分叉出一个新会话（对应 CLI 的 `/branch`）。
 *
 * 复制的是**对话状态**（消息、设置、待办、任务、改动记录、用量计数），
 * 不复制运行时状态（cancelled / 定时器）。新会话是独立的一份，改它不影响源会话。
 *
 * @param {object} source 源会话
 * @param {string} [title] 新会话标题；省略则用「源标题（分叉）」
 * @param {number} [atIndex] 只复制到第 atIndex 条消息（含）。省略则复制全部。
 *   给 `atIndex` 就是"在此处分叉"——前端从某条消息上点分叉时用。
 * @returns {object|null} 新会话
 */
export function forkSession(source, title, atIndex) {
  if (!source) return null
  const forked = blankSession()
  const cut = Number.isInteger(atIndex)
    ? Math.max(0, Math.min(atIndex + 1, source.messages.length))
    : source.messages.length

  // 消息浅拷贝：消息对象本身在两侧都不再被原地修改（引擎每轮 push 新对象），
  // 但 images / toolCalls 是数组，深拷一层避免共享引用。
  forked.messages = source.messages.slice(0, cut).map(m => ({
    ...m,
    images: m.images ? m.images.map(i => ({ ...i })) : undefined,
    toolCalls: m.toolCalls ? m.toolCalls.map(t => ({ ...t })) : undefined,
  }))

  const trimmed = String(title ?? '').trim()
  forked.title = trimmed ? trimmed.slice(0, 40) : `${source.title}（分叉）`
  forked.settings = { ...(source.settings ?? {}) }
  forked.planMode = Boolean(source.planMode)
  forked.tags = [...(source.tags ?? [])]
  forked.usage = { ...source.usage }
  forked.turnCount = source.turnCount
  forked.toolCallCount = source.toolCallCount
  forked.filesChanged = [...source.filesChanged]
  forked.todos = (source.todos ?? []).map(t => ({ ...t }))
  forked.tasks = (source.tasks ?? []).map(t => ({ ...t }))
  forked.enabledTools = new Set(source.enabledTools ?? [])
  forked.allowedTools = new Set(source.allowedTools ?? [])
  // 沙箱根一起带过去：分叉的本意是"从这里接着干"，把根换回默认根会让人莫名其妙。
  // 代价是 **两个会话可能共用同一个 worktree 目录** —— 退出时选 remove 会删掉
  // 另一个会话正在用的目录，所以 ExitWorktree 在 remove 时依赖 git 自己的检查
  // （有未提交改动就拒绝），并在结果里说明。
  forked.workspaceRoot = source.workspaceRoot ?? null
  forked.workspaceAdditions = [...(source.workspaceAdditions ?? [])]
  forked.worktree = source.worktree ? { ...source.worktree } : null

  sessions.set(forked.id, forked)
  schedulePersist()
  return forked
}

/**
 * 回退会话到第 n 条消息（对应 CLI 的 `/rewind`，但 web 端只做对话级回退）。
 * @param {object} session
 * @param {number} keep 保留的消息条数
 * @returns {{removed: number, kept: number}}
 */
export function rewindSession(session, keep) {
  const before = session.messages.length
  const n = Math.max(0, Math.min(Math.floor(keep), before))
  session.messages = session.messages.slice(0, n)
  session.updatedAt = Date.now()
  schedulePersist()
  return { removed: before - n, kept: n }
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
  // 用 cancelSession 而不是直接写 cancelled：它同时推进代次，
  // 让正在跑的回合在下一个边界就过期，而不是等它自己检查布尔值。
  cancelSession(s)
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
    // 沙箱根必须持久化（见 blankSession 的说明）；worktree 一起存，退出时才能还原。
    workspaceRoot: s.workspaceRoot ?? null,
    workspaceAdditions: s.workspaceAdditions ?? [],
    worktree: s.worktree ?? null,
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
      // 沙箱根：只有路径**仍然存在**才恢复 —— 目录被删掉之后还按它当根，
      // 会让这个会话的所有文件操作都失败在各种奇怪的地方（而不是一句清楚的提示）。
      let root = typeof item.workspaceRoot === 'string' ? item.workspaceRoot : null
      let wt = item.worktree && typeof item.worktree?.path === 'string' ? item.worktree : null
      if (root && !existsSync(root)) {
        console.warn(`会话 ${s.id} 的沙箱根已不存在，回落到默认根：${root}`)
        root = null
        wt = null
      }
      s.workspaceRoot = root
      s.workspaceAdditions = Array.isArray(item.workspaceAdditions) ? item.workspaceAdditions : []
      s.worktree = wt
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
