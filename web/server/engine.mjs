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
import { outputStylePrompt } from './outputStyle.mjs'
import { ensureInstructions, instructionsCached } from './instructions.mjs'
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
import {
  allSessions,
  beginTurn,
  broadcastSessions,
  schedulePersist,
  turnExpired,
} from './sessions.mjs'
import { scopeForSession, withWorkspace, workspaceRoot } from './paths.mjs'
import { additionalDirectories, deniedBy } from './settings.mjs'
import { HOOK_EVENT, hooksEnabled, runEventHooks, sessionHookInput, toolHookInput } from './hooks.mjs'

/** notice 类钩子：只播报、不参与决策 —— 派出去就不管，失败静默。 */
function fireNoticeHooks(text) {
  void runEventHooks(HOOK_EVENT.NOTICE, {
    hookInput: { session_id: '', cwd: undefined, message: text },
  }).catch(() => {})
}
import { autoCompactThreshold, compactSession } from './compact.mjs'
import { analyzeShellCommand, hasUntrusted, UNTRUSTED_NOTE, untrustedInfo } from './security.mjs'
import { deferredHint, enableTools, schemasFor } from './toolindex.mjs'
import { callMcpTool, listMcpResources, readMcpResource, getMcpPrompt, mcpRegistrySearch, mcpAuthFlow } from './mcp.mjs'
import { runWorkflow } from './workflow.mjs'
import { executeTool, isSubAgentTool, summarizeToolInput, TOOL_SCHEMAS } from './tools.mjs'
import { recordRequest } from './requestLog.mjs'
import { resolveSubagent } from './subagents.mjs'

function newMessageId() {
  return `m_${Math.random().toString(36).slice(2, 10)}`
}

export { newMessageId }

/**
 * 正在跑回合的会话（同一会话不并发跑两个回合）。
 *
 * 定时任务是唯一会"自己发起"回合的来源：间隔到了就触发。如果上一次还没跑完
 * （回合比间隔还长），再触发一次就会同一会话并发跑两个回合 —— 消息交错、
 * token 双倍消耗、界面出现两条同时在转的回复。所以要能查"这个会话忙不忙"。
 */
const activeTurns = new Set()

/** 该会话当前是否有回合在执行。 */
export function isTurnActive(sessionId) {
  return activeTurns.has(sessionId)
}

/** 项目指令块：无指令时返回空串。 */
function instructionsBlock() {
  const t = instructionsCached()
  return t ? `\n\n[项目指令（LIMKENION.md / AGENTS.md）]\n${t}` : ''
}

function baseSystemPrompt(session) {
  return (
    '你是 Limkenion，一个高效的中文编程助手，工作区为当前项目目录。' +
    '需要文件内容、搜索、执行命令时先调用工具，再基于结果回答。' +
    '用 Markdown 回答，代码放在代码块中。修改文件/执行命令前系统会请求用户确认。' +
    '多步任务用 TodoWrite 维护清单；非平凡的实现任务可先用 PlanEnter 设计方案再实施。\n\n' +
    UNTRUSTED_NOTE +
    '\n\n' +
    deferredHint() +
    // 输出风格（outputStyle）真正生效：default 时不追加任何内容
    outputStylePrompt(session?.settings?.outputStyle) +
    // 项目指令（LIMKENION.md / AGENTS.md，回合开头已由 ensureInstructions 加载）
    instructionsBlock()

  )
}

/**
 * 把会话历史映射为 chat-completions 消息数组（跳过 system 回显和工具元数据）。
 *
 * 跳过 system 这一点是 `/btw` 语义成立的前提：命令输出在会话里存成 role:'system'，
 * 因此「旁路回答」会显示在界面上，但不会被发给模型。导出供测试直接验证。
 */
