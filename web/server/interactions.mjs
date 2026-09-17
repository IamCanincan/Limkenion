/**
 * 交互通道：权限确认与 AskUserQuestion 问答。
 *
 * 两个要点：
 *   1. 请求走 broadcast 而不是发给单个连接 —— 回合事件本来就是广播的，
 *      弹窗只发给发起连接会导致「第二个标签页看不到弹窗 → 挂到超时自动拒绝」。
 *   2. escalate 优先级最高：命中 shell 守卫（工作区外路径、敏感文件）或
 *      本回合接触过不可信外部内容时，即使「本会话总是允许」、即使 bypassPermissions，
 *      也必须重新弹窗确认。
 */

import { broadcast } from './bus.mjs'
import { settingsFor } from './config.mjs'
import { ruleDecision } from './settings.mjs'
import { DANGEROUS_TOOLS } from './tools.mjs'

const pendingPermissions = new Map()
const pendingQuestions = new Map()
let permissionSeq = 0
let questionSeq = 0

const PERMISSION_TIMEOUT_MS = 120_000
const QUESTION_TIMEOUT_MS = 300_000

/** 计划模式下允许放行的工具（只读 + 流程类）。 */
const PLAN_MODE_ALLOWED = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch',
  'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput',
  'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'Skill', 'ToolSearch', 'Config', 'Sleep',
])

/**
 * 判断某次工具调用是否需要弹窗确认。
 * @param {object} session
 * @param {string} toolName
 * @param {{escalate?: string, input?: object, hook?: 'allow'|'ask'}} [opts]
 *   escalate 非空表示强制确认（无视权限模式与「总是允许」）；
 *   hook 是 PreToolUse 钩子的判定（`allow` 免确认、`ask` 强制确认）。
 */
export function needsPermission(session, toolName, opts = {}) {
  const mode = settingsFor(session).permissionMode

  // 计划模式：只读放行，其余一律拒绝（由 requestPermission 直接返回 deny）
  if (mode === 'plan') return !PLAN_MODE_ALLOWED.has(toolName)

  // 升级确认：shell 守卫或不可信内容触发，优先级高于一切 —— 包括设置文件里的 allow 规则
  // 和**钩子的 allow**（升级的意义就是"这次不算数，重新问一遍"）
  if (opts.escalate) return true

  // 钩子说"问一下"：强制确认
  if (opts.hook === 'ask') return true

  // 设置文件里的权限规则（与 CLI 同一套 settings.json）。
  // `ask` 优先于 `allow`：更保守的一侧赢。**设置里的 ask 也压过钩子的 allow** ——
  // 用户手写的规则比脚本的判定更该被信任。
  const rule = ruleDecision(toolName, opts.input)
  if (rule === 'ask') return true

  // 钩子明确放行 → 免确认（但上面的 escalate / ask 已经先返回了）
  if (opts.hook === 'allow') return false

  if (rule === 'allow') return false

  if (!DANGEROUS_TOOLS.has(toolName)) return false
  if (session.allowedTools?.has(toolName)) return false

  if (mode === 'bypassPermissions') return false
  if (mode === 'acceptEdits') {
    return !['Write', 'Edit', 'NotebookEdit'].includes(toolName)
  }
  return true
}

/** 计划模式下的拒绝理由。 */
export function planModeDenial() {
  return '当前处于计划模式，禁止执行有副作用的操作。请先用 ExitPlanMode 提交方案并等待批准。'
}

/**
 * 广播权限请求并等待应答。
 * @returns {Promise<'allow'|'always'|'deny'>}
 */
export function requestPermission(session, toolName, input, opts = {}) {
  const mode = settingsFor(session).permissionMode
  if (mode === 'plan' && !PLAN_MODE_ALLOWED.has(toolName)) return Promise.resolve('deny')

  return new Promise(resolvePermission => {
    const requestId = 'perm_' + ++permissionSeq
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestId)
      resolvePermission('deny')
    }, PERMISSION_TIMEOUT_MS)
    pendingPermissions.set(requestId, {
      resolve: decision => {
        clearTimeout(timer)
        pendingPermissions.delete(requestId)
        resolvePermission(decision)
      },
    })
    broadcast({
      type: 'permission_request',
      sessionId: session.id,
      requestId,
      toolName,
      input,
      permissionMode: mode,
      // 升级确认时把原因一并告诉前端，用户才知道为什么又被问了
      escalate: opts.escalate ?? null,
    })
  })
}

/** 处理前端应答。 */
export function resolvePermission(requestId, decision) {
  const pending = pendingPermissions.get(requestId)
  if (!pending) return false
  pending.resolve(decision === 'allow' ? 'allow' : decision === 'always' ? 'always' : 'deny')
  return true
}

/**
 * 广播 AskUserQuestion 并等待作答。
 * @returns {Promise<{question:string, answer:string|string[]}[]>}
 */
export function requestQuestions(session, questions) {
  return new Promise(resolveAnswers => {
    const requestId = 'ask_' + ++questionSeq
    const timer = setTimeout(() => {
      pendingQuestions.delete(requestId)
      resolveAnswers(questions.map(q => ({ question: q.question, answer: '（用户未作答，超时）' })))
    }, QUESTION_TIMEOUT_MS)
    pendingQuestions.set(requestId, {
      resolve: answers => {
        clearTimeout(timer)
        pendingQuestions.delete(requestId)
        resolveAnswers(answers)
      },
    })
    broadcast({ type: 'question_request', sessionId: session.id, requestId, questions })
  })
}

/** 处理前端作答。 */
export function resolveQuestions(requestId, answers) {
  const pending = pendingQuestions.get(requestId)
  if (!pending) return false
  pending.resolve(Array.isArray(answers) ? answers : [])
  return true
}

/** 待处理请求数（供 /status 展示）。 */
export function pendingCounts() {
  return { permissions: pendingPermissions.size, questions: pendingQuestions.size }
}
