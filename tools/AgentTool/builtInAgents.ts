import { feature } from 'bun:bundle'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { LIMKENION_GUIDE_AGENT } from './built-in/limkenionGuideAgent.js'
import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { STATUSLINE_SETUP_AGENT } from './built-in/statuslineSetup.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

export function areExplorePlanAgentsEnabled(): boolean {
  if (feature('BUILTIN_EXPLORE_PLAN_AGENTS')) {
    // 3P 默认值：true——Bedrock/Vertex 保持 agent 启用（与实验前
    // 的外部行为一致）。A/B 测试处理组设为 false 以衡量移除的影响。
    return getFeatureValue_CACHED_MAY_BE_STALE('limkenion_amber_stoat', true)
  }
  return false
}

export function getBuiltInAgents(): AgentDefinition[] {
  // 允许通过环境变量禁用所有内置 agent（对想要全新空白环境的 SDK 用户有用）
  // 仅在非交互模式（SDK/API 用法）下生效
  if (
    isEnvTruthy(process.env.LIMKENION_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }

  // 在函数体内使用惰性 require，以避免模块初始化时的循环依赖
  // 问题。coordinatorMode 模块依赖 tools，
  // tools 依赖 AgentTool，而 AgentTool 导入了本文件。
  if (feature('COORDINATOR_MODE')) {
    if (isEnvTruthy(process.env.LIMKENION_COORDINATOR_MODE)) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getCoordinatorAgents } =
        require('../../coordinator/workerAgent.js') as typeof import('../../coordinator/workerAgent.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      return getCoordinatorAgents()
    }
  }

  const agents: AgentDefinition[] = [
    GENERAL_PURPOSE_AGENT,
    STATUSLINE_SETUP_AGENT,
  ]

  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)
  }

  // 为非 SDK 入口包含 Code Guide agent
  const isNonSdkEntrypoint =
    process.env.LIMKENION_ENTRYPOINT !== 'sdk-ts' &&
    process.env.LIMKENION_ENTRYPOINT !== 'sdk-py' &&
    process.env.LIMKENION_ENTRYPOINT !== 'sdk-cli'

  if (isNonSdkEntrypoint) {
    agents.push(LIMKENION_GUIDE_AGENT)
  }

  if (
    feature('VERIFICATION_AGENT') &&
    getFeatureValue_CACHED_MAY_BE_STALE('limkenion_hive_evidence', false)
  ) {
    agents.push(VERIFICATION_AGENT)
  }

  return agents
}
