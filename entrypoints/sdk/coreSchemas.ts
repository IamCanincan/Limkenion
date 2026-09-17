/**
 * SDK 核心架构 - 可序列化 SDK 数据类型对应的 Zod 架构。
 *
 * 这些架构是 SDK 数据类型的唯一事实来源。
 * TypeScript 类型由这些架构生成并提交，以支持 IDE 提示。
 *
 * @see scripts/generate-sdk-types.ts 类型生成相关
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

// ============================================================================
// 使用量与模型类型
// ============================================================================

export const ModelUsageSchema = lazySchema(() =>
  z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    webSearchRequests: z.number(),
    costUSD: z.number(),
    contextWindow: z.number(),
    maxOutputTokens: z.number(),
  }),
)

// ============================================================================
// 输出格式类型
// ============================================================================

export const OutputFormatTypeSchema = lazySchema(() => z.literal('json_schema'))

export const BaseOutputFormatSchema = lazySchema(() =>
  z.object({
    type: OutputFormatTypeSchema(),
  }),
)

export const JsonSchemaOutputFormatSchema = lazySchema(() =>
  z.object({
    type: z.literal('json_schema'),
    schema: z.record(z.string(), z.unknown()),
  }),
)

export const OutputFormatSchema = lazySchema(() =>
  JsonSchemaOutputFormatSchema(),
)

// ============================================================================
// 配置类型
// ============================================================================

export const ApiKeySourceSchema = lazySchema(() =>
  z.enum(['user', 'project', 'org', 'temporary', 'oauth']),
)

export const ConfigScopeSchema = lazySchema(() =>
  z.enum(['local', 'user', 'project']).describe('设置的作用域。'),
)

export const SdkBetaSchema = lazySchema(() =>
  z.literal('context-1m-2025-08-07'),
)

export const ThinkingAdaptiveSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('adaptive'),
    })
    .describe('Limkenion 自行决定是否思考以及思考的深度。'),
)

export const ThinkingEnabledSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('enabled'),
      budgetTokens: z.number().optional(),
    })
    .describe('固定思考 token 预算（旧模型）'),
)

export const ThinkingDisabledSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('disabled'),
    })
    .describe('不进行扩展思考'),
)

export const ThinkingConfigSchema = lazySchema(() =>
  z
    .union([
      ThinkingAdaptiveSchema(),
      ThinkingEnabledSchema(),
      ThinkingDisabledSchema(),
    ])
    .describe(
      '控制 Limkenion 的思考/推理行为。设置后，将优先于已废弃的 maxThinkingTokens。',
    ),
)

// ============================================================================
// MCP 服务器配置类型（仅可序列化）
// ============================================================================

export const McpStdioServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('stdio').optional(), // 可选，用于向后兼容
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
)

export const McpSSEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
)

export const McpHttpServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
)

export const McpSdkServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sdk'),
    name: z.string(),
  }),
)

export const McpServerConfigForProcessTransportSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpHttpServerConfigSchema(),
    McpSdkServerConfigSchema(),
  ]),
)

export const McpLimkenionAIProxyServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('limkenionai-proxy'),
    url: z.string(),
    id: z.string(),
  }),
)

// 状态响应使用的更宽泛的配置类型（包含仅作输出的 limkenionai-proxy）
export const McpServerStatusConfigSchema = lazySchema(() =>
  z.union([
    McpServerConfigForProcessTransportSchema(),
    McpLimkenionAIProxyServerConfigSchema(),
  ]),
)

export const McpServerStatusSchema = lazySchema(() =>
  z
    .object({
      name: z.string().describe('配置的服务器名称'),
      status: z
        .enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])
        .describe('当前连接状态'),
      serverInfo: z
        .object({
          name: z.string(),
          version: z.string(),
        })
        .optional()
        .describe('服务器信息（连接后可用）'),
      error: z
        .string()
        .optional()
        .describe("错误信息（当状态为 'failed' 时可用）"),
      config: McpServerStatusConfigSchema()
        .optional()
        .describe('服务器配置（包含 HTTP/SSE 服务器的 URL）'),
      scope: z
        .string()
        .optional()
        .describe(
          '配置作用域（例如：project、user、local、limkenionai、managed）',
        ),
      tools: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            annotations: z
              .object({
                readOnly: z.boolean().optional(),
                destructive: z.boolean().optional(),
                openWorld: z.boolean().optional(),
              })
              .optional(),
          }),
        )
        .optional()
        .describe('此服务器提供的工具（连接后可用）'),
      capabilities: z
        .object({
          experimental: z.record(z.string(), z.unknown()).optional(),
        })
        .optional()
        .describe(
          "@internal 服务器能力（连接后可用）。experimental['limkenion/channel'] 仅当服务器的插件在已获准的渠道白名单中时才会存在——可依据其是否存在来决定是否显示启用渠道的提示。",
        ),
    })
    .describe('MCP 服务器连接的状态信息。'),
)

export const McpSetServersResultSchema = lazySchema(() =>
  z
    .object({
      added: z.array(z.string()).describe('已添加的服务器名称'),
      removed: z
        .array(z.string())
        .describe('已移除的服务器名称'),
      errors: z
        .record(z.string(), z.string())
        .describe(
          '连接失败的服务器名称到错误信息的映射',
        ),
    })
    .describe('setMcpServers 操作的结果。'),
)

// ============================================================================
// 权限类型
// ============================================================================

export const PermissionUpdateDestinationSchema = lazySchema(() =>
  z.enum([
    'userSettings',
    'projectSettings',
    'localSettings',
    'session',
    'cliArg',
  ]),
)

export const PermissionBehaviorSchema = lazySchema(() =>
  z.enum(['allow', 'deny', 'ask']),
)

export const PermissionRuleValueSchema = lazySchema(() =>
  z.object({
    toolName: z.string(),
    ruleContent: z.string().optional(),
  }),
)

export const PermissionUpdateSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('addRules'),
      rules: z.array(PermissionRuleValueSchema()),
      behavior: PermissionBehaviorSchema(),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('replaceRules'),
      rules: z.array(PermissionRuleValueSchema()),
      behavior: PermissionBehaviorSchema(),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('removeRules'),
      rules: z.array(PermissionRuleValueSchema()),
      behavior: PermissionBehaviorSchema(),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('setMode'),
      mode: z.lazy(() => PermissionModeSchema()),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('addDirectories'),
      directories: z.array(z.string()),
      destination: PermissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('removeDirectories'),
      directories: z.array(z.string()),
      destination: PermissionUpdateDestinationSchema(),
    }),
  ]),
)

export const PermissionDecisionClassificationSchema = lazySchema(() =>
  z
    .enum(['user_temporary', 'user_permanent', 'user_reject'])
    .describe(
      '此权限决策用于遥测的分类。提示用户的 SDK 宿主（桌面应用、IDE）' +
        '应按实际发生的情况设置此值：user_temporary 表示仅本次允许，user_permanent ' +
        '表示始终允许（包括点击与后续缓存命中），user_reject ' +
        '表示拒绝。若未设置，CLI 会保守推断（允许时为 temporary，拒绝时为 reject）。' +
        '该词汇与 tool_decision OTel 事件（monitoring-usage 文档）一致。',
    ),
)

export const PermissionResultSchema = lazySchema(() =>
  z.union([
    z.object({
      behavior: z.literal('allow'),
      // 可选——若钩子在未修改输入的情况下设置权限，则可能不提供
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(PermissionUpdateSchema()).optional(),
      toolUseID: z.string().optional(),
      decisionClassification:
        PermissionDecisionClassificationSchema().optional(),
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string(),
      interrupt: z.boolean().optional(),
      toolUseID: z.string().optional(),
      decisionClassification:
        PermissionDecisionClassificationSchema().optional(),
    }),
  ]),
)

export const PermissionModeSchema = lazySchema(() =>
  z
    .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'])
    .describe(
      '用于控制如何处理工具执行的权限模式。' +
        "'default' - 标准行为，对危险操作进行提示。 " +
        "'acceptEdits' - 自动接受文件编辑操作。 " +
        "'bypassPermissions' - 绕过所有权限检查（需要 allowDangerouslySkipPermissions）。 " +
        "'plan' - 规划模式，不实际执行工具。 " +
        "'dontAsk' - 不提示权限，若未预先批准则拒绝。",
    ),
)


// ============================================================================
// 钩子类型
// ============================================================================

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

export const HookEventSchema = lazySchema(() => z.enum(HOOK_EVENTS))

export const BaseHookInputSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    transcript_path: z.string(),
    cwd: z.string(),
    permission_mode: z.string().optional(),
    agent_id: z
      .string()
      .optional()
      .describe(
        '子代理标识符。仅当钩子在子代理内部触发时才存在' +
          '（例如，由 AgentTool worker 调用的工具）。在主线程中不存在，' +
          '即使在 --agent 会话中亦然。请使用此字段（而非 agent_type）来区分' +
          '子代理调用与主线程调用。',
      ),
    agent_type: z
      .string()
      .optional()
      .describe(
        '代理类型名称（例如 "general-purpose"、"code-reviewer"）。当' +
          '钩子在子代理内部触发时存在（伴随 agent_id），或在以 --agent ' +
          '启动的会话主线程中存在（不带 agent_id）。',
      ),
  }),
)

// 使用 .and() 而非 .extend()，以在生成类型中保留 BaseHookInput 与 {...} 的交集
export const PreToolUseHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PreToolUse'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      tool_use_id: z.string(),
    }),
  ),
)

export const PermissionRequestHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PermissionRequest'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      permission_suggestions: z.array(PermissionUpdateSchema()).optional(),
    }),
  ),
)

export const PostToolUseHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PostToolUse'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      tool_response: z.unknown(),
      tool_use_id: z.string(),
    }),
  ),
)

export const PostToolUseFailureHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PostToolUseFailure'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      tool_use_id: z.string(),
      error: z.string(),
      is_interrupt: z.boolean().optional(),
    }),
  ),
)

export const PermissionDeniedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PermissionDenied'),
      tool_name: z.string(),
      tool_input: z.unknown(),
      tool_use_id: z.string(),
      reason: z.string(),
    }),
  ),
)

export const NotificationHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('Notification'),
      message: z.string(),
      title: z.string().optional(),
      notification_type: z.string(),
    }),
  ),
)

export const UserPromptSubmitHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('UserPromptSubmit'),
      prompt: z.string(),
    }),
  ),
)

export const SessionStartHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('SessionStart'),
      source: z.enum(['startup', 'resume', 'clear', 'compact']),
      agent_type: z.string().optional(),
      model: z.string().optional(),
    }),
  ),
)

export const SetupHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('Setup'),
      trigger: z.enum(['init', 'maintenance']),
    }),
  ),
)

export const StopHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('Stop'),
      stop_hook_active: z.boolean(),
      last_assistant_message: z
        .string()
        .optional()
        .describe(
          '停止前最后一条助手消息的文本内容。' +
            '避免需要读取并解析转录文件。',
        ),
    }),
  ),
)

export const StopFailureHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('StopFailure'),
      error: SDKAssistantMessageErrorSchema(),
      error_details: z.string().optional(),
      last_assistant_message: z.string().optional(),
    }),
  ),
)

export const SubagentStartHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('SubagentStart'),
      agent_id: z.string(),
      agent_type: z.string(),
    }),
  ),
)

export const SubagentStopHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('SubagentStop'),
      stop_hook_active: z.boolean(),
      agent_id: z.string(),
      agent_transcript_path: z.string(),
      agent_type: z.string(),
      last_assistant_message: z
        .string()
        .optional()
        .describe(
          '停止前最后一条助手消息的文本内容。' +
            '避免需要读取并解析转录文件。',
        ),
    }),
  ),
)

export const PreCompactHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PreCompact'),
      trigger: z.enum(['manual', 'auto']),
      custom_instructions: z.string().nullable(),
    }),
  ),
)

export const PostCompactHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PostCompact'),
      trigger: z.enum(['manual', 'auto']),
      compact_summary: z
        .string()
        .describe('压缩产生的对话摘要'),
    }),
  ),
)

export const TeammateIdleHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('TeammateIdle'),
      teammate_name: z.string(),
      team_name: z.string(),
    }),
  ),
)

export const TaskCreatedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('TaskCreated'),
      task_id: z.string(),
      task_subject: z.string(),
      task_description: z.string().optional(),
      teammate_name: z.string().optional(),
      team_name: z.string().optional(),
    }),
  ),
)

export const TaskCompletedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('TaskCompleted'),
      task_id: z.string(),
      task_subject: z.string(),
      task_description: z.string().optional(),
      teammate_name: z.string().optional(),
      team_name: z.string().optional(),
    }),
  ),
)

export const ElicitationHookInputSchema = lazySchema(() =>
  BaseHookInputSchema()
    .and(
      z.object({
        hook_event_name: z.literal('Elicitation'),
        mcp_server_name: z.string(),
        message: z.string(),
        mode: z.enum(['form', 'url']).optional(),
        url: z.string().optional(),
        elicitation_id: z.string().optional(),
        requested_schema: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .describe(
      'Elicitation 事件的钩子输入。当 MCP 服务器请求用户输入时触发。钩子可以自动响应（接受/拒绝），而无需显示对话框。',
    ),
)

export const ElicitationResultHookInputSchema = lazySchema(() =>
  BaseHookInputSchema()
    .and(
      z.object({
        hook_event_name: z.literal('ElicitationResult'),
        mcp_server_name: z.string(),
        elicitation_id: z.string().optional(),
        mode: z.enum(['form', 'url']).optional(),
        action: z.enum(['accept', 'decline', 'cancel']),
        content: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .describe(
      'ElicitationResult 事件的钩子输入。在用户响应 MCP 询问后触发。钩子可以在响应发送到服务器之前观察或覆盖该响应。',
    ),
)

export const CONFIG_CHANGE_SOURCES = [
  'user_settings',
  'project_settings',
  'local_settings',
  'policy_settings',
  'skills',
] as const

export const ConfigChangeHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('ConfigChange'),
      source: z.enum(CONFIG_CHANGE_SOURCES),
      file_path: z.string().optional(),
    }),
  ),
)

export const INSTRUCTIONS_LOAD_REASONS = [
  'session_start',
  'nested_traversal',
  'path_glob_match',
  'include',
  'compact',
] as const

export const INSTRUCTIONS_MEMORY_TYPES = [
  'User',
  'Project',
  'Local',
  'Managed',
] as const

export const InstructionsLoadedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('InstructionsLoaded'),
      file_path: z.string(),
      memory_type: z.enum(INSTRUCTIONS_MEMORY_TYPES),
      load_reason: z.enum(INSTRUCTIONS_LOAD_REASONS),
      globs: z.array(z.string()).optional(),
      trigger_file_path: z.string().optional(),
      parent_file_path: z.string().optional(),
    }),
  ),
)

export const WorktreeCreateHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('WorktreeCreate'),
      name: z.string(),
    }),
  ),
)

export const WorktreeRemoveHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('WorktreeRemove'),
      worktree_path: z.string(),
    }),
  ),
)

export const CwdChangedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('CwdChanged'),
      old_cwd: z.string(),
      new_cwd: z.string(),
    }),
  ),
)

export const FileChangedHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('FileChanged'),
      file_path: z.string(),
      event: z.enum(['change', 'add', 'unlink']),
    }),
  ),
)

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const

export const ExitReasonSchema = lazySchema(() => z.enum(EXIT_REASONS))

export const SessionEndHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('SessionEnd'),
      reason: ExitReasonSchema(),
    }),
  ),
)

export const HookInputSchema = lazySchema(() =>
  z.union([
    PreToolUseHookInputSchema(),
    PostToolUseHookInputSchema(),
    PostToolUseFailureHookInputSchema(),
    PermissionDeniedHookInputSchema(),
    NotificationHookInputSchema(),
    UserPromptSubmitHookInputSchema(),
    SessionStartHookInputSchema(),
    SessionEndHookInputSchema(),
    StopHookInputSchema(),
    StopFailureHookInputSchema(),
    SubagentStartHookInputSchema(),
    SubagentStopHookInputSchema(),
    PreCompactHookInputSchema(),
    PostCompactHookInputSchema(),
    PermissionRequestHookInputSchema(),
    SetupHookInputSchema(),
    TeammateIdleHookInputSchema(),
    TaskCreatedHookInputSchema(),
    TaskCompletedHookInputSchema(),
    ElicitationHookInputSchema(),
    ElicitationResultHookInputSchema(),
    ConfigChangeHookInputSchema(),
    InstructionsLoadedHookInputSchema(),
    WorktreeCreateHookInputSchema(),
    WorktreeRemoveHookInputSchema(),
    CwdChangedHookInputSchema(),
    FileChangedHookInputSchema(),
  ]),
)

export const AsyncHookJSONOutputSchema = lazySchema(() =>
  z.object({
    async: z.literal(true),
    asyncTimeout: z.number().optional(),
  }),
)

export const PreToolUseHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PreToolUse'),
    permissionDecision: PermissionBehaviorSchema().optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    additionalContext: z.string().optional(),
  }),
)

export const UserPromptSubmitHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('UserPromptSubmit'),
    additionalContext: z.string().optional(),
  }),
)

export const SessionStartHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('SessionStart'),
    additionalContext: z.string().optional(),
    initialUserMessage: z.string().optional(),
    watchPaths: z.array(z.string()).optional(),
  }),
)

export const SetupHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Setup'),
    additionalContext: z.string().optional(),
  }),
)

export const SubagentStartHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('SubagentStart'),
    additionalContext: z.string().optional(),
  }),
)

export const PostToolUseHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUse'),
    additionalContext: z.string().optional(),
    updatedMCPToolOutput: z.unknown().optional(),
  }),
)

export const PostToolUseFailureHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUseFailure'),
    additionalContext: z.string().optional(),
  }),
)

export const PermissionDeniedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PermissionDenied'),
    retry: z.boolean().optional(),
  }),
)

export const NotificationHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Notification'),
    additionalContext: z.string().optional(),
  }),
)

export const PermissionRequestHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PermissionRequest'),
    decision: z.union([
      z.object({
        behavior: z.literal('allow'),
        updatedInput: z.record(z.string(), z.unknown()).optional(),
        updatedPermissions: z.array(PermissionUpdateSchema()).optional(),
      }),
      z.object({
        behavior: z.literal('deny'),
        message: z.string().optional(),
        interrupt: z.boolean().optional(),
      }),
    ]),
  }),
)

export const CwdChangedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('CwdChanged'),
    watchPaths: z.array(z.string()).optional(),
  }),
)

export const FileChangedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('FileChanged'),
    watchPaths: z.array(z.string()).optional(),
  }),
)

export const SyncHookJSONOutputSchema = lazySchema(() =>
  z.object({
    continue: z.boolean().optional(),
    suppressOutput: z.boolean().optional(),
    stopReason: z.string().optional(),
    decision: z.enum(['approve', 'block']).optional(),
    systemMessage: z.string().optional(),
    reason: z.string().optional(),
    hookSpecificOutput: z
      .union([
        PreToolUseHookSpecificOutputSchema(),
        UserPromptSubmitHookSpecificOutputSchema(),
        SessionStartHookSpecificOutputSchema(),
        SetupHookSpecificOutputSchema(),
        SubagentStartHookSpecificOutputSchema(),
        PostToolUseHookSpecificOutputSchema(),
        PostToolUseFailureHookSpecificOutputSchema(),
        PermissionDeniedHookSpecificOutputSchema(),
        NotificationHookSpecificOutputSchema(),
        PermissionRequestHookSpecificOutputSchema(),
        ElicitationHookSpecificOutputSchema(),
        ElicitationResultHookSpecificOutputSchema(),
        CwdChangedHookSpecificOutputSchema(),
        FileChangedHookSpecificOutputSchema(),
        WorktreeCreateHookSpecificOutputSchema(),
      ])
      .optional(),
  }),
)

export const ElicitationHookSpecificOutputSchema = lazySchema(() =>
  z
    .object({
      hookEventName: z.literal('Elicitation'),
      action: z.enum(['accept', 'decline', 'cancel']).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .describe(
      'Elicitation 事件的钩子专属输出。返回此值可通过编程方式接受或拒绝 MCP 询问请求。',
    ),
)

export const ElicitationResultHookSpecificOutputSchema = lazySchema(() =>
  z
    .object({
      hookEventName: z.literal('ElicitationResult'),
      action: z.enum(['accept', 'decline', 'cancel']).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .describe(
      'ElicitationResult 事件的钩子专属输出。返回此值可在响应发送到 MCP 服务器之前覆盖动作或内容。',
    ),
)

export const WorktreeCreateHookSpecificOutputSchema = lazySchema(() =>
  z
    .object({
      hookEventName: z.literal('WorktreeCreate'),
      worktreePath: z.string(),
    })
    .describe(
      'WorktreeCreate 事件的钩子专属输出。提供所创建 worktree 目录的绝对路径。命令钩子则改为在 stdout 上打印该路径。',
    ),
)

export const HookJSONOutputSchema = lazySchema(() =>
  z.union([AsyncHookJSONOutputSchema(), SyncHookJSONOutputSchema()]),
)

export const PromptRequestOptionSchema = lazySchema(() =>
  z.object({
    key: z
      .string()
      .describe('此选项的唯一键，将在响应中返回'),
    label: z.string().describe('此选项的显示文本'),
    description: z
      .string()
      .optional()
      .describe('显示在标签下方的可选描述'),
  }),
)

export const PromptRequestSchema = lazySchema(() =>
  z.object({
    prompt: z
      .string()
      .describe(
        '请求 ID。此键的存在表示该行是一个提示请求。',
      ),
    message: z.string().describe('要显示给用户的提示消息'),
    options: z
      .array(PromptRequestOptionSchema())
      .describe('用户可以选择的可用选项'),
  }),
)

export const PromptResponseSchema = lazySchema(() =>
  z.object({
    prompt_response: z
      .string()
      .describe('来自对应提示请求的请求 ID'),
    selected: z.string().describe('所选选项的键'),
  }),
)

// ============================================================================
// 技能/命令类型
// ============================================================================

export const SlashCommandSchema = lazySchema(() =>
  z
    .object({
      name: z.string().describe('技能名称（不含开头的斜杠）'),
      description: z.string().describe('技能功能的描述'),
      argumentHint: z
        .string()
        .describe('技能参数的提示（例如 "<file>"）'),
    })
    .describe(
      '关于可用技能的信息（通过 /command 语法调用）。',
    ),
)

export const AgentInfoSchema = lazySchema(() =>
  z
    .object({
      name: z.string().describe('代理类型标识符（例如 "Explore"）'),
      description: z.string().describe('何时使用此代理的描述'),
      model: z
        .string()
        .optional()
        .describe(
          '此代理使用的模型别名。如果省略，则继承父级的模型',
        ),
    })
    .describe(
      '关于可通过 Task 工具调用的可用子代理的信息。',
    ),
)

export const ModelInfoSchema = lazySchema(() =>
  z
    .object({
      value: z.string().describe('API 调用中使用的模型标识符'),
      displayName: z.string().describe('人类可读的显示名称'),
      description: z
        .string()
        .describe('模型能力的描述'),
      supportsEffort: z
        .boolean()
        .optional()
        .describe('此模型是否支持 effort 等级'),
      supportedEffortLevels: z
        .array(z.enum(['low', 'medium', 'high', 'max']))
        .optional()
        .describe('此模型可用的 effort 等级'),
      supportsAdaptiveThinking: z
        .boolean()
        .optional()
        .describe(
          '此模型是否支持自适应思考（由 Limkenion 决定是否思考以及思考深度）',
        ),
      supportsFastMode: z
        .boolean()
        .optional()
        .describe('此模型是否支持快速模式'),
      supportsAutoMode: z
        .boolean()
        .optional()
        .describe('此模型是否支持自动模式'),
    })
    .describe('关于可用模型的信息。'),
)

export const AccountInfoSchema = lazySchema(() =>
  z
    .object({
      email: z.string().optional(),
      organization: z.string().optional(),
      subscriptionType: z.string().optional(),
      tokenSource: z.string().optional(),
      apiKeySource: z.string().optional(),
      apiProvider: z
        .enum(['firstParty', 'bedrock', 'vertex', 'foundry'])
        .optional()
        .describe(
          '活动的 API 后端。Limkenion OAuth 登录仅适用于 "firstParty"；对于第三方提供方，其他字段不存在，认证为外部方式（AWS 凭据、gcloud ADC 等）。',
        ),
    })
    .describe('关于已登录用户账户的信息。'),
)

// ============================================================================
// 代理定义类型
// ============================================================================

export const AgentMcpServerSpecSchema = lazySchema(() =>
  z.union([
    z.string(),
    z.record(z.string(), McpServerConfigForProcessTransportSchema()),
  ]),
)

export const AgentDefinitionSchema = lazySchema(() =>
  z
    .object({
      description: z
        .string()
        .describe('何时使用此代理的自然语言描述'),
      tools: z
        .array(z.string())
        .optional()
        .describe(
          '允许的工具名称数组。如果省略，则继承父级的所有工具',
        ),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe('要对此代理显式禁用的工具名称数组'),
      prompt: z.string().describe('此代理的系统提示'),
      model: z
        .string()
        .optional()
        .describe(
          "模型名（例如 'deepseek-flash' 或 'deepseek-v4-pro'）。如果省略或为 'inherit'，则使用主模型",
        ),
      mcpServers: z.array(AgentMcpServerSpecSchema()).optional(),
      criticalSystemReminder_EXPERIMENTAL: z
        .string()
        .optional()
        .describe('实验性：添加到系统提示中的关键提醒'),
      skills: z
        .array(z.string())
        .optional()
        .describe('要预加载到代理上下文中的技能名称数组'),
      initialPrompt: z
        .string()
        .optional()
        .describe(
          '当此代理作为主线程代理时，会自动作为首个用户回合提交。会处理斜杠命令。会前置到用户提供的任何提示之前。',
        ),
      maxTurns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          '停止前最大的代理回合数（API 往返）',
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          '调用时将此代理作为后台任务运行（非阻塞、即发即忘）',
        ),
      memory: z
        .enum(['user', 'project', 'local'])
        .optional()
        .describe(
          "自动加载代理记忆文件的作用域。'user' - ~/.limkenion/agent-memory/<agentType>/，'project' - .limkenion/agent-memory/<agentType>/，'local' - .limkenion/agent-memory-local/<agentType>/",
        ),
      effort: z
        .union([z.enum(['low', 'medium', 'high', 'max']), z.number().int()])
        .optional()
        .describe(
          '此代理的推理 effort 等级。可以是命名的等级或整数',
        ),
      permissionMode: PermissionModeSchema()
        .optional()
        .describe(
          '控制如何处理工具执行的权限模式',
        ),
    })
    .describe(
      '可通过 Agent 工具调用的自定义子代理的定义。',
    ),
)

// ============================================================================
// 设置类型
// ============================================================================

export const SettingSourceSchema = lazySchema(() =>
  z
    .enum(['user', 'project', 'local'])
    .describe(
      '加载基于文件系统的设置的数据来源。' +
        "从 'user' 加载全局用户设置（~/.limkenion/settings.json）。 " +
        "从 'project' 加载项目设置（.limkenion/settings.json）。 " +
        "从 'local' 加载本地设置（.limkenion/settings.local.json）。",
    ),
)

export const SdkPluginConfigSchema = lazySchema(() =>
  z
    .object({
      type: z
        .literal('local')
        .describe("插件类型。目前仅支持 'local'"),
      path: z
        .string()
        .describe('插件目录的绝对或相对路径'),
    })
    .describe('用于加载插件的配置。'),
)

// ============================================================================
// 回退类型
// ============================================================================

export const RewindFilesResultSchema = lazySchema(() =>
  z
    .object({
      canRewind: z.boolean(),
      error: z.string().optional(),
      filesChanged: z.array(z.string()).optional(),
      insertions: z.number().optional(),
      deletions: z.number().optional(),
    })
    .describe('rewindFiles 操作的结果。'),
)

// ============================================================================
// 外部类型占位符
// ============================================================================
//
// 这些架构使用 z.unknown() 作为外部类型的占位符。
// 生成脚本使用 TypeOverrideMap 输出正确的 TS 类型引用。
// 这使我们能够在 Zod 中定义 SDK 消息类型，同时保持正确的类型。

/** APIUserMessage（来自 @limkenion-ai/sdk）的占位符 */
export const APIUserMessagePlaceholder = lazySchema(() => z.unknown())

