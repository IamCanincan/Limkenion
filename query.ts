// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from './types/llm-protocol.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
} from './services/api/errors.js'
import { logAntError, logForDebugging } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getRuntimeMainLoopModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // 从这条 assistant 消息中提取所有 tool use 块
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // 为每个 tool use 产出一条中断消息
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * 思考的规则冗长而玄奥。要理解它们，需要一位巫师长时间、深入地冥想，
 * 才能把这团乱麻理顺。
 *
 * 规则如下：
 * 1. 含有 thinking 或 redacted_thinking 块的消息，必须属于 max_thinking_length > 0 的查询
 * 2. thinking 块不能是某个 block 中的最后一条消息
 * 3. thinking 块必须在一条 assistant 轨迹期间被保留（单个回合；若该回合含 tool_use 块，
 *    则还包括其后的 tool_result 以及再下一条 assistant 消息）
 *
 * 年轻的巫师，请谨记这些规则。因为它们是思考的规则，
 * 而思考的规则就是宇宙的规则。若你不遵守这些规则，
 * 就会被罚上一整天的调试与抓狂。
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * 这是不是一条 max_output_tokens 错误消息？如果是，流式循环应当先对 SDK
 * 调用方隐瞒它，直到我们确认恢复循环能否继续。过早产出会把一个中间错误
 * 泄漏给 SDK 调用方（例如 cowork/desktop）—— 它们只要看到 `error` 字段就会
 * 终止会话，而恢复循环还在跑，却已经没人监听了。
 *
 * 与 reactiveCompact.isWithheldPromptTooLong 对应。
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API 的 task_budget（output_config.task_budget，beta task-budgets-2026-03-13）。
  // 与 tokenBudget +500k 自动续写特性不同。`total` 是整个 agentic 回合的预算；
  // `remaining` 每次迭代根据累计的 API 用量计算。参见 limkenion.ts 中的
  // configureTaskBudgetParams。
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// —— 查询循环状态

