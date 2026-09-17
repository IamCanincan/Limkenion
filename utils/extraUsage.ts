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
  const isStrongModel = m === 'opus' || m.includes('opus-4-6')
  const isMainModel = m === 'sonnet' || m.includes('sonnet-4-6')

  if (isStrongModel && is1mContextMerged) return false

  return isStrongModel || isMainModel
}