/** APIAssistantMessage（来自 @limkenion-ai/sdk）的占位符 */
export const APIAssistantMessagePlaceholder = lazySchema(() => z.unknown())

/** RawMessageStreamEvent（来自 @limkenion-ai/sdk）的占位符 */
export const RawMessageStreamEventPlaceholder = lazySchema(() => z.unknown())

/** UUID（来自 crypto）的占位符 */
export const UUIDPlaceholder = lazySchema(() => z.string())

/** NonNullableUsage（对 Usage 的映射类型）的占位符 */
export const NonNullableUsagePlaceholder = lazySchema(() => z.unknown())

// ============================================================================
// SDK 消息类型
// ============================================================================

export const SDKAssistantMessageErrorSchema = lazySchema(() =>
  z.enum([
    'authentication_failed',
    'billing_error',
    'rate_limit',
    'invalid_request',
    'server_error',
    'unknown',
    'max_output_tokens',
  ]),
)

export const SDKStatusSchema = lazySchema(() =>
  z.union([z.literal('compacting'), z.null()]),
)

// 不含 uuid/session_id 的 SDKUserMessage 内容
const SDKUserMessageContentSchema = lazySchema(() =>
  z.object({
    type: z.literal('user'),
    message: APIUserMessagePlaceholder(),
    parent_tool_use_id: z.string().nullable(),
    isSynthetic: z.boolean().optional(),
    tool_use_result: z.unknown().optional(),
    priority: z.enum(['now', 'next', 'later']).optional(),
    timestamp: z
      .string()
      .optional()
      .describe(
        '消息在发起进程上创建时的 ISO 时间戳。较旧的发射器可能省略它；消费方应回退到接收时间。',
      ),
  }),
)

