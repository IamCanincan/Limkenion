import { randomBytes, type UUID } from 'crypto'
import type { AgentId } from 'src/types/ids.js'

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 校验 uuid
 * @param maybeUUID 要检查是否为 uuid 的值
 * @returns 若有效则返回 UUID 字符串，否则返回 null
 */
export function validateUuid(maybeUuid: unknown): UUID | null {
  // UUID 格式：8-4-4-4-12 十六进制数字
  if (typeof maybeUuid !== 'string') return null

  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

/**
 * 生成带前缀的新的智能体 ID，与任务 ID 保持一致。
 * 格式：a{label-}{16 个十六进制字符}
 * 例如：aa3f2c1b4d5e6f7a8、acompact-a3f2c1b4d5e6f7a8
 */
export function createAgentId(label?: string): AgentId {
  const suffix = randomBytes(8).toString('hex')
  return (label ? `a${label}-${suffix}` : `a${suffix}`) as AgentId
}
