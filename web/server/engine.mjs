/**
 * Agent 引擎：回合循环、只读子代理、定时任务、mock 兜底。
 *
 * 回合事件一律 broadcast（前端按 sessionId 过滤），因此这里不再需要 ws 参数。
 *
 * 危险工具的执行前检查顺序：
 *   1. shell 守卫（analyzeShellCommand）—— 灾难性命令硬拒绝，工作区外路径升级确认；
 *   2. 权限策略（needsPermission）—— 含不可信内容触发的升级确认；
 *   3. 执行，结果回灌。
 */

import { chatCompletion, getApiKey } from './deepseek.mjs'
import { broadcast } from './bus.mjs'
import {
  applySessionSetting,
  MAX_SUBAGENT_ROUNDS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_ROUNDS,
  resolveEffort,
  settingsFor,
  sleep,
} from './config.mjs'
import {
  needsPermission,
  planModeDenial,
  requestPermission,
  requestQuestions,
} from './interactions.mjs'
import { allSessions, broadcastSessions, schedulePersist } from './sessions.mjs'
import { deniedBy } from './settings.mjs'
import { analyzeShellCommand, hasUntrusted, UNTRUSTED_NOTE, untrustedInfo } from './security.mjs'
import { deferredHint, enableTools, schemasFor } from './toolindex.mjs'
import { executeTool, isSubAgentTool, summarizeToolInput, TOOL_SCHEMAS } from './tools.mjs'
import { recordRequest } from './requestLog.mjs'

function newMessageId() {
  return `m_${Math.random().toString(36).slice(2, 10)}`
}

export { newMessageId }

function baseSystemPrompt() {
  return (
    '你是 Limkenion，一个高效的中文编程助手，工作区为当前项目目录。' +
    '需要文件内容、搜索、执行命令时先调用工具，再基于结果回答。' +
    '用 Markdown 回答，代码放在代码块中。修改文件/执行命令前系统会请求用户确认。' +
    '多步任务用 TodoWrite 维护清单；非平凡的实现任务可先用 EnterPlanMode 设计方案再实施。\n\n' +
    UNTRUSTED_NOTE +
    '\n\n' +
    deferredHint()
  )
}

/**
 * 把会话历史映射为 chat-completions 消息数组（跳过 system 回显和工具元数据）。
 *
 * 跳过 system 这一点是 `/btw` 语义成立的前提：命令输出在会话里存成 role:'system'，
 * 因此「旁路回答」会显示在界面上，但不会被发给模型。导出供测试直接验证。
 */
export function sessionToWireMessages(session) {
  const messages = [{ role: 'system', content: baseSystemPrompt() }]
  for (const m of session.messages) {
    if (m.role === 'user') {
      // 图片输入：走多模态 content parts
      if (Array.isArray(m.images) && m.images.length > 0) {
        const parts = [{ type: 'text', text: m.text || '' }]
        for (const img of m.images) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
        }
        messages.push({ role: 'user', content: parts })
      } else {
        messages.push({ role: 'user', content: m.text })
      }
    } else if (m.role === 'assistant' && m.text) {
      messages.push({ role: 'assistant', content: m.text })
    }
  }
  return messages
}

/** 工具返回值的归一化：字符串 或 { text, diff }。 */
function normalizeToolResult(r) {
  if (typeof r === 'string') return { text: r, diff: undefined }
  if (r && typeof r === 'object') return { text: String(r.text ?? ''), diff: r.diff }
  return { text: String(r ?? ''), diff: undefined }
}

/** 回灌给模型的工具结果做体积上限。 */
function capResult(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  const head = Math.floor(MAX_TOOL_RESULT_CHARS * 0.5)
  const tail = MAX_TOOL_RESULT_CHARS - head
  return (
    text.slice(0, head) +
    `\n\n…（结果过长，中间省略 ${text.length - MAX_TOOL_RESULT_CHARS} 字符）…\n\n` +
    text.slice(text.length - tail)
  )
}

