import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import {
  getLimkenionApiKey,
  getLimkenionAIOAuthTokens,
  hasProfileScope,
} from 'src/utils/auth.js'
import { z } from 'zod'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getLimkenionUserAgent } from '../../utils/userAgent.js'

const bootstrapResponseSchema = lazySchema(() =>
  z.object({
    client_data: z.record(z.unknown()).nullish(),
    additional_model_options: z
      .array(
        z
          .object({
            model: z.string(),
            name: z.string(),
            description: z.string(),
          })
          .transform(({ model, name, description }) => ({
            value: model,
            label: name,
            description,
          })),
      )
      .nullish(),
  }),
)

type BootstrapResponse = z.infer<ReturnType<typeof bootstrapResponseSchema>>

async function fetchBootstrapAPI(): Promise<BootstrapResponse | null> {
  if (isEssentialTrafficOnly()) {
    logForDebugging('[Bootstrap] 已跳过：非必要流量已禁用')
    return null
  }

  if (getAPIProvider() !== 'firstParty') {
    logForDebugging('[Bootstrap] 已跳过：第三方 provider')
    return null
  }

  // 优先使用 OAuth（需要 user:profile scope——service-key OAuth token
  // 缺少该 scope 会得到 403）。控制台用户回退到 API key 认证。
  const apiKey = getLimkenionApiKey()
  const hasUsableOAuth =
    getLimkenionAIOAuthTokens()?.accessToken && hasProfileScope()
  if (!hasUsableOAuth && !apiKey) {
    logForDebugging('[Bootstrap] 已跳过：无可用 OAuth 或 API key')
    return null
  }

  const endpoint = `${getOauthConfig().BASE_API_URL}/api/limkenion_cli/bootstrap`

  // withOAuth401Retry 负责刷新并重试。API key 用户在 401 时
  // 直接失败（无刷新机制——没有可传入的 OAuth token）。
  try {
    return await withOAuth401Retry(async () => {
      // 每次调用都重新读取 OAuth，以便重试拿到刷新后的 token。
      const token = getLimkenionAIOAuthTokens()?.accessToken
      let authHeaders: Record<string, string>
      if (token && hasProfileScope()) {
        authHeaders = {
          Authorization: `Bearer ${token}`,
          'limkenion-beta': OAUTH_BETA_HEADER,
        }
      } else if (apiKey) {
        authHeaders = { 'x-api-key': apiKey }
      } else {
        logForDebugging('[Bootstrap] 重试时没有可用认证，正在中止')
        return null
      }

      logForDebugging('[Bootstrap] 正在获取')
      const response = await axios.get<unknown>(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getLimkenionUserAgent(),
          ...authHeaders,
        },
        timeout: 5000,
      })
      const parsed = bootstrapResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        logForDebugging(
          `[Bootstrap] 响应未通过校验：${parsed.error.message}`,
        )
        return null
      }
      logForDebugging('[Bootstrap] 获取成功')
      return parsed.data
    })
  } catch (error) {
    logForDebugging(
      `[Bootstrap] 获取失败：${axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'}`,
    )
    throw error
  }
}

/**
 * 从 API 获取 bootstrap 数据并持久化到磁盘缓存。
 */
export async function fetchBootstrapData(): Promise<void> {
  try {
    const response = await fetchBootstrapAPI()
    if (!response) return

    const clientData = response.client_data ?? null
    const additionalModelOptions = response.additional_model_options ?? []

    // 仅当数据确实发生变化时才持久化——避免每次启动都写配置。
    const config = getGlobalConfig()
    if (
      isEqual(config.clientDataCache, clientData) &&
      isEqual(config.additionalModelOptionsCache, additionalModelOptions)
    ) {
      logForDebugging('[Bootstrap] 缓存未变化，跳过写入')
      return
    }

    logForDebugging('[Bootstrap] 缓存已更新，正在持久化到磁盘')
    saveGlobalConfig(current => ({
      ...current,
      clientDataCache: clientData,
      additionalModelOptionsCache: additionalModelOptions,
    }))
  } catch (error) {
    logError(error)
  }
}
