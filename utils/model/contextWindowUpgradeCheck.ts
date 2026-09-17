
/**
 * 获取"更多上下文"的模型升级项。
 * 没有可升级项、或用户已经是最大上下文时返回 null。
 *
 * **本构建恒返回 null** —— DeepSeek 的上下文本来就是 1M，不存在"升到 1M"这个阶梯；
 * 而且原本那两条分支依赖的是订阅判定，本地恒 false；
 * 上游那套 `[1m]` 变体别名也已随模型表移除。
 */
function getAvailableUpgrade(): {
  alias: string
  name: string
  multiplier: number
} | null {
  return null
}

/**
 * Get upgrade message for different contexts
 */
export function getUpgradeMessage(context: 'warning' | 'tip'): string | null {
  const upgrade = getAvailableUpgrade()
  if (!upgrade) return null

  switch (context) {
    case 'warning':
      return `/model ${upgrade.alias}`
    case 'tip':
      return `Tip: You have access to ${upgrade.name} with ${upgrade.multiplier}x more context`
    default:
      return null
  }
}
