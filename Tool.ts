import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from './types/llm-protocol.js'
import type {
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { UUID } from 'crypto'
import type { z } from 'zod/v4'
import type { Command } from './commands.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { ThinkingConfig } from './utils/thinking.js'
import { canonicalToolName } from './shared/naming.js'

export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

import type { Notification } from './context/notifications.js'
import type {
  MCPServerConnection,
  ServerResource,
} from './services/mcp/types.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from './tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from './types/message.js'
// 从统一位置导入权限类型，以打破导入循环
// 从统一位置导入 PermissionResult，以打破导入循环
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionResult,
} from './types/permissions.js'
// 从统一位置导入工具进度类型，以打破导入循环
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
} from './types/tools.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
import type { SystemPrompt } from './utils/systemPromptType.js'
import type { ContentReplacementState } from './utils/toolResultStorage.js'

// 重新导出进度类型以向后兼容
export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  WebSearchProgress,
}

import type { SpinnerMode } from './components/Spinner.js'
import type { QuerySource } from './constants/querySource.js'
import type { SDKStatus } from './entrypoints/agentSdkTypes.js'
import type { AppState } from './state/AppState.js'
import type {
  HookProgress,
  PromptRequest,
  PromptResponse,
} from './types/hooks.js'
import type { AgentId } from './types/ids.js'
import type { DeepImmutable } from './types/utils.js'
import type { AttributionState } from './utils/commitAttribution.js'
import type { FileHistoryState } from './utils/fileHistory.js'
import type { Theme, ThemeName } from './utils/theme.js'

export type QueryChainTracking = {
  chainId: string
  depth: number
}

export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

export type SetToolJSXFn = (
  args: {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand?: boolean
    isImmediate?: boolean
    /** 置为 true 时清除本地 JSX 命令（例如在它的 onDone 回调中） */
    clearLocalJSX?: boolean
  } | null,
) => void

// 从统一位置导入工具权限类型，以打破导入循环
import type { ToolPermissionRulesBySource } from './types/permissions.js'

// 重新导出以向后兼容
export type { ToolPermissionRulesBySource }

// 对导入的类型应用 DeepImmutable
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  strippedDangerousRules?: ToolPermissionRulesBySource
  /** 为 true 时权限弹窗会被自动拒绝（例如无法显示 UI 的后台 agent） */
  shouldAvoidPermissionPrompts?: boolean
  /** 为 true 时，会先等自动检查（classifier、hooks）完成再弹权限对话框（coordinator worker） */
  awaitAutomatedChecksBeforeDialog?: boolean
  /** 保存进入由 model 发起的 plan 模式之前的权限模式，退出时可据此恢复 */
  prePlanMode?: PermissionMode
}>

export const getEmptyToolPermissionContext: () => ToolPermissionContext =
  () => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  })

export type CompactProgressEvent =
  | {
      type: 'hooks_start'
      hookType: 'pre_compact' | 'post_compact' | 'session_start'
    }
  | { type: 'compact_start' }
  | { type: 'compact_end' }

