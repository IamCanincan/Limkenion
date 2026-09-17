import { feature } from 'bun:bundle'
import type { PartialCompactDirection } from '../../types/message.js'

// 死代码消除：按特性条件引入 proactive 模式模块
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

// 强化的“禁止使用工具”前导指令。缓存共享的 fork 路径会继承父进程的完整工具集
//（这是 cache-key 匹配所需），而在 Sonnet 4.6+ 的自适应思考模型上，模型有时仍会
// 在较弱的尾部指令下尝试调用工具。当 maxTurns: 1 时，一次被拒绝的工具调用意味着
// 没有任何文本输出 → 会回退到流式输出兜底（4.6 上 2.79% vs 4.5 上 0.01%）。
// 把这段放在最前面，并明确说明被拒绝的后果，就能避免浪费这一轮。
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

// 两个变体：BASE 的作用范围是“整个对话”，PARTIAL 的作用范围是“最近的若干消息”。
// <analysis> 块是一个草稿草稿区，formatCompactSummary() 会在摘要进入上下文前将其剥离。
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `在给出最终摘要之前，请先用 <analysis> 标签把你的分析过程包起来，用来组织思路并确保覆盖了所有必要要点。在你的分析过程中：

1. 按时间顺序逐条分析对话的每一段消息。对每一段都要彻底识别：
   - 用户的显式请求与意图
   - 你应对用户请求所采用的方法
   - 关键决策、技术概念与代码模式
   - 具体细节，例如：
     - 文件名
     - 完整代码片段
     - 函数签名
     - 文件编辑
   - 你遇到过的错误以及你如何修复它们
   - 特别关注你收到的具体用户反馈，尤其是用户让你用不同方式做某事的情况。
2. 反复核对技术准确性与完整性，逐项彻底覆盖每个必要要素。`

const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `在给出最终摘要之前，请先用 <analysis> 标签把你的分析过程包起来，用来组织思路并确保覆盖了所有必要要点。在你的分析过程中：

1. 按时间顺序分析最近的消息。对每一段都要彻底识别：
   - 用户的显式请求与意图
   - 你应对用户请求所采用的方法
   - 关键决策、技术概念与代码模式
   - 具体细节，例如：
     - 文件名
     - 完整代码片段
     - 函数签名
     - 文件编辑
   - 你遇到过的错误以及你如何修复它们
   - 特别关注你收到的具体用户反馈，尤其是用户让你用不同方式做某事的情况。
2. 反复核对技术准确性与完整性，逐项彻底覆盖每个必要要素。`

