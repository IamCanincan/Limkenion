import { Ajv } from 'ajv'
import { z } from 'zod/v4'
import type { Tool, ToolInputJSONSchema } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// 允许任意输入对象，因为 schema 是动态提供的
const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.string().describe('结构化输出的工具结果'),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'

export function isSyntheticOutputToolEnabled(opts: {
  isNonInteractiveSession: boolean
}): boolean {
  return opts.isNonInteractiveSession
}

export const SyntheticOutputTool = buildTool({
  isMcp: false,
  isEnabled() {
    // 仅在满足条件时才创建该工具（见 main.tsx，其中
    // isSyntheticOutputToolEnabled() 控制工具创建）。一旦创建，就始终启用。
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isOpenWorld() {
    return false
  },
  name: SYNTHETIC_OUTPUT_TOOL_NAME,
  searchHint: 'return the final response as structured JSON',
  maxResultSizeChars: 100_000,
  async description(): Promise<string> {
    return 'Return structured output in the requested format'
  },
  async prompt(): Promise<string> {
    return `Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input) {
    // 该工具只做校验，并将输入作为结构化输出返回
    return {
      data: 'Structured output provided successfully',
      structured_output: input,
    }
  },
  async checkPermissions(input): Promise<PermissionResult> {
    // 始终允许该工具 - 它只是返回数据
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  },
  // 最小化的 UI 实现 - 该工具用于非交互式 SDK/CLI 场景
  renderToolUseMessage(input: Record<string, unknown>) {
    const keys = Object.keys(input)
    if (keys.length === 0) return null
    if (keys.length <= 3) {
      return keys.map(k => `${k}: ${jsonStringify(input[k])}`).join(', ')
    }
    return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}…`
  },
  renderToolUseRejectedMessage() {
    return 'Structured output rejected'
  },
  renderToolUseErrorMessage() {
    return 'Structured output error'
  },
  renderToolUseProgressMessage() {
    return null
  },
  renderToolResultMessage(output: string) {
    return output
  },
  mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

type CreateResult = { tool: Tool<InputSchema> } | { error: string }

// 工作流脚本每次运行会以同一个 schema 对象引用调用
// agent({schema: BUGS_SCHEMA}) 30-80 次。若不缓存，每次调用都要
// new Ajv() + validateSchema() + compile()（约 1.4ms 的 JIT 代码生成）。按引用
// 缓存可将 80 次调用的工作流从约 110ms 降到约 4ms 的 Ajv 开销。
const toolCache = new WeakMap<object, CreateResult>()

/**
 * 创建使用给定 JSON schema 配置的 SyntheticOutputTool。
 * 成功时返回 {tool}，schema 无效时返回 {error} 并附带 Ajv 的诊断信息
 * （例如 "data/properties/bugs should be object"）。
 */
export function createSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  const cached = toolCache.get(jsonSchema)
  if (cached) return cached

  const result = buildSyntheticOutputTool(jsonSchema)
  toolCache.set(jsonSchema, result)
  return result
}

function buildSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  try {
    const ajv = new Ajv({ allErrors: true })
    const isValidSchema = ajv.validateSchema(jsonSchema)
    if (!isValidSchema) {
      return { error: ajv.errorsText(ajv.errors) }
    }
    const validateSchema = ajv.compile(jsonSchema)

    return {
      tool: {
        ...SyntheticOutputTool,
        inputJSONSchema: jsonSchema as ToolInputJSONSchema,
        async call(input) {
          const isValid = validateSchema(input)
          if (!isValid) {
            const errors = validateSchema.errors
              ?.map(e => `${e.instancePath || 'root'}: ${e.message}`)
              .join(', ')
            throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `Output does not match required schema: ${errors}`,
              `StructuredOutput schema mismatch: ${(errors ?? '').slice(0, 150)}`,
            )
          }
          return {
            data: 'Structured output provided successfully',
            structured_output: input,
          }
        },
      },
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
