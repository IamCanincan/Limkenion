import { readFile } from 'fs/promises'
import { join } from 'path'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import { getLimkenionConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode, toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'

const MAX_SECTION_LENGTH = 2000
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000

export const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_给本次会话取一个简短、独特、5-10 个词的描述性标题。信息密度要高，不要废话_

# Current State
_当前正在积极推进的事项是什么？尚未完成的待办任务。下一步要做什么。_

# Task specification
_用户要求构建什么？有哪些设计决策或其他解释性上下文_

# Files and Functions
_哪些是重要文件？简而言之，它们包含什么、为什么与本次工作相关？_

# Workflow
_通常会运行哪些 bash 命令、按什么顺序运行？如果输出不明显，如何解读？_

# Errors & Corrections
_遇到过的错误及其修复方式。用户纠正过什么？哪些做法失败了、不应再尝试？_

# Codebase and System Documentation
_哪些是重要的系统组件？它们如何运作、如何组合在一起？_

# Learnings
_什么做得好？什么做得不好？要避免什么？不要与其他章节重复条目_

# Key results
_如果用户想要某个具体输出（如问题的答案、表格或其他文档），请在此处完整复述确切结果_

# Worklog
_逐步记录尝试了什么、做了什么。每个步骤用极简的总结_
`

function getDefaultUpdatePrompt(): string {
  return `重要：这条消息和这些指令不属于真实用户对话的一部分。不要在笔记内容中提及任何与“记笔记”“会话笔记提取”或这些更新指令相关的内容。

基于上方用户对话（排除这条记笔记指令消息，以及系统提示、limkenion.md 条目或任何过往会话摘要）来更新会话笔记文件。

文件 {{notesPath}} 已为你读取。以下是它的当前内容：
<current_notes_content>
{{currentNotes}}
</current_notes_content>

你的唯一任务：用 Edit 工具更新笔记文件，然后停止。你可以多次编辑（按需更新每个章节）——请在一条消息里并行发出所有 Edit 调用。不要调用任何其他工具。

编辑的关键规则：
- 文件必须保持准确的结构，所有章节、标题与斜体描述都原样保留
-- 绝不修改、删除或新增章节标题（以 '#' 开头的行，如 # Task specification）
-- 绝不修改或删除斜体的 _章节描述_ 行（即紧跟在每个标题后的斜体行——它们以和下划线开头和结尾）
-- 斜体的 _章节描述_ 是模板指令，必须原样保留——它们指示每个章节该放什么内容
-- 只更新每个既有章节中位于斜体 _章节描述_ 下方的实际内容
-- 不要在既有结构之外添加任何新章节、摘要或信息
- 不要在笔记中任何地方引用这个记笔记过程或这些指令
- 如果一个章节没有实质性的新洞见可补充，跳过更新也是可以的。不要添加“暂无信息”之类的填充内容，合适的话保持章节留空/不更新即可。
- 为每个章节写出**详细、信息密集**的内容——包括诸如文件路径、函数名、错误信息、确切命令、技术细节等具体内容
- 对“Key results”，请完整给出用户请求的确切输出（例如完整的表格、完整的答案等）
- 不要包含上下文里已有的 LIMKENION.md 文件中的信息
- 让每个章节保持在约 ${MAX_SECTION_LENGTH} 个 token/词以内——如果某章节接近此上限，就通过剔除不太重要的细节来浓缩它，同时保留最关键的信息
- 聚焦可落地、具体的信息，这些信息应能帮助别人理解或复现对话中讨论的工作
- 重要：始终更新 “Current State” 以反映最近的工作——这对压缩之后的连续性至关重要

使用 file_path: {{notesPath}} 的 Edit 工具

结构保留提醒：
每个章节有两部分必须按当前文件中的原样保留：
1. 章节标题（以 # 开头的行）
2. 斜体描述行（紧跟标题后的 _斜体文本_ ——这是一条模板指令）

你只更新在这两行保留内容之后出现的实际内容。以和为下划线开头结尾的斜体描述行属于模板结构的一部分，而不是要被编辑或移除的内容。

记住：并行使用 Edit 工具然后停止。编辑后不要继续。只能纳入来自真实用户对话的洞见，绝不能来自这些记笔记指令。不要删除或修改章节标题或斜体的 _章节描述_。`
}

/**
 * 若存在自定义会话记忆模板文件则加载之
 */
export async function loadSessionMemoryTemplate(): Promise<string> {
  const templatePath = join(
    getLimkenionConfigHomeDir(),
    'session-memory',
    'config',
    'template.md',
  )

  try {
    return await readFile(templatePath, { encoding: 'utf-8' })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return DEFAULT_SESSION_MEMORY_TEMPLATE
    }
    logError(toError(e))
    return DEFAULT_SESSION_MEMORY_TEMPLATE
  }
}

/**
 * 若存在自定义会话记忆提示文件则加载之
 * 自定义提示可放在 ~/.limkenion/session-memory/prompt.md
 * 使用 {{variableName}} 语法进行变量替换（如 {{currentNotes}}、{{notesPath}}）
 */
export async function loadSessionMemoryPrompt(): Promise<string> {
  const promptPath = join(
    getLimkenionConfigHomeDir(),
    'session-memory',
    'config',
    'prompt.md',
  )

  try {
    return await readFile(promptPath, { encoding: 'utf-8' })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return getDefaultUpdatePrompt()
    }
    logError(toError(e))
    return getDefaultUpdatePrompt()
  }
}

// 把会话记忆文件切分成章节并分析各章节大小
function analyzeSectionSizes(content: string): Record<string, number> {
  const sections: Record<string, number> = {}
  const lines = content.split('\n')
  let currentSection = ''
  let currentContent: string[] = []

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (currentSection && currentContent.length > 0) {
        const sectionContent = currentContent.join('\n').trim()
        sections[currentSection] = roughTokenCountEstimation(sectionContent)
      }
      currentSection = line
      currentContent = []
    } else {
      currentContent.push(line)
    }
  }

  if (currentSection && currentContent.length > 0) {
    const sectionContent = currentContent.join('\n').trim()
    sections[currentSection] = roughTokenCountEstimation(sectionContent)
  }

  return sections
}

// 为过长的章节生成提醒
function generateSectionReminders(
  sectionSizes: Record<string, number>,
  totalTokens: number,
): string {
  const overBudget = totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS
  const oversizedSections = Object.entries(sectionSizes)
    .filter(([_, tokens]) => tokens > MAX_SECTION_LENGTH)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([section, tokens]) =>
        `- "${section}" 大约有 ~${tokens} 个 token（上限：${MAX_SECTION_LENGTH}）`,
    )

  if (oversizedSections.length === 0 && !overBudget) {
    return ''
  }

  const parts: string[] = []

  if (overBudget) {
    parts.push(
      `\n\n重要：会话记忆文件目前约 ${totalTokens} 个 token，超过了 ${MAX_TOTAL_SESSION_MEMORY_TOKENS} 的上限。你必须压缩该文件以控制在预算内。激进地精简过大的章节——去掉次要细节、合并相关条目、总结旧条目。优先保证 "Current State" 与 "Errors & Corrections" 的准确和详尽。`,
    )
  }

  if (oversizedSections.length > 0) {
    parts.push(
      `\n\n${overBudget ? '需要压缩的超大章节' : '重要：以下章节超过了单章节上限，必须压缩'}：\n${oversizedSections.join('\n')}`,
    )
  }

  return parts.join('')
}

// 使用 {{variable}} 语法在提示模板中替换变量
function substituteVariables(
  template: string,
  variables: Record<string, string>,
): string {
  // 单次替换避免了两个问题：(1) $ 反向引用损坏（替换函数把 $ 当字面量），
  // (2) 当用户内容恰好包含与后续变量匹配的 {{varName}} 时发生的二次替换。
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]!
      : match,
  )
}

/**
 * 检查会话记忆内容是否基本为空（与模板一致）。
 * 用于检测是否尚未提取出任何实际内容，此时应回退到旧的 compact 行为。
 */
export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  // 加载模板并与内容比较，判断其是否仍为空的模板
  const template = await loadSessionMemoryTemplate()
  // 通过裁剪后的内容对比来判断它是否只是模板
  return content.trim() === template.trim()
}

export async function buildSessionMemoryUpdatePrompt(
  currentNotes: string,
  notesPath: string,
): Promise<string> {
  const promptTemplate = await loadSessionMemoryPrompt()

  // Analyze section sizes and generate reminders if needed
  const sectionSizes = analyzeSectionSizes(currentNotes)
  const totalTokens = roughTokenCountEstimation(currentNotes)
  const sectionReminders = generateSectionReminders(sectionSizes, totalTokens)

  // Substitute variables in the prompt
  const variables = {
    currentNotes,
    notesPath,
  }

  const basePrompt = substituteVariables(promptTemplate, variables)

  // Add section size reminders and/or total budget warnings
  return basePrompt + sectionReminders
}

/**
 * 截断超过单章节 token 上限的会话记忆章节。
 * 在把会话记忆插入 compact 消息时使用，防止过大的会话记忆
 * 吃掉整个压缩后的 token 预算。
 *
 * 返回截断后的内容以及是否发生了截断。
 */
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string
  wasTruncated: boolean
} {
  const lines = content.split('\n')
  const maxCharsPerSection = MAX_SECTION_LENGTH * 4 // roughTokenCountEstimation uses length/4
  const outputLines: string[] = []
  let currentSectionLines: string[] = []
  let currentSectionHeader = ''
  let wasTruncated = false

  for (const line of lines) {
    if (line.startsWith('# ')) {
      const result = flushSessionSection(
        currentSectionHeader,
        currentSectionLines,
        maxCharsPerSection,
      )
      outputLines.push(...result.lines)
      wasTruncated = wasTruncated || result.wasTruncated
      currentSectionHeader = line
      currentSectionLines = []
    } else {
      currentSectionLines.push(line)
    }
  }

  // 冲刷最后一个章节
  const result = flushSessionSection(
    currentSectionHeader,
    currentSectionLines,
    maxCharsPerSection,
  )
  outputLines.push(...result.lines)
  wasTruncated = wasTruncated || result.wasTruncated

  return {
    truncatedContent: outputLines.join('\n'),
    wasTruncated,
  }
}

function flushSessionSection(
  sectionHeader: string,
  sectionLines: string[],
  maxCharsPerSection: number,
): { lines: string[]; wasTruncated: boolean } {
  if (!sectionHeader) {
    return { lines: sectionLines, wasTruncated: false }
  }

  const sectionContent = sectionLines.join('\n')
  if (sectionContent.length <= maxCharsPerSection) {
    return { lines: [sectionHeader, ...sectionLines], wasTruncated: false }
  }

  // 在章节边界附近按行裁剪
  let charCount = 0
  const keptLines: string[] = [sectionHeader]
  for (const line of sectionLines) {
    if (charCount + line.length + 1 > maxCharsPerSection) {
      break
    }
    keptLines.push(line)
    charCount += line.length + 1
  }
  keptLines.push('\n[... section truncated for length ...]')
  return { lines: keptLines, wasTruncated: true }
}
