import type { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { BashTool } from './BashTool.js'

const ACCEPT_EDITS_ALLOWED_COMMANDS = [
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
] as const

type FilesystemCommand = (typeof ACCEPT_EDITS_ALLOWED_COMMANDS)[number]

function isFilesystemCommand(command: string): command is FilesystemCommand {
  return ACCEPT_EDITS_ALLOWED_COMMANDS.includes(command as FilesystemCommand)
}

function validateCommandForMode(
  cmd: string,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const trimmedCmd = cmd.trim()
  const [baseCmd] = trimmedCmd.split(/\s+/)

  if (!baseCmd) {
    return {
      behavior: 'passthrough',
      message: '未找到基础命令',
    }
  }

  // 在“接受编辑”模式下，自动允许文件系统操作
  if (
    toolPermissionContext.mode === 'acceptEdits' &&
    isFilesystemCommand(baseCmd)
  ) {
    return {
      behavior: 'allow',
      updatedInput: { command: cmd },
      decisionReason: {
        type: 'mode',
        mode: 'acceptEdits',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: `在 ${toolPermissionContext.mode} 模式下，'${baseCmd}' 无模式相关的特殊处理`,
  }
}

/**
 * 根据当前权限模式检查命令是否应以不同方式处理。
 *
 * 这是基于模式的权限逻辑的主入口。
 * 目前处理“接受编辑”模式下的文件系统命令，
 * 但设计为可扩展到其他模式。
 *
 * @param input - bash 命令输入
 * @param toolPermissionContext - 包含模式与权限的上下文
 * @returns
 * - 'allow' 如果当前模式允许自动批准
 * - 'ask' 如果命令在当前模式下需要批准
 * - 'passthrough' 如果没有适用的模式相关处理
 */
export function checkPermissionMode(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  // 如果处于绕过权限模式则跳过（在其他地方处理）
  if (toolPermissionContext.mode === 'bypassPermissions') {
    return {
      behavior: 'passthrough',
      message: '绕过权限模式在主权限流程中处理',
    }
  }

  // 如果处于 dontAsk 模式则跳过（在主权限流程中处理）
  if (toolPermissionContext.mode === 'dontAsk') {
    return {
      behavior: 'passthrough',
      message: 'dontAsk 模式在主权限流程中处理',
    }
  }

  const commands = splitCommand_DEPRECATED(input.command)

  // 依次检查每个子命令
  for (const cmd of commands) {
    const result = validateCommandForMode(cmd, toolPermissionContext)

    // 若有任一命令触发了模式相关行为，则返回该结果
    if (result.behavior !== 'passthrough') {
      return result
    }
  }

  // 没有需要模式相关的处理
  return {
    behavior: 'passthrough',
    message: '无需模式相关的校验',
  }
}

