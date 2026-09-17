import { feature } from 'bun:bundle';
import * as React from 'react';
import { buildTool, type ToolDef, toolMatchesName } from 'src/Tool.js';
import type { Message as MessageType, NormalizedUserMessage } from 'src/types/message.js';
import { getQuerySourceForAgent } from 'src/utils/promptCategory.js';
import { z } from 'zod/v4';
import { clearInvokedSkillsForAgent, getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js';
import { enhanceSystemPromptWithEnvDetails, getSystemPrompt } from '../../constants/prompts.js';
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js';
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { clearDumpState } from '../../services/api/dumpPrompts.js';
import { completeAgentTask as completeAsyncAgent, createActivityDescriptionResolver, createProgressTracker, enqueueAgentNotification, failAgentTask as failAsyncAgent, getProgressUpdate, getTokenCountFromTracker, isLocalAgentTask, killAsyncAgent, registerAgentForeground, registerAsyncAgent, unregisterAgentForeground, updateAgentProgress as updateAsyncAgentProgress, updateProgressFromMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { checkRemoteAgentEligibility, formatPreconditionError, getRemoteTaskSessionUrl, registerRemoteAgentTask } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js';
import { assembleToolPool } from '../../tools.js';
import { asAgentId } from '../../types/ids.js';
import { runWithAgentContext } from '../../utils/agentContext.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js';
import { logForDebugging } from '../../utils/debug.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { AbortError, errorMessage, toError } from '../../utils/errors.js';
import type { CacheSafeParams } from '../../utils/forkedAgent.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { createUserMessage, extractTextContent, isSyntheticMessage, normalizeMessages } from '../../utils/messages.js';
import { getAgentModel } from '../../utils/model/agent.js';
import { permissionModeSchema } from '../../utils/permissions/PermissionMode.js';
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js';
import { filterDeniedAgents, getDenyRuleForAgent } from '../../utils/permissions/permissions.js';
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js';
import { writeAgentMetadata } from '../../utils/sessionStorage.js';
import { sleep } from '../../utils/sleep.js';
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js';
import { asSystemPrompt } from '../../utils/systemPromptType.js';
import { getTaskOutputPath } from '../../utils/task/diskOutput.js';
import { getParentSessionId, isTeammate } from '../../utils/teammate.js';
import { isInProcessTeammate } from '../../utils/teammateContext.js';
import { teleportToRemote } from '../../utils/teleport.js';
import { getAssistantMessageContentLength } from '../../utils/tokens.js';
import { createAgentId } from '../../utils/uuid.js';
import { createAgentWorktree, hasWorktreeChanges, removeAgentWorktree } from '../../utils/worktree.js';
import { BASH_TOOL_NAME } from '../BashTool/toolName.js';
import { BackgroundHint } from '../BashTool/UI.js';
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js';
import { spawnTeammate } from '../shared/spawnMultiAgent.js';
import { setAgentColor } from './agentColorManager.js';
import { agentToolResultSchema, classifyHandoffIfNeeded, emitTaskProgress, extractPartialResult, finalizeAgentTool, getLastToolUseName, runAsyncAgentLifecycle } from './agentToolUtils.js';
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js';
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME, ONE_SHOT_BUILTIN_AGENT_TYPES } from './constants.js';
import { buildForkedMessages, buildWorktreeNotice, FORK_AGENT, isForkSubagentEnabled, isInForkChild } from './forkSubagent.js';
import type { AgentDefinition } from './loadAgentsDir.js';
import { filterAgentsByMcpRequirements, hasRequiredMcpServers, isBuiltInAgent } from './loadAgentsDir.js';
import { getPrompt } from './prompt.js';
import { runAgent } from './runAgent.js';
import { renderGroupedAgentToolUse, renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, renderToolUseProgressMessage, renderToolUseRejectedMessage, renderToolUseTag, userFacingName, userFacingNameBackgroundColor } from './UI.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../../proactive/index.js') as typeof import('../../proactive/index.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */

// 进度显示常量（用于展示后台提示）
const PROGRESS_THRESHOLD_MS = 2000; // 2 秒后展示后台提示

// 在模块加载时检查后台任务是否被禁用
const isBackgroundTasksDisabled =
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
isEnvTruthy(process.env.LIMKENION_DISABLE_BACKGROUND_TASKS);

// agent 任务在这么多毫秒后自动转入后台（0 = 禁用）
// 由环境变量或 GrowthBook 开关启用（延迟检查，因为模块加载时 GB 可能尚未就绪）
function getAutoBackgroundMs(): number {
  if (isEnvTruthy(process.env.LIMKENION_AUTO_BACKGROUND_TASKS) || getFeatureValue_CACHED_MAY_BE_STALE('limkenion_auto_background_agents', false)) {
    return 120_000;
  }
  return 0;
}

// 多 agent 类型常量内联定义在受开关保护的代码块中，以便进行死代码消除

// 基础输入 schema（不含多代理参数）
const baseInputSchema = lazySchema(() => z.object({
  description: z.string().describe('任务的一句简短描述（3-5 个词）'),
  prompt: z.string().describe('要求代理执行的任务'),
  subagent_type: z.string().optional().describe('用于此任务的专业化代理类型'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional().describe("此代理的可选模型覆盖。优先于代理定义的 model frontmatter。若省略，则使用代理定义中的模型，或继承父级。"),
  run_in_background: z.boolean().optional().describe('设为 true 以在后台运行此代理。运行完成时你会收到通知。')
}));

// 组合 base + 多代理参数 + isolation 的完整 schema
const fullInputSchema = lazySchema(() => {
  // 多代理参数
  const multiAgentInputSchema = z.object({
    name: z.string().optional().describe('生成的代理的名称。运行期间可通过 SendMessage({to: name}) 对其进行寻址。'),
    team_name: z.string().optional().describe('生成所用的团队名称。若省略则使用当前团队上下文。'),
    mode: permissionModeSchema().optional().describe('生成团队成员所需遵循的权限模式（例如 "plan" 表示需要计划审批）。')
  });
  return baseInputSchema().merge(multiAgentInputSchema).extend({
    isolation: (z.enum(['worktree'])).optional().describe('隔离模式。"worktree" 会创建一个临时 git 工作树，使代理在仓库的隔离副本上工作。'),
    cwd: z.string().optional().describe('代理运行所在的绝对路径。覆盖该代理内所有文件系统与 shell 操作的工作目录。与 isolation: "worktree" 互斥。')
  });
});

// 当后备特性关闭时，从 schema 中剔除可选字段，使模型永远看不到它们。
// 用 .omit() 而非 .extend() 中的条件展开来实现，因为展开三元会破坏 Zod 的
// 类型推断（字段类型坍缩为 `unknown`）。三元返回会产生联合类型，但 call()
// 通过下面显式的 AgentToolInput 类型解构，该类型总是包含所有可选字段。
export const inputSchema = lazySchema(() => {
  const schema = feature('KAIROS') ? fullInputSchema() : fullInputSchema().omit({
    cwd: true
  });

  // 此处的 lazySchema GD 中允许使用 GrowthBook（与 subagent_type 不同，
  // 后者已在 906da6c723 中移除）：分歧窗口是通过 _CACHED_MAY_BE_STALE 磁盘
  // 读取实现的一次会话/一次开关翻转，最坏情况要么是"schema 显示一个无效
  // 参数"（会话中途开关翻转：forceAsync 忽略该参数），要么是"schema 隐藏
  // 了本可用的参数"（会话中途开关翻转关闭：一切仍通过记忆化 forceAsync
  // 异步运行）。不会出现 Zod 拒绝、崩溃——不同于必选→可选。
  return isBackgroundTasksDisabled || isForkSubagentEnabled() ? schema.omit({
    run_in_background: true
  }) : schema;
});
type InputSchema = ReturnType<typeof inputSchema>;

// 强制加宽 schema 推断的类型，使其总是包含所有可选字段，即使 .omit()
// 出于门控从 schema 中剥离它们（cwd、run_in_background）。subagent_type 是
// 可选字段；当 fork 门控关闭时 call() 将其默认为通用用途，门控开启时
// 则路由到 fork 路径。
type AgentToolInput = z.infer<ReturnType<typeof baseInputSchema>> & {
  name?: string;
  team_name?: string;
  mode?: z.infer<ReturnType<typeof permissionModeSchema>>;
  isolation?: 'worktree' | 'remote';
  cwd?: string;
};

// 输出 schema——启用时在运行时动态添加生成的多代理 schema
export const outputSchema = lazySchema(() => {
  const syncOutputSchema = agentToolResultSchema().extend({
    status: z.literal('completed'),
    prompt: z.string()
  });
  const asyncOutputSchema = z.object({
    status: z.literal('async_launched'),
    agentId: z.string().describe('异步代理的 ID'),
    description: z.string().describe('任务的描述'),
    prompt: z.string().describe('给代理的提示词'),
    outputFile: z.string().describe('用于检查代理进度的输出文件路径'),
    canReadOutputFile: z.boolean().optional().describe('调用方代理是否具有 Read/Bash 工具来检查进度')
  });
  return z.union([syncOutputSchema, asyncOutputSchema]);
});
type OutputSchema = ReturnType<typeof outputSchema>;
type Output = z.input<OutputSchema>;

// teammate 派生结果的私有类型——为死代码消除而从导出 schema 中排除
// 仅当 ENABLE_AGENT_SWARMS 为 true 时才包含 'teammate_spawned' 状态字符串
type TeammateSpawnedOutput = {
  status: 'teammate_spawned';
  prompt: string;
  teammate_id: string;
  agent_id: string;
  agent_type?: string;
  model?: string;
  name: string;
  color?: string;
  tmux_session_name: string;
  tmux_window_name: string;
  tmux_pane_id: string;
  team_name?: string;
  is_splitpane?: boolean;
  plan_mode_required?: boolean;
};

// 合并的输出类型，同时包含公开类型和内部类型
// 注意：TeammateSpawnedOutput 类型没问题——TypeScript 类型在编译时会被擦除
// 远程启动结果的私有类型——为死代码消除目的，与 TeammateSpawnedOutput 一样
// 从导出 schema 中排除。导出是为了让 UI.tsx 能进行正确的可辨识联合收窄，
// 而不是临时强制类型转换。
export type RemoteLaunchedOutput = {
  status: 'remote_launched';
  taskId: string;
  sessionUrl: string;
  description: string;
  prompt: string;
  outputFile: string;
};
type InternalOutput = Output | TeammateSpawnedOutput | RemoteLaunchedOutput;
import type { AgentToolProgress, ShellProgress } from '../../types/tools.js';
// AgentTool 同时转发自身的进度事件和来自子代理的 shell 进度事件，
// 以便 SDK 在 bash/powershell 运行期间收到 tool_progress 更新。
export type Progress = AgentToolProgress | ShellProgress;
export const AgentTool = buildTool({
  async prompt({
    agents,
    tools,
    getToolPermissionContext,
    allowedAgentTypes
  }) {
    const toolPermissionContext = await getToolPermissionContext();

    // 获取有可用工具的 MCP 服务器
    const mcpServersWithTools: string[] = [];
    for (const tool of tools) {
      if (tool.name?.startsWith('mcp__')) {
        const parts = tool.name.split('__');
        const serverName = parts[1];
        if (serverName && !mcpServersWithTools.includes(serverName)) {
          mcpServersWithTools.push(serverName);
        }
      }
    }

    // 过滤 agent：先按 MCP 要求，再按权限规则
    const agentsWithMcpRequirementsMet = filterAgentsByMcpRequirements(agents, mcpServersWithTools);
    const filteredAgents = filterDeniedAgents(agentsWithMcpRequirementsMet, toolPermissionContext, AGENT_TOOL_NAME);

    // 使用内联环境变量检查而非 coordinatorModule，以避免测试模块加载时的
    // 循环依赖问题。
    const isCoordinator = feature('COORDINATOR_MODE') ? isEnvTruthy(process.env.LIMKENION_COORDINATOR_MODE) : false;
    return await getPrompt(filteredAgents, isCoordinator, allowedAgentTypes);
  },
  name: AGENT_TOOL_NAME,
  searchHint: 'delegate work to a subagent',
  aliases: [LEGACY_AGENT_TOOL_NAME],
  maxResultSizeChars: 100_000,
  async description() {
    return 'Launch a new agent';
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  async call({
    prompt,
    subagent_type,
    description,
    model: modelParam,
    run_in_background,
    name,
    team_name,
    mode: spawnMode,
    isolation,
    cwd
  }: AgentToolInput, toolUseContext, canUseTool, assistantMessage, onProgress?) {
    const startTime = Date.now();
    const model = isCoordinatorMode() ? undefined : modelParam;

    // 获取应用状态以用于权限模式和 agent 过滤
    const appState = toolUseContext.getAppState();
    const permissionMode = appState.toolPermissionContext.mode;
    // 进程内 teammate 得到的是空操作 setAppState；setAppStateForTasks
    // 能触达根 store，使任务注册/进度/终止保持可见。
    const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState;

    // 检查用户是否在无权访问的情况下尝试使用 agent 团队
    if (team_name && !isAgentSwarmsEnabled()) {
      throw new Error('Agent Teams is not yet available on your plan.');
    }

    // teammate（进程内或 tmux）传入 `name` 会触发下方的 spawnTeammate()，
    // 但 TeamFile.members 是只有一个 leadAgentId 的扁平数组——嵌套的
    // teammate 会以无来源信息的方式进入名单，令 lead 困惑。
    const teamName = resolveTeamName({
      team_name
    }, appState);
    if (isTeammate() && teamName && name) {
      throw new Error('Teammates cannot spawn other teammates — the team roster is flat. To spawn a subagent instead, omit the `name` parameter.');
    }
    // 进程内 teammate 无法派生子代理（其生命周期绑定在
    // leader 的进程上）。Tmux teammate 是独立进程，
    // 可以管理自己的后台 agent。
    if (isInProcessTeammate() && teamName && run_in_background === true) {
      throw new Error('In-process teammates cannot spawn background agents. Use run_in_background=false for synchronous subagents.');
    }

    // 检查这是否是多 agent 派生请求
    // 当设置了 team_name（来自参数或上下文）且提供了 name 时触发派生
    if (teamName && name) {
      // 派生前为分组 UI 展示设置 agent 定义颜色
      const agentDef = subagent_type ? toolUseContext.options.agentDefinitions.activeAgents.find(a => a.agentType === subagent_type) : undefined;
      if (agentDef?.color) {
        setAgentColor(subagent_type!, agentDef.color);
      }
      const result = await spawnTeammate({
        name,
        prompt,
        description,
        team_name: teamName,
        use_splitpane: true,
        plan_mode_required: spawnMode === 'plan',
        model: model ?? agentDef?.model,
        agent_type: subagent_type,
        invokingRequestId: assistantMessage?.requestId
      }, toolUseContext);

      // 类型断言使用 TeammateSpawnedOutput（上文已定义）而非 any。
      // 该类型为死代码消除而被排除在导出的 outputSchema 之外。
      // 通过 unknown 转换，因为 TeammateSpawnedOutput 有意
      // 不属于导出的 Output 联合（出于死代码消除目的）。
      const spawnResult: TeammateSpawnedOutput = {
        status: 'teammate_spawned' as const,
        prompt,
        ...result.data
      };
      return {
        data: spawnResult
      } as unknown as {
        data: Output;
      };
    }

    // Fork 子代理实验路由：
    // - 设置了 subagent_type：使用它（显式优先）
    // - 未设置 subagent_type，开关开启：fork 路径（undefined）
    // - 未设置 subagent_type，开关关闭：默认 general-purpose
    const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType);
    const isForkPath = effectiveType === undefined;
    let selectedAgent: AgentDefinition;
    if (isForkPath) {
      // 递归 fork 防护：fork 子级将 Agent 工具保留在其工具池中，
      // 以获得缓存一致的工具定义，因此在调用时拒绝 fork 尝试。
      // 主要检查项是 querySource（抗上下文压缩——在派生时设置于
      // context.options，能在 autocompact 的消息重写中存活）。
      // 消息扫描降级检查可捕获任何 querySource 未被
      // 传递的路径。
      if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}` || isInForkChild(toolUseContext.messages)) {
        throw new Error('Fork is not available inside a forked worker. Complete your task directly using your tools.');
      }
      selectedAgent = FORK_AGENT;
    } else {
      // 过滤 agent，排除通过 Agent(AgentName) 语法被拒绝的那些
      const allAgents = toolUseContext.options.agentDefinitions.activeAgents;
      const {
        allowedAgentTypes
      } = toolUseContext.options.agentDefinitions;
      const agents = filterDeniedAgents(
      // 当设置了 allowedAgentTypes（来自 Agent(x,y) 工具规格）时，限制为这些类型
      allowedAgentTypes ? allAgents.filter(a => allowedAgentTypes.includes(a.agentType)) : allAgents, appState.toolPermissionContext, AGENT_TOOL_NAME);
      const found = agents.find(agent => agent.agentType === effectiveType);
      if (!found) {
        // 检查 agent 是否存在但被权限规则拒绝
        const agentExistsButDenied = allAgents.find(agent => agent.agentType === effectiveType);
        if (agentExistsButDenied) {
          const denyRule = getDenyRuleForAgent(appState.toolPermissionContext, AGENT_TOOL_NAME, effectiveType);
          throw new Error(`Agent type '${effectiveType}' has been denied by permission rule '${AGENT_TOOL_NAME}(${effectiveType})' from ${denyRule?.source ?? 'settings'}.`);
        }
        throw new Error(`Agent type '${effectiveType}' not found. Available agents: ${agents.map(a => a.agentType).join(', ')}`);
      }
      selectedAgent = found;
    }

    // 与上文 run_in_background 防护相同的生命周期约束，但针对
    // 通过 `background: true` 强制后台的 agent 定义。在此检查
    // 是因为 selectedAgent 到这时才解析完成。
    if (isInProcessTeammate() && teamName && selectedAgent.background === true) {
      throw new Error(`In-process teammates cannot spawn background agents. Agent '${selectedAgent.agentType}' has background: true in its definition.`);
    }

    // 为类型收窄而捕获——`let selectedAgent` 使 TS 无法
    // 跨上文的 if-else 赋值收窄属性类型。
    const requiredMcpServers = selectedAgent.requiredMcpServers;

    // 检查所需的 MCP 服务器是否有可用工具
    // 已连接但未认证的服务器不会有任何工具
    if (requiredMcpServers?.length) {
      // 如果有任何所需服务器仍在等待中（连接中），先等待它们
      // 再检查工具可用性。这避免了在 MCP 服务器完成连接前
      // 就调用 agent 的竞态。
      const hasPendingRequiredServers = appState.mcp.clients.some(c => c.type === 'pending' && requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())));
      let currentAppState = appState;
      if (hasPendingRequiredServers) {
        const MAX_WAIT_MS = 30_000;
        const POLL_INTERVAL_MS = 500;
        const deadline = Date.now() + MAX_WAIT_MS;
        while (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          currentAppState = toolUseContext.getAppState();

          // 提前退出：如果有任何所需服务器已失败，就无需
          // 等待其他待定服务器——检查无论如何都会失败。
          const hasFailedRequiredServer = currentAppState.mcp.clients.some(c => c.type === 'failed' && requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())));
          if (hasFailedRequiredServer) break;
          const stillPending = currentAppState.mcp.clients.some(c => c.type === 'pending' && requiredMcpServers.some(pattern => c.name.toLowerCase().includes(pattern.toLowerCase())));
          if (!stillPending) break;
        }
      }

      // 获取真正拥有工具的服务器（意味着它们已连接且已认证）
      const serversWithTools: string[] = [];
      for (const tool of currentAppState.mcp.tools) {
        if (tool.name?.startsWith('mcp__')) {
          // 从工具名中提取服务器名（格式：mcp__serverName__toolName）
          const parts = tool.name.split('__');
          const serverName = parts[1];
          if (serverName && !serversWithTools.includes(serverName)) {
            serversWithTools.push(serverName);
          }
        }
      }
      if (!hasRequiredMcpServers(selectedAgent, serversWithTools)) {
        const missing = requiredMcpServers.filter(pattern => !serversWithTools.some(server => server.toLowerCase().includes(pattern.toLowerCase())));
        throw new Error(`Agent '${selectedAgent.agentType}' requires MCP servers matching: ${missing.join(', ')}. ` + `MCP servers with tools: ${serversWithTools.length > 0 ? serversWithTools.join(', ') : 'none'}. ` + `Use /mcp to configure and authenticate the required MCP servers.`);
      }
    }

    // 如果该 agent 有预定义颜色，则初始化它
    if (selectedAgent.color) {
      setAgentColor(selectedAgent.agentType, selectedAgent.color);
    }

    // 解析 agent 参数用于日志（这些在 runAgent 中已解析）
    const resolvedAgentModel = getAgentModel(selectedAgent.model, toolUseContext.options.mainLoopModel, isForkPath ? undefined : model, permissionMode);
    logEvent('limkenion_agent_tool_selected', {
      agent_type: selectedAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      model: resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source: selectedAgent.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      color: selectedAgent.color as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      is_built_in_agent: isBuiltInAgent(selectedAgent),
      is_resume: false,
      is_async: (run_in_background === true || selectedAgent.background === true) && !isBackgroundTasksDisabled,
      is_fork: isForkPath
    });

    // 解析生效的隔离模式（显式参数覆盖 agent 定义）
    const effectiveIsolation = isolation ?? selectedAgent.isolation;

    // 远程隔离：委托给 CCR。仅限 ant 的开关保护——该防护使整个代码块
    // 能在外部构建中被死代码消除。
    
    // 系统提示词 + 提示词消息：按 fork 路径分支。
    //
    // Fork 路径：子级继承父级的系统提示词（不是 FORK_AGENT 的），
    // 以获得缓存一致的 API 请求前缀。提示词消息通过
    // buildForkedMessages() 构建，它克隆父级完整的 assistant 消息
    // （所有 tool_use 块）+ 占位 tool_results + 每个子级的指令。
    //
    // 常规路径：用环境详情构建所选 agent 自己的系统提示词，
    // 并使用一条简单的 user 消息作为提示词。
    let enhancedSystemPrompt: string[] | undefined;
    let forkParentSystemPrompt: ReturnType<typeof buildEffectiveSystemPrompt> | undefined;
    let promptMessages: MessageType[];
    if (isForkPath) {
      if (toolUseContext.renderedSystemPrompt) {
        forkParentSystemPrompt = toolUseContext.renderedSystemPrompt;
      } else {
        // 降级：重新计算。如果 GrowthBook 状态在父级回合开始与 fork 派生之间
        // 发生变化，可能与父级缓存的字节不一致。
        const mainThreadAgentDefinition = appState.agent ? appState.agentDefinitions.activeAgents.find(a => a.agentType === appState.agent) : undefined;
        const additionalWorkingDirectories = Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys());
        const defaultSystemPrompt = await getSystemPrompt(toolUseContext.options.tools, toolUseContext.options.mainLoopModel, additionalWorkingDirectories, toolUseContext.options.mcpClients);
        forkParentSystemPrompt = buildEffectiveSystemPrompt({
          mainThreadAgentDefinition,
          toolUseContext,
          customSystemPrompt: toolUseContext.options.customSystemPrompt,
          defaultSystemPrompt,
          appendSystemPrompt: toolUseContext.options.appendSystemPrompt
        });
      }
      promptMessages = buildForkedMessages(prompt, assistantMessage);
    } else {
      try {
        const additionalWorkingDirectories = Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys());

        // 所有 agent 都有 getSystemPrompt——向所有调用传递 toolUseContext
        const agentPrompt = selectedAgent.getSystemPrompt({
          toolUseContext
        });

        // 为子代理记录 agent 记忆加载事件
        if (selectedAgent.memory) {
          logEvent('limkenion_agent_memory_loaded', {
            
            scope: selectedAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            source: 'subagent' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
        }

        // 应用环境详情增强
        enhancedSystemPrompt = await enhanceSystemPromptWithEnvDetails([agentPrompt], resolvedAgentModel, additionalWorkingDirectories);
      } catch (error) {
        logForDebugging(`Failed to get system prompt for agent ${selectedAgent.agentType}: ${errorMessage(error)}`);
      }
      promptMessages = [createUserMessage({
        content: prompt
      })];
    }
    const metadata = {
      prompt,
      resolvedAgentModel,
      isBuiltInAgent: isBuiltInAgent(selectedAgent),
      startTime,
      agentType: selectedAgent.agentType,
      isAsync: (run_in_background === true || selectedAgent.background === true) && !isBackgroundTasksDisabled
    };

    // 使用内联环境变量检查而非 coordinatorModule，以避免测试模块加载时的
    // 循环依赖问题。
    const isCoordinator = feature('COORDINATOR_MODE') ? isEnvTruthy(process.env.LIMKENION_COORDINATOR_MODE) : false;

    // Fork 子代理实验：将所有派生强制为异步，以获得统一的
    // <task-notification> 交互模型（不只是 fork 派生——是所有派生）。
    const forceAsync = isForkSubagentEnabled();

    // Assistant 模式：强制所有 agent 异步。同步子代理会一直占住
    // 主循环的回合直到完成——守护进程的 inputQueue 积压，
    // 派生时首次逾期的 cron 补跑会变成 N 个串行
    // 子代理回合，阻塞所有用户输入。与
    // executeForkedSlashCommand 的即发即弃路径使用同一开关；那里的
    // <task-notification> 重入由下方的 else 分支处理
    // （registerAsyncAgentTask + notifyOnCompletion）。
    const assistantForceAsync = feature('KAIROS') ? appState.kairosEnabled : false;
    const shouldRunAsync = (run_in_background === true || selectedAgent.background === true || isCoordinator || forceAsync || assistantForceAsync || (proactiveModule?.isProactiveActive() ?? false)) && !isBackgroundTasksDisabled;
    // 独立于父级组装 worker 的工具池。
    // worker 始终以自己的权限模式从 assembleToolPool 获取工具，
    // 因此不受父级工具限制的影响。在此处计算是为了让
    // runAgent 无需从 tools.ts 导入（那会造成
    // 循环依赖）。
    const workerPermissionContext = {
      ...appState.toolPermissionContext,
      mode: selectedAgent.permissionMode ?? 'acceptEdits'
    };
    const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools);

    // 尽早创建稳定的 agent ID，以便用于 worktree 短名
    const earlyAgentId = createAgentId();

    // 如请求则设置 worktree 隔离
    let worktreeInfo: {
      worktreePath: string;
      worktreeBranch?: string;
      headCommit?: string;
      gitRoot?: string;
      hookBased?: boolean;
    } | null = null;
    if (effectiveIsolation === 'worktree') {
      const slug = `agent-${earlyAgentId.slice(0, 8)}`;
      worktreeInfo = await createAgentWorktree(slug);
    }

    // Fork + worktree：注入一条通知，告知子级转换路径
    // 并重新读取可能失效的文件。追加在 fork 指令之后，
    // 使其成为子级看到的最新指引。
    if (isForkPath && worktreeInfo) {
      promptMessages.push(createUserMessage({
        content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath)
      }));
    }
    const runAgentParams: Parameters<typeof runAgent>[0] = {
      agentDefinition: selectedAgent,
      promptMessages,
      toolUseContext,
      canUseTool,
      isAsync: shouldRunAsync,
      querySource: toolUseContext.options.querySource ?? getQuerySourceForAgent(selectedAgent.agentType, isBuiltInAgent(selectedAgent)),
      model: isForkPath ? undefined : model,
      // Fork 路径：传递父级的系统提示词以及父级精确的工具
      // 数组（缓存一致的前缀）。workerTools 是在
      // permissionMode 'bubble' 下重建的，与父级的模式不同，因此
      // 其工具定义序列化会产生分歧，并在第一个不同的工具处破坏缓存。
      // useExactTools 还会继承父级的
      // thinkingConfig 和 isNonInteractiveSession（见 runAgent.ts）。
      //
      // 常规路径：当 cwd 覆盖生效时（worktree 隔离
      // 或显式 cwd），跳过预构建的系统提示词，让 runAgent 的
      // buildAgentSystemPrompt() 在 wrapWithCwd 内运行，此时 getCwd()
      // 返回覆盖后的路径。
      override: isForkPath ? {
        systemPrompt: forkParentSystemPrompt
      } : enhancedSystemPrompt && !worktreeInfo && !cwd ? {
        systemPrompt: asSystemPrompt(enhancedSystemPrompt)
      } : undefined,
      availableTools: isForkPath ? toolUseContext.options.tools : workerTools,
      // 当 fork 子代理路径需要完整上下文时传递父级会话。
      // useExactTools 继承 thinkingConfig（runAgent.ts:624）。
      forkContextMessages: isForkPath ? toolUseContext.messages : undefined,
      ...(isForkPath && {
        useExactTools: true
      }),
      worktreePath: worktreeInfo?.worktreePath,
      description
    };

    // 用 cwd 覆盖包装执行的辅助函数：显式 cwd 参数（KAIROS）
    // 优先于 worktree 隔离路径。
    const cwdOverridePath = cwd ?? worktreeInfo?.worktreePath;
    const wrapWithCwd = <T,>(fn: () => T): T => cwdOverridePath ? runWithCwdOverride(cwdOverridePath, fn) : fn();

    // agent 完成后清理 worktree 的辅助函数
    const cleanupWorktreeIfNeeded = async (): Promise<{
      worktreePath?: string;
      worktreeBranch?: string;
    }> => {
      if (!worktreeInfo) return {};
      const {
        worktreePath,
        worktreeBranch,
        headCommit,
        gitRoot,
        hookBased
      } = worktreeInfo;
      // 置空以保持幂等——防止清理与 try 结束之间的代码
      // 抛入 catch 时出现重复调用
      worktreeInfo = null;
      if (hookBased) {
        // 基于 hook 的 worktree 始终保留，因为我们无法检测 VCS 变更
        logForDebugging(`Hook-based agent worktree kept at: ${worktreePath}`);
        return {
          worktreePath
        };
      }
      if (headCommit) {
        const changed = await hasWorktreeChanges(worktreePath, headCommit);
        if (!changed) {
          await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot);
          // 从元数据中清除 worktreePath，使恢复不会尝试使用
          // 已删除的目录。即发即弃，与 runAgent 的
          // writeAgentMetadata 处理方式一致。
          void writeAgentMetadata(asAgentId(earlyAgentId), {
            agentType: selectedAgent.agentType,
            description
          }).catch(_err => logForDebugging(`Failed to clear worktree metadata: ${_err}`));
          return {};
        }
      }
      logForDebugging(`Agent worktree has changes, keeping: ${worktreePath}`);
      return {
        worktreePath,
        worktreeBranch
      };
    };
    if (shouldRunAsync) {
      const asyncAgentId = earlyAgentId;
      const agentBackgroundTask = registerAsyncAgent({
        agentId: asyncAgentId,
        description,
        prompt,
        selectedAgent,
        setAppState: rootSetAppState,
        // 不要链接到父级的中止控制器——后台 agent 应在
        // 用户按 ESC 取消主线程时存活下来。
        // 它们通过 chat:killAgents 被显式终止。
        toolUseId: toolUseContext.toolUseId
      });

      // 注册 name → agentId 以用于 SendMessage 路由。在 registerAsyncAgent
      // 之后注册，这样派生失败时不会留下失效条目。跳过同步 agent——
      // coordinator 被阻塞，因此 SendMessage 路由不适用。
      if (name) {
        rootSetAppState(prev => {
          const next = new Map(prev.agentNameRegistry);
          next.set(name, asAgentId(asyncAgentId));
          return {
            ...prev,
            agentNameRegistry: next
          };
        });
      }

      // 将异步 agent 执行包装在 agent 上下文中以用于分析归因
      const asyncAgentContext = {
        agentId: asyncAgentId,
        // 来自 teammate 的子代理：使用团队 lead 的会话
        // 来自主 REPL 的子代理：undefined（无父级会话）
        parentSessionId: getParentSessionId(),
        agentType: 'subagent' as const,
        subagentName: selectedAgent.agentType,
        isBuiltIn: isBuiltInAgent(selectedAgent),
        invokingRequestId: assistantMessage?.requestId,
        invocationKind: 'spawn' as const,
        invocationEmitted: false
      };

      // 负载传播：handlePromptSubmit 将整个回合包装在
      // runWithWorkload（AsyncLocalStorage）中。ALS 上下文在
      // 调用时——即这个 `void` 触发时——被捕获，并在内部的每个 await 中
      // 存活。无需捕获/恢复；分离的闭包会自动看到
      // 父级回合的负载，且与其 finally 隔离。
      void runWithAgentContext(asyncAgentContext, () => wrapWithCwd(() => runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        makeStream: onCacheSafeParams => runAgent({
          ...runAgentParams,
          override: {
            ...runAgentParams.override,
            agentId: asAgentId(agentBackgroundTask.agentId),
            abortController: agentBackgroundTask.abortController!
          },
          onCacheSafeParams
        }),
        metadata,
        description,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: asyncAgentId,
        enableSummarization: isCoordinator || isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: cleanupWorktreeIfNeeded
      })));
      const canReadOutputFile = toolUseContext.options.tools.some(t => toolMatchesName(t, FILE_READ_TOOL_NAME) || toolMatchesName(t, BASH_TOOL_NAME));
      return {
        data: {
          isAsync: true as const,
          status: 'async_launched' as const,
          agentId: agentBackgroundTask.agentId,
          description: description,
          prompt: prompt,
          outputFile: getTaskOutputPath(agentBackgroundTask.agentId),
          canReadOutputFile
        }
      };
    } else {
      // 为同步 agent 创建显式的 agentId
      const syncAgentId = asAgentId(earlyAgentId);

      // 为同步执行设置 agent 上下文（用于分析归因）
      const syncAgentContext = {
        agentId: syncAgentId,
        // 来自 teammate 的子代理：使用团队 lead 的会话
        // 来自主 REPL 的子代理：undefined（无父级会话）
        parentSessionId: getParentSessionId(),
        agentType: 'subagent' as const,
        subagentName: selectedAgent.agentType,
        isBuiltIn: isBuiltInAgent(selectedAgent),
        invokingRequestId: assistantMessage?.requestId,
        invocationKind: 'spawn' as const,
        invocationEmitted: false
      };

      // 将整个同步 agent 执行包装在上下文中以用于分析归因，
      // 并可选地包装在 worktree cwd 覆盖中以实现文件系统隔离
      return runWithAgentContext(syncAgentContext, () => wrapWithCwd(async () => {
        const agentMessages: MessageType[] = [];
        const agentStartTime = Date.now();
        const syncTracker = createProgressTracker();
        const syncResolveActivity = createActivityDescriptionResolver(toolUseContext.options.tools);

        // 产出初始进度消息以携带元数据（prompt）
        if (promptMessages.length > 0) {
          const normalizedPromptMessages = normalizeMessages(promptMessages);
          const normalizedFirstMessage = normalizedPromptMessages.find((m): m is NormalizedUserMessage => m.type === 'user');
          if (normalizedFirstMessage && normalizedFirstMessage.type === 'user' && onProgress) {
            onProgress({
              toolUseID: `agent_${assistantMessage.message.id}`,
              data: {
                message: normalizedFirstMessage,
                type: 'agent_progress',
                prompt,
                agentId: syncAgentId
              }
            });
          }
        }

        // 立即注册为前台任务，以便随时可转入后台
        // 如果后台任务被禁用则跳过注册
        let foregroundTaskId: string | undefined;
        // 在循环外一次性创建后台竞态 promise——否则
        // 每次迭代都会向同一个未决 promise 添加新的 .then() 反应，
        // 在 agent 的整个生命周期内累积回调。
        let backgroundPromise: Promise<{
          type: 'background';
        }> | undefined;
        let cancelAutoBackground: (() => void) | undefined;
        if (!isBackgroundTasksDisabled) {
          const registration = registerAgentForeground({
            agentId: syncAgentId,
            description,
            prompt,
            selectedAgent,
            setAppState: rootSetAppState,
            toolUseId: toolUseContext.toolUseId,
            autoBackgroundMs: getAutoBackgroundMs() || undefined
          });
          foregroundTaskId = registration.taskId;
          backgroundPromise = registration.backgroundSignal.then(() => ({
            type: 'background' as const
          }));
          cancelAutoBackground = registration.cancelAutoBackground;
        }

        // 跟踪是否已展示后台提示 UI
        let backgroundHintShown = false;
        // 跟踪 agent 是否已转入后台（清理由后台化的 finally 处理）
        let wasBackgrounded = false;
        // 按作用域独立的停止函数——不与后台化的闭包共享。
        // 幂等：startAgentSummarization 的 stop() 会检查 `stopped` 标志。
        let stopForegroundSummarization: (() => void) | undefined;
        // const 捕获，以便下方回调内进行可靠的类型收窄
        const summaryTaskId = foregroundTaskId;

        // 获取 agent 的异步迭代器
        const agentIterator = runAgent({
          ...runAgentParams,
          override: {
            ...runAgentParams.override,
            agentId: syncAgentId
          },
          onCacheSafeParams: summaryTaskId && getSdkAgentProgressSummariesEnabled() ? (params: CacheSafeParams) => {
            const {
              stop
            } = startAgentSummarization(summaryTaskId, syncAgentId, params, rootSetAppState);
            stopForegroundSummarization = stop;
          } : undefined
        })[Symbol.asyncIterator]();

        // 跟踪迭代期间是否发生错误
        let syncAgentError: Error | undefined;
        let wasAborted = false;
        let worktreeResult: {
          worktreePath?: string;
          worktreeBranch?: string;
        } = {};
        try {
          while (true) {
            const elapsed = Date.now() - agentStartTime;

            // 超过阈值后展示后台提示（但任务已注册）
            // 如果后台任务被禁用则跳过
            if (!isBackgroundTasksDisabled && !backgroundHintShown && elapsed >= PROGRESS_THRESHOLD_MS && toolUseContext.setToolJSX) {
              backgroundHintShown = true;
              toolUseContext.setToolJSX({
                jsx: <BackgroundHint />,
                shouldHidePromptInput: false,
                shouldContinueAnimation: true,
                showSpinner: true
              });
            }

            // 在下一条消息与后台信号之间竞态
            // 如果后台任务被禁用，直接 await 下一条消息
            const nextMessagePromise = agentIterator.next();
            const raceResult = backgroundPromise ? await Promise.race([nextMessagePromise.then(r => ({
              type: 'message' as const,
              result: r
            })), backgroundPromise]) : {
              type: 'message' as const,
              result: await nextMessagePromise
            };

            // 检查我们是否通过 backgroundAll() 被转入后台
            // 如果 raceResult.type 为 'background'，foregroundTaskId 保证已定义，
            // 因为 backgroundPromise 仅在 foregroundTaskId 已定义时才定义
            if (raceResult.type === 'background' && foregroundTaskId) {
              const appState = toolUseContext.getAppState();
              const task = appState.tasks[foregroundTaskId];
              if (isLocalAgentTask(task) && task.isBackgrounded) {
                // 捕获 taskId 以便在异步回调中使用
                const backgroundedTaskId = foregroundTaskId;
                wasBackgrounded = true;
                // 停止前台摘要；下方后台化的闭包
                // 拥有自己独立的停止函数。
                stopForegroundSummarization?.();

                // 负载：在 `void` 调用时通过 ALS 继承，
                // 与上文从开始即异步的路径相同。
                // 在后台继续 agent 并返回异步结果
                void runWithAgentContext(syncAgentContext, async () => {
                  let stopBackgroundedSummarization: (() => void) | undefined;
                  try {
                    // 清理前台迭代器，使其 finally 块得以运行
                    // （释放 MCP 连接、会话钩子、提示词缓存跟踪等）
                    // 超时可防止 MCP 服务器清理挂起时造成阻塞。
                    // .catch() 可防止超时赢得竞态时出现未处理的拒绝。
                    await Promise.race([agentIterator.return(undefined).catch(() => {}), sleep(1000)]);
                    // 从已有消息初始化进度跟踪
                    const tracker = createProgressTracker();
                    const resolveActivity2 = createActivityDescriptionResolver(toolUseContext.options.tools);
                    for (const existingMsg of agentMessages) {
                      updateProgressFromMessage(tracker, existingMsg, resolveActivity2, toolUseContext.options.tools);
                    }
                    for await (const msg of runAgent({
                      ...runAgentParams,
                      isAsync: true,
                      // agent 现在在后台运行
                      override: {
                        ...runAgentParams.override,
                        agentId: asAgentId(backgroundedTaskId),
                        abortController: task.abortController
                      },
                      onCacheSafeParams: getSdkAgentProgressSummariesEnabled() ? (params: CacheSafeParams) => {
                        const {
                          stop
                        } = startAgentSummarization(backgroundedTaskId, asAgentId(backgroundedTaskId), params, rootSetAppState);
                        stopBackgroundedSummarization = stop;
                      } : undefined
                    })) {
                      agentMessages.push(msg);

                      // 跟踪后台化 agent 的进度
                      updateProgressFromMessage(tracker, msg, resolveActivity2, toolUseContext.options.tools);
                      updateAsyncAgentProgress(backgroundedTaskId, getProgressUpdate(tracker), rootSetAppState);
                      const lastToolName = getLastToolUseName(msg);
                      if (lastToolName) {
                        emitTaskProgress(tracker, backgroundedTaskId, toolUseContext.toolUseId, description, startTime, lastToolName);
                      }
                    }
                    const agentResult = finalizeAgentTool(agentMessages, backgroundedTaskId, metadata);

                    // 先标记任务完成，使 TaskOutput(block=true)
                    // 立即解除阻塞。classifyHandoffIfNeeded 和
                    // cleanupWorktreeIfNeeded 可能挂起——它们不得阻塞
                    // 状态转换（gh-20236）。
                    completeAsyncAgent(agentResult, rootSetAppState);

                    // 从 agent 结果内容中提取文本用于通知
                    let finalMessage = extractTextContent(agentResult.content, '\n');
                    if (feature('TRANSCRIPT_CLASSIFIER')) {
                      const backgroundedAppState = toolUseContext.getAppState();
                      const handoffWarning = await classifyHandoffIfNeeded({
                        agentMessages,
                        tools: toolUseContext.options.tools,
                        toolPermissionContext: backgroundedAppState.toolPermissionContext,
                        abortSignal: task.abortController!.signal,
                        subagentType: selectedAgent.agentType,
                        totalToolUseCount: agentResult.totalToolUseCount
                      });
                      if (handoffWarning) {
                        finalMessage = `${handoffWarning}\n\n${finalMessage}`;
                      }
                    }

                    // 在通知前清理 worktree，以便将其包含在通知中
                    const worktreeResult = await cleanupWorktreeIfNeeded();
                    enqueueAgentNotification({
                      taskId: backgroundedTaskId,
                      description,
                      status: 'completed',
                      setAppState: rootSetAppState,
                      finalMessage,
                      usage: {
                        totalTokens: getTokenCountFromTracker(tracker),
                        toolUses: agentResult.totalToolUseCount,
                        durationMs: agentResult.totalDurationMs
                      },
                      toolUseId: toolUseContext.toolUseId,
                      ...worktreeResult
                    });
                  } catch (error) {
                    if (error instanceof AbortError) {
                      // 在 worktree 清理之前转换状态，
                      // 使 TaskOutput 即使 git 挂起也能解除阻塞（gh-20236）。
                      killAsyncAgent(backgroundedTaskId, rootSetAppState);
                      logEvent('limkenion_agent_tool_terminated', {
                        agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                        model: metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                        duration_ms: Date.now() - metadata.startTime,
                        is_async: true,
                        is_built_in_agent: metadata.isBuiltInAgent,
                        reason: 'user_cancel_background' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
                      });
                      const worktreeResult = await cleanupWorktreeIfNeeded();
                      const partialResult = extractPartialResult(agentMessages);
                      enqueueAgentNotification({
                        taskId: backgroundedTaskId,
                        description,
                        status: 'killed',
                        setAppState: rootSetAppState,
                        toolUseId: toolUseContext.toolUseId,
                        finalMessage: partialResult,
                        ...worktreeResult
                      });
                      return;
                    }
                    const errMsg = errorMessage(error);
                    failAsyncAgent(backgroundedTaskId, errMsg, rootSetAppState);
                    const worktreeResult = await cleanupWorktreeIfNeeded();
                    enqueueAgentNotification({
                      taskId: backgroundedTaskId,
                      description,
                      status: 'failed',
                      error: errMsg,
                      setAppState: rootSetAppState,
                      toolUseId: toolUseContext.toolUseId,
                      ...worktreeResult
                    });
                  } finally {
                    stopBackgroundedSummarization?.();
                    clearInvokedSkillsForAgent(syncAgentId);
                    clearDumpState(syncAgentId);
                    // 注意：在 try 和 catch 两条路径中，worktree 清理都在
                    // enqueueAgentNotification 之前完成，以便包含 worktree 信息
                  }
                });

                // 立即返回 async_launched 结果
                const canReadOutputFile = toolUseContext.options.tools.some(t => toolMatchesName(t, FILE_READ_TOOL_NAME) || toolMatchesName(t, BASH_TOOL_NAME));
                return {
                  data: {
                    isAsync: true as const,
                    status: 'async_launched' as const,
                    agentId: backgroundedTaskId,
                    description: description,
                    prompt: prompt,
                    outputFile: getTaskOutputPath(backgroundedTaskId),
                    canReadOutputFile
                  }
                };
              }
            }

            // 处理来自竞态结果的消息
            if (raceResult.type !== 'message') {
              // 这不应发生——后台情况已在上文处理
              continue;
            }
            const {
              result
            } = raceResult;
            if (result.done) break;
            const message = result.value;
            agentMessages.push(message);

            // 为 VS Code 子代理面板发出 task_progress
            updateProgressFromMessage(syncTracker, message, syncResolveActivity, toolUseContext.options.tools);
            if (foregroundTaskId) {
              const lastToolName = getLastToolUseName(message);
              if (lastToolName) {
                emitTaskProgress(syncTracker, foregroundTaskId, toolUseContext.toolUseId, description, agentStartTime, lastToolName);
                // 启用 SDK 摘要时保持 AppState task.progress 同步，
                // 使 updateAgentSummary 读取正确的 token/工具计数
                // 而不是零。
                if (getSdkAgentProgressSummariesEnabled()) {
                  updateAsyncAgentProgress(foregroundTaskId, getProgressUpdate(syncTracker), rootSetAppState);
                }
              }
            }

            // 将子代理的 bash_progress 事件转发给父级，使 SDK
            // 像对待主 agent 一样收到 tool_progress 事件。
            if (message.type === 'progress' && (message.data.type === 'bash_progress' || message.data.type === 'powershell_progress') && onProgress) {
              onProgress({
                toolUseID: message.toolUseID,
                data: message.data
              });
            }
            if (message.type !== 'assistant' && message.type !== 'user') {
              continue;
            }

            // 为 assistant 消息递增 spinner 中的 token 计数
            // 子代理的流式事件在 runAgent.ts 中被过滤掉，因此
            // 我们需要在此从已完成的消息中统计 token
            if (message.type === 'assistant') {
              const contentLength = getAssistantMessageContentLength(message);
              if (contentLength > 0) {
                toolUseContext.setResponseLength(len => len + contentLength);
              }
            }
            const normalizedNew = normalizeMessages([message]);
            for (const m of normalizedNew) {
              for (const content of m.message.content) {
                if (content.type !== 'tool_use' && content.type !== 'tool_result') {
                  continue;
                }

                // 转发进度更新
                if (onProgress) {
                  onProgress({
                    toolUseID: `agent_${assistantMessage.message.id}`,
                    data: {
                      message: m,
                      type: 'agent_progress',
                      // prompt 仅在第一条进度消息中需要（UI.tsx:624
                      // 读取 progressMessages[0]）。此处省略以避免重复。
                      prompt: '',
                      agentId: syncAgentId
                    }
                  });
                }
              }
            }
          }
        } catch (error) {
          // 处理同步 agent 循环中的错误
          // 应重新抛出 AbortError 以正确处理中断
          if (error instanceof AbortError) {
            wasAborted = true;
            logEvent('limkenion_agent_tool_terminated', {
              agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model: metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              duration_ms: Date.now() - metadata.startTime,
              is_async: false,
              is_built_in_agent: metadata.isBuiltInAgent,
              reason: 'user_cancel_sync' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
            });
            throw error;
          }

          // 记录错误以便调试
          logForDebugging(`Sync agent error: ${errorMessage(error)}`, {
            level: 'error'
          });

          // 存储错误以便在清理后处理
          syncAgentError = toError(error);
        } finally {
          // 清除后台提示 UI
          if (toolUseContext.setToolJSX) {
            toolUseContext.setToolJSX(null);
          }

          // 停止前台摘要。幂等——如果在转入后台时已停止，
          // 这里就是空操作。后台化的闭包
          // 拥有独立的停止函数（stopBackgroundedSummarization）。
          stopForegroundSummarization?.();

          // 如果 agent 未转入后台就已完成，则注销前台任务
          if (foregroundTaskId) {
            unregisterAgentForeground(foregroundTaskId, rootSetAppState);
            // 通知 SDK 使用方（例如 VS Code 子代理面板）该前台
            // agent 已完成。经由 drainSdkEvents()——不会
            // 触发 print.ts 的 XML task_notification 解析器或 LLM 循环。
            if (!wasBackgrounded) {
              const progress = getProgressUpdate(syncTracker);
              enqueueSdkEvent({
                type: 'system',
                subtype: 'task_notification',
                task_id: foregroundTaskId,
                tool_use_id: toolUseContext.toolUseId,
                status: syncAgentError ? 'failed' : wasAborted ? 'stopped' : 'completed',
                output_file: '',
                summary: description,
                usage: {
                  total_tokens: progress.tokenCount,
                  tool_uses: progress.toolUseCount,
                  duration_ms: Date.now() - agentStartTime
                }
              });
            }
          }

          // 清理作用域技能，避免它们在全局 map 中累积
          clearInvokedSkillsForAgent(syncAgentId);

          // 清理该 agent 的 dumpState 条目以防止无限增长
          // 如果已转入后台则跳过——后台化 agent 的 finally 会处理清理
          if (!wasBackgrounded) {
            clearDumpState(syncAgentId);
          }

          // 如果 agent 在定时器触发前已完成，则取消自动转后台定时器
          cancelAutoBackground?.();

          // 如适用则清理 worktree（放在 finally 中以处理中止/错误路径）
          // 如果已转入后台则跳过——后台续体仍在其内运行
          if (!wasBackgrounded) {
            worktreeResult = await cleanupWorktreeIfNeeded();
          }
        }

        // 重新抛出中止错误
        // TODO: 寻找更简洁的表达方式
        const lastMessage = agentMessages.findLast(_ => _.type !== 'system' && _.type !== 'progress');
        if (lastMessage && isSyntheticMessage(lastMessage)) {
          logEvent('limkenion_agent_tool_terminated', {
            agent_type: metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            model: metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            duration_ms: Date.now() - metadata.startTime,
            is_async: false,
            is_built_in_agent: metadata.isBuiltInAgent,
            reason: 'user_cancel_sync' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          throw new AbortError();
        }

        // 如果迭代期间发生错误，尝试用已有的消息返回结果。
        // 如果没有 assistant 消息，
        // 则重新抛出错误，以便由工具框架正确处理。
        if (syncAgentError) {
          // 检查是否有可返回的 assistant 消息
          const hasAssistantMessages = agentMessages.some(msg => msg.type === 'assistant');
          if (!hasAssistantMessages) {
            // 未收集到消息，重新抛出错误
            throw syncAgentError;
          }

          // 有一些消息，尝试最终处理并返回它们
          // 这使父 agent 即使在出错后也能看到部分进展
          logForDebugging(`Sync agent recovering from error with ${agentMessages.length} messages`);
        }
        const agentResult = finalizeAgentTool(agentMessages, syncAgentId, metadata);
        if (feature('TRANSCRIPT_CLASSIFIER')) {
          const currentAppState = toolUseContext.getAppState();
          const handoffWarning = await classifyHandoffIfNeeded({
            agentMessages,
            tools: toolUseContext.options.tools,
            toolPermissionContext: currentAppState.toolPermissionContext,
            abortSignal: toolUseContext.abortController.signal,
            subagentType: selectedAgent.agentType,
            totalToolUseCount: agentResult.totalToolUseCount
          });
          if (handoffWarning) {
            agentResult.content = [{
              type: 'text' as const,
              text: handoffWarning
            }, ...agentResult.content];
          }
        }
        return {
          data: {
            status: 'completed' as const,
            prompt,
            ...agentResult,
            ...worktreeResult
          }
        };
      }));
    }
  },
  isReadOnly() {
    return true; // 将权限检查委托给其底层工具
  },
  toAutoClassifierInput(input) {
    const i = input as AgentToolInput;
    const tags = [i.subagent_type, i.mode ? `mode=${i.mode}` : undefined].filter((t): t is string => t !== undefined);
    const prefix = tags.length > 0 ? `(${tags.join(', ')}): ` : ': ';
    return `${prefix}${i.prompt}`;
  },
  isConcurrencySafe() {
    return true;
  },
  userFacingName,
  userFacingNameBackgroundColor,
  getActivityDescription(input) {
    return input?.description ?? 'Running task';
  },
  async checkPermissions(input, context): Promise<PermissionResult> {
    const appState = context.getAppState();

    // 仅在自动模式下才经由自动模式分类器路由
    // 在所有其他模式下，自动批准子代理生成
    // 注意："external" === 'ant' 防护使外部构建可进行死代码消除
    
    return {
      behavior: 'allow',
      updatedInput: input
    };
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    // 多 agent 派生结果
    const internalData = data as InternalOutput;
    if (typeof internalData === 'object' && internalData !== null && 'status' in internalData && internalData.status === 'teammate_spawned') {
      const spawnData = internalData as TeammateSpawnedOutput;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [{
          type: 'text',
          text: `Spawned successfully.
agent_id: ${spawnData.teammate_id}
name: ${spawnData.name}
team_name: ${spawnData.team_name}
The agent is now running and will receive instructions via mailbox.`
        }]
      };
    }
    if ('status' in internalData && internalData.status === 'remote_launched') {
      const r = internalData;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [{
          type: 'text',
          text: `Remote agent launched in CCR.\ntaskId: ${r.taskId}\nsession_url: ${r.sessionUrl}\noutput_file: ${r.outputFile}\nThe agent is running remotely. You will be notified automatically when it completes.\nBriefly tell the user what you launched and end your response.`
        }]
      };
    }
    if (data.status === 'async_launched') {
      const prefix = `Async agent launched successfully.\nagentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`;
      const instructions = data.canReadOutputFile ? `Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\noutput_file: ${data.outputFile}\nIf asked, you can check progress before completion by using ${FILE_READ_TOOL_NAME} or ${BASH_TOOL_NAME} tail on the output file.` : `Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.`;
      const text = `${prefix}\n${instructions}`;
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [{
          type: 'text',
          text
        }]
      };
    }
    if (data.status === 'completed') {
      const worktreeData = data as Record<string, unknown>;
      const worktreeInfoText = worktreeData.worktreePath ? `\nworktreePath: ${worktreeData.worktreePath}\nworktreeBranch: ${worktreeData.worktreeBranch}` : '';
      // 如果子代理完成时没有内容，tool_result 就只是下方的
      // agentId/usage 尾注——位于提示词末尾的纯元数据块。
      // 某些模型会将其理解为“无事可做”并立即
      // 结束回合。显式说明这一点，让父级有可回应的内容。
      const contentOrMarker = data.content.length > 0 ? data.content : [{
        type: 'text' as const,
        text: '(Subagent completed but returned no output.)'
      }];
      // 一次性内置 agent（Explore、Plan）从不通过 SendMessage 继续——
      // agentId 提示和 <usage> 块是累赘（约 135 字符 ×
      // 每周 34M 次 Explore 运行 ≈ 每周 1-2 Gtok）。遥测不解析该
      // 块（它在 finalizeAgentTool 中使用 logEvent），因此丢弃是安全的。
      // 为兼容恢复，agentType 是可选的——缺失即表示展示尾注。
      if (data.agentType && ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) && !worktreeInfoText) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: contentOrMarker
        };
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [...contentOrMarker, {
          type: 'text',
          text: `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)${worktreeInfoText}
<usage>total_tokens: ${data.totalTokens}
tool_uses: ${data.totalToolUseCount}
duration_ms: ${data.totalDurationMs}</usage>`
        }]
      };
    }
    data satisfies never;
    throw new Error(`Unexpected agent tool result status: ${(data as {
      status: string;
    }).status}`);
  },
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseTag,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderGroupedToolUse: renderGroupedAgentToolUse
} satisfies ToolDef<InputSchema, Output, Progress>);
function resolveTeamName(input: {
  team_name?: string;
}, appState: {
  teamContext?: {
    teamName: string;
  };
}): string | undefined {
  if (!isAgentSwarmsEnabled()) return undefined;
  return input.team_name || appState.teamContext?.teamName;
}