export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    /** 自定义 system 提示词，用于替换默认 system 提示词 */
    customSystemPrompt?: string
    /** 追加在主 system 提示词之后的附加提示词 */
    appendSystemPrompt?: string
    /** 覆盖 querySource，用于遥测统计 */
    querySource?: QuerySource
    /** 可选回调，用于获取最新工具列表（例如 MCP server 在查询中途连上之后） */
    refreshTools?: () => Tools
  }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  /**
   * 始终共享的 setAppState，用于会话级基础设施（后台任务、会话钩子）。
   * 与 setAppState 不同 —— 后者对异步 agent 是空操作（见 createSubagentContext）——
   * 这个版本总能到达根 store，因此任意嵌套层级的 agent 都能注册/清理
   * 生命周期长于单个回合的基础设施。只由 createSubagentContext 设置；
   * 主线程 context 回退到 setAppState。
   */
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  /**
   * 可选的 URL elicitation 处理器，由工具调用错误（-32042）触发。
   * 在 print/SDK 模式下委托给 structuredIO.handleElicitation。
   * 在 REPL 模式下该值为 undefined，走基于队列的 UI 路径。
   */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: Notification) => void
  /** 向 REPL 消息列表追加一条仅用于 UI 的 system 消息。会在
   *  normalizeMessagesForAPI 边界处被剥离 —— Exclude<> 让这一点由类型强制保证。 */
  appendSystemMessage?: (
    msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
  ) => void
  /** 发送操作系统级通知（iTerm2、Kitty、Ghostty、响铃等） */
  sendOSNotification?: (opts: {
    message: string
    notificationType: string
  }) => void
  nestedMemoryAttachmentTriggers?: Set<string>
  /**
   * 本会话中已作为 nested_memory 附件注入过的 LIMKENION.md 路径。
   * 用于 memoryFilesToAttachments 的去重 —— readFileState 是一个 LRU，
   * 在繁忙会话中会淘汰条目，所以仅靠它的 .has() 检查会让同一个
   * LIMKENION.md 被重复注入几十次。
   */
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  /** 本会话通过 skill_discovery 暴露出来的技能名。仅用于遥测（提供 was_discovered 数据）。 */
  discoveredSkillNames?: Set<string>
  userModified?: boolean
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
  /** 只在交互式（REPL）context 中接线；SDK/QueryEngine 不会设置它。 */
  setHasInterruptibleToolInProgress?: (v: boolean) => void
  setResponseLength: (f: (prev: number) => number) => void
  /** 仅 Ant：为 OTPS 统计推入一条新的 API 指标记录。
   *  当新的 API 请求开始时，由子代理流式处理调用。 */
  pushApiMetricsEntry?: (ttftMs: number) => void
  setStreamMode?: (mode: SpinnerMode) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  setSDKStatus?: (status: SDKStatus) => void
  openMessageSelector?: () => void
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void
  updateAttributionState: (
    updater: (prev: AttributionState) => AttributionState,
  ) => void
  setConversationId?: (id: UUID) => void
  agentId?: AgentId // 仅为子代理设置；取会话 ID 请用 getSessionId()。钩子据此区分是否子代理调用。
  agentType?: string // 子代理类型名。对于主线程的 --agent 类型，钩子会回退到 getMainThreadAgentType()。
  /** 为 true 时，即使钩子自动批准也必须调用 canUseTool。
   *  供 speculation 用于覆写文件路径重写。 */
  requireCanUseTool?: boolean
  messages: Message[]
  fileReadingLimits?: {
    maxTokens?: number
    maxSizeBytes?: number
  }
  globLimits?: {
    maxResults?: number
  }
  toolDecisions?: Map<
    string,
    {
      source: string
      decision: 'accept' | 'reject'
      timestamp: number
    }
  >
  queryTracking?: QueryChainTracking
  /** 用于向用户请求交互式提示的回调工厂。
   * 返回一个绑定到给定 source 名称的提示回调。
   * 仅在交互式（REPL）context 中可用。 */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolUseId?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  /** 为 true 时，即使对子代理也保留消息上的 toolUseResult。
   * 用于进程内 teammate —— 它们的 transcript 对用户可见。 */
  preserveToolUseResults?: boolean
  /** 供 setAppState 为空操作的异步子代理使用的本地拒绝统计状态。
   *  没有它，拒绝计数永远不会累加，也就永远达不到
   *  「回退为弹窗提示」的阈值。可变 —— 权限代码会就地更新它。 */
  localDenialTracking?: DenialTrackingState
  /**
   * 按对话线程划分的内容替换状态，用于工具结果预算。
   * 存在时，query.ts 会应用聚合后的工具结果预算。
   * 主线程：REPL 只准备一次（从不重置 —— 过期的 UUID 键是无害的）。
   * 子代理：createSubagentContext 默认克隆父级状态（共享缓存的 fork
   * 需要完全一致的决策），或者由 resumeAgentBackground 传入一个
   * 依据 sidechain 记录重建出来的状态。
   */
  contentReplacementState?: ContentReplacementState
  /**
   * 父级已渲染的 system 提示词字节，在回合开始时冻结。
   * 供 fork 子代理共享父级的提示词缓存 —— 在 fork 生成时重新调用
   * getSystemPrompt() 可能产生偏差（GrowthBook 冷→热）并击穿缓存。
   * 参见 forkSubagent.ts。
   */
  renderedSystemPrompt?: SystemPrompt
}

