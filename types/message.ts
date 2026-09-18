/**
 * 核心消息类型定义（真实类型，替换初建仓库时的 @generated stub）。
 *
 * 形状依据代码库实际用法重建：
 * - 工厂函数：utils/messages.ts（createUserMessage / baseCreateAssistantMessage /
 *   createProgressMessage / createSystemMessage 系列 / createToolUseSummaryMessage）
 * - UI 分组：utils/groupToolUses.ts（GroupedToolUseMessage）、
 *   utils/collapseReadSearch.ts（CollapsedReadSearchGroup）
 * - 流事件构造：services/api/limkenion.ts（StreamEvent / AssistantMessage）
 * - 协议类型：types/llm-protocol.ts（BetaMessage / ContentBlock 等，真实存在）
 */
import type { UUID } from 'crypto'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from './llm-protocol.js'
import type { SDKAssistantMessageError } from '../entrypoints/agentSdkTypes.js'
import type { Progress } from '../Tool.js'
import type { PermissionMode } from './permissions.js'
import type { Attachment } from '../utils/attachments.js'

// ============================================================================
// 基础标量
// ============================================================================

/** 消息来源。undefined = 人类（键盘）输入。 */
export type MessageOrigin = string

/** 系统消息展示级别。 */
export type SystemMessageLevel = string

/** 部分压缩方向（summarizeMetadata.direction）。 */
export type PartialCompactDirection = string

export interface CompactMetadata {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
}

export interface MicrocompactMetadata {
  trigger: string
  preTokens: number
  tokensSaved: number
  compactedToolIds: string[]
  clearedAttachmentUUIDs: string[]
}

export interface StopHookInfo {
  command: string
  durationMs?: number
  hookName?: string
  preventedContinuation?: boolean
}

// ============================================================================
// 用户 / 助手消息
// ============================================================================

export interface UserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  uuid: UUID
  timestamp?: string
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  /** 工具的 `Output` 类型（结构随工具而异，消费方自行收窄） */
  toolUseResult?: unknown
  /** MCP 协议元数据（透传给 SDK 消费者，不发给模型） */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  /** tool_result 消息：与之配对的 tool_use 所在 assistant 消息的 UUID */
  sourceToolAssistantUUID?: UUID
  /** 发送消息时的权限模式（用于 rewind 恢复） */
  permissionMode?: PermissionMode
  origin?: MessageOrigin
}

export interface AssistantMessage {
  type: 'assistant'
  message: BetaMessage
  uuid: UUID
  timestamp?: string
  requestId?: string
  /** API 错误类别（如 'max_output_tokens'） */
  apiError?: string
  error?: SDKAssistantMessageError
  errorDetails?: string
  isApiErrorMessage?: boolean
  isVirtual?: true
  isMeta?: boolean
  advisorModel?: string
}

// ============================================================================
// 进度 / 附件 / 流事件
// ============================================================================

export interface ProgressMessage<P = Progress> {
  type: 'progress'
  data: P
  toolUseID: string
  parentToolUseID: string
  uuid: UUID
  timestamp?: string
}

export interface AttachmentMessage {
  type: 'attachment'
  attachment: Attachment
  uuid: UUID
  timestamp?: string
}

export interface StreamEvent {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  /** 仅 message_start 事件携带 */
  ttftMs?: number
  uuid?: UUID
  timestamp?: string
}

// ============================================================================
// 墓碑 / 摘要 / 请求起点
// ============================================================================

/** 标记某条 assistant 消息已被丢弃（如无效签名的部分消息） */
export interface TombstoneMessage {
  type: 'tombstone'
  message: AssistantMessage
  uuid?: UUID
  timestamp?: string
}

export interface ToolUseSummaryMessage {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
  uuid: UUID
  timestamp?: string
}

/** 一轮 API 请求开始的信号（query 生成器联用类型） */
export interface RequestStartEvent {
  type: 'request_start'
  uuid?: UUID
  timestamp?: string
}

/** 钩子执行结果消息（预留，当前无构造点） */
export interface HookResultMessage {
  type: 'hook_result'
  content?: string
  toolUseID?: string
  uuid?: UUID
  timestamp?: string
}

// ============================================================================
// 系统消息（单接口 + subtype 交集，字段随 subtype 可选）
// ============================================================================

