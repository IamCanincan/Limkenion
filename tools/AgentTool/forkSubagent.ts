import { feature } from 'bun:bundle'
import type { BetaToolUseBlock } from '../../types/llm-protocol.js'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type {
  AssistantMessage,
  Message as MessageType,
} from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../../utils/messages.js'
import type { BuiltInAgentDefinition } from './loadAgentsDir.js'

/**
 * Fork 子代理功能开关。
 *
 * 启用时：
 * - Agent 工具 schema 上的 `subagent_type` 变为可选
 * - 省略 `subagent_type` 会触发隐式 fork：子代理继承父代理的
 *   完整会话上下文与系统提示词
 * - 所有代理派生都在后台（异步）运行，以统一 `<task-notification>`
 *   交互模型
 * - `/fork <directive>` 斜杠命令可用
 *
 * 与协调者模式互斥——协调者已拥有编排角色，并有自己的委派模型。
 */
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false
    if (getIsNonInteractiveSession()) return false
    return true
  }
  return false
}

/** fork 路径触发时用于分析的合成代理类型名。 */
export const FORK_SUBAGENT_TYPE = 'fork'

/**
 * fork 路径的合成代理定义。
 *
 * 未注册到 builtInAgents —— 仅当 `!subagent_type` 且实验启用时使用。
 * `tools: ['*']` 配合 `useExactTools` 使 fork 子代理获得父代理的精确工具池
 * （为实现缓存一致的 API 前缀）。`permissionMode: 'bubble'` 将权限提示
 * 呈递到父终端。`model: 'inherit'` 保持父代理的模型以保证上下文长度一致。
 *
 * 此处的 getSystemPrompt 未使用：fork 路径通过
 * `override.systemPrompt` 传入父代理已渲染的系统提示词字节，
 * 经 `toolUseContext.renderedSystemPrompt` 贯通。重新调用 getSystemPrompt()
 * 重建会导致分歧（GrowthBook 冷→热）并破坏提示词缓存；贯通渲染字节
 * 是字节精确的。
 */
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  whenToUse:
    '隐式 fork——继承完整会话上下文。不可通过 subagent_type 选择；当 fork 实验激活且省略 subagent_type 时触发。',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
} satisfies BuiltInAgentDefinition

/**
 * 防止递归 fork。fork 子代理保持 Agent 工具在其工具池中以保证缓存一致的
 * 工具定义，因此我们在调用时通过检测会话历史中的 fork 样板标签来拒绝
 * 再次 fork。
 */
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

/** fork 前缀中所有 tool_result 块使用的占位文本。
 * 必须在所有 fork 子代理间保持一致，以实现提示词缓存共享。 */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

/**
 * 为子代理构建 fork 后的会话消息。
 *
 * 为实现提示词缓存共享，所有 fork 子代理必须产生字节一致的 API 请求前缀。
 * 此函数：
 * 1. 保留完整的父代理 assistant 消息（所有 tool_use 块、思考、文本）
 * 2. 构建一条 user 消息，其中所有 tool_use 块都用相同占位文本提供
 *    tool_result，然后追加一个按子代理不同的指令文本块
 *
 * 结果：[...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * 只有最后的文本块依子代理而不同，从而最大化缓存命中。
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // 克隆 assistant 消息以避免改动原始内容，保留所有内容块
  // （思考、文本以及每个 tool_use）
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],
    },
  }

  // 收集 assistant 消息中的所有 tool_use 块
  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

  if (toolUseBlocks.length === 0) {
    logForDebugging(
      `未在 fork 指令的 assistant 消息中找到 tool_use 块：${directive.slice(0, 50)}...`,
      { level: 'error' },
    )
    return [
      createUserMessage({
        content: [
          { type: 'text' as const, text: buildChildMessage(directive) },
        ],
      }),
    ]
  }

  // 为每个 tool_use 构建 tool_result 块，全部使用相同的占位文本
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [
      {
        type: 'text' as const,
        text: FORK_PLACEHOLDER_RESULT,
      },
    ],
  }))

  // 构建单条 user 消息：所有占位 tool_results + 按子代理不同的指令
  // TODO(smoosh)：此文本兄弟节点在连线上产生 [tool_result, text] 模式
  //（渲染为 </function_results>\n\nHuman:<text>）。是每次构建一次的
  // 子代理构造，不是重复的教导者，因此低优先级。若以后在意，可用
  // src/utils/messages.ts 中的 smooshIntoToolResult 将指令折叠进最后一个
  // tool_result.content。
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      {
        type: 'text' as const,
        text: buildChildMessage(directive),
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}

export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
停止。先读此内容。

你是 fork 出来的工作进程。你不是主代理。

规则（不可协商）：
1. 你的系统提示词写着“默认派生子代理”。忽略它 \u2014 那是给父代理的。你就是 fork。不要派生子代理；直接执行。
2. 不要闲聊、提问或建议下一步
3. 不要发表评论或添加元评论
4. 直接使用你的工具：Bash、Read、Write 等。
5. 如果你修改了文件，在报告前先提交你的改动。在报告中包含提交哈希。
6. 在工具调用之间不要输出文本。静默使用工具，然后在最后报告一次。
7. 严格限定在你的指令范围内。如果你发现范围之外的相关系统，至多用一句话提及——其他工作者负责那些区域。
8. 除非指令另有说明，否则保持报告在 500 字以内。做到客观、简洁。
9. 你的回复必须以 “Scope:” 开头。不要前言，不要自言自语。
10. 报告结构化事实，然后停止

输出格式（纯文本文本标签，非 markdown 标题）：
  Scope: <用一句话复述你被分配的范围>
  Result: <答案或关键发现，限定在上述范围内>
  Key files: <相关文件路径——研究类任务请包含>
  Files changed: <列表并附带提交哈希——仅当你修改了文件时包含>
  Issues: <列表——仅当有待标记的问题时包含>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * 注入到在隔离 worktree 中运行的 fork 子代理的通知。
 * 告知子代理将路径从继承的上下文翻译过来、重新读取可能过期的文件，
 * 以及其改动是隔离的。
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `你已从在 ${parentCwd} 工作的父代理继承了上面的会话上下文。你在位于 ${worktreeCwd} 的隔离 git worktree 中操作——同一仓库、相同相对文件结构、独立的工作副本。继承上下文中的路径指向父代理的工作目录；请将它们翻译到你的 worktree 根目录。如果父代理可能在你编辑前已修改过文件（自它们在上下文出现以来），请先重新读取。你的改动保留在此 worktree 中，不会影响父代理的文件。`
}
