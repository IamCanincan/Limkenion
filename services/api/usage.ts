import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  hasProfileScope,
  isLimkenionAISubscriber,
} from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getLimkenionUserAgent } from '../../utils/userAgent.js'

export type RateLimit = {
  utilization: number | null // 0 到 100 之间的百分比
  resets_at: string | null // ISO 8601 时间戳
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
}

export async function fetchUtilization(): Promise<Utilization | null> {
  if (!isLimkenionAISubscriber() || !hasProfileScope()) {
    return {}
  }

  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`认证错误：${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getLimkenionUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 秒超时
  })

  return response.data
}
