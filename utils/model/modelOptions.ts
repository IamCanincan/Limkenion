// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isLimkenionAISubscriber } from '../auth.js'
import {
  getLimkenionAiUserDefaultModelDescription,
  getDefaultMainLoopModelSetting,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import {
  isOpenAICompat,
  OPENAI_COMPAT_DEFAULT_MODEL,
  OPENAI_COMPAT_MODELS,
} from './providers.js'

/**
 * 模型选择器的选项。
 *
 * **本构建只有 DeepSeek 两个模型**，而且 `isOpenAICompat()` 恒为 true，
 * 所以原本那一整套「按用户档位分叉的上游模型选项」——
 * `getModelOptionsBase()` 与十几个 `getXxxOption()` 构造函数
 * （含 1M 上下文变体、legacy 版本、自定义模型覆盖等）**已整体删除**。
 * 它们在兼容模式下永远走不到，属于死代码。
 */

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  // 订阅用户
  if (isLimkenionAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getLimkenionAiUserDefaultModelDescription(fastMode),
    }
  }

  // 按量付费
  return {
    value: null,
    label: '默认（推荐）',
    description: `使用默认模型（当前为 ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())}）`,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  // 只列 DeepSeek 真实存在的模型。
  if (isOpenAICompat()) {
    return [
      getDefaultOptionForUser(fastMode),
      ...OPENAI_COMPAT_MODELS.map(model => ({
        value: model,
        label:
          model === OPENAI_COMPAT_DEFAULT_MODEL ? `${model}（默认）` : model,
        description: `DeepSeek 模型 · ${model}`,
      })),
    ]
  }

  // isOpenAICompat() 恒为 true，走不到这里；保留兜底是为了万一判断逻辑变化时
  // 不会静默返回空列表。
  return [getDefaultOptionForUser(fastMode)]
}
