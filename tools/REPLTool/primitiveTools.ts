import type { Tool } from '../../Tool.js'
import { AgentTool } from '../AgentTool/AgentTool.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { NotebookEditTool } from '../NotebookEditTool/NotebookEditTool.js'

let _primitiveTools: readonly Tool[] | undefined

/**
 * 当 REPL 模式开启时，从模型的直接使用中隐藏的原始工具
 * （REPL_ONLY_TOOLS），但在 REPL VM 上下文内部仍可访问。
 * 之所以导出，是为了让展示侧代码（collapseReadSearch、渲染器）能够
 * 为这些工具分类/渲染虚拟消息，即使它们
 * 不在过滤后的执行工具列表中。
 *
 * 惰性 getter —— 导入链 collapseReadSearch.ts → primitiveTools.ts
 * → FileReadTool.tsx → ... 会回环经过工具注册表，因此
 * 顶层 const 会触发 "Cannot access before initialization"。推迟到
 * 调用时求值可避免 TDZ。
 *
 * 直接引用而非通过 getAllBaseTools()，因为当 hasEmbeddedSearchTools() 为 true 时，
 * 后者会排除 Glob/Grep。
 */
export function getReplPrimitiveTools(): readonly Tool[] {
  return (_primitiveTools ??= [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    BashTool,
    NotebookEditTool,
    AgentTool,
  ])
}
