import type { Attachment } from 'src/utils/attachments.js'
import type { Message, NormalizedMessage } from '../../types/message.js'

/**
 * AttachmentMessage 无条件渲染为 `null` 的附件类型（无论运行时状态如何都不产生可见输出）。
 * Messages.tsx 会在渲染上限/消息计数之前过滤掉这些，从而让不可见的条目不会占用
 * 200 条消息的渲染预算（CC-724）。
 *
 * 同步由 TypeScript 保证：AttachmentMessage 的 switch `default:` 分支会断言
 * `attachment.type satisfies NullRenderingAttachmentType`。若新增了 Attachment 类型
 * 却没有对应的 case 或此处条目，将通过类型检查失败。
 */
const NULL_RENDERING_TYPES = [
  'hook_success',
  'hook_additional_context',
  'hook_cancelled',
  'command_permissions',
  'agent_mention',
  'budget_usd',
  'critical_system_reminder',
  'edited_image_file',
  'edited_text_file',
  'opened_file_in_ide',
  'output_style',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'structured_output',
  'team_context',
  'todo_reminder',
  'context_efficiency',
  'deferred_tools_delta',
  'mcp_instructions_delta',
  'companion_intro',
  'token_usage',
  'ultrathink_effort',
  'max_turns_reached',
  'task_reminder',
  'auto_mode',
  'auto_mode_exit',
  'output_token_usage',
  'pen_mode_enter',
  'pen_mode_exit',
  'verify_plan_reminder',
  'current_session_memory',
  'compaction_reminder',
  'date_change',
] as const satisfies readonly Attachment['type'][]

export type NullRenderingAttachmentType = (typeof NULL_RENDERING_TYPES)[number]

const NULL_RENDERING_ATTACHMENT_TYPES: ReadonlySet<Attachment['type']> =
  new Set(NULL_RENDERING_TYPES)

/**
 * 当该消息是一个被 AttachmentMessage 渲染为 null 且无可见输出的附件时为 true。
 * Messages.tsx 会在计数以及施加 200 条消息渲染上限之前过滤掉这些，因此不可见的
 * hook 附件（hook_success、hook_additional_context、hook_cancelled）不会虚增
 * “N 条消息”计数，也不会挤占渲染预算（CC-724）。
 */
export function isNullRenderingAttachment(
  msg: Message | NormalizedMessage,
): boolean {
  return (
    msg.type === 'attachment' &&
    NULL_RENDERING_ATTACHMENT_TYPES.has(msg.attachment.type)
  )
}
