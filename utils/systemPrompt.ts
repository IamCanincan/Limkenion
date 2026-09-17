import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { isEnvTruthy } from './envUtils.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

export { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

// 死代码消除：针对主动模式的条件导入。
// 与 prompts.ts 相同的模式——懒 require 以避免把模块拉进非主动模式构建。
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

function isProactiveActive_SAFE_TO_CALL_ANYWHERE(): boolean {
  return proactiveModule?.isProactiveActive() ?? false
}

/**
 * 依据优先级构建有效的系统提示数组：
 * 0. 覆盖系统提示（如已设置，如循环模式——替换所有其他提示）
 * 1. 协调者系统提示（若协调者模式激活）
 * 2. Agent 系统提示（若设置了 mainThreadAgentDefinition）
 *    - 主动模式下：agent 提示被追加到默认提示之后（agent 在自主 agent 提示之上叠加领域指令，与队友一致）
 *    - 其他情况：agent 提示替换默认提示
 * 3. 自定义系统提示（若通过 --system-prompt 指定）
 * 4. 默认系统提示（标准 Limkenion 提示）
 *
 * 此外，appendSystemPrompt 在指定时总是追加到末尾（覆盖提示设置时除外）。
 */
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string | null
}): SystemPrompt {
  if (overrideSystemPrompt) {
    return asSystemPrompt([overrideSystemPrompt])
  }
  // 协调者模式：改用协调者提示而非默认提示
  // 使用内联环境变量检查而非 coordinatorModule，以规避测试模块加载期间的循环依赖问题。
  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.LIMKENION_COORDINATOR_MODE) &&
    !mainThreadAgentDefinition
  ) {
    // 模块加载时才懒 require，以避免加载时的循环依赖
    const { getCoordinatorSystemPrompt } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')
    return asSystemPrompt([
      getCoordinatorSystemPrompt(),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  const agentSystemPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({
          toolUseContext: { options: toolUseContext.options },
        })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  // 为主循环 agent 记录 agent 记忆加载事件
  if (mainThreadAgentDefinition?.memory) {
    logEvent('limkenion_agent_memory_loaded', {
      
      scope:
        mainThreadAgentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'main-thread' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 主动模式下，agent 指令被追加到默认提示之后，而非替换之。
  // 主动模式默认提示本就精简（自主 agent 身份 + 记忆 + 环境 + 主动模块），
  // agent 在其上叠加领域行为——与队友的模式一致。
  if (
    agentSystemPrompt &&
    (feature('PROACTIVE') || feature('KAIROS')) &&
    isProactiveActive_SAFE_TO_CALL_ANYWHERE()
  ) {
    return asSystemPrompt([
      ...defaultSystemPrompt,
      `\n# 自定义 Agent 指令\n${agentSystemPrompt}`,
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  return asSystemPrompt([
    ...(agentSystemPrompt
      ? [agentSystemPrompt]
      : customSystemPrompt
        ? [customSystemPrompt]
        : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}
