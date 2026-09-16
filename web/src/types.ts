/** Shared protocol + view types for the Limkenion web client. */

// ---------------------------------------------------------------------------
// Wire protocol (client ⇄ server over WebSocket)
// ---------------------------------------------------------------------------

/** Client → server messages. */
export type ClientMessage =
  | { type: 'new_session' }
  | { type: 'select_session'; sessionId: string }
  | { type: 'rename_session'; sessionId: string; title: string }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'user_message'; sessionId: string; text: string; images?: ImageAttachment[] }
  | { type: 'cancel'; sessionId: string }
  | { type: 'run_command'; sessionId: string; command: string }
  | { type: 'get_models' }
  | { type: 'set_model'; model: string; sessionId?: string }
  | { type: 'get_settings'; sessionId?: string }
  | { type: 'set_setting'; key: string; value: unknown; sessionId?: string }
  | { type: 'get_stats' }
  | { type: 'export_session'; sessionId: string }
  | { type: 'list_files' }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'always' | 'deny' }
  | { type: 'question_response'; requestId: string; answers: QuestionAnswer[] }

/** Server → client messages. */
export type ServerMessage =
  | { type: 'hello'; sessions: SessionInfo[]; serverVersion: string }
  | { type: 'session_messages'; sessionId: string; messages: ChatMessage[] }
  | {
      type: 'user_message'
      sessionId: string
      message: ChatMessage
    }
  | {
      type: 'assistant_start'
      sessionId: string
      messageId: string
    }
  | { type: 'assistant_delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'assistant_reasoning'; sessionId: string; messageId: string; delta: string }
  | {
      type: 'tool_call'
      sessionId: string
      messageId: string
      toolCall: ToolCall
    }
  | {
      type: 'tool_result'
      sessionId: string
      messageId: string
      toolCallId: string
      ok: boolean
      result: string
      durationMs: number
      /** 写盘类工具（Write/Edit/NotebookEdit）的 unified diff。 */
      diff?: string
    }
  | {
      type: 'turn_complete'
      sessionId: string
      messageId: string
      usage: TokenUsage
    }
  | { type: 'turn_cancelled'; sessionId: string; messageId: string }
  | { type: 'sessions_changed'; sessions: SessionInfo[] }
  | { type: 'commands'; commands: CommandInfo[] }
  | { type: 'models'; models: ModelInfo[]; current: string }
  | { type: 'model_changed'; model: string; sessionId?: string | null }
  | { type: 'settings'; settings: Settings; sessionId?: string | null }
  | { type: 'stats'; stats: UsageStats }
  | { type: 'files'; files: string[] }
  | { type: 'command_result'; sessionId: string; output: string }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_export'; sessionId: string; filename: string; markdown: string }
  | { type: 'plan_mode_changed'; active: boolean; sessionId?: string; plan?: string }
  | { type: 'notice'; sessionId?: string; text: string }
  | {
      type: 'permission_request'
      sessionId: string
      requestId: string
      toolName: string
      input: Record<string, unknown>
      permissionMode?: PermissionMode
      /** 非空表示这是「升级确认」：shell 守卫命中或本回合接触过不可信内容。 */
      escalate?: string | null
    }
  | { type: 'question_request'; sessionId: string; requestId: string; questions: AskQuestion[] }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
export type ThemeMode = 'dark' | 'light' | 'system'

/** 全局设置（镜像 CLI settings）。 */
export interface Settings {
  theme: ThemeMode
  permissionMode: PermissionMode
  model: string
  outputStyle: string
  workspace: string
  engine: 'deepseek' | 'mock'
}

export type ToolCallStatus = 'running' | 'done' | 'error'

export interface ToolCall {
  id: string
  name: string
  /** Compact one-line summary of the tool input, e.g. a file path or command. */
  input: string
  status: ToolCallStatus
  /** Full input payload (JSON-ish text), shown when expanded. */
  inputDetail?: string
  result?: string
  durationMs?: number
  /** unified diff，写盘类工具才有。 */
  diff?: string
}

/** 图片附件（base64 data URL）。 */
export interface ImageAttachment {
  dataUrl: string
  name: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  /** 用户消息附带的图片。 */
  images?: ImageAttachment[]
  /** DeepSeek 思维链（reasoning_content），思考模型回台时存在。 */
  reasoning?: string
  /** True while the assistant text is still streaming in. */
  streaming?: boolean
  /** True while the reasoning chain is still streaming in. */
  reasoningStreaming?: boolean
  /** Tool calls that happened inside this assistant turn ("turn process"). */
  toolCalls?: ToolCall[]
  usage?: TokenUsage
  timestamp: number
}

export interface SessionInfo {
  id: string
  title: string
  updatedAt: number
  messageCount: number
  planMode?: boolean
  tags?: string[]
}

/** A CLI slash command, mirrored from the commands registry index files. */
export interface CommandInfo {
  name: string
  description: string
  aliases: string[]
  /** Short usage hint, e.g. "[model]". */
  argumentHint?: string
}

export interface ModelInfo {
  value: string
  label: string
  description: string
}

/** AskUserQuestion 的单个问题（对齐 CLI AskUserQuestionTool 载荷）。 */
export interface AskQuestion {
  question: string
  header: string
  multiSelect?: boolean
  options: { label: string; description: string; preview?: string }[]
}

/** 用户对单个问题的作答。 */
export interface QuestionAnswer {
  question: string
  answer: string | string[]
}

export interface UsageStats {
  /** Tokens aggregated over all sessions this server run. */
  total: TokenUsage
  /** Tokens for the given (last queried) session. */
  session: TokenUsage
  sessionCount: number
  turnCount: number
  toolCallCount: number
  uptimeMs: number
}

export type ConnectionState = 'connecting' | 'open' | 'closed'
