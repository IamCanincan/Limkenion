import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import { fetchEnvironments } from '../../utils/teleport/environments.js'

const CCR_BYOC_BETA_HEADER = 'ccr-byoc-2025-07-29'

/**
 * 包装原始 GitHub token，使其字符串表示被脱敏。
 * `String(token)`、模板字面量、`JSON.stringify(token)` 以及任何
 * 附带的消息中都会显示 `[REDACTED:gh-token]`，而不是
 * token 的真实值。仅在把原始值放入 HTTP 请求体的那一处
 * 调用 `.reveal()`。
 */
export class RedactedGithubToken {
  readonly #value: string
  constructor(raw: string) {
    this.#value = raw
  }
  reveal(): string {
    return this.#value
  }
  toString(): string {
    return '[REDACTED:gh-token]'
  }
  toJSON(): string {
    return '[REDACTED:gh-token]'
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED:gh-token]'
  }
}

export type ImportTokenResult = {
  github_username: string
}

export type ImportTokenError =
  | { kind: 'not_signed_in' }
  | { kind: 'invalid_token' }
  | { kind: 'server'; status: number }
  | { kind: 'network' }

/**
 * 将 GitHub token POST 到 CCR 后端，后端会用 GitHub 的 /user
 * 端点校验它，并以 Fernet 加密形式存入 sync_user_tokens。
 * 存储后的 token 满足与 OAuth token 相同的读取路径，因此
 * 成功后 limkenion.ai/code 中的 clone/push 可立即使用。
 */
export async function importGithubToken(
  token: RedactedGithubToken,
): Promise<
  | { ok: true; result: ImportTokenResult }
  | { ok: false; error: ImportTokenError }
> {
  let accessToken: string, orgUUID: string
  try {
    ;({ accessToken, orgUUID } = await prepareApiRequest())
  } catch {
    return { ok: false, error: { kind: 'not_signed_in' } }
  }

  const url = `${getOauthConfig().BASE_API_URL}/v1/code/github/import-token`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'limkenion-beta': CCR_BYOC_BETA_HEADER,
    'x-organization-uuid': orgUUID,
  }

  try {
    const response = await axios.post<ImportTokenResult>(
      url,
      { token: token.reveal() },
      { headers, timeout: 15000, validateStatus: () => true },
    )
    if (response.status === 200) {
      return { ok: true, result: response.data }
    }
    if (response.status === 400) {
      return { ok: false, error: { kind: 'invalid_token' } }
    }
    if (response.status === 401) {
      return { ok: false, error: { kind: 'not_signed_in' } }
    }
    logForDebugging(`import-token returned ${response.status}`, {
      level: 'error',
    })
    return { ok: false, error: { kind: 'server', status: response.status } }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      // err.config.data 会包含带有原始 token 的 POST 请求体。
      // 不要把它写进任何日志。仅错误码就足够了。
      logForDebugging(`import-token network error: ${err.code ?? 'unknown'}`, {
        level: 'error',
      })
    }
    return { ok: false, error: { kind: 'network' } }
  }
}

async function hasExistingEnvironment(): Promise<boolean> {
  try {
    const envs = await fetchEnvironments()
    return envs.length > 0
  } catch {
    return false
  }
}

/**
 * 尽力而为地创建默认环境。与 web 端引导流程的
 * DEFAULT_CLOUD_ENVIRONMENT_REQUEST 保持一致，让首次使用的用户
 * 直接进入 composer 而不是 env-setup。会先检查是否已有环境，
 * 避免重复运行 /web-setup 时堆积重复项。失败不致命 ——
 * token 导入已经成功，且 web 状态机在下次加载时会
 * 降级到 env-setup。
 */
export async function createDefaultEnvironment(): Promise<boolean> {
  let accessToken: string, orgUUID: string
  try {
    ;({ accessToken, orgUUID } = await prepareApiRequest())
  } catch {
    return false
  }

  if (await hasExistingEnvironment()) {
    return true
  }

  // /private/organizations/{org}/ 路径会拒绝 CLI OAuth token（auth
  // 依赖不对）。公开路径使用 build_flexible_auth —— 与
  // fetchEnvironments() 使用的路径相同。org 通过 x-organization-uuid 请求头传递。
  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers/cloud/create`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  try {
    const response = await axios.post(
      url,
      {
        name: 'Default',
        kind: 'limkenion_cloud',
        description: '默认 - 受信任的网络访问',
        config: {
          environment_type: 'limkenion',
          cwd: '/home/user',
          init_script: null,
          environment: {},
          languages: [
            { name: 'python', version: '3.11' },
            { name: 'node', version: '20' },
          ],
          network_config: {
            allowed_hosts: [],
            allow_default_hosts: true,
          },
        },
      },
      { headers, timeout: 15000, validateStatus: () => true },
    )
    return response.status >= 200 && response.status < 300
  } catch {
    return false
  }
}

/** 当用户拥有有效的 Limkenion OAuth 凭据时返回 true。 */
export async function isSignedIn(): Promise<boolean> {
  try {
    await prepareApiRequest()
    return true
  } catch {
    return false
  }
}

export function getCodeWebUrl(): string {
  return `${getOauthConfig().LIMKENION_AI_ORIGIN}/code`
}
