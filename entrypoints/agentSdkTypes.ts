/**
 * Limkenion Agent SDK 类型的主入口。
 *
 * 本文件从以下位置重新导出公共 SDK API：
 * - sdk/coreTypes.ts —— 通用可序列化类型（消息、配置）
 * - sdk/runtimeTypes.ts —— 非可序列化类型（回调、接口）
 *
 * 需要控制协议类型的 SDK 构建者应直接从
 * sdk/controlTypes.ts 导入。
 */

import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'

// 供 SDK 构建者使用的控制协议类型（bridge 子路径消费方）
/** @alpha */
export type {
  SDKControlRequest,
  SDKControlResponse,
} from './sdk/controlTypes.js'
// 重新导出核心类型（通用可序列化类型）
export * from './sdk/coreTypes.js'
// 重新导出运行时类型（回调、含方法的接口）
export * from './sdk/runtimeTypes.js'

// 重新导出设置类型（由设置 JSON schema 生成）
export type { Settings } from './sdk/settingsTypes.generated.js'
// 重新导出工具类型（在 SDK API 稳定前全部标记为 @internal）
export * from './sdk/toolTypes.js'

// ============================================================================
// Functions
// ============================================================================

import type {
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from './sdk/coreTypes.js'
// 函数签名所需的类型
import type {
  AnyZodRawShape,
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  InferShape,
  InternalOptions,
  InternalQuery,
  ListSessionsOptions,
  McpSdkServerConfigWithInstance,
  Options,
  Query,
  SDKSession,
  SDKSessionOptions,
  SdkMcpToolDefinition,
  SessionMessage,
  SessionMutationOptions,
} from './sdk/runtimeTypes.js'

export type {
  ListSessionsOptions,
  GetSessionInfoOptions,
  SessionMutationOptions,
  ForkSessionOptions,
  ForkSessionResult,
  SDKSessionInfo,
}

export function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (
    args: InferShape<Schema>,
    extra: unknown,
  ) => Promise<CallToolResult>,
  _extras?: {
    annotations?: ToolAnnotations
    searchHint?: string
    alwaysLoad?: boolean
  },
): SdkMcpToolDefinition<Schema> {
  throw new Error('未实现')
}

type CreateSdkMcpServerOptions = {
  name: string
  version?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Array<SdkMcpToolDefinition<any>>
}

/**
 * 创建可配合 SDK 传输使用的 MCP 服务器实例。
 * 这允许 SDK 用户定义在同一进程中运行的自定义工具。
 *
 * 如果你的 SDK MCP 调用运行时间会超过 60 秒，请覆盖 LIMKENION_STREAM_CLOSE_TIMEOUT
 */
export function createSdkMcpServer(
  _options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance {
  throw new Error('未实现')
}

export class AbortError extends Error {}

/** @internal */
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
}): InternalQuery
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
export function query(): Query {
  throw new Error('SDK 中尚未实现 query')
}

/**
 * V2 API —— 不稳定
 * 为多轮对话创建持久会话。
 * @alpha
 */
export function unstable_v2_createSession(
  _options: SDKSessionOptions,
): SDKSession {
  throw new Error('SDK 中尚未实现 unstable_v2_createSession')
}

/**
 * V2 API —— 不稳定
 * 按 ID 恢复已有会话。
 * @alpha
 */
export function unstable_v2_resumeSession(
  _sessionId: string,
  _options: SDKSessionOptions,
): SDKSession {
  throw new Error('SDK 中尚未实现 unstable_v2_resumeSession')
}

// @[MODEL LAUNCH]: 更新此文档字符串中的示例模型 ID。
/**
 * V2 API —— 不稳定
 * 用于单次提示的一次性便捷函数。
 * @alpha
 *
 * @example
 * ```typescript
 * const result = await unstable_v2_prompt("What files are here?", {
 *   model: 'limkenion-deepseek-flash-4-6'
 * })
 * ```
 */
export async function unstable_v2_prompt(
  _message: string,
  _options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  throw new Error('SDK 中尚未实现 unstable_v2_prompt')
}

/**
 * 从会话的 JSONL 转录文件中读取其对话消息。
 *
 * 解析转录文件，通过 parentUuid 链接构建对话链，
 * 并按时间顺序返回用户/助手消息。在选项中设置
 * `includeSystemMessages: true` 可同时包含系统消息。
 *
 * @param sessionId - 要读取的会话的 UUID
 * @param options - 可选的 dir、limit、offset 与 includeSystemMessages
 * @returns 消息数组，若未找到会话则返回空数组
 */
