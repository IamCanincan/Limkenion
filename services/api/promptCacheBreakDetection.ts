import type { BetaToolUnion } from '../../types/llm-protocol.js'
import type { TextBlockParam } from '../../types/llm-protocol.js'
import { createPatch } from 'diff'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AgentId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import { djb2Hash } from 'src/utils/hash.js'
import { logError } from 'src/utils/log.js'
import { getLimkenionTempDir } from 'src/utils/permissions/filesystem.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { QuerySource } from '../../constants/querySource.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

function getCacheBreakDiffPath(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return join(getLimkenionTempDir(), `cache-break-${suffix}.diff`)
}

type PreviousState = {
  systemHash: number
  toolsHash: number
  /** 系统块的 hash，其中 cache_control 保持完好。用于捕获 stripCacheControl
   * 会从 systemHash 中擦除的 scope/TTL 翻转（global↔org、1h↔5m）。 */
  cacheControlHash: number
  toolNames: string[]
  /** 每个工具 schema 的 hash。当 toolSchemasChanged 但 added=removed=0 时
   * 通过 diff 来指出是哪个工具的描述变了（按 BQ 2026-03-22 数据，工具破坏中
   * 77% 属此类）。AgentTool/SkillTool 会内嵌动态的 agent/命令列表。 */
  perToolHashes: Record<string, number>
  systemCharCount: number
  model: string
  fastMode: boolean
  /** 'tool_based' | 'system_prompt' | 'none' —— 在 MCP 工具被
   * 发现/移除时会翻转。 */
  globalCacheStrategy: string
  /** 排序后的 beta 响应头列表。通过 diff 展示哪些响应头被添加/移除。 */
  betas: string[]
  /** AFK_MODE_BETA_HEADER 是否存在 —— 不应再破坏缓存
   *（在 limkenion.ts 中粘附锁定）。随后来验证修复。 */
  autoModeActive: boolean
  /** Overage 状态翻转 —— 不应再破坏缓存（资格在 should1hCacheTTL 中
   * 会话级粘附锁定）。随后来验证修复。 */
  isUsingOverage: boolean
  /** 缓存编辑 beta 响应头是否存在 —— 不应再破坏缓存
   *（在 limkenion.ts 中粘附锁定）。随后来验证修复。 */
  cachedMCEnabled: boolean
  /** 已解析的 effort（env → options → 模型默认）。会写入 output_config
   * 或 limkenion_internal.effort_override。 */
  effortValue: string
  /** getExtraBodyParams() 的 hash —— 捕获 LIMKENION_EXTRA_BODY 与
   * limkenion_internal 的改动。 */
  extraBodyHash: number
  callCount: number
  pendingChanges: PendingChanges | null
  prevCacheReadTokens: number | null
  /** 当缓存的微压缩发送 cache_edits 删除时设置。缓存读取量
   * 会合理地下降 —— 这是预期的，不是破坏。 */
  cacheDeletionsPending: boolean
  buildDiffableContent: () => string
}

type PendingChanges = {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMCChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  prevEffortValue: string
  newEffortValue: string
  buildPrevDiffableContent: () => string
}

const previousStateBySource = new Map<string, PreviousState>()

// 限制跟踪的源头数量，防止无界内存增长。
// 每条记录会存储约 300KB+ 的 diffableContent 字符串（序列化后的系统提示
// + 工具 schema）。若不设上限，大量生成子代理（每个都有唯一的
// agentId 键）会导致该 map 无限增长。
const MAX_TRACKED_SOURCES = 10

const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]

// 触发缓存破坏告警所需的最小绝对 token 下降量。
// 小幅下降（例如几千 token）可能源于正常波动，不值得告警。
const MIN_CACHE_MISS_TOKENS = 2_000

// Limkenion 服务端提示缓存 TTL 阈值，供测试对照。
// 超过这些时长后发生的缓存破坏，更可能是 TTL 过期导致，
// 而非客户端改动。
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000

// 需排除在缓存破坏检测之外的模型（例如 deepseek-flash 的缓存行为不同）
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}

