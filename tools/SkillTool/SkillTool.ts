import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '../../types/llm-protocol.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { dirname } from 'path'
import { getProjectRoot } from 'src/bootstrap/state.js'
import {
  builtInCommandNames,
  findCommand,
  getCommands,
  type PromptCommand,
} from 'src/commands.js'
import type {
  Tool,
  ToolCallProgress,
  ToolResult,
  ToolUseContext,
  ValidationResult,
} from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import type { Command } from 'src/types/command.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from 'src/utils/permissions/permissions.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from 'src/utils/plugins/pluginIdentifier.js'
import { buildPluginCommandTelemetryFields } from 'src/utils/telemetry/pluginTelemetry.js'
import { z } from 'zod/v4'
import {
  addInvokedSkill,
  clearInvokedSkillsForAgent,
  getSessionId,
} from '../../bootstrap/state.js'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { errorMessage } from '../../utils/errors.js'
import {
  extractResultText,
  prepareForkedCommandContext,
} from '../../utils/forkedAgent.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createUserMessage, normalizeMessages } from '../../utils/messages.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { resolveSkillModelOverride } from '../../utils/model/model.js'
import { recordSkillUsage } from '../../utils/suggestions/skillUsageTracking.js'
import { createAgentId } from '../../utils/uuid.js'
import { runAgent } from '../AgentTool/runAgent.js'
import {
  getToolUseIDFromParentMessage,
  tagMessagesWithToolUseID,
} from '../utils.js'
import { SKILL_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/**
 * 从 AppState 获取所有命令，包括 MCP 技能/提示词。
 * SkillTool 需要它，因为 getCommands() 只返回本地/内置技能。
 */
async function getAllCommands(context: ToolUseContext): Promise<Command[]> {
  // 只包含 MCP 技能（loadedFrom === 'mcp'），不包含普通的 MCP 提示词。
  // 在此过滤之前，模型若猜到 mcp__server__prompt 名称，
  // 就能通过 SkillTool 调用 MCP 提示词 —— 它们不可被发现，
  // 但技术上可达。
  const mcpSkills = context
    .getAppState()
    .mcp.commands.filter(
      cmd => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp',
    )
  if (mcpSkills.length === 0) return getCommands(getProjectRoot())
  const localCommands = await getCommands(getProjectRoot())
  return uniqBy([...localCommands, ...mcpSkills], 'name')
}

// 从集中式类型重新导出 Progress 以打破导入循环
export type { SkillToolProgress as Progress } from '../../types/tools.js'

import type { SkillToolProgress as Progress } from '../../types/tools.js'

// 对远程技能模块使用条件式 require —— 这里的静态导入会
// 引入 akiBackend.ts（经由 remoteSkillLoader → akiBackend），其中
// 模块级的 memoize()/lazySchema() 常量会作为有副作用的初始化器
// 在 tree-shaking 中存活。所有使用点都在
// feature('EXPERIMENTAL_SKILL_SEARCH') 守卫内，因此在每个调用点
// remoteSkillModules 都非空。
/* eslint-disable @typescript-eslint/no-require-imports */
const remoteSkillModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      ...(require('../../services/skillSearch/remoteSkillState.js') as typeof import('../../services/skillSearch/remoteSkillState.js')),
      ...(require('../../services/skillSearch/remoteSkillLoader.js') as typeof import('../../services/skillSearch/remoteSkillLoader.js')),
      ...(require('../../services/skillSearch/telemetry.js') as typeof import('../../services/skillSearch/telemetry.js')),
      ...(require('../../services/skillSearch/featureCheck.js') as typeof import('../../services/skillSearch/featureCheck.js')),
    }
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 在 fork 出的子 agent 上下文中执行技能。
 * 这会在拥有独立 token 预算的隔离 agent 中运行技能提示词。
 */
