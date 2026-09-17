import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import type { Message } from '../types/message.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

export type McpInstructionsDelta = {
  /** 服务器名称——用于无状态扫描重建。 */
  addedNames: string[]
  /** 针对 addedNames 渲染出的 "## {name}\n{instructions}" 块。 */
  addedBlocks: string[]
  removedNames: string[]
}

/**
 * 客户端撰写的指令块，用于在服务器连接时发布，
 * 作为服务器自身 `InitializeResult.instructions` 的补充（或替代）。
 * 让第一方服务器（如 limkenion-in-chrome）携带服务器自身不知道的客户端上下文。
 */
export type ClientSideInstruction = {
  serverName: string
  block: string
}

/**
 * 为 true → 通过持久化的增量附件来发布 MCP 服务器指令。
 * 为 false → prompts.ts 继续使用其 DANGEROUS_uncachedSystemPromptSection
 * （每轮重建；在迟到连接时驱逐缓存）。
 *
 * 本地测试的环境变量覆盖：LIMKENION_MCP_INSTR_DELTA=true/false
 * 优先于 ant 分流和 GrowthBook 开关。
 */
export function isMcpInstructionsDeltaEnabled(): boolean {
  if (isEnvTruthy(process.env.LIMKENION_MCP_INSTR_DELTA)) return true
  if (isEnvDefinedFalsy(process.env.LIMKENION_MCP_INSTR_DELTA)) return false
  return (
    (getFeatureValue_CACHED_MAY_BE_STALE('limkenion_basalt_3kr', false))
  )
}

/**
 * 将当前已连接且带有指令（服务器通过 InitializeResult 提供，或客户端合成）
 * 的 MCP 服务器集合，与本次对话中已经公布过的集合做差异对比。
 * 若没有任何变化则返回 null。
 *
 * 指令在连接生命周期内不可变（握手时设定一次），因此扫描按服务器 NAME 而非内容做差异对比。
 */
export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
  clientSideInstructions: ClientSideInstruction[],
): McpInstructionsDelta | null {
  const announced = new Set<string>()
  let attachmentCount = 0
  let midCount = 0
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    attachmentCount++
    if (msg.attachment.type !== 'mcp_instructions_delta') continue
    midCount++
    for (const n of msg.attachment.addedNames) announced.add(n)
    for (const n of msg.attachment.removedNames) announced.delete(n)
  }

  const connected = mcpClients.filter(
    (c): c is ConnectedMCPServer => c.type === 'connected',
  )
  const connectedNames = new Set(connected.map(c => c.name))

  // 需发布指令的服务器（任一种通道）。一个服务器可同时具备：
  // 服务器撰写的指令 + 追加的客户端侧块。
  const blocks = new Map<string, string>()
  for (const c of connected) {
    if (c.instructions) blocks.set(c.name, `## ${c.name}\n${c.instructions}`)
  }
  for (const ci of clientSideInstructions) {
    if (!connectedNames.has(ci.serverName)) continue
    const existing = blocks.get(ci.serverName)
    blocks.set(
      ci.serverName,
      existing
        ? `${existing}\n\n${ci.block}`
        : `## ${ci.serverName}\n${ci.block}`,
    )
  }

  const added: Array<{ name: string; block: string }> = []
  for (const [name, block] of blocks) {
    if (!announced.has(name)) added.push({ name, block })
  }

  // 之前已公布、现已不再连接的服务器 → 标记为 removed。
  // 对于仍连接的服务器，不存在"已公布但如今没有指令"的情况：InitializeResult 不可变，
  // 客户端指令的开关在实际运行中也是会话内稳定的。（/model 可能切换模型开关，
  // 但 deferred_tools_delta 具有同样性质，且我们把历史视为既定历史——不做追溯性撤销。）
  const removed: string[] = []
  for (const n of announced) {
    if (!connectedNames.has(n)) removed.push(n)
  }

  if (added.length === 0 && removed.length === 0) return null

  // 与 limkenion_deferred_tools_pool_change 相同的诊断字段——相同的发布环境扫描缺陷，
  // 相同的附件持久化路径。
  logEvent('limkenion_mcp_instructions_pool_change', {
    addedCount: added.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    clientSideCount: clientSideInstructions.length,
    messagesLength: messages.length,
    attachmentCount,
    midCount,
  })

  added.sort((a, b) => a.name.localeCompare(b.name))
  return {
    addedNames: added.map(a => a.name),
    addedBlocks: added.map(a => a.block),
    removedNames: removed.sort(),
  }
}