export function sessionToWireMessages(session) {
  /** @type {import('./deepseek.mjs').WireMessage[]} */
  const messages = [{ role: 'system', content: baseSystemPrompt(session) }]
  for (const m of session.messages) {
    if (m.role === 'user') {
      // 图片输入：走多模态 content parts
      if (Array.isArray(m.images) && m.images.length > 0) {
        // parts 要显式标类型：从 `[{type:'text',...}]` 起步会被推断成只有 text 的数组，
        // 后面 push image_url 就报类型错（而多模态一直是对的、也一直在跑）。
        /** @type {Array<{type: string, text?: string, image_url?: {url: string}}>} */
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

/**
 * 把 `prompt-submit` 钩子给的上下文挂到**最后一条用户消息**上（只在本次请求里有效）。
 *
 * 不新插一条 system 消息：DeepSeek 侧 system 消息一般在开头，插在中间语义不稳，
 * 而 `sessionToWireMessages()` 本来就只认 user/assistant 两种角色。
 *
 * 找不到用户消息时挂到系统提示后面（正常流程里协议层已经先写了用户消息，但
 * 定时任务 / 程序化调用 `runTurn()` 时可能没有）——**不能静默丢掉**：
 * 钩子给了上下文却被无视，是最难查的那种"钩子没生效"。
 */
function attachHookContext(messages, context) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    const c = messages[i].content
    if (typeof c === 'string') messages[i].content = `${c}\n\n[prompt-submit 钩子附加]\n${context}`
    return
  }
  if (messages[0]?.role === 'system') {
    messages[0].content = `${messages[0].content}\n\n[prompt-submit 钩子附加]\n${context}`
  }
}

/** 工具返回值的归一化：字符串 或 { text, diff }。 */function normalizeToolResult(r) {
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
 *
 * @param {object} session
 * @param {string} text
 * @param {(ev: object) => void} emit
 * @param {() => boolean} expired 本回合是否已过期（被中断，或被后来的回合顶掉）
 */
/**
 * microcompact：把旧的 tool 消息内容替换为占位符（保留最近 keep 条）。
 * 与上游 CLI 原型 的 microcompact 同思路：工具结果是大头，清它们比压整段历史划算。
 * 导出供测试直接验证。
 */
export function microcompactToolResults(messages, lastInputTokens, { keep = 4 } = {}) {
  const threshold = autoCompactThreshold() - 24_000
  if ((lastInputTokens ?? 0) < threshold) return 0
  const toolIdx = []
  messages.forEach((m, i) => { if (m.role === "tool") toolIdx.push(i) })
  const victims = toolIdx.slice(0, Math.max(0, toolIdx.length - keep))
  let cleared = 0
  for (const i of victims) {
    const m = messages[i]
    if (typeof m.content === "string" && !m.content.startsWith("[microcompact]")) {
      m.content = `[microcompact] 工具结果已被清除以释放上下文（原 ${m.content.length} 字符）`
      cleared++
    }
  }
  return cleared
}

async function runDeepSeekTurn(session, text, emit, expired, hookContext) {
  const settings = settingsFor(session)
  const messages = sessionToWireMessages(session)
  // prompt-submit 钩子附加的上下文：**只影响这一次请求**，不写进会话记录 ——
  // 写进去的话之后每一轮都会重复带上，越滚越长。
  if (hookContext) attachHookContext(messages, hookContext)
  let totalUsage = { inputTokens: 0, outputTokens: 0 }
  let lastInputTokens = 0 // 最后一轮请求的输入量 —— 这才是「当前上下文有多大」的真信号
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
    notifyUntrusted: msg => {
      emit({ type: 'notice', text: msg })
      fireNoticeHooks(msg)
    },
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
    runSubAgent: ({ description, prompt, tag, agent, emit: customEmit }) =>
      runSubAgent(session, prompt, description, tag ? ev => emit({ type: 'team_event', member: tag, payload: ev }) : customEmit ?? emit, expired, tag, agent),
    // MCP：发现的工具经这里执行（tools.mjs 不反向 import mcp.mjs）。
    callMcpTool: (name, args) => callMcpTool(name, args, session),
    listMcpResources: server => listMcpResources(server),
    readMcpResource: (server, uri) => readMcpResource(server, uri),
    getMcpPrompt: (server, name, args) => getMcpPrompt(server, name, args),
    mcpAuthFlow: name => mcpAuthFlow(name),
    mcpRegistrySearch: query => mcpRegistrySearch(query),
    // 动态工作流：脚本里的每个 agent() 派一个**只读子代理**（与 Agent 工具同一套机制，
    // 所以只读保证、轮次上限、事件标记都一致）。并发与预算在 workflow.mjs 里控制。
    runWorkflow: ({ script, name, resumeFrom, args, maxAgents }) =>
      runWorkflow({
        script,
        name,
        resumeFrom,
        args,
        maxAgents,
        sessionId: session.id,
        emit: msg => {
          emit({ type: 'notice', text: msg })
          fireNoticeHooks(msg)
        },
        runAgent: (prompt, description) => runSubAgent(session, prompt, description, emit, expired),
      }),
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (expired()) break

    // ---- microcompact：回合内多轮工具时，旧工具结果（大文件读取/长命令输出）
    // ---- 是挤占上下文的大头。接近软阈值就清旧保新（保留最近 4 条），
    // ---- 让硬上限墙尽量不要撞上。工具结果本来就不进跨回合历史，
    // ---- 所以这只影响本回合内的多轮工具循环。
    microcompactToolResults(messages, lastInputTokens)

    // 回合内硬上限：软阈值（回合末自动压缩）之上再留一道墙。
    // 上一轮请求已烧到极限时，继续请求只会换来 API 报错 —— 主动收束本轮，
    // 让回合末的自动压缩接手，用户发条消息就能从摘要继续任务。
    if (lastInputTokens >= autoCompactThreshold() + 24_000) {
      emit({ type: 'notice', text: `上下文已达上限（${lastInputTokens} tokens），本轮提前收束；历史将自动压缩。` })
    fireNoticeHooks(`上下文已达上限（${lastInputTokens} tokens），本轮提前收束`)
      answer += '\n\n（上下文达到上限，本轮到此为止。历史已自动压缩，请发一条消息继续任务。）'
      finishedNaturally = true
      break
    }

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
    lastInputTokens = usage.inputTokens

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
      if (expired()) break

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

      // ---- 0. tool-before 钩子 ----
      // 钩子**先跑**（不是先判权限），这样审计类钩子能看到每一次调用 —— 包括之后被
      // deny 规则挡下的那些。钩子的 deny 是硬拒；allow 可以免确认，但**不能**覆盖
      // 设置里的 deny、shell 守卫的硬拦截，也不能绕过 escalate（见 needsPermission）。
      let hookVerdict = null
      if (hooksEnabled()) {
        hookVerdict = await runToolHooksScoped(session, HOOK_EVENT.TOOL_BEFORE, () => ({
          toolName: tc.name,
          hookInput: toolHookInput(session, tc.name, input),
        }))
        for (const m of hookVerdict.messages) emit({ type: 'notice', text: m })
        if (hookVerdict.updatedInput) {
          input = hookVerdict.updatedInput
          emit({ type: 'notice', text: `钩子改写了 ${tc.name} 的输入` })
        }
      }

      // ---- 0.5 设置文件里的 deny 规则：硬拦截，不弹确认 ----
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
      // 钩子的 deny 放在权限之前：它和权限规则一样是"决定"，不是"建议"
      if (hookVerdict?.decision === 'deny') {
        const hookDeniedId = 'tc_' + Math.random().toString(36).slice(2, 10)
        const reason = `被 tool-before 钩子拒绝：${hookVerdict.reason ?? '（钩子未给出理由）'}`
        emit({
          type: 'tool_call',
          toolCall: {
            id: hookDeniedId,
            name: tc.name,
            input: summarizeToolInput(tc.name, input),
            inputDetail: tc.arguments,
            status: 'error',
          },
        })
        emit({ type: 'tool_result', toolCallId: hookDeniedId, ok: false, result: reason, durationMs: 0 })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: reason })
        continue
      }
      if (
        needsPermission(session, tc.name, {
          escalate,
          input,
          hook: hookVerdict?.decision === 'allow' || hookVerdict?.decision === 'ask'
            ? hookVerdict.decision
            : undefined,
        })
      ) {
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
        const raw = await runToolScoped(session, tc.name, input, ctx)
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

      // ---- 3. tool-after / tool-failed 钩子 ----
      // 成功走 tool-after，抛错走 tool-failed（与 CLI 的两个事件对应）。
      // additionalContext 追加进回灌给模型的内容；钩子若 block，则用它给的理由替换结果 ——
      // 这样"格式检查失败"这类钩子能让模型看到具体哪里不对，而不是一句笼统的报错。
      if (hooksEnabled()) {
        const postEvent = ok ? HOOK_EVENT.TOOL_AFTER : HOOK_EVENT.TOOL_FAILED
        const post = await runToolHooksScoped(session, postEvent, () => ({
          toolName: tc.name,
          hookInput: toolHookInput(session, tc.name, input, { tool_result: result }),
        }))
        for (const m of post.messages) emit({ type: 'notice', text: m })
        if (post.additionalContext) {
          result = `${result}\n\n[${postEvent} 钩子附加]\n${post.additionalContext}`
        }
        if (post.decision === 'deny') {
          ok = false
          result = `被 ${postEvent} 钩子阻断：${post.reason ?? '（钩子未给出理由）'}`
        }
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
  if (!finishedNaturally && !expired()) {
    emit({
      type: 'assistant_delta',
      delta:
        `\n\n---\n\n⚠️ 已达到工具调用轮次上限（${MAX_TOOL_ROUNDS} 轮），本轮提前结束。` +
        '如果任务确实需要更多轮，建议拆成几步分别提。',
    })
  }

  session.lastReasoning = reasoning
  return { ...totalUsage, lastInputTokens }
}

/**
 * 只读子代理（Agent 工具）：独立上下文跑一个小循环，只允许只读工具。
 * 内部工具调用以 `Agent·<工具>` 的形式冒泡到界面，保持过程可见。
 */
/**
 * @param {object} session
 * @param {string} prompt
 * @param {string} description
 * @param {(ev: object) => void} emit
 * @param {() => boolean} expired
 * @param {string} [tag] 工作台成员名
 * @param {string} [agentName] 具名子代理（覆盖模型与工具子集）
 */
async function runSubAgent(session, prompt, description, emit, expired, tag, agentName) {
  // 具名子代理：只覆盖**模型**与**工具子集**，其余能力边界（不能写盘 / 不能联网写 /
  // 不能再派子代理 / 不给 MCP 通道）一律不变 —— 配置面不能成为提权的口子。
  const resolved = resolveSubagent(agentName)
  // 找不到具名子代理时**如实回「未执行」**（resolveSubagent 负责措辞）：
  // 直接 return 而文案却说"已执行"，等于对模型撒谎 —— 它会以为子代理跑过了。
  if (!resolved.ok) return resolved.error
  const agent = resolved.agent

  // 工作台模式：tag = 成员名。子代理的全部事件包装成 team_event，
  // 前端团队面板按成员分列展示 —— 否则子代理就是黑盒。
  if (tag) {
    const base = emit
    emit = ev => base({ type: 'team_event', member: tag, payload: ev })
  }
  // agent-start：与 agent-end 成对。原来只有 end 没有 start，
  // 用户配的「子代理启动」钩子永远不触发且无任何提示。
  if (hooksEnabled()) {
    try {
      const start = await runEventHooks(HOOK_EVENT.AGENT_START, {
        hookInput: sessionHookInput(session, { description: description ?? '', prompt }),
      })
      for (const m of start.messages) emit({ type: 'notice', text: m })
    } catch { /* 钩子失败不拦子代理 */ }
  }
  if (!getApiKey()) {
    return `（mock 引擎）子代理「${description ?? 'task'}」无法执行：未设置 DEEPSEEK_API_KEY。`
  }
  // 具名子代理配了 tools 就再收一层（配置已校验过，只会是只读集的子集）
  const subTools = TOOL_SCHEMAS.filter(
    s => isSubAgentTool(s.function.name) && (!agent?.tools || agent.tools.includes(s.function.name)),
  )
  const subModel = agent?.model ?? settingsFor(session).model
  /** @type {import('./deepseek.mjs').WireMessage[]} */
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
    notifyUntrusted: msg => {
      emit({ type: 'notice', text: msg })
      fireNoticeHooks(msg)
    },
    // 子代理内不允许反问/定时/改设置/再派子代理
    askQuestions: undefined,
    scheduleCron: undefined,
    cronList: undefined,
    cronRemove: undefined,
    applySetting: undefined,
    enableTools: undefined,
    runSubAgent: undefined,
    // 子代理是只读的，**不给它 MCP 通道**：MCP 工具能干什么我们看不见
    // （可能是写盘、可能是发请求），让只读子代理拿到它等于把只读保证作废。
    callMcpTool: undefined,
    listMcpResources: undefined,
    readMcpResource: undefined,
    // 子代理里不允许再派工作流（会变成"子代理套子代理"的嵌套爆炸）
    runWorkflow: undefined,
  }

  for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
    if (expired()) break
    const { toolCalls } = await chatCompletion({
      model: subModel,
      messages,
      tools: subTools,
      reasoningEffort: resolveEffort(subModel, settingsFor(session).effortLevel),
      onDelta: ev => {
        if (ev.type === 'text') { answer += ev.delta; if (tag) emit({ type: 'assistant_delta', delta: ev.delta }) }
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
      if (expired()) break
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
        result = normalizeToolResult(await runToolScoped(session, tc.name, input, ctx)).text
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
  const hitLimit = !finishedNaturally && !expired()
  if (hooksEnabled()) {
    const stop = await runEventHooks(HOOK_EVENT.AGENT_END, {
      hookInput: sessionHookInput(session, { description: description ?? '', finishedNaturally, hitLimit }),
    })
    for (const m of stop.messages) emit({ type: 'notice', text: m })
  }
  if (hitLimit) {
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
async function runAgentTurn(session, text, emit, expired, hookContext) {
  if (!getApiKey()) return runMockTurn(session, text, emit)
  try {
    return await runDeepSeekTurn(session, text, emit, expired, hookContext)
  } catch (err) {
    if (expired()) return { inputTokens: 0, outputTokens: 0 }
    emit({ type: 'assistant_delta', delta: '⚠️ DeepSeek 调用失败：' + String(err.message ?? err) })
    return { inputTokens: 0, outputTokens: 0 }
  }
}

/**
 * 本回合的沙箱作用域：会话自己的根（可能是某个 worktree）+ 设置文件里的额外目录。
 *
 * 回合里跑的一切（文件工具、shell 的 cwd、子代理、工作流、Skill 扫描）都走它，
 * 所以 `safePath()` 这类判断自动拿到正确的根 —— 不会出现"会话切了 worktree，
 * 但工具还在老根里写文件"。
 */
function sessionScope(session) {
  const base = scopeForSession(session)
  return { root: base.root, additions: [...additionalDirectories(), ...base.additions] }
}

/**
 * 在**当前**会话作用域里执行一次工具调用。
 *
 * 关键：作用域要**每次调用重新解析**，不能在回合开头算一次用到回合结束。
 * `EnterWorktree` 会把 `session.workspaceRoot` 换掉，而 AsyncLocalStorage 里
 * 已经进入的那层作用域**不会自己更新** —— 结果是"模型说进入了 worktree，
 * 紧跟着的 Write 却还写在原来的树上"（真机实测到：文件落在主仓库，worktree 里是空的，
 * 而 EnterWorktree 自己报成功，用户完全看不出来）。
 *
 * 每次调用重新进入作用域，切换在**同一回合内**立即生效 —— 这既是模型与用户的直觉，
 * 也是 CLI 的行为（那边 EnterWorktree 之后 cwd 立刻就变了）。
 */
function runToolScoped(session, name, input, ctx) {
  return withWorkspace(sessionScope(session), () => executeTool(name, input, ctx))
}

/**
 * 跑**工具相关**的钩子（tool-before / tool-after / tool-failed）。
 *
 * 两件事都必须在**当前**作用域里发生，缺一不可：
 *   1. 钩子进程的 cwd；2. **钩子输入 JSON 里的 `cwd` 字段**。
 *
 * 第 2 点尤其容易写错：`hookInput` 里带了 `cwd`，如果把它当实参在外面先构造好
 * （`runToolHooksScoped(session, ev, { hookInput: toolHookInput(...) })`），
 * 它就在**进作用域之前**求值了 —— 于是 `EnterWorktree` 之后钩子进程确实在新目录里跑，
 * 但它在 stdin 里读到的 `cwd` 还是老目录。那种"两处说法不一致"最难查。
 * 所以这里收的是**构造函数**，等进了作用域再调用。
 */
function runToolHooksScoped(session, event, buildOpts) {
  return withWorkspace(sessionScope(session), () => runEventHooks(event, buildOpts()))
}

/**
 * 完整跑一个回合。事件广播给所有连接（前端按 sessionId 过滤）。
 * @returns {Promise<void>}
 */
export async function runTurn(session, text, messageId = newMessageId()) {
  // 本回合的代次：从这一刻起，"是否还在跑"由代次说了算（见 sessions.beginTurn）。
  const seq = beginTurn(session)
  const expired = () => session.cancelled || turnExpired(session, seq)
  let acc = ''
  let reasoning = ''
  let toolCalls = []
  const emit = ev => {
    if (expired()) return
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

  activeTurns.add(session.id)
  try {
    const usage = await withWorkspace(sessionScope(session), async () => {
      // ---- 项目指令：LIMKENION.md / AGENTS.md（mtime 缓存；/init 承诺过的行为）----
      try { await ensureInstructions(workspaceRoot()) } catch { /* 指令失败不拦回合 */ }
      if (hooksEnabled() && session.turnCount === 0) {
        // setup：比 session-open 更早的"开工准备"事件（CLI 同款顺序）
        try {
          const setup = await runEventHooks(HOOK_EVENT.SETUP, {
            hookInput: sessionHookInput(session, { phase: 'web-session' }),
          })
          for (const m of setup.messages) emit({ type: 'notice', text: m })
        } catch { /* setup 失败不拦启动 */ }
      }
      // ---- session-open：只在本会话的第一个回合之前跑一次 ----
      if (hooksEnabled() && session.turnCount === 0) {
        const start = await runEventHooks(HOOK_EVENT.SESSION_OPEN, {
          hookInput: sessionHookInput(session, { source: 'web' }),
        })
        for (const m of start.messages) emit({ type: 'notice', text: m })
      }

      // ---- prompt-submit：可以往提示里加内容，也可以直接拦下 ----
      let hookContext = null
      if (hooksEnabled()) {
        const ups = await runEventHooks(HOOK_EVENT.PROMPT_SUBMIT, {
          hookInput: sessionHookInput(session, { prompt: text }),
        })
        for (const m of ups.messages) emit({ type: 'notice', text: m })
        if (ups.decision === 'deny' || ups.preventContinuation) {
          const reason = ups.reason ?? ups.stopReason ?? '被 prompt-submit 钩子拦下'
          emit({ type: 'assistant_delta', delta: `消息未发送：${reason}` })
          return { inputTokens: 0, outputTokens: 0 }
        }
        if (ups.additionalContext) {
          hookContext = ups.additionalContext
          emit({ type: 'notice', text: 'prompt-submit 钩子附加了上下文（随本条消息发给模型，不写进会话记录）' })
        }
      }

      return runAgentTurn(session, text, emit, expired, hookContext)
    })
    session.turnCount++
    session.toolCallCount += toolCalls.length
    if (expired()) {
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
    // ---- 自动压缩：上下文逼近上限时的自我保护（上游 CLI 原型 同款）----
    // 判据用「最后一轮请求的输入 tokens」—— 它就是模型实际看到的上下文大小，
    // 比自己数消息靠谱得多。压缩失败不能影响本回合已产出的结果，只如实播报。
    const overSoft = (usage.lastInputTokens ?? 0) >= autoCompactThreshold()
    const overHard = (usage.lastInputTokens ?? 0) >= autoCompactThreshold() + 24_000
    if (!expired() && overSoft && (session.messages.length > 10 || overHard)) {
      try {
        emit({ type: 'notice', text: `上下文已用到约 ${usage.lastInputTokens} tokens（阈值 ${autoCompactThreshold()}），自动压缩历史…` })
        const r = await compactSession(session, { emit, reason: '上下文接近上限，自动压缩' })
        if (!r.ok) emit({ type: 'notice', text: `自动压缩未执行：${r.skipped}` })
      } catch (err) {
        emit({ type: 'notice', text: '自动压缩失败（不影响本回合结果）：' + String(err.message ?? err) })
      }
    }
    // ---- Stop：回合正常结束后的钩子（日志、通知、检查清单之类）----
    if (hooksEnabled() && !expired()) {
      const stop = await runEventHooks(HOOK_EVENT.TURN_END, { hookInput: sessionHookInput(session, { stopped: true }) })
      for (const m of stop.messages) emit({ type: 'notice', text: m })
    }
  } catch (err) {
    broadcast({ type: 'error', message: `回合执行失败：${String(err)}` })
    // turn-failed 钩子：回合异常收尾（区别于正常的 turn-end）
    if (hooksEnabled()) {
      void runEventHooks(HOOK_EVENT.TURN_FAILED, {
        hookInput: sessionHookInput(session, { error: String(err?.message ?? err) }),
      })
    }
  } finally {
    activeTurns.delete(session.id)
  }
  session.updatedAt = Date.now()
  broadcastSessions()
  schedulePersist()

  // ---- 排队消息接续：回合期间用户发的消息按序处理（每条一个完整回合）----
  // 递归深度 = 队列长度，量级完全可控；用户中断不清队 —— 排队的意图还在。
  if (Array.isArray(session.messageQueue) && session.messageQueue.length > 0) {
    const next = session.messageQueue.shift()
    broadcast({ type: 'notice', sessionId: session.id, text: `开始处理排队的消息（剩 ${session.messageQueue.length} 条）…` })
    await runTurn(session, next.text, newMessageId())
  }
}

// ---------------------------------------------------------------------------
// Agent Teams 工作台（后端）
// ---------------------------------------------------------------------------

/** 广播团队快照（成员列表 + 状态 + 日志）。 */
function broadcastTeam(session) {
  broadcast({ type: 'team', sessionId: session.id, team: session.team ?? null })
}

export function getTeam(session) {
  return session.team ?? null
}

/**
 * 从工作台直接给某成员派一个独立回合（不等主 agent 转发）。
 * 成员置 busy → 跑只读子代理（事件按成员广播）→ 回 idle → teammate-idle 钩子。
 */
export async function runTeamMemberTurn(session, memberName, text) {
  const member = session.team?.members?.find(m => m.name === memberName)
  if (!member) return { ok: false, error: `成员「${memberName}」不在团队中` }
  if (member.status === 'busy') return { ok: false, error: `成员「${memberName}」正在工作中，请稍候` }
  member.status = "busy"
  broadcastTeam(session)
    // 里程碑事件：面板上至少能看到「收到任务」，否则纯文本回合是空白流
    broadcast({ sessionId: session.id, type: 'team_event', member: memberName, payload: { type: 'notice', text: `收到任务：${String(text ?? '').slice(0, 200)}` } })
  try {
    const result = await runSubAgent(
      session,
      String(text ?? ""),
      `成员「${memberName}」处理消息`,
      ev => broadcast({ sessionId: session.id, ...ev }),
      () => session.cancelled,
      memberName,
    )
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) }
  } finally {
    member.status = "idle"
    broadcastTeam(session)
    void runEventHooks(HOOK_EVENT.TEAMMATE_IDLE, {
      hookInput: sessionHookInput(session, { member: memberName }),
    }).catch(() => {})
  }
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
/** Node 定时器的 delay 上限（2^31-1，约 24.8 天）。 */
export const MAX_TIMER_MS = 2_147_483_647

export function scheduleCron(session, { everyMs, prompt }) {
  // 登记定时任务唯一的口子，挡在这里就能覆盖所有调用方（模型 CronCreate / 界面 / 工作流）。
  //
  // 为什么必须有上限：setInterval 对**大于 2^31-1 的 delay 会当成 1ms**，
  // 于是填一个很大的毫秒数（界面允许直接填）会变成「每毫秒起一个回合」——
  // 相当于把自己打挂。宁可明说不支持，也不能默默变成疯跑。
  if (!Number.isFinite(everyMs) || everyMs > MAX_TIMER_MS) {
    throw new Error(
      `周期 ${everyMs}ms 超过定时器上限（${MAX_TIMER_MS}ms，约 ${Math.round(MAX_TIMER_MS / 86_400_000)} 天）；` +
        '请改用更小的周期。更长的周期需要「触发后重新排下一次」的实现，暂不支持。',
    )
  }
  const id = 'cron_' + ++cronSeq
  const timer = setInterval(() => {
    // 会话已被删除（从 store 里消失）则自停，避免往孤儿会话里塞消息
    if (![...allSessions()].some(s => s.id === session.id)) {
      clearInterval(timer)
      crons.delete(id)
      return
    }
    // 上一个回合还在跑就跳过本次 —— 同一会话不允许并发回合。
    // 跳过要**说出来**：静默跳过会让人以为定时任务没生效（在排查"为什么没触发"时最难查）。
    if (activeTurns.has(session.id)) {
      broadcast({
        type: 'notice',
        sessionId: session.id,
        text: `[定时任务] 上一次「${prompt}」还在执行，本次跳过（同一会话不会并发跑两个回合）。`,
      })
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