async function executeForkedSkill(
  command: Command & { type: 'prompt' },
  commandName: string,
  args: string | undefined,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress<Progress>,
): Promise<ToolResult<Output>> {
  const startTime = Date.now()
  const agentId = createAgentId()
  const isBuiltIn = builtInCommandNames().has(commandName)
  const isOfficialSkill = isOfficialMarketplaceSkill(command)
  const isBundled = command.source === 'bundled'
  const forkedSanitizedName =
    isBuiltIn || isBundled || isOfficialSkill ? commandName : 'custom'

  const wasDiscoveredField =
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    remoteSkillModules!.isSkillSearchEnabled()
      ? {
          was_discovered:
            context.discoveredSkillNames?.has(commandName) ?? false,
        }
      : {}
  const pluginMarketplace = command.pluginInfo
    ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
    : undefined
  const queryDepth = context.queryTracking?.depth ?? 0
  const parentAgentId = getAgentContext()?.agentId
  logEvent('limkenion_skill_tool_invocation', {
    command_name:
      forkedSanitizedName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // _PROTO_skill_name 路由到有权限的 skill_name BQ 列
    // （未脱敏，面向所有用户）；command_name 保留在 additional_metadata 中
    // 作为供通用访问看板使用的脱敏变体。
    _PROTO_skill_name:
      commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    execution_context:
      'fork' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: (queryDepth > 0
      ? 'nested-skill'
      : 'limkenion-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    query_depth: queryDepth,
    ...(parentAgentId && {
      parent_agent_id:
        parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...wasDiscoveredField,
    
    ...(command.pluginInfo && {
      // _PROTO_* 路由到带 PII 标记的 plugin_name/marketplace_name BQ 列
      // （未脱敏，面向所有用户）；plugin_name/plugin_repository 保留在
      // additional_metadata 中作为脱敏变体。
      _PROTO_plugin_name: command.pluginInfo.pluginManifest
        .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(pluginMarketplace && {
        _PROTO_marketplace_name:
          pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      plugin_name: (isOfficialSkill
        ? command.pluginInfo.pluginManifest.name
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      plugin_repository: (isOfficialSkill
        ? command.pluginInfo.repository
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginCommandTelemetryFields(command.pluginInfo),
    }),
  })

  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)

  // 将技能的 effort 合并进 agent 定义，以便 runAgent 应用它
  const agentDefinition =
    command.effort !== undefined
      ? { ...baseAgent, effort: command.effort }
      : baseAgent

  // 收集来自 fork 出的 agent 的消息
  const agentMessages: Message[] = []

  logForDebugging(
    `SkillTool executing forked skill ${commandName} with agent ${agentDefinition.agentType}`,
  )

  try {
    // 运行子代理
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState,
      },
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools,
      override: { agentId },
    })) {
      agentMessages.push(message)

      // 为工具调用上报进度（与 AgentTool 的做法一致）
      if (
        (message.type === 'assistant' || message.type === 'user') &&
        onProgress
      ) {
        const normalizedNew = normalizeMessages([message])
        for (const m of normalizedNew) {
          const hasToolContent = m.message.content.some(
            c => c.type === 'tool_use' || c.type === 'tool_result',
          )
          if (hasToolContent) {
            onProgress({
              toolUseID: `skill_${parentMessage.message.id}`,
              data: {
                message: m,
                type: 'skill_progress',
                prompt: skillContent,
                agentId,
              },
            })
          }
        }
      }
    }

    const resultText = extractResultText(
      agentMessages,
      'Skill execution completed',
    )
    // 提取结果后释放消息内存
    agentMessages.length = 0

    const durationMs = Date.now() - startTime
    logForDebugging(
      `SkillTool forked skill ${commandName} completed in ${durationMs}ms`,
    )

    return {
      data: {
        success: true,
        commandName,
        status: 'forked',
        agentId,
        result: resultText,
      },
    }
  } finally {
    // 从 invokedSkills 状态中释放技能内容
    clearInvokedSkillsForAgent(agentId)
  }
}

export const inputSchema = lazySchema(() =>
  z.object({
    skill: z
      .string()
      .describe('技能名称。例如 "commit"、"review-pr" 或 "pdf"'),
    args: z.string().optional().describe('该技能的可选参数'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() => {
  // 内联技能（默认）的输出 schema
  const inlineOutputSchema = z.object({
    success: z.boolean().describe('技能是否有效'),
    commandName: z.string().describe('技能的名称'),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe('此技能允许使用的工具'),
    model: z.string().optional().describe('若指定则为模型覆盖'),
    status: z.literal('inline').optional().describe('执行状态'),
  })

  // fork 技能的输出 schema
  const forkedOutputSchema = z.object({
    success: z.boolean().describe('技能是否成功完成'),
    commandName: z.string().describe('技能的名称'),
    status: z.literal('forked').describe('执行状态'),
    agentId: z
      .string()
      .describe('执行该技能的子代理的 ID'),
    result: z.string().describe('fork 技能执行的结果'),
  })

  return z.union([inlineOutputSchema, forkedOutputSchema])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.input<OutputSchema>

export const SkillTool: Tool<InputSchema, Output, Progress> = buildTool({
  name: SKILL_TOOL_NAME,
  searchHint: 'invoke a slash-command skill',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  description: async ({ skill }) => `Execute skill: ${skill}`,

  prompt: async () => getPrompt(getProjectRoot()),

  // 同一时间只应运行一个技能/命令，因为该工具会把
  // 命令展开为完整提示词，Limkenion 必须先处理完才能继续。
  // Skill-coach 需要技能名称，以避免在 X 确实被调用时
  // 误报 "you could have used skill X" 建议。Backseat 会从展开后的
  // 提示词（而非这个包装器）归类下游工具调用，因此
  // 仅凭名称就足够了 —— 它只是记录技能被触发过。
  toAutoClassifierInput: ({ skill }) => skill ?? '',

  async validateInput({ skill }, context): Promise<ValidationResult> {
    // 技能只是技能名称，没有参数
    const trimmed = skill.trim()
    if (!trimmed) {
      return {
        result: false,
        message: `Invalid skill format: ${skill}`,
        errorCode: 1,
      }
    }

    // 若存在前导斜杠则移除（为兼容性）
    const hasLeadingSlash = trimmed.startsWith('/')
    if (hasLeadingSlash) {
      logEvent('limkenion_skill_tool_slash_prefix', {})
    }
    const normalizedCommandName = hasLeadingSlash
      ? trimmed.substring(1)
      : trimmed

    // 远程规范技能处理（仅 ant 的实验特性）。在本地命令查找之前
    // 拦截 `_canonical_<slug>` 名称，因为远程
    // 技能不在本地命令注册表中。
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      false
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(
        normalizedCommandName,
      )
      if (slug !== null) {
        const meta = remoteSkillModules!.getDiscoveredRemoteSkill(slug)
        if (!meta) {
          return {
            result: false,
            message: `Remote skill ${slug} was not discovered in this session. Use DiscoverSkills to find remote skills first.`,
            errorCode: 6,
          }
        }
        // 发现远程技能 —— 有效。加载发生在 call() 中。
        return { result: true }
      }
    }

    // 获取可用命令（包括 MCP 技能）
    const commands = await getAllCommands(context)

    // 检查命令是否存在
    const foundCommand = findCommand(normalizedCommandName, commands)
    if (!foundCommand) {
      return {
        result: false,
        message: `Unknown skill: ${normalizedCommandName}`,
        errorCode: 2,
      }
    }

    // 检查命令是否禁用了模型调用
    if (foundCommand.disableModelInvocation) {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} cannot be used with ${SKILL_TOOL_NAME} tool due to disable-model-invocation`,
        errorCode: 4,
      }
    }

    // 检查命令是否为基于提示词的命令
    if (foundCommand.type !== 'prompt') {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} is not a prompt-based skill`,
        errorCode: 5,
      }
    }

    return { result: true }
  },

  async checkPermissions(
    { skill, args },
    context,
  ): Promise<PermissionDecision> {
    // 技能只是技能名称，没有参数
    const trimmed = skill.trim()

    // 若存在前导斜杠则移除（为兼容性）
    const commandName = trimmed.startsWith('/') ? trimmed.substring(1) : trimmed

    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    // 查找命令对象以作为元数据传入
    const commands = await getAllCommands(context)
    const commandObj = findCommand(commandName, commands)

    // 用于检查规则是否匹配该技能的辅助函数
    // 通过剥离前导斜杠来规范化两个输入，以保证匹配一致
    const ruleMatches = (ruleContent: string): boolean => {
      // 通过剥离前导斜杠规范化规则内容
      const normalizedRule = ruleContent.startsWith('/')
        ? ruleContent.substring(1)
        : ruleContent

      // 检查精确匹配（使用规范化后的 commandName）
      if (normalizedRule === commandName) {
        return true
      }
      // 检查前缀匹配（例如 "review:*" 匹配 "review-pr 123"）
      if (normalizedRule.endsWith(':*')) {
        const prefix = normalizedRule.slice(0, -2) // 移除 ':*'
        return commandName.startsWith(prefix)
      }
      return false
    }

    // 检查拒绝规则
    const denyRules = getRuleByContentsForTool(
      permissionContext,
      SkillTool as Tool,
      'deny',
    )
    for (const [ruleContent, rule] of denyRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: 'deny',
          message: `Skill execution blocked by permission rules`,
          decisionReason: {
            type: 'rule',
            rule,
          },
        }
      }
    }

    // 远程规范技能是仅 ant 的实验特性 —— 自动授权。
    // 放在拒绝循环之后，以便用户配置的 Skill(_canonical_:*)
    // 拒绝规则得到尊重（与下方安全属性自动允许的模式相同）。
    // 技能内容本身是规范/精选的，而非用户编写。
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      false
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(commandName)
      if (slug !== null) {
        return {
          behavior: 'allow',
          updatedInput: { skill, args },
          decisionReason: undefined,
        }
      }
    }

    // 检查允许规则
    const allowRules = getRuleByContentsForTool(
      permissionContext,
      SkillTool as Tool,
      'allow',
    )
    for (const [ruleContent, rule] of allowRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: 'allow',
          updatedInput: { skill, args },
          decisionReason: {
            type: 'rule',
            rule,
          },
        }
      }
    }

    // 自动允许仅使用安全属性的技能。
    // 这是一个允许列表：如果技能有任何一个不在该集合中且
    // 具有实际值的属性，就需要权限。这确保未来新增的属性
    // 默认需要权限。
    if (
      commandObj?.type === 'prompt' &&
      skillHasOnlySafeProperties(commandObj)
    ) {
      return {
        behavior: 'allow',
        updatedInput: { skill, args },
        decisionReason: undefined,
      }
    }

    // 为精确技能和前缀准备建议
    // 使用规范化后的 commandName（不带前导斜杠）以保证规则一致
    const suggestions = [
      // 精确技能建议
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: commandName,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
      // 允许任意参数的前缀建议
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: `${commandName}:*`,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
    ]

    // 默认行为：向用户请求权限
    return {
      behavior: 'ask',
      message: `Execute skill: ${commandName}`,
      decisionReason: undefined,
      suggestions,
      updatedInput: { skill, args },
      metadata: commandObj ? { command: commandObj } : undefined,
    }
  },

  async call(
    { skill, args },
    context,
    canUseTool,
    parentMessage,
    onProgress?,
  ): Promise<ToolResult<Output>> {
    // 此时 validateInput 已确认：
    // - 技能格式有效
    // - 技能存在
    // - 技能可加载
    // - 技能没有 disableModelInvocation
    // - 技能是基于提示词的技能

    // 技能只是名称，可带可选参数
    const trimmed = skill.trim()

    // 若存在前导斜杠则移除（为兼容性）
    const commandName = trimmed.startsWith('/') ? trimmed.substring(1) : trimmed

    // 远程规范技能执行（仅 ant 的实验特性）。在本地命令查找之前
    // 拦截 `_canonical_<slug>` —— 从 AKI/GCS 加载 SKILL.md
    // （带本地缓存），将内容直接作为用户消息注入。
    // 远程技能是声明式 markdown，因此无需斜杠命令展开
    // （无需 !command 替换，也无需 $ARGUMENTS 插值）。
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      false
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(commandName)
      if (slug !== null) {
        return executeRemoteSkill(slug, commandName, parentMessage, context)
      }
    }

    const commands = await getAllCommands(context)
    const command = findCommand(commandName, commands)

    // 跟踪技能使用情况用于排序
    recordSkillUsage(commandName)

    // 检查技能是否应作为 fork 的子 agent 运行
    if (command?.type === 'prompt' && command.context === 'fork') {
      return executeForkedSkill(
        command,
        commandName,
        args,
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )
    }

    // 处理带可选参数的技能
    const { processPromptSlashCommand } = await import(
      'src/utils/processUserInput/processSlashCommand.js'
    )
    const processedCommand = await processPromptSlashCommand(
      commandName,
      args || '', // 若提供了参数则传入
      commands,
      context,
    )

    if (!processedCommand.shouldQuery) {
      throw new Error('Command processing failed')
    }

    // 从命令中提取元数据
    const allowedTools = processedCommand.allowedTools || []
    const model = processedCommand.model
    const effort = command?.type === 'prompt' ? command.effort : undefined

    const isBuiltIn = builtInCommandNames().has(commandName)
    const isBundled = command?.type === 'prompt' && command.source === 'bundled'
    const isOfficialSkill =
      command?.type === 'prompt' && isOfficialMarketplaceSkill(command)
    const sanitizedCommandName =
      isBuiltIn || isBundled || isOfficialSkill ? commandName : 'custom'

    const wasDiscoveredField =
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      remoteSkillModules!.isSkillSearchEnabled()
        ? {
            was_discovered:
              context.discoveredSkillNames?.has(commandName) ?? false,
          }
        : {}
    const pluginMarketplace =
      command?.type === 'prompt' && command.pluginInfo
        ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
        : undefined
    const queryDepth = context.queryTracking?.depth ?? 0
    const parentAgentId = getAgentContext()?.agentId
    logEvent('limkenion_skill_tool_invocation', {
      command_name:
        sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // _PROTO_skill_name 路由到有权限的 skill_name BQ 列
      // （未脱敏，面向所有用户）；command_name 保留在 additional_metadata 中
      // 作为供通用访问看板使用的脱敏变体。
      _PROTO_skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      execution_context:
        'inline' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      invocation_trigger: (queryDepth > 0
        ? 'nested-skill'
        : 'limkenion-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      query_depth: queryDepth,
      ...(parentAgentId && {
        parent_agent_id:
          parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...wasDiscoveredField,
      
      ...(command?.type === 'prompt' &&
        command.pluginInfo && {
          _PROTO_plugin_name: command.pluginInfo.pluginManifest
            .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          ...(pluginMarketplace && {
            _PROTO_marketplace_name:
              pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          }),
          plugin_name: (isOfficialSkill
            ? command.pluginInfo.pluginManifest.name
            : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          plugin_repository: (isOfficialSkill
            ? command.pluginInfo.repository
            : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...buildPluginCommandTelemetryFields(command.pluginInfo),
        }),
    })

    // 从父消息中获取工具调用 ID，用于关联 newMessages
    const toolUseID = getToolUseIDFromParentMessage(
      parentMessage,
      SKILL_TOOL_NAME,
    )

    // 用 sourceToolUseID 标记用户消息，使其在本工具完成前保持瞬态
    const newMessages = tagMessagesWithToolUseID(
      processedCommand.messages.filter(
        (m): m is UserMessage | AttachmentMessage | SystemMessage => {
          if (m.type === 'progress') {
            return false
          }
          // 过滤掉 command-message，因为 SkillTool 负责展示
          if (m.type === 'user' && 'message' in m) {
            const content = m.message.content
            if (
              typeof content === 'string' &&
              content.includes(`<${COMMAND_MESSAGE_TAG}>`)
            ) {
              return false
            }
          }
          return true
        },
      ),
      toolUseID,
    )

    logForDebugging(
      `SkillTool returning ${newMessages.length} newMessages for skill ${commandName}`,
    )

    // 注意：addInvokedSkill 和 registerSkillHooks 会在
    // processPromptSlashCommand 内部调用（经由 getMessagesForPromptSlashCommand），
    // 因此在这里再次调用会重复注册钩子并多余地重建
    // skillContent。

    // 返回带有 newMessages 和 contextModifier 的成功结果
    return {
      data: {
        success: true,
        commandName,
        allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
        model,
      },
      newMessages,
      contextModifier(ctx) {
        let modifiedContext = ctx

        // 若指定了允许的工具则更新
        if (allowedTools.length > 0) {
          // 捕获当前的 getAppState，以便正确串联修改
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              // 使用上一次的 getAppState，而不是闭包中的 context.getAppState，
              // 以正确串联上下文修改
              const appState = previousGetAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: [
                      ...new Set([
                        ...(appState.toolPermissionContext.alwaysAllowRules
                          .command || []),
                        ...allowedTools,
                      ]),
                    ],
                  },
                },
              }
            },
          }
        }

        // 保留 [1m] 后缀 —— 否则在 opus[1m] 会话上使用 `model: opus` 的技能
        // 会把有效窗口降到 200K 并触发自动压缩。
        if (model) {
          modifiedContext = {
            ...modifiedContext,
            options: {
              ...modifiedContext.options,
              mainLoopModel: resolveSkillModelOverride(
                model,
                ctx.options.mainLoopModel,
              ),
            },
          }
        }

        // 若技能指定了 effort 级别则覆盖
        if (effort !== undefined) {
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              const appState = previousGetAppState()
              return {
                ...appState,
                effortValue: effort,
              }
            },
          }
        }

        return modifiedContext
      },
    }
  },

  mapToolResultToToolResultBlockParam(
    result: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    // 处理 fork 的技能结果
    if ('status' in result && result.status === 'forked') {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: `Skill "${result.commandName}" completed (forked execution).\n\nResult:\n${result.result}`,
      }
    }

    // 内联技能结果（默认）
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: `Launching skill: ${result.commandName}`,
    }
  },

  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
} satisfies ToolDef<InputSchema, Output, Progress>)

