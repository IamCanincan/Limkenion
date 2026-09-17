import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getOauthAccountInfo,
  getSubscriptionType,
  isLimkenionAISubscriber,
} from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import type {
  ReferralCampaign,
  ReferralEligibilityResponse,
  ReferralRedemptionsResponse,
  ReferrerRewardInfo,
} from '../oauth/types.js'

// 缓存过期时间：24 小时（资格仅在订阅/实验变化时才变动）
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

// 跟踪进行中的请求，避免重复 API 调用
let fetchInProgress: Promise<ReferralEligibilityResponse | null> | null = null

export async function fetchReferralEligibility(
  campaign: ReferralCampaign = 'limkenion_guest_pass',
): Promise<ReferralEligibilityResponse> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/eligibility`

  const response = await axios.get(url, {
    headers,
    params: { campaign },
    timeout: 5000, // 后台获取的 5 秒超时
  })

  return response.data
}

export async function fetchReferralRedemptions(
  campaign: string = 'limkenion_guest_pass',
): Promise<ReferralRedemptionsResponse> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/redemptions`

  const response = await axios.get<ReferralRedemptionsResponse>(url, {
    headers,
    params: { campaign },
    timeout: 10000, // 10 秒超时
  })

  return response.data
}

/**
 * 预检查用户能否使用 guest passes 功能
 */
function shouldCheckForPasses(): boolean {
  return !!(
    getOauthAccountInfo()?.organizationUuid &&
    isLimkenionAISubscriber() &&
    getSubscriptionType() === 'max'
  )
}

/**
 * 从 GlobalConfig 检查缓存的 passes 资格
 * 返回当前缓存状态与缓存新鲜度
 */
export function checkCachedPassesEligibility(): {
  eligible: boolean
  needsRefresh: boolean
  hasCache: boolean
} {
  if (!shouldCheckForPasses()) {
    return {
      eligible: false,
      needsRefresh: false,
      hasCache: false,
    }
  }

  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) {
    return {
      eligible: false,
      needsRefresh: false,
      hasCache: false,
    }
  }

  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]

  if (!cachedEntry) {
    // 无缓存条目，需要拉取
    return {
      eligible: false,
      needsRefresh: true,
      hasCache: false,
    }
  }

  const { eligible, timestamp } = cachedEntry
  const now = Date.now()
  const needsRefresh = now - timestamp > CACHE_EXPIRATION_MS

  return {
    eligible,
    needsRefresh,
    hasCache: true,
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  SGD: 'S$',
}

export function formatCreditAmount(reward: ReferrerRewardInfo): string {
  const symbol = CURRENCY_SYMBOLS[reward.currency] ?? `${reward.currency} `
  const amount = reward.amount_minor_units / 100
  const formatted = amount % 1 === 0 ? amount.toString() : amount.toFixed(2)
  return `${symbol}${formatted}`
}

/**
 * 从资格缓存中获取引荐人奖励信息。
 * 若用户在 v1 活动中，则返回奖励信息，否则返回 null。
 */
export function getCachedReferrerReward(): ReferrerRewardInfo | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  return cachedEntry?.referrer_reward ?? null
}

/**
 * 从资格缓存中获取剩余的 passes 数量。
 * 返回剩余 passes 数量，若不可用则返回 null。
 */
export function getCachedRemainingPasses(): number | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  return cachedEntry?.remaining_passes ?? null
}

/**
 * 拉取 passes 资格并存入 GlobalConfig。
 * 返回拉取到的响应，出错时返回 null。
 */
export async function fetchAndStorePassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  // 若拉取已在进行中，返回已有的 promise
  if (fetchInProgress) {
    logForDebugging('Passes: 复用进行中的资格拉取')
    return fetchInProgress
  }

  const orgId = getOauthAccountInfo()?.organizationUuid

  if (!orgId) {
    return null
  }

  // 保存 promise 以与并发调用共享
  fetchInProgress = (async () => {
    try {
      const response = await fetchReferralEligibility()

      const cacheEntry = {
        ...response,
        timestamp: Date.now(),
      }

      saveGlobalConfig(current => ({
        ...current,
        passesEligibilityCache: {
          ...current.passesEligibilityCache,
          [orgId]: cacheEntry,
        },
      }))

      logForDebugging(
        `组织 ${orgId} 的 Passes 资格已缓存：${response.eligible}`,
      )

      return response
    } catch (error) {
      logForDebugging('拉取并缓存 passes 资格失败')
      logError(error as Error)
      return null
    } finally {
      // 完成后清除 promise
      fetchInProgress = null
    }
  })()

  return fetchInProgress
}

/**
 * 获取缓存的 passes 资格数据，若无则按需拉取。
 * 所有资格检查的主要入口。
 *
 * 此函数永不在网络上阻塞——立即返回缓存数据，如需则在后台拉取。
 * 冷启动（无缓存）时返回 null，passes 命令直到下一个会话才可用。
 */
export async function getCachedOrFetchPassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  if (!shouldCheckForPasses()) {
    return null
  }

  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) {
    return null
  }

  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  const now = Date.now()

  // 无缓存——触发后台拉取并返回 null（非阻塞）。
  // 本会话的 passes 命令不可用，但下个会话可用。
  if (!cachedEntry) {
    logForDebugging(
      'Passes: 无缓存，后台拉取资格（本会话命令不可用）',
    )
    void fetchAndStorePassesEligibility()
    return null
  }

  // 缓存存在但已过期——返回过期缓存并触发后台刷新
  if (now - cachedEntry.timestamp > CACHE_EXPIRATION_MS) {
    logForDebugging(
      'Passes: 缓存已过期，返回缓存数据并在后台刷新',
    )
    void fetchAndStorePassesEligibility() // 后台刷新
    const { timestamp, ...response } = cachedEntry
    return response as ReferralEligibilityResponse
  }

  // 缓存是新的——立即返回
  logForDebugging('Passes: 使用最新缓存资格数据')
  const { timestamp, ...response } = cachedEntry
  return response as ReferralEligibilityResponse
}

/**
 * 启动时预取 passes 资格
 */
export async function prefetchPassesEligibility(): Promise<void> {
  // 若非关键流量被禁用则跳过网络请求
  if (isEssentialTrafficOnly()) {
    return
  }

  void getCachedOrFetchPassesEligibility()
}
