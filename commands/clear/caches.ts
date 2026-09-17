/**
 * 会话缓存清理工具。
 * 该模块在启动时由 main.tsx 导入，因此请保持 import 尽量精简。
 */
import { feature } from 'bun:bundle'
import {
  clearInvokedSkills,
  setLastEmittedDate,
} from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import { getSessionStartDate } from '../../constants/common.js'
import {
  getGitStatus,
  getSystemContext,
  getUserContext,
  setSystemPromptInjection,
} from '../../context.js'
import { clearFileSuggestionCaches } from '../../hooks/fileSuggestions.js'
import { clearAllPendingCallbacks } from '../../hooks/useSwarmPermissionPoller.js'
import { clearAllDumpState } from '../../services/api/dumpPrompts.js'
import { resetPromptCacheBreakDetection } from '../../services/api/promptCacheBreakDetection.js'
import { clearAllSessions } from '../../services/api/sessionIngress.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { resetAllLSPDiagnosticState } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { clearTrackedMagicDocs } from '../../services/MagicDocs/magicDocs.js'
import { clearDynamicSkills } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import { clearCommandPrefixCaches } from '../../utils/bash/commands.js'
import { resetGetMemoryFilesCache } from '../../utils/limkenionmd.js'
import { clearRepositoryCaches } from '../../utils/detectRepository.js'
import { clearResolveGitDirCache } from '../../utils/git/gitFilesystem.js'
import { clearStoredImagePaths } from '../../utils/imageStore.js'
import { clearSessionEnvVars } from '../../utils/sessionEnvVars.js'

/**
 * 清理所有与会话相关的缓存。
 * 在恢复会话时调用本函数，以确保文件/技能发现为最新状态。
 * 这是 clearConversation 所做工作的一个子集——它只清理缓存，
 * 不影响消息、会话 ID，也不会触发 hooks。
 *
 * @param preservedAgentIds - 在清理后需要存活下来的、按 Agent ID 区分的状态
 *   （例如 /clear 时保留下来的后台任务）。当非空时，按 agentId 为键的状态
 *   （调用过的技能）会被选择性清理，而按 requestId 为键的状态
 *   （待处理的权限回调、dump 状态、cache-break 追踪）会被保留，
 *   因为它们无法被安全地限定在主会话范围内。
 */
export function clearSessionCaches(
  preservedAgentIds: ReadonlySet<string> = new Set(),
): void {
  const hasPreserved = preservedAgentIds.size > 0
  // 清理上下文缓存
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  getGitStatus.cache.clear?.()
  getSessionStartDate.cache.clear?.()
  // 清理文件建议缓存（用于 @ 提及）
  clearFileSuggestionCaches()

  // 清理命令/技能缓存
  clearCommandsCache()

  // 清理 prompt 缓存中断检测状态
  if (!hasPreserved) resetPromptCacheBreakDetection()

  // 清理 system prompt 注入（cache breaker）
  setSystemPromptInjection(null)

  // 清理上次发出的日期，下一轮将重新检测
  setLastEmittedDate(null)

  // 运行压缩后清理（清理 system prompt 分段、microcompact 追踪、
  // 分类器审批、推测性检查，以及主线程压缩时 load_reason 为 'compact' 的
  // 内存文件缓存）。
  runPostCompactCleanup()
  // 重置已发送技能名列表，以便在 /clear 之后重新发送技能清单。
  // runPostCompactCleanup 有意不重置它（压缩后重新注入会消耗约 4K token），
  // 但 /clear 会完全清空消息，因此模型需要再次获得完整清单。
  resetSentSkillNames()
  // 用 'session_start' 覆盖内存缓存重置：clearSessionCaches 从 /clear 和
  // --resume/--continue 调用，它们并不是压缩事件。若无此行，下次调用
  // getMemoryFiles() 时 InstructionsLoaded hook 就会以 load_reason 'compact'
  // 而非 'session_start' 触发。
  resetGetMemoryFilesCache('session_start')

  // 清理存储的图片路径缓存
  clearStoredImagePaths()

  // 清理所有会话入口缓存（lastUuidMap、sequentialAppendBySession）
  clearAllSessions()
  // 清理 swarm 权限待处理的回调
  if (!hasPreserved) clearAllPendingCallbacks()

  // 清理 tungsten 会话用量追踪
  
  // 清理归因缓存（文件内容缓存、待处理 bash 状态）
  // 使用动态 import 保留 COMMIT_ATTRIBUTION feature flag 下的死代码消除
  if (feature('COMMIT_ATTRIBUTION')) {
    void import('../../utils/attributionHooks.js').then(
      ({ clearAttributionCaches }) => clearAttributionCaches(),
    )
  }
  // 清理仓库检测缓存
  clearRepositoryCaches()
  // 清理 bash 命令前缀缓存（Haiku 提取的前缀）
  clearCommandPrefixCaches()
  // 清理 dump prompts 状态
  if (!hasPreserved) clearAllDumpState()
  // 清理已调用技能缓存（每一项都包含完整的技能文件内容）
  clearInvokedSkills(preservedAgentIds)
  // 清理 git 目录解析缓存
  clearResolveGitDirCache()
  // 清理动态技能（从技能目录加载）
  clearDynamicSkills()
  // 清理 LSP 诊断追踪状态
  resetAllLSPDiagnosticState()
  // 清理被追踪的 magic docs
  clearTrackedMagicDocs()
  // 清理会话环境变量
  clearSessionEnvVars()
  // 清理 WebFetch URL 缓存（最多 50MB 的缓存页面内容）
  void import('../../tools/WebFetchTool/utils.js').then(
    ({ clearWebFetchCache }) => clearWebFetchCache(),
  )
  // 清理 ToolSearch 描述缓存（完整工具 prompt，约 50 个 MCP 工具 ~500KB）
  void import('../../tools/ToolSearchTool/ToolSearchTool.js').then(
    ({ clearToolSearchDescriptionCache }) => clearToolSearchDescriptionCache(),
  )
  // 清理 agent 定义缓存（会经 EnterWorktreeTool 按 cwd 累积）
  void import('../../tools/AgentTool/loadAgentsDir.js').then(
    ({ clearAgentDefinitionsCache }) => clearAgentDefinitionsCache(),
  )
  // 清理 SkillTool prompt 缓存（按项目根目录累积）
  void import('../../tools/SkillTool/prompt.js').then(({ clearPromptCache }) =>
    clearPromptCache(),
  )
}
