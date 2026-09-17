import * as React from 'react'
import { useAppState, useAppStateStore } from '../../state/AppState.js'
import {
  getActiveAgentForInput,
  getViewedTeammateTask,
} from '../../state/selectors.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
  getAgentColor,
} from '../../tools/AgentTool/agentColorManager.js'
import { getStandaloneAgentName } from '../../utils/standaloneAgent.js'
import { isInsideTmux } from '../../utils/swarm/backends/detection.js'
import {
  getCachedDetectionResult,
  isInProcessEnabled,
} from '../../utils/swarm/backends/registry.js'
import { getSwarmSocketName } from '../../utils/swarm/constants.js'
import {
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeammate,
} from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import type { Theme } from '../../utils/theme.js'

type SwarmBannerInfo = {
  text: string
  bgColor: keyof Theme
} | null

/**
 * 返回 swarm、独立代理或 --agent CLI 上下文横幅信息的 Hook。
 * - 领导者（不在 tmux 中）：返回 "tmux -L ... attach" 命令，青色背景
 * - 领导者（在 tmux / 进程内）：走到独立代理检查——若已设置则显示
 *   /rename 名称 + /color 背景，否则为 null
 * - 队友：返回 "teammate@team" 格式，使用其分配的颜色背景
 * - 查看后台代理（CoordinatorTaskPanel）：返回带其颜色的代理名
 * - 独立代理：返回带其颜色背景的代理名（不含 @team）
 * - --agent CLI 参数：返回 "@agentName"，青色背景
 */
export function useSwarmBanner(): SwarmBannerInfo {
  const teamContext = useAppState(s => s.teamContext)
  const standaloneAgentContext = useAppState(s => s.standaloneAgentContext)
  const agent = useAppState(s => s.agent)
  // 订阅以便在进入/退出队友视图时横幅更新，
  // 尽管 getActiveAgentForInput 从 store.getState() 读取。
  useAppState(s => s.viewingAgentTaskId)
  const store = useAppStateStore()
  const [insideTmux, setInsideTmux] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    void isInsideTmux().then(setInsideTmux)
  }, [])

  const state = store.getState()

  // 队友进程：以分配的颜色显示 @agentName。
  // 进程内队友无头运行——其横幅显示在领导者 UI 中。
  if (isTeammate() && !isInProcessTeammate()) {
    const agentName = getAgentName()
    if (agentName && getTeamName()) {
      return {
        text: `@${agentName}`,
        bgColor: toThemeColor(
          teamContext?.selfAgentColor ?? getTeammateColor(),
        ),
      }
    }
  }

  // 已生成队友的领导者：外部时显示 tmux-attach 提示，
  // 在 tmux / 原生窗格 / 进程内时显示被查看队友的名字。
  const hasTeammates =
    teamContext?.teamName &&
    teamContext.teammates &&
    Object.keys(teamContext.teammates).length > 0
  if (hasTeammates) {
    const viewedTeammate = getViewedTeammateTask(state)
    const viewedColor = toThemeColor(viewedTeammate?.identity.color)
    const inProcessMode = isInProcessEnabled()
    const nativePanes = getCachedDetectionResult()?.isNative ?? false

    if (insideTmux === false && !inProcessMode && !nativePanes) {
      return {
        text: `查看队友: \`tmux -L ${getSwarmSocketName()} a\``,
        bgColor: viewedColor,
      }
    }
    if (
      (insideTmux === true || inProcessMode || nativePanes) &&
      viewedTeammate
    ) {
      return {
        text: `@${viewedTeammate.identity.agentName}`,
        bgColor: viewedColor,
      }
    }
    // insideTmux === null：仍在加载中——继续向下。
    // 未在查看队友：继续向下，以便 /rename 和 /color 生效。
  }

  // 查看后台代理（CoordinatorTaskPanel）：local_agent 任务不是
  // InProcessTeammates，因此 getViewedTeammateTask 会遗漏它们。
  // 与 CoordinatorAgentStatus 相同，从 agentNameRegistry 反向查找名称。
  const active = getActiveAgentForInput(state)
  if (active.type === 'named_agent') {
    const task = active.task
    let name: string | undefined
    for (const [n, id] of state.agentNameRegistry) {
      if (id === task.id) {
        name = n
        break
      }
    }
    return {
      text: name ? `@${name}` : task.description,
      bgColor: getAgentColor(task.agentType) ?? 'cyan_FOR_SUBAGENTS_ONLY',
    }
  }

  // 独立代理（/rename、/color）：名称和/或自定义颜色，不含 @team。
  const standaloneName = getStandaloneAgentName(state)
  const standaloneColor = standaloneAgentContext?.color
  if (standaloneName || standaloneColor) {
    return {
      text: standaloneName ?? '',
      bgColor: toThemeColor(standaloneColor),
    }
  }

  // --agent CLI 参数（在未由上面处理时）。
  if (agent) {
    const agentDef = state.agentDefinitions.activeAgents.find(
      a => a.agentType === agent,
    )
    return {
      text: agent,
      bgColor: toThemeColor(agentDef?.color, 'promptBorder'),
    }
  }

  return null
}

function toThemeColor(
  colorName: string | undefined,
  fallback: keyof Theme = 'cyan_FOR_SUBAGENTS_ONLY',
): keyof Theme {
  return colorName && AGENT_COLORS.includes(colorName as AgentColorName)
    ? AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName]
    : fallback
}
