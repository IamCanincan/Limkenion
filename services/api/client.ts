import Limkenion, { type ClientOptions } from '../../types/llm-protocol.js'
import { randomUUID } from 'crypto'
import type { GoogleAuth } from 'google-auth-library'
import {
  ensureLocalAuthAvailable,
  getLimkenionApiKey,
  getApiKeyFromApiKeyHelper,
  getLimkenionAIOAuthTokens,
  isLimkenionAISubscriber,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import {
  getAPIProvider,
  isFirstPartyLimkenionBaseUrl,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import {
  getAWSRegion,
  getVertexRegionForModel,
  isEnvTruthy,
} from '../../utils/envUtils.js'

/**
 * 不同客户端类型所需的环境变量：
 *
 * 直连 API：
 * - LIMKENION_API_KEY：直连 API 必需的 API key
 *
 * AWS Bedrock：
 * - 通过 aws-sdk 默认值配置 AWS 凭据
 * - AWS_REGION 或 AWS_DEFAULT_REGION：设置所有模型的 AWS 区域（默认：us-east-1）
 * - LIMKENION_SMALL_FAST_MODEL_AWS_REGION：可选。专门为小快模型（deepseek-flash）覆盖 AWS 区域
 *
 * Foundry (Azure)：
 * - LIMKENION_FOUNDRY_RESOURCE：你的 Azure 资源名（例如 'my-resource'）
 *   完整端点：https://{resource}.services.ai.azure.com/limkenion/v1/messages
 * - LIMKENION_FOUNDRY_BASE_URL：可选。资源名的替代——直接提供完整 base URL
 *   （例如 'https://my-resource.services.ai.azure.com'）
 *
 * 认证（以下任一方式）：
 * - LIMKENION_FOUNDRY_API_KEY：你的 Microsoft Foundry API key（若使用 API key 认证）
 * - Azure AD 认证：若未提供 API key，则使用 DefaultAzureCredential，
 *   它支持多种认证方式（环境变量、托管身份、Azure CLI 等）。
 *   参见：https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI：
 * - 模型特定区域变量（最高优先级）：
 *   - VERTEX_REGION_LIMKENION_3_5_HAIKU：deepseek-flash 模型的区域
 *   - VERTEX_REGION_LIMKENION_HAIKU_4_5：Limkenion deepseek-flash 模型的区域
 *   - VERTEX_REGION_LIMKENION_3_5_SONNET：deepseek-flash 模型的区域
 *   - VERTEX_REGION_LIMKENION_3_7_SONNET：deepseek-flash 模型的区域
 * - CLOUD_ML_REGION：可选。所有模型默认使用的 GCP 区域
 *   若上面未指定特定模型区域时
 * - LIMKENION_VERTEX_PROJECT_ID：必需。你的 GCP 项目 ID
 * - 通过 google-auth-library 配置标准 GCP 凭据
 *
 * 决定区域的优先级：
 * 1. 硬编码的模型特定环境变量
 * 2. 全局 CLOUD_ML_REGION 变量
 * 3. 配置中的默认区域
 * 4. 回退区域（us-east5）
 */

function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: 有意的 console 输出——SDK 记录器必须使用 console
      console.error('[Limkenion SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: 有意的 console 输出——SDK 记录器必须使用 console
    warn: (msg, ...args) => console.error('[Limkenion SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: 有意的 console 输出——SDK 记录器必须使用 console
    info: (msg, ...args) => console.error('[Limkenion SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: 有意的 console 输出——SDK 记录器必须使用 console
      console.error('[Limkenion SDK DEBUG]', msg, ...args),
  }
}

export async function getLimkenionClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Limkenion> {
  const containerId = process.env.LIMKENION_CONTAINER_ID
  const remoteSessionId = process.env.LIMKENION_REMOTE_SESSION_ID
  const clientApp = process.env.LIMKENION_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Limkenion-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-limkenion-remote-container-id': containerId } : {}),
    ...(remoteSessionId
      ? { 'x-limkenion-remote-session-id': remoteSessionId }
      : {}),
    // SDK 调用方可标识自己的应用/库，便于后端分析
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // 记录 API 客户端配置，便于 HFI 调试
  logForDebugging(
    `[API:请求] 正在创建客户端，LIMKENION_CUSTOM_HEADERS 是否存在：${!!process.env.LIMKENION_CUSTOM_HEADERS}，是否含 Authorization 请求头：${!!customHeaders['Authorization']}`,
  )

  // 若通过环境变量启用，则添加额外保护请求头
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.LIMKENION_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-limkenion-additional-protection'] = 'true'
  }

  logForDebugging('[API:auth] OAuth token 检查开始')
  await ensureLocalAuthAvailable()
  logForDebugging('[API:auth] OAuth token 检查完成')

  if (!isLimkenionAISubscriber()) {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forLimkenionAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
  if (isEnvTruthy(process.env.LIMKENION_USE_BEDROCK)) {
    const { LimkenionBedrock } = await import('@limkenion-ai/bedrock-sdk')
    // 若指定，则为小快模型使用区域覆盖
    const awsRegion =
      model === getSmallFastModel() &&
      process.env.LIMKENION_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.LIMKENION_SMALL_FAST_MODEL_AWS_REGION
        : getAWSRegion()

    const bedrockArgs: ConstructorParameters<typeof LimkenionBedrock>[0] = {
      ...ARGS,
      awsRegion,
      ...(isEnvTruthy(process.env.LIMKENION_SKIP_BEDROCK_AUTH) && {
        skipAuth: true,
      }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }

    // 若可用，则添加 API key 认证
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      bedrockArgs.skipAuth = true
      // 为 Bedrock API key 认证添加 Bearer token
      bedrockArgs.defaultHeaders = {
        ...bedrockArgs.defaultHeaders,
        Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
      }
    } else if (!isEnvTruthy(process.env.LIMKENION_SKIP_BEDROCK_AUTH)) {
      // 刷新认证并在清空缓存的情况下获取凭据
      const cachedCredentials = await refreshAndGetAwsCredentials()
      if (cachedCredentials) {
        bedrockArgs.awsAccessKey = cachedCredentials.accessKeyId
        bedrockArgs.awsSecretKey = cachedCredentials.secretAccessKey
        bedrockArgs.awsSessionToken = cachedCredentials.sessionToken
      }
    }
    // 我们一直在返回类型上“撒谎”——它并不支持批处理或模型
    return new LimkenionBedrock(bedrockArgs) as unknown as Limkenion
  }
  if (isEnvTruthy(process.env.LIMKENION_USE_FOUNDRY)) {
    const { LimkenionFoundry } = await import('@limkenion-ai/foundry-sdk')
    // 根据配置决定 Azure AD token 提供器
    // SDK 默认读取 LIMKENION_FOUNDRY_API_KEY
    let azureADTokenProvider: (() => Promise<string>) | undefined
    if (!process.env.LIMKENION_FOUNDRY_API_KEY) {
      if (isEnvTruthy(process.env.LIMKENION_SKIP_FOUNDRY_AUTH)) {
        // 用于测试/代理场景的 Mock token 提供器（类似 Vertex 的 Mock GoogleAuth）
        azureADTokenProvider = () => Promise.resolve('')
      } else {
        // 使用 DefaultAzureCredential 进行真正的 Azure AD 认证
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider,
        } = await import('@azure/identity')
        azureADTokenProvider = getBearerTokenProvider(
          new AzureCredential(),
          'https://cognitiveservices.azure.com/.default',
        )
      }
    }

    const foundryArgs: ConstructorParameters<typeof LimkenionFoundry>[0] = {
      ...ARGS,
      ...(azureADTokenProvider && { azureADTokenProvider }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // 我们一直在返回类型上“撒谎”——它并不支持批处理或模型
    return new LimkenionFoundry(foundryArgs) as unknown as Limkenion
  }
  if (isEnvTruthy(process.env.LIMKENION_USE_VERTEX)) {
    // 若配置了 gcpAuthRefresh 且凭据已过期，则刷新 GCP 凭据
    // 这与我们为 Bedrock 处理 AWS 凭据刷新的方式类似
    if (!isEnvTruthy(process.env.LIMKENION_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded()
    }

    const [{ LimkenionVertex }, { GoogleAuth }] = await Promise.all([
      import('@limkenion-ai/vertex-sdk'),
      import('google-auth-library'),
    ])
    // TODO：缓存 GoogleAuth 实例或 AuthClient 以提升性能
    // 目前每次 getLimkenionClient() 调用都会创建一个新的 GoogleAuth 实例
    // 这可能导致重复的认证流程和 metadata 服务器检查
    // 然而，缓存需要小心处理：
    // - 凭据刷新/过期
    // - 环境变量变化（GOOGLE_APPLICATION_CREDENTIALS、项目变量）
    // - 跨请求的认证状态管理
    // 缓存挑战参见：https://github.com/googleapis/google-auth-library-nodejs/issues/390

    // 通过提供 projectId 作为回退来防止 metadata 服务器超时
    // google-auth-library 按以下顺序检查项目 ID：
    // 1. 环境变量（GCLOUD_PROJECT、GOOGLE_CLOUD_PROJECT 等）
    // 2. 凭据文件（service account JSON、ADC 文件）
    // 3. gcloud 配置
    // 4. GCE metadata 服务器（在 GCP 之外会导致 12 秒超时）
    //
    // 只有当用户未配置其他发现方式时才设置 projectId，
    // 以免干扰他们现有的认证配置

    // 按与 google-auth-library 相同的顺序检查项目环境变量
    // 参见：https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts
    const hasProjectEnvVar =
      process.env['GCLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['gcloud_project'] ||
      process.env['google_cloud_project']

    // 检查凭据文件路径（service account 或 ADC）
    // 注意：为保险起见，我们同时检查标准写法和小写写法，
    // 不过应当核实 google-auth-library 实际检查了什么
    const hasKeyFile =
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
      process.env['google_application_credentials']

    const googleAuth = isEnvTruthy(process.env.LIMKENION_SKIP_VERTEX_AUTH)
      ? ({
          // 用于测试/代理场景的 Mock GoogleAuth
          getClient: () => ({
            getRequestHeaders: () => ({}),
          }),
        } as unknown as GoogleAuth)
      : new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          // 仅在万不得已时才回退使用 LIMKENION_VERTEX_PROJECT_ID
          // 这在以下情况可防止 12 秒的 metadata 服务器超时：
          // - 未设置项目环境变量 且
          // - 未指定凭据 keyfile 且
          // - ADC 文件存在但缺少 project_id 字段
          //
          // 风险：若认证项目 != API 目标项目，可能导致计费/审计问题
          // 缓解：用户可设置 GOOGLE_CLOUD_PROJECT 来覆盖
          ...(hasProjectEnvVar || hasKeyFile
            ? {}
            : {
                projectId: process.env.LIMKENION_VERTEX_PROJECT_ID,
              }),
        })

    const vertexArgs: ConstructorParameters<typeof LimkenionVertex>[0] = {
      ...ARGS,
      region: getVertexRegionForModel(model),
      googleAuth,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // 我们一直在返回类型上“撒谎”——它并不支持批处理或模型
    return new LimkenionVertex(vertexArgs) as unknown as Limkenion
  }

  // 根据可用的 token 决定认证方式
  const clientConfig: ConstructorParameters<typeof Limkenion>[0] = {
    apiKey: isLimkenionAISubscriber() ? null : apiKey || getLimkenionApiKey(),
    authToken: isLimkenionAISubscriber()
      ? getLimkenionAIOAuthTokens()?.accessToken
      : undefined,
    // 使用 staging OAuth 时从 OAuth 配置设置 baseURL
    ...(({})),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new Limkenion(clientConfig)
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.LIMKENION_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.LIMKENION_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // 按换行拆分以支持多个请求头
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // 解析 "Name: Value"（curl 风格）格式的请求头。在第一个 `:` 处拆分，
    // 然后去除两端空白——避免在格式错误的超长请求头上发生正则回溯。
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // 仅发送到第一方 API——Bedrock/Vertex/Foundry 不记录它，
  // 且未知请求头有被严格代理拒绝的风险（inc-4029 类）。
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyLimkenionBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // 生成客户端请求 ID，使超时请求（不会返回服务器请求 ID）
    // 仍能与 API 团队记录的服务器日志关联。
    // 想自行跟踪该 ID 的调用方可预先设置此请求头。
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API 请求] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // 绝不让日志导致 fetch 崩溃
    }
    return inner(input, { ...init, headers })
  }
}
