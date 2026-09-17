import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  BEDROCK_EXTRA_PARAMS_HEADERS,
  LIMKENION_20250219_BETA_HEADER,
  CLI_INTERNAL_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER,
  TOKEN_EFFICIENT_TOOLS_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
  TOOL_SEARCH_BETA_HEADER_3P,
  WEB_SEARCH_BETA_HEADER,
} from '../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import { isLimkenionAISubscriber } from './auth.js'
import { has1mContext } from './context.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getAPIProvider } from './model/providers.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * 允许用于 API 密钥用户的 SDK 提供的 betas。
 * 只有此列表中的 betas 才能通过 SDK 选项传入。
 */
const ALLOWED_SDK_BETAS = [CONTEXT_1M_BETA_HEADER]

/**
 * 只保留白名单中的 betas。
 * 分别返回允许与不允许的 betas。
 */
function partitionBetasByAllowlist(betas: string[]): {
  allowed: string[]
  disallowed: string[]
} {
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of betas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  return { allowed, disallowed }
}

/**
 * 将 SDK betas 过滤为仅允许的项。
 * 对不允许的 betas 和订阅者限制发出警告。
 * 若无有效 betas 剩余或用户是订阅者，则返回 undefined。
 */
export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }

  if (isLimkenionAISubscriber()) {
    // biome-ignore lint/suspicious/noConsole: intentional warning
    console.warn(
      '警告：自定义 betas 仅适用于 API 密钥用户。已忽略提供的 betas。',
    )
    return undefined
  }

  const { allowed, disallowed } = partitionBetasByAllowlist(sdkBetas)
  for (const beta of disallowed) {
    // biome-ignore lint/suspicious/noConsole: intentional warning
    console.warn(
      `警告：beta 头 '${beta}' 不被允许。仅支持以下 betas：${ALLOWED_SDK_BETAS.join(', ')}`,
    )
  }
  return allowed.length > 0 ? allowed : undefined
}

// 通常 foundry 支持所有 1P 特性；
// 但出于谨慎，我们不会启用任何处于实验后端的特性

export function modelSupportsISP(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(
    model,
    'interleaved_thinking',
  )
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // Foundry 对所有模型都支持交错思考
  if (provider === 'foundry') {
    return true
  }
  if (provider === 'firstParty') {
    return !canonical.includes('limkenion-3-')
  }
  return (
    canonical.includes('limkenion-opus-4') || canonical.includes('limkenion-sonnet-4')
  )
}

function vertexModelSupportsWebSearch(model: string): boolean {
  const canonical = getCanonicalName(model)
  // Vertex 上仅 Limkenion 4.0+ 模型支持网络搜索
  return (
    canonical.includes('limkenion-opus-4') ||
    canonical.includes('limkenion-sonnet-4') ||
    canonical.includes('limkenion-haiku-4')
  )
}

// 上下文管理支持于 Limkenion 4+ 模型
export function modelSupportsContextManagement(model: string): boolean {
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  if (provider === 'foundry') {
    return true
  }
  if (provider === 'firstParty') {
    return !canonical.includes('limkenion-3-')
  }
  return (
    canonical.includes('limkenion-opus-4') ||
    canonical.includes('limkenion-sonnet-4') ||
    canonical.includes('limkenion-haiku-4')
  )
}

// @[MODEL LAUNCH]: 若新模型支持结构化输出，请将其 ID 加入此列表。
export function modelSupportsStructuredOutputs(model: string): boolean {
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 结构化输出仅在 firstParty 和 Foundry 上受支持（Bedrock/Vertex 尚不支持）
  if (provider !== 'firstParty' && provider !== 'foundry') {
    return false
  }
  return (
    canonical.includes('limkenion-sonnet-4-6') ||
    canonical.includes('limkenion-sonnet-4-5') ||
    canonical.includes('limkenion-opus-4-1') ||
    canonical.includes('limkenion-opus-4-5') ||
    canonical.includes('limkenion-opus-4-6') ||
    canonical.includes('limkenion-haiku-4-5')
  )
}