/**
 * 返回某个 querySource 的跟踪键；若不跟踪则返回 null。
 * Compact 与 repl_main_thread 共用相同的服务端缓存
 * （相同的 cacheSafeParams），因此它们共享跟踪状态。
 *
 * 对于带被跟踪 querySource 的子代理，使用唯一的 agentId 来
 * 隔离跟踪状态，避免同一代理类型并发运行多个实例时
 * 产生误报的缓存破坏通知。
 *
 * 未被跟踪的源头（speculation、session_memory、prompt_suggestion 等）
 * 是短生命周期的 fork 代理，缓存破坏检测对它们没有价值——
 * 每次都以全新的 agentId 运行 1-3 轮，没有可比对象。
 * 其缓存指标仍通过 limkenion_api_success 记录以用于分析。
 */
function getTrackingKey(
  querySource: QuerySource,
  agentId?: AgentId,
): string | null {
  if (querySource === 'compact') return 'repl_main_thread'
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    if (querySource.startsWith(prefix)) return agentId || querySource
  }
  return null
}

function stripCacheControl(
  items: ReadonlyArray<Record<string, unknown>>,
): unknown[] {
  return items.map(item => {
    if (!('cache_control' in item)) return item
    const { cache_control: _, ...rest } = item
    return rest
  })
}

function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined') {
    const hash = Bun.hash(str)
    // Bun.hash 对较大输入可能返回 bigint；安全地转成 number
    return typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash
  }
  // 非 Bun 运行时的回退方案（例如通过 npm 全局安装的 Node.js）
  return djb2Hash(str)
}

/** MCP 工具名由用户控制（服务器配置），可能泄露文件路径。
 *  将其归并到 'mcp'；内置名称是固定词汇表。 */
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

function computePerToolHashes(
  strippedTools: ReadonlyArray<unknown>,
  names: string[],
): Record<string, number> {
  const hashes: Record<string, number> = {}
  for (let i = 0; i < strippedTools.length; i++) {
    hashes[names[i] ?? `__idx_${i}`] = computeHash(strippedTools[i])
  }
  return hashes
}

function getSystemCharCount(system: TextBlockParam[]): number {
  let total = 0
  for (const block of system) {
    total += block.text.length
  }
  return total
}

function buildDiffableContent(
  system: TextBlockParam[],
  tools: BetaToolUnion[],
  model: string,
): string {
  const systemText = system.map(b => b.text).join('\n\n')
  const toolDetails = tools
    .map(t => {
      if (!('name' in t)) return 'unknown'
      const desc = 'description' in t ? t.description : ''
      const schema = 'input_schema' in t ? jsonStringify(t.input_schema) : ''
      return `${t.name}\n  description: ${desc}\n  input_schema: ${schema}`
    })
    .sort()
    .join('\n\n')
  return `Model: ${model}\n\n=== System Prompt ===\n\n${systemText}\n\n=== Tools (${tools.length}) ===\n\n${toolDetails}\n`
}

/** 扩展跟踪快照——可观察到的、可能影响服务端缓存键的全部信息。
 *  所有字段均为可选，便于调用方按需逐步补充；未定义字段在比较时视为稳定。 */
export type PromptStateSnapshot = {
  system: TextBlockParam[]
  toolSchemas: BetaToolUnion[]
  querySource: QuerySource
  model: string
  agentId?: AgentId
  fastMode?: boolean
  globalCacheStrategy?: string
  betas?: readonly string[]
  autoModeActive?: boolean
  isUsingOverage?: boolean
  cachedMCEnabled?: boolean
  effortValue?: string | number
  extraBodyParams?: unknown
}