// 从统一位置重新导出 ToolProgressData
export type { ToolProgressData }

export type Progress = ToolProgressData | HookProgress

export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}

export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      msg.data?.type !== 'hook_progress',
  )
}

export type ToolResult<T> = {
  data: T
  newMessages?: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[]
  // contextModifier 只对非并发安全的工具生效。
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  /** 透传给 SDK 使用方的 MCP 协议元数据（structuredContent、_meta） */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

// 任意「输出对象且键为字符串」的 schema 的类型
export type AnyObject = z.ZodType<{ [key: string]: unknown }>

/**
 * 检查某个工具是否匹配给定名称（主名称或别名）。
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  const cname = canonicalToolName(name)
  return (
    tool.name === name ||
    tool.name === cname ||
    (tool.aliases?.includes(name) ?? false) ||
    (tool.aliases?.includes(cname) ?? false)
  )
}

/**
 * 从工具列表中按名称或别名查找工具。
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  /**
   * 可选别名，用于工具改名后的向后兼容。
   * 除主名称外，还可以用这些名字中的任意一个查到该工具。
   */
  aliases?: string[]
  /**
   * 供 ToolSearch 做关键词匹配的一行能力描述。
   * 帮助模型在工具被延迟加载时通过关键词搜索找到它。
   * 3–10 个词，末尾不加句号。
   * 优先使用工具名里没有的词（例如 NotebookEdit 用 'jupyter'）。
   */
  searchHint?: string
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input
  // 适用于可直接用 JSON Schema 格式指定 input schema 的 MCP 工具的类型
  // 而不是从 Zod schema 转换而来
  readonly inputJSONSchema?: ToolInputJSONSchema
  // 可选，因为 TungstenTool 没有定义它。TODO: 改为必填。
  // 改完之后，也可以顺带把它做得更类型安全一些。
  outputSchema?: z.ZodType<unknown>
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean
  isEnabled(): boolean
  isReadOnly(input: z.infer<Input>): boolean
  /** 默认 false。仅当工具执行不可逆操作（删除、覆写、发送）时才设置。 */
  isDestructive?(input: z.infer<Input>): boolean
  /**
   * 当该工具正在运行时用户提交了新消息，应该如何处理。
   *
   * - `'cancel'` —— 停止工具并丢弃其结果
   * - `'block'`  —— 继续运行；新消息排队等待
   *
   * 未实现时默认为 `'block'`。
   */
  interruptBehavior?(): 'cancel' | 'block'
  /**
   * 返回该工具调用是否属于「搜索或读取」操作的信息 —— 这类操作在 UI 中
   * 应当被折叠为精简展示。例如文件搜索（Grep、Glob）、文件读取（Read），
   * 以及 find、grep、wc 之类的 bash 命令。
   *
   * 返回一个对象，说明该操作属于搜索还是读取：
   * - `isSearch: true` 表示搜索操作（grep、find、glob 模式）
   * - `isRead: true` 表示读取操作（cat、head、tail、文件读取）
   * - `isList: true` 表示目录列举操作（ls、tree、du）
   * - 若该操作不应折叠，三者都可以为 false
   */
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean
  isMcp?: boolean
  isLsp?: boolean
  /**
   * 为 true 时该工具被延迟加载（以 defer_loading: true 发送），
   * 必须先通过 ToolSearch 才能调用。
   */
  readonly shouldDefer?: boolean
  /**
   * 为 true 时该工具永不被延迟加载 —— 即使启用了 ToolSearch，它的完整
   * schema 也会出现在初始提示词中。对 MCP 工具通过
   * `_meta['limkenion/alwaysLoad']` 设置。用于模型必须在第 1 回合就看到、
   * 不想为此多跑一次 ToolSearch 的工具。
   */
  readonly alwaysLoad?: boolean
  /**
   * 对 MCP 工具而言：从 MCP server 收到的 server 名与工具名（未规范化）。
   * 所有 MCP 工具都带该字段，无论 `name` 是否带前缀（mcp__server__tool）
   * 或不带前缀（LIMKENION_AGENT_SDK_MCP_NO_PREFIX 模式）。
   */
  mcpInfo?: { serverName: string; toolName: string }
  readonly name: string
  /**
   * 工具结果在持久化到磁盘之前允许的最大字符数。
   * 超出后结果会保存到文件，Limkenion 收到的只是带文件路径的预览，
   * 而不是完整内容。
   *
   * 对输出绝不能持久化的工具设为 Infinity（例如 Read —— 持久化会造成
   * Read→file→Read 的循环，而且它本身已通过自身限制做了边界控制）。
   */
  maxResultSizeChars: number
  /**
   * 为 true 时为该工具启用严格模式，使 API 更严格地遵循工具指令与
   * 参数 schema。仅在启用 limkenion_tool_pear 时生效。
   */
  readonly strict?: boolean

  /**
   * 在观察者看到 tool_use input 之前（SDK 流、transcript、canUseTool、
   * PreToolUse/PostToolUse 钩子）对其副本调用。可就地修改以补充
   * 遗留/派生字段。必须幂等。发往 API 的原始 input 从不被修改
   * （以保留提示词缓存）。当钩子/权限返回全新的 updatedInput 时不再
   * 重新应用 —— 那些输入的结构由它们自己负责。
   */
  backfillObservableInput?(input: Record<string, unknown>): void

  /**
   * 判断在当前上下文下该工具是否允许以此输入运行。
   * 它向模型说明工具调用为何失败，本身不直接显示任何 UI。
   * @param input
   * @param context
   */
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  /**
   * 判断是否要向用户请求权限。只在 validateInput() 通过之后调用。
   * 通用权限逻辑在 permissions.ts 中。此方法只放工具特有的逻辑。
   * @param input
   * @param context
   */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  // 可选方法，供操作文件路径的工具实现
  getPath?(input: z.infer<Input>): string

  /**
   * 为钩子的 `if` 条件准备匹配器（形如 "Bash(git *)" 里 "git *" 这类
   * 权限规则模式）。每个「钩子输入对」调用一次；开销较大的解析放在这里完成。
   * 返回一个闭包，每个钩子模式调用一次。若未实现，则只能做工具名级别的匹配。
   */
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>

  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  userFacingNameBackgroundColor?(
    input: Partial<z.infer<Input>> | undefined,
  ): keyof Theme | undefined
  /**
   * 透明包装器（例如 REPL）把所有渲染委托给自己的进度处理器，
   * 由后者为每个内部工具调用产出外观一致的原生块。
   * 包装器本身不显示任何内容。
   */
  isTransparentWrapper?(): boolean
  /**
   * 返回该工具调用的简短摘要字符串，用于精简视图展示。
   * @param input 工具输入
   * @returns 简短摘要字符串；返回 null 表示不展示
   */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  /**
   * 返回供 spinner 展示的、人类可读的现在进行时活动描述。
   * 例如："Reading src/foo.ts"、"Running bun test"、"Searching for pattern"
   * @param input 工具输入
   * @returns 活动描述字符串；返回 null 则回退为工具名
   */
  getActivityDescription?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | null
  /**
   * 返回该工具调用的紧凑表示，用于 auto 模式的安全分类器。
   * 例如：Bash 用 `ls -la`，Edit 用 `/tmp/x: new content`。
   * 返回 '' 表示在分类器 transcript 中跳过该工具（例如与安全无关的工具）。
   * 也可以返回对象，以免调用方再做 JSON 包装时造成二次编码。
   */
  toAutoClassifierInput(input: z.infer<Input>): unknown
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam
  /**
   * 可选。省略时工具结果不渲染任何内容（等同于返回 null）。
   * 若工具结果已在别处呈现则可省略（例如 TodoWrite 更新的是 todo 面板，
   * 而不是 transcript）。
   */
  renderToolResultMessage?(
    content: Output,
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
      isBriefOnly?: boolean
      /** 可用的原始 tool_use input。便于生成引用了请求内容的
       * 精简结果摘要（例如 "Sent to #foo"）。 */
      input?: unknown
    },
  ): React.ReactNode
  /**
   * renderToolResultMessage 在 TRANSCRIPT 模式（verbose=true、
   * isTranscriptMode=true）下展示内容的扁平化文本。用于 transcript 搜索索引：
   * 索引统计该字符串中的出现次数，高亮层则扫描真实屏幕缓冲区。
   * 要让计数 ≡ 高亮，这里必须返回最终可见的文本 —— 而不是
   * mapToolResultToToolResultBlockParam 那种面向模型的序列化结果
   * （它会额外加上 system-reminder、持久化输出包装等）。
   *
   * 少计数没关系。"Found 3 files in 12ms" 不值得建索引。
   * 幻影则不行 —— 这里声称有、实际却没渲染出来的文本，属于
   * 计数≠高亮的 bug。
   *
   * 可选：省略时走 transcriptSearch.ts 里的字段名启发式。
   * 漂移由 test/utils/transcriptSearch.renderFidelity.test.tsx 把关 ——
   * 它渲染样例输出，并标出「已索引但未渲染」（幻影）或
   * 「已渲染但未索引」（少计数告警）的文本。
   */
  extractSearchText?(out: Output): string
  /**
   * 渲染工具调用消息。注意 `input` 是部分内容 —— 我们会尽早渲染消息，
   * 可能在工具参数还没流式传输完成时就已经渲染了。
   */
  renderToolUseMessage(
    input: Partial<z.infer<Input>>,
    options: { theme: ThemeName; verbose: boolean; commands?: Command[] },
  ): React.ReactNode
  /**
   * 当该输出的非 verbose 渲染被截断（即点击展开会看到更多内容）时返回 true。
   * 用于在全屏模式下控制点击展开 —— 只有 verbose 确实能显示更多内容的消息
   * 才给出悬停/点击提示。未设置表示永不截断。
   */
  isResultTruncated?(output: Output): boolean
  /**
   * 渲染一个可选标签，显示在工具调用消息之后。
   * 用于展示超时、模型、resume ID 之类的附加元数据。
   * 返回 null 表示不显示任何内容。
   */
  renderToolUseTag?(input: Partial<z.infer<Input>>): React.ReactNode
  /**
   * 可选。省略时工具运行期间不显示任何进度 UI。
   */
  renderToolUseProgressMessage?(
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      tools: Tools
      verbose: boolean
      terminalSize?: { columns: number; rows: number }
      inProgressToolCallCount?: number
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  renderToolUseQueuedMessage?(): React.ReactNode
  /**
   * 可选。省略时回退到 <FallbackToolUseRejectedMessage />。
   * 只为需要自定义拒绝 UI 的工具定义（例如需要展示被拒绝 diff 的文件编辑）。
   */
  renderToolUseRejectedMessage?(
    input: z.infer<Input>,
    options: {
      columns: number
      messages: Message[]
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      progressMessagesForMessage: ProgressMessage<P>[]
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  /**
   * 可选。省略时回退到 <FallbackToolUseErrorMessage />。
   * 只为需要自定义错误 UI 的工具定义（例如搜索工具展示
   * "File not found" 而不是原始错误）。
   */
  renderToolUseErrorMessage?(
    result: ToolResultBlockParam['content'],
    options: {
      progressMessagesForMessage: ProgressMessage<P>[]
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
    },
  ): React.ReactNode

  /**
   * 把该工具的多个并行实例作为一个分组渲染。
   * @returns 要渲染的 React 节点；返回 null 则回退为逐个渲染
   */
  /**
   * 把多个工具调用作为一个分组渲染（仅非 verbose 模式）。
   * 在 verbose 模式下，各工具调用仍在其原始位置单独渲染。
   * @returns 要渲染的 React 节点；返回 null 则回退为逐个渲染
   */
  renderGroupedToolUse?(
    toolUses: Array<{
      param: ToolUseBlockParam
      isResolved: boolean
      isError: boolean
      isInProgress: boolean
      progressMessages: ProgressMessage<P>[]
      result?: {
        param: ToolResultBlockParam
        output: unknown
      }
    }>,
    options: {
      shouldAnimate: boolean
      tools: Tools
    },
  ): React.ReactNode | null
}

/**
 * 一组工具。请用这个类型而不是 `Tool[]`，以便更容易追踪工具集在代码库
 * 中被组装、传递和过滤的位置。
 */
export type Tools = readonly Tool[]

/**
 * `buildTool` 会提供默认实现的方法。`ToolDef` 可以省略这些；
 * 生成的 `Tool` 则总是具备它们。
 */
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

/**
 * `buildTool` 接受的工具定义。形状与 `Tool` 相同，但那些有默认值的方法
 * 是可选的 —— `buildTool` 会把它们补齐，使调用方总能拿到完整的 `Tool`。
 */
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * 类型层面的展开，对应 `{ ...TOOL_DEFAULTS, ...def }`。对每个有默认值的键：
 * 若 D 提供了它（必填），则采用 D 的类型；若 D 省略了它、或它是可选的
 * （继承自约束中的 Partial<>），则由默认值填充。其余键原样取自 D ——
 * 保持参数个数、可选性与字面量类型，与 `satisfies Tool` 完全一致。
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * 从部分定义构建出完整的 `Tool`，为那些常被写成空实现的方法填充安全默认值。
 * 所有工具的导出都应经过这里，以便默认值集中在一处，调用方永远不需要
 * 写 `?.() ?? default`。
 *
 * 默认值（在关键处采取失败即关闭策略）：
 * - `isEnabled` → `true`
 * - `isConcurrencySafe` → `false`（假定不安全）
 * - `isReadOnly` → `false`（假定会写入）
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{ behavior: 'allow', updatedInput }`（交由通用权限系统处理）
 * - `toAutoClassifierInput` → `''`（跳过分类器 —— 涉及安全的工具必须覆写）
 * - `userFacingName` → `name`
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

// 默认值类型取的是 TOOL_DEFAULTS 的真实形状（参数设为可选，这样
// 0 参与全参两种调用点都能通过类型检查 —— 各 stub 的参数个数本就不一致，
// 而测试依赖了这一点），而不是接口里那些严格签名。
type ToolDefaults = typeof TOOL_DEFAULTS

// D 由调用点推断出具体的对象字面量类型。约束为方法参数提供上下文类型；
// 约束位置上的 `any` 是结构化用法，绝不会泄漏到返回类型中。
// BuiltTool<D> 在类型层面镜像运行时的 `{...TOOL_DEFAULTS, ...def}`。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any, any>

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  // 运行时的展开很直接；`as` 用来弥合「结构化的 any 约束」与精确的
  // BuiltTool<D> 返回类型之间的落差。类型语义已由覆盖 60+ 个工具的
  // 0 错误 typecheck 验证过。
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