// 安全且不需要权限的 PromptCommand 属性键允许列表。
// 如果技能有任何一个不在该集合中且具有实际值的属性，就需要
// 权限。这确保未来新增到 PromptCommand 的属性
// 默认需要权限，直到被显式审查并加入此处。
const SAFE_SKILL_PROPERTIES = new Set([
  // PromptCommand 属性
  'type',
  'progressMessage',
  'contentLength',
  'argNames',
  'model',
  'effort',
  'source',
  'pluginInfo',
  'disableNonInteractive',
  'skillRoot',
  'context',
  'agent',
  'getPromptForCommand',
  'frontmatterKeys',
  // CommandBase 属性
  'name',
  'description',
  'hasUserSpecifiedDescription',
  'isEnabled',
  'isHidden',
  'aliases',
  'isMcp',
  'argumentHint',
  'whenToUse',
  'paths',
  'version',
  'disableModelInvocation',
  'userInvocable',
  'loadedFrom',
  'immediate',
  'userFacingName',
])

function skillHasOnlySafeProperties(command: Command): boolean {
  for (const key of Object.keys(command)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) {
      continue
    }
    // 属性不在安全允许列表中 - 检查它是否有实际值
    const value = (command as Record<string, unknown>)[key]
    if (value === undefined || value === null) {
      continue
    }
    if (Array.isArray(value) && value.length === 0) {
      continue
    }
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue
    }
    return false
  }
  return true
}

