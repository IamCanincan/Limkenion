import { logForDebugging } from './debug.js'

/** AWS 短期凭据格式。 */
export type AwsCredentials = {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  Expiration?: string
}

/** 来自 `aws sts get-session-token` 或 `aws sts assume-role` 的输出。 */
export type AwsStsOutput = {
  Credentials: AwsCredentials
}

type AwsError = {
  name: string
}

export function isAwsCredentialsProviderError(err: unknown) {
  return (err as AwsError | undefined)?.name === 'CredentialsProviderError'
}

/** 校验 AWS STS assume-role 输出的类型守卫 */
export function isValidAwsStsOutput(obj: unknown): obj is AwsStsOutput {
  if (!obj || typeof obj !== 'object') {
    return false
  }

  const output = obj as Record<string, unknown>

  // 检查 Credentials 是否存在并具有必需字段
  if (!output.Credentials || typeof output.Credentials !== 'object') {
    return false
  }

  const credentials = output.Credentials as Record<string, unknown>

  return (
    typeof credentials.AccessKeyId === 'string' &&
    typeof credentials.SecretAccessKey === 'string' &&
    typeof credentials.SessionToken === 'string' &&
    credentials.AccessKeyId.length > 0 &&
    credentials.SecretAccessKey.length > 0 &&
    credentials.SessionToken.length > 0
  )
}

/** 若无法获取 STS 调用者身份则抛出异常。 */
export async function checkStsCallerIdentity(): Promise<void> {
  const { STSClient, GetCallerIdentityCommand } = await import(
    '@aws-sdk/client-sts'
  )
  await new STSClient().send(new GetCallerIdentityCommand({}))
}

/**
 * 通过强制刷新清除 AWS 凭据提供方缓存
 * 确保对 ~/.aws/credentials 的任何更改立即生效
 */
export async function clearAwsIniCache(): Promise<void> {
  try {
    logForDebugging('清除 AWS 凭据提供方缓存')
    const { fromIni } = await import('@aws-sdk/credential-providers')
    const iniProvider = fromIni({ ignoreCache: true })
    await iniProvider() // 这会更新全局文件缓存
    logForDebugging('AWS 凭据提供方缓存已刷新')
  } catch (_error) {
    // 忽略错误——我们只是在清除缓存
    logForDebugging(
      '清除 AWS 凭据缓存失败（若未配置任何凭据则这是预期行为）',
    )
  }
}
