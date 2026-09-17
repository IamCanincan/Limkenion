/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  clearAuthRelatedCaches,
  performLogout,
} from '../../commands/logout/logout.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  getLimkenionApiKeyWithSource,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isUsing3PServices,
} from '../../utils/auth.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { jsonStringify } from '../../utils/slowOperations.js'

/**
 * Limkenion 是纯本地工具，无远程账号/OAuth。登录即设置
 * DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量即可，无需浏览器登录。
 */
export async function authLogin(_opts: {
  email?: string
  sso?: boolean
  console?: boolean
  limkenionai?: boolean
}): Promise<void> {
  logEvent('limkenion_oauth_flow_start', {})
  process.stdout.write(
    'Limkenion 无需账号登录。请设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY ' +
      '环境变量后使用（默认端点 https://api.deepseek.com）。\n',
  )
  await clearAuthRelatedCaches()
  process.stdout.write('登录成功。\n')
  process.exit(0)
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const { source: apiKeySource } = getLimkenionApiKeyWithSource()
  const hasApiKeyEnvVar =
    !!process.env.LIMKENION_API_KEY && !isRunningOnHomespace()
  const oauthAccount = getOauthAccountInfo()
  const subscriptionType = getSubscriptionType()
  const using3P = isUsing3PServices()
  const loggedIn =
    hasToken || apiKeySource !== 'none' || hasApiKeyEnvVar || using3P

  // Determine auth method
  let authMethod: string = 'none'
  if (using3P) {
    authMethod = 'third_party'
  } else if (authTokenSource === 'limkenion.ai') {
    authMethod = 'limkenion.ai'
  } else if (authTokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (authTokenSource !== 'none') {
    authMethod = 'oauth_token'
  } else if (apiKeySource === 'LIMKENION_API_KEY' || hasApiKeyEnvVar) {
    authMethod = 'api_key'
  } else if (apiKeySource === '/login managed key') {
    authMethod = 'limkenion.ai'
  }

  if (opts.text) {
    if (hasApiKeyEnvVar) {
      process.stdout.write('API key: LIMKENION_API_KEY\n')
    }
    if (!loggedIn) {
      process.stdout.write(
        '未登录。请设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 环境变量。\n',
      )
    }
  } else {
    const apiProvider = getAPIProvider()
    const resolvedApiKeySource =
      apiKeySource !== 'none'
        ? apiKeySource
        : hasApiKeyEnvVar
          ? 'LIMKENION_API_KEY'
          : null
    const output: Record<string, string | boolean | null> = {
      loggedIn,
      authMethod,
      apiProvider,
    }
    if (resolvedApiKeySource) {
      output.apiKeySource = resolvedApiKeySource
    }
    if (oauthAccount) {
      output.email = oauthAccount.emailAddress ?? null
      output.orgId = oauthAccount.organizationUuid ?? null
      output.subscriptionType = subscriptionType ?? null
    }

    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }
  process.exit(loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  try {
    await performLogout({ clearOnboarding: false })
  } catch {
    process.stderr.write('退出登录失败。\n')
    process.exit(1)
  }
  process.stdout.write('已成功退出你的 Limkenion 账户。\n')
  process.exit(0)
}
