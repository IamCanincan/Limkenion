import {
  checkAdminRequestEligibility,
  createAdminRequest,
  getMyAdminRequests,
} from '../../services/api/adminRequests.js'
import { invalidateOverageCreditGrantCache } from '../../services/api/overageCreditGrant.js'
import { type ExtraUsage, fetchUtilization } from '../../services/api/usage.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasLimkenionAiBillingAccess } from '../../utils/billing.js'
import { openBrowser } from '../../utils/browser.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'

type ExtraUsageResult =
  | { type: 'message'; value: string }
  | { type: 'browser-opened'; url: string; opened: boolean }

export async function runExtraUsage(): Promise<ExtraUsageResult> {
  if (!getGlobalConfig().hasVisitedExtraUsage) {
    saveGlobalConfig(prev => ({ ...prev, hasVisitedExtraUsage: true }))
  }
  // 仅使当前组织的条目失效，让后续读取时重新拉取授予状态。与 visited 标志分开，
  // 因为用户可能在调试申请流程时多次运行 /extra-usage。
  invalidateOverageCreditGrantCache()

  const subscriptionType = getSubscriptionType()
  const isTeamOrEnterprise =
    subscriptionType === 'team' || subscriptionType === 'enterprise'
  const hasBillingAccess = hasLimkenionAiBillingAccess()

  if (!hasBillingAccess && isTeamOrEnterprise) {
    // 与 apps/limkenion-ai 的 useHasUnlimitedOverage() 保持一致：若超量使用已启用
    // 且没有月度上限，则无需申请。拉取出错时继续向下走，让用户提出申请
    // （与 Web 端"偏向展示"的行为一致）。
    let extraUsage: ExtraUsage | null | undefined
    try {
      const utilization = await fetchUtilization()
      extraUsage = utilization?.extra_usage
    } catch (error) {
      logError(error as Error)
    }

    if (extraUsage?.is_enabled && extraUsage.monthly_limit === null) {
      return {
        type: 'message',
        value:
          '你的组织已拥有无限超量使用额度，无需申请。',
      }
    }

    try {
      const eligibility = await checkAdminRequestEligibility('limit_increase')
      if (eligibility?.is_allowed === false) {
        return {
          type: 'message',
          value: '请联系你的管理员来管理超量使用设置。',
        }
      }
    } catch (error) {
      logError(error as Error)
      // 若资格检查失败，则继续——create 接口会在必要时强制校验
    }

    try {
      const pendingOrDismissedRequests = await getMyAdminRequests(
        'limit_increase',
        ['pending', 'dismissed'],
      )
      if (pendingOrDismissedRequests && pendingOrDismissedRequests.length > 0) {
        return {
          type: 'message',
          value:
            '你已向管理员提交过超量使用申请。',
        }
      }
    } catch (error) {
      logError(error as Error)
      // 继续向下，创建新申请
    }

    try {
      await createAdminRequest({
        request_type: 'limit_increase',
        details: null,
      })
      return {
        type: 'message',
        value: extraUsage?.is_enabled
          ? '请求已发送给你的管理员，以增加超量使用额度。'
          : '请求已发送给你的管理员，以启用超量使用额度。',
      }
    } catch (error) {
      logError(error as Error)
      // 继续向下到通用消息
    }

    return {
      type: 'message',
      value: '请联系你的管理员来管理超量使用设置。',
    }
  }

  const url = isTeamOrEnterprise
    ? 'https://limkenion.ai/admin-settings/usage'
    : 'https://limkenion.ai/settings/usage'

  try {
    const opened = await openBrowser(url)
    return { type: 'browser-opened', url, opened }
  } catch (error) {
    logError(error as Error)
    return {
      type: 'message',
      value: `无法打开浏览器。请访问 ${url} 来管理超量使用额度。`,
    }
  }
}
