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
  | { type: 'fork_session'; sessionId: string; title?: string; atIndex?: number }
  | { type: 'get_settings'; sessionId?: string }
  | { type: 'set_setting'; key: string; value: unknown; sessionId?: string }
  | { type: 'get_stats' }
  | { type: 'get_team'; sessionId: string }
  | { type: 'team_message'; sessionId: string; member: string; text: string }
  | { type: 'get_requests'; limit?: number }
  | { type: 'clear_requests'; limit?: number }
  | { type: 'export_session'; sessionId: string }
  | { type: 'list_files' }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'always' | 'deny' }
  | { type: 'question_response'; requestId: string; answers: QuestionAnswer[] }
  /** 全局搜索：跨会话消息 + 文件名 + 会话标题。 */
  | { type: 'search'; query: string; limit?: number }
  /** MCP 图形化管理：列出 / 保存 / 删除（scope 决定写哪个设置文件）。 */
  | { type: 'mcp_list' }
  | {
      type: 'mcp_save'
      name: string
      config: Record<string, unknown>
      scope?: SettingsScope
    }
  | { type: 'mcp_delete'; name: string; scope?: SettingsScope }
  /** 定时任务（界面）：列 / 建 / 删。周期写法与模型的 CronCreate 同一套。 */
  | { type: 'cron_list' }
  | {
      type: 'cron_create'
      sessionId: string
      prompt: string
      schedule?: string
      interval_ms?: number
    }
  | { type: 'cron_delete'; id: string }

/** 设置文件的作用域：user=全局、project=项目共享、local=项目私有。 */
export type SettingsScope = 'user' | 'project' | 'local'

/** MCP 服务器（合并后的生效配置 + 来源作用域 + 连接状态）。 */
export interface McpServerInfo {
  name: string
  transport: string
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  headers: Record<string, string>
  source: SettingsScope
  state: string
  error: string | null
  problem: string | null
  tools: string[]
  serverInfo: string | null
}

/** 全局搜索里的一条命中。 */
export type SearchHit =
  | {
      kind: 'message'
      sessionId: string
      sessionTitle: string
      messageId: string
      role: 'user' | 'assistant' | 'system'
      timestamp: number | null
      snippet: string
    }
  | { kind: 'file'; path: string }
  | { kind: 'session'; sessionId: string; sessionTitle: string }

/** 服务端 → 客户端消息。 */
export type ServerMessage =
  | { type: 'hello'; sessions: SessionInfo[]; serverVersion: string }
  | { type: 'session_messages'; sessionId: string; messages: ChatMessage[] }
  /** 会话分叉成功（对应 CLI 的 /branch）。随后会紧跟一条 session_messages 切过去。 */
  | { type: 'session_forked'; sessionId: string; fromId: string; title: string; messageCount: number }
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
  | { type: 'requests'; requests: RequestLogEntry[]; summary: RequestSummary; cleared?: number }
  | { type: 'files'; files: string[] }
  /**
   * 搜索结果。`complete=false` 表示命中数触顶被截断（学 codex file-search 的
   * 增量快照语义），前端可以先渲染这批，不必假装它是全部。
   */
  | { type: 'search_results'; query: string; hits: SearchHit[]; complete: boolean; truncated: boolean }
  /** MCP 服务器清单（保存/删除后也会重新推一份）。 */
  | { type: 'mcp_servers'; servers: McpServerInfo[] }
  /** 定时任务清单（创建/删除后也会重新推一份）。 */
  | { type: 'crons'; crons: CronInfo[] }
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
  | { type: 'preview_open'; sessionId: string; url: string }
  | { type: 'team'; sessionId: string; team: TeamInfo | null }
  | { type: 'team_event'; sessionId: string; member: string; payload: Record<string, unknown> & { type?: string } }
  | { type: 'error'; message: string }

/** 一条定时任务。 */
export interface CronInfo {
  id: string
  sessionId: string
  everyMs: number
  prompt: string
}

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
  /** 推理强度档位；null 表示未设置（用服务端默认，思考链开启）。 */
  effortLevel: EffortLevel | null
  /** 按当前模型解析后的实际档位（max 在非 v4-pro 上会降级为 high）。 */
  effectiveEffort: EffortLevel | null
  workspace: string
  engine: 'deepseek' | 'mock'
}

/**
 * 推理强度档位 —— **与 CLI 的 EFFORT_LEVELS 保持一致**（utils/effort.ts）。
 *
 * 实测 `POST /chat/completions` 的 reasoning_effort 取值：
 * none（关思考）/ minimal / low / medium / high / max 可用，`auto` 会 400。
 * CLI 只暴露 low|medium|high|max，所以这里也只暴露这四档。
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

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
  /** 非空表示这是 MCP elicitation 的结构化表单（一次渲染全部字段）。 */
  form?: ElicitForm
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

/** 一次模型请求的记录（服务端内存环形缓冲，进程重启即清空）。 */
export interface RequestLogEntry {
  id: number
  /** 请求发起时刻（epoch ms）。 */
  at: number
  durationMs: number
  model: string
  ok: boolean
  /** 失败时的错误码（如 HTTP_429 / TRANSPORT / MISSING_CREDENTIAL）。 */
  code: string | null
  error: string | null
  inputTokens: number
  outputTokens: number
  sessionId: string | null
}

/** 请求记录的汇总（面板顶部统计条）。 */
export interface RequestSummary {
  count: number
  ok: number
  failed: number
  avgMs: number
  maxMs: number
  inputTokens: number
  outputTokens: number
}


/** MCP elicitation 的结构化表单（MCP requestedSchema 的前端投影）。 */
export interface ElicitField {
  name: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  description?: string
  options?: string[]
  required?: boolean
}
export interface ElicitForm {
  fields: ElicitField[]
}

/** Agent Teams 工作台：团队快照。 */
export interface TeamMember {
  name: string
  role?: string
  status?: 'idle' | 'busy' | 'stopped'
}
export interface TeamLogEntry {
  to: string
  message: string
  summary?: string
  at: number
}
export interface TeamInfo {
  name: string | null
  members: TeamMember[]
  log: TeamLogEntry[]
}
