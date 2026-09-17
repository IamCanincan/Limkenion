/**
 * 团队伙伴创建的共享 spawn 模块。
 * 从 TeammateTool 中抽取，便于 AgentTool 复用。
 */

import React from 'react'
import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
  getSessionId,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatAgentId } from '../../utils/agentId.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { isTmuxAvailable } from '../../utils/swarm/backends/detection.js'
import {
  detectAndGetBackend,
  getBackendByType,
  isInProcessEnabled,
  markInProcessFallback,
  resetBackendDetection,
} from '../../utils/swarm/backends/registry.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  SWARM_SESSION_NAME,
  TEAM_LEAD_NAME,
  TEAMMATE_COMMAND_ENV_VAR,
  TMUX_COMMAND,
} from '../../utils/swarm/constants.js'
import { It2SetupPrompt } from '../../utils/swarm/It2SetupPrompt.js'
import { startInProcessTeammate } from '../../utils/swarm/inProcessRunner.js'
import {
  type InProcessSpawnConfig,
  spawnInProcessTeammate,
} from '../../utils/swarm/spawnInProcess.js'
import { buildInheritedEnvVars } from '../../utils/swarm/spawnUtils.js'
import {
  readTeamFileAsync,
  sanitizeAgentName,
  sanitizeName,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import {
  assignTeammateColor,
  createTeammatePaneInSwarmView,
  enablePaneBorderStatus,
  isInsideTmux,
  sendCommandToPane,
} from '../../utils/swarm/teammateLayoutManager.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { registerTask } from '../../utils/task/framework.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import type { CustomAgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { isCustomAgent } from '../AgentTool/loadAgentsDir.js'

function getDefaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (configured === null) {
    // 用户在 /config 选择器中选了"默认"——跟随主控模型。
    return leaderModel ?? getHardcodedTeammateModelFallback()
  }
  if (configured !== undefined) {
    return parseUserSpecifiedModel(configured)
  }
  return getHardcodedTeammateModelFallback()
}

/**
 * 解析团队伙伴模型值。处理 'inherit' 别名（来自 agent 的 frontmatter），
 * 用主控的模型替换。gh-31069: 'inherit' 被直接传给 --model，导致
 * "It may not exist or you may not have access" 报错。若主控模型为空（尚未设置），
 * 则回退到默认值。
 *
 * 导出用于测试。
 */
export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    return leaderModel ?? getDefaultTeammateModel(leaderModel)
  }
  return inputModel ?? getDefaultTeammateModel(leaderModel)
}

// ============================================================================
// 类型
// ============================================================================

export type SpawnOutput = {
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}

export type SpawnTeammateConfig = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  /** request_id 是需要解析的 api 调用的 request_id，其响应中包含 spawn 此团队伙伴
   *  的 tool_use。它会被贯穿传递给 TeammateAgentContext，用于在
   *  limkenion_api_* 事件上做溯源追踪。 */
  invokingRequestId?: string
}

// 内部输入类型，匹配 TeammateTool 的 spawn 参数
type SpawnInput = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  invokingRequestId?: string
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 检查 tmux 会话是否存在
 */
async function hasSession(sessionName: string): Promise<boolean> {
  const result = await execFileNoThrow(TMUX_COMMAND, [
    'has-session',
    '-t',
    sessionName,
  ])
  return result.code === 0
}

/**
 * 若 tmux 会话不存在则创建它
 */
async function ensureSession(sessionName: string): Promise<void> {
  const exists = await hasSession(sessionName)
  if (!exists) {
    const result = await execFileNoThrow(TMUX_COMMAND, [
      'new-session',
      '-d',
      '-s',
      sessionName,
    ])
    if (result.code !== 0) {
      throw new Error(
        `Failed to create tmux session '${sessionName}': ${result.stderr || 'Unknown error'}`,
      )
    }
  }
}

/**
 * 获取 spawn 团队伙伴的命令。
 * 原生构建（编译后的二进制）使用 process.execPath。
 * 非原生（node/bun 运行脚本）使用 process.argv[1]。
 */