interface SystemMessageBase {
  type: 'system'
  subtype: string
  uuid: UUID
  timestamp?: string
  isMeta?: boolean
  toolUseID?: string
  level?: SystemMessageLevel
  content?: string
  commands?: string[]
  url?: string
  upgradeNudge?: string
  preventContinuation?: boolean
  cause?: Error
  error?: Error
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  hookErrors?: string[]
  hookLabel?: string
  preventedContinuation?: boolean
  stopReason?: string
  hasOutput?: boolean
  totalDurationMs?: number
  durationMs?: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
  writtenPaths?: string[]
  ttftMs?: number
  otps?: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  classifierCount?: number
  configWriteCount?: number
  compactMetadata?: CompactMetadata
  microcompactMetadata?: MicrocompactMetadata
  snapshotFiles?: { key: string; path: string; content: string }[]
}

export type SystemMessage = SystemMessageBase

export type SystemInformationalMessage = SystemMessageBase & {
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
}
export type SystemAPIErrorMessage = SystemMessageBase & {
  subtype: 'api_error'
  level: 'error'
}
export type SystemPermissionRetryMessage = SystemMessageBase & {
  subtype: 'permission_retry'
  content: string
  commands: string[]
}
export type SystemBridgeStatusMessage = SystemMessageBase & {
  subtype: 'bridge_status'
  content: string
  url: string
}
export type SystemScheduledTaskFireMessage = SystemMessageBase & {
  subtype: 'scheduled_task_fire'
  content: string
}
export type SystemStopHookSummaryMessage = SystemMessageBase & {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason: string | undefined
  hasOutput: boolean
}
export type SystemTurnDurationMessage = SystemMessageBase & {
  subtype: 'turn_duration'
  durationMs: number
}
export type SystemAwaySummaryMessage = SystemMessageBase & {
  subtype: 'away_summary'
  content: string
}
export type SystemMemorySavedMessage = SystemMessageBase & {
  subtype: 'memory_saved'
  writtenPaths: string[]
}
export type SystemAgentsKilledMessage = SystemMessageBase & {
  subtype: 'agents_killed'
}
export type SystemApiMetricsMessage = SystemMessageBase & {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
}
export type SystemLocalCommandMessage = SystemMessageBase & {
  subtype: 'local_command'
  content: string
}
export type SystemCompactBoundaryMessage = SystemMessageBase & {
  subtype: 'compact_boundary'
  content: string
  compactMetadata: CompactMetadata
  logicalParentUuid?: UUID
}
export type SystemMicrocompactBoundaryMessage = SystemMessageBase & {
  subtype: 'microcompact_boundary'
  content: string
  microcompactMetadata: MicrocompactMetadata
}
export type SystemFileSnapshotMessage = SystemMessageBase & {
  subtype: 'file_snapshot'
  content: string
  snapshotFiles: { key: string; path: string; content: string }[]
}
export type SystemThinkingMessage = SystemMessageBase & {
  subtype: 'thinking'
}

// ============================================================================
// 归一化消息（每条只含单个 content block）
// ============================================================================

export type NormalizedUserMessage = Omit<UserMessage, 'message'> & {
  message: {
    role: 'user'
    content: [ContentBlockParam, ...ContentBlockParam[]]
  }
}

export type NormalizedAssistantMessage = Omit<AssistantMessage, 'message'> & {
  message: Omit<BetaMessage, 'content' | 'context_management'> & {
    content: [BetaContentBlock, ...BetaContentBlock[]]
    context_management: BetaMessage['context_management'] | null
  }
}

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage

// ============================================================================
// UI 渲染分组
// ============================================================================

export interface GroupedToolUseMessage {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage
  uuid: string
  timestamp?: string
  messageId: string
}

export interface CollapsedReadSearchGroup {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint: string
  messages: RenderableMessage[]
  displayMessage: CollapsibleMessage
  uuid: string
  timestamp?: string
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: { kind: string; sha: string; [k: string]: unknown }[]
  pushes?: { branch: string; [k: string]: unknown }[]
  branches?: { action: string; [k: string]: unknown }[]
  prs?: { action: string; number: number; url?: string; [k: string]: unknown }[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: { path: string; content?: string; [k: string]: unknown }[]
}

/** 可折叠进 read/search 分组的消息 */
export type CollapsibleMessage =
  | GroupedToolUseMessage
  | NormalizedAssistantMessage
  | NormalizedUserMessage

/** UI 渲染层处理的消息集合 */
export type RenderableMessage =
  | NormalizedMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

// ============================================================================
// 顶层联合
// ============================================================================

/**
 * 会话消息联合。TombstoneMessage / ToolUseSummaryMessage / StreamEvent /
 * RequestStartEvent 不在其中——它们只出现在 query 生成器的联合签名里。
 */
export type Message =
  | UserMessage
  | AssistantMessage
  | ProgressMessage
  | AttachmentMessage
  | SystemMessage
