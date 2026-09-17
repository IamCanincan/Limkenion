import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

// 已记忆化：150+ 调用方，其中许多在热点路径上。以 LIMKENION_CONFIG_DIR
// 为键，使改变该环境变量的测试无需显式 cache.clear 也能获得新值。
export const getLimkenionConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.LIMKENION_CONFIG_DIR ?? join(homedir(), '.limkenion')
    ).normalize('NFC')
  },
  () => process.env.LIMKENION_CONFIG_DIR,
)

export function getTeamsDir(): string {
  return join(getLimkenionConfigHomeDir(), 'teams')
}

/**
 * 检查 NODE_OPTIONS 中是否包含某个特定 flag。
 * 按空白拆分并做精确匹配，以免出现误报。
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / LIMKENION_SIMPLE —— 跳过钩子、LSP、插件同步、技能目录遍历、
 * 归属、后台预取以及所有 keychain/凭据读取。
 * 认证严格来自 LIMKENION_API_KEY 环境变量或 --settings 的 apiKeyHelper。
 * 显式 CLI 标志（--plugin-dir、--add-dir、--mcp-config）仍被遵守。
 * 整个代码库约 30 个门。
 *
 * 直接检查 argv（除了环境变量），因为若干门在 main.tsx 的 action
 * handler 从 --bare 设置 LIMKENION_SIMPLE=1 之前运行——特别是
 * main.tsx 顶层调用的 startKeychainPrefetch()。
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.LIMKENION_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * 把环境变量字符串数组解析为键值对象
 * @param envVars KEY=VALUE 格式的字符串数组
 * @returns 含键值对的对象
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // 解析各个环境变量
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `环境变量格式无效：${envStr}，环境变量应按这种方式添加：-e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * 获取 AWS 区域，带默认值回退
 * 与 Limkenion Bedrock SDK 的区域行为一致
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * 获取默认的 Vertex AI 区域
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * 检查 bash 命令是否应保持项目工作目录（每条命令后重置为最初值）
 * @returns 若 LIMKENION_BASH_MAINTAIN_PROJECT_WORKING_DIR 被设为真值时返回 true
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.LIMKENION_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * 检查是否运行在 Homespace（内部构建云环境）
 */
export function isRunningOnHomespace(): boolean {
  return (
    false
  )
}

/**
 * 保守地判断 Limkenion 是否运行在受保护（特权或 ASL3+）的
 * COO 命名空间或集群内。
 *
 * 保守的意思是：当信号不明确时，假定已受保护。我们宁愿多报
 * 受保护使用，也不愿漏报。不受保护的环境是 homespace、开放白名单上的
 * 命名空间，以及完全没有 k8s/COO 信号的环境（笔记本/本地开发）。
 *
 * 用于遥测，测量敏感环境中的自动模式使用情况。
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE 是构建时的 --define'd；在外部构建中此代码块会被 DCE 掉，
  // 因此 require() 和命名空间白名单永远不会出现在 bundle 中。
  
  return false
}

// @[MODEL LAUNCH]: 为新模型添加一个 Vertex 区域覆盖环境变量。
/**
 * 模型前缀 → Vertex 区域覆盖的环境变量。
 * 顺序很重要：更具体的前缀必须放在更不具体的前缀之前
 * （例如 'limkenion-deepseek-v4-pro-4-1' 在 'limkenion-deepseek-v4-pro-4' 之前）。
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['limkenion-haiku-4-5', 'VERTEX_REGION_LIMKENION_HAIKU_4_5'],
  ['limkenion-3-5-haiku', 'VERTEX_REGION_LIMKENION_3_5_HAIKU'],
  ['limkenion-3-5-sonnet', 'VERTEX_REGION_LIMKENION_3_5_SONNET'],
  ['limkenion-3-7-sonnet', 'VERTEX_REGION_LIMKENION_3_7_SONNET'],
  ['limkenion-opus-4-1', 'VERTEX_REGION_LIMKENION_4_1_OPUS'],
  ['limkenion-opus-4', 'VERTEX_REGION_LIMKENION_4_0_OPUS'],
  ['limkenion-sonnet-4-6', 'VERTEX_REGION_LIMKENION_4_6_SONNET'],
  ['limkenion-sonnet-4-5', 'VERTEX_REGION_LIMKENION_4_5_SONNET'],
  ['limkenion-sonnet-4', 'VERTEX_REGION_LIMKENION_4_0_SONNET'],
]

/**
 * 为特定模型获取 Vertex AI 区域。
 * 不同的模型可能在不同区域可用。
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
