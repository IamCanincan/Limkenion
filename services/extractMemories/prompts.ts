/**
 * 后台记忆提取 agent 的提示模板。
 *
 * 提取 agent 以主对话的一个完美 fork 形式运行——系统提示相同、消息前缀相同。
 * 主 agent 的系统提示始终包含完整的保存指令；当主 agent 自行写入记忆时，
 * extractMemories.ts 会跳过那一轮（hasMemoryWritesSince）。本提示仅在主 agent
 * 没有写入时触发，因此这里的保存标准与系统提示的重叠是无害的。
 */

import { feature } from 'bun:bundle'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from '../../memdir/memoryTypes.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'

/**
 * 两个提取提示变体共享的开头段落。
 */
function opener(newMessageCount: number, existingMemories: string): string {
  const manifest =
    existingMemories.length > 0
      ? `\n\n## 现有的记忆文件\n\n${existingMemories}\n\n在写作之前先检查这份清单——尽量更新已有文件，而不是创建重复文件。`
      : ''
  return [
    `你现在扮演记忆提取子代理。分析上面最近的约 ${newMessageCount} 条消息，并用它们更新你的持久记忆系统。`,
    '',
    `可用工具：${FILE_READ_TOOL_NAME}、${GREP_TOOL_NAME}、${GLOB_TOOL_NAME}、只读的 ${BASH_TOOL_NAME}（ls/find/cat/stat/wc/head/tail 等），以及仅限记忆目录内路径使用的 ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME}。不允许使用 ${BASH_TOOL_NAME} rm。所有其他工具——MCP、Agent、可写入的 ${BASH_TOOL_NAME} 等——都会被拒绝。`,
    '',
    `你的轮次预算有限。${FILE_EDIT_TOOL_NAME} 需要先对同一文件进行 ${FILE_READ_TOOL_NAME}，因此高效的做法是：第 1 轮——对每一个你可能更新的文件并行发起所有 ${FILE_READ_TOOL_NAME} 调用；第 2 轮——并行发起所有 ${FILE_WRITE_TOOL_NAME}/${FILE_EDIT_TOOL_NAME} 调用。不要在多个轮次中来回穿插读取与写入。`,
    '',
    `你只能使用最近约 ${newMessageCount} 条消息的内容来更新持久记忆。不要浪费任何一轮去进一步调查或验证这些内容——不要 grep 源码文件、不要读代码去确认模式是否存在、不要运行任何 git 命令。` +
      manifest,
  ].join('\n')
}

/**
 * 构建仅用于自动记忆（无团队记忆）的提取提示。
 * 四类分类法，无范围指引（单一目录）。
 */
export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  const howToSave = skipIndex
    ? [
        '## 如何保存记忆',
        '',
        '把每条记忆写入它自己的文件（例如 `user_role.md`、`feedback_testing.md`），使用如下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 按主题语义整理记忆，而不是按时间顺序',
        '- 更新或删除那些已证明错误或过时的记忆',
        '- 不要写入重复记忆。先检查是否有可更新的已有记忆，再写新的。',
      ]
    : [
        '## 如何保存记忆',
        '',
        '保存一条记忆分为两步：',
        '',
        '**第 1 步** —— 把记忆写入它自己的文件（例如 `user_role.md`、`feedback_testing.md`），使用如下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '**第 2 步** —— 在 `MEMORY.md` 中加上指向该文件的指针。`MEMORY.md` 是一份索引，不是记忆本身——每条目应占一行、约 150 字符以内：`- [标题](file.md) —— 一句话钩子`。它没有 frontmatter。永远不要把记忆内容直接写进 `MEMORY.md`。',
        '',
        '- `MEMORY.md` 始终会加载进你的系统提示——200 行之后的内容会被截断，所以请保持索引简洁',
        '- 按主题语义整理记忆，而不是按时间顺序',
        '- 更新或删除那些已证明错误或过时的记忆',
        '- 不要写入重复记忆。先检查是否有可更新的已有记忆，再写新的。',
      ]

  return [
    opener(newMessageCount, existingMemories),
    '',
    '如果用户显式要求你记住某些东西，立即把它保存为最合适的那类记忆。如果他们要求你忘记某些东西，就找到并删除相关条目。',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
  ].join('\n')
}

/**
 * 构建用于自动 + 团队组合记忆的提取提示。
 * 四类分类法，带逐类 <scope> 指引（目录选择已烘焙进每个类型块，无需单独的路由章节）。
 */
export function buildExtractCombinedPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  if (!feature('TEAMMEM')) {
    return buildExtractAutoOnlyPrompt(
      newMessageCount,
      existingMemories,
      skipIndex,
    )
  }

  const howToSave = skipIndex
    ? [
        '## 如何保存记忆',
        '',
        '把每条记忆写入所选目录（私有或团队，按该类型的范围指引）中它自己的文件，使用如下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 按主题语义整理记忆，而不是按时间顺序',
        '- 更新或删除那些已证明错误或过时的记忆',
        '- 不要写入重复记忆。先检查是否有可更新的已有记忆，再写新的。',
      ]
    : [
        '## 如何保存记忆',
        '',
        '保存一条记忆分为两步：',
        '',
        '**第 1 步** —— 把记忆写入所选目录（私有或团队，按该类型的范围指引）中它自己的文件，使用如下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '**第 2 步** —— 在同一个目录的 `MEMORY.md` 中加上指向该文件的指针。每个目录（私有与团队）都有自己的 `MEMORY.md` 索引——每条目应占一行、约 150 字符以内：`- [标题](file.md) —— 一句话钩子`。它们没有 frontmatter。永远不要把记忆内容直接写进任何 `MEMORY.md`。',
        '',
        '- 两个 `MEMORY.md` 索引都会被加载进你的系统提示——200 行之后的内容会被截断，所以请保持它们简洁',
        '- 按主题语义整理记忆，而不是按时间顺序',
        '- 更新或删除那些已证明错误或过时的记忆',
        '- 不要写入重复记忆。先检查是否有可更新的已有记忆，再写新的。',
      ]

  return [
    opener(newMessageCount, existingMemories),
    '',
    '如果用户显式要求你记住某些东西，立即把它保存为最合适的那类记忆。如果他们要求你忘记某些东西，就找到并删除相关条目。',
    '',
    ...TYPES_SECTION_COMBINED,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '- 你必须在共享团队记忆中避免保存敏感数据。例如，永远不要保存 API 密钥或用户凭据。',
    '',
    ...howToSave,
  ].join('\n')
}