/**
 * 阶段 1（调用前）：记录当前提示词/工具状态并检测哪些发生了变化。
 * 不会触发事件——仅暂存待定改动供阶段 2 使用。
 */
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
    const {
      system,
      toolSchemas,
      querySource,
      model,
      agentId,
      fastMode,
      globalCacheStrategy = '',
      betas = [],
      autoModeActive = false,
      isUsingOverage = false,
      cachedMCEnabled = false,
      effortValue,
      extraBodyParams,
    } = snapshot
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const strippedSystem = stripCacheControl(
      system as unknown as ReadonlyArray<Record<string, unknown>>,
    )
    const strippedTools = stripCacheControl(
      toolSchemas as unknown as ReadonlyArray<Record<string, unknown>>,
    )

    const systemHash = computeHash(strippedSystem)
    const toolsHash = computeHash(strippedTools)
    // 对包含 cache_control 的完整系统数组计算 hash——这能捕获
    // 剥离 hash 无法看到的 scope 翻转（global↔org/none）与 TTL 翻转
    //（1h↔5m），因为此时文本内容完全相同。
    const cacheControlHash = computeHash(
      system.map(b => ('cache_control' in b ? b.cache_control : null)),
    )
    const toolNames = toolSchemas.map(t => ('name' in t ? t.name : 'unknown'))
    // 仅在聚合值发生变化时才计算每个工具的 hash——常见情况
    //（工具未变）可跳过 N 次额外的 jsonStringify 调用。
    const computeToolHashes = () =>
      computePerToolHashes(strippedTools, toolNames)
    const systemCharCount = getSystemCharCount(system)
    const lazyDiffableContent = () =>
      buildDiffableContent(system, toolSchemas, model)
    const isFastMode = fastMode ?? false
    const sortedBetas = [...betas].sort()
    const effortStr = effortValue === undefined ? '' : String(effortValue)
    const extraBodyHash =
      extraBodyParams === undefined ? 0 : computeHash(extraBodyParams)

    const prev = previousStateBySource.get(key)

    if (!prev) {
      // map 已满时逐出最旧的条目
      while (previousStateBySource.size >= MAX_TRACKED_SOURCES) {
        const oldest = previousStateBySource.keys().next().value
        if (oldest !== undefined) previousStateBySource.delete(oldest)
      }

      previousStateBySource.set(key, {
        systemHash,
        toolsHash,
        cacheControlHash,
        toolNames,
        systemCharCount,
        model,
        fastMode: isFastMode,
        globalCacheStrategy,
        betas: sortedBetas,
        autoModeActive,
        isUsingOverage,
        cachedMCEnabled,
        effortValue: effortStr,
        extraBodyHash,
        callCount: 1,
        pendingChanges: null,
        prevCacheReadTokens: null,
        cacheDeletionsPending: false,
        buildDiffableContent: lazyDiffableContent,
        perToolHashes: computeToolHashes(),
      })
      return
    }

    prev.callCount++

    const systemPromptChanged = systemHash !== prev.systemHash
    const toolSchemasChanged = toolsHash !== prev.toolsHash
    const modelChanged = model !== prev.model
    const fastModeChanged = isFastMode !== prev.fastMode
    const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
    const globalCacheStrategyChanged =
      globalCacheStrategy !== prev.globalCacheStrategy
    const betasChanged =
      sortedBetas.length !== prev.betas.length ||
      sortedBetas.some((b, i) => b !== prev.betas[i])
    const autoModeChanged = autoModeActive !== prev.autoModeActive
    const overageChanged = isUsingOverage !== prev.isUsingOverage
    const cachedMCChanged = cachedMCEnabled !== prev.cachedMCEnabled
    const effortChanged = effortStr !== prev.effortValue
    const extraBodyChanged = extraBodyHash !== prev.extraBodyHash

    if (
      systemPromptChanged ||
      toolSchemasChanged ||
      modelChanged ||
      fastModeChanged ||
      cacheControlChanged ||
      globalCacheStrategyChanged ||
      betasChanged ||
      autoModeChanged ||
      overageChanged ||
      cachedMCChanged ||
      effortChanged ||
      extraBodyChanged
    ) {
      const prevToolSet = new Set(prev.toolNames)
      const newToolSet = new Set(toolNames)
      const prevBetaSet = new Set(prev.betas)
      const newBetaSet = new Set(sortedBetas)
      const addedTools = toolNames.filter(n => !prevToolSet.has(n))
      const removedTools = prev.toolNames.filter(n => !newToolSet.has(n))
      const changedToolSchemas: string[] = []
      if (toolSchemasChanged) {
        const newHashes = computeToolHashes()
        for (const name of toolNames) {
          if (!prevToolSet.has(name)) continue
          if (newHashes[name] !== prev.perToolHashes[name]) {
            changedToolSchemas.push(name)
          }
        }
        prev.perToolHashes = newHashes
      }
      prev.pendingChanges = {
        systemPromptChanged,
        toolSchemasChanged,
        modelChanged,
        fastModeChanged,
        cacheControlChanged,
        globalCacheStrategyChanged,
        betasChanged,
        autoModeChanged,
        overageChanged,
        cachedMCChanged,
        effortChanged,
        extraBodyChanged,
        addedToolCount: addedTools.length,
        removedToolCount: removedTools.length,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: systemCharCount - prev.systemCharCount,
        previousModel: prev.model,
        newModel: model,
        prevGlobalCacheStrategy: prev.globalCacheStrategy,
        newGlobalCacheStrategy: globalCacheStrategy,
        addedBetas: sortedBetas.filter(b => !prevBetaSet.has(b)),
        removedBetas: prev.betas.filter(b => !newBetaSet.has(b)),
        prevEffortValue: prev.effortValue,
        newEffortValue: effortStr,
        buildPrevDiffableContent: prev.buildDiffableContent,
      }
    } else {
      prev.pendingChanges = null
    }

    prev.systemHash = systemHash
    prev.toolsHash = toolsHash
    prev.cacheControlHash = cacheControlHash
    prev.toolNames = toolNames
    prev.systemCharCount = systemCharCount
    prev.model = model
    prev.fastMode = isFastMode
    prev.globalCacheStrategy = globalCacheStrategy
    prev.betas = sortedBetas
    prev.autoModeActive = autoModeActive
    prev.isUsingOverage = isUsingOverage
    prev.cachedMCEnabled = cachedMCEnabled
    prev.effortValue = effortStr
    prev.extraBodyHash = extraBodyHash
    prev.buildDiffableContent = lazyDiffableContent
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * 阶段 2（调用后）：检查 API 响应的缓存 token，判断是否真的发生了
 * 缓存破坏。若发生，则用阶段 1 记录的待定改动来解释原因。
 */