export async function getSessionMessages(
  _sessionId: string,
  _options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  throw new Error('SDK 中尚未实现 getSessionMessages')
}

/**
 * 列出带元数据的会话。
 *
 * 提供了 `dir` 时，返回该项目目录及其 git worktrees 的会话。
 * 省略时，返回所有项目的会话。
 *
 * 使用 `limit` 与 `offset` 进行分页。
 *
 * @example
 * ```typescript
 * // 列出特定项目的会话
 * const sessions = await listSessions({ dir: '/path/to/project' })
 *
 * // 分页
 * const page1 = await listSessions({ limit: 50 })
 * const page2 = await listSessions({ limit: 50, offset: 50 })
 * ```
 */
export async function listSessions(
  _options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]> {
  throw new Error('SDK 中尚未实现 listSessions')
}

/**
 * 按 ID 读取单个会话的元数据。与 `listSessions` 不同，它只读取单个会话文件，
 * 而不是项目中的每个会话。
 * 若会话文件不存在、是侧链会话，或没有可提取的摘要，则返回 undefined。
 *
 * @param sessionId - 会话的 UUID
 * @param options - `{ dir?: string }` 项目路径；省略则搜索所有项目目录
 */
export async function getSessionInfo(
  _sessionId: string,
  _options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined> {
  throw new Error('SDK 中尚未实现 getSessionInfo')
}

/**
 * 重命名会话。会向会话的 JSONL 文件追加一条自定义标题记录。
 * @param sessionId - 会话的 UUID
 * @param title - 新标题
 * @param options - `{ dir?: string }` 项目路径；省略则搜索所有项目
 */
export async function renameSession(
  _sessionId: string,
  _title: string,
  _options?: SessionMutationOptions,
): Promise<void> {
  throw new Error('SDK 中尚未实现 renameSession')
}

/**
 * 为会话打标签。传入 null 以清除标签。
 * @param sessionId - 会话的 UUID
 * @param tag - 标签字符串，或传入 null 以清除
 * @param options - `{ dir?: string }` 项目路径；省略则搜索所有项目
 */
export async function tagSession(
  _sessionId: string,
  _tag: string | null,
  _options?: SessionMutationOptions,
): Promise<void> {
  throw new Error('SDK 中尚未实现 tagSession')
}

/**
 * 将会话分叉到带有全新 UUID 的新分支。
 *
 * 把源会话的转录消息复制到新会话文件中，
 * 重新映射每一条消息的 UUID 并保留 parentUuid 链。支持
 * `upToMessageId`，以便从对话中的某个特定点分叉。
 *
 * 分叉出的会话没有撤销历史（不复制文件历史快照）。
 *
 * @param sessionId - 源会话的 UUID
 * @param options - `{ dir?, upToMessageId?, title? }`
 * @returns `{ sessionId }` —— 新分叉会话的 UUID
 */
export async function forkSession(
  _sessionId: string,
  _options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  throw new Error('SDK 中尚未实现 forkSession')
}

// ============================================================================
// 助手守护进程原语（内部）
// ============================================================================

/**
 * 来自 `<dir>/.limkenion/scheduled_tasks.json` 的定时任务。
 * @internal
 */
export type CronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
}

/**
 * Cron 调度器调优旋钮（抖动 + 过期）。在 CLI 会话中运行时从
 * `limkenion_kairos_cron_config` GrowthBook 配置获取；daemon 宿主
 * 通过 `watchScheduledTasks({ getJitterConfig })` 传入以获得
 * 相同的调优参数。
 * @internal
 */
export type CronJitterConfig = {
  recurringFrac: number
  recurringCapMs: number
  oneShotMaxMs: number
  oneShotFloorMs: number
  oneShotMinuteMod: number
  recurringMaxAgeMs: number
}

/**
 * `watchScheduledTasks()` 产生的事件。
 * @internal
 */
export type ScheduledTaskEvent =
  | { type: 'fire'; task: CronTask }
  | { type: 'missed'; tasks: CronTask[] }

/**
 * `watchScheduledTasks()` 返回的句柄。
 * @internal
 */
