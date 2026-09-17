import type { BetaUsage } from '../types/llm-protocol.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { shouldIncludeFirstPartyOnlyBetas } from './betas.js'
import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

// SDK 目前还没有 advisor 块的类型。
// TODO(hackyon): 该功能公开上线后迁移到真正的 limkenion SDK 类型
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: { [key: string]: unknown }
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | {
        type: 'advisor_result'
        text: string
      }
    | {
        type: 'advisor_redacted_result'
        encrypted_content: string
      }
    | {
        type: 'advisor_tool_result_error'
        error_code: string
      }
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export function isAdvisorBlock(param: {
  type: string
  name?: string
}): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

type AdvisorConfig = {
  enabled?: boolean
  canUserConfigure?: boolean
  baseModel?: string
  advisorModel?: string
}

function getAdvisorConfig(): AdvisorConfig {
  return getFeatureValue_CACHED_MAY_BE_STALE<AdvisorConfig>(
    'limkenion_sage_compass',
    {},
  )
}

export function isAdvisorEnabled(): boolean {
  if (isEnvTruthy(process.env.LIMKENION_DISABLE_ADVISOR_TOOL)) {
    return false
  }
  // advisor 的 beta 头仅限第一方（Bedrock/Vertex 400 启用它）。
  if (!shouldIncludeFirstPartyOnlyBetas()) {
    return false
  }
  return getAdvisorConfig().enabled ?? false
}

export function canUserConfigureAdvisor(): boolean {
  return isAdvisorEnabled() && (getAdvisorConfig().canUserConfigure ?? false)
}

export function getExperimentAdvisorModels():
  | { baseModel: string; advisorModel: string }
  | undefined {
  const config = getAdvisorConfig()
  return isAdvisorEnabled() &&
    !canUserConfigureAdvisor() &&
    config.baseModel &&
    config.advisorModel
    ? { baseModel: config.baseModel, advisorModel: config.advisorModel }
    : undefined
}

// @[MODEL LAUNCH]: 若新模型支持 advisor 工具，请在此添加。
// 检查主循环模型是否支持调用 advisor 工具。
export function modelSupportsAdvisor(model: string): boolean {
  return model.toLowerCase().includes('deepseek-')
}

// @[MODEL LAUNCH]: 若新模型可作为 advisor 模型，请在此添加。
export function isValidAdvisorModel(model: string): boolean {
  return model.toLowerCase().includes('deepseek-')
}

export function getInitialAdvisorSetting(): string | undefined {
  if (!isAdvisorEnabled()) {
    return undefined
  }
  return getInitialSettings().advisorModel
}

export function getAdvisorUsage(
  usage: BetaUsage,
): Array<BetaUsage & { model: string }> {
  const iterations = usage.iterations as
    | Array<{ type: string }>
    | null
    | undefined
  if (!iterations) {
    return []
  }
  return iterations.filter(
    it => it.type === 'advisor_message',
  ) as unknown as Array<BetaUsage & { model: string }>
}

export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor 工具

你可以使用一个由更强审查模型驱动的 \`advisor\` 工具。它不接收任何参数——一旦调用它，你的整个对话历史会自动转发过去。advisor 能看到任务、你做过的每一次工具调用、以及你看到过的每一个结果。

在实质工作之前调用 advisor——在写代码之前、在确定某一种解读之前、在基于某个假设继续推进之前。如果任务需要先做定位（查找文件、阅读代码、了解现状），先做这些，然后再调用 advisor。定位不属于实质工作；而编写、编辑和给出结论属于实质工作。

以下情况也应调用 advisor：
- 当你认为任务已完成时。在这次调用之前，请先让你的交付成果变得持久可靠：写入文件、暂存变更、保存结果。advisor 的调用需要时间；如果会话在此期间结束，那么持久的结果仍在、未写入的结果会丢失。
- 当你卡住时——错误反复出现、方法迟迟不收敛、结果对不上。
- 当你考虑更换方法时。

对于超过几个步骤的任务，在敲定方法前至少调用一次 advisor，在宣布完成前再调用一次。对于由刚读到的工具输出决定下一步的短响应式任务，你不需要反复调用——advisor 的大部分价值在第一调用时（方法成型之前）就已兑现。

认真对待这些建议。如果你照做某一步却在实证上失败了，或你有与某条具体论断相矛盾的一手证据（文件上写的是 X，代码实际是 Y），那就做出调整。一次通过的自测并不能证明建议是错的——它只能说明你的测试没有覆盖 advisor 所检查的内容。

如果你已经检索到的数据指向一个方向，而 advisor 指向另一个方向：不要默默切换。在再一次 advisor 调用中把冲突摆出来——"我发现 X，你建议 Y，哪个约束条件能打破平局？" advisor 看到了你的证据，但可能低估了它的分量；一次核对调用的代价，远低于走上错误分支的代价。`
