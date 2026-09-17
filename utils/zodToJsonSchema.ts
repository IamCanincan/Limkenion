/**
 * 使用原生的 toJSONSchema 将 Zod v4 schema 转换为 JSON Schema。
 */

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export type JsonSchema7Type = Record<string, unknown>

// toolToAPISchema() 会在每个 API 请求时为每个工具运行该转换（每个回合约
// 60-250 次）。工具 schema 用 lazySchema() 包裹，保证每个会话里是同一个
// ZodTypeAny 引用，因此可以按标识进行缓存。
const cache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

/**
 * 将 Zod v4 schema 转换为 JSON Schema 格式。
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  const result = toJSONSchema(schema) as JsonSchema7Type
  cache.set(schema, result)
  return result
}
