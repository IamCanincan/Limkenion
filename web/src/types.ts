/** Limkenion web 客户端共用的协议类型与视图类型。 */

// ---------------------------------------------------------------------------
// 线上协议（客户端 ⇄ 服务端，走 WebSocket）
// ---------------------------------------------------------------------------

/** 客户端 → 服务端消息。 */
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

/** 服务端 → 客户端消息。 */
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
// 视图模型
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
  /** 工具输入的紧凑单行摘要，例如文件路径或命令。 */
  input: string
  status: ToolCallStatus
  /** 完整输入载荷（类 JSON 文本），展开时展示。 */
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
  /** 助手正文仍在流式输出时为 true。 */
  streaming?: boolean
  /** 思维链仍在流式输出时为 true。 */
  reasoningStreaming?: boolean
  /** 本助手回合内发生的工具调用（即「回合过程」）。 */
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

/** 一条 CLI 斜杠命令，镜像自命令注册表的索引文件。 */
export interface CommandInfo {
  name: string
  description: string
  aliases: string[]
  /** 简短用法提示，例如 "[model]"。 */
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
  /** 本次服务运行期间所有会话累计的 token。 */
  total: TokenUsage
  /** 给定（最近一次查询的）会话的 token。 */
  session: TokenUsage
  sessionCount: number
  turnCount: number
  toolCallCount: number
  uptimeMs: number
}

export type ConnectionState = 'connecting' | 'open' | 'closed'
