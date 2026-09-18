import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

/**
 * 初始化 agent 专属的 MCP 服务器
 * agent 可以在其 frontmatter 中定义自己的 MCP 服务器，作为
 * 父级 MCP 客户端的增量。这些服务器在 agent 启动时连接，
 * 在 agent 结束时清理。
 *
 * @param agentDefinition 带可选 mcpServers 的 agent 定义
 * @param parentClients 从父级上下文继承的 MCP 客户端
 * @returns 合并后的客户端（父级 + agent 专属）、agent MCP 工具以及清理函数
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // 如果未定义 agent 专属服务器，则原样返回父级客户端
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  // 当 MCP 被锁定为仅限插件时，只对用户可控的 agent 跳过
  // frontmatter MCP 服务器。插件、内置和 policySettings agent
  // 受管理员信任——它们的 frontmatter MCP 属于管理员批准的
  // 范围。阻止它们（如最初版本所做）会破坏那些确实需要 MCP
  // 的插件 agent，与“插件提供的内容始终加载”相矛盾。
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // 跟踪哪些客户端是新建的（内联定义），哪些是从父级共享的
  // agent 结束时只应清理新建的客户端
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // 按名称引用——在现有 MCP 配置中查找
      // 这里使用已记忆化的 connectToServer，因此可能得到共享客户端
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // 以 { [name]: config } 形式内联定义
      // 这些是 agent 专属服务器，应被清理
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // 连接到服务器
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // 如果已连接则获取工具
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // 为 agent 专属服务器创建清理函数
  // 只清理新建的客户端（内联定义），不清理共享/被引用的那些
  // 共享客户端（按字符串名称引用）已记忆化，并由父级上下文使用
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // 返回合并后的客户端（父级 + agent 专属）和 agent 工具
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * 类型守卫：检查来自 query() 的消息是否为可记录的 Message 类型。
 * 匹配我们想要记录的类型：assistant、user、progress 或 system compact_boundary。
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** 该 agent 是否能展示权限提示。默认为 !isAsync。
   * 对于异步运行但共享终端的进程内 teammate，设为 true。 */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** 为具有可查看记录的对话的子代理在消息上保留 toolUseResult */
  preserveToolUseResults?: boolean
  /** 为 worker agent 预计算的工具池。由调用方
   * （AgentTool.tsx）计算，以避免 runAgent 与 tools.ts 之间的循环依赖。
   * 始终包含以 worker 自身权限模式组装的完整工具池，
   * 独立于父级的工具限制。 */
  availableTools: Tools
  /** 要添加到 agent 会话允许规则中的工具权限规则。
   * 提供时会替换所有允许规则，使 agent 仅拥有
   * 显式列出的内容（父级的批准不会泄漏进来）。 */
  allowedTools?: string[]
  /** 在构建 agent 的系统提示词、上下文和工具后，以 CacheSafeParams
   * 调用的可选回调。后台摘要用它来 fork agent 的对话，
   * 以生成周期性进度摘要。 */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** 从恢复的 sidechain 记录重建的替换状态，以便
   * 相同的工具结果被重新替换（提示词缓存稳定性）。省略时，
   * createSubagentContext 会克隆父级的状态。 */
  contentReplacementState?: ContentReplacementState
  /** 为 true 时，直接使用 availableTools，不经过
   * resolveAgentTools() 过滤。同时继承父级的 thinkingConfig 和
   * isNonInteractiveSession，而非覆盖它们。fork 子代理路径用它
   * 生成字节级一致的 API 请求前缀，以获得
   * 提示词缓存命中。 */
  useExactTools?: boolean
  /** 如果 agent 以 isolation: "worktree" 派生，则为 worktree 路径。
   * 持久化到元数据，以便恢复时能还原正确的 cwd。 */
  worktreePath?: string
  /** 来自 AgentTool 输入的原始任务描述。持久化到元数据，
   * 以便恢复的 agent 通知能展示原始描述。 */
  description?: string
  /** subagents/ 下可选的子目录，用于将该 agent 的记录与相关的
   * 记录归组（例如工作流子代理的 workflows/<runId>）。 */
  transcriptSubdir?: string
  /** 对 query() 产出的每条消息触发的可选回调——包括
   * runAgent 原本会丢弃的 stream_event 增量。用于在长时间单块流
   * （例如 thinking）中检测存活性，此时超过 60 秒没有
   * assistant 消息产出。 */
  onQueryProgress?: () => void
}): AsyncGenerator<Message, void> {
  // 跟踪子代理使用情况以发现功能

  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // 通往根 AppState store 的始终共享通道。当*父级*本身是异步
  // agent（嵌套 async→async）时，toolUseContext.setAppState 是空操作，
  // 因此会话作用域的写入（钩子、bash 任务）必须改走这里。
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

  const agentId = override?.agentId ? override.agentId : createAgentId()

  // 如有请求，将该 agent 的记录归入分组子目录
  // （例如工作流子代理写入 subagents/workflows/<runId>/）。
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // 在 Perfetto trace 中注册 agent 以实现层级可视化
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // 为子代理记录 API 调用路径（仅限 ant）
  

  // 处理用于上下文共享的消息 fork
  // 从父级消息中过滤掉不完整的工具调用，以避免 API 错误
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // 只读 agent（Explore、Plan）不依据 LIMKENION.md 中的 commit/PR/lint
  // 规则行事——主 agent 拥有完整上下文并解读它们的输出。
  // 在此丢弃 limkenionMd 可在 34M+ 次 Explore 派生中每周节省约 5-15 Gtok。
  // 调用方显式提供的 override.userContext 保持不变。
  // 终止开关默认为 true；将其改为 limkenion_slim_subagent_limkenionmd=false 即可还原。
  const shouldOmitLimkenionMd =
    agentDefinition.omitLimkenionMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('limkenion_slim_subagent_limkenionmd', true)
  const { limkenionMd: _omittedLimkenionMd, ...userContextNoLimkenionMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitLimkenionMd
    ? userContextNoLimkenionMd
    : baseUserContext

  // Explore/Plan 是只读搜索 agent——父会话启动时的
  // gitStatus（最大 40KB，已明确标记为失效）是累赘。如果它们
  // 需要 git 信息，会自行运行 `git status` 获取最新数据。
  // 全集群每周节省约 1-3 Gtok。
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit
      : baseSystemContext

  // 如果 agent 定义了权限模式则覆盖
  // 但如果父级处于 bypassPermissions 或 acceptEdits 模式则不要覆盖——那些应始终优先
  // 对于异步 agent，还要设置 shouldAvoidPermissionPrompts，因为它们无法展示 UI
  const agentPermissionMode = agentDefinition.permissionMode
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // 如果 agent 定义了权限模式则覆盖（除非父级为 bypassPermissions、acceptEdits 或 auto）
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // 为无法展示 UI 的 agent 设置自动拒绝提示的标志
    // 如果提供了显式的 canShowPermissionPrompts 则使用它，否则：
    //   - bubble 模式：始终展示提示（冒泡到父终端）
    //   - 默认：!isAsync（同步 agent 展示提示，异步 agent 不展示）
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // 对于能展示提示的后台 agent，先等待自动化检查
    // （分类器、权限钩子）完成，再展示权限对话框。
    // 由于这些是后台 agent，等待没有问题——只有当自动化检查
    // 无法解决权限时才应打扰用户。
    // 这适用于 bubble 模式（始终）和显式的 canShowPermissionPrompts。
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // 限定工具权限范围：提供 allowedTools 时，将其用作会话规则。
    // 重要：保留 cliArg 规则（来自 SDK 的 --allowedTools），因为那些是
    // SDK 使用方给出的显式权限，应适用于所有 agent。
    // 只清除来自父级的会话级规则，以防止意外泄漏。
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // 保留来自 --allowedTools 的 SDK 级权限
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // 将提供的 allowedTools 用作会话级权限
          session: [...allowedTools],
        },
      }
    }

    // 如果 agent 定义了 effort 级别则覆盖
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  const agentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
          resolvedTools,
        ),
      )

  // 确定 abortController：
  // - 覆盖值优先
  // - 异步 agent 获得新的未链接控制器（独立运行）
  // - 同步 agent 共享父级的控制器
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // 执行 SubagentStart 钩子并收集附加上下文
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // 将 SubagentStart 钩子上下文作为 user 消息添加（与 SessionStart/UserPromptSubmit 一致）
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'agent-start',
      toolUseID: randomUUID(),
      hookEvent: 'agent-start',
    })
    initialMessages.push(contextMessage)
  }

  // 注册 agent 的 frontmatter 钩子（作用域限定为 agent 生命周期）
  // 传入 isAgent=true 将 Stop 钩子转换为 SubagentStop（因为子代理触发 SubagentStop）
  // frontmatter 钩子使用同样的管理员信任开关：仅锁定 ["hooks"] 时
  // （skills/agents 未锁定），用户 agent 仍会加载——在此处已知来源的地方
  // 阻止其 frontmatter 钩子的注册，而不是在执行时
  // 一刀切地阻止所有会话钩子（那样也会
  // 连带杀死插件 agent 的钩子）。
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent——将 Stop 转换为 SubagentStop
    )
  }

  // 从 agent frontmatter 预加载技能
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // 过滤有效技能并对缺失的技能发出警告
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // 解析技能名，尝试多种策略：
      // 1. 精确匹配（hasCommand 检查 name、userFacingName、aliases）
      // 2. 带上 agent 的插件前缀做完全限定（例如 "my-skill" → "plugin:my-skill"）
      // 3. 对插件命名空间技能做 ":skillName" 后缀匹配
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // 并发加载所有技能内容并加入初始消息
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // 添加 command-message 元数据，使 UI 展示正在加载哪个技能
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // 初始化 agent 专属的 MCP 服务器（作为父级服务器的增量）
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )

  // 将 agent MCP 工具与已解析的 agent 工具合并，按名称去重。
  // resolvedTools 已去重（见 resolveAgentTools），因此当没有
  // agent 专属 MCP 工具时，跳过展开 + uniqBy 的开销。
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // 构建 agent 专属选项
  const agentOptions: ToolUseContext['options'] = {
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,
    commands: [],
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    // 对于 fork 子级（useExactTools），继承 thinking 配置以匹配
    // 父级的 API 请求前缀，从而获得提示词缓存命中。对于常规
    // 子代理，禁用 thinking 以控制输出 token 成本。
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // fork 子级（useExactTools 路径）需要在 context.options 上设置 querySource，
    // 以供 AgentTool.tsx call() 中的递归 fork 防护使用——它检查
    // options.querySource === 'agent:builtin:fork'。这能在 autocompact 中存活
    // （autocompact 重写的是消息，不是 context.options）。否则该防护
    // 读到 undefined，只有消息扫描降级检查会触发——而
    // autocompact 会通过替换 fork 样板消息使其失效。
    ...(useExactTools && { querySource }),
  }

  // 使用共享辅助函数创建子代理上下文
  // - 同步 agent 与父级共享 setAppState、setResponseLength、abortController
  // - 异步 agent 完全隔离（但带有显式的未链接 abortController）
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // 同步 agent 与父级共享这些回调
    shareSetAppState: !isAsync,
    shareSetResponseLength: true, // 同步和异步都会计入响应指标
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // 为具有可查看记录的子代理（进程内 teammate）保留工具调用结果
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // 暴露 cache-safe 参数以供后台摘要使用（提示词缓存共享）
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // 在查询循环开始前记录初始消息，以及 agentType，
  // 以便在省略 subagent_type 时恢复能正确路由。两处写入
  // 都是即发即弃——持久化失败不应阻塞 agent。
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`Failed to record sidechain transcript: ${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))

  // 跟踪最后记录的消息 UUID 以保持父链连续
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
    })) {
      onQueryProgress?.()
      // 将子代理的 API 请求开始转发到父级的指标展示，
      // 使 TTFT/OTPS 在子代理执行期间更新。
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_start' &&
        message.ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
        continue
      }

      // 产出附件消息（例如 structured_output）而不记录它们
      if (message.type === 'attachment') {
        // 处理来自 query.ts 的达到最大回合数信号
        if (message.attachment.type === 'max_turns_reached') {
          logForDebugging(
            `[Agent
: $
{
  agentDefinition.agentType
}
] Reached max turns limit ($
{
  message.attachment.maxTurns
}
)`,
          )
          break
        }
        yield message
        continue
      }

      if (isRecordableMessage(message)) {
        // 只记录带正确父级的新消息（每条消息 O(1)）
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`Failed to record sidechain transcript: ${err}`),
        )
        if (message.type !== 'progress') {
          lastRecordedUuid = message.uuid
        }
        yield message
      }
    }

    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // 如提供了回调则运行（只有内置 agent 有回调）
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
  } finally {
    // 清理 agent 专属 MCP 服务器（在正常完成、中止或出错时运行）
    await mcpCleanup()
    // 清理 agent 的会话钩子
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // 清理该 agent 的提示词缓存跟踪状态
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      cleanupAgentTracking(agentId)
    }
    // 释放克隆的文件状态缓存内存
    agentToolUseContext.readFileState.clear()
    // 释放克隆的 fork 上下文消息
    initialMessages.length = 0
    // 释放 perfetto agent 注册表条目
    unregisterPerfettoAgent(agentId)
    // 释放记录子目录映射
    clearAgentTranscriptSubdir(agentId)
    // 释放该 agent 的 todos 条目。否则每个调用过 TodoWrite 的子代理
    // 都会在 AppState.todos 中永久留下一个键（即使所有条目都已完成，
    // 值为 [] 但键仍保留）。大型会话会派生数百个 agent；
    // 每个孤立键都是一点泄漏，累积起来很可观。
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // 终止该 agent 派生的所有后台 bash 任务。否则当主会话最终退出时，
    // 一个 `run_in_background` shell 循环（例如测试夹具 fake-logs.sh）
    // 会以 PPID=1 僵尸进程的形式比 agent 存活更久。
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (feature('MONITOR_TOOL')) {
      const mcpMod =
        require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js')
      mcpMod.killMonitorMcpTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

/**
 * 过滤掉含不完整工具调用（没有结果的工具调用）的 assistant 消息。
 * 这可防止发送带孤立工具调用的消息时出现 API 错误。
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // 构建具有结果的工具调用 ID 集合
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // 过滤掉包含无结果工具调用的 assistant 消息
  return messages.filter(message => {
    if (message?.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        // 检查该 assistant 消息是否有无结果的工具调用
        const hasIncompleteToolCall = content.some(
          block =>
            block.type === 'tool_use' &&
            block.id &&
            !toolUseIdsWithResults.has(block.id),
        )
        // 排除含不完整工具调用的消息
        return !hasIncompleteToolCall
      }
    }
    // 保留所有非 assistant 消息以及不含工具调用的 assistant 消息
    return true
  })
}

async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  try {
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  } catch (_error) {
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  }
}

/**
 * 将 agent frontmatter 中的技能名解析为已注册的命令名。
 *
 * 插件技能以带命名空间的名称注册（例如 "my-plugin:my-skill"），
 * 但 agent 以裸名引用它们（例如 "my-skill"）。本函数
 * 尝试多种解析策略：
 *
 * 1. 通过 hasCommand 精确匹配（name、userFacingName、aliases）
 * 2. 加上 agent 的插件名前缀（例如 "my-skill" → "my-plugin:my-skill"）
 * 3. 后缀匹配——查找名称以 ":skillName" 结尾的命令
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. 直接匹配
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. 尝试加上 agent 的插件名前缀
  // 插件 agent 的 agentType 形如 "pluginName:agentName"
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. 后缀匹配——查找名称以 ":skillName" 结尾的技能
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}
