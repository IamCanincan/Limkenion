/**
 * 显示代理信息的共享工具。
 * 同时被 CLI `limkenion agents` 处理器和交互式 `/agents` 命令使用。
 */

import { getDefaultSubagentModel } from '../../utils/model/agent.js'
import {
  getSourceDisplayName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type AgentSource = SettingSource | 'built-in' | 'plugin'

export type AgentSourceGroup = {
  label: string
  source: AgentSource
}

/**
 * 用于显示的代理来源分组的有序列表。
 * CLI 与交互式 UI 都应使用此列表以保证顺序一致。
 */
export const AGENT_SOURCE_GROUPS: AgentSourceGroup[] = [
  { label: '用户代理', source: 'userSettings' },
  { label: '项目代理', source: 'projectSettings' },
  { label: '本地代理', source: 'localSettings' },
  { label: '受管代理', source: 'policySettings' },
  { label: '插件代理', source: 'plugin' },
  { label: 'CLI 参数代理', source: 'flagSettings' },
  { label: '内置代理', source: 'built-in' },
]

export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource
}

/**
 * 通过对照活动（获胜的）代理列表，为代理注解覆盖信息。当来自更高优先级
 * 来源的同类型代理取得优先时，该代理被视为“被覆盖”。
 *
 * 同时按 (agentType, source) 去重，以处理 git worktree 重复——同一代理文件
 * 可能同时从 worktree 和主仓库加载。
 */
export function resolveAgentOverrides(
  allAgents: AgentDefinition[],
  activeAgents: AgentDefinition[],
): ResolvedAgent[] {
  const activeMap = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeMap.set(agent.agentType, agent)
  }

  const seen = new Set<string>()
  const resolved: ResolvedAgent[] = []

  // 遍历 allAgents，用来自 activeAgents 的覆盖信息为每个注解。
  // 按 (agentType, source) 去重，以处理 git worktree 重复。
  for (const agent of allAgents) {
    const key = `${agent.agentType}:${agent.source}`
    if (seen.has(key)) continue
    seen.add(key)

    const active = activeMap.get(agent.agentType)
    const overriddenBy =
      active && active.source !== agent.source ? active.source : undefined
    resolved.push({ ...agent, overriddenBy })
  }

  return resolved
}

/**
 * 解析代理的显示模型字符串。
 * 为显示目的返回模型别名或 'inherit'。
 */
export function resolveAgentModelDisplay(
  agent: AgentDefinition,
): string | undefined {
  const model = agent.model || getDefaultSubagentModel()
  if (!model) return undefined
  return model === 'inherit' ? 'inherit' : model
}

/**
 * 获取覆盖代理的来源的人可读标签。
 * 返回小写，例如 “user”、“project”、“managed”。
 */
export function getOverrideSourceLabel(source: AgentSource): string {
  return getSourceDisplayName(source).toLowerCase()
}

/**
 * 按名称字母序比较代理（不区分大小写）。
 */
export function compareAgentsByName(
  a: AgentDefinition,
  b: AgentDefinition,
): number {
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
