import { feature } from 'bun:bundle'
import { writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import {
  buildTool,
  type Tool,
  type ToolDef,
  toolMatchesName,
} from '../../Tool.js'
import { formatAgentId, generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  setAwaitingPlanApproval,
} from '../../utils/inProcessTeammateHelpers.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from '../../utils/plans.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentName,
  getTeamName,
  isPlanModeRequired,
  isTeammate,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from './constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null
const permissionSetupModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/permissionSetup.js') as typeof import('../../utils/permissions/permissionSetup.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 基于提示词的权限请求的 schema。
 * 用于在退出计划模式时请求语义化权限。
 */
const allowedPromptSchema = lazySchema(() =>
  z.object({
    tool: z.enum(['Bash']).describe('此提示词所适用的工具'),
    prompt: z
      .string()
      .describe(
        '动作的语义描述，例如 "运行测试"、"安装依赖"',
      ),
  }),
)

export type AllowedPrompt = z.infer<ReturnType<typeof allowedPromptSchema>>

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      // 计划请求的基于提示词的权限
      allowedPrompts: z
        .array(allowedPromptSchema())
        .optional()
        .describe(
          '实施该计划所需的基于提示词的权限。这些描述的是行为类别，而非具体命令。',
        ),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 面向 SDK 的输入 schema——包含 normalizeToolInput 注入的字段。
 * 内部 inputSchema 没有这些字段，因为计划是从磁盘读取的，
 * 但 SDK/hooks 会看到包含计划与文件路径的规范化版本。
 */
export const _sdkInputSchema = lazySchema(() =>
  inputSchema().extend({
    plan: z
      .string()
      .optional()
      .describe('计划内容（由 normalizeToolInput 从磁盘注入）'),
    planFilePath: z
      .string()
      .optional()
      .describe('计划文件路径（由 normalizeToolInput 注入）'),
  }),
)

export const outputSchema = lazySchema(() =>
  z.object({
    plan: z
      .string()
      .nullable()
      .describe('呈现给用户的计划'),
    isAgent: z.boolean(),
    filePath: z
      .string()
      .optional()
      .describe('计划保存到的文件路径'),
    hasTaskTool: z
      .boolean()
      .optional()
      .describe('当前上下文中是否有可用的 Agent 工具'),
    planWasEdited: z
      .boolean()
      .optional()
      .describe(
        '当用户编辑了计划（CCR Web UI 或 Ctrl+G）时为 true；决定计划是否在 tool_result 中被回显',
      ),
    awaitingLeaderApproval: z
      .boolean()
      .optional()
      .describe(
        '为 true 时，表示队友已将计划审批请求发送给团队负责人',
      ),
    requestId: z
      .string()
      .optional()
      .describe('计划审批请求的唯一标识符'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ExitPlanModeV2Tool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_PLAN_MODE_V2_TOOL_NAME,
  searchHint: 'present plan for approval and start coding (plan mode only)',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Prompts the user to exit plan mode and start coding'
  },
  async prompt() {
    return EXIT_PLAN_MODE_V2_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  shouldDefer: true,
  isEnabled() {
    // 当 --channels 生效时，用户很可能在 Telegram/Discord 上，
    // 而不是盯着 TUI。计划审批对话框会挂起。与 EnterPlanMode 上的
    // 同一门控配对，以免计划模式成为陷阱。
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false // 现在写入磁盘
  },
  requiresUserInteraction() {
    // 对所有 teammate 都无需本地用户交互：
    // - 若 isPlanModeRequired()：由团队负责人通过邮箱审批
    // - 否则：本地直接退出，无需审批（自愿计划模式）
    if (isTeammate()) {
      return false
    }
    // 对非 teammate，退出计划模式需要用户确认
    return true
  },
  async validateInput(_input, { getAppState, options }) {
    // teammate 的 AppState 可能显示负责人的模式（runAgent.ts 在
    // acceptEdits/bypassPermissions/auto 下跳过覆盖）；isPlanModeRequired() 才是真正的依据
    if (isTeammate()) {
      return { result: true }
    }
    // 延迟工具列表无论模式如何都会声明此工具，因此
    // 模型可在计划获批后调用它（在上下文压缩/清空时重新下发增量）。
    // 在 checkPermissions 之前拒绝，以免展示审批对话框。
    const mode = getAppState().toolPermissionContext.mode
    if (mode !== 'plan') {
      logEvent('limkenion_exit_plan_mode_called_outside_plan', {
        model:
          options.mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        hasExitedPlanModeInSession: hasExitedPlanModeInSession(),
      })
      return {
        result: false,
        message:
          'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    // 对所有 teammate 都绕过权限 UI，以免发送 permission_request
    // call() 方法会处理相应的行为：
    // - 若 isPlanModeRequired()：向负责人发送 plan_approval_request
    // - 否则：本地退出计划模式（自愿计划模式）
    if (isTeammate()) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
      }
    }

    // 对非 teammate，退出计划模式需要用户确认
    return {
      behavior: 'ask' as const,
      message: 'Exit plan mode?',
      updatedInput: input,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(input, context) {
    const isAgent = !!context.agentId

    const filePath = getPlanFilePath(context.agentId)
    // CCR Web UI 可能通过 permissionResult.updatedInput 发送编辑过的计划。
    // queryHelpers.ts 会整体替换 finalInput，因此当 CCR 发送 {}（无编辑）时
    // input.plan 为 undefined -> 降级到磁盘。内部 inputSchema 省略了
    // `plan`（通常由 normalizeToolInput 注入），故需此处收窄类型。
    const inputPlan =
      'plan' in input && typeof input.plan === 'string' ? input.plan : undefined
    const plan = inputPlan ?? getPlan(context.agentId)

    // 同步磁盘，使 VerifyPlanExecution / Read 能看到该编辑。之后
    // 重新生成快照：另一个 persistFileSnapshotIfRemote 调用（api.ts）
    // 运行于 normalizeToolInput 中、权限检查之前——它捕获的是旧计划。
    if (inputPlan !== undefined && filePath) {
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      void persistFileSnapshotIfRemote()
    }

    // 检查这是否是需要负责人审批的 teammate
    if (isTeammate() && isPlanModeRequired()) {
      // 对 plan_mode_required 的 teammate 而言计划是必需的
      if (!plan) {
        throw new Error(
          `No plan file found at ${filePath}. Please write your plan to this file before calling ExitPlanMode.`,
        )
      }
      const agentName = getAgentName() || 'unknown'
      const teamName = getTeamName()
      const requestId = generateRequestId(
        'plan_approval',
        formatAgentId(agentName, teamName || 'default'),
      )

      const approvalRequest = {
        type: 'plan_approval_request',
        from: agentName,
        timestamp: new Date().toISOString(),
        planFilePath: filePath,
        planContent: plan,
        requestId,
      }

      await writeToMailbox(
        'team-lead',
        {
          from: agentName,
          text: jsonStringify(approvalRequest),
          timestamp: new Date().toISOString(),
        },
        teamName,
      )

      // 更新任务状态以显示等待审批（适用于进程内 teammate）
      const appState = context.getAppState()
      const agentTaskId = findInProcessTeammateTaskId(agentName, appState)
      if (agentTaskId) {
        setAwaitingPlanApproval(agentTaskId, context.setAppState, true)
      }

      return {
        data: {
          plan,
          isAgent: true,
          filePath,
          awaitingLeaderApproval: true,
          requestId,
        },
      }
    }

    // 注意：后台校验钩子是在上下文清空之后于 REPL.tsx 中通过
    // registerPlanVerificationHook() 注册的。在此处注册会在上下文清空时被清除。

    // 确保退出计划模式时模式被更改。
    // 这处理了权限流程未设置模式的情况
    // （例如 PermissionRequest 钩子自动批准但未提供 updatedPermissions 时）。
    const appState = context.getAppState()
    // 在 setAppState 之前计算门控关闭时的降级方案，以便通知用户。
    // 熔断器防御：若 prePlanMode 是类 auto 模式但
    // 门控现已关闭（熔断器或设置禁用），则改为恢复为
    // 'default'。否则 ExitPlanMode 会直接调用 setAutoModeActive(true)
    // 从而绕过熔断器。
    let gateFallbackNotification: string | null = null
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const prePlanRaw = appState.toolPermissionContext.prePlanMode ?? 'default'
      if (
        prePlanRaw === 'auto' &&
        !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
      ) {
        const reason =
          permissionSetupModule?.getAutoModeUnavailableReason() ??
          'circuit-breaker'
        gateFallbackNotification =
          permissionSetupModule?.getAutoModeUnavailableNotification(reason) ??
          'auto mode unavailable'
        logForDebugging(
          `[auto-mode gate @ ExitPlanModeV2Tool] prePlanMode=${prePlanRaw} ` +
            `but gate is off (reason=${reason}) — falling back to default on plan exit`,
          { level: 'warn' },
        )
      }
    }
    if (gateFallbackNotification) {
      context.addNotification?.({
        key: 'auto-mode-gate-plan-exit-fallback',
        text: `plan exit → default · ${gateFallbackNotification}`,
        priority: 'immediate',
        color: 'warning',
        timeoutMs: 10000,
      })
    }

    context.setAppState(prev => {
      if (prev.toolPermissionContext.mode !== 'plan') return prev
      setHasExitedPlanMode(true)
      setNeedsPlanModeExitAttachment(true)
      let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        if (
          restoreMode === 'auto' &&
          !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
        ) {
          restoreMode = 'default'
        }
        const finalRestoringAuto = restoreMode === 'auto'
        // 捕获恢复前的状态——isAutoModeActive() 是权威
        // 信号（在 transitionPlanAutoMode 于计划中途停用后，
        // prePlanMode/strippedDangerousRules 已失效）。
        const autoWasUsedDuringPlan =
          autoModeStateModule?.isAutoModeActive() ?? false
        autoModeStateModule?.setAutoModeActive(finalRestoringAuto)
        if (autoWasUsedDuringPlan && !finalRestoringAuto) {
          setNeedsAutoModeExitAttachment(true)
        }
      }
      // 若恢复到非 auto 模式且权限已被剥离（无论是
      // 从 auto 进入计划模式，还是由 shouldPlanUseAutoMode 导致），
      // 则恢复它们。若恢复到 auto，则保持剥离状态。
      const restoringToAuto = restoreMode === 'auto'
      let baseContext = prev.toolPermissionContext
      if (restoringToAuto) {
        baseContext =
          permissionSetupModule?.stripDangerousPermissionsForAutoMode(
            baseContext,
          ) ?? baseContext
      } else if (prev.toolPermissionContext.strippedDangerousRules) {
        baseContext =
          permissionSetupModule?.restoreDangerousPermissions(baseContext) ??
          baseContext
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...baseContext,
          mode: restoreMode,
          prePlanMode: undefined,
        },
      }
    })

    const hasTaskTool =
      isAgentSwarmsEnabled() &&
      context.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))

    return {
      data: {
        plan,
        isAgent,
        filePath,
        hasTaskTool: hasTaskTool || undefined,
        planWasEdited: inputPlan !== undefined || undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(
    {
      isAgent,
      plan,
      filePath,
      hasTaskTool,
      planWasEdited,
      awaitingLeaderApproval,
      requestId,
    },
    toolUseID,
  ) {
    // 处理等待负责人审批的 teammate
    if (awaitingLeaderApproval) {
      return {
        type: 'tool_result',
        content: `Your plan has been submitted to the team lead for approval.

Plan file: ${filePath}

**What happens next:**
1. Wait for the team lead to review your plan
2. You will receive a message in your inbox with approval/rejection
3. If approved, you can proceed with implementation
4. If rejected, refine your plan based on the feedback

**Important:** Do NOT proceed until you receive approval. Check your inbox for response.

Request ID: ${requestId}`,
        tool_use_id: toolUseID,
      }
    }

    if (isAgent) {
      return {
        type: 'tool_result',
        content:
          'User has approved the plan. There is nothing else needed from you now. Please respond with "ok"',
        tool_use_id: toolUseID,
      }
    }

    // 处理空计划
    if (!plan || plan.trim() === '') {
      return {
        type: 'tool_result',
        content: 'User has approved exiting plan mode. You can now proceed.',
        tool_use_id: toolUseID,
      }
    }

    const teamHint = hasTaskTool
      ? `\n\nIf this plan can be broken down into multiple independent tasks, consider using the ${TEAM_CREATE_TOOL_NAME} tool to create a team and parallelize the work.`
      : ''

    // 始终包含计划——Ultraplan CCR 流程中的 extractApprovedPlan()
    // 会解析 tool_result 以取回计划文本供本地 CLI 使用。
    // 为编辑过的计划打标签，让模型知道用户做了修改。
    const planLabel = planWasEdited
      ? 'Approved Plan (edited by user)'
      : 'Approved Plan'

    return {
      type: 'tool_result',
      content: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${filePath}
You can refer back to it if needed during implementation.${teamHint}

## ${planLabel}:
${plan}`,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