export const SDKUserMessageSchema = lazySchema(() =>
  SDKUserMessageContentSchema().extend({
    uuid: UUIDPlaceholder().optional(),
    session_id: z.string().optional(),
  }),
)

export const SDKUserMessageReplaySchema = lazySchema(() =>
  SDKUserMessageContentSchema().extend({
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
    isReplay: z.literal(true),
  }),
)

export const SDKRateLimitInfoSchema = lazySchema(() =>
  z
    .object({
      status: z.enum(['allowed', 'allowed_warning', 'rejected']),
      resetsAt: z.number().optional(),
      rateLimitType: z
        .enum([
          'five_hour',
          'seven_day',
          'overage',
        ])
        .optional(),
      utilization: z.number().optional(),
      overageStatus: z
        .enum(['allowed', 'allowed_warning', 'rejected'])
        .optional(),
      overageResetsAt: z.number().optional(),
      overageDisabledReason: z
        .enum([
          'overage_not_provisioned',
          'org_level_disabled',
          'org_level_disabled_until',
          'out_of_credits',
          'seat_tier_level_disabled',
          'member_level_disabled',
          'seat_tier_zero_credit_limit',
          'group_zero_credit_limit',
          'member_zero_credit_limit',
          'org_service_level_disabled',
          'org_service_zero_credit_limit',
          'no_limits_configured',
          'unknown',
        ])
        .optional(),
      isUsingOverage: z.boolean().optional(),
      surpassedThreshold: z.number().optional(),
    })
    .describe('订阅用户的速率限制信息。'),
)

