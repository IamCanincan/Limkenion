import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getLimkenionUserAgent } from '../../utils/userAgent.js'

/**
 * 获取用户第一次使用 Limkenion 的 token 日期并存入配置。
 * 在成功登录后调用，用于缓存用户开始使用 Limkenion 的时间。
 */
export async function fetchAndStoreLimkenionFirstTokenDate(): Promise<void> {
  try {
    const config = getGlobalConfig()

    if (config.limkenionFirstTokenDate !== undefined) {
      return
    }

    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      logError(new Error(`获取认证响应头失败：${authHeaders.error}`))
      return
    }

    const oauthConfig = getOauthConfig()
    const url = `${oauthConfig.BASE_API_URL}/api/organization/limkenion_first_token_date`

    const response = await axios.get(url, {
      headers: {
        ...authHeaders.headers,
        'User-Agent': getLimkenionUserAgent(),
      },
      timeout: 10000,
    })

    const firstTokenDate = response.data?.first_token_date ?? null

    // 若不为 null 则校验日期
    if (firstTokenDate !== null) {
      const dateTime = new Date(firstTokenDate).getTime()
      if (isNaN(dateTime)) {
        logError(
          new Error(
            `从 API 收到无效的 first_token_date：${firstTokenDate}`,
          ),
        )
        // 不保存无效日期
        return
      }
    }

    saveGlobalConfig(current => ({
      ...current,
      limkenionFirstTokenDate: firstTokenDate,
    }))
  } catch (error) {
    logError(error)
  }
}