function isOfficialMarketplaceSkill(command: PromptCommand): boolean {
  if (command.source !== 'plugin' || !command.pluginInfo?.repository) {
    return false
  }
  return isOfficialMarketplaceName(
    parsePluginIdentifier(command.pluginInfo.repository).marketplace,
  )
}

/**
 * 提取 URL scheme 用于遥测。对于无法识别的 scheme 默认使用 'gs'，
 * 因为 AKI 后端是唯一的生产路径，而且加载器在我们到达遥测之前
 * 就已经对未知 scheme 抛错。
 */
function extractUrlScheme(url: string): 'gs' | 'http' | 'https' | 's3' {
  if (url.startsWith('gs://')) return 'gs'
  if (url.startsWith('https://')) return 'https'
  if (url.startsWith('http://')) return 'http'
  if (url.startsWith('s3://')) return 's3'
  return 'gs'
}

/**
 * 加载远程规范技能并将其 SKILL.md 内容注入
 * 会话。与本地技能不同（本地技能会经过 processPromptSlashCommand
 * 做 !command / $ARGUMENTS 展开），远程技能是声明式 markdown
 * —— 我们直接把内容包装进一条用户消息。
 *
 * 该技能也会通过 addInvokedSkill 注册，以便在上下文压缩后依然保留
 * （与本地技能相同）。
 *
 * 仅在 call() 中的 feature('EXPERIMENTAL_SKILL_SEARCH') 守卫内
 * 调用 —— 此处 remoteSkillModules 非空。
 */
