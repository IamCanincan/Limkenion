// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getSubscriptionType,
  isLimkenionAISubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  getAPIProvider,
  getOpenAICompatSmallFastModel,
  isOpenAICompat,
  OPENAI_COMPAT_DEFAULT_MODEL,
} from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

export function getSmallFastModel(): ModelName {
  // OpenAI 兼容模式（DeepSeek）下必须返回真实存在的 DeepSeek 模型名。
  // 否则会拿到 getModelStrings().deepseekFlash —— 那是改名后的上游模型 ID，
  // 发给 DeepSeek 会 404，WebSearch 结果处理、离开回来摘要、agent hooks 全废。
  if (isOpenAICompat()) {
    return getOpenAICompatSmallFastModel()
  }
  return process.env.LIMKENION_SMALL_FAST_MODEL || getDefaultSmallFastModel()
}

export function isNonCustomStrongModel(model: ModelName): boolean {
  return (
    model === getModelStrings().deepseekV4Pro ||
    model === getModelStrings().deepseekV4Pro ||
    model === getModelStrings().deepseekV4Pro ||
    model === getModelStrings().deepseekV4Pro
  )
}

/**
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. LIMKENION_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = process.env.LIMKENION_MODEL || settings.model || undefined
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. LIMKENION_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getBestModel(): ModelName {
  return getDefaultStrongModel()
}

// @[MODEL LAUNCH]: 新增模型时更新强模型的默认值。
export function getDefaultStrongModel(): ModelName {
  if (process.env.LIMKENION_DEFAULT_STRONG_MODEL) {
    return process.env.LIMKENION_DEFAULT_STRONG_MODEL
  }
  // 本构建只有 firstParty（DeepSeek），原本按 provider 分叉的分支已移除。
  return getModelStrings().deepseekV4Pro
}

// @[MODEL LAUNCH]: 新增模型时更新主模型的默认值。
export function getDefaultMainModel(): ModelName {
  if (process.env.LIMKENION_DEFAULT_MAIN_MODEL) {
    return process.env.LIMKENION_DEFAULT_MAIN_MODEL
  }
  return getModelStrings().deepseekFlash
}

// @[MODEL LAUNCH]: 新增模型时更新小快模型的默认值。
export function getDefaultSmallFastModel(): ModelName {
  if (process.env.LIMKENION_DEFAULT_SMALL_FAST_MODEL) {
    return process.env.LIMKENION_DEFAULT_SMALL_FAST_MODEL
  }
  return getModelStrings().deepseekFlash
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // proplan uses deepseek-v4-pro in plan mode without [1m] suffix.
  if (
    getUserSpecifiedModelSetting() === 'proplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultStrongModel()
  }

  // flashplan by default
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultMainModel()
  }

  return mainLoopModel
}

/**
 * Get the default main loop model setting.
 *
 * This handles the built-in default:
 * - deepseek-v4-pro for Max and Team Premium users
 * - deepseek-flash for all other users (including Team Standard, Pro, Enterprise)
 *
 * @returns The default model setting to use
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // OpenAI 兼容模式（DeepSeek）下：默认走实际生效的 DeepSeek 模型，
  // 不要回落到上游的硬编码默认模型。
  if (isOpenAICompat()) {
    return OPENAI_COMPAT_DEFAULT_MODEL
  }

  // Ants default to defaultModel from flag config, or deepseek-v4-pro（1M 上下文） if not configured
  

  // Max users get deepseek-v4-pro as default
  if (isMaxSubscriber()) {
    return getDefaultStrongModel() + (is1mContextMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets deepseek-v4-pro (same as Max)
  if (isTeamPremiumSubscriber()) {
    return getDefaultStrongModel() + (is1mContextMergeEnabled() ? '[1m]' : '')
  }

  // PAYG (1P and 3P), Enterprise, Team Standard, and Pro get deepseek-flash as default
  // Note that PAYG (3P) may default to an older deepseek-flash model
  return getDefaultMainModel()
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  // 本构建的模型 ID 本身就是规范名（deepseek-flash / deepseek-v4-pro），
  // 不需要上游那套「limkenion-{家族}-{版本}」的规范化映射 —— 那张表已随模型表移除。
  return name.toLowerCase()
}

/**
 * 把完整模型串映射成跨 provider 统一的规范短名。
 * 本构建只有 DeepSeek，模型 ID 本身就是规范名，所以这里等于做一次小写归一。
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

// @[MODEL LAUNCH]: 新增模型时更新这里给用户看的默认模型描述。
export function getLimkenionAiUserDefaultModelDescription(
  _fastMode = false,
): string {
  // 本构建只有 DeepSeek 两个模型，没有订阅分档，也没有按模型的定价后缀。
  return 'DeepSeek Flash · 日常任务的默认模型'
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'proplan') {
    return '计划模式用 DeepSeek V4 Pro，其余用 DeepSeek Flash'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function is1mContextMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    getAPIProvider() !== 'firstParty'
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and the merge leaks
  // deepseek-v4-pro[1m] into the model dropdown — the API then rejects it with a
  // misleading "rate limit reached" error.
  if (isLimkenionAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'proplan') {
    return 'Plan 用强模型'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

/**
 * Returns a human-readable display name for known models, or null if the model
 * is not recognized.
 *
 * 本构建只有 DeepSeek 两个模型。原本这里是一长串 case，把各个上游模型 ID
 * 映射成 "deepseek-v4-pro" / "deepseek-flash" 之类的营销名 —— 那些模型都不存在了，
 * 而且重复 case 会让 switch 退化成只命中第一条，属于会骗人的死代码。
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  switch (model) {
    case getModelStrings().deepseekFlash:
      return 'DeepSeek Flash'
    case getModelStrings().deepseekV4Pro:
      return 'DeepSeek V4 Pro'
    default:
      return null
  }
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Limkenion {ModelName}" for publicly known models, or "Limkenion ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "Limkenion {ModelName}" for public models, or "Limkenion ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Limkenion ${publicName}`
  }
  return `Limkenion (${model})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., deepseek-flash[1m], deepseek-flash[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'proplan':
        return getDefaultMainModel() + (has1mTag ? '[1m]' : '') // deepseek-flash is default, deepseek-v4-pro in plan mode
      case 'sonnet':
        return getDefaultMainModel() + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultSmallFastModel() + (has1mTag ? '[1m]' : '')
      case 'opus':
        return getDefaultStrongModel() + (has1mTag ? '[1m]' : '')
      case 'best':
        return getBestModel()
      default:
    }
  }

  // deepseek-v4-pro/4.1 are no longer available on the first-party API (same as
  // Limkenion.ai) — silently remap to the current deepseek-v4-pro default. The 'deepseek-v4-pro'
  // alias already resolves to 4.6, so the only users on these explicit
  // strings pinned them in settings/env/--model/SDK before 4.5 launched.
  // 3P providers may not yet have 4.6 capacity, so pass through unchanged.
  if (
    getAPIProvider() === 'firstParty' &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultStrongModel() + (has1mTag ? '[1m]' : '')
  }

  

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs)
  // Only strip [1m] suffix if present, maintaining case of the base model
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: deepseek-v4-pro` means "use deepseek-v4-pro-class reasoning" — not
 * "downgrade to 200K". If the user is on deepseek-v4-pro[1m] at 230K tokens and invokes a
 * skill with `model: deepseek-v4-pro`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (deepseek-flash/deepseek-v4-pro). A skill
 * with `model: deepseek-flash` on a 1M session still downgrades — deepseek-flash has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M matches on canonical IDs ('limkenion-deepseek-v4-pro-4-6', 'limkenion-deepseek-flash-4');
  // a bare 'deepseek-v4-pro' alias falls through getCanonicalName unmatched. Resolve first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

const LEGACY_OPUS_FIRSTPARTY = [
  'limkenion-opus-4-20250514',
  'limkenion-opus-4-1-20250805',
  'limkenion-opus-4-0',
  'limkenion-opus-4-1',
]

function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/**
 * Opt-out for the legacy deepseek-v4-pro/4.1 → current deepseek-v4-pro remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.LIMKENION_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
     if (isLimkenionAISubscriber()) {
      return `Default (${getLimkenionAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
/**
 * 把模型 ID 映射成给用户看的名字。
 * 本构建只有 DeepSeek 两个模型；原本那一长串上游模型名
 * （deepseek-v4-pro / deepseek-flash / deepseek-flash …）已全部移除。
 */
export function getMarketingNameForModel(modelId: string): string | undefined {
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('deepseek-v4-pro')) {
    return 'DeepSeek V4 Pro'
  }
  if (canonical.includes('deepseek-flash')) {
    return 'DeepSeek Flash'
  }

  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
