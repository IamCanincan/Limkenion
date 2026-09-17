// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import {
  isLimkenionAISubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getModelStrings } from './modelStrings.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkStrong1mAccess, checkMain1mAccess } from './check1mAccess.js'
import {
  getAPIProvider,
  isOpenAICompat,
  OPENAI_COMPAT_DEFAULT_MODEL,
  OPENAI_COMPAT_MODELS,
} from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getLimkenionAiUserDefaultModelDescription,
  getDefaultMainModel,
  getDefaultStrongModel,
  getDefaultSmallFastModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  is1mContextMergeEnabled,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { has1mContext } from '../context.js'
import { getGlobalConfig } from '../config.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  

  // Subscribers
  if (isLimkenionAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getLimkenionAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  return {
    value: null,
    label: '默认（推荐）',
    description: `使用默认模型（当前为 ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())}）`,
  }
}

function getCustomSonnetOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customMainModel = process.env.LIMKENION_DEFAULT_SONNET_MODEL
  // When a 3P user has a custom deepseek-flash model string, show it directly
  if (is3P && customMainModel) {
    const is1m = has1mContext(customMainModel)
    return {
      value: 'sonnet',
      label:
        process.env.LIMKENION_DEFAULT_SONNET_MODEL_NAME ?? customMainModel,
      description:
        process.env.LIMKENION_DEFAULT_SONNET_MODEL_DESCRIPTION ??
        `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.LIMKENION_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customMainModel})`,
    }
  }
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
function getSonnet46Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().deepseekFlash : 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 4.6 · Best for everyday tasks`,
    descriptionForModel:
      'Sonnet 4.6 - best for everyday tasks. Generally recommended for most coding tasks',
  }
}

function getCustomOpusOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customStrongModel = process.env.LIMKENION_DEFAULT_OPUS_MODEL
  // When a 3P user has a custom deepseek-v4-pro model string, show it directly
  if (is3P && customStrongModel) {
    const is1m = has1mContext(customStrongModel)
    return {
      value: 'opus',
      label: process.env.LIMKENION_DEFAULT_OPUS_MODEL_NAME ?? customStrongModel,
      description:
        process.env.LIMKENION_DEFAULT_OPUS_MODEL_DESCRIPTION ??
        `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.LIMKENION_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customStrongModel})`,
    }
  }
}

function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version',
  }
}

function getStrongOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().deepseekV4Pro : 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work`,
    descriptionForModel: 'Opus 4.6 - most capable for complex work',
  }
}

export function getMain1mOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().deepseekFlash + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 for long sessions`,
    descriptionForModel:
      'Sonnet 4.6 with 1M context window - for long sessions with large codebases',
  }
}

export function getStrong1mOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().deepseekV4Pro + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 for long sessions`,
    descriptionForModel:
      'Opus 4.6 with 1M context window - for long sessions with large codebases',
  }
}

function getCustomHaikuOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customSmallFastModel = process.env.LIMKENION_DEFAULT_HAIKU_MODEL
  // When a 3P user has a custom deepseek-flash model string, show it directly
  if (is3P && customSmallFastModel) {
    return {
      value: 'haiku',
      label: process.env.LIMKENION_DEFAULT_HAIKU_MODEL_NAME ?? customSmallFastModel,
      description:
        process.env.LIMKENION_DEFAULT_HAIKU_MODEL_DESCRIPTION ??
        'Custom Haiku model',
      descriptionForModel: `${process.env.LIMKENION_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customSmallFastModel})`,
    }
  }
}

function getSmallFastOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
  }
}

function getHaiku35Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks`,
    descriptionForModel:
      'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.',
  }
}

function getHaikuOption(): ModelOption {
  // Return correct deepseek-flash option based on provider
  const haikuModel = getDefaultSmallFastModel()
  return haikuModel === getModelStrings().deepseekFlash
    ? getSmallFastOption()
    : getHaiku35Option()
}

function getMaxStrongOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.6 · Most capable for complex work`,
  }
}

export function getMaxMain1mOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const billingInfo = isLimkenionAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.6 with 1M context${billingInfo}`,
  }
}

export function getMaxStrong1mOption(fastMode = false): ModelOption {
  const billingInfo = isLimkenionAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 with 1M context${billingInfo}`,
  }
}