export async function checkResponseForCacheBreak(
  querySource: QuerySource,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: AgentId,
  requestId?: string | null,
): Promise<void> {
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const state = previousStateBySource.get(key)
    if (!state) return

    // 跳过被排除的模型（例如 deepseek-flash 的缓存行为不同）
    if (isExcludedModel(state.model)) return

    const prevCacheRead = state.prevCacheReadTokens
    state.prevCacheReadTokens = cacheReadTokens

    // 通过在 messages 数组中查找最近一次助手消息的时间戳
    //（在当前响应之前），计算距离上次调用经过的时间用于 TTL 检测
    const lastAssistantMessage = messages.findLast(m => m.type === 'assistant')
    const timeSinceLastAssistantMsg = lastAssistantMessage
      ? Date.now() - new Date(lastAssistantMessage.timestamp).getTime()
      : null

    // 跳过首次调用——没有可比较的上一次取值
    if (prevCacheRead === null) return

    const changes = state.pendingChanges

    // 通过缓存微压缩发送的 cache_edits 删除会有意缩减缓存前缀。
    // 缓存读取量下降是预期行为——重置基线，避免下一次调用误报。
    if (state.cacheDeletionsPending) {
      state.cacheDeletionsPending = false
      logForDebugging(
        `[PROMPT CACHE] 已应用缓存删除，缓存读取：${prevCacheRead} → ${cacheReadTokens}（预期下降）`,
      )
      // 不标记为破坏——其余状态仍然有效
      state.pendingChanges = null
      return
    }

    // 检测缓存破坏：缓存读取相对上一次下降 >5% 且
    // 绝对下降量超过最小阈值。
    const tokenDrop = prevCacheRead - cacheReadTokens
    if (
      cacheReadTokens >= prevCacheRead * 0.95 ||
      tokenDrop < MIN_CACHE_MISS_TOKENS
    ) {
      state.pendingChanges = null
      return
    }

    // 根据待定改动（如有）构建原因说明
    const parts: string[] = []
    if (changes) {
      if (changes.modelChanged) {
        parts.push(
          `模型已更改（${changes.previousModel} → ${changes.newModel}）`,
        )
      }
      if (changes.systemPromptChanged) {
        const charDelta = changes.systemCharDelta
        const charInfo =
          charDelta === 0
            ? ''
            : charDelta > 0
              ? `（+${charDelta} 字符）`
              : `（${charDelta} 字符）`
        parts.push(`系统提示已更改${charInfo}`)
      }
      if (changes.toolSchemasChanged) {
        const toolDiff =
          changes.addedToolCount > 0 || changes.removedToolCount > 0
            ? `（+${changes.addedToolCount}/-${changes.removedToolCount} 个工具）`
            : '（工具提示/schema 已更改，工具集相同）'
        parts.push(`工具已更改${toolDiff}`)
      }
      if (changes.fastModeChanged) {
        parts.push('快模式已切换')
      }
      if (changes.globalCacheStrategyChanged) {
        parts.push(
          `全局缓存策略已更改（${changes.prevGlobalCacheStrategy || 'none'} → ${changes.newGlobalCacheStrategy || 'none'}）`,
        )
      }
      if (
        changes.cacheControlChanged &&
        !changes.globalCacheStrategyChanged &&
        !changes.systemPromptChanged
      ) {
        // 仅当没有其他原因解释时，才将其作为独立原因上报——
        // 否则 scope/TTL 翻转只是结果，而非根因。
        parts.push('cache_control 已更改（scope 或 TTL）')
      }
      if (changes.betasChanged) {
        const added = changes.addedBetas.length
          ? `+${changes.addedBetas.join(',')}`
          : ''
        const removed = changes.removedBetas.length
          ? `-${changes.removedBetas.join(',')}`
          : ''
        const diff = [added, removed].filter(Boolean).join(' ')
        parts.push(`betas 已更改${diff ? `（${diff}）` : ''}`)
      }
      if (changes.autoModeChanged) {
        parts.push('自动模式已切换')
      }
      if (changes.overageChanged) {
        parts.push('overage 状态已更改（TTL 粘附锁定，无翻转）')
      }
      if (changes.cachedMCChanged) {
        parts.push('缓存微压缩已切换')
      }
      if (changes.effortChanged) {
        parts.push(
          `effort 已更改（${changes.prevEffortValue || 'default'} → ${changes.newEffortValue || 'default'}）`,
        )
      }
      if (changes.extraBodyChanged) {
        parts.push('extra body 参数已更改')
      }
    }

    // 检查时间间隔是否暗示 TTL 过期
    const lastAssistantMsgOver5minAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
    const lastAssistantMsgOver1hAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

    // PR #19823 之后的 BQ 分析（bq-queries/prompt-caching/cache_break_pr19823_analysis.sql）：
    // 当所有客户端标志均为 false 且间隔低于 TTL 时，约 90% 的破坏
    // 是服务端路由/驱逐或计费/推理不一致导致。据此给出标签，
    // 而不要暗示是 CC bug 排查。
    let reason: string
    if (parts.length > 0) {
      reason = parts.join(', ')
    } else if (lastAssistantMsgOver1hAgo) {
      reason = '可能为 1h TTL 过期（提示未更改）'
    } else if (lastAssistantMsgOver5minAgo) {
      reason = '可能为 5min TTL 过期（提示未更改）'
    } else if (timeSinceLastAssistantMsg !== null) {
      reason = '可能为服务端问题（提示未更改，间隔<5min）'
    } else {
      reason = '未知原因'
    }

    logEvent('limkenion_prompt_cache_break', {
      systemPromptChanged: changes?.systemPromptChanged ?? false,
      toolSchemasChanged: changes?.toolSchemasChanged ?? false,
      modelChanged: changes?.modelChanged ?? false,
      fastModeChanged: changes?.fastModeChanged ?? false,
      cacheControlChanged: changes?.cacheControlChanged ?? false,
      globalCacheStrategyChanged: changes?.globalCacheStrategyChanged ?? false,
      betasChanged: changes?.betasChanged ?? false,
      autoModeChanged: changes?.autoModeChanged ?? false,
      overageChanged: changes?.overageChanged ?? false,
      cachedMCChanged: changes?.cachedMCChanged ?? false,
      effortChanged: changes?.effortChanged ?? false,
      extraBodyChanged: changes?.extraBodyChanged ?? false,
      addedToolCount: changes?.addedToolCount ?? 0,
      removedToolCount: changes?.removedToolCount ?? 0,
      systemCharDelta: changes?.systemCharDelta ?? 0,
      // 工具名已做脱敏：内置名称是固定词汇表，
      // MCP 工具归并为 'mcp'（用户配置，可能泄露路径）。
      addedTools: (changes?.addedTools ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedTools: (changes?.removedTools ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      changedToolSchemas: (changes?.changedToolSchemas ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // beta 响应头名称与缓存策略是固定的类枚举值，
      // 并非代码或文件路径。requestId 是服务端生成的不透明 ID。
      addedBetas: (changes?.addedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedBetas: (changes?.removedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      prevGlobalCacheStrategy: (changes?.prevGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      newGlobalCacheStrategy: (changes?.newGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      callNumber: state.callCount,
      prevCacheReadTokens: prevCacheRead,
      cacheReadTokens,
      cacheCreationTokens,
      timeSinceLastAssistantMsg: timeSinceLastAssistantMsg ?? -1,
      lastAssistantMsgOver5minAgo,
      lastAssistantMsgOver1hAgo,
      requestId: (requestId ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 为通过 --debug 进行的调试写出 diff 文件。路径会包含在
    // 摘要日志中，便于定位（DevBar UI 已移除——事件数据
    // 可靠地流向 BQ 用于分析）。
    let diffPath: string | undefined
    if (changes?.buildPrevDiffableContent) {
      diffPath = await writeCacheBreakDiff(
        changes.buildPrevDiffableContent(),
        state.buildDiffableContent(),
      )
    }

    const diffSuffix = diffPath ? `, diff: ${diffPath}` : ''
    const summary = `[PROMPT CACHE BREAK] ${reason} [source=${querySource}，调用 #${state.callCount}，缓存读取：${prevCacheRead} → ${cacheReadTokens}，创建：${cacheCreationTokens}${diffSuffix}]`

    logForDebugging(summary, { level: 'warn' })

    state.pendingChanges = null
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * 当缓存微压缩发送 cache_edits 删除时调用。
 * 下一次 API 响应的缓存读取量会较低——这是预期行为，并非缓存破坏。
 */
export function notifyCacheDeletion(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.cacheDeletionsPending = true
  }
}

/**
 * 压缩后调用以重置缓存读取基线。
 * 压缩会合理地减少消息数量，因此下一次调用的缓存读取量
 * 会自然下降——这不是缓存破坏。
 */
export function notifyCompaction(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.prevCacheReadTokens = null
  }
}

export function cleanupAgentTracking(agentId: AgentId): void {
  previousStateBySource.delete(agentId)
}

export function resetPromptCacheBreakDetection(): void {
  previousStateBySource.clear()
}

async function writeCacheBreakDiff(
  prevContent: string,
  newContent: string,
): Promise<string | undefined> {
  try {
    const diffPath = getCacheBreakDiffPath()
    await mkdir(getLimkenionTempDir(), { recursive: true })
    const patch = createPatch(
      'prompt-state',
      prevContent,
      newContent,
      'before',
      'after',
    )
    await writeFile(diffPath, patch)
    return diffPath
  } catch {
    return undefined
  }
}
