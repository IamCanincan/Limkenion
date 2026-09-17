import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { formatAgentId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getResolvedTeammateMode } from '../../utils/swarm/backends/registry.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import type { TeamFile } from '../../utils/swarm/teamHelpers.js'
import {
  getTeamFilePath,
  readTeamFile,
  registerTeamForSessionCleanup,
  sanitizeName,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import { assignTeammateColor } from '../../utils/swarm/teammateLayoutManager.js'
import {
  ensureTasksDir,
  resetTaskList,
  setLeaderTeamName,
} from '../../utils/tasks.js'
import { generateWordSlug } from '../../utils/words.js'
import { TEAM_CREATE_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    team_name: z.string().describe('要创建的新团队的名称。'),
    description: z.string().optional().describe('团队描述/用途。'),
    agent_type: z
      .string()
      .optional()
      .describe(
        '团队负责人的类型/角色（例如"研究员"、"测试运行者"）。' +
          '用于团队文件和代理间协同。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Output = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}

export type Input = z.infer<InputSchema>

/**
 * 通过检查所提供的名称是否已存在来生成唯一团队名称。
 * 若名称已存在，则生成新的词 slug。
 */
function generateUniqueTeamName(providedName: string): string {
  // 若团队不存在，则使用所提供的名称
  if (!readTeamFile(providedName)) {
    return providedName
  }

  // 团队已存在，生成新的唯一名称
  return generateWordSlug()
}

export const TeamCreateTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_CREATE_TOOL_NAME,
  searchHint: 'create a multi-agent swarm team',
  maxResultSizeChars: 100_000,
  shouldDefer: true,

  userFacingName() {
    return ''
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return isAgentSwarmsEnabled()
  },

  toAutoClassifierInput(input) {
    return input.team_name
  },

  async validateInput(input, _context) {
    if (!input.team_name || input.team_name.trim().length === 0) {
      return {
        result: false,
        message: 'team_name is required for TeamCreate',
        errorCode: 9,
      }
    }
    return { result: true }
  },

  async description() {
    return 'Create a new team for coordinating multiple agents'
  },

  async prompt() {
    return getPrompt()
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: jsonStringify(data),
        },
      ],
    }
  },

  async call(input, context) {
    const { setAppState, getAppState } = context
    const { team_name, description: _description, agent_type } = input

    // 检查是否已在某个团队中 - 每个 leader 只允许一个团队
    const appState = getAppState()
    const existingTeam = appState.teamContext?.teamName

    if (existingTeam) {
      throw new Error(
        `Already leading team "${existingTeam}". A leader can only manage one team at a time. Use TeamDelete to end the current team before creating a new one.`,
      )
    }

    // 若团队已存在，则生成唯一名称而不是失败
    const finalTeamName = generateUniqueTeamName(team_name)

    // 为团队 leader 生成确定性的 agent ID
    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, finalTeamName)
    const leadAgentType = agent_type || TEAM_LEAD_NAME
    // 从 AppState 获取团队 leader 的当前模型（处理会话模型、设置、CLI 覆盖）
    const leadModel = parseUserSpecifiedModel(
      appState.mainLoopModelForSession ??
        appState.mainLoopModel ??
        getDefaultMainLoopModel(),
    )

    const teamFilePath = getTeamFilePath(finalTeamName)

    const teamFile: TeamFile = {
      name: finalTeamName,
      description: _description,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: getSessionId(), // 存储实际会话 ID 用于团队发现
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: leadAgentType,
          model: leadModel,
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: getCwd(),
          subscriptions: [],
        },
      ],
    }

    await writeTeamFileAsync(finalTeamName, teamFile)
    // 跟踪以便会话结束时清理 —— 团队此前会永远留在磁盘上，
    // 除非显式执行 TeamDelete（gh-32730）。
    registerTeamForSessionCleanup(finalTeamName)

    // 重置并创建对应的任务列表目录（Team = Project = TaskList）
    // 这确保每个新 swarm 的任务编号都从 1 重新开始
    const taskListId = sanitizeName(finalTeamName)
    await resetTaskList(taskListId)
    await ensureTasksDir(taskListId)

    // 注册团队名称，使 getTaskListId() 为 leader 返回它。
    // 否则 leader 会落到 getSessionId()，从而把任务写到
    // 与 tmux/iTerm2 teammate 期望不同的目录。
    setLeaderTeamName(sanitizeName(finalTeamName))

    // 用团队上下文更新 AppState
    setAppState(prev => ({
      ...prev,
      teamContext: {
        teamName: finalTeamName,
        teamFilePath,
        leadAgentId,
        teammates: {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: leadAgentType,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: '',
            tmuxPaneId: '',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }))

    logEvent('limkenion_team_created', {
      team_name:
        finalTeamName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      teammate_count: 1,
      lead_agent_type:
        leadAgentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      teammate_mode:
        getResolvedTeammateMode() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 注意：我们有意不为团队 leader 设置 LIMKENION_AGENT_ID，因为：
    // 1. leader 不是 "teammate" - isTeammate() 对它们应返回 false
    // 2. 它们的 ID 是确定性的（team-lead@teamName），需要时可推导得出
    // 3. 设置它会导致 isTeammate() 返回 true，破坏收件箱轮询
    // 团队名称存储在 AppState.teamContext 中，而非 process.env

    return {
      data: {
        team_name: finalTeamName,
        team_file_path: teamFilePath,
        lead_agent_id: leadAgentId,
      },
    }
  },

  renderToolUseMessage,
} satisfies ToolDef<InputSchema, Output>)