function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * 构建需要从当前会话传播给被 spawn 的团队伙伴的 CLI flags。
 * 这样团队伙伴能继承父级的重要设置，如权限模式、模型选择与插件配置。
 *
 * @param options.planModeRequired - 若为 true，不继承绕过权限（计划模式优先）
 * @param options.permissionMode - 需要传播的权限模式
 */
function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // 把权限模式传播给团队伙伴，但计划模式需要时除外
  // 出于安全考虑，计划模式优先于绕过权限
  if (planModeRequired) {
    // 计划模式需要时，不继承绕过权限
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  } else if (permissionMode === 'auto') {
    // 团队伙伴继承 auto 模式，使分类器也能自动批准它们的工具
    // 调用。团队伙伴自身的启动逻辑（permissionSetup.ts）独立处理
    // GrowthBook 门控检查并调用 setAutoModeActive(true)。
    flags.push('--permission-mode auto')
  }

  // 若在 CLI 显式设置，则传播 --model
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // 若在 CLI 显式设置，则传播 --settings
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // 为每个内联插件传播 --plugin-dir
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // 若在 CLI 显式设置，则传播 --chrome / --no-chrome
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * 通过检查现有团队成员生成唯一的团队伙伴名。
 * 若名字已存在，追加数字后缀（例如 tester-2、tester-3）。
 * @internal 导出用于测试
 */
export async function generateUniqueTeammateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) {
    return baseName
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    return baseName
  }

  const existingNames = new Set(teamFile.members.map(m => m.name.toLowerCase()))

  // 若基础名不存在，则原样使用
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName
  }

  // 寻找下一个可用后缀
  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix++
  }

  return `${baseName}-${suffix}`
}

// ============================================================================
// Spawn 处理器
// ============================================================================

/**
 * 使用分屏视图（默认）处理 spawn 操作。
 * 在 tmux 内部：在共享窗口中创建团队伙伴，主控在左、团队伙伴在右。
 * 在 tmux 外部：创建 limkenion-swarm 会话，所有团队伙伴平铺排布。
 */
