import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * 检查是否通过 CLI 传入了 --agent-teams 标志。
 * 直接检查 process.argv，以避免与 bootstrap/state 的导入循环。
 * 注意：该标志仅在帮助中对 ant 用户显示，但如果外部用户无论如何
 * 传了它，它也会生效（受制于 killswitch）。
 */
function isAgentTeamsFlagSet(): boolean {
  return process.argv.includes('--agent-teams')
}

/**
 * 智能体团队/队友功能的集中式运行时检查。
 * 这是所有引用队友的地方（提示词、代码、工具 isEnabled、UI 等）
 * 都应检查的单一门控。
 *
 * Ant 构建：始终启用。
 * 外部构建需要同时满足：
 * 1. 通过 LIMKENION_EXPERIMENTAL_AGENT_TEAMS 环境变量或 --agent-teams 标志选择加入
 * 2. GrowthBook 门控 'limkenion_amber_flint' 启用（killswitch）
 */
export function isAgentSwarmsEnabled(): boolean {
  // Ant：始终开启
  

  // 外部：需要通过环境变量或 --agent-teams 标志选择加入
  if (
    !isEnvTruthy(process.env.LIMKENION_EXPERIMENTAL_AGENT_TEAMS) &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  // Killswitch——对外部用户始终尊重
  if (!getFeatureValue_CACHED_MAY_BE_STALE('limkenion_amber_flint', true)) {
    return false
  }

  return true
}
