import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  type GlobalConfig,
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
} from '../../utils/config.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { CONFIG_TOOL_NAME } from './constants.js'
import { DESCRIPTION, generatePrompt } from './prompt.js'
import {
  getConfig,
  getOptionsForSetting,
  getPath,
  isSupported,
} from './supportedSettings.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    setting: z
      .string()
      .describe(
        '设置键（例如 "theme"、"model"、"permissions.defaultMode"）',
      ),
    value: z
      .union([z.string(), z.boolean(), z.number()])
      .optional()
      .describe('新值。省略以获取当前值。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    operation: z.enum(['get', 'set']).optional(),
    setting: z.string().optional(),
    value: z.unknown().optional(),
    previousValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

export const ConfigTool = buildTool({
  name: CONFIG_TOOL_NAME,
  searchHint: 'get or set Limkenion settings (theme, model)',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return generatePrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Config'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input: Input) {
    return input.value === undefined
  },
  toAutoClassifierInput(input) {
    return input.value === undefined
      ? input.setting
      : `${input.setting} = ${input.value}`
  },
  async checkPermissions(input: Input) {
    // 自动允许读取配置
    if (input.value === undefined) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'ask' as const,
      message: `Set ${input.setting} to ${jsonStringify(input.value)}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call({ setting, value }: Input, context): Promise<{ data: Output }> {
    // 1. 检查该设置是否受支持
    // （语音模式已移除——voiceEnabled 不再注册后，会落入下方的
    // 未知设置分支。）
    if (!isSupported(setting)) {
      return {
        data: { success: false, error: `Unknown setting: "${setting}"` },
      }
    }

    const config = getConfig(setting)!
    const path = getPath(setting)

    // 2. GET 操作
    if (value === undefined) {
      const currentValue = getValue(config.source, path)
      const displayValue = config.formatOnRead
        ? config.formatOnRead(currentValue)
        : currentValue
      return {
        data: { success: true, operation: 'get', setting, value: displayValue },
      }
    }

    // 3. SET 操作

    // 处理 "default"——取消该配置键，使其降级为
    // 平台感知的默认值（由 bridge 功能门控决定）。
    if (
      setting === 'remoteControlAtStartup' &&
      typeof value === 'string' &&
      value.toLowerCase().trim() === 'default'
    ) {
      saveGlobalConfig(prev => {
        if (prev.remoteControlAtStartup === undefined) return prev
        const next = { ...prev }
        delete next.remoteControlAtStartup
        return next
      })
      const resolved = getRemoteControlAtStartup()
      // 同步到 AppState，使 useReplBridge 立即响应
      context.setAppState(prev => {
        if (prev.replBridgeEnabled === resolved && !prev.replBridgeOutboundOnly)
          return prev
        return {
          ...prev,
          replBridgeEnabled: resolved,
          replBridgeOutboundOnly: false,
        }
      })
      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          value: resolved,
        },
      }
    }

    let finalValue: unknown = value

    // 强制转换并校验布尔值
    if (config.type === 'boolean') {
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim()
        if (lower === 'true') finalValue = true
        else if (lower === 'false') finalValue = false
      }
      if (typeof finalValue !== 'boolean') {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: `${setting} requires true or false.`,
          },
        }
      }
    }

    // 检查选项
    const options = getOptionsForSetting(setting)
    if (options && !options.includes(String(finalValue))) {
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: `Invalid value "${value}". Options: ${options.join(', ')}`,
        },
      }
    }

    // 异步校验（例如模型 API 检查）
    if (config.validateOnWrite) {
      const result = await config.validateOnWrite(finalValue)
      if (!result.valid) {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: result.error,
          },
        }
      }
    }

    const previousValue = getValue(config.source, path)

    // 4. 写入存储
    try {
      if (config.source === 'global') {
        const key = path[0]
        if (!key) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: 'Invalid setting path',
            },
          }
        }
        saveGlobalConfig(prev => {
          if (prev[key as keyof GlobalConfig] === finalValue) return prev
          return { ...prev, [key]: finalValue }
        })
      } else {
        const update = buildNestedObject(path, finalValue)
        const result = updateSettingsForSource('userSettings', update)
        if (result.error) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: result.error.message,
            },
          }
        }
      }

      // 5a. 语音需要 notifyChange，以便 applySettingsChange 重新同步
      // AppState.settings（useVoiceEnabled 读取 settings.voiceEnabled）
      // 并在下次 /voice 读取时重置设置缓存。
      if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
        const { settingsChangeDetector } = await import(
          '../../utils/settings/changeDetector.js'
        )
        settingsChangeDetector.notifyChange('userSettings')
      }

      // 5b. 如需立即产生 UI 效果，则同步到 AppState
      if (config.appStateKey) {
        const appKey = config.appStateKey
        context.setAppState(prev => {
          if (prev[appKey] === finalValue) return prev
          return { ...prev, [appKey]: finalValue }
        })
      }

      // 将 remoteControlAtStartup 同步到 AppState，使 bridge 立即响应
      // （该配置键与 AppState 字段名不同，
      // 因此通用的 appStateKey 机制无法处理。）
      if (setting === 'remoteControlAtStartup') {
        const resolved = getRemoteControlAtStartup()
        context.setAppState(prev => {
          if (
            prev.replBridgeEnabled === resolved &&
            !prev.replBridgeOutboundOnly
          )
            return prev
          return {
            ...prev,
            replBridgeEnabled: resolved,
            replBridgeOutboundOnly: false,
          }
        })
      }

      logEvent('limkenion_config_tool_changed', {
        setting:
          setting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: String(
          finalValue,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          previousValue,
          newValue: finalValue,
        },
      }
    } catch (error) {
      logError(error)
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: errorMessage(error),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.success) {
      if (content.operation === 'get') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `${content.setting} = ${jsonStringify(content.value)}`,
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `Set ${content.setting} to ${jsonStringify(content.newValue)}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Error: ${content.error}`,
      is_error: true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function getValue(source: 'global' | 'settings', path: string[]): unknown {
  if (source === 'global') {
    const config = getGlobalConfig()
    const key = path[0]
    if (!key) return undefined
    return config[key as keyof GlobalConfig]
  }
  const settings = getInitialSettings()
  let current: unknown = settings
  for (const key of path) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

function buildNestedObject(
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) {
    return {}
  }
  const key = path[0]!
  if (path.length === 1) {
    return { [key]: value }
  }
  return { [key]: buildNestedObject(path.slice(1), value) }
}