async function handleSpawnSplitPane(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // 解析模型：'inherit' → 主控模型；undefined → 默认 deepseek-v4-pro
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('spawn 操作需要 name 和 prompt')
  }

  // 从输入获取团队名，或继承主控的团队上下文
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'spawn 操作需要 team_name。请在输入中提供 team_name，或先调用 spawnTeam 建立团队上下文。',
    )
  }

  // 若团队中存在重复名，生成唯一名字
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // 净化名字，防止 @ 出现在 agent ID 中（会破坏 agentName@teamName 格式）
  const sanitizedName = sanitizeAgentName(uniqueName)

  // 由名字和团队生成确定性的 agent ID
  const teammateId = formatAgentId(sanitizedName, teamName)
  const workingDir = cwd || getCwd()

  // 检测合适的后端，并检查是否需要进行设置
  let detectionResult = await detectAndGetBackend()

  // 若在 iTerm2 中但 it2 未设置，则提示用户
  if (detectionResult.needsIt2Setup && context.setToolJSX) {
    const tmuxAvailable = await isTmuxAvailable()

    // 显示设置提示并等待用户决定
    const setupResult = await new Promise<
      'installed' | 'use-tmux' | 'cancelled'
    >(resolve => {
      context.setToolJSX!({
        jsx: React.createElement(It2SetupPrompt, {
          onDone: resolve,
          tmuxAvailable,
        }),
        shouldHidePromptInput: true,
      })
    })

    // 清除 JSX
    context.setToolJSX(null)

    if (setupResult === 'cancelled') {
      throw new Error('团队伙伴 spawn 已取消 - 需要 iTerm2 设置')
    }

    // 若用户安装了 it2 或选择了 tmux，清除缓存的检测结果并重新拉取，
    // 使本地的 detectionResult 与真正用于创建 pane 的后端一致。
    // - 'installed': 重新检测以采用 ITermBackend（现在 it2 可用）
    // - 'use-tmux': 重新检测使 needsIt2Setup 为 false（preferTmux 已保存）
    //   并且后续 spawn 会跳过此提示
    if (setupResult === 'installed' || setupResult === 'use-tmux') {
      resetBackendDetection()
      detectionResult = await detectAndGetBackend()
    }
  }

  // 检查是否位于 tmux 内部，以确定会话命名方式
  const insideTmux = await isInsideTmux()

  // 为该团队伙伴分配唯一颜色
  const teammateColor = assignTeammateColor(teammateId)

  // 在 swarm 视图中创建 pane
  // - 在 tmux 内部：分割当前窗口（主控在左、团队伙伴在右）
  // - 在带 it2 的 iTerm2 中：使用原生 iTerm2 分屏
  // - 两者之外：创建 limkenion-swarm 会话并平铺团队伙伴
  const { paneId, isFirstTeammate } = await createTeammatePaneInSwarmView(
    sanitizedName,
    teammateColor,
  )

  // 在 tmux 内部时，为第一个团队伙伴启用 pane 边框状态
  // （在 tmux 外部，由 createTeammatePaneInSwarmView 处理）
  if (isFirstTeammate && insideTmux) {
    await enablePaneBorderStatus()
  }

  // 构建以团队伙伴身份 spawn Limkenion 的命令
  // 注意：spawn 时不带 prompt - 初始指令通过 mailbox 发送
  const binaryPath = getTeammateCommand()

  // 构建团队伙伴身份的 CLI 参数（替代 LIMKENION_* 环境变量）
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // 构建需要传播给团队伙伴的 CLI flags
  // 传入 plan_mode_required，防止继承绕过权限
  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
  })

  // 若团队伙伴有自定义模型，添加 --model flag（或替换继承的同名 flag）
  if (model) {
    // 先移除任何继承的 --model flag
    inheritedFlags = inheritedFlags
      .split(' ')
      .filter((flag, i, arr) => flag !== '--model' && arr[i - 1] !== '--model')
      .join(' ')
    // 再添加团队伙伴的模型
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // 传播团队伙伴需要但可能无法从 tmux 分屏 shell 继承的环境变量。
  // 包括 LIMKENIONCODE、LIMKENION_EXPERIMENTAL_AGENT_TEAMS 及各 API provider 变量。
  const envStr = buildInheritedEnvVars()
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // 向新 pane 发送命令
  // 在 tmux 外部运行时使用 swarm socket（外部 swarm 会话）
  await sendCommandToPane(paneId, spawnCommand, !insideTmux)

  // 确定输出的会话/窗口名
  const sessionName = insideTmux ? 'current' : SWARM_SESSION_NAME
  const windowName = insideTmux ? 'current' : 'swarm-view'

  // 在 AppState 的 teamContext 中（带颜色）跟踪团队伙伴
  // 若在没有 spawnTeam 的情况下 spawn，则将主控设置为主控方
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: sessionName,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // 注册后台任务，使团队伙伴出现在 task 胶囊/对话框中
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType: detectionResult.backend.type,
    toolUseId: context.toolUseId,
  })

  // 在团队文件中注册 agent
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `团队 "${teamName}" 不存在。请先调用 spawnTeam 创建团队。`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: detectionResult.backend.type,
  })
  await writeTeamFileAsync(teamName, teamFile)

  // 通过 mailbox 向团队伙伴发送初始指令
  // 团队伙伴的 inbox 轮询器会取走这条消息，并将其作为其首轮提交
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: sessionName,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: true,
      plan_mode_required,
    },
  }
}

/**
 * 处理使用独立窗口（旧行为）的 spawn 操作。
 * 每个团队伙伴创建在自己的 tmux 窗口中。
 */
