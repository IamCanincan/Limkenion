import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, setUserMsgOptIn } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import { isBriefEntitled } from '../tools/BriefTool/BriefTool.js'
import { BRIEF_TOOL_NAME } from '../tools/BriefTool/prompt.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import { lazySchema } from '../utils/lazySchema.js'

// Zod 防止误推送的 GB 配置（与 pollConfig.ts / cronScheduler.ts 相同的模式）。
// 格式错误的配置会完全回退到 DEFAULT_BRIEF_CONFIG，
// 而不会被部分信任。
const briefConfigSchema = lazySchema(() =>
  z.object({
    enable_slash_command: z.boolean(),
  }),
)
type BriefConfig = z.infer<ReturnType<typeof briefConfigSchema>>

const DEFAULT_BRIEF_CONFIG: BriefConfig = {
  enable_slash_command: false,
}

// 无 TTL——这个门控控制的是斜杠命令的*可见性*，而非开关。
// CACHED_MAY_BE_STALE 仍有一次后台更新的翻转（首次调用触发拉取，
// 第二次调用看到新值），但此后不再有额外翻转。
// 工具可用性门控（isBriefEnabled 中的 limkenion_kairos_brief）保持其
// 5 分钟 TTL，因为那个才是真正的开关。
function getBriefConfig(): BriefConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'limkenion_kairos_brief_config',
    DEFAULT_BRIEF_CONFIG,
  )
  const parsed = briefConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_BRIEF_CONFIG
}

const brief = {
  type: 'local-jsx',
  name: 'brief',
  description: '切换仅简报模式',
  isEnabled: () => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      return getBriefConfig().enable_slash_command
    }
    return false
  },
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        const current = context.getAppState().isBriefOnly
        const newState = !current

        // 资格检查只约束"开启"这一操作——关闭始终允许，
        // 以免用户会话中途 GB 门控翻转时卡死。
        if (newState && !isBriefEntitled()) {
          logEvent('limkenion_brief_mode_toggled', {
            enabled: false,
            gated: true,
            source:
              'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          onDone('你的账号未启用 Brief 工具', {
            display: 'system',
          })
          return null
        }

        // 双向：userMsgOptIn 追踪 isBriefOnly，使得工具恰好在简报模式开启时
        // 可用。这会在每次切换时使提示词缓存失效（工具列表变了），
        // 但工具列表过期更糟——当 /brief 在会话中途启用时，
        // 模型此前没拿到该工具，会输出被过滤器隐藏的纯文本。
        setUserMsgOptIn(newState)

        context.setAppState(prev => {
          if (prev.isBriefOnly === newState) return prev
          return { ...prev, isBriefOnly: newState }
        })

        logEvent('limkenion_brief_mode_toggled', {
          enabled: newState,
          gated: false,
          source:
            'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })

        // 仅仅改变工具列表在会话中途不是足够强的信号
        //（模型可能出于惯性继续输出纯文本，或继续调用一个刚消失的工具）。
        // 在下一轮上下文注入一条明确的提醒，让切换无歧义。
        // 当 Kairos 激活时跳过：isBriefEnabled() 在 getKairosActive() 处短路，
        // 工具其实从未离开列表，且 Kairos 系统提示词已强制要求 SendUserMessage。
        // 内联 <system-reminder> 包裹——如果从 utils/messages.ts import
        // wrapInSystemReminder，就会通过本模块的 import 链把 constants/xml.ts
        // 拉进桥接 SDK 打包，触发排除字符串检查。
        const metaMessages = getKairosActive()
          ? undefined
          : [
              `<system-reminder>\n${
                newState
                  ? `简报模式现已启用。所有面向用户的输出都要用 ${BRIEF_TOOL_NAME} 工具——工具之外输出的纯文本对用户是不可见的。`
                  : `简报模式现已禁用。${BRIEF_TOOL_NAME} 工具已不可用——请直接用纯文本回复。`
              }\n</system-reminder>`,
            ]

        onDone(
          newState ? '已启用仅简报模式' : '已禁用仅简报模式',
          { display: 'system', metaMessages },
        )
        return null
      },
    }),
} satisfies Command

export default brief
