import { z } from 'zod/v4'
import type { TaskStateBase } from '../../Task.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { stopTask } from '../../tasks/stopTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DESCRIPTION, TASK_STOP_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z
      .string()
      .optional()
      .describe('要停止的后台任务的 ID'),
    // 为兼容已弃用的 KillShell 工具而保留 shell_id
    shell_id: z.string().optional().describe('已弃用：请改用 task_id'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('该操作的状态消息'),
    task_id: z.string().describe('被停止的任务的 ID'),
    task_type: z.string().describe('被停止的任务的类型'),
    // 说明：工具输出会持久化到记录中，并在 --resume 时重新播放而不重新验证，
    // 因此在此字段加入之前的会话缺少该字段。
    command: z
      .string()
      .optional()
      .describe('被停止任务的命令或描述'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  searchHint: 'kill a running background task',
  // KillShell 是已弃用的名称 - 作为别名保留，以向后兼容
  // 现有 transcript 和 SDK 用户
  aliases: ['KillShell'],
  maxResultSizeChars: 100_000,
  userFacingName: () => ('Stop Task'),
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.task_id ?? input.shell_id ?? ''
  },
  async validateInput({ task_id, shell_id }, { getAppState }) {
    // 同时支持 task_id 和 shell_id（兼容已弃用的 KillShell）
    const id = task_id ?? shell_id
    if (!id) {
      return {
        result: false,
        message: 'Missing required parameter: task_id',
        errorCode: 1,
      }
    }

    const appState = getAppState()
    const task = appState.tasks?.[id] as TaskStateBase | undefined

    if (!task) {
      return {
        result: false,
        message: `No task found with ID: ${id}`,
        errorCode: 1,
      }
    }

    if (task.status !== 'running') {
      return {
        result: false,
        message: `Task ${id} is not running (status: ${task.status})`,
        errorCode: 3,
      }
    }

    return { result: true }
  },
  async description() {
    return `Stop a running background task by ID`
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(
    { task_id, shell_id },
    { getAppState, setAppState, abortController },
  ) {
    // 同时支持 task_id 和 shell_id（兼容已弃用的 KillShell）
    const id = task_id ?? shell_id
    if (!id) {
      throw new Error('Missing required parameter: task_id')
    }

    const result = await stopTask(id, {
      getAppState,
      setAppState,
    })

    return {
      data: {
        message: `Successfully stopped task: ${result.taskId} (${result.command})`,
        task_id: result.taskId,
        task_type: result.taskType,
        command: result.command,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