export const SDKAssistantMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('assistant'),
    message: APIAssistantMessagePlaceholder(),
    parent_tool_use_id: z.string().nullable(),
    error: SDKAssistantMessageErrorSchema().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKRateLimitEventSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('rate_limit_event'),
      rate_limit_info: SDKRateLimitInfoSchema(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    })
    .describe('速率限制信息变化时发出的速率限制事件。'),
)

export const SDKStreamlinedTextMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('streamlined_text'),
      text: z
        .string()
        .describe('从助手消息中保留的文本内容'),
      session_id: z.string(),
      uuid: UUIDPlaceholder(),
    })
    .describe(
      '@internal 精简文本消息——在精简输出中替代 SDKAssistantMessage。保留文本内容，移除思考块和 tool_use 块。',
    ),
)

export const SDKStreamlinedToolUseSummaryMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('streamlined_tool_use_summary'),
      tool_summary: z
        .string()
        .describe('工具调用摘要（例如 "读取 2 个文件，写入 1 个文件"）'),
      session_id: z.string(),
      uuid: UUIDPlaceholder(),
    })
    .describe(
      '@internal 精简后的工具使用摘要——在精简输出中用累计摘要字符串替代 tool_use 块。',
    ),
)

export const SDKPermissionDenialSchema = lazySchema(() =>
  z.object({
    tool_name: z.string(),
    tool_use_id: z.string(),
    tool_input: z.record(z.string(), z.unknown()),
  }),
)

