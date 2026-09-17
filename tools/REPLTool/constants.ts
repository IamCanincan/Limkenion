import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'

export const REPL_TOOL_NAME = 'REPL'

/**
 * 在交互式 CLI 中，REPL 模式对 ant 默认开启（可用
 * LIMKENION_REPL=0 关闭）。旧的 LIMKENION_REPL_MODE=1 同样会强制开启。
 *
 * SDK 入口（sdk-ts、sdk-py、sdk-cli）则不会默认开启 —— SDK
 * 使用方会自行编排直接的工具调用（Bash、Read 等），而 REPL 模式
 * 会隐藏这些工具。USER_TYPE 是构建期的 --define，否则 ant-native
 * 二进制会对每个 SDK 子进程强制开启 REPL 模式，而不论
 * 调用方传入的环境变量为何。
 */
export function isReplModeEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.LIMKENION_REPL)) return false
  if (isEnvTruthy(process.env.LIMKENION_REPL_MODE)) return true
  return (
    false
  )
}

/**
 * 仅在启用 REPL 模式时才能通过 REPL 访问的工具。
 * 当 REPL 模式开启时，这些工具会从 Limkenion 的直接使用中隐藏，
 * 迫使 Limkenion 使用 REPL 进行批量操作。
 */
export const REPL_ONLY_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  AGENT_TOOL_NAME,
])