async function executeRemoteSkill(
  slug: string,
  commandName: string,
  parentMessage: AssistantMessage,
  context: ToolUseContext,
): Promise<ToolResult<Output>> {
  const { getDiscoveredRemoteSkill, loadRemoteSkill, logRemoteSkillLoaded } =
    remoteSkillModules!

  // validateInput 已确认该 slug 存在于会话状态中，但我们
  // 在此重新获取以拿到 URL。如果它不知何故消失了（例如状态在
  // 会话中途被清除），则给出明确错误而不是崩溃。
  const meta = getDiscoveredRemoteSkill(slug)
  if (!meta) {
    throw new Error(
      `Remote skill ${slug} was not discovered in this session. Use DiscoverSkills to find remote skills first.`,
    )
  }

  const urlScheme = extractUrlScheme(meta.url)
  let loadResult
  try {
    loadResult = await loadRemoteSkill(slug, meta.url)
  } catch (e) {
    const msg = errorMessage(e)
    logRemoteSkillLoaded({
      slug,
      cacheHit: false,
      latencyMs: 0,
      urlScheme,
      error: msg,
    })
    throw new Error(`Failed to load remote skill ${slug}: ${msg}`)
  }

  const {
    cacheHit,
    latencyMs,
    skillPath,
    content,
    fileCount,
    totalBytes,
    fetchMethod,
  } = loadResult

  logRemoteSkillLoaded({
    slug,
    cacheHit,
    latencyMs,
    urlScheme,
    fileCount,
    totalBytes,
    fetchMethod,
  })

  // 远程技能总是由模型发现的（从不出现在静态 skill_listing 中），
  // 因此 was_discovered 始终为 true。is_remote 让 BQ 查询能够区分
  // 远程与本地调用，而无需按技能名前缀做连接。
  const queryDepth = context.queryTracking?.depth ?? 0
  const parentAgentId = getAgentContext()?.agentId
  logEvent('limkenion_skill_tool_invocation', {
    command_name:
      'remote_skill' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // _PROTO_skill_name 路由到有权限的 skill_name BQ 列
    // （未脱敏，面向所有用户）；command_name 保留在 additional_metadata 中
    // 作为脱敏变体。
    _PROTO_skill_name:
      commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    execution_context:
      'remote' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: (queryDepth > 0
      ? 'nested-skill'
      : 'limkenion-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    query_depth: queryDepth,
    ...(parentAgentId && {
      parent_agent_id:
        parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    was_discovered: true,
    is_remote: true,
    remote_cache_hit: cacheHit,
    remote_load_latency_ms: latencyMs,
    
  })

  recordSkillUsage(commandName)

  logForDebugging(
    `SkillTool loaded remote skill ${slug} (cacheHit=${cacheHit}, ${latencyMs}ms, ${content.length} chars)`,
  )

  // 在添加头部之前剥离 YAML frontmatter（---\nname: x\n---）
  // （与 loadSkillsDir.ts:333 一致）。若不存在 frontmatter，
  // parseFrontmatter 会原样返回内容。
  const { content: bodyContent } = parseFrontmatter(content, skillPath)

  // 注入基础目录头部 + ${LIMKENION_SKILL_DIR}/${LIMKENION_SESSION_ID}
  // 替换（与 loadSkillsDir.ts 一致），以便模型能够针对缓存目录
  // 解析诸如 ./schemas/foo.json 的相对引用。
  const skillDir = dirname(skillPath)
  const normalizedDir =
    process.platform === 'win32' ? skillDir.replace(/\\/g, '/') : skillDir
  let finalContent = `Base directory for this skill: ${normalizedDir}\n\n${bodyContent}`
  finalContent = finalContent.replace(/\$\{LIMKENION_SKILL_DIR\}/g, normalizedDir)
  finalContent = finalContent.replace(
    /\$\{LIMKENION_SESSION_ID\}/g,
    getSessionId(),
  )

  // 注册到上下文压缩保留状态。使用缓存的文件路径，以便
  // 压缩后恢复时知道内容来自何处。必须使用
  // finalContent（而非原始内容），这样基础目录头部和
  // ${LIMKENION_SKILL_DIR} 替换才能在压缩后保留 —— 与本地
  // 技能通过 processSlashCommand 存储已转换内容的方式一致。
  addInvokedSkill(
    commandName,
    skillPath,
    finalContent,
    getAgentContext()?.agentId ?? null,
  )

  // 直接注入 —— 将 SKILL.md 内容包装进一条 meta 用户消息。与
  // processPromptSlashCommand 为简单技能产出的结构一致。
  const toolUseID = getToolUseIDFromParentMessage(
    parentMessage,
    SKILL_TOOL_NAME,
  )
  return {
    data: { success: true, commandName, status: 'inline' },
    newMessages: tagMessagesWithToolUseID(
      [createUserMessage({ content: finalContent, isMeta: true })],
      toolUseID,
    ),
  }
}