async function handleSpawnSeparateWindow(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // 解析模型：'inherit' → 主控模型；undefined → 默认 deepseek-v4-pro
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('spawn 操作需要 name 和 prompt')
  }

  // 从输入获取团队名，或继承主控的团队上下文
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'spawn 操作需要 team_name。请在输入中提供 team_name，或先调用 spawnTeam 建立团队上下文。',
    )
  }

  // 若团队中存在重复名，生成唯一名字
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // 净化名字，防止 @ 出现在 agent ID 中（会破坏 agentName@teamName 格式）
  const sanitizedName = sanitizeAgentName(uniqueName)

  // 由名字和团队生成确定性的 agent ID
  const teammateId = formatAgentId(sanitizedName, teamName)
  const windowName = `teammate-${sanitizeName(sanitizedName)}`
  const workingDir = cwd || getCwd()

  // 确保 swarm 会话存在
  await ensureSession(SWARM_SESSION_NAME)

  // 为该团队伙伴分配唯一颜色
  const teammateColor = assignTeammateColor(teammateId)

  // 为该团队伙伴创建一个新窗口
  const createWindowResult = await execFileNoThrow(TMUX_COMMAND, [
    'new-window',
    '-t',
    SWARM_SESSION_NAME,
    '-n',
    windowName,
    '-P',
    '-F',
    '#{pane_id}',
  ])

  if (createWindowResult.code !== 0) {
    throw new Error(
      `创建 tmux 窗口失败: ${createWindowResult.stderr}`,
    )
  }

  const paneId = createWindowResult.stdout.trim()

  // 构建以团队伙伴身份 spawn Limkenion 的命令
  // 注意：spawn 时不带 prompt - 初始指令通过 mailbox 发送
  const binaryPath = getTeammateCommand()

  // 构建团队伙伴身份的 CLI 参数（替代 LIMKENION_* 环境变量）
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // 构建需要传播给团队伙伴的 CLI flags
  // 传入 plan_mode_required，防止继承绕过权限
  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
  })

  // 若团队伙伴有自定义模型，添加 --model flag（或替换继承的同名 flag）
  if (model) {
    // 先移除任何继承的 --model flag
    inheritedFlags = inheritedFlags
      .split(' ')
      .filter((flag, i, arr) => flag !== '--model' && arr[i - 1] !== '--model')
      .join(' ')
    // 再添加团队伙伴的模型
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // 传播团队伙伴需要但可能无法从 tmux 分屏 shell 继承的环境变量。
  // 包括 LIMKENIONCODE、LIMKENION_EXPERIMENTAL_AGENT_TEAMS 及各 API provider 变量。
  const envStr = buildInheritedEnvVars()
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // 向新窗口发送命令
  const sendKeysResult = await execFileNoThrow(TMUX_COMMAND, [
    'send-keys',
    '-t',
    `${SWARM_SESSION_NAME}:${windowName}`,
    spawnCommand,
    'Enter',
  ])

  if (sendKeysResult.code !== 0) {
    throw new Error(
      `向 tmux 窗口发送命令失败: ${sendKeysResult.stderr}`,
    )
  }

  // 在 AppState 的 teamContext 中跟踪团队伙伴
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: SWARM_SESSION_NAME,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // 注册后台任务，使 tmux 团队伙伴出现在 task 胶囊/对话框中
  // 独立窗口 spawn 始终在 tmux 外部（外部 swarm 会话）
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux: false,
    backendType: 'tmux',
    toolUseId: context.toolUseId,
  })

  // 在团队文件中注册 agent
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `团队 "${teamName}" 不存在。请先调用 spawnTeam 创建团队。`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: 'tmux', // 此处理器始终直接使用 tmux
  })
  await writeTeamFileAsync(teamName, teamFile)

  // 通过 mailbox 向团队伙伴发送初始指令
  // 团队伙伴的 inbox 轮询器会取走这条消息，并将其作为其首轮提交
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: SWARM_SESSION_NAME,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * 为进程外（tmux/iTerm2）团队伙伴注册一个后台任务条目。
 * 这把 tmux 团队伙伴变为在后台任务胶囊和对话框中可见，
 * 与进程内团队伙伴的跟踪方式一致。
 */
