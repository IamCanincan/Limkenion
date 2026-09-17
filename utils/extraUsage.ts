import { isLimkenionAISubscriber } from './auth.js'
import { has1mContext } from './context.js'

export function isBilledAsExtraUsage(
  model: string | null,
  isFastMode: boolean,
  is1mContextMerged: boolean,
): boolean {
  if (!isLimkenionAISubscriber()) return false
  if (isFastMode) return true
  if (model === null || !has1mContext(model)) return false

  const m = model
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .trim()
  const isStrongModel = m.includes('deepseek-v4-pro')
  const isMainModel = m.includes('deepseek-flash')

  if (isStrongModel && is1mContextMerged) return false

  return isStrongModel || isMainModel
}
