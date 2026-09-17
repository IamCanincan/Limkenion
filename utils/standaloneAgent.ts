/**
 * 用于自定义名称/颜色的会话的独立智能体工具
 *
 * 这些辅助函数为不属于 swarm 团队的会话提供独立智能体上下文（名称和颜色）的
 * 访问。当会话属于 swarm 时，这些函数返回 undefined，让 swarm 上下文优先。
 */

import type { AppState } from '../state/AppState.js'
import { getTeamName } from './teammate.js'

/**
 * 若已设置且不是 swarm 队友，则返回独立智能体名称。
 * 使用 getTeamName() 以与 isTeammate() 的 swarm 检测保持一致。
 */
export function getStandaloneAgentName(appState: AppState): string | undefined {
  // 若在团队（swarm）中，不返回独立名称
  if (getTeamName()) {
    return undefined
  }
  return appState.standaloneAgentContext?.name
}
