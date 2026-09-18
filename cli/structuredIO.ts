import { feature } from 'bun:bundle'
import type {
  ElicitResult,
  JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import type { AssistantMessage } from 'src//types/message.js'
import type {
  HookInput,
  HookJSONOutput,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import { SDKControlElicitationResponseSchema } from 'src/entrypoints/sdk/controlSchemas.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
  StdinMessage,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { type HookCallback, hookJSONOutputSchema } from 'src/types/hooks.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { AbortError } from 'src/utils/errors.js'
import {
  type Output as PermissionToolOutput,
  permissionPromptToolResultToPermissionDecision,
  outputSchema as permissionToolOutputSchema,
} from 'src/utils/permissions/PermissionPromptToolResultSchema.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from 'src/utils/permissions/PermissionResult.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { writeToStdout } from 'src/utils/process.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { z } from 'zod/v4'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { executePermissionRequestHooks } from '../utils/hooks.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../utils/permissions/PermissionUpdate.js'
import {
  notifySessionStateChanged,
  type RequiresActionDetails,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import { jsonParse } from '../utils/slowOperations.js'
import { Stream } from '../utils/stream.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'

/**
 * 通过 stdio 以结构化方式读写 SDK 消息时的合成工具名，用于转发
 * 沙箱网络权限请求（经由 can_use_tool 控制请求协议）。SDK 宿主会把它
 * 当作一个普通的工具权限提示来对待。
 */
export const SANDBOX_NETWORK_ACCESS_TOOL_NAME = 'SandboxNetworkAccess'

function serializeDecisionReason(
  reason: PermissionDecisionReason | undefined,
): string | undefined {
  if (!reason) {
    return undefined
  }

  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    reason.type === 'classifier'
  ) {
    return reason.reason
  }
  switch (reason.type) {
    case 'rule':
    case 'mode':
    case 'subcommandResults':
    case 'permissionPromptTool':
      return undefined
    case 'hook':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return reason.reason
  }
}

function buildRequiresActionDetails(
  tool: Tool,
  input: Record<string, unknown>,
  toolUseID: string,
  requestId: string,
): RequiresActionDetails {
  // 逐工具的摘要方法可能因格式错误的输入而抛异常；权限处理
  // 不能因为一条糟糕的描述就中断。
  let description: string
  try {
    description =
      tool.getActivityDescription?.(input) ??
      tool.getToolUseSummary?.(input) ??
      tool.userFacingName(input)
  } catch {
    description = tool.name
  }
  return {
    tool_name: tool.name,
    action_description: description,
    tool_use_id: toolUseID,
    request_id: requestId,
    input,
  }
}

type PendingRequest<T> = {
  resolve: (result: T) => void
  reject: (error: unknown) => void
  schema?: z.Schema
  request: SDKControlRequest
}

/**
 * 提供一种从 stdio 结构化读写 SDK 消息、对接 SDK 协议的方式。
 */
// 要追踪的已解析 tool_use ID 数量上限，超过后淘汰最旧的条目。这在极长会话中
// 约束内存占用，同时保留足够历史以捕获重复的 control_response 投递。
const MAX_RESOLVED_TOOL_USE_IDS = 1000

export class StructuredIO {
  readonly structuredInput: AsyncGenerator<StdinMessage | SDKMessage>
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>()

  // worker 启动时读回的 CCR external_metadata；传输未恢复时为 null。
  // 由 RemoteIO 赋值。
  restoredWorkerState: Promise<SessionExternalMetadata | null> =
    Promise.resolve(null)

  private inputClosed = false
  private unexpectedResponseCallback?: (
    response: SDKControlResponse,
  ) => Promise<void>

  // 追踪已通过正常权限流程（或被钩子中止）解析完成的 tool_use ID。
  // 当原始请求已被处理后，又到达一条重复的 control_response 时，该 Set 能
  // 阻止孤立处理器再次处理它——否则会把重复的 assistant 消息推入
  // mutableMessages，造成 API 返回 400 "tool_use ids must be unique" 错误。
  private readonly resolvedToolUseIds = new Set<string>()
  private prependedLines: string[] = []
  private onControlRequestSent?: (request: SDKControlRequest) => void
  private onControlRequestResolved?: (requestId: string) => void

  // sendRequest() 与 print.ts 都入队到这里；排空循环是唯一的写入者。
  // 防止 control_request 越过排队中的 stream_events。
  readonly outbound = new Stream<StdoutMessage>()

  constructor(
    private readonly input: AsyncIterable<string>,
    private readonly replayUserMessages?: boolean,
  ) {
    this.input = input
    this.structuredInput = this.read()
  }

  /**
   * 将某个 tool_use ID 记录为已解析，以便针对同一工具的迟到/重复
   * control_response 消息被孤立处理器忽略。
   */
  private trackResolvedToolUseId(request: SDKControlRequest): void {
    if (request.request.subtype === 'can_use_tool') {
      this.resolvedToolUseIds.add(request.request.tool_use_id)
      if (this.resolvedToolUseIds.size > MAX_RESOLVED_TOOL_USE_IDS) {
        // 淘汰最旧的条目（Set 按插入顺序迭代）
        const first = this.resolvedToolUseIds.values().next().value
        if (first !== undefined) {
          this.resolvedToolUseIds.delete(first)
        }
      }
    }
  }

  /** 冲刷待处理的内部事件。非远端子进程为空操作，由 RemoteIO 覆写。 */
  flushInternalEvents(): Promise<void> {
    return Promise.resolve()
  }

  /** 内部事件队列深度。由 RemoteIO 覆写；其余情况为零。 */
  get internalEventsPending(): number {
    return 0
  }

  /**
   * 在 this.input 的下一条消息之前，把一个用户回合入队。
   * 在迭代开始前和流式进行中均可用——read() 会在每两条产出的消息之间
   * 重新检查 prependedLines。
   */
  prependUserMessage(content: string): void {
    this.prependedLines.push(
      jsonStringify({
        type: 'user',
        session_id: '',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      } satisfies SDKUserMessage) + '\n',
    )
  }

  private async *read() {
    let content = ''

    // 在 for-await 之前先调用一次（否则空的 this.input 会完全跳过
    // 循环体），此后每个数据块再调用一次。prependedLines 的复查放在
    // while 内部，因此同一数据块的两条消息之间插入的 prepend 仍会先落盘。
    const splitAndProcess = async function* (this: StructuredIO) {
      for (;;) {
        if (this.prependedLines.length > 0) {
          content = this.prependedLines.join('') + content
          this.prependedLines = []
        }
        const newline = content.indexOf('\n')
        if (newline === -1) break
        const line = content.slice(0, newline)
        content = content.slice(newline + 1)
        const message = await this.processLine(line)
        if (message) {
          logForDiagnosticsNoPII('info', 'cli_stdin_message_parsed', {
            type: message.type,
          })
          yield message
        }
      }
    }.bind(this)

    yield* splitAndProcess()

    for await (const block of this.input) {
      content += block
      yield* splitAndProcess()
    }
    if (content) {
      const message = await this.processLine(content)
      if (message) {
        yield message
      }
    }
    this.inputClosed = true
    for (const request of this.pendingRequests.values()) {
      // 把输入流关闭前所有挂起的请求都拒绝掉
      request.reject(
        new Error('工具权限流在收到响应前已关闭'),
      )
    }
  }

  getPendingPermissionRequests() {
    return Array.from(this.pendingRequests.values())
      .map(entry => entry.request)
      .filter(pr => pr.request.subtype === 'can_use_tool')
  }

  setUnexpectedResponseCallback(
    callback: (response: SDKControlResponse) => Promise<void>,
  ): void {
    this.unexpectedResponseCallback = callback
  }

  /**
   * 注入一条 control_response 消息以解析某个挂起的权限请求。
   * 由网桥用来把来自 远端服务 的权限响应喂入 SDK 权限流程。
   *
   * 同时向 SDK 消费方发送一条 control_cancel_request，以便其 canUseTool
   * 回调通过信号被中止——否则该回调会一直挂起。
   */
  injectControlResponse(response: SDKControlResponse): void {
    const requestId = response.response?.request_id
    if (!requestId) return
    const request = this.pendingRequests.get(requestId)
    if (!request) return
    this.trackResolvedToolUseId(request.request)
    this.pendingRequests.delete(requestId)
    // Cancel the SDK consumer's canUseTool callback — the bridge won.
    void this.write({
      type: 'control_cancel_request',
      request_id: requestId,
    })
    if (response.response.subtype === 'error') {
      request.reject(new Error(response.response.error))
    } else {
      const result = response.response.response
      if (request.schema) {
        try {
          request.resolve(request.schema.parse(result))
        } catch (error) {
          request.reject(error)
        }
      } else {
        request.resolve({})
      }
    }
  }

  /**
   * 注册一个在 can_use_tool 控制请求被写入 stdout 时触发的回调。
   * 网桥用它把权限请求转发到 远端服务。
   */
  setOnControlRequestSent(
    callback: ((request: SDKControlRequest) => void) | undefined,
  ): void {
    this.onControlRequestSent = callback
  }

  /**
   * 注册一个在 SDK 消费方（经 stdin）返回 can_use_tool 的 control_response
   * 时触发的回调。网桥用它来在 SDK 消费方赢得竞速时取消 远端服务 上
   * 已过期的权限提示。
   */
  setOnControlRequestResolved(
    callback: ((requestId: string) => void) | undefined,
  ): void {
    this.onControlRequestResolved = callback
  }

  private async processLine(
    line: string,
  ): Promise<StdinMessage | SDKMessage | undefined> {
    // 跳过空行（例如来自管道 stdin 的连续双换行）
    if (!line) {
      return undefined
    }
    try {
      const message = normalizeControlMessageKeys(jsonParse(line)) as
        | StdinMessage
        | SDKMessage
      if (message.type === 'keep_alive') {
        // 静默忽略心跳消息
        return undefined
      }
      if (message.type === 'update_environment_variables') {
        // 直接把环境变量更新应用到 process.env。
        // 由网桥会话运行器用于刷新认证 token
        // （LIMKENION_SESSION_ACCESS_TOKEN），它必须对 REPL 进程本身
        // 可读，而不只是对子 Bash 命令可读。
        const keys = Object.keys(message.variables)
        for (const [key, value] of Object.entries(message.variables)) {
          process.env[key] = value
        }
        logForDebugging(
          `[structuredIO] 已应用 update_environment_variables: ${keys.join(', ')}`,
        )
        return undefined
      }
      if (message.type === 'control_response') {
        // 为每条 control_response——包括重复项和孤立项——关闭生命周期；
        // 孤立项不会交给 print.ts 的主循环，所以这是唯一能看到它们的路径。
        // uuid 由服务端注入到载荷中。
        const uuid =
          'uuid' in message && typeof message.uuid === 'string'
            ? message.uuid
            : undefined
        if (uuid) {
          notifyCommandLifecycle(uuid, 'completed')
        }
        const request = this.pendingRequests.get(message.response.request_id)
        if (!request) {
          // 检查这个 tool_use 是否已通过正常权限流程解析完成。重复的
          // control_response 投递（例如来自 WebSocket 重连）会在原始请求
          // 被处理后到达，重新处理会把重复的 assistant 消息推入对话，
          // 造成 API 400 错误。
          const responsePayload =
            message.response.subtype === 'success'
              ? message.response.response
              : undefined
          const toolUseID = responsePayload?.toolUseID
          if (
            typeof toolUseID === 'string' &&
            this.resolvedToolUseIds.has(toolUseID)
          ) {
            logForDebugging(
              `忽略针对已解析 toolUseID=${toolUseID} 的重复 control_response，request_id=${message.response.request_id}`,
            )
            return undefined
          }
          if (this.unexpectedResponseCallback) {
            await this.unexpectedResponseCallback(message)
          }
          return undefined // 忽略我们不认识的请求对应的响应
        }
        this.trackResolvedToolUseId(request.request)
        this.pendingRequests.delete(message.response.request_id)
        // 在 SDK 消费方解析 can_use_tool 请求时通知网桥，以便它取消
        // 远端服务 上已过期的权限提示。
        if (
          request.request.request.subtype === 'can_use_tool' &&
          this.onControlRequestResolved
        ) {
          this.onControlRequestResolved(message.response.request_id)
        }

        if (message.response.subtype === 'error') {
          request.reject(new Error(message.response.error))
          return undefined
        }
        const result = message.response.response
        if (request.schema) {
          try {
            request.resolve(request.schema.parse(result))
          } catch (error) {
            request.reject(error)
          }
        } else {
          request.resolve({})
        }
        // 启用重放时，把控制响应向上传播
        if (this.replayUserMessages) {
          return message
        }
        return undefined
      }
      if (
        message.type !== 'user' &&
        message.type !== 'control_request' &&
        message.type !== 'assistant' &&
        message.type !== 'system'
      ) {
        logForDebugging(`忽略未知消息类型：${message.type}`, {
          level: 'warn',
        })
        return undefined
      }
      if (message.type === 'control_request') {
        if (!message.request) {
          exitWithMessage(`错误：control_request 缺少 request 字段`)
        }
        return message
      }
      if (message.type === 'assistant' || message.type === 'system') {
        return message
      }
      if (message.message.role !== 'user') {
        exitWithMessage(
          `错误：期望消息角色为 'user'，实际为 '${message.message.role}'`,
        )
      }
      return message
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`解析流式输入行时出错：${line}：${error}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  async write(message: StdoutMessage): Promise<void> {
    writeToStdout(ndjsonSafeStringify(message) + '\n')
  }

  private async sendRequest<Response>(
    request: SDKControlRequest['request'],
    schema: z.Schema,
    signal?: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<Response> {
    const message: SDKControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request,
    }
    if (this.inputClosed) {
      throw new Error('流已关闭')
    }
    if (signal?.aborted) {
      throw new Error('请求已中止')
    }
    this.outbound.enqueue(message)
    if (request.subtype === 'can_use_tool' && this.onControlRequestSent) {
      this.onControlRequestSent(message)
    }
    const aborted = () => {
      this.outbound.enqueue({
        type: 'control_cancel_request',
        request_id: requestId,
      })
      // 立即拒绝挂起的 Promise，无需等待宿主确认取消。
      const request = this.pendingRequests.get(requestId)
      if (request) {
        // 在拒绝之前把该 tool_use ID 标记为已解析，这样宿主的迟到响应
        // 就会被孤立处理器忽略。
        this.trackResolvedToolUseId(request.request)
        request.reject(new AbortError())
      }
    }
    if (signal) {
      signal.addEventListener('abort', aborted, {
        once: true,
      })
    }
    try {
      return await new Promise<Response>((resolve, reject) => {
        this.pendingRequests.set(requestId, {
          request: {
            type: 'control_request',
            request_id: requestId,
            request,
          },
          resolve: result => {
            resolve(result as Response)
          },
          reject,
          schema,
        })
      })
    } finally {
      if (signal) {
        signal.removeEventListener('abort', aborted)
      }
      this.pendingRequests.delete(requestId)
    }
  }

  createCanUseTool(
    onPermissionPrompt?: (details: RequiresActionDetails) => void,
  ): CanUseToolFn {
    return async (
      tool: Tool,
      input: { [key: string]: unknown },
      toolUseContext: ToolUseContext,
      assistantMessage: AssistantMessage,
      toolUseID: string,
      forceDecision?: PermissionDecision,
    ): Promise<PermissionDecision> => {
      const mainPermissionResult =
        forceDecision ??
        (await hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
        ))
      // 如果工具被允许或拒绝，直接返回结果
      if (
        mainPermissionResult.behavior === 'allow' ||
        mainPermissionResult.behavior === 'deny'
      ) {
        return mainPermissionResult
      }

      // 把 PermissionRequest 钩子的执行与 SDK 权限提示并行进行。
      // 在终端 CLI 中，钩子与交互提示竞速，因此例如带 --delay 20 的钩子
      // 不会卡住 UI。这里需要同样的行为：SDK 宿主（VS Code 等）立即显示
      // 其权限对话框，钩子在后台运行。谁先解析成功谁获胜；输家被取消/忽略。

      // 用于在钩子先做决定时取消 SDK 请求的 AbortController
      const hookAbortController = new AbortController()
      const parentSignal = toolUseContext.abortController.signal
      // 把父级中止转发给本地控制器
      const onParentAbort = () => hookAbortController.abort()
      parentSignal.addEventListener('abort', onParentAbort, { once: true })

      try {
        // 开始执行钩子（在后台运行）
        const hookPromise = executePermissionRequestHooksForSDK(
          tool.name,
          toolUseID,
          input,
          toolUseContext,
          mainPermissionResult.suggestions,
        ).then(decision => ({ source: 'hook' as const, decision }))

        // 立即开始 SDK 权限提示（不要等待钩子）
        const requestId = randomUUID()
        onPermissionPrompt?.(
          buildRequiresActionDetails(tool, input, toolUseID, requestId),
        )
        const sdkPromise = this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: tool.name,
            input,
            permission_suggestions: mainPermissionResult.suggestions,
            blocked_path: mainPermissionResult.blockedPath,
            decision_reason: serializeDecisionReason(
              mainPermissionResult.decisionReason,
            ),
            tool_use_id: toolUseID,
            agent_id: toolUseContext.agentId,
          },
          permissionToolOutputSchema(),
          hookAbortController.signal,
          requestId,
        ).then(result => ({ source: 'sdk' as const, result }))

        // 竞速：钩子完成 vs SDK 提示响应。
        // 钩子 Promise 总是会解析（从不拒绝），若没有钩子做出决定则返回 undefined。
        const winner = await Promise.race([hookPromise, sdkPromise])

        if (winner.source === 'hook') {
          if (winner.decision) {
            // 钩子已做决定——中止挂起的 SDK 请求。
            // 抑制 sdkPromise 被期望的 AbortError 拒绝。
            sdkPromise.catch(() => {})
            hookAbortController.abort()
            return winner.decision
          }
          // 钩子未做决定（放行）——等待 SDK 提示
          const sdkResult = await sdkPromise
          return permissionPromptToolResultToPermissionDecision(
            sdkResult.result,
            tool,
            input,
            toolUseContext,
          )
        }

        // SDK 提示先返回——使用其结果（钩子仍在后台运行，但其结果会被忽略）
        return permissionPromptToolResultToPermissionDecision(
          winner.result,
          tool,
          input,
          toolUseContext,
        )
      } catch (error) {
        return permissionPromptToolResultToPermissionDecision(
          {
            behavior: 'deny',
            message: `工具权限请求失败：${error}`,
            toolUseID,
          },
          tool,
          input,
          toolUseContext,
        )
      } finally {
        // 只有不再有其它权限提示挂起时（并发工具执行可能有多个进行中），
        // 才转回 'running' 状态。
        if (this.getPendingPermissionRequests().length === 0) {
          notifySessionStateChanged('running')
        }
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  createHookCallback(callbackId: string, timeout?: number): HookCallback {
    return {
      type: 'callback',
      timeout,
      callback: async (
        input: HookInput,
        toolUseID: string | null,
        abort: AbortSignal | undefined,
      ): Promise<HookJSONOutput> => {
        try {
          const result = await this.sendRequest<HookJSONOutput>(
            {
              subtype: 'hook_callback',
              callback_id: callbackId,
              input,
              tool_use_id: toolUseID || undefined,
            },
            hookJSONOutputSchema(),
            abort,
          )
          return result
        } catch (error) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.error(`钩子回调 ${callbackId} 出错：`, error)
          return {}
        }
      },
    }
  }

  /**
   * 向 SDK 消费方发送一条 elicitation 请求并返回其响应。
   */
  async handleElicitation(
    serverName: string,
    message: string,
    requestedSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    mode?: 'form' | 'url',
    url?: string,
    elicitationId?: string,
  ): Promise<ElicitResult> {
    try {
      const result = await this.sendRequest<ElicitResult>(
        {
          subtype: 'elicitation',
          mcp_server_name: serverName,
          message,
          mode,
          url,
          elicitation_id: elicitationId,
          requested_schema: requestedSchema,
        },
        SDKControlElicitationResponseSchema(),
        signal,
      )
      return result
    } catch {
      return { action: 'cancel' as const }
    }
  }

  /**
   * 创建一个把沙箱网络权限请求作为 can_use_tool 控制请求转发给 SDK 宿主
   * 的 SandboxAskCallback。
   *
   * 它借用现有的 can_use_tool 协议并传入一个合成工具名，这样 SDK 宿主
   * （VS Code、CCR 等）无需新的协议子类型即可向用户询问网络访问权限。
   */
  createSandboxAskCallback(): (hostPattern: {
    host: string
    port?: number
  }) => Promise<boolean> {
    return async (hostPattern): Promise<boolean> => {
      try {
        const result = await this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: SANDBOX_NETWORK_ACCESS_TOOL_NAME,
            input: { host: hostPattern.host },
            tool_use_id: randomUUID(),
            description: `允许连接到 ${hostPattern.host} 的网络吗？`,
          },
          permissionToolOutputSchema(),
        )
        return result.behavior === 'allow'
      } catch {
        // 若请求失败（流关闭、中止等），则拒绝该连接
        return false
      }
    }
  }

  /**
   * 向 SDK 服务端发送一条 MCP 消息并等待其响应
   */
  async sendMcpMessage(
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage> {
    const response = await this.sendRequest<{ mcp_response: JSONRPCMessage }>(
      {
        subtype: 'mcp_message',
        server_name: serverName,
        message,
      },
      z.object({
        mcp_response: z.any() as z.Schema<JSONRPCMessage>,
      }),
    )
    return response.mcp_response
  }
}

function exitWithMessage(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

/**
 * 执行 PermissionRequest 钩子，若某个钩子做出决定则返回该决定。
 * 若没有钩子做出决定，返回 undefined。
 */
async function executePermissionRequestHooksForSDK(
  toolName: string,
  toolUseID: string,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | undefined> {
  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode

  // 直接遍历生成器而不是使用 `all`
  const hookGenerator = executePermissionRequestHooks(
    toolName,
    toolUseID,
    input,
    toolUseContext,
    permissionMode,
    suggestions,
    toolUseContext.abortController.signal,
  )

  for await (const hookResult of hookGenerator) {
    if (
      hookResult.permissionRequestResult &&
      (hookResult.permissionRequestResult.behavior === 'allow' ||
        hookResult.permissionRequestResult.behavior === 'deny')
    ) {
      const decision = hookResult.permissionRequestResult
      if (decision.behavior === 'allow') {
        const finalInput = decision.updatedInput || input

        // 钩子提供权限更新时应用它们（“总是允许”）
        const permissionUpdates = decision.updatedPermissions ?? []
        if (permissionUpdates.length > 0) {
          persistPermissionUpdates(permissionUpdates)
          const currentAppState = toolUseContext.getAppState()
          const updatedContext = applyPermissionUpdates(
            currentAppState.toolPermissionContext,
            permissionUpdates,
          )
          // 通过 setAppState 更新权限上下文
          toolUseContext.setAppState(prev => {
            if (prev.toolPermissionContext === updatedContext) return prev
            return { ...prev, toolPermissionContext: updatedContext }
          })
        }

        return {
          behavior: 'allow',
          updatedInput: finalInput,
          userModified: false,
          decisionReason: {
            type: 'hook',
            hookName: 'permission-request',
          },
        }
      } else {
        // 钩子拒绝了该权限
        return {
          behavior: 'deny',
          message:
            decision.message || 'permission-request 钩子拒绝了此操作权限',
          decisionReason: {
            type: 'hook',
            hookName: 'permission-request',
          },
        }
      }
    }
  }

  return undefined
}