function registerOutOfProcessTeammateTask(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType,
    toolUseId,
  }: {
    teammateId: string
    sanitizedName: string
    teamName: string
    teammateColor: string
    prompt: string
    plan_mode_required?: boolean
    paneId: string
    insideTmux: boolean
    backendType: BackendType
    toolUseId?: string
  },
): void {
  const taskId = generateTaskId('in_process_teammate')
  const description = `${sanitizedName}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

  const abortController = new AbortController()

  const taskState: InProcessTeammateTaskState = {
    ...createTaskStateBase(
      taskId,
      'in_process_teammate',
      description,
      toolUseId,
    ),
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: teammateId,
      agentName: sanitizedName,
      teamName,
      color: teammateColor,
      planModeRequired: plan_mode_required ?? false,
      parentSessionId: getSessionId(),
    },
    prompt,
    abortController,
    awaitingPlanApproval: false,
    permissionMode: plan_mode_required ? 'plan' : 'default',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingUserMessages: [],
  }

  registerTask(taskState, setAppState)

  // 当收到 abort 信号时，使用创建它的后端杀掉 pane
  // （tmux pane 用 kill-pane，iTerm2 原生 pane 用 it2 session close）。
  // SDK task_notification 书签由 killInProcessTeammate 发出
  // （这是该控制器的唯一 abort 触发元）。
  abortController.signal.addEventListener(
    'abort',
    () => {
      if (isPaneBackend(backendType)) {
        void getBackendByType(backendType).killPane(paneId, !insideTmux)
      }
    },
    { once: true },
  )
}

/**
 * 处理进程内团队伙伴的 spawn 操作。
 * 进程内团队伙伴运行在同一个 Node.js 进程中，使用 AsyncLocalStorage。
 */
async function handleSpawnInProcess(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, plan_mode_required } = input

  // 解析模型：'inherit' → 主控模型；undefined → 默认 deepseek-v4-pro
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('spawn 操作需要 name 和 prompt')
  }

  // 从输入获取团队名，或继承主控的团队上下文
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'spawn 操作需要 team_name。请在输入中提供 team_name，或先调用 spawnTeam 建立团队上下文。',
    )
  }

  // 若团队中存在重复名，生成唯一名字
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // 净化名字，防止 @ 出现在 agent ID 中
  const sanitizedName = sanitizeAgentName(uniqueName)

  // 由名字和团队生成确定性的 agent ID
  const teammateId = formatAgentId(sanitizedName, teamName)

  // 为该团队伙伴分配唯一颜色
  const teammateColor = assignTeammateColor(teammateId)

  // 若提供了 agent_type，则查找自定义 agent 定义
  let agentDefinition: CustomAgentDefinition | undefined
  if (agent_type) {
    const allAgents = context.options.agentDefinitions.activeAgents
    const foundAgent = allAgents.find(a => a.agentType === agent_type)
    if (foundAgent && isCustomAgent(foundAgent)) {
      agentDefinition = foundAgent
    }
    logForDebugging(
      `[handleSpawnInProcess] agent_type=${agent_type}, found=${!!agentDefinition}`,
    )
  }

  // Spawn 进程内的团队伙伴
  const config: InProcessSpawnConfig = {
    name: sanitizedName,
    teamName,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required ?? false,
    model,
  }

  const result = await spawnInProcessTeammate(config, context)

  if (!result.success) {
    throw new Error(result.error ?? '进程内团队伙伴 spawn 失败')
  }

  // 调试：记录 spawn 返回内容
  logForDebugging(
    `[handleSpawnInProcess] spawn result: taskId=${result.taskId}, hasContext=${!!result.teammateContext}, hasAbort=${!!result.abortController}`,
  )

  // 启动 agent 执行循环（fire-and-forget）
  if (result.taskId && result.teammateContext && result.abortController) {
    startInProcessTeammate({
      identity: {
        agentId: teammateId,
        agentName: sanitizedName,
        teamName,
        color: teammateColor,
        planModeRequired: plan_mode_required ?? false,
        parentSessionId: result.teammateContext.parentSessionId,
      },
      taskId: result.taskId,
      prompt,
      description: input.description,
      model,
      agentDefinition,
      teammateContext: result.teammateContext,
      // 剥离消息：团队伙伴从不读取 toolUseContext.messages
      // （它通过 inProcessRunner 里的 allMessages 构建自己的历史）。
      // 把父级的完整对话传进来会使其在团队伙伴整个生命周期内被钉住，
      // 甚至在 /clear 与自动压缩后仍然存活。
      toolUseContext: { ...context, messages: [] },
      abortController: result.abortController,
      invokingRequestId: input.invokingRequestId,
    })
    logForDebugging(
      `[handleSpawnInProcess] Started agent execution for ${teammateId}`,
    )
  }

  // 在 AppState 的 teamContext 中跟踪团队伙伴
  // 若在之前没有 spawnTeam 的情况下 spawn，则自动注册主控
  setAppState(prev => {
    const needsLeaderSetup = !prev.teamContext?.leadAgentId
    const leadAgentId = needsLeaderSetup
      ? formatAgentId(TEAM_LEAD_NAME, teamName)
      : prev.teamContext!.leadAgentId

    // 构建团队成员映射，含需要时为主控提供的 inbox 轮询条目
    const existingTeammates = prev.teamContext?.teammates || {}
    const leadEntry = needsLeaderSetup
      ? {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: TEAM_LEAD_NAME,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'leader',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        }
      : {}

    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
        teamFilePath: prev.teamContext?.teamFilePath ?? '',
        leadAgentId,
        teammates: {
          ...existingTeammates,
          ...leadEntry,
          [teammateId]: {
            name: sanitizedName,
            agentType: agent_type,
            color: teammateColor,
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'in-process',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }
  })

  // 在团队文件中注册 agent
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `团队 "${teamName}" 不存在。请先调用 spawnTeam 创建团队。`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: 'in-process',
    cwd: getCwd(),
    subscriptions: [],
    backendType: 'in-process',
  })
  await writeTeamFileAsync(teamName, teamFile)

  // 注意：对进程内的团队伙伴，不要通过 mailbox 发送 prompt。
  // 进程内团队伙伴通过 startInProcessTeammate() 直接接收 prompt。
  // mailbox 仅对基于 tmux 的团队伙伴需要，它们会轮询自己的初始消息。
  // 若两条路径都发送，会导致重复的欢迎消息。

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * 处理 spawn 操作 - 创建一个新的 Limkenion 实例。
 * 当进程内模式启用时使用进程内模式，否则使用 tmux/iTerm2 分屏视图。
 * 若 pane 后端检测失败（例如没有 it2 CLI 的 iTerm2 或未安装 tmux），
 * 则回退到进程内模式。
 */
async function handleSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  // 检查特征开关是否启用了进程内模式
  if (isInProcessEnabled()) {
    return handleSpawnInProcess(input, context)
  }

  // 预检：在尝试基于 pane 的 spawn 之前，确保 pane 后端可用。
  // 用于处理 auto 模式的情况，例如没有 it2 或 tmux 的 iTerm2，
  // 此时 isInProcessEnabled() 返回 false 但 detectAndGetBackend() 没有可用后端。
  // 范围很小，用户取消和其他 spawn 错误照常传播。
  try {
    await detectAndGetBackend()
  } catch (error) {
    // 仅在 auto 模式下静默回退。若用户显式配置了
    // teammateMode: 'tmux'，让错误传播，以便看到来自
    // getTmuxInstallInstructions() 的可操作安装说明。
    if (getTeammateModeFromSnapshot() !== 'auto') {
      throw error
    }
    logForDebugging(
      `[handleSpawn] 无可用 pane 后端，回退到进程内: ${errorMessage(error)}`,
    )
    // 记录回退，使 isInProcessEnabled() 反映实际模式
    // （修复横幅及其他 UI，否则会显示 tmux attach 命令）。
    markInProcessFallback()
    return handleSpawnInProcess(input, context)
  }

  // 后端可用（现已缓存）- 继续进行 pane spawn。
  // 此处的任何错误（用户取消、校验等）都会传播给调用方。
  const useSplitPane = input.use_splitpane !== false
  if (useSplitPane) {
    return handleSpawnSplitPane(input, context)
  }
  return handleSpawnSeparateWindow(input, context)
}

// ============================================================================
// 主导出
// ============================================================================

/**
 * 使用给定配置 spawn 一个新的团队伙伴。
 * 这是团队伙伴 spawn 的主要入口，TeammateTool 与 AgentTool 均会使用。
 */
export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  return handleSpawn(config, context)
}
