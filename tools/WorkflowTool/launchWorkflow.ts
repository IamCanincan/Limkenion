import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type vm from 'vm'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
} from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { SetAppState } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  completeWorkflowTask,
  enqueueWorkflowNotification,
  failWorkflowTask,
  registerWorkflowTask,
  updateWorkflowProgressBatch,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { logForDebugging } from '../../utils/debug.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { emitTaskProgress } from '../../utils/task/sdkProgress.js'
import {
  WORKFLOW_PANEL_EMIT_INTERVAL_MS,
  WORKFLOW_PROGRESS_BATCH_MS,
} from '../../utils/workflows/constants.js'
import { createWorkflowSharedCounters } from '../../utils/workflows/harness.js'
import { createRunJournal } from '../../utils/workflows/journal.js'
import {
  getWorkflowTranscriptDir,
  getWorkflowScriptPath,
} from '../../utils/workflows/paths.js'
import { executeWorkflowScript } from '../../utils/workflows/runtime.js'
import { createNestedWorkflowRunner } from './runNestedWorkflow.js'
import {
  isDurableWorkflowEvent,
  type WorkflowMeta,
  type WorkflowProgressEvent,
} from '../../utils/workflows/types.js'

export type LaunchWorkflowParams = {
  taskId: string
  workflowRunId: string
  script: string
  scriptPath?: string
  args?: unknown
  meta: WorkflowMeta
  vmScript: vm.Script
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  toolUseId?: string
  isResume: boolean
  runNestedWorkflow?: (nameOrRef: unknown, args: unknown) => Promise<unknown>
}

export type LaunchedWorkflow = {
  task: LocalWorkflowTaskState
  transcriptDir: string
  scriptPath: string
}

/**
 * 为一次运行注册后台任务，并开始执行它的脚本。
 *
 * 只要任务存在就立即返回，这样工具调用可以马上把 run id 交给模型；
 * 之后的一切都发生在下面的游离 promise 上。
 */
export function launchWorkflow(params: LaunchWorkflowParams): LaunchedWorkflow {
  const {
    taskId,
    workflowRunId,
    script,
    args,
    meta,
    vmScript,
    toolUseContext,
    canUseTool,
    toolUseId,
    isResume,
  } = params

  const setAppState: SetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const transcriptDir = getWorkflowTranscriptDir(workflowRunId)
  // 调用方提供的路径是只读的：它是用户的文件，而恢复运行应当
  // 接续用户的编辑，而不是覆盖它们。
  const callerSuppliedPath = params.scriptPath !== undefined
  const scriptPath =
    params.scriptPath ?? getWorkflowScriptPath(workflowRunId, meta.name)

  // 恢复的运行会替换同一 run id 上已结算的任务，这样
  // 进度视图只显示一个条目，而不是一摞已死掉的条目。
  if (isResume) {
    const tasks = toolUseContext.getAppState().tasks
    for (const [id, task] of Object.entries(tasks)) {
      if (
        task.type === 'local_workflow' &&
        task.workflowRunId === workflowRunId &&
        task.status !== 'running'
      ) {
        setAppState(prev => {
          const { [id]: _removed, ...rest } = prev.tasks
          return { ...prev, tasks: rest }
        })
      }
    }
  }

  const task = registerWorkflowTask({
    taskId,
    script,
    scriptPath,
    args,
    summary: meta.description,
    workflowName: meta.name,
    title: meta.title,
    phases: meta.phases,
    defaultModel: toolUseContext.options.mainLoopModel,
    workflowRunId,
    ownerAgentId: toolUseContext.agentId,
    toolUseId,
  })
  registerTask(task, setAppState)

  if (!callerSuppliedPath) void persistScript(scriptPath, script)

  const budgetTotal = getCurrentTurnTokenBudget()
  const spentBeforeRun = getTurnOutputTokens()
  const tokenBudget = {
    total: budgetTotal,
    getTurnSpent: () => getTurnOutputTokens() - spentBeforeRun,
  }

  const batcher = createProgressBatcher({
    taskId,
    toolUseId,
    setAppState,
    getTask: () =>
      toolUseContext.getAppState().tasks[taskId] as
        | LocalWorkflowTaskState
        | undefined,
    fallbackDescription: task.description,
    startTime: task.startTime,
    summary: meta.description,
  })

  void (async () => {
    const journal = createRunJournal(workflowRunId)
    const journalSnapshot = isResume ? await journal.load() : undefined
    const shared = createWorkflowSharedCounters()
    const nestedContext = {
      ...toolUseContext,
      abortController: task.abortController ?? toolUseContext.abortController,
    }
    const onAgentController = (
      agentKey: string,
      controller: AbortController | undefined,
    ) => {
      updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, current => {
        if (!current.agentControllers) return current
        if (controller) current.agentControllers.set(agentKey, controller)
        else current.agentControllers.delete(agentKey)
        return current
      })
    }

    const outcome = await executeWorkflowScript({
      vmScript,
      toolUseContext: nestedContext,
      canUseTool,
      runId: workflowRunId,
      workflowName: meta.name,
      args,
      seedPhaseTitles: meta.phases?.map(phase => phase.title),
      tokenBudget,
      journal,
      journalSnapshot,
      shared,
      onProgress: event => batcher.push(event),
      onAgentController,
      runNestedWorkflow:
        params.runNestedWorkflow ??
        createNestedWorkflowRunner({
          toolUseContext: nestedContext,
          canUseTool,
          runId: workflowRunId,
          tokenBudget,
          journal,
          shared,
          onProgress: event => batcher.push(event),
          onAgentController,
        }),
    })

    batcher.flush()

    const settled = toolUseContext.getAppState().tasks[taskId] as
      | LocalWorkflowTaskState
      | undefined
    // 用户停止的运行已处于终态；不要覆盖它。
    if (settled && settled.status !== 'running') return

    const totalTokens = settled?.totalTokens ?? 0
    const totalToolCalls = settled?.totalToolCalls ?? 0
    const status = outcome.error ? 'failed' : 'completed'

    if (outcome.error) {
      await failWorkflowTask(
        taskId,
        outcome.error,
        outcome.agentCount,
        outcome.logs,
        setAppState,
      )
    } else {
      await completeWorkflowTask(
        taskId,
        outcome.result,
        outcome.agentCount,
        outcome.logs,
        setAppState,
      )
    }

    enqueueWorkflowNotification({
      taskId,
      summary: meta.description,
      status,
      result: outcome.error ? undefined : outcome.result,
      error: outcome.error,
      failures: outcome.failures,
      agentCount: outcome.agentCount,
      totalTokens,
      totalToolCalls,
      durationMs: outcome.durationMs,
      toolUseId,
      transcriptDir,
      scriptPath,
      workflowRunId,
      args,
      setAppState,
    })
  })().catch(async error => {
    batcher.cancel()
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`Workflow ${workflowRunId} crashed: ${message}`)
    await failWorkflowTask(taskId, message, 0, [], setAppState)
    enqueueWorkflowNotification({
      taskId,
      summary: meta.description,
      status: 'failed',
      error: message,
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      durationMs: Date.now() - task.startTime,
      toolUseId,
      transcriptDir,
      scriptPath,
      workflowRunId,
      args,
      setAppState,
    })
  })

  return { task, transcriptDir, scriptPath }
}