/** 供 WebFetch 用的提炼器：把小模型当"读页面"用。 */
function makeSummarizer(session) {
  return async (content, prompt) => {
    if (!getApiKey()) return null
    try {
      const res = await chatCompletion({
        model: settingsFor(session).model,
        messages: [
          {
            role: 'system',
            content:
              '你是一个网页内容提炼器。只依据给定内容回答，不要补充外部知识。' +
              '引用原文时单次不超过 125 字符。输出简洁的要点。',
          },
          { role: 'user', content: `网页内容：\n---\n${content}\n---\n\n${prompt}` },
        ],
        tools: [],
        // 提炼是纯抽取任务，不需要推理链：关掉思考更快也更省。
        // （`none` 是实测唯一能关掉思考链的取值。）
        reasoningEffort: 'none',
      })
      return res.text ?? null
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// 主回合
// ---------------------------------------------------------------------------

/**
 * 单个 agent 回合：模型 ⇄ 工具多轮迭代，直到最终回答（或轮次上限）。
 * 事件流：assistant_reasoning / assistant_delta / tool_call / tool_result / notice。
 */
async function runDeepSeekTurn(session, text, emit) {
  const settings = settingsFor(session)
  const messages = sessionToWireMessages(session)
  let totalUsage = { inputTokens: 0, outputTokens: 0 }
  let answer = ''
  let reasoning = ''
  // 循环是因为"模型不再调工具"而正常结束，还是撞到了轮次上限？
  // 撞上限时必须明说 —— 否则用户只看到半截回答，不知道为什么停了。
  let finishedNaturally = false

  // ---- 工具执行上下文：把客户端交互能力注入给工具实现 ----
  const ctx = {
    session,
    emit,
    settings,
    summarize: makeSummarizer(session),
    markUntrusted: undefined, // 由 tools 直接调用 security.markUntrusted
    notifyUntrusted: msg => emit({ type: 'notice', text: msg }),
    askQuestions: questions => requestQuestions(session, questions),
    scheduleCron: entry => scheduleCron(session, entry),
    // 定时任务的查看与取消 —— 与 scheduleCron 一样经 ctx 注入，
    // 避免 tools.mjs 反向 import engine.mjs 形成循环依赖。
    cronList: () => cronList(),
    cronRemove: id => removeCron(id),
    applySetting: (key, value) => {
      const ok = applySessionSetting(session, key, value)
      return ok
    },
    enableTools: names => enableTools(session, names),
    runSubAgent: ({ description, prompt }) => runSubAgent(session, prompt, description, emit),
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (session.cancelled) break

    // 记录这次模型请求的耗时/状态/token —— 供 Web 端的「请求追踪」面板查看。
    // 成功与失败都记：排查"为什么卡住"时，失败那条往往是关键。
    const requestAt = Date.now()
    let usage
    let toolCalls
    try {
      ;({ usage, toolCalls } = await chatCompletion({
        model: settings.model,
        messages,
        tools: schemasFor(session),
        // 推理强度：设置里没指定就不带该参数（由服务端默认）。
        // max 在非 v4-pro 上会降级为 high，与 CLI 一致。
        reasoningEffort: resolveEffort(settings.model, settings.effortLevel),
        onDelta: ev => {
          if (ev.type === 'reasoning') {
            reasoning += ev.delta
            emit({ type: 'assistant_reasoning', delta: ev.delta })
          } else if (ev.type === 'text') {
            answer += ev.delta
            emit({ type: 'assistant_delta', delta: ev.delta })
          }
        },
      }))
    } catch (err) {
      recordRequest({
        at: requestAt,
        durationMs: Date.now() - requestAt,
        model: settings.model,
        ok: false,
        code: err?.code ?? null,
        error: err?.message ?? String(err),
        sessionId: session.id,
      })
      throw err
    }
    recordRequest({
      at: requestAt,
      durationMs: Date.now() - requestAt,
      model: settings.model,
      ok: true,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      sessionId: session.id,
    })
    totalUsage.inputTokens += usage.inputTokens
    totalUsage.outputTokens += usage.outputTokens

    // 无工具调用 → 本轮即最终回答
    if (!toolCalls || toolCalls.length === 0) {
      finishedNaturally = true
      break
    }

    // 记录 assistant 的工具调用意图
    messages.push({
      role: 'assistant',
      content: answer.length > 0 ? answer : null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    for (const tc of toolCalls) {
      if (session.cancelled) break

      let input = {}
      try {
        input = tc.arguments ? JSON.parse(tc.arguments) : {}
      } catch {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '参数解析失败：' + String(tc.arguments).slice(0, 200),
        })
        continue
      }

      // ---- 0. 设置文件里的 deny 规则：硬拦截，不弹确认 ----
      // 用户显式写了 `permissions.deny`，就该直接挡住 —— 给弹窗等于把决定权又还回去。
      const denyReason = deniedBy(tc.name, input)
      if (denyReason) {
        const deniedId = 'tc_' + Math.random().toString(36).slice(2, 10)
        emit({
          type: 'tool_call',
          toolCall: {
            id: deniedId,
            name: tc.name,
            input: summarizeToolInput(tc.name, input),
            inputDetail: tc.arguments,
            status: 'error',
          },
        })
        emit({ type: 'tool_result', toolCallId: deniedId, ok: false, result: denyReason, durationMs: 0 })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: denyReason })
        continue
      }

      // ---- 1. shell 守卫 ----
      const shellVerdict = analyzeShellCommand(tc.name, input.command ?? input.code ?? '')
      if (shellVerdict.block) {
        const blockedId = 'tc_' + Math.random().toString(36).slice(2, 10)
        const reason = `已拒绝执行：${shellVerdict.block}`
        emit({
          type: 'tool_call',
          toolCall: {
            id: blockedId,
            name: tc.name,
            input: summarizeToolInput(tc.name, input),
            inputDetail: tc.arguments,
            status: 'error',
          },
        })
        emit({ type: 'tool_result', toolCallId: blockedId, ok: false, result: reason, durationMs: 0 })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: reason })
        continue
      }

      // ---- 2. 权限确认（含不可信内容与工作区外路径的升级确认）----
      let escalate = shellVerdict.escalate
      if (!escalate && hasUntrusted(session)) {
        escalate = `本回合接触过外部内容（${untrustedInfo(session)?.source ?? 'web'}），危险操作需重新确认`
      }
      if (needsPermission(session, tc.name, { escalate, input })) {
        const decision = await requestPermission(session, tc.name, input, { escalate })
        if (decision === 'always') {
          session.allowedTools = session.allowedTools || new Set()
          session.allowedTools.add(tc.name)
        }
        if (decision !== 'allow' && decision !== 'always') {
          const deniedId = 'tc_' + Math.random().toString(36).slice(2, 10)
          const mode = settingsFor(session).permissionMode
          const reason = mode === 'plan'
            ? planModeDenial()
            : '用户拒绝了此操作，请改用其他方式或询问用户。'
          emit({
            type: 'tool_call',
            toolCall: {
              id: deniedId,
              name: tc.name,
              input: summarizeToolInput(tc.name, input),
              inputDetail: tc.arguments,
              status: 'error',
            },
          })
          emit({ type: 'tool_result', toolCallId: deniedId, ok: false, result: reason, durationMs: 0 })
          messages.push({ role: 'tool', tool_call_id: tc.id, content: reason })
          continue
        }
      }

      const tcId = 'tc_' + Math.random().toString(36).slice(2, 10)
      emit({
        type: 'tool_call',
        toolCall: {
          id: tcId,
          name: tc.name,
          input: summarizeToolInput(tc.name, input),
          inputDetail: tc.arguments,
          status: 'running',
        },
      })
      const startedAt = Date.now()
      let ok = true
      let result
      let diff
      try {
        const raw = await executeTool(tc.name, input, ctx)
        const normalized = normalizeToolResult(raw)
        result = normalized.text
        diff = normalized.diff
        // 记录写盘工具，供 /diff 汇总
        if (diff && input.file_path && !session.filesChanged.includes(input.file_path)) {
          session.filesChanged.push(input.file_path)
        }
        if (diff && input.notebook_path && !session.filesChanged.includes(input.notebook_path)) {
          session.filesChanged.push(input.notebook_path)
        }
      } catch (err) {
        ok = false
        result = '工具执行失败：' + String(err.message ?? err)
      }
      const durationMs = Date.now() - startedAt
      emit({ type: 'tool_result', toolCallId: tcId, ok, result, durationMs, diff })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: capResult(result) })

      // 下一轮让模型基于工具结果继续；正文已发出，重置以避免重复拼接
      if (answer.length > 0) {
        answer = ''
        emit({ type: 'assistant_delta', delta: '\n\n' })
      }
    }
  }

  // 撞到工具轮次上限就明说 —— 静默停止会让用户以为模型"答完了"。
  if (!finishedNaturally && !session.cancelled) {
    emit({
      type: 'assistant_delta',
      delta:
        `\n\n---\n\n⚠️ 已达到工具调用轮次上限（${MAX_TOOL_ROUNDS} 轮），本轮提前结束。` +
        '如果任务确实需要更多轮，建议拆成几步分别提。',
    })
  }

  session.lastReasoning = reasoning
  return totalUsage
}