const BASE_COMPACT_PROMPT = `你的任务是为到目前为止的对话生成一份详细摘要，密切留意用户的显式请求以及你之前的操作。
这份摘要应当详尽地记录技术细节、代码模式与架构决策，以便在不清失上下文的前提下继续开发工作。

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

你的摘要应当包含以下这些部分：

1. 主要请求与意图：详尽记录用户所有的显式请求与意图
2. 关键技术概念：列出所讨论的所有重要技术概念、技术栈与框架。
3. 文件与代码部分：逐项列出你查看过、修改过或创建过的具体文件与代码片段。特别关注最近的消息，在适用处给出完整代码片段，并说明这次文件读取或编辑为什么重要。
4. 错误与修复：列出所有你遇到的错误，以及你是如何修复的。特别关注你收到的具体用户反馈，尤其是用户让你用不同方式做某事的情况。
5. 问题解决：记录已解决的问题以及仍在进行中的排查工作。
6. 所有用户消息：列出所有不是工具结果（tool result）的用户消息。这些消息对理解用户反馈和意图变化至关重要。
7. 待办任务：概括你被显式要求处理的各项待办任务。
8. 当前工作：精确描述在收到这次摘要请求之前你正在处理的内容，特别关注来自用户和助手最近的若干消息。在适用处包含文件名与代码片段。
9. 可选下一步：列出与最近工作相关的、你将要采取的下一步操作。重要：确保这一步与你最近收到的显式请求、以及你在收到摘要请求之前正在处理的任务直接一致。如果你的上一个任务已经结束，那么只有在下一步与用户请求显式一致时才列出。未经用户确认，不要开始处理那些旁路请求或早已完成的老请求。
                       如果存在下一步，请直接引用最近对话的原文，展示你当时正在处理的确切任务以及停在了哪里。请逐字引用，以确保任务理解不发生偏移。

下面是一个你应当如何组织输出的示例：

<example>
<analysis>
[你的思考过程，确保所有要点都被透彻且准确地覆盖]
</analysis>

<summary>
1. 主要请求与意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]
   - [...]

3. 文件与代码部分：
   - [文件 1]
      - [这个文件为什么重要的摘要]
      - [对此文件所做的改动摘要，如有]
      - [重要代码片段]
   - [文件 2]
      - [重要代码片段]
   - [...]

4. 错误与修复：
    - [错误 1 的详细描述]：
      - [你是如何修复这个错误的]
      - [关于此错误的用户反馈，如有]
    - [...]

5. 问题解决：
   [关于已解决问题和排查情况的描述]

6. 所有用户消息： 
    - [详细的非工具使用用户消息]
    - [...]

7. 待办任务：
   - [任务 1]
   - [任务 2]
   - [...]

8. 当前工作：
   [对当前工作的精确描述]

9. 可选下一步：
   [可选的下一步操作]

</summary>
</example>

请根据到目前为止的对话提供你的摘要，遵循上述结构并确保回复精确而彻底。

在已包含的上下文中可能还会提供额外的摘要指令。如果有，请在生成摘要时记住遵循这些指令。指令示例包括：
<example>
## 压缩指令
在总结对话时，重点关注 typescript 代码改动，同时记住你犯过的错误以及你是如何修复它们的。
</example>

<example>
# 摘要指令
在你使用 compact 时——请重点记录测试输出与代码改动。逐字包含文件读取内容。
</example>
`

const PARTIAL_COMPACT_PROMPT = `你的任务是为对话中“最近这一段”的消息——即位于较早保留上下文之后的消息——生成一份详细摘要。较早的消息会被原样保留，无需进行摘要。请只把讨论、学到和完成的内容聚焦到最近这段消息上。

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

你的摘要应当包含以下这些部分：

1. 主要请求与意图：记录最近消息中用户的显式请求与意图
2. 关键技术概念：列出最近讨论过的重要技术概念、技术栈与框架。
3. 文件与代码部分：逐项列出查看过、修改过或创建过的具体文件与代码片段。在适用处给出完整代码片段，并说明这次文件读取或编辑为什么重要。
4. 错误与修复：列出遇到的错误以及修复方法。
5. 问题解决：记录已解决的问题以及仍在进行中的排查工作。
6. 所有用户消息：列出最近一段所有非工具结果（tool result）的用户消息。
7. 待办任务：概括最近消息中的各项待办任务。
8. 当前工作：精确描述在收到这次摘要请求之前你正在处理的内容。
9. 可选下一步：列出与最近工作相关的下一步操作。请直接引用最近对话的原文。

下面是一个你应当如何组织输出的示例：

<example>
<analysis>
[你的思考过程，确保所有要点都被透彻且准确地覆盖]
</analysis>

<summary>
1. 主要请求与意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]

3. 文件与代码部分：
   - [文件 1]
      - [这个文件为什么重要的摘要]
      - [重要代码片段]

4. 错误与修复：
    - [错误描述]：
      - [你是如何修复的]

5. 问题解决：
   [描述]

6. 所有用户消息：
    - [详细的非工具使用用户消息]

7. 待办任务：
   - [任务 1]

8. 当前工作：
   [对当前工作的精确描述]

9. 可选下一步：
   [可选的下一步操作]

</summary>
</example>

请只基于最近这段消息（位于较早保留上下文之后）提供你的摘要，遵循上述结构并确保回复精确而彻底。
`

