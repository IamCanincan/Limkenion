/**
 * 会话压缩（CLI CompactTool 的 web 真实现 + 上游 CLI 原型 同款自动触发）。
 *
 * 之前 web 的 /compact 是**假压缩**——直接清空消息，模型彻底失忆。
 * 真压缩应该像官方那样：把历史交给模型总结成一份结构化摘要，然后
 * 用「一条摘要消息」替换掉全部历史，上下文从摘要重新开始。
 *
 * 触发点有两处：
 * - `/compact` 命令（commands.mjs）
 * - 回合结束后上下文逼近上限时自动触发（engine.mjs，阈值见 autoCompactThreshold）
 *
 * 依赖方向：compact → deepseek/hooks/sessions/bus，**谁都不反过来 import 它**；
 * engine 和 commands 都只 import 本模块，不会成环。
 */
import { chatCompletion, getApiKey } from './deepseek.mjs'
import { HOOK_EVENT, runEventHooks, sessionHookInput, hooksEnabled } from './hooks.mjs'
import { schedulePersist, broadcastSessions } from './sessions.mjs'
import { settingsFor } from './config.mjs'

/** 会话内自增 id（不能 import engine 的 newMessageId —— 会成环）。 */
let compactSeq = 0

/**
 * 触发自动压缩的输入 token 阈值（读环境变量便于测试；默认 96K，
 * DeepSeek 上下文 128K，留 32K 给摘要本身 + 新回合的输出空间）。
 * **必须在调用时读**，不能在模块加载时定格 —— 测试要在 before() 里改环境变量。
 */
export function autoCompactThreshold() {
  const v = Number(process.env.LIMKENION_AUTO_COMPACT_INPUT_TOKENS)
  return Number.isFinite(v) && v > 0 ? v : 96 * 1024
}

/**
 * 把会话历史交给模型压缩成一份摘要，替换掉全部历史消息。
 *
 * @returns {{ok:true, removed:number, summaryChars:number} | {ok:false, skipped:string}}
 */
/**
 * @param {object} session 会话对象（messages / settings 等）
 * @param {{ emit?: (ev: {type: string, text?: string}) => void, reason?: string }} [opts]
 *   - emit：把压缩进度以 notice 事件播给前端（auto-compact 场景传，/compact 命令场景不传）
 *   - reason：触发原因，写进摘要消息头与钩子输入
 */
export async function compactSession(session, opts = {}) {
  const { emit, reason = '手动压缩' } = opts ?? {}
  const messages = session.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, skipped: '会话没有历史消息，无需压缩' }
  }

  const notice = text => emit?.({ type: 'notice', text })

  // ---- 无 API key：没有模型可总结，退化为「清空」并如实说明（不谎报成摘要）----
  if (!getApiKey()) {
    const count = messages.length
    session.messages = []
    session.compactedAt = Date.now()
    schedulePersist()
    broadcastSessions()
    return { ok: false, skipped: `未配置 API key，无法生成摘要；已直接清空 ${count} 条历史消息` }
  }

  // ---- context-compact-before：给钩子一个「最后一刻还能落地盘」的机会 ----
  if (hooksEnabled()) {
    await runEventHooks(HOOK_EVENT.CONTEXT_COMPACT_BEFORE, {
      hookInput: sessionHookInput(session, { reason, messageCount: messages.length }),
    })
  }

  notice(`开始压缩：${messages.length} 条历史 → 摘要（${reason}）…`)

  // ---- 生成摘要 ----
  const transcript = messages
    .map(m => {
      const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '模型' : '系统'
      const tools = Array.isArray(m.toolCalls) && m.toolCalls.length > 0
        ? `（工具：${m.toolCalls.map(t => t.name).join('、')}）`
        : ''
      const text = String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 2000)
      return `${who}${tools}：${text}`
    })
    .join('\n')
    .slice(-60_000) // 摘要请求本身也要防超限

  const { text: summary, usage } = await chatCompletion({
    model: settingsFor(session).model,
    messages: [
      {
        role: 'user',
        content:
          '以下是同一次工作会话的完整对话记录。请把它压缩成一份**给下一个回合的模型自己看**的摘要，' +
          '必须保留：① 用户的原始目标与约束；② 已经完成的事与关键产出（含文件路径）；' +
          '③ 做过的决定与理由；④ 未完成的事与下一步。用 Markdown 列表，不要寒暄，不要评价。\n\n' +
          '=== 对话记录 ===\n' +
          transcript,
      },
    ],
  })

  const trimmed = String(summary ?? '').trim()
  if (!trimmed) {
    return { ok: false, skipped: '摘要模型返回了空内容，为安全起见保留原历史' }
  }

  // ---- 用一条摘要消息替换全部历史 ----
  const removed = messages.length
  session.messages = [
    {
      id: `cmp-${Date.now()}-${++compactSeq}`,
      role: 'user',
      text:
        `[对话压缩 · ${reason} · 压缩掉 ${removed} 条历史，耗 ${usage?.inputTokens ?? '?'} + ${usage?.outputTokens ?? '?'} tokens]\n\n` +
        '以下是对此前对话的摘要，请在此基础上继续：\n\n' +
        trimmed,
      timestamp: Date.now(),
    },
  ]
  session.compactedAt = Date.now()
  schedulePersist()
  broadcastSessions()

  // ---- context-compact-after ----
  if (hooksEnabled()) {
    await runEventHooks(HOOK_EVENT.CONTEXT_COMPACT_AFTER, {
      hookInput: sessionHookInput(session, { reason, removed, summaryChars: trimmed.length }),
    })
  }

  notice(`压缩完成：${removed} 条 → 1 条摘要（${trimmed.length} 字）`)
  return { ok: true, removed, summaryChars: trimmed.length }
}