/**
 * 在进度事件触及 AppState 之前先把它们合并起来。
 *
 * 一次 40 个 agent 的运行会发出成千上万次 token 计数更新；逐个应用
 * 会让每个事件都重新渲染整个任务列表。用短定时器做批处理
 * 可以让视图保持实时，又不会让 UI 成为瓶颈。
 */
function createProgressBatcher(params: {
  taskId: string
  toolUseId?: string
  setAppState: SetAppState
  getTask: () => LocalWorkflowTaskState | undefined
  fallbackDescription: string
  startTime: number
  summary?: string
}) {
  let pending: WorkflowProgressEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPanelEmit = 0

  const drain = (): void => {
    timer = undefined
    if (pending.length === 0) return
    const batch = pending
    pending = []
    updateWorkflowProgressBatch(params.taskId, batch, params.setAppState)
    emitPanelProgress(batch)
  }

  const emitPanelProgress = (batch: WorkflowProgressEvent[]): void => {
    const durable = batch.filter(isDurableWorkflowEvent)
    if (durable.length === 0) return
    const task = params.getTask()
    if (task?.type !== 'local_workflow' || task.status !== 'running') return

    const lastAgent = [...durable]
      .reverse()
      .find(event => event.type === 'workflow_agent')
    // token 计数的频繁变动被节流；其他任何事件（agent 完成、进入新
    // 阶段）都立即发出，这样面板永远不会肉眼可见地滞后。
    const onlyTokenChurn = durable.every(
      event => event.type === 'workflow_agent' && event.state === 'progress',
    )
    const now = Date.now()
    if (onlyTokenChurn && now - lastPanelEmit < WORKFLOW_PANEL_EMIT_INTERVAL_MS) {
      return
    }
    lastPanelEmit = now

    emitTaskProgress({
      taskId: params.taskId,
      toolUseId: params.toolUseId,
      description:
        lastAgent?.type === 'workflow_agent'
          ? lastAgent.phaseTitle
            ? `${lastAgent.phaseTitle}: ${lastAgent.label}`
            : lastAgent.label
          : params.fallbackDescription,
      startTime: params.startTime,
      totalTokens: task.totalTokens,
      toolUses: task.totalToolCalls,
      lastToolName:
        lastAgent?.type === 'workflow_agent' ? lastAgent.label : undefined,
      summary: params.summary,
      workflowRunId: task.workflowRunId,
      workflowProgress: task.workflowProgress.filter(isDurableWorkflowEvent),
      ownerAgentId: task.ownerAgentId,
    })
  }

  return {
    push(event: WorkflowProgressEvent): void {
      pending.push(event)
      if (!timer) {
        timer = setTimeout(drain, WORKFLOW_PROGRESS_BATCH_MS)
        timer.unref?.()
      }
    },
    flush(): void {
      if (timer) clearTimeout(timer)
      drain()
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = []
    },
  }
}

async function persistScript(path: string, script: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, script, 'utf8')
  } catch (error) {
    logForDebugging(
      `Failed to persist workflow script to ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