export const SDKResultSuccessSchema = lazySchema(() =>
  z.object({
    type: z.literal('result'),
    subtype: z.literal('success'),
    duration_ms: z.number(),
    duration_api_ms: z.number(),
    is_error: z.boolean(),
    num_turns: z.number(),
    result: z.string(),
    stop_reason: z.string().nullable(),
    total_cost_usd: z.number(),
    usage: NonNullableUsagePlaceholder(),
    modelUsage: z.record(z.string(), ModelUsageSchema()),
    permission_denials: z.array(SDKPermissionDenialSchema()),
    structured_output: z.unknown().optional(),
    fast_mode_state: FastModeStateSchema().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKResultErrorSchema = lazySchema(() =>
  z.object({
    type: z.literal('result'),
    subtype: z.enum([
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]),
    duration_ms: z.number(),
    duration_api_ms: z.number(),
    is_error: z.boolean(),
    num_turns: z.number(),
    stop_reason: z.string().nullable(),
    total_cost_usd: z.number(),
    usage: NonNullableUsagePlaceholder(),
    modelUsage: z.record(z.string(), ModelUsageSchema()),
    permission_denials: z.array(SDKPermissionDenialSchema()),
    errors: z.array(z.string()),
    fast_mode_state: FastModeStateSchema().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKResultMessageSchema = lazySchema(() =>
  z.union([SDKResultSuccessSchema(), SDKResultErrorSchema()]),
)

export const SDKSystemMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    agents: z.array(z.string()).optional(),
    apiKeySource: ApiKeySourceSchema(),
    betas: z.array(z.string()).optional(),
    limkenion_version: z.string(),
    cwd: z.string(),
    tools: z.array(z.string()),
    mcp_servers: z.array(
      z.object({
        name: z.string(),
        status: z.string(),
      }),
    ),
    model: z.string(),
    permissionMode: PermissionModeSchema(),
    slash_commands: z.array(z.string()),
    output_style: z.string(),
    skills: z.array(z.string()),
    plugins: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        source: z
          .string()
          .optional()
          .describe(
            '@internal 采用 "name\\@marketplace" 格式的插件来源标识符。哨兵值："name\\@inline" 表示 --plugin-dir，"name\\@builtin" 表示内置插件。',
          ),
      }),
    ),
    fast_mode_state: FastModeStateSchema().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKPartialAssistantMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('stream_event'),
    event: RawMessageStreamEventPlaceholder(),
    parent_tool_use_id: z.string().nullable(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKCompactBoundaryMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('compact_boundary'),
    compact_metadata: z.object({
      trigger: z.enum(['manual', 'auto']),
      pre_tokens: z.number(),
      preserved_segment: z
        .object({
          head_uuid: UUIDPlaceholder(),
          anchor_uuid: UUIDPlaceholder(),
          tail_uuid: UUIDPlaceholder(),
        })
        .optional()
        .describe(
          'messagesToKeep 的重新关联信息。加载器会在 anchor_uuid 处拼接保留的' +
            '片段（后缀保留时为 summary，前缀保留的部分压缩时为 boundary），' +
            '使得恢复时包含保留的内容。当压缩对一切进行摘要（无 messagesToKeep）时未设置。',
        ),
    }),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKStatusMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('status'),
    status: SDKStatusSchema(),
    permissionMode: PermissionModeSchema().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKPostTurnSummaryMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('system'),
      subtype: z.literal('post_turn_summary'),
      summarizes_uuid: z.string(),
      status_category: z.enum([
        'blocked',
        'waiting',
        'completed',
        'review_ready',
        'failed',
      ]),
      status_detail: z.string(),
      is_noteworthy: z.boolean(),
      title: z.string(),
      description: z.string(),
      recent_action: z.string(),
      needs_action: z.string(),
      artifact_urls: z.array(z.string()),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    })
    .describe(
      '@internal 在每个助手回合后发出的后台回合后摘要。summarizes_uuid 指向此摘要所概括的助手消息。',
    ),
)

export const SDKAPIRetryMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('system'),
      subtype: z.literal('api_retry'),
      attempt: z.number(),
      max_retries: z.number(),
      retry_delay_ms: z.number(),
      error_status: z.number().nullable(),
      error: SDKAssistantMessageErrorSchema(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    })
    .describe(
      '当 API 请求因可重试的错误而失败并将在延迟后重试时发出。对于没有 HTTP 响应的连接错误（如超时），error_status 为 null。',
    ),
)

export const SDKLocalCommandOutputMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('system'),
      subtype: z.literal('local_command_output'),
      content: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    })
    .describe(
      '来自本地斜杠命令（例如 /voice、/cost）的输出。在转录中以助手样式文本显示。',
    ),
)

export const SDKHookStartedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('hook_started'),
    hook_id: z.string(),
    hook_name: z.string(),
    hook_event: z.string(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKHookProgressMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('hook_progress'),
    hook_id: z.string(),
    hook_name: z.string(),
    hook_event: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    output: z.string(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKHookResponseMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('hook_response'),
    hook_id: z.string(),
    hook_name: z.string(),
    hook_event: z.string(),
    output: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number().optional(),
    outcome: z.enum(['success', 'error', 'cancelled']),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKToolProgressMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('tool_progress'),
    tool_use_id: z.string(),
    tool_name: z.string(),
    parent_tool_use_id: z.string().nullable(),
    elapsed_time_seconds: z.number(),
    task_id: z.string().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKAuthStatusMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('auth_status'),
    isAuthenticating: z.boolean(),
    output: z.array(z.string()),
    error: z.string().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKFilesPersistedEventSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('files_persisted'),
    files: z.array(
      z.object({
        filename: z.string(),
        file_id: z.string(),
      }),
    ),
    failed: z.array(
      z.object({
        filename: z.string(),
        error: z.string(),
      }),
    ),
    processed_at: z.string(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKTaskNotificationMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('task_notification'),
    task_id: z.string(),
    tool_use_id: z.string().optional(),
    status: z.enum(['completed', 'failed', 'stopped']),
    output_file: z.string(),
    summary: z.string(),
    usage: z
      .object({
        total_tokens: z.number(),
        tool_uses: z.number(),
        duration_ms: z.number(),
      })
      .optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKTaskStartedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('task_started'),
    task_id: z.string(),
    tool_use_id: z.string().optional(),
    description: z.string(),
    task_type: z.string().optional(),
    workflow_name: z
      .string()
      .optional()
      .describe(
        "来自工作流脚本的 meta.name（例如 'spec'）。仅当 task_type 为 'local_workflow' 时设置。",
      ),
    prompt: z.string().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKSessionStateChangedMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('system'),
      subtype: z.literal('session_state_changed'),
      state: z.enum(['idle', 'running', 'requires_action']),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    })
    .describe(
      '镜像 notifySessionStateChanged。在 heldBackResult 刷新且后台代理的 do-while 退出后触发 "idle"——权威的回合交接信号。',
    ),
)


