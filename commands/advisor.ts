import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import {
  canUserConfigureAdvisor,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from '../utils/advisor.js'
import {
  getDefaultMainLoopModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { validateModel } from '../utils/model/validateModel.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim().toLowerCase()
  const baseModel = parseUserSpecifiedModel(
    context.getAppState().mainLoopModel ?? getDefaultMainLoopModelSetting(),
  )

  if (!arg) {
    const current = context.getAppState().advisorModel
    if (!current) {
      return {
        type: 'text',
        value:
          'Advisor：未设置\n使用 "/advisor <model>" 启用（例如 "/advisor deepseek-v4-pro"）。',
      }
    }
    if (!modelSupportsAdvisor(baseModel)) {
      return {
        type: 'text',
        value: `Advisor：${current}（未激活）\n当前模型（${baseModel}）不支持顾问。`,
      }
    }
    return {
      type: 'text',
      value: `Advisor：${current}\n使用 "/advisor unset" 禁用，或用 "/advisor <model>" 更改。`,
    }
  }

  if (arg === 'unset' || arg === 'off') {
    const prev = context.getAppState().advisorModel
    context.setAppState(s => {
      if (s.advisorModel === undefined) return s
      return { ...s, advisorModel: undefined }
    })
    updateSettingsForSource('userSettings', { advisorModel: undefined })
    return {
      type: 'text',
      value: prev
        ? `Advisor 已禁用（之前为 ${prev}）。`
        : 'Advisor 尚未设置。',
    }
  }

  const normalizedModel = normalizeModelStringForAPI(arg)
  const resolvedModel = parseUserSpecifiedModel(arg)
  const { valid, error } = await validateModel(resolvedModel)
  if (!valid) {
    return {
      type: 'text',
      value: error
        ? `无效的顾问模型：${error}`
        : `未知模型：${arg}（${resolvedModel}）`,
    }
  }

  if (!isValidAdvisorModel(resolvedModel)) {
    return {
      type: 'text',
      value: `模型 ${arg}（${resolvedModel}）不能用作顾问`,
    }
  }

  context.setAppState(s => {
    if (s.advisorModel === normalizedModel) return s
    return { ...s, advisorModel: normalizedModel }
  })
  updateSettingsForSource('userSettings', { advisorModel: normalizedModel })

  if (!modelSupportsAdvisor(baseModel)) {
    return {
      type: 'text',
      value: `Advisor 已设置为 ${normalizedModel}。\n注意：你当前的模型（${baseModel}）不支持顾问。请切换到受支持的模型以使用 Advisor。`,
    }
  }

  return {
    type: 'text',
    value: `Advisor 已设置为 ${normalizedModel}。`,
  }
}

const advisor = {
  type: 'local',
  name: 'advisor',
  description: '配置顾问模型',
  argumentHint: '[<model>|off]',
  isEnabled: () => canUserConfigureAdvisor(),
  get isHidden() {
    return !canUserConfigureAdvisor()
  },
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default advisor
