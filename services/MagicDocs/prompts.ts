import { join } from 'path'
import { getLimkenionConfigHomeDir } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'

/**
 * 获取 Magic Docs 的更新提示模板
 */
function getUpdatePromptTemplate(): string {
  return `重要：这条消息和这些指令不属于真实用户对话的一部分。不要在文档内容中提及任何与“文档更新”“magic docs”或这些更新指令相关的内容。

基于上方用户对话（排除这条文档更新指令消息）来更新这个 Magic Doc 文件，把值得保留的**新**知识、洞见或信息纳入其中。

文件 {{docPath}} 已为你读取。以下是它的当前内容：
<current_doc_content>
{{docContents}}
</current_doc_content>

文档标题：{{docTitle}}
{{customInstructions}}

你的唯一任务：如果有实质性的新信息要添加，就用 Edit 工具更新这个文档文件，然后停止。你可以多次编辑（按需更新多个章节）——请在一条消息里并行发出所有 Edit 调用。如果没有任何实质性内容要添加，只需用一句话简要说明，不要调用任何工具。

编辑的关键规则：
- 原样保留 Magic Doc 的文档头： # MAGIC DOC: {{docTitle}}
- 如果标题后紧跟一行斜体文字，请原样保留
- 让文档与代码库的最新状态保持同步——这不是变更日志或历史记录
- 就地更新信息以反映当前状态——不要追加历史注释或记录随时间的变化
- 移除或替换过时信息，而不是添加“此前……”或“已更新至……”之类的注释
- 清理或删除不再相关、或与文档用途不符的章节
- 修正明显错误：错别字、语法错误、损坏的排版、错误信息或令人困惑的表述
- 保持文档组织良好：使用清晰的标题、有逻辑的章节顺序、一致的格式与合理的嵌套

文档哲学——请仔细阅读：
- 要**精炼**。只保留高信噪比内容。不要废话或冗余阐述。
- 文档服务于**总览、架构与入口点**——而不是逐行讲解代码
- 不要重复那些读源码就能看出来的明显信息
- 不要记录每个函数、参数或行号引用
- 聚焦：某事物**为什么**存在、各组件**如何**连接、**从哪里**开始阅读、使用了**什么**模式
- 跳过：详尽的实现步骤、面面俱到的 API 文档、流水账式叙事

应当记录的内容：
- 高层架构与系统设计
- 不明显的模式、约定或坑
- 关键入口点以及从哪里开始阅读代码
- 重要的设计决策及其理由
- 关键依赖或集成点
- 指向相关文件、文档或代码的引用（类似 wiki）——帮助读者导航到相关上下文

不应记录的内容：
- 任何读代码就能看出的内容
- 面面俱到的文件、函数或参数清单
- 一步步的实现细节
- 底层代码机制
- 已经写在 LIMKENION.md 或其他项目文档里的信息

使用 file_path: {{docPath}} 的 Edit 工具。

记住：只有存在实质性新信息时才更新。Magic Doc 的文档头（# MAGIC DOC: {{docTitle}}）必须保持不变。`
}

/**
 * 如果存在，则从文件加载自定义 Magic Docs 提示
 * 自定义提示可放在 ~/.limkenion/magic-docs/prompt.md
 * 使用 {{variableName}} 语法进行变量替换（例如 {{docContents}}、{{docPath}}、{{docTitle}}）
 */
async function loadMagicDocsPrompt(): Promise<string> {
  const fs = getFsImplementation()
  const promptPath = join(getLimkenionConfigHomeDir(), 'magic-docs', 'prompt.md')

  try {
    return await fs.readFile(promptPath, { encoding: 'utf-8' })
  } catch {
    // 如果自定义提示不存在或加载失败，则静默回退到默认模板
    return getUpdatePromptTemplate()
  }
}

/**
 * 使用 {{variable}} 语法替换提示模板中的变量
 */
function substituteVariables(
  template: string,
  variables: Record<string, string>,
): string {
  // 单趟替换可避免两个问题：(1) $ 反向引用被破坏（替换函数把 $ 当字面量处理），
  // 以及 (2) 当用户内容恰好包含与后一个变量匹配的 {{varName}} 时发生二次替换。
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]!
      : match,
  )
}

/**
 * 构建 Magic Docs 的更新提示并进行变量替换
 */
export async function buildMagicDocsUpdatePrompt(
  docContents: string,
  docPath: string,
  docTitle: string,
  instructions?: string,
): Promise<string> {
  const promptTemplate = await loadMagicDocsPrompt()

  // 如果提供了指令，则构建自定义指令段
  const customInstructions = instructions
    ? `

DOCUMENT-SPECIFIC UPDATE INSTRUCTIONS:
The document author has provided specific instructions for how this file should be updated. Pay extra attention to these instructions and follow them carefully:

"${instructions}"

These instructions take priority over the general rules below. Make sure your updates align with these specific guidelines.`
    : ''

  // 替换提示中的变量
  const variables = {
    docContents,
    docPath,
    docTitle,
    customInstructions,
  }

  return substituteVariables(promptTemplate, variables)
}