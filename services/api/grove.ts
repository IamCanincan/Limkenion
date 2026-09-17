import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { isConsumerSubscriber } from 'src/utils/auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { isEssentialTrafficOnly } from 'src/utils/privacyLevel.js'
import { writeToStderr } from 'src/utils/process.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  getAuthHeaders,
  getUserAgent,
  withOAuth401Retry,
} from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getLimkenionUserAgent } from '../../utils/userAgent.js'

// 缓存有效期：24 小时
const GROVE_CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

export type AccountSettings = {
  grove_enabled: boolean | null
  grove_notice_viewed_at: string | null
}

export type GroveConfig = {
  grove_enabled: boolean
  domain_excluded: boolean
  notice_is_grace_period: boolean
  notice_reminder_frequency: number | null
}

/**
 * 用于区分 API 失败与成功的结果类型。
 * - success: true 表示 API 调用成功（data 中仍可能含 null 字段）
 * - success: false 表示 API 在重试后仍失败
 */
export type ApiResult<T> = { success: true; data: T } | { success: false }

/**
 * 获取当前账户的 Grove 设置。
 * 返回 ApiResult 以区分 API 失败与成功。
 * 先使用已有的 OAuth 401 重试，若无效则返回失败。
 *
 * 本次会话内记忆化，避免重复渲染时多余请求。
 * 缓存会在 updateGroveSettings() 中失效，确保切换后的读取保持最新。
 */
export const getGroveSettings = memoize(
  async (): Promise<ApiResult<AccountSettings>> => {
    // Grove 是通知类功能；服务中断期间跳过它是正确的。
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`获取认证响应头失败：${authHeaders.error}`)
        }
        return axios.get<AccountSettings>(
          `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getLimkenionUserAgent(),
            },
          },
        )
      })
      return { success: true, data: response.data }
    } catch (err) {
      logError(err)
      // 不要缓存失败结果——临时的网络问题会让用户整个会话
      // 都无法使用隐私设置（死锁：对话框需成功结果才能渲染开关，
      // 而开关调用 updateGroveSettings 是唯一另一处清除缓存的地方）。
      getGroveSettings.cache.clear?.()
      return { success: false }
    }
  },
)

/**
 * 标记 Grove 通知已被用户查看
 */
export async function markGroveNoticeViewed(): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`获取认证响应头失败：${authHeaders.error}`)
      }
      return axios.post(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/grove_notice_viewed`,
        {},
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getLimkenionUserAgent(),
          },
        },
      )
    })
    // 这在服务端变更 grove_notice_viewed_at——Grove.tsx:87 读取它来
    // 决定是否展示对话框。若不失效缓存，同一会话内重新挂载会读到
    // 过期的 viewed_at:null，从而再次弹出对话框。
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * 更新当前账户的 Grove 设置
 */
export async function updateGroveSettings(
  groveEnabled: boolean,
): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`获取认证响应头失败：${authHeaders.error}`)
      }
      return axios.patch(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
        {
          grove_enabled: groveEnabled,
        },
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getLimkenionUserAgent(),
          },
        },
      )
    })
    // 使记忆化的设置失效，确保切换后的确认读取在
    // privacy-settings.tsx 中拿到新值。
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * 检查用户是否符合 Grove 条件（非阻塞、优先读缓存）。
 *
 * 此函数永不在网络上阻塞——立即返回缓存数据，如需则在后台获取。
 * 冷启动（无缓存）时返回 false，Grove 对话框直到下一个会话才展示。
 */
export async function isQualifiedForGrove(): Promise<boolean> {
  if (!isConsumerSubscriber()) {
    return false
  }

  // Limkenion 无远程账号，恒无账号 UUID，不符合 Grove 条件。
  const accountId = null
  if (!accountId) {
    return false
  }

  const globalConfig = getGlobalConfig()
  const cachedEntry = globalConfig.groveConfigCache?.[accountId]
  const now = Date.now()

  // 无缓存——触发后台获取并返回 false（非阻塞）。
  // 本会话不展示 Grove 对话框，但下个会话若有资格则会展示。
  if (!cachedEntry) {
    logForDebugging(
      'Grove: 无缓存，后台获取配置（本会话跳过对话框）',
    )
    void fetchAndStoreGroveConfig(accountId)
    return false
  }

  // 缓存存在但已过期——返回缓存值并在后台刷新
  if (now - cachedEntry.timestamp > GROVE_CACHE_EXPIRATION_MS) {
    logForDebugging(
      'Grove: 缓存已过期，返回缓存数据并在后台刷新',
    )
    void fetchAndStoreGroveConfig(accountId)
    return cachedEntry.grove_enabled
  }

  // 缓存是新的——立即返回
  logForDebugging('Grove: 使用最新缓存配置')
  return cachedEntry.grove_enabled
}

/**
 * 从 API 获取 Grove 配置并存储到缓存
 */