export const SDKTaskProgressMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('task_progress'),
    task_id: z.string(),
    tool_use_id: z.string().optional(),
    description: z.string(),
    usage: z.object({
      total_tokens: z.number(),
      tool_uses: z.number(),
      duration_ms: z.number(),
    }),
    last_tool_name: z.string().optional(),
    summary: z.string().optional(),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKToolUseSummaryMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('tool_use_summary'),
    summary: z.string(),
    preceding_tool_use_ids: z.array(z.string()),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
)

export const SDKElicitationCompleteMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('system'),
      subtype: z.literal('elicitation_complete'),
      mcp_server_name: z.string(),
      elicitation_id: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    })
    .describe(
      '当 MCP 服务器确认 URL 模式的询问完成时发出。',
    ),
)

/** @internal */
export const SDKPromptSuggestionMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('prompt_suggestion'),
      suggestion: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    })
    .describe(
      '预测的下一个用户提示，在启用 promptSuggestions 时于每个回合后发出。',
    ),
)

// ============================================================================
// 会话列表类型
// ============================================================================

export const SDKSessionInfoSchema = lazySchema(() =>
  z
    .object({
      sessionId: z.string().describe('唯一会话标识符（UUID）。'),
      summary: z
        .string()
        .describe(
          '会话的显示标题：自定义标题、自动生成的摘要或首个提示。',
        ),
      lastModified: z
        .number()
        .describe('自纪元以来的最后修改时间（毫秒）。'),
      fileSize: z
        .number()
        .optional()
        .describe(
          '文件大小（字节）。仅本地 JSONL 存储时填充。',
        ),
      customTitle: z
        .string()
        .optional()
        .describe('通过 /rename 设置的会话标题。'),
      firstPrompt: z
        .string()
        .optional()
        .describe('会话中首个有意义的用户提示。'),
      gitBranch: z
        .string()
        .optional()
        .describe('会话结束时的 Git 分支。'),
      cwd: z.string().optional().describe('会话的工作目录。'),
      tag: z.string().optional().describe('用户设置的会话标签。'),
      createdAt: z
        .number()
        .optional()
        .describe(
          '自纪元以来的创建时间（毫秒），取自第一条记录的时间戳。',
        ),
    })
    .describe('由 listSessions 和 getSessionInfo 返回的会话元数据。'),
)

