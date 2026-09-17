import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * 所有 LSP 操作的判别联合体
 * 使用 'operation' 作为判别字段
 */
export const lspToolInputSchema = lazySchema(() => {
  /**
   * 转到定义操作
   * 查找给定位置处符号的定义位置
   */
  const goToDefinitionSchema = z.strictObject({
    operation: z.literal('goToDefinition'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  /**
   * 查找引用操作
   * 查找给定位置处符号的所有引用
   */
  const findReferencesSchema = z.strictObject({
    operation: z.literal('findReferences'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  /**
   * 悬停操作
   * 获取给定位置处符号的悬停信息（文档、类型信息）
   */
  const hoverSchema = z.strictObject({
    operation: z.literal('hover'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  /**
   * 文档符号操作
   * 获取文档中的所有符号（函数、类、变量）
   */
  const documentSymbolSchema = z.strictObject({
    operation: z.literal('documentSymbol'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  /**
   * 工作区符号操作
   * 在整个工作区中搜索符号
   */
  const workspaceSymbolSchema = z.strictObject({
    operation: z.literal('workspaceSymbol'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  /**
   * 转到实现操作
   * 查找接口或抽象方法的实现位置
   */
  const goToImplementationSchema = z.strictObject({
    operation: z.literal('goToImplementation'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  /**
   * 准备调用层级操作
   * 在给定位置准备一个调用层级项（调用层级的第一步）
   */
  const prepareCallHierarchySchema = z.strictObject({
    operation: z.literal('prepareCallHierarchy'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  /**
   * 传入调用操作
   * 查找调用给定位置处函数/方法的所有函数/方法
   */
  const incomingCallsSchema = z.strictObject({
    operation: z.literal('incomingCalls'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  /**
   * 传出调用操作
   * 查找由给定位置处函数/方法调用的所有函数/方法
   */
  const outgoingCallsSchema = z.strictObject({
    operation: z.literal('outgoingCalls'),
    filePath: z.string().describe('文件的绝对或相对路径'),
    line: z
      .number()
      .int()
      .positive()
      .describe('行号（从 1 开始，与编辑器中显示一致）'),
    character: z
      .number()
      .int()
      .positive()
      .describe('字符偏移量（从 1 开始，与编辑器中显示一致）'),
  })

  return z.discriminatedUnion('operation', [
    goToDefinitionSchema,
    findReferencesSchema,
    hoverSchema,
    documentSymbolSchema,
    workspaceSymbolSchema,
    goToImplementationSchema,
    prepareCallHierarchySchema,
    incomingCallsSchema,
    outgoingCallsSchema,
  ])
})

/**
 * LSPTool 输入的 TypeScript 类型
 */
export type LSPToolInput = z.infer<ReturnType<typeof lspToolInputSchema>>