// 在循环迭代之间传递的可变状态
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  // 上一次迭代为何继续。首次迭代时为 undefined。
  // 便于测试断言恢复路径被触发，而无需检查消息内容。
  transition: Continue | undefined
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 只有在 queryLoop 正常返回时才会走到这里。抛异常时跳过（错误
  // 通过 yield* 向上传播），调用 .return() 时也跳过（Return completion
  // 会关闭两个 generator）。这样在回合失败时，能给出与 print.ts 的
  // drainCommandQueue 相同的「已开始但未完成」的非对称信号。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 不可变参数 —— 在查询循环中从不被重新赋值。
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // 可变的跨迭代状态。循环体在每次迭代开头解构它，
  // 这样读取时保持裸名（`messages`、`toolUseContext`）。
  // continue 处改为写 `state = { ... }`，而不是 9 次单独赋值。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // 跨压缩边界跟踪 task_budget.remaining。在第一次压缩触发前为 undefined ——
  // 上下文未压缩时服务端能看到完整历史，并自行从 {total} 做倒数
  // （见 api/api/sampling/prompt/renderer.py:292）。压缩之后服务端只看到
  // 摘要，会少算开销；remaining 用来告诉它那次被摘要掉的、
  // 压缩前的最终窗口。跨多次压缩是累加的：每次都减去该次压缩触发点上的
  // 最终上下文。放在循环局部（而不是 State 上），以免牵动 7 处 continue 站点。
  let taskBudgetRemaining: number | undefined = undefined

  // 在进入时一次性快照不可变的 env/statsig/会话状态。
  // 包含哪些内容、以及为何有意排除 feature() 开关，参见 QueryConfig。
  const config = buildQueryConfig()

  // 每个用户回合只触发一次 —— 提示词在循环迭代之间是不变的，
  // 若每次迭代都触发，就会拿同一个问题问 sideQuery N 次。
  // 消费点轮询 settledAt（从不阻塞）。`using` 在 generator 的所有
  // 退出路径上都会释放资源 —— 释放与遥测语义见 MemoryPrefetch。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 在每次迭代开头解构 state。其中只有 toolUseContext 会在
    // 迭代内部被重新赋值（queryTracking、messages 更新）；
    // 其余在 continue 站点之间是只读的。
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    // 技能发现预取 —— 每次迭代都做（用 findWritePivot 守卫，
    // 在非写入迭代上提前返回）。发现过程在模型流式输出与工具执行期间进行；
    // 在工具执行之后与记忆预取的消费点一起 await。取代了原先跑在
    // getAttachmentMessages 内部的阻塞式 assistant_turn 路径
    // （生产环境里 97% 的这类调用什么都没找到）。
    // 回合 0 的用户输入发现仍然阻塞在 userInputAttachments 中 ——
    // 那是唯一没有前置工作可供隐藏的信号。
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // 记录查询开始时间，用于无头模式的延迟统计（子代理跳过）
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // 初始化或递增查询链跟踪
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    let tracking = autoCompactTracking

    // 对聚合后的工具结果大小执行单条消息预算。在 microcompact 之前运行 ——
    // 带缓存的 MC 完全按 tool_use_id 工作（从不检查内容），
    // 因此内容替换对它是不可见的，两者可以干净地组合。
    // 当 contentReplacementState 为 undefined（特性关闭）时为空操作。
    // 只对那些在恢复时会读回记录的 querySource 做持久化：agentId
    // 会路由到 sidechain 文件（AgentTool 恢复）或会话文件（/resume）。
    // 一次性的 runForkedAgent 调用方（agent_summary 等）不做持久化。
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // 在 microcompact 之前应用 snip（两者可能都执行 —— 并不互斥）。
    // snipTokensFreed 会传给 autocompact，好让它的阈值判断反映 snip 已移除的量；
    // 仅凭 tokenCountWithEstimation 看不到这一点（它从受保护尾部的
    // assistant 读取用量，而那条消息在 snip 后原样保留）。
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage
      }
      queryCheckpoint('query_snip_end')
    }

    // 在 autocompact 之前应用 microcompact
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // 对带缓存的 microcompact（缓存编辑），把边界消息推迟到 API 响应之后，
    // 以便使用真实的 cache_deleted_input_tokens。
    // 用 feature() 做开关，以便该字符串能从外部构建中被消除。
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // 投影出折叠后的上下文视图，并可能提交更多折叠。
    // 在 autocompact 之前运行，这样如果折叠能把我们降到 autocompact
    // 阈值以下，autocompact 就变成空操作，从而保留细粒度上下文
    // 而不是只剩一条摘要。
    //
    // 不产出任何消息 —— 折叠视图是对 REPL 完整历史的读取期投影。
    // 摘要消息存放在折叠存储里，而不是 REPL 数组中。这正是折叠能跨回合
    // 保留的原因：projectView() 在每次进入时都会重放提交日志。
    // 在单个回合内，视图通过 continue 站点上的 state.messages 向前流动
    // （query.ts:1192），而下一次 projectView() 会是空操作，
    // 因为已归档的消息已经从它的输入中消失了。
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('limkenion_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // task_budget：在下面把 messagesForQuery 替换成 postCompactMessages 之前，
      // 捕获压缩前的最终上下文窗口。
      // iterations[-1] 是权威的最终窗口（服务端工具循环之后）；见 #304930。
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // 每次压缩都重置，使 turnCounter/turnId 反映最近一次压缩。
      // recompactionInfo（autoCompact.ts:190）已在调用前捕获了
      // turnsSincePreviousCompact/previousCompactTurnId 的旧值，
      // 所以这次重置不会丢失它们。
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      for (const message of postCompactMessages) {
        yield message
      }

      // 使用压缩后的消息继续当前的查询调用
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // autocompact 失败 —— 传播失败计数，以便熔断器
      // 能在下一次迭代时停止重试。
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    // TODO: 无需在设置阶段给 toolUseContext.messages 赋值，因为这里已经更新了
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // @see 
    // 注意：stop_reason === 'tool_use' 并不可靠 —— 它并不总是被正确设置。
    // 在流式过程中，只要出现 tool_use 块就置位 —— 这是唯一的循环退出信号。
    // 流式结束后若为 false，说明我们完成了（除 stop-hook 重试外）。
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // 每次查询会话只创建一次 fetch 包装器，以避免内存滞留。
    // 每调用一次 createDumpPromptsFetch 都会创建一个捕获请求体的闭包。
    // 只创建一次意味着仅保留最新的一份请求体（约 700KB），
    // 而不是会话中的全部请求体（长会话约 500MB）。
    // 注意：在一次 query() 调用期间 agentId 实际上是常量 ——
    // 它只在查询之间变化（例如 /clear 命令或会话恢复）。
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // 若已达到硬阻塞上限则阻塞（仅在自动压缩关闭时生效）
    // 这会预留空间，好让用户仍可手动执行 /compact
    // 若刚刚发生过压缩则跳过该检查 —— 压缩结果已经过校验、
    // 确认在阈值以下，而 tokenCountWithEstimation 会用到保留消息里
    // 那些反映压缩前上下文大小的、已过时的 input_tokens。
    // 同样的过期问题也适用于 snip：减去 snipTokensFreed（否则在
    // snip 已把我们降到 autocompact 阈值以下、但过时用量仍高于阻塞上限的
    // 那段窗口里，我们会误判为阻塞 —— 在本 PR 之前这段窗口并不存在，
    // 因为 autocompact 总是基于那个过期计数触发）。
    // 对 compact/session_memory 查询也跳过 —— 这些是继承了完整对话的
    // fork agent，若在这里被阻塞就会死锁（压缩 agent 需要运行起来
    // 才能降低 token 数）。
    // 当启用响应式压缩且允许自动压缩时也跳过 —— preempt 的
    // 合成错误会在 API 调用之前返回，于是响应式压缩永远看不到
    // prompt-too-long，也就无从反应。放宽到 walrus，以便 RC 能在
    // 主动压缩失败时充当兜底。
    //
    // context-collapse 同样跳过：它的 recoverFromOverflow 会在真实的
    // API 413 上排空暂存的折叠，然后落到 reactiveCompact。
    // 这里的合成 preempt 会在 API 调用之前返回，从而饿死两条恢复路径。
    // 保留 isAutoCompactEnabled() 这个合取项，是为了尊重用户显式配置的
    // 「不做任何自动行为」—— 如果他们设了 DISABLE_AUTO_COMPACT，
    // 就该走 preempt。
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) &&
        isAutoCompactEnabled()
    }
    // 每个回合提升一次媒体恢复门禁。流式循环内的「隐瞒」与其后的
    // 「恢复」必须一致；CACHED_MAY_BE_STALE 可能在 5-30 秒的流式过程中翻转，
    // 只隐瞒不恢复就会把这条消息吃掉。PTL 不做提升，因为它的隐瞒
    // 本身没有门禁 —— 它早于该实验，已经是控制组的基线。
    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    let attemptWithFallback = true

    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
          })) {
            // 我们不会使用第一次尝试里的 tool_calls
            // 可以那样做.. 但那样就得合并 id 不同的 assistant 消息，
            // 并且把完整的 tool_results 重复一遍
            if (streamingFallbackOccured) {
              // 为孤儿消息产出墓碑，以便它们从 UI 和 transcript 中移除。
              // 这些部分消息（尤其是 thinking 块）带有无效签名，
              // 会触发 "thinking blocks cannot be modified" 的 API 错误。
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('limkenion_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // 丢弃失败流式尝试中待处理的结果，并创建一个
              // 全新的 executor。这可以避免在降级响应到达之后
              // 再产出孤儿 tool_results（带着旧的 tool_use_ids）。
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // 在产出之前，对克隆出的消息回填 tool_use 输入，
            // 好让 SDK 流输出与 transcript 序列化能看到遗留/派生字段。
            // 原始 `message` 保持不动，留给下面的 assistantMessages.push ——
            // 它会流回 API，修改它会破坏提示词缓存（字节不匹配）。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              let clonedContent: typeof message.message.content | undefined
              for (let i = 0; i < message.message.content.length; i++) {
                const block = message.message.content[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // 只有当回填是「新增」字段时才产出克隆；若只是
                    // 「覆写」已有字段（例如文件工具展开 file_path）则跳过。
                    // 覆写会改变序列化后的 transcript，并在恢复时破坏
                    // VCR fixture 的哈希，同时又没有给 SDK 流带来任何它需要的
                    // 东西 —— 钩子会另行通过 toolExecution.ts 拿到展开后的路径。
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...message.message.content]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...message.message, content: clonedContent },
                }
              }
            }
            // 对可恢复的错误（prompt-too-long、max-output-tokens）先隐瞒，
            // 直到我们确认恢复（折叠排空 / 响应式压缩 / 截断重试）能否成功。
            // 仍会 push 到 assistantMessages，好让下面的恢复检查能找到它们。
            // 任一子系统的隐瞒都足够 —— 它们彼此独立，
            // 关掉其中一个不会破坏另一个的恢复路径。
            //
            // feature() 只能用在 if/三元条件中（bun:bundle 的
            // tree-shaking 约束），所以折叠检查是嵌套的，而不是组合的。
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message,
                  isPromptTooLongMessage,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              assistantMessages.push(message)

              const msgToolUseBlocks = message.message.content.filter(
                content => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, message)
                }
              }
            }

            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')

          // 产出被推迟的 microcompact 边界消息，使用 API 实际上报的
          // token 删除数，而不是客户端估算值。
          // 整块由 feature() 控制，以便该被排除的字符串
          // 能从外部构建中被消除。
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // 该 API 字段在多次请求之间是累计/粘滞的，所以
            // 要减去本次请求之前捕获的基线，才能得到增量。
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // 已触发降级 —— 切换模型并重试
            currentModel = fallbackModel
            attemptWithFallback = true

            // 清空 assistant 消息，因为我们要重试整个请求
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // 丢弃失败尝试中待处理的结果，并创建一个
            // 全新的 executor。这可以避免孤儿 tool_results（带着旧的
            // tool_use_ids）泄漏到重试中。
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // 用新模型更新 tool use context
            toolUseContext.options.mainLoopModel = fallbackModel

            // thinking 签名是绑定模型的：把受保护 thinking 的块重放给
            // 不受保护的降级模型会报 400。重试前先剥离，
            // 好让降级模型拿到干净的历史。
            

            // 记录降级事件
            logEvent('limkenion_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // 产出关于降级的 system 消息 —— 使用 'warning' 级别，
            // 这样用户无需开启 verbose 模式也能看到该通知
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('limkenion_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          _.message.content.filter(content => content.type === 'tool_use'),
        ).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 用对用户友好的消息处理图片尺寸/缩放错误
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // 通常情况下 queryModelWithStreaming 不应当抛错，而是把错误
      // 作为合成的 assistant 消息产出。但如果确实因为 bug 抛了错，
      // 我们可能已经产出了一个 tool_use 块，却会在产出 tool_result
      // 之前停下来。
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // 暴露真实的错误，而不是误导性的 "[Request interrupted
      // by user]" —— 这条路径是模型/运行时失败，不是用户操作。
      // SDK 使用方此前会在例如 Node 18 缺失 Array.prototype.with()
      // 时看到幻影中断，掩盖了真实原因。
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // 为便于排查 bug，对 ant 大声记录日志
      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }

    // 在模型响应完成之后执行采样后钩子
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // 我们需要最先处理流式中断。
    // 使用 streamingToolExecutor 时，必须消费 getRemainingResults()，
    // 以便 executor 能为排队中/进行中的工具生成合成的 tool_result 块。
    // 否则 tool_use 块就会缺少与之匹配的 tool_result 块。
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // 消费剩余结果 —— executor 会为被中断的工具生成合成的
        // tool_results，因为它在 executeTool() 中会检查中断信号
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }
      // chicago MCP：中断时自动取消隐藏并释放锁。与 stopHooks.ts 中
      // 回合自然结束路径上的清理相同。仅限主线程 ——
      // 关于子代理释放主线程锁的理由见 stopHooks.ts。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 失败静默处理 —— 这是自用清理逻辑，不在关键路径上
        }
      }

      // 对 submit 类中断跳过中断消息 —— 紧随其后的
      // 排队用户消息已经提供了足够的上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // 产出上一回合的工具调用摘要 —— haiku（约 1s）在模型流式输出（5-30s）期间已解析完成
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // prompt-too-long 恢复：流式循环此前隐瞒了该错误
      // （见上面的 withheldByCollapse / withheldByReactive）。先尝试
      // 折叠排空（成本低，保留细粒度上下文），再尝试响应式压缩
      // （完整摘要）。两者各只执行一次 —— 如果重试仍然 413，
      // 就交给下一阶段处理，或者让错误暴露出来。
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // 媒体尺寸过大被拒（图片/PDF/多图）可以通过响应式压缩的
      // strip-retry 恢复。与 PTL 不同，媒体错误会跳过折叠排空 ——
      // 折叠并不会剥离图片。mediaRecoveryEnabled 是流式循环之前
      // 提升上来的门禁（取值与隐瞒检查相同 —— 这两者必须一致，
      // 否则被隐瞒的消息就丢了）。如果超大的媒体位于受保护尾部，
      // 压缩后的回合会再次出现媒体错误；hasAttemptedReactiveCompact
      // 可以防止失控循环，届时错误会暴露出来。
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // 首先：排空所有暂存的上下文折叠。条件是上一次
        // 迁移不是 collapse_drain_retry —— 如果我们已经排空过
        // 而重试仍然 413，就落到响应式压缩。
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // task_budget：与上面主动路径相同的结转。
          // 此处 messagesForQuery 仍是压缩前的数组
          // （即那次 413 失败尝试的输入）。
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // 无法恢复 —— 暴露被隐瞒的错误并退出。不要
        // 继续往下走停止钩子：模型从未产出有效响应，
        // 钩子没什么有意义的东西可评估。在 prompt-too-long 上
        // 运行停止钩子会造成死亡螺旋：错误 → 钩子阻断 →
        // 重试 → 错误 → ……（钩子每个循环都注入更多 token）。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // reactiveCompact 已被编译剔除，但 contextCollapse 隐瞒了错误
        // 且无法恢复（暂存队列为空/已过期）。暴露出来。
        // 提前返回的理由相同 —— 不要继续往下走停止钩子。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      // 检查 max_output_tokens 并注入恢复消息。该错误
      // 在上面的流式中已被隐瞒；只有在恢复手段用尽时才暴露。
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // 升级式重试：如果我们用的是 8k 的默认上限并且撞到了
        // 限制，就以 64k 重试同一次请求 —— 不加元消息，
        // 也不做多回合的来回。每个回合只触发一次（由
        // override 检查守卫），之后若 64k 仍然撞上限，
        // 就落到多回合恢复。
        // 3P 默认：false（未在 Bedrock/Vertex 上验证）
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'limkenion_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.LIMKENION_MAX_OUTPUT_TOKENS
        ) {
          logEvent('limkenion_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // 恢复手段已用尽 —— 现在暴露被隐瞒的错误。
        yield lastMessage
      }

      // 当最后一条消息是 API 错误（限流、
      // prompt-too-long、认证失败等）时跳过停止钩子。模型从未
      // 产出真实响应 —— 让钩子去评估它会造成死亡螺旋：
      // 错误 → 钩子阻断 → 重试 → 错误 → ……
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // 保留响应式压缩的守卫 —— 如果压缩已经跑过
          // 仍无法从 prompt-too-long 恢复，那么在停止钩子阻断错误
          // 之后重试也会得到同样的结果。此前在这里把它重置为 false
          // 导致了无限循环：压缩 → 仍然过长 → 错误 →
          // 停止钩子阻断 → 压缩 → …… 白白烧掉数千次 API 调用。
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('limkenion_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')


    if (streamingToolExecutor) {
      logEvent('limkenion_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('limkenion_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // 工具批次完成后生成工具调用摘要 —— 传给下一次递归调用
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // 子代理不会出现在移动端 UI 中 —— 跳过这次 Haiku 调用
    ) {
      // 提取最后的 assistant 文本块作为上下文
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = lastAssistantMessage.message.content.filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // 收集工具信息以生成摘要
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // 找到对应的工具结果
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // 发出摘要生成请求，不阻塞下一次 API 调用
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // 我们在工具调用期间被中断了
    if (toolUseContext.abortController.signal.aborted) {
      // chicago MCP：在工具调用中途被中断时自动取消隐藏并释放锁。
      // 这是 CU 最可能的 Ctrl+C 路径（例如截图很慢时）。
      // 仅限主线程 —— 子代理的理由见 stopHooks.ts。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 失败静默处理 —— 这是自用清理逻辑，不在关键路径上
        }
      }
      // 对 submit 类中断跳过中断消息 —— 紧随其后的
      // 排队用户消息已经提供了足够的上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // 在被中断时，返回前先检查 maxTurns
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    // 如果钩子指示不要继续，就在这里停下
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('limkenion_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 注意要在工具调用完成之后再做这件事，因为
    // 如果我们把 tool_result 消息与普通用户消息交错，
    // API 会报错。

    // 埋点：在添加附件之前记录消息数量
    logEvent('limkenion_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在处理附件之前获取排队命令的快照。
    // 它们会作为附件发送，好让 Limkenion 能在当前回合中响应它们。
    //
    // 排空待处理的通知。LocalShellTask 完成属于 'next'
    // （开启 MONITOR_TOOL 时），无需 Sleep 即可排空。其他任务类型
    // （agent/workflow/framework）仍默认为 'later' —— 由 Sleep flush 覆盖。
    // 如果所有任务类型都改为 'next'，这个分支就可以删掉了。
    //
    // 斜杠命令不参与回合中途排空 —— 它们必须在回合结束后经由
    // processSlashCommand 处理（通过 useQueueProcessor），
    // 而不是作为文本发给模型。Bash 模式的命令已由
    // INLINE_NOTIFICATION_MODES 在 getQueuedCommandAttachments 中排除。
    //
    // agent 作用域：该队列是进程级单例，由 coordinator 与所有进程内
    // 子代理共享。每个循环只排空寻址给自己的部分 ——
    // 主线程排空 agentId===undefined 的，子代理排空自己的 agentId。
    // 用户提示（mode:'prompt'）仍然只进主线程；子代理永远看不到提示流。
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // 子代理只排空寻址给自己的任务通知 ——
      // 从不排空用户提示，即使有人给提示打上了 agentId。
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // 记忆预取的消费点：只有在已 settle、且之前的迭代尚未消费过时才进行。
    // 若尚未 settle 就跳过（零等待）并在下一次迭代重试 ——
    // 在回合结束之前，预取有多少次循环迭代就有多少次机会。
    // readFileState（跨迭代累计）会过滤掉模型已经 Read/Write/Edit 过的
    // 记忆 —— 包括更早迭代中的那些，而按迭代划分的
    // toolUseBlocks 数组会漏掉这些。
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }


    // 注入预取到的技能发现结果。collectSkillDiscoveryPrefetch 会输出
    // hidden_by_main_turn —— 当预取在此时间点之前解析完成时该值为 true
    // （AKI@250ms / Haiku@573ms 对比 2-30s 的回合时长，应当 >98%）。
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // 只移除那些确实作为附件被消费掉的命令。
    // 提示与任务通知类命令已在上面转换为附件。
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // 埋点：在文件变更附件添加之后记录
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('limkenion_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在回合之间刷新工具，好让新连上的 MCP server 可用
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // 每当我们拿到工具结果并准备递归时，就算一个回合
    const nextTurnCount = turnCount + 1

    // 为 `limkenion ps` 生成周期性的任务摘要 —— 在回合中途触发，
    // 这样长时间运行的 agent 也能刷新它正在做的事。
    // 只用 !agentId 做条件，因此每个顶层对话（REPL、SDK、HFI、
    // remote）都会生成摘要；子代理/fork 不会。
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
          ],
        })
      }
    }

    // 检查是否已达到最大回合数限制
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    queryCheckpoint('query_recursive_call')
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