async function fetchAndStoreGroveConfig(accountId: string): Promise<void> {
  try {
    const result = await getGroveNoticeConfig()
    if (!result.success) {
      return
    }
    const groveEnabled = result.data.grove_enabled
    const cachedEntry = getGlobalConfig().groveConfigCache?.[accountId]
    if (
      cachedEntry?.grove_enabled === groveEnabled &&
      Date.now() - cachedEntry.timestamp <= GROVE_CACHE_EXPIRATION_MS
    ) {
      return
    }
    saveGlobalConfig(current => ({
      ...current,
      groveConfigCache: {
        ...current.groveConfigCache,
        [accountId]: {
          grove_enabled: groveEnabled,
          timestamp: Date.now(),
        },
      },
    }))
  } catch (err) {
    logForDebugging(`Grove: 获取并存储配置失败：${err}`)
  }
}

/**
 * 从 API 获取 Grove Statsig 配置。
 * 返回 ApiResult 以区分 API 失败与成功。
 * 先使用已有的 OAuth 401 重试，若无效则返回失败。
 */
export const getGroveNoticeConfig = memoize(
  async (): Promise<ApiResult<GroveConfig>> => {
    // Grove 是通知类功能；服务中断期间跳过它是正确的。
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`获取认证响应头失败：${authHeaders.error}`)
        }
        return axios.get<GroveConfig>(
          `${getOauthConfig().BASE_API_URL}/api/limkenion_grove`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getUserAgent(),
            },
            timeout: 3000, // 短超时——若响应慢则跳过 Grove 对话框
          },
        )
      })

      // 将 API 响应映射为 GroveConfig 类型
      const {
        grove_enabled,
        domain_excluded,
        notice_is_grace_period,
        notice_reminder_frequency,
      } = response.data

      return {
        success: true,
        data: {
          grove_enabled,
          domain_excluded: domain_excluded ?? false,
          notice_is_grace_period: notice_is_grace_period ?? true,
          notice_reminder_frequency,
        },
      }
    } catch (err) {
      logForDebugging(`获取 Grove 通知配置失败：${err}`)
      return { success: false }
    }
  },
)

/**
 * 决定是否应展示 Grove 对话框。
 * 若任一 API 调用（重试后）失败则返回 false——API 失败时隐藏对话框。
 */
export function calculateShouldShowGrove(
  settingsResult: ApiResult<AccountSettings>,
  configResult: ApiResult<GroveConfig>,
  showIfAlreadyViewed: boolean,
): boolean {
  // API 失败（重试后）时隐藏对话框
  if (!settingsResult.success || !configResult.success) {
    return false
  }

  const settings = settingsResult.data
  const config = configResult.data

  const hasChosen = settings.grove_enabled !== null
  if (hasChosen) {
    return false
  }
  if (showIfAlreadyViewed) {
    return true
  }
  if (!config.notice_is_grace_period) {
    return true
  }
  // 检查是否需要提醒用户接受条款并选择
  // 是否帮助改进 Limkenion。
  const reminderFrequency = config.notice_reminder_frequency
  if (reminderFrequency !== null && settings.grove_notice_viewed_at) {
    const daysSinceViewed = Math.floor(
      (Date.now() - new Date(settings.grove_notice_viewed_at).getTime()) /
        (1000 * 60 * 60 * 24),
    )
    return daysSinceViewed >= reminderFrequency
  } else {
    // 若从未查看过则展示
    const viewedAt = settings.grove_notice_viewed_at
    return viewedAt === null || viewedAt === undefined
  }
}

export async function checkGroveForNonInteractive(): Promise<void> {
  const [settingsResult, configResult] = await Promise.all([
    getGroveSettings(),
    getGroveNoticeConfig(),
  ])

  // 检查用户是否尚未做出选择（API 失败时返回 false）
  const shouldShowGrove = calculateShouldShowGrove(
    settingsResult,
    configResult,
    false,
  )

  if (shouldShowGrove) {
    // 仅当两个 API 调用都成功时 shouldShowGrove 才为 true
    const config = configResult.success ? configResult.data : null
    logEvent('limkenion_grove_print_viewed', {
      dismissable:
        config?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (config === null || config.notice_is_grace_period) {
      // 宽限期仍在——展示提示信息并继续
      writeToStderr(
        '\n我们对消费者条款和隐私政策的更新将于 2025 年 10 月 8 日生效。运行 `limkenion` 以查看更新后的条款。\n\n',
      )
      await markGroveNoticeViewed()
    } else {
      // 宽限期已结束——展示错误信息并退出
      writeToStderr(
        '\n[需要操作] 我们对消费者条款和隐私政策的更新已于 2025 年 10 月 8 日生效。您必须运行 `limkenion` 以查看更新后的条款。\n\n',
      )
      await gracefulShutdown(1)
    }
  }
}
