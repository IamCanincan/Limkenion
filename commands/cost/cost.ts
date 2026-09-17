import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/limkenionAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isLimkenionAISubscriber } from '../../utils/auth.js'

export const call: LocalCommandCall = async () => {
  if (isLimkenionAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        '你当前正在使用超额量来驱动你的 Limkenion 使用。当订阅速率限制重置时，我们会自动将你切回订阅速率限制'
    } else {
      value =
        '你当前正在使用你的订阅来驱动你的 Limkenion 使用'
    }

    
    return { type: 'text', value }
  }
  return { type: 'text', value: formatTotalCost() }
}