// 'up_to'：模型只看到被摘要过的前缀（缓存命中）。摘要会位于保留的最近消息之前，
// 因此需要“为后续工作保留的上下文”这一节。
const PARTIAL_COMPACT_UP_TO_PROMPT = `你的任务是为这次对话生成一份详细摘要。这份摘要会被放在一个延续会话的开头；在它的基础上继续的消息会排在摘要之后（你在这里看不到它们）。请彻底地摘要，让只读你的摘要再加上后续较新消息的读者，能够完全理解发生了什么并继续这项工作。

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

你的摘要应当包含以下这些部分：

1. 主要请求与意图：详尽记录用户的显式请求与意图
2. 关键技术概念：列出所讨论的所有重要技术概念、技术栈与框架。
3. 文件与代码部分：逐项列出查看过、修改过或创建过的具体文件与代码片段。在适用处给出完整代码片段，并说明这次文件读取或编辑为什么重要。
4. 错误与修复：列出遇到的错误以及修复方法。
5. 问题解决：记录已解决的问题以及仍在进行中的排查工作。
6. 所有用户消息：列出所有不是工具结果（tool result）的用户消息。
7. 待办任务：概括各项待办任务。
8. 已完成的工作：描述到这一段结束时已完成的内容。
9. 为后续工作保留的上下文：概括在后续消息中继续这项工作所需的上下文、决策或状态。

下面是一个你应当如何组织输出的示例：

<example>
<analysis>
[你的思考过程，确保所有要点都被透彻且准确地覆盖]
</analysis>

<summary>
1. 主要请求与意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]

3. 文件与代码部分：
   - [文件 1]
      - [这个文件为什么重要的摘要]
      - [重要代码片段]

4. 错误与修复：
    - [错误描述]：
      - [你是如何修复的]

5. 问题解决：
   [描述]

6. 所有用户消息：
    - [详细的非工具使用用户消息]

7. 待办任务：
   - [任务 1]

8. 已完成的工作：
   [对已完成内容的描述]

9. 为后续工作保留的上下文：
   [继续这项工作所需的关键上下文、决策或状态]

</summary>
</example>

请遵循上述结构提供你的摘要，确保回复精确而彻底。
`

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: PartialCompactDirection = 'from',
): string {
  const template =
    direction === 'up_to'
      ? PARTIAL_COMPACT_UP_TO_PROMPT
      : PARTIAL_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

/**
 * 对压缩摘要进行格式化：剥离用于起草思路的 <analysis> 部分，
 * 并把 <summary> XML 标签替换为易读的章节标题。
 * @param summary 可能包含 <analysis> 与 <summary> XML 标签的原始摘要字符串
 * @returns 格式化后的摘要：analysis 被剥离，summary 标签被替换为章节标题
 */
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  // 剥离 analysis 部分——它只是用来提升摘要质量的起草思路区，
  // 一旦摘要写成后就不再具有信息价值。
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  // 提取并格式化 summary 部分
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }

  // 清理各章节之间多余的空行
  formattedSummary = formattedSummary.replace(/\n\n+/g, '\n\n')

  return formattedSummary.trim()
}

export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  let baseSummary = `本次会话是从上一段因上下文用尽而中断的对话延续下来的。下面的摘要覆盖了之前那一段对话。

${formattedSummary}`

  if (transcriptPath) {
    baseSummary += `\n\n如果你需要压缩之前的某个具体细节（比如确切的代码片段、错误信息或你生成的内容），请读取完整转录记录：${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    baseSummary += `\n\n最近的消息会被逐字保留。`
  }

  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
请从上次中断的地方继续对话，不要再向用户追问任何问题。直接恢复— 不用确认这条摘要，不用复述正在发生的事，不要以“我会继续”之类的话开头。就像中断从未发生过一样，接着做最后那个任务。`

    if (
      (feature('PROACTIVE') || feature('KAIROS')) &&
      proactiveModule?.isProactiveActive()
    ) {
      continuation += `

你正运行在自主/主动模式下。这不是一次首次唤醒——在压缩之前你就已经在自主工作了。继续你的工作循环：根据上面的摘要从停下的地方继续。不要向用户打招呼，也不要询问该做什么。`
    }

    return continuation
  }

  return baseSummary
}