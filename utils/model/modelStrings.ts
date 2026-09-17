import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from 'src/bootstrap/state.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type CanonicalModelId,
  type ModelKey,
} from './configs.js'

/**
 * Maps each model to its actual model ID string.
 * Derived from ALL_MODEL_CONFIGS — adding a model there extends this type.
 *
 * 本构建只有一种 provider（DeepSeek / OpenAI 兼容），所以不再按 provider 取值；
 * 原本的 Bedrock 分支（拉 inference profile、后台刷新）连同 Bedrock 路由一起移除了。
 */
export type ModelStrings = Record<ModelKey, string>

const MODEL_KEYS = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]

function getBuiltinModelStrings(): ModelStrings {
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = ALL_MODEL_CONFIGS[key].firstParty
  }
  return out
}

/**
 * Layer user-configured modelOverrides (from settings.json) on top of the
 * built-in model strings. Overrides are keyed by canonical model ID.
 */
function applyModelOverrides(ms: ModelStrings): ModelStrings {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) {
    return ms
  }
  const out = { ...ms }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId as CanonicalModelId]
    if (key && override) {
      out[key] = override
    }
  }
  return out
}

/**
 * Resolve an overridden model ID back to its canonical model ID. If the input
 * doesn't match any current override value, it is returned unchanged. Safe to
 * call during module init (no-ops if settings aren't loaded yet).
 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) {
    return modelId
  }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) {
      return canonicalId
    }
  }
  return modelId
}

export function getModelStrings(): ModelStrings {
  const ms = getModelStringsState()
  if (ms === null) {
    const built = getBuiltinModelStrings()
    setModelStringsState(built)
    return applyModelOverrides(built)
  }
  return applyModelOverrides(ms)
}

/**
 * Ensure model strings are initialized.
 * 保留 async 签名只是为了不破坏既有调用方（原本 Bedrock 需要等 profile 拉取完成）。
 */
export async function ensureModelStringsInitialized(): Promise<void> {
  if (getModelStringsState() === null) {
    setModelStringsState(getBuiltinModelStrings())
  }
}
