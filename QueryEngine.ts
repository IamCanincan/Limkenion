import { feature } from 'bun:bundle'
import type { ContentBlockParam } from './types/llm-protocol.js'
import { randomUUID } from 'crypto'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import { accumulateUsage, updateUsage } from 'src/services/api/limkenion.js'
import type { NonNullableUsage } from 'src/services/api/logging.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import { countToolCalls, SYNTHETIC_MESSAGES } from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

// 延迟加载：MessageSelector.tsx 会引入 React/ink，只有在查询期做消息过滤时才需要
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector =
  (): typeof import('src/components/MessageSelector.js') =>
    require('src/components/MessageSelector.js')

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// 死代码消除：coordinator 模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

// 死代码消除：snip 压缩的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const snipProjection = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipProjection.js') as typeof import('./services/compact/snipProjection.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  /** MCP 工具 -32042 错误触发的 URL elicitation 处理器。 */
  handleElicitation?: ToolUseContext['handleElicitation']
  includePartialMessages?: boolean
  setSDKStatus?: (status: SDKStatus) => void
  abortController?: AbortController
  orphanedPermission?: OrphanedPermission
  /**
   * snip 边界处理器：接收每条产出的 system 消息，以及当前 mutableMessages 存储。
   * 若该消息不是 snip 边界则返回 undefined；否则返回重放后的 snip 结果。
   * 启用 HISTORY_SNIP 时由 ask() 注入，这样特性开关相关的字符串就留在被开关
   * 控制的模块内部（在 bun test 下 feature() 返回 false 时，QueryEngine 也不会
   * 带上这些被排除的字符串，从而依然可测试）。
   * 仅 SDK 路径：REPL 保留完整历史用于 UI 回滚查看，并通过 projectSnippedView
   * 按需投影；QueryEngine 在此处截断，以便在长时间无头会话中限制内存占用
   * （没有 UI 需要保留）。
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine 负责一次对话的查询生命周期与会话状态。
 * 它把 ask() 的核心逻辑抽离成独立类，供 headless/SDK 路径使用，
 * （未来阶段）也可供 REPL 使用。
 *
 * 每个对话对应一个 QueryEngine。每次调用 submitMessage() 会在同一对话中
 * 开启一个新回合。状态（消息、文件缓存、用量等）在回合之间持续保留。
 */
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  // 回合级的技能发现记录（为 limkenion_skill_tool_invocation 的
  // was_discovered 字段提供数据）。需要在 submitMessage 内部两次
  // processUserInputContext 重建之间保留，但在每次 submitMessage 开始时清空，
  // 避免在 SDK 模式下跨多个回合无界增长。
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE
  }

  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    this.discoveredSkillNames.clear()
    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()

    // 包装 canUseTool，以便统计权限拒绝
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // 统计拒绝次数，供 SDK 上报
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    const initialAppState = getAppState()
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    headlessProfilerCheckpoint('before_getSystemPrompt')
    // 先做一次类型收窄，好让 TS 在下面的条件分支中跟踪类型。
    const customPrompt =
      typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    // 当 SDK 调用方提供了自定义 system 提示词，并且设置了
    // LIMKENION_COWORK_MEMORY_PATH_OVERRIDE 时，注入记忆机制提示词。
    // 该环境变量是一次显式开启的信号 —— 调用方已经接好了记忆目录，
    // 需要让 Limkenion 知道如何使用它（该调用哪些 Write/Edit 工具、
    // MEMORY.md 的文件名、加载语义）。
    // 调用方还可以通过 appendSystemPrompt 叠加自己的策略文本。
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    // 注册 function 钩子，用于强制结构化输出
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // 会改写消息数组的斜杠命令（例如 /force-snip）
      // 会调用 setMessages(fn)。在交互模式下这会写回 AppState；
      // 在 print 模式下则写回 mutableMessages，好让查询循环的后续部分
      // （:389 处 push、:392 处 snapshot）能看到结果。下面第二个
      // processUserInputContext（在斜杠命令处理之后）保持空操作 ——
      // 那之后没有别的地方再调用 setMessages。
      setMessages: fn => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // 我们用的是 stdout，所以不希望把它冲掉
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: (
        updater: (prev: FileHistoryState) => FileHistoryState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (
        updater: (prev: AttributionState) => AttributionState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    // 处理孤儿权限（每个引擎生命周期只处理一次）
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: 'sdk',
    })

    // 推入新消息，包括用户输入与所有附件
    this.mutableMessages.push(...messagesFromUserInput)

    // 更新参数，以反映处理 /slash 命令带来的变更
    const messages = [...this.mutableMessages]

    // 在进入查询循环之前，先把用户消息写入 transcript。
    // 下面的 for-await 只在 ask() 产出 assistant/user/compact_boundary 消息时
    // 才调用 recordTranscript —— 而这要等到 API 响应之后才会发生。
    // 如果进程在此之前被杀掉（例如用户在 cowork 中点发送后几秒内点了 Stop），
    // transcript 里就只剩队列操作记录；getLastSessionLog 会把它们过滤掉、
    // 返回 null，于是 --resume 报 "No conversation found"。
    // 现在就写入，可以让 transcript 从用户消息被接受的那一刻起就可恢复，
    // 即使始终没有等到 API 响应。
    //
    // --bare / SIMPLE：发后不管。脚本化调用不会在请求中途被杀后再 --resume。
    // 这个 await 在 SSD 上约 4ms，磁盘争用时约 30ms —— 是模块求值之后
    // 可控关键路径上最大的一笔开销。transcript 照旧会写（便于事后排查），
    // 只是不再阻塞。
    if (persistSession && messagesFromUserInput.length > 0) {
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode()) {
        void transcriptPromise
      } else {
        await transcriptPromise
        if (
          isEnvTruthy(process.env.LIMKENION_EAGER_FLUSH) ||
          isEnvTruthy(process.env.LIMKENION_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }
    }

    // 过滤出写入 transcript 之后需要确认（ack）的消息
    const replayableMessages = messagesFromUserInput.filter(
      msg =>
        (msg.type === 'user' &&
          !msg.isMeta && // 跳过合成的声明（caveat）消息
          !msg.toolUseResult && // 跳过工具结果（它们会在 query 中被 ack）
          messageSelector().selectableUserMessagesFilter(msg)) || // 跳过非用户产出的消息（任务通知等）
        (msg.type === 'system' && msg.subtype === 'compact_boundary'), // compact 边界始终 ack
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []

    // 根据用户输入的处理结果更新 ToolPermissionContext（如需要）
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // 在处理提示词之后重建，以便拿到更新后的消息与
    // model（来自斜杠命令）。
    processUserInputContext = {
      messages,
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    headlessProfilerCheckpoint('before_skills_plugins')
    // 仅读缓存：headless/SDK/CCR 启动时不得为 ref 跟踪的插件阻塞网络。
    // CCR 在此之前已通过 LIMKENION_SYNC_PLUGIN_INSTALL（headlessPluginInstall）
    // 或 LIMKENION_PLUGIN_SEED_DIR 填好缓存；需要拉取最新源码的 SDK 调用方
    // 可以调用 /reload-plugins。
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')

    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext
        .mode as PermissionMode, // TODO: 避免使用类型断言
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
      fastMode: initialAppState.fastMode,
    })

    // 记录 system 消息产出的时刻，用于无头模式的延迟统计
    headlessProfilerCheckpoint('system_message_yielded')

    if (!shouldQuery) {
      // 返回本地斜杠命令的执行结果。
      // 用 messagesFromUserInput（而不是 replayableMessages）承载命令输出，
      // 因为 selectableUserMessagesFilter 会排除 local-command-stdout 标签。
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === 'user' &&
          typeof msg.message.content === 'string' &&
          (msg.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: 'user',
            message: {
              ...msg.message,
              content: stripAnsi(msg.message.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as SDKUserMessageReplay
        }

        // 本地命令输出 —— 作为合成的 assistant 消息产出，这样
        // RC 会把它渲染成 assistant 风格的文本，而不是用户气泡。
        // 以 assistant 形式产出（而不是专用的 SDKLocalCommandOutputMessage
        // system 子类型），以便移动端 client 与 session-ingress 能解析它。
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(msg.compactMetadata),
          } as SDKCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.LIMKENION_EAGER_FLUSH) ||
          isEnvTruthy(process.env.LIMKENION_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
      }
      return
    }

    if (fileHistoryEnabled() && persistSession) {
      messagesFromUserInput
        .filter(messageSelector().selectableUserMessagesFilter)
        .forEach(message => {
          void fileHistoryMakeSnapshot(
            (updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory),
              }))
            },
            message.uuid,
          )
        })
    }

    // 记录当前消息的用量（每次 message_start 时重置）
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    let turnCount = 1
    let hasAcknowledgedInitialMessages = false
    // 记录来自 StructuredOutput 工具调用的结构化输出
    let structuredOutputFromTool: unknown
    // 记录 assistant 消息中最后的 stop_reason
    let lastStopReason: string | null = null
    // 基于引用的水位线，使 error_during_execution 的 errors[] 保持
    // 回合作用域。用基于长度的下标会在 100 条环形缓冲区于回合中
    // 发生 shift() 时失效 —— 下标会滑动。如果该条目已被轮转出去，
    // lastIndexOf 返回 -1，此时我们全量包含（安全的兜底行为）。
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // 快照本次查询前的计数，用于基于增量的重试限制
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })) {
      // 记录 assistant、user 与 compact 边界消息
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        // 在写入 compact 边界之前，先把只存在于内存中的
        // 消息（直到 preservedSegment 尾部）全部落盘。附件与进度
        // 现在已在各自的 switch case 中就地记录，但这次 flush
        // 对 preservedSegment 的尾部遍历仍然重要。
        // 如果 SDK 子进程在那之前重启（limkenion-desktop 会在回合之间
        // 杀掉进程），tailUuid 会指向一条从未写入的消息 →
        // applyPreservedSegmentRelinks 的 tail→head 遍历失败 →
        // 直接返回而不做剪枝 → 恢复时会加载完整的压缩前历史。
        if (
          persistSession &&
          message.type === 'system' &&
          message.subtype === 'compact_boundary'
        ) {
          const tailUuid = message.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex(
              m => m.uuid === tailUuid,
            )
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message)
        if (persistSession) {
          // 对 assistant 消息发后不管。limkenion.ts 每个内容块产出一条
          // assistant 消息，随后在 message_delta 时修改最后一条的
          // message.usage/stop_reason —— 这依赖于写入队列 100ms 的
          // 惰性 jsonStringify。若在这里 await，就会阻塞 ask() 的
          // generator，导致 message_delta 在所有块被消费完之前无法运行；
          // 而排空定时器（在第 1 个块时启动）会先超时。交互式 CC 不会
          // 遇到这个问题，因为 useLogMessages.ts 是发后不管的。
          // enqueueWrite 保证顺序，因此这里发后不管也是安全的。
          if (message.type === 'assistant') {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // 在首次写入 transcript 之后确认初始用户消息
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === 'user') {
              yield {
                type: 'user',
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as SDKUserMessageReplay
            }
          }
        }
      }

      if (message.type === 'user') {
        turnCount++
      }

      switch (message.type) {
        case 'tombstone':
          // 墓碑消息是用于删除消息的控制信号，跳过它们
          break
        case 'assistant':
          // 若 stop_reason 已设置则捕获（合成消息）。对于流式响应，
          // 在 content_block_stop 时它还是 null；真实值会随
          // message_delta 到达（在下面处理）。
          if (message.message.stop_reason != null) {
            lastStopReason = message.message.stop_reason
          }
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'progress':
          this.mutableMessages.push(message)
          // 就地记录，好让下一次 ask() 调用中的去重循环把它
          // 视为「已记录」。否则延迟的进度消息会与 mutableMessages 中
          // 已记录的 tool_results 交错，导致去重遍历把
          // startingParentUuid 冻结在错误的消息上 —— 链条分叉，
          // 恢复时整段对话变成孤儿。
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(message)
          break
        case 'user':
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
        case 'stream_event':
          if (message.event.type === 'message_start') {
            // 为新消息重置当前消息用量
            currentMessageUsage = EMPTY_USAGE
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.message.usage,
            )
          }
          if (message.event.type === 'message_delta') {
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.usage,
            )
            // 从 message_delta 捕获 stop_reason。assistant 消息在
            // content_block_stop 时以 stop_reason=null 被产出；
            // 真实值只在这里到达（见 limkenion.ts 的 message_delta
            // 处理器）。没有这段代码，result.stop_reason 永远是 null。
            if (message.event.delta.stop_reason != null) {
              lastStopReason = message.event.delta.stop_reason
            }
          }
          if (message.event.type === 'message_stop') {
            // 把当前消息用量累加进总计
            this.totalUsage = accumulateUsage(
              this.totalUsage,
              currentMessageUsage,
            )
          }

          if (includePartialMessages) {
            yield {
              type: 'stream_event' as const,
              event: message.event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        case 'attachment':
          this.mutableMessages.push(message)
          // 就地记录（原因同上面的 progress）。
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }

          // 从 StructuredOutput 工具调用中提取结构化输出
          if (message.attachment.type === 'structured_output') {
            structuredOutputFromTool = message.attachment.data
          }
          // 处理来自 query.ts 的「已达最大回合数」信号
          else if (message.attachment.type === 'max_turns_reached') {
            if (persistSession) {
              if (
                isEnvTruthy(process.env.LIMKENION_EAGER_FLUSH) ||
                isEnvTruthy(process.env.LIMKENION_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: message.attachment.turnCount,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(
                mainLoopModel,
                initialAppState.fastMode,
              ),
              uuid: randomUUID(),
              errors: [
                `Reached maximum number of turns (${message.attachment.maxTurns})`,
              ],
            }
            return
          }
          // 把排队的 queued_command 附件作为 SDK 用户消息重放产出
          else if (
            replayUserMessages &&
            message.attachment.type === 'queued_command'
          ) {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: message.attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: message.attachment.source_uuid || message.uuid,
              timestamp: message.timestamp,
              isReplay: true,
            } as SDKUserMessageReplay
          }
          break
        case 'stream_request_start':
          // 不产出流式请求开始消息
          break
        case 'system': {
          // snip 边界：在我们的存储上重放，以清除僵尸消息与
          // 过期标记。产出的边界只是一个信号，而不是要 push 的数据 ——
          // 重放本身会产生它自己的等价边界。没有这一步，标记会一直留存
          // 并在每个回合反复触发，mutableMessages 也永不收缩
          // （长 SDK 会话中的内存泄漏）。子类型检查放在被注入的回调内部，
          // 以便特性开关相关的字符串不出现在本文件中（被排除字符串检查）。
          const snipResult = this.config.snipReplay?.(
            message,
            this.mutableMessages,
          )
          if (snipResult !== undefined) {
            if (snipResult.executed) {
              this.mutableMessages.length = 0
              this.mutableMessages.push(...snipResult.messages)
            }
            break
          }
          this.mutableMessages.push(message)
          // 把 compact 边界消息产出给 SDK
          if (
            message.subtype === 'compact_boundary' &&
            message.compactMetadata
          ) {
            // 释放压缩前的消息以便 GC。边界刚刚被 push，
            // 所以它是最后一个元素。query.ts 内部已经在使用
            // getMessagesAfterCompactBoundary()，因此往后只需要
            // 边界之后的消息。
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: message.uuid,
              compact_metadata: toSDKCompactMetadata(message.compactMetadata),
            }
          }
          if (message.subtype === 'api_error') {
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: message.retryAttempt,
              max_retries: message.maxRetries,
              retry_delay_ms: message.retryInMs,
              error_status: message.error.status ?? null,
              error: categorizeRetryableAPIError(message.error),
              session_id: getSessionId(),
              uuid: message.uuid,
            }
          }
          // 无头模式下不产出其他 system 消息
          break
        }
        case 'tool_use_summary':
          // 把工具调用摘要消息产出给 SDK
          yield {
            type: 'tool_use_summary' as const,
            summary: message.summary,
            preceding_tool_use_ids: message.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: message.uuid,
          }
          break
      }

      // 检查美元预算是否已超支
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        if (persistSession) {
          if (
            isEnvTruthy(process.env.LIMKENION_EAGER_FLUSH) ||
            isEnvTruthy(process.env.LIMKENION_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            mainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [`Reached maximum budget ($${maxBudgetUsd})`],
        }
        return
      }

      // 检查结构化输出重试次数是否超限（只在用户消息上检查）
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )
        if (callsThisQuery >= maxRetries) {
          if (persistSession) {
            if (
              isEnvTruthy(process.env.LIMKENION_EAGER_FLUSH) ||
              isEnvTruthy(process.env.LIMKENION_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              mainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `Failed to provide valid structured output after ${maxRetries} attempts`,
            ],
          }
          return
        }
      }
    }

    // 停止钩子会在 assistant 响应之后（通过 query.ts 中的
    // yield* handleStopHooks）产出进度/附件消息。由于 #23537 会把它们
    // 就地 push 到 `messages`，last(messages) 可能是一条进度/附件消息
    // 而不是 assistant —— 这会让下面的 textResult 提取返回 ''，
    // 于是 -p 模式输出一个空行。这里把类型放宽到 assistant|user：
    // isResultSuccessful 对两者都能处理（全部为 tool_result 块的
    // user 消息也是一种合法的成功终态）。
    const result = messages.findLast(
      m => m.type === 'assistant' || m.type === 'user',
    )
    // 为 error_during_execution 诊断捕获信息 —— isResultSuccessful
    // 是一个类型谓词（message is Message），所以在 false 分支里
    // `result` 会被收窄为 never，这些访问也就无法通过类型检查。
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContentType =
      result?.type === 'assistant'
        ? (last(result.message.content)?.type ?? 'none')
        : 'n/a'

    // 在产出结果之前，把缓冲中的 transcript 写入落盘。
    // 桌面端应用在收到结果消息后会立刻杀掉 CLI 进程，
    // 因此任何未落盘的写入都会丢失。
    if (persistSession) {
      if (
        isEnvTruthy(process.env.LIMKENION_EAGER_FLUSH) ||
        isEnvTruthy(process.env.LIMKENION_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    if (!isResultSuccessful(result, lastStopReason)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        // 诊断前缀：这些正是 isResultSuccessful() 检查的内容 —— 如果
        // 结果类型不是「带 text/thinking 的 assistant」或「带 tool_result 的
        // user」，且 stop_reason 也不是 end_turn，那就是它触发的原因。
        // errors[] 通过水位线保持回合作用域；以前它会把整个进程的
        // logError 缓冲全部倾倒出来（ripgrep 超时、ENOENT 等等）。
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark
            ? all.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map(_ => _.error),
          ]
        })(),
      }
      return
    }

    // 根据消息类型提取文本结果
    let textResult = ''
    let isApiError = false

    if (result.type === 'assistant') {
      const lastContent = last(result.message.content)
      if (
        lastContent?.type === 'text' &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    yield {
      type: 'result',
      subtype: 'success',
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(
        mainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  }

  interrupt(): void {
    this.abortController.abort()
  }

  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  getSessionId(): string {
    return getSessionId()
  }

  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }
}

/**
 * 向 Limkenion API 发送单条提示词并返回响应。
 * 假定 limkenion 以非交互方式使用 —— 不会向用户请求权限或进一步输入。
 *
 * 面向一次性使用场景、包在 QueryEngine 之外的便捷封装。
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  setSDKStatus?: (status: SDKStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents,
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
    ...(feature('HISTORY_SNIP')
      ? {
          snipReplay: (yielded: Message, store: Message[]) => {
            if (!snipProjection!.isSnipBoundaryMessage(yielded))
              return undefined
            return snipModule!.snipCompactIfNeeded(store, { force: true })
          },
        }
      : {}),
  })

  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}