export type ScheduledTasksHandle = {
  /** fire/missed 事件的异步流。使用 `for await` 消费。 */
  events(): AsyncGenerator<ScheduledTaskEvent>
  /**
   * 所有已加载任务中下一次计划触发的时间（毫秒时间戳），
   * 若没有任务被调度则为 null。用于决定是拆除空闲的 agent 子进程，
   * 还是让它保持热用以应对即将到来的触发。
   */
  getNextFireTime(): number | null
}

/**
 * 监听 `<dir>/.limkenion/scheduled_tasks.json`，在任务触发时产生事件。
 *
 * 获取按目录划分的调度器锁（基于 PID 的存活检测），因此同一目录下的
 * REPL 会话不会重复触发。在信号中止时释放锁并关闭文件监听器。
 *
 * - `fire` —— cron 计划满足的任务。在产生该事件时一次性任务已从文件中删除；
 *   循环任务会被重新调度（或在其老化后删除）。
 * - `missed` —— 在 daemon 停机期间窗口已过去的一次性任务。
 *   在初始加载时产生一次；随后一个后台删除会将其从文件中移除。
 *
 * 面向在外部拥有调度器并通过 `query()` 生成 agent 的 daemon 架构；
 * agent 子进程（`-p` 模式）不会运行自己的调度器。
 *
 * @internal
 */
export function watchScheduledTasks(_opts: {
  dir: string
  signal: AbortSignal
  getJitterConfig?: () => CronJitterConfig
}): ScheduledTasksHandle {
  throw new Error('未实现')
}

/**
 * 把错过的即时任务格式化为一个提示词，请求模型在执行前（通过 AskUserQuestion）
 * 与用户确认。
 * @internal
 */
export function buildMissedTaskNotification(_missed: CronTask[]): string {
  throw new Error('未实现')
}

/**
 * 用户在 远端服务 上键入的用户消息，从 bridge WS 提取。
 * @internal
 */
export type InboundPrompt = {
  content: string | unknown[]
  uuid?: string
}

/**
 * connectRemoteControl 的选项。
 * @internal
 */
export type ConnectRemoteControlOptions = {
  dir: string
  name?: string
  workerType?: string
  branch?: string
  gitRepoUrl?: string | null
  getAccessToken: () => string | undefined
  baseUrl: string
  orgUUID: string
  model: string
}

/**
 * connectRemoteControl 返回的句柄。把 query() 的产出写入其中，再从
 * 其中读取入站提示词。字段的完整文档见 src/assistant/daemonBridge.ts。
 * @internal
 */
export type RemoteControlHandle = {
  sessionUrl: string
  environmentId: string
  bridgeSessionId: string
  write(msg: SDKMessage): void
  sendResult(): void
  sendControlRequest(req: unknown): void
  sendControlResponse(res: unknown): void
  sendControlCancelRequest(requestId: string): void
  inboundPrompts(): AsyncGenerator<InboundPrompt>
  controlRequests(): AsyncGenerator<unknown>
  permissionResponses(): AsyncGenerator<unknown>
  onStateChange(
    cb: (
      state: 'ready' | 'connected' | 'reconnecting' | 'failed',
      detail?: string,
    ) => void,
  ): void
  teardown(): Promise<void>
}

/**
 * 从 daemon 进程持有一条 远端服务 远程控制桥接连接。
 *
 * daemon 在父进程中拥有 WebSocket —— 如果 agent 子进程（通过 `query()` 生成）
 * 崩溃，daemon 会重新生成它，而 远端服务 保持同一会话。与 `query.enableRemoteControl`
 * 相对，后者把 WebSocket 放在子进程中（会随 agent 一起销毁）。
 *
 * 通过 `write()` + `sendResult()` 接入 `query()` 的产出。把
 * `inboundPrompts()`（用户在 远端服务 上键入的内容）读入 `query()` 的输入流。
 * 在本地处理 `controlRequests()`（interrupt → 中止，set_model → 重新配置）。
 *
 * 跳过 `limkenion_ccr_bridge` 门控与策略限制检查 —— @internal
 * 调用方已被预先授权。仍需要 OAuth（环境变量或钥匙串）。
 *
 * 在无 OAuth 或注册失败时返回 null。
 *
 * @internal
 */
export async function connectRemoteControl(
  _opts: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle | null> {
  throw new Error('未实现')
}