function getMerged1mContextOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().deepseekV4Pro + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.6 with 1M context · Most capable for complex work`,
    descriptionForModel:
      'Opus 4.6 with 1M context - most capable for complex work',
  }
}

const MaxSonnet46Option: ModelOption = {
  value: 'sonnet',
  label: 'Sonnet',
  description: 'Sonnet 4.6 · Best for everyday tasks',
}

const MaxSmallFastOption: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
}

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus 4.6 in plan mode, Sonnet 4.6 otherwise',
  }
}

// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.
function getModelOptionsBase(fastMode = false): ModelOption[] {
  

  if (isLimkenionAISubscriber()) {
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Max and Team Premium users: deepseek-v4-pro is default, show deepseek-flash as alternative
      const premiumOptions = [getDefaultOptionForUser(fastMode)]
      if (!is1mContextMergeEnabled() && checkStrong1mAccess()) {
        premiumOptions.push(getMaxStrong1mOption(fastMode))
      }

      premiumOptions.push(MaxSonnet46Option)
      if (checkMain1mAccess()) {
        premiumOptions.push(getMaxMain1mOption())
      }

      premiumOptions.push(MaxSmallFastOption)
      return premiumOptions
    }

    // Pro/Team Standard/Enterprise users: deepseek-flash is default, show deepseek-v4-pro as alternative
    const standardOptions = [getDefaultOptionForUser(fastMode)]
    if (checkMain1mAccess()) {
      standardOptions.push(getMaxMain1mOption())
    }

    if (is1mContextMergeEnabled()) {
      standardOptions.push(getMerged1mContextOption(fastMode))
    } else {
      standardOptions.push(getMaxStrongOption(fastMode))
      if (checkStrong1mAccess()) {
        standardOptions.push(getMaxStrong1mOption(fastMode))
      }
    }

    standardOptions.push(MaxSmallFastOption)
    return standardOptions
  }

  // PAYG 1P API: Default (deepseek-flash) + deepseek-flash（1M 上下文） + deepseek-v4-pro + deepseek-v4-pro（1M 上下文） + deepseek-flash
  if (getAPIProvider() === 'firstParty') {
    const payg1POptions = [getDefaultOptionForUser(fastMode)]
    if (checkMain1mAccess()) {
      payg1POptions.push(getMain1mOption())
    }
    if (is1mContextMergeEnabled()) {
      payg1POptions.push(getMerged1mContextOption(fastMode))
    } else {
      payg1POptions.push(getStrongOption(fastMode))
      if (checkStrong1mAccess()) {
        payg1POptions.push(getStrong1mOption(fastMode))
      }
    }
    payg1POptions.push(getSmallFastOption())
    return payg1POptions
  }

  // PAYG 3P: Default (deepseek-flash) + deepseek-flash (3P custom) or deepseek-flash/1M + deepseek-v4-pro (3P custom) or deepseek-v4-pro/deepseek-v4-pro/Opus1M + deepseek-flash + deepseek-v4-pro
  const payg3pOptions = [getDefaultOptionForUser(fastMode)]

  const customMain = getCustomSonnetOption()
  if (customMain !== undefined) {
    payg3pOptions.push(customMain)
  } else {
    // Add deepseek-flash since deepseek-flash is the default
    payg3pOptions.push(getSonnet46Option())
    if (checkMain1mAccess()) {
      payg3pOptions.push(getMain1mOption())
    }
  }

  const customStrong = getCustomOpusOption()
  if (customStrong !== undefined) {
    payg3pOptions.push(customStrong)
  } else {
    // Add deepseek-v4-pro, deepseek-v4-pro and deepseek-v4-pro 1M
    payg3pOptions.push(getOpus41Option()) // This is the default deepseek-v4-pro
    payg3pOptions.push(getStrongOption(fastMode))
    if (checkStrong1mAccess()) {
      payg3pOptions.push(getStrong1mOption(fastMode))
    }
  }
  const customSmallFast = getCustomHaikuOption()
  if (customSmallFast !== undefined) {
    payg3pOptions.push(customSmallFast)
  } else {
    payg3pOptions.push(getHaikuOption())
  }
  return payg3pOptions
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // deepseek-flash family
  if (
    canonical.includes('limkenion-sonnet-4-6') ||
    canonical.includes('limkenion-sonnet-4-5') ||
    canonical.includes('limkenion-sonnet-4-') ||
    canonical.includes('limkenion-3-7-sonnet') ||
    canonical.includes('limkenion-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultMainModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // deepseek-v4-pro family
  if (canonical.includes('limkenion-opus-4')) {
    const currentName = getMarketingNameForModel(getDefaultStrongModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // deepseek-flash family
  if (
    canonical.includes('limkenion-haiku') ||
    canonical.includes('limkenion-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSmallFastModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Limkenion model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  // OpenAI 兼容模式（DeepSeek）下：只列 DeepSeek 真实存在的模型，
  // 不再罗列上游那套多档模型选项（deepseek-flash/deepseek-v4-pro/deepseek-flash 在这里都不存在）。
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
  const options = getModelOptionsBase(fastMode)

  // Add the custom model from the LIMKENION_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.LIMKENION_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.LIMKENION_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.LIMKENION_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'opus' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxStrongOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMerged1mContextOption(fastMode),
    ])
  } else {
    // Try to show a human-readable label for known Limkenion models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
