// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

// @[MODEL LAUNCH]: 若新模型支持 effort 参数，请将其加入白名单。
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.LIMKENION_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // 由 Limkenion 4 的模型子集支持
  if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return true
  }
  // 排除任何其他已知的旧版模型（deepseek-flash、较老的 deepseek-v4-pro/deepseek-flash 变体）
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // 重要：更改默认 effort 支持前，务必通知模型发布 DRI 和研究团队。
  // 这是一项敏感设置，会极大地影响模型质量和 bashing。

  // 对 1P 的未知模型串默认返回 true。
  // 对 3P 不默认 true，因为它们的模型串格式不同（例如 limkenions/limkenion#30795）
  return getAPIProvider() === 'firstParty'
}

// @[MODEL LAUNCH]: 若新模型支持 'max' effort，请将其加入白名单。
// 根据 API 文档，对公开模型而言 'max' 仅限 deepseek-v4-pro——其他模型会返回错误。
export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (model.toLowerCase().includes('opus-4-6')) {
    return true
  }
  
  return false
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * 数值 effort 仅供模型默认使用，不做持久化。
 * 对外部用户而言 'max' 是会话作用域的（ant 可以持久化它）。
 * 写入方在保存到设置前调用本函数，使只接受字符串级别的 Zod schema
 * 永不拒绝写入。
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  if (value === 'max' && false) {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // 读取时 toPersistableEffort 会为非 ant 过滤掉 'max'，因此手工编辑的
  // settings.json 不会把会话作用域的 max 泄漏到一次全新的会话里。
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * 决定用户在 ModelPicker 中选择模型时应持久化哪个 effort 级别（如果有）。
 * 即使显式指定的早期 /effort 选择恰好匹配所选模型的默认值，也会让它保持
 * 粘性；而纯默认和会话瞬态 effort（CLI --effort、EffortCallout 默认）则放行
 * 到 undefined，以便其跟随未来的模型默认变化。
 *
 * priorPersisted 必须来自磁盘上的 userSettings
 * （getSettingsForSource('userSettings')?.effortLevel），而非合并后的设置
 * （project/policy 层会泄漏进用户的全局 settings.json），也非
 * AppState.effortValue（它包含刻意不写入 settings.json 的会话作用域来源）。
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.LIMKENION_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * 解析最终会发送给 API 的 effort 值，遵循完整优先级链：
 *   env LIMKENION_EFFORT_LEVEL → appState.effortValue → 模型默认
 *
 * 当不应发送 effort 参数时返回 undefined（env 设为 'unset'，或模型无默认值）。
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // 对非 deepseek-v4-pro-4.6 模型，API 拒绝 'max'——降级为 'high'。
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  return resolved
}

/**
 * 解析要向用户展示的 effort 级别。用 'high' 兜底包装 resolveAppliedEffort
 * （不发送 effort 参数时 API 实际使用的值）。状态栏和 /effort 输出的
 * 单一事实来源（CC-1088）。
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * 构建 Logo/Spinner 中显示的 ` with {level} effort` 后缀。
 * 若用户未显式设置 effort 值则返回空串。
 * 委托给 resolveAppliedEffort()，使显示的级别与 API 实际收到的值一致
 * （包括非 deepseek-v4-pro 模型的 max→high 钳制）。
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // 运行时守卫：值可能来自远程配置（GrowthBook），TypeScript 类型在这里
    // 帮不上忙。把未知串强制为 'high'，而不是不检查就让它们通过。
    return isEffortLevel(value) ? value : 'high'
  }
  
  return 'high'
}

/**
 * 获取面向用户的 effort 级别描述
 *
 * @param level 要描述的 effort 级别
 * @returns 人类可读的描述
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return '快速直接的实现，开销极小'
    case 'medium':
      return '均衡方案，包含标准的实现与测试'
    case 'high':
      return '全面实现，包含充分的测试与文档'
    case 'max':
      return '最大能力，推理最深（仅限 DeepSeek V4 Pro）'
  }
}

/**
 * 获取面向用户的 effort 值描述（字符串与数值形式均可）
 *
 * @param value 要描述的 effort 值
 * @returns 人类可读的描述
 */
export function getEffortValueDescription(value: EffortValue): string {
  

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return '均衡方案，包含标准的实现与测试'
}

export type StrongModelDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: StrongModelDefaultEffortConfig = {
  enabled: true,
  dialogTitle: '我们建议强模型使用中等 effort',
  dialogDescription:
    'Effort 决定 Limkenion 完成你的任务时思考的时长。我们建议大多数任务使用中等 effort，以在速度与智能之间取得平衡并最大化速率限制。需要时可使用 ultrathink 触发高 effort。',
}

export function getStrongModelDefaultEffortConfig(): StrongModelDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'limkenion_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: 更新新模型的默认 effort 级别
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  

  // 重要：更改默认 effort 级别前，务必通知模型发布 DRI 和研究团队。
  // 默认 effort 是一项敏感设置，会极大地影响模型质量和 bashing。

  // Pro 用户在 deepseek-v4-pro 上默认用中等 effort。
  // 当 limkenion_grey_step2 配置启用时，Max/Team 同样使用中等 effort。
  if (model.toLowerCase().includes('opus-4-6')) {
    if (isProSubscriber()) {
      return 'medium'
    }
    if (
      getStrongModelDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'medium'
    }
  }

  // 当 ultrathink 功能开启时，默认 effort 为中等（ultrathink 会提升到高）
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // 回退到 undefined，即我们不设置 effort 级别。这应在 API 中解析为高 effort。
  return undefined
}
