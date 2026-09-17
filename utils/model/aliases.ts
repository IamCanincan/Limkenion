/**
 * 本构建只有 DeepSeek 两个模型。上游那套按模型家族划分的别名（含 `[1m]` 变体与
 * `best` 之类的抽象别名）已随模型表一起移除，这里只剩模型 ID 本身，
 * 外加一个「plan 模式用强模型」的模式别名。
 */
export const MODEL_ALIASES = [
  'deepseek-flash',
  'deepseek-v4-pro',
  'proplan',
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * 本构建没有「模型家族」的概念 —— 上游那套家族通配别名已随模型表移除。
 * availableModels 白名单里只能写具体模型 ID，没有通配别名。
 */
export const MODEL_FAMILY_ALIASES = [] as const

export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}