/**
 * 只读子代理（Agent 工具）：独立上下文跑一个小循环，只允许只读工具。
 * 内部工具调用以 `Agent·<工具>` 的形式冒泡到界面，保持过程可见。
 */
async function runSubAgent(session, prompt, description, emit) {
  if (!getApiKey()) {
    return `（mock 引擎）子代理「${description ?? 'task'}」无法执行：未设置 DEEPSEEK_API_KEY。`
  }
  const subTools = TOOL_SCHEMAS.filter(s => isSubAgentTool(s.function.name))
  const messages = [
    {
      role: 'system',
      content:
        '你是一个只读探查子代理。只能使用给定的只读工具（读文件/搜索/抓网页）。' +
        '不要试图修改文件。完成后用简洁的中文给出结论与关键证据（文件:行号）。\n\n' +
        UNTRUSTED_NOTE,
    },
    { role: 'user', content: prompt },
  ]
  let answer = ''
  let finishedNaturally = false
  const ctx = {
    session,
    emit,
    settings: settingsFor(session),
    summarize: makeSummarizer(session),
    notifyUntrusted: msg => emit({ type: 'notice', text: msg }),
    // 子代理内不允许反问/定时/改设置/再派子代理
    askQuestions: undefined,
    scheduleCron: undefined,
    cronList: undefined,
    cronRemove: undefined,
    applySetting: undefined,
    enableTools: undefined,
    runSubAgent: undefined,
  }

  for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
    if (session.cancelled) break
    const { toolCalls } = await chatCompletion({
      model: settingsFor(session).model,
      messages,
      tools: subTools,
      reasoningEffort: resolveEffort(settingsFor(session).model, settingsFor(session).effortLevel),
      onDelta: ev => {
        if (ev.type === 'text') answer += ev.delta
      },
    })
    if (!toolCalls || toolCalls.length === 0) {
      finishedNaturally = true
      break
    }

    messages.push({
      role: 'assistant',
      content: answer.length > 0 ? answer : null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    for (const tc of toolCalls) {
      if (session.cancelled) break
      let input = {}
      try {
        input = tc.arguments ? JSON.parse(tc.arguments) : {}
      } catch {
        input = {}
      }
      const tcId = 'tc_' + Math.random().toString(36).slice(2, 10)
      emit({
        type: 'tool_call',
        toolCall: {
          id: tcId,
          name: `Agent·${tc.name}`,
          input: summarizeToolInput(tc.name, input),
          inputDetail: tc.arguments,
          status: 'running',
        },
      })
      const startedAt = Date.now()
      let ok = true
      let result
      try {
        result = normalizeToolResult(await executeTool(tc.name, input, ctx)).text
      } catch (err) {
        ok = false
        result = '工具执行失败：' + String(err.message ?? err)
      }
      emit({ type: 'tool_result', toolCallId: tcId, ok, result, durationMs: Date.now() - startedAt })
      messages.push({ role: 'tool', tool_call_id: tc.id, content: capResult(result) })
      if (answer.length > 0) answer = ''
    }
  }
  // 撞到轮次上限时给父模型一个**明确说法** —— 原来只回「（子代理未产出结论）」，
  // 父模型根本不知道是"子代理空转完了"还是"任务太大做不完"，于是容易反复重派。
  if (!finishedNaturally && !session.cancelled) {
    return (
      `（子代理已达轮次上限 ${MAX_SUBAGENT_ROUNDS} 轮，未给出结论）\n` +
      '它已经做过的探查：' +
      (answer.trim() ? answer.trim().slice(0, 400) : '（无正文产出，可能一直在重复调用工具）') +
      '\n建议：把任务拆得更具体，或改用主对话直接做。'
    )
  }
  return answer.trim() || '（子代理未产出结论）'
}

/** 无 API key 时的降级 mock（保留协议演示能力）。 */
async function runMockTurn(session, text, emit) {
  const reply =
    '**[mock 引擎]** 未检测到 DEEPSEEK_API_KEY，当前为模拟回复。\n\n' +
    `设置环境变量后重启服务即可接入真实 DeepSeek（含全部 ${TOOL_SCHEMAS.length} 个工具）：\n\n` +
    '```bash\nset DEEPSEEK_API_KEY=sk-你的密钥\nlimkenion-web\n```\n\n' +
    `收到：「${text}」（模型：\`${settingsFor(session).model}\`）`
  for (const chunk of reply.match(/[\s\S]{1,6}/g) || []) {
    emit({ type: 'assistant_delta', delta: chunk })
    await sleep(30)
  }
  return { inputTokens: 120 + text.length, outputTokens: reply.length }
}

/** 统一回合入口：真实引擎优先，失败时把错误作为正文反馈。 */
async function runAgentTurn(session, text, emit) {
  if (!getApiKey()) return runMockTurn(session, text, emit)
  try {
    return await runDeepSeekTurn(session, text, emit)
  } catch (err) {
    if (session.cancelled) return { inputTokens: 0, outputTokens: 0 }
    emit({ type: 'assistant_delta', delta: '⚠️ DeepSeek 调用失败：' + String(err.message ?? err) })
    return { inputTokens: 0, outputTokens: 0 }
  }
}

/**
 * 完整跑一个回合。事件广播给所有连接（前端按 sessionId 过滤）。
 * @returns {Promise<void>}
 */
export async function runTurn(session, text, messageId = newMessageId()) {
  let acc = ''
  let reasoning = ''
  let toolCalls = []
  const emit = ev => {
    if (session.cancelled) return
    if (ev.type === 'assistant_delta') acc += ev.delta
    if (ev.type === 'assistant_reasoning') reasoning += ev.delta
    if (ev.type === 'tool_call') toolCalls.push(ev.toolCall)
    // 工具跑完要把结果**回填到自己这份记录**上，否则落盘的 toolCalls 会永远停在
    // status:'running'、没有 result / diff / durationMs —— 刷新页面或重启服务后，
    // 整条执行轨迹（包括改动 diff）就丢了。前端有自己的一份状态，所以实时界面看不出问题，
    // 只有"重载后"才暴露。
    if (ev.type === 'tool_result') {
      const tc = toolCalls.find(t => t.id === ev.toolCallId)
      if (tc) {
        tc.status = ev.ok ? 'done' : 'error'
        tc.result = ev.result
        tc.durationMs = ev.durationMs
        tc.diff = ev.diff ?? tc.diff
      }
    }
    broadcast({ sessionId: session.id, messageId, ...ev })
  }

  try {
    const usage = await runAgentTurn(session, text, emit)
    session.turnCount++
    session.toolCallCount += toolCalls.length
    if (session.cancelled) {
      session.messages.push({ id: messageId, role: 'assistant', text: acc, reasoning, toolCalls, timestamp: Date.now() })
      broadcast({ type: 'turn_cancelled', sessionId: session.id, messageId })
    } else {
      session.usage.inputTokens += usage.inputTokens
      session.usage.outputTokens += usage.outputTokens
      session.messages.push({
        id: messageId,
        role: 'assistant',
        text: acc,
        reasoning: reasoning.length > 0 ? reasoning : undefined,
        toolCalls,
        usage,
        timestamp: Date.now(),
      })
      broadcast({ type: 'turn_complete', sessionId: session.id, messageId, usage })
    }
  } catch (err) {
    broadcast({ type: 'error', message: `回合执行失败：${String(err)}` })
  }
  session.updatedAt = Date.now()
  broadcastSessions()
  schedulePersist()
}

// ---------------------------------------------------------------------------
// 会话级定时任务
// ---------------------------------------------------------------------------

let cronSeq = 0
const crons = new Map()

/**
 * 登记定时回合。
 * 注意：定时器不能看 session.cancelled —— 那个标志是「中断当前回合」用的，
 * 用户中断一次之后如果不重置，所有后续定时触发都会被静默丢掉。
 * 每次触发前显式重置为 false，让定时任务独立于上一次中断。
 */
export function scheduleCron(session, { everyMs, prompt }) {
  const id = 'cron_' + ++cronSeq
  const timer = setInterval(() => {
    // 会话已被删除（从 store 里消失）则自停，避免往孤儿会话里塞消息
    if (![...allSessions()].some(s => s.id === session.id)) {
      clearInterval(timer)
      crons.delete(id)
      return
    }
    session.cancelled = false
    void runTurnFromCron(session, prompt)
  }, everyMs)
  timer.unref?.()
  crons.set(id, { id, sessionId: session.id, everyMs, prompt, timer })
  return { id }
}

/** 定时触发的回合：作为一条用户消息走正常链路。 */
async function runTurnFromCron(session, prompt) {
  session.messages.push({
    id: newMessageId(),
    role: 'user',
    text: `[定时任务] ${prompt}`,
    timestamp: Date.now(),
  })
  const messageId = newMessageId()
  broadcast({ type: 'assistant_start', sessionId: session.id, messageId })
  await runTurn(session, prompt, messageId)
}

/** 清理某会话的全部定时器（会话被删除时调用）。 */
export function clearCronsForSession(sessionId) {
  let n = 0
  for (const [id, entry] of crons) {
    if (entry.sessionId === sessionId) {
      clearInterval(entry.timer)
      crons.delete(id)
      n++
    }
  }
  return n
}

/**
 * 按 id 删除单个定时任务（供 `/schedule remove <id>` 用）。
 * @returns {boolean} 是否真的删掉了
 */
export function removeCron(id) {
  const entry = crons.get(id)
  if (!entry) return false
  clearInterval(entry.timer)
  crons.delete(id)
  return true
}

/** 清理全部定时器（进程退出前）。 */
export function clearAllCrons() {
  for (const entry of crons.values()) clearInterval(entry.timer)
  crons.clear()
}

export function cronCount() {
  return crons.size
}

export function cronList() {
  return [...crons.values()].map(c => ({
    id: c.id,
    sessionId: c.sessionId,
    everyMs: c.everyMs,
    prompt: c.prompt,
  }))
}