// @[MODEL LAUNCH]: 若新模型支持自动模式（特指 PI 探测），请加入该模型——可在 #proj-limkenion-safety-research 中询问。
export function modelSupportsAutoMode(model: string): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const m = getCanonicalName(model)
    // 外部：启动时仅限 firstParty（PI 探测尚未接入
    // Bedrock/Vertex/Foundry）。在 allowModels 之前检查，使 GB
    // 覆盖无法在不支持的 provider 上启用自动模式。
    if ((getAPIProvider() !== 'firstParty')) {
      return false
    }
    // GrowthBook 覆盖：limkenion_auto_mode_config.allowModels 为列出的模型
    // 强制启用自动模式，绕过下方的拒绝列表/允许列表。
    // 精确模型 ID（例如 "limkenion-strudel-v6-p"）仅匹配该模型；
    // canonical 名称（例如 "limkenion-strudel"）匹配整个家族。
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowModels?: string[]
    }>('limkenion_auto_mode_config', {})
    const rawLower = model.toLowerCase()
    if (
      config?.allowModels?.some(
        am => am.toLowerCase() === rawLower || am.toLowerCase() === m,
      )
    ) {
      return true
    }
    
    // 外部允许列表（firstParty 已在上方检查）。
    return /^limkenion-(opus|sonnet)-4-6/.test(m)
  }
  return false
}

/**
 * 为当前 API provider 获取正确的工具搜索 beta 头。
 * - Limkenion API / Foundry: advanced-tool-use-2025-11-20
 * - Vertex AI / Bedrock: tool-search-tool-2025-10-19
 */
export function getToolSearchBetaHeader(): string {
  const provider = getAPIProvider()
  if (provider === 'vertex' || provider === 'bedrock') {
    return TOOL_SEARCH_BETA_HEADER_3P
  }
  return TOOL_SEARCH_BETA_HEADER_1P
}

/**
 * 检查是否应包含实验性 betas。
 * 这些 betas 仅适用于 firstParty provider，
 * 代理或其他 provider 可能不支持它们。
 */
