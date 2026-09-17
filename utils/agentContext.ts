/**
 * 用于分析归属的 agent 上下文，基于 AsyncLocalStorage。
 *
 * 本模块提供一种在异步操作之间追踪 agent 身份的方法，无需逐层传参。
 * 支持两种 agent 类型：
 *
 * 1. 子 agent（Agent 工具）：进程内运行，用于快速的委派任务。
 *    上下文：agentType: 'subagent' 的 SubagentContext
 *
 * 2. 进程内队友：属于带有团队协调的 swarm。
 *    上下文：agentType: 'teammate' 的 TeammateAgentContext
 *
 * 对于独立进程（tmux/iTerm2）中的 swarm 队友，改用环境变量：
 * LIMKENION_AGENT_ID、LIMKENION_PARENT_SESSION_ID
 *
 * 为什么用 AsyncLocalStorage（而非 AppState）：
 * 当 agents 被置为后台（ctrl+b）时，同一进程内可并发运行多个 agents。
 * AppState 是单一共享状态，会被覆盖，导致 agent A 的事件错误地用到
 * agent B 的上下文。AsyncLocalStorage 隔离每个异步执行链，使并发的
 * agents 互不干扰。
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'

/**
 * 子 agent（Agent 工具 agents）的上下文。
 * 子 agents 在进程内运行，用于快速的委派任务。
 */
export type SubagentContext = {
  /** 子 agent 的 UUID（来自 createAgentId()） */
  agentId: string
  /** 团队负责人的会话 ID（来自 LIMKENION_PARENT_SESSION_ID 环境变量），
   *  主 REPL 的子 agent 为 undefined */
  parentSessionId?: string
  /** agent 类型——Agent 工具 agents 为 'subagent' */
  agentType: 'subagent'
  /** 子 agent 的类型名（例如 "Explore"、"Bash"、"code-reviewer"） */
  subagentName?: string
  /** 是否内建 agent（vs 用户自定义的 agent） */
  isBuiltIn?: boolean
  /** 派生出或恢复此 agent 的调用方的 request_id。
   *  对嵌套子 agent 而言这是直接调用方而非根——
   *  session_id 已经打包了整棵树。每次恢复时更新。 */
  invokingRequestId?: string
  /** 该次调用是最初派生还是通过 SendMessage 的后续恢复。
   *  invokingRequestId 不存在时为 undefined。 */
  invocationKind?: 'spawn' | 'resume'
  /** 可变标志：此次调用的边是否已发给遥测？
   *  每次派生/恢复时重置为 false；在首个终端 API 事件上由
   *  consumeInvokingRequestId() 翻转为 true。 */
  invocationEmitted?: boolean
}

/**
 * 进程内队友的上下文。
 * 队友属于 swarm，具有团队协调。
 */
export type TeammateAgentContext = {
  /** 完整 agent ID，例如 "researcher@my-team" */
  agentId: string
  /** 显示名，例如 "researcher" */
  agentName: string
  /** 该队友所属的团队名 */
  teamName: string
  /** 分配给该队友的 UI 颜色 */
  agentColor?: string
  /** 队友实现前是否必须进入计划模式 */
  planModeRequired: boolean
  /** 用于 transcript 关联的团队负责人会话 ID */
  parentSessionId: string
  /** 该 agent 是否为团队负责人 */
  isTeamLead: boolean
  /** agent 类型——swarm 队友为 'teammate' */
  agentType: 'teammate'
  /** 派生出或恢复此队友的调用方的 request_id。在工具调用之外启动的
   *  队友（例如会话启动）为 undefined。每次恢复时更新。 */
  invokingRequestId?: string
  /** 参见 SubagentContext.invocationKind。 */
  invocationKind?: 'spawn' | 'resume'
  /** 可变标志：参见 SubagentContext.invocationEmitted。 */
  invocationEmitted?: boolean
}

/**
 * agent 上下文的判别联合。
 * 使用 agentType 区分子 agent 与队友上下文。
 */
export type AgentContext = SubagentContext | TeammateAgentContext

const agentContextStorage = new AsyncLocalStorage<AgentContext>()

/**
 * 获取当前 agent 上下文（如果有）。
 * 若未运行在（子 agent 或队友的）agent 上下文内则返回 undefined。
 * 使用类型守卫 isSubagentContext() 或 isTeammateAgentContext() 收窄类型。
 */
export function getAgentContext(): AgentContext | undefined {
  return agentContextStorage.getStore()
}

/**
 * 在给定 agent 上下文中运行异步函数。
 * 函数内的所有异步操作都能访问此上下文。
 */
export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContextStorage.run(context, fn)
}

/**
 * 判断上下文是否为 SubagentContext 的类型守卫。
 */
export function isSubagentContext(
  context: AgentContext | undefined,
): context is SubagentContext {
  return context?.agentType === 'subagent'
}

/**
 * 判断上下文是否为 TeammateAgentContext 的类型守卫。
 */
export function isTeammateAgentContext(
  context: AgentContext | undefined,
): context is TeammateAgentContext {
  if (isAgentSwarmsEnabled()) {
    return context?.agentType === 'teammate'
  }
  return false
}

/**
 * 获取适合分析日志的子 agent 名称。
 * 内建 agents 返回 agent 类型名，自定义 agents 返回 "user-defined"，
 * 若未运行在子 agent 上下文内则返回 undefined。
 *
 * 对分析元数据安全：内建 agent 名称是代码常量，
 * 自定义 agents 总是被映射为字面量 "user-defined"。
 */
export function getSubagentLogName():
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  | undefined {
  const context = getAgentContext()
  if (!isSubagentContext(context) || !context.subagentName) {
    return undefined
  }
  return (
    context.isBuiltIn ? context.subagentName : 'user-defined'
  ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 每次调用一次地获取当前 agent 上下文的调用方 request_id。在
 * 某次派生/恢复之后首次调用返回该 id，随后直到下一个边界才返回
 * undefined。主线程上或派生路径没有 request_id 时也是 undefined。
 *
 * 稀疏边的语义：invokingRequestId 在每次调用恰好一条
 * limkenion_api_success/error 上出现，因此下游的非 NULL 值
 * 标志着一个派生/恢复边界。
 */
export function consumeInvokingRequestId():
  | {
      invokingRequestId: string
      invocationKind: 'spawn' | 'resume' | undefined
    }
  | undefined {
  const context = getAgentContext()
  if (!context?.invokingRequestId || context.invocationEmitted) {
    return undefined
  }
  context.invocationEmitted = true
  return {
    invokingRequestId: context.invokingRequestId,
    invocationKind: context.invocationKind,
  }
}
