import type { BetaTool } from '../types/llm-protocol.js'

// 渲染后的工具 schema 的会话作用域缓存。工具 schema 渲染在服务器位置 2
// （系统提示词之前），因此任何字节级变化都会使整个约 11K token 的工具块
// 以及其后的所有内容全部失效。GrowthBook 门控翻转（limkenion_tool_pear、
// limkenion_fgts）、MCP 重连或 tool.prompt() 中的动态内容都会导致这种
// 波动。按会话记住化可在首次渲染时锁定 schema 字节——会话中途的 GB 刷新
// 不再使缓存失效。
//
// 放在叶子模块中，使 auth.ts 无需导入 api.ts 即可清空它（后者会通过
// plans→settings→file→growthbook→config→bridgeEnabled→auth 产生循环）。
type CachedSchema = BetaTool & {
  strict?: boolean
  eager_input_streaming?: boolean
}

const TOOL_SCHEMA_CACHE = new Map<string, CachedSchema>()

export function getToolSchemaCache(): Map<string, CachedSchema> {
  return TOOL_SCHEMA_CACHE
}

export function clearToolSchemaCache(): void {
  TOOL_SCHEMA_CACHE.clear()
}
