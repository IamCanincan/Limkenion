/**
 * 会话清理工具。
 * 本模块依赖较重，应尽可能懒加载。
 */
import { feature } from 'bun:bundle'
import { randomUUID, type UUID } from 'crypto'
import {
  getLastMainRequestId,
  getOriginalCwd,
  getSessionId,
  regenerateSessionId,
} from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createEmptyAttributionState } from '../../utils/commitAttribution.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import {
  executeSessionEndHooks,
  getSessionEndHookTimeoutMs,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { clearAllPlanSlugs } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  clearSessionMetadata,
  getAgentTranscriptPath,
  resetSessionFilePointer,
  saveWorktreeState,
} from '../../utils/sessionStorage.js'
import {
  evictTaskOutput,
  initTaskOutputAsSymlink,
} from '../../utils/task/diskOutput.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { clearSessionCaches } from './caches.js'

export async function clearConversation({
  setMessages,
  readFileState,
  discoveredSkillNames,
  loadedNestedMemoryPaths,
  getAppState,
  setAppState,
  setConversationId,
}: {
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  readFileState: FileStateCache
  discoveredSkillNames?: Set<string>
  loadedNestedMemoryPaths?: Set<string>
  getAppState?: () => AppState
  setAppState?: (f: (prev: AppState) => AppState) => void
  setConversationId?: (id: UUID) => void
}): Promise<void> {
  // 在清理之前执行 SessionEnd hooks（受
  // LIMKENION_SESSIONEND_HOOKS_TIMEOUT_MS 限制，默认 1.5s）
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()
  await executeSessionEndHooks('clear', {
    getAppState,
    setAppState,
    signal: AbortSignal.timeout(sessionEndTimeoutMs),
    timeoutMs: sessionEndTimeoutMs,
  })

  // 向推理侧发出的信号：本次对话的缓存可以被逐出。
  const lastRequestId = getLastMainRequestId()
  if (lastRequestId) {
    logEvent('limkenion_cache_eviction_hint', {
      scope:
        'conversation_clear' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 提前计算出需要保留的任务，使它们的按 agent 状态能在下方清理缓存时存活。
  // 除非某任务显式地具有 isBackgrounded === false，否则它会被保留。
  // 主会话任务（Ctrl+B）会被保留——它们写入隔离的按任务转录，并在 agent
  // 上下文下运行，因此在会话 ID 重新生成后也是安全的。参见
  // LocalMainSessionTask.ts 中的 startBackgroundSession。
  const preservedAgentIds = new Set<string>()
  const preservedLocalAgents: LocalAgentTaskState[] = []
  const shouldKillTask = (task: AppState['tasks'][string]): boolean =>
    'isBackgrounded' in task && task.isBackgrounded === false
  if (getAppState) {
    for (const task of Object.values(getAppState().tasks)) {
      if (shouldKillTask(task)) continue
      if (isLocalAgentTask(task)) {
        preservedAgentIds.add(task.agentId)
        preservedLocalAgents.push(task)
      } else if (isInProcessTeammateTask(task)) {
        preservedAgentIds.add(task.identity.agentId)
      }
    }
  }

  setMessages(() => [])

  // 清除上下文阻塞标记，使 proactive 在 /clear 后恢复运行
  if (feature('PROACTIVE') || feature('KAIROS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { setContextBlocked } = require('../../proactive/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    setContextBlocked(false)
  }

  // 通过更新 conversationId 强制重新渲染 logo
  if (setConversationId) {
    setConversationId(randomUUID())
  }

  // 清理所有会话相关缓存。被保留的后台任务（调用过的技能、待处理的权限
  // 回调、dump 状态、cache-break 追踪）的按 agent 状态会被保留，
  // 使这些 agent 能继续正常运行。
  clearSessionCaches(preservedAgentIds)

  setCwd(getOriginalCwd())
  readFileState.clear()
  discoveredSkillNames?.clear()
  loadedNestedMemoryPaths?.clear()

  // 从 App State 中清理必要项
  if (setAppState) {
    setAppState(prev => {
      // 使用上方计算的同一谓词对任务进行分区：
      // 杀掉并移除前台任务，保留其余所有任务。
      const nextTasks: AppState['tasks'] = {}
      for (const [taskId, task] of Object.entries(prev.tasks)) {
        if (!shouldKillTask(task)) {
          nextTasks[taskId] = task
          continue
        }
        // 前台任务：杀掉它并从状态中移除
        try {
          if (task.status === 'running') {
            if (isLocalShellTask(task)) {
              task.shellCommand?.kill()
              task.shellCommand?.cleanup()
              if (task.cleanupTimeoutId) {
                clearTimeout(task.cleanupTimeoutId)
              }
            }
            if ('abortController' in task) {
              task.abortController?.abort()
            }
            if ('unregisterCleanup' in task) {
              task.unregisterCleanup?.()
            }
          }
        } catch (error) {
          logError(error)
        }
        void evictTaskOutput(taskId)
      }

      return {
        ...prev,
        tasks: nextTasks,
        attribution: createEmptyAttributionState(),
        // 清除独立 agent 上下文（由 /rename、/color 设置的名称/颜色），
        // 使新会话不显示旧会话的身份徽标
        standaloneAgentContext: undefined,
        fileHistory: {
          snapshots: [],
          trackedFiles: new Set(),
          snapshotSequence: 0,
        },
        // 将 MCP 状态重置为默认值，以触发重新初始化。
        // 保留 pluginReconnectKey，使 /clear 不产生无效操作
        // （它只会被 /reload-plugins 更新）。
        mcp: {
          clients: [],
          tools: [],
          commands: [],
          resources: {},
          pluginReconnectKey: prev.mcp.pluginReconnectKey,
        },
      }
    })
  }

  // 清理 plan slug 缓存，以便在 /clear 后使用新的 plan 文件
  clearAllPlanSlugs()

  // 清缓存会话元数据（标题、标签、agent 名称/颜色）
  // 使新会话不继承上一会话的身份
  clearSessionMetadata()

  // 生成新的会话 ID 以提供全新状态
  // 将旧会话设为 parent，用于 analytics 谱系追踪
  regenerateSessionId({ setCurrentAsParent: true })
  // 更新环境变量，使子进程使用新的会话 ID
  
  await resetSessionFilePointer()

  // 已保留的 local_agent 任务的 TaskOutput symlink 在生成时是针对旧会话 ID
  // 设置的，但清理后的转录写入会落到新的会话目录下（appendEntry 会重新读取
  // getSessionId()）。重新指向这些 symlink，使 TaskOutput 读取实时文件而非
  // 一份冻结的清理前快照。只重新指向运行中的任务——已完成的任务不会再写入，
  // 重新指向只会把有效的 symlink 替换成悬空链接。
  // 主会话任务使用相同的按 agent 路径（它们经 recordSidechainTranscript 写入
  // getAgentTranscriptPath），因此无需特殊处理。
  for (const task of preservedLocalAgents) {
    if (task.status !== 'running') continue
    void initTaskOutputAsSymlink(
      task.id,
      getAgentTranscriptPath(asAgentId(task.agentId)),
    )
  }

  // 清理后重新持久化模式与 worktree 状态，使后续的 --resume 知道新的清理后
  // 会话处于什么状态。clearSessionMetadata 已把两者从缓存中清除，但进程仍处于
  // 相同的模式与（如适用）相同的 worktree 目录下。
  if (feature('COORDINATOR_MODE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { saveMode } = require('../../utils/sessionStorage.js')
    const {
      isCoordinatorMode,
    } = require('../../coordinator/coordinatorMode.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    saveMode(isCoordinatorMode() ? 'coordinator' : 'normal')
  }
  const worktreeSession = getCurrentWorktreeSession()
  if (worktreeSession) {
    saveWorktreeState(worktreeSession)
  }

  // 清理后执行 SessionStart hooks
  const hookMessages = await processSessionStartHooks('clear')

  // 用 hook 结果更新消息
  if (hookMessages.length > 0) {
    setMessages(() => hookMessages)
  }
}