export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return (
    (getAPIProvider() === 'firstParty' || getAPIProvider() === 'foundry') &&
    !isEnvTruthy(process.env.LIMKENION_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * 全局作用域的提示缓存仅限 firstParty。Foundry 被排除，因为
 * GrowthBook 从未把 Foundry 用户分桶进推送实验——处理数据是
 * 仅限 firstParty 的。
 */
export function shouldUseGlobalCacheScope(): boolean {
  return (
    getAPIProvider() === 'firstParty' &&
    !isEnvTruthy(process.env.LIMKENION_DISABLE_EXPERIMENTAL_BETAS)
  )
}

export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = getCanonicalName(model).includes('haiku')
  const provider = getAPIProvider()
  const includeFirstPartyOnlyBetas = shouldIncludeFirstPartyOnlyBetas()

  if (!isHaiku) {
    betaHeaders.push(LIMKENION_20250219_BETA_HEADER)
    
  }
  if (isLimkenionAISubscriber()) {
    betaHeaders.push(OAUTH_BETA_HEADER)
  }
  if (has1mContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsISP(model)
  ) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // 跳过 API 侧的 deepseek-flash 思考摘要器——摘要仅用于
  // ctrl+o 显示，交互式用户很少打开。API 改为返回
  // redacted_thinking 块；AssistantRedactedThinkingMessage 已把它们
  // 渲染为 stub。SDK / print 模式保留摘要，因为调用方
  // 可能遍历思考内容。用户可通过 settings.json 的
  // showThinkingSummaries 重新选择加入。
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }

  // POC：服务端连接器文本摘要（反蒸馏）。API 在多次工具调用之间
  // 缓存助手文本、生成摘要，并附带签名返回，使后续轮次可恢复原始
  // 内容——与思考块的机制相同。在测量 TTFT/TTLT/容量期间仅限 ant；
  // betas 已流向 limkenion_api_success 用于拆分。
  // 后端独立要求 Capability.LIMKENION_INTERNAL_RESEARCH。
  //
  // USE_CONNECTOR_TEXT_SUMMARIZATION 是三态的：=1 强制开启（即使 GB
  // 关闭也可选择加入），=0 强制关闭（退出一项你已被分桶进 GB 推送），
  // 未设置则交给 GB 决定。
  if (
    SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER &&
    false &&
    includeFirstPartyOnlyBetas &&
    !isEnvDefinedFalsy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) &&
    (isEnvTruthy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) ||
      getFeatureValue_CACHED_MAY_BE_STALE('limkenion_slate_prism', false))
  ) {
    betaHeaders.push(SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER)
  }

  // 为工具清空（ant 选择加入）或思考保留添加上下文管理 beta
  const antOptedIntoToolClearing =
    isEnvTruthy(process.env.USE_API_CONTEXT_MANAGEMENT) &&
    false

  const thinkingPreservationEnabled = modelSupportsContextManagement(model)

  if (
    shouldIncludeFirstPartyOnlyBetas() &&
    (antOptedIntoToolClearing || thinkingPreservationEnabled)
  ) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }
  // 实验启用时添加严格工具使用 beta。
  // 由 includeFirstPartyOnlyBetas 门控：LIMKENION_DISABLE_EXPERIMENTAL_BETAS
  // 已在 api.ts 的关口从工具体中剥离 schema.strict，但这个头此前
  // 绕过了那个开关。伪装成 firstParty 但转发到 Vertex 的代理网关
  // 会用 400 拒绝此头。
  // github.com/deshaw/limkenion-issues/issues/5
  const strictToolsEnabled =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE('limkenion_tool_pear')
  // 3P 默认：false。API 拒绝 strict 与 token 高效工具同时存在
  // （tool_use.py:139），因此它们是互斥的——strict 优先。
  const tokenEfficientToolsEnabled =
    !strictToolsEnabled &&
    getFeatureValue_CACHED_MAY_BE_STALE('limkenion_amber_json_tools', false)
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsStructuredOutputs(model) &&
    strictToolsEnabled
  ) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }
  // JSON tool_use 格式（FC v3）——相比 ANTML 输出 token 约减少 4.5%。
  // 发送 limkenions/limkenion#337072 中加入的 v2 头（2026-03-28），把
  // CC A/B 队列与每周约 920 万的既有 v1 发送者隔离开。在恢复的
  // JsonToolUseOutputParser 浸泡期间仅限 ant。
  

  // 仅向 Vertex Limkenion 4.0+ 模型添加网络搜索 beta
  if (provider === 'vertex' && vertexModelSupportsWebSearch(model)) {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }
  // Foundry 只发布已经支持网络搜索的模型
  if (provider === 'foundry') {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }

  // 始终发送 1P 的 beta 头。没有 scope 字段时该头是空操作。
  if (includeFirstPartyOnlyBetas) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // 若设置了 LIMKENION_BETAS，按逗号拆分并添加到 betaHeaders。
  // 这是显式的用户选择加入，所以不依赖模型一律遵守。
  if (process.env.LIMKENION_BETAS) {
    betaHeaders.push(
      ...process.env.LIMKENION_BETAS.split(',')
        .map(_ => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
})

export const getModelBetas = memoize((model: string): string[] => {
  const modelBetas = getAllModelBetas(model)
  if (getAPIProvider() === 'bedrock') {
    return modelBetas.filter(b => !BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  }
  return modelBetas
})

export const getBedrockExtraBodyParamsBetas = memoize(
  (model: string): string[] => {
    const modelBetas = getAllModelBetas(model)
    return modelBetas.filter(b => BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  },
)

/**
 * 合并 SDK 提供的 betas 与自动检测到的模型 betas。
 * SDK betas 从全局状态读取（由 main.tsx 中的 setSdkBetas 设置）。
 * betas 由 filterAllowedSdkBetas 预先过滤，后者处理
 * 订阅者检查和白名单校验并发出警告。
 *
 * @param options.isAgenticQuery - 为 true 时，确保代理查询所需的 beta 头
 *   存在。对非 deepseek-flash 模型这些已由 getAllModelBetas() 包含；对 deepseek-flash 它们
 *   被排除，因为非代理调用（压缩、分类器、token 估算）不需要它们。
 */
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  // 代理查询始终需要 limkenion 和 cli-internal 的 beta 头。
  // 对非 deepseek-flash 模型它们已在 baseBetas 中；对 deepseek-flash 它们被
  // getAllModelBetas() 排除，因为非代理 deepseek-flash 调用不需要它们。
  if (options?.isAgenticQuery) {
    if (!baseBetas.includes(LIMKENION_20250219_BETA_HEADER)) {
      baseBetas.push(LIMKENION_20250219_BETA_HEADER)
    }
    
  }

  const sdkBetas = getSdkBetas()

  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }

  // 合并 SDK betas，去重（已由 filterAllowedSdkBetas 过滤）
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
  getBedrockExtraBodyParamsBetas.cache?.clear?.()
}
