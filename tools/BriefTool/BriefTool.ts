import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, getUserMsgOptIn } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { plural } from '../../utils/stringUtils.js'
import { resolveAttachments, validateAttachmentPaths } from './attachments.js'
import {
  BRIEF_TOOL_NAME,
  BRIEF_TOOL_PROMPT,
  DESCRIPTION,
  LEGACY_BRIEF_TOOL_NAME,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z
      .string()
      .describe('给用户的消息。支持 markdown 格式。'),
    attachments: z
      .array(z.string())
      .optional()
      .describe(
        '可选的附件文件路径（绝对路径或相对当前工作目录）。用于照片、截图、差异、日志，或任何你希望用户在你的消息旁看到的文件。',
      ),
    status: z
      .enum(['normal', 'proactive'])
      .describe(
        "当你主动呈现用户并未要求、但需要现在看到的内容时，请使用 'proactive'——用户不在时完成任务、你遇到的阻塞、主动的状态更新。当你在回复用户刚说的话时，使用 'normal'。",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// attachments 必须保持可选——恢复的会话会逐字重放带附件的输出，
// 若为必选字段则会在恢复时崩溃 UI 渲染器。
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('消息'),
    attachments: z
      .array(
        z.object({
          path: z.string(),
          size: z.number(),
          isImage: z.boolean(),
          file_uuid: z.string().optional(),
        }),
      )
      .optional()
      .describe('解析后的附件元数据'),
    sentAt: z
      .string()
      .optional()
      .describe(
        '在发送进程执行工具时捕获的 ISO 时间戳。可选——恢复的会话会逐字重放未含 sentAt 的输出。',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const KAIROS_BRIEF_REFRESH_MS = 5 * 60 * 1000

/**
 * 授权检查——用户是否有权使用 Brief？它结合了构建期
 * 标志、运行时 GB 门控以及助手模式直通。此处不做主动选择（opt-in）检查
 * ——这里决定的是是否应当尊重主动选择，而不是用户
 * 是否已主动选择。
 *
 * 构建期以 KAIROS || KAIROS_BRIEF 做 OR 门控（与
 * PROACTIVE || KAIROS 同一模式）：助手模式依赖 Brief，因此仅有 KAIROS
 * 也必须打包它。KAIROS_BRIEF 则让 Brief 可以独立发布。
 *
 * 用它来决定是否应尊重 `--brief` / `defaultView: 'chat'` / `--tools`
 * 列表。用 `isBriefEnabled()` 判断该工具在当前会话中
 * 是否真正生效。
 *
 * LIMKENION_BRIEF 环境变量在开发/测试时强制授予权限——
 * 绕过 GB 门控，让你无需被纳入即可测试。它仍
 * 需要一次主动选择操作才能激活（--brief、defaultView 等），但
 * 仅该环境变量本身也会通过 maybeActivateBrief() 设置 userMsgOptIn。
 */
export function isBriefEntitled(): boolean {
  // 正向三元表达式——见 docs/feature-gating.md。反向提前返回
  // 无法从外部构建中消除 GB 门控字符串。
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? getKairosActive() ||
        isEnvTruthy(process.env.LIMKENION_BRIEF) ||
        getFeatureValue_CACHED_WITH_REFRESH(
          'limkenion_kairos_brief',
          false,
          KAIROS_BRIEF_REFRESH_MS,
        )
    : false
}

/**
 * Brief 工具的统一激活门控。它作为一个整体管理面向模型的行为：
 * 工具可用性、系统提示词段落（getBriefSection）、
 * 工具延迟绕过（isDeferredTool）以及 todo 提醒抑制。
 *
 * 激活需要显式主动选择（userMsgOptIn），由以下之一设置：
 *   - `--brief` CLI 标志（main.tsx 中的 maybeActivateBrief）
 *   - 设置中的 `defaultView: 'chat'`（main.tsx 初始化）
 *   - `/brief` 斜杠命令（brief.ts）
 *   - `/config` 的 defaultView 选择器（Config.tsx）
 *   - `--tools` / SDK `tools` 选项中的 SendUserMessage（main.tsx）
 *   - LIMKENION_BRIEF 环境变量（maybeActivateBrief——开发/测试绕过）
 * 助手模式（kairosActive）会绕过主动选择，因为其系统提示词
 * 硬编码了 "you MUST use SendUserMessage"（systemPrompt.md:14）。
 *
 * 此处重新检查 GB 门控作为终止开关，并且——在会话中途将
 * limkenion_kairos_brief 关闭，会在下一次 5 分钟刷新时禁用该工具，
 * 即使对已主动选择的会话也是如此。无主动选择 → 无论 GB 如何都为 false
 * （这是对 "brief defaults on for enrolled ants" 的修复）。
 *
 * 由 Tool.isEnabled() 调用（惰性、初始化后），绝不在模块作用域调用。
 * getKairosActive() 和 getUserMsgOptIn() 在任何调用方到达此处之前
 * 已在 main.tsx 中设置。
 */
export function isBriefEnabled(): boolean {
  // 顶层 feature() 守卫对 DCE 至关重要：Bun 可以在外部构建中把该三元
  // 表达式常量折叠为 `false`，进而将 BriefTool 对象按死代码消除。
  // 仅组合 isBriefEntitled()（它自带守卫）在语义上等价，
  // 但会破坏跨边界的常量折叠。
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (getKairosActive() || getUserMsgOptIn()) && isBriefEntitled()
    : false
}

export const BriefTool = buildTool({
  name: BRIEF_TOOL_NAME,
  aliases: [LEGACY_BRIEF_TOOL_NAME],
  searchHint:
    'send a message to the user — your primary visible output channel',
  maxResultSizeChars: 100_000,
  userFacingName() {
    return ''
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isBriefEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.message
  },
  async validateInput({ attachments }, _context): Promise<ValidationResult> {
    if (!attachments || attachments.length === 0) {
      return { result: true }
    }
    return validateAttachmentPaths(attachments)
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return BRIEF_TOOL_PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const n = output.attachments?.length ?? 0
    const suffix = n === 0 ? '' : ` (${n} ${plural(n, 'attachment')} included)`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Message delivered to user.${suffix}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ message, attachments, status }, context) {
    const sentAt = new Date().toISOString()
    logEvent('limkenion_brief_send', {
      proactive: status === 'proactive',
      attachment_count: attachments?.length ?? 0,
    })
    if (!attachments || attachments.length === 0) {
      return { data: { message, sentAt } }
    }
    const appState = context.getAppState()
    const resolved = await resolveAttachments(attachments, {
      replBridgeEnabled: appState.replBridgeEnabled,
      signal: context.abortController.signal,
    })
    return {
      data: { message, attachments: resolved, sentAt },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