export const SDKMessageSchema = lazySchema(() =>
  z.union([
    SDKAssistantMessageSchema(),
    SDKUserMessageSchema(),
    SDKUserMessageReplaySchema(),
    SDKResultMessageSchema(),
    SDKSystemMessageSchema(),
    SDKPartialAssistantMessageSchema(),
    SDKCompactBoundaryMessageSchema(),
    SDKStatusMessageSchema(),
    SDKAPIRetryMessageSchema(),
    SDKLocalCommandOutputMessageSchema(),
    SDKHookStartedMessageSchema(),
    SDKHookProgressMessageSchema(),
    SDKHookResponseMessageSchema(),
    SDKToolProgressMessageSchema(),
    SDKAuthStatusMessageSchema(),
    SDKTaskNotificationMessageSchema(),
    SDKTaskStartedMessageSchema(),
    SDKTaskProgressMessageSchema(),
    SDKSessionStateChangedMessageSchema(),
    SDKFilesPersistedEventSchema(),
    SDKToolUseSummaryMessageSchema(),
    SDKRateLimitEventSchema(),
    SDKElicitationCompleteMessageSchema(),
    SDKPromptSuggestionMessageSchema(),
  ]),
)

export const FastModeStateSchema = lazySchema(() =>
  z
    .enum(['off', 'cooldown', 'on'])
    .describe(
      '快速模式状态：关闭、速率限制后冷却中，或已启用。',
    ),
)
