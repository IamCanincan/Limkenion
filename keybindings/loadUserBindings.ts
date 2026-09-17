/**
 * 用户键位绑定配置加载器，支持热重载。
 *
 * 从 ~/.limkenion/keybindings.json 加载键位绑定，并监听
 * 文件变化以自动重新加载。
 *
 * 注意：用户键位绑定自定义目前仅对 Limkenion 员工
 * 开放（USER_TYPE === 'ant'）。外部用户始终
 * 使用默认绑定。
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { readFileSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { getLimkenionConfigHomeDir } from '../utils/envUtils.js'
import { errorMessage, isENOENT } from '../utils/errors.js'
import { createSignal } from '../utils/signal.js'
import { jsonParse } from '../utils/slowOperations.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { parseBindings } from './parser.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'
import {
  checkDuplicateKeysInJson,
  type KeybindingWarning,
  validateBindings,
} from './validate.js'

/**
 * 检查键位绑定自定义是否已启用。
 *
 * 当 limkenion_keybinding_customization_release 这个 GrowthBook 开关启用时返回 true。
 *
 * 导出该函数是为了让代码库的其他部分（例如 /doctor）
 * 能以一致的方式检查同一条件。
 */
export function isKeybindingCustomizationEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'limkenion_keybinding_customization_release',
    false,
  )
}

/**
 * 等待文件写入稳定所需的时间（毫秒）。
 */
const FILE_STABILITY_THRESHOLD_MS = 500

/**
 * 检查文件稳定性的轮询间隔。
 */
const FILE_STABILITY_POLL_INTERVAL_MS = 200

/**
 * 加载键位绑定的结果，包含任何校验警告。
 */
export type KeybindingsLoadResult = {
  bindings: ParsedBinding[]
  warnings: KeybindingWarning[]
}

let watcher: FSWatcher | null = null
let initialized = false
let disposed = false
let cachedBindings: ParsedBinding[] | null = null
let cachedWarnings: KeybindingWarning[] = []
const keybindingsChanged = createSignal<[result: KeybindingsLoadResult]>()

/**
 * 记录我们上次上报自定义键位绑定加载事件的日期（YYYY-MM-DD）。
 * 用于确保该事件每天最多触发一次。
 */
let lastCustomBindingsLogDate: string | null = null

/**
 * 在加载自定义键位绑定时上报遥测事件，每天最多一次。
 * 这让我们可以估算自定义键位绑定的用户比例。
 */
function logCustomBindingsLoadedOncePerDay(userBindingCount: number): void {
  const today = new Date().toISOString().slice(0, 10)
  if (lastCustomBindingsLogDate === today) return
  lastCustomBindingsLogDate = today
  logEvent('limkenion_custom_keybindings_loaded', {
    user_binding_count: userBindingCount,
  })
}

/**
 * 类型守卫，用于检查对象是否为有效的 KeybindingBlock。
 */
function isKeybindingBlock(obj: unknown): obj is KeybindingBlock {
  if (typeof obj !== 'object' || obj === null) return false
  const b = obj as Record<string, unknown>
  return (
    typeof b.context === 'string' &&
    typeof b.bindings === 'object' &&
    b.bindings !== null
  )
}

/**
 * 类型守卫，用于检查数组是否只包含有效的 KeybindingBlock。
 */
function isKeybindingBlockArray(arr: unknown): arr is KeybindingBlock[] {
  return Array.isArray(arr) && arr.every(isKeybindingBlock)
}

/**
 * 获取用户键位绑定文件的路径。
 */
export function getKeybindingsPath(): string {
  return join(getLimkenionConfigHomeDir(), 'keybindings.json')
}

/**
 * 解析默认绑定（为提升性能而缓存）。
 */
function getDefaultParsedBindings(): ParsedBinding[] {
  return parseBindings(DEFAULT_BINDINGS)
}

/**
 * 从用户配置文件加载并解析键位绑定。
 * 返回合并后的默认绑定 + 用户绑定以及校验警告。
 *
 * 对外部用户，始终只返回默认绑定。
 * 用户自定义目前仅限 Limkenion 员工使用。
 */
export async function loadKeybindings(): Promise<KeybindingsLoadResult> {
  const defaultBindings = getDefaultParsedBindings()

  // 外部用户跳过加载用户配置
  if (!isKeybindingCustomizationEnabled()) {
    return { bindings: defaultBindings, warnings: [] }
  }

  const userPath = getKeybindingsPath()

  try {
    const content = await readFile(userPath, 'utf-8')
    const parsed: unknown = jsonParse(content)

    // 从对象包装格式中提取 bindings 数组：{ "bindings": [...] }
    let userBlocks: unknown
    if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
      userBlocks = (parsed as { bindings: unknown }).bindings
    } else {
      // 格式无效 —— 缺少 bindings 属性
      const errorMessage = 'keybindings.json must have a "bindings" array'
      const suggestion = 'Use format: { "bindings": [ ... ] }'
      logForDebugging(`[keybindings] Invalid keybindings.json: ${errorMessage}`)
      return {
        bindings: defaultBindings,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }

    // 校验结构 —— bindings 必须是有效键位绑定块组成的数组
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      logForDebugging(`[keybindings] Invalid keybindings.json: ${errorMessage}`)
      return {
        bindings: defaultBindings,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }

    const userParsed = parseBindings(userBlocks)
    logForDebugging(
      `[keybindings] Loaded ${userParsed.length} user bindings from ${userPath}`,
    )

    // 用户绑定排在默认绑定之后，因此会覆盖它们
    const mergedBindings = [...defaultBindings, ...userParsed]

    logCustomBindingsLoadedOncePerDay(userParsed.length)

    // 对用户配置运行校验
    // 先检查原始 JSON 中的重复键（JSON.parse 会静默丢弃靠前的值）
    const duplicateKeyWarnings = checkDuplicateKeysInJson(content)
    const warnings = [
      ...duplicateKeyWarnings,
      ...validateBindings(userBlocks, mergedBindings),
    ]

    if (warnings.length > 0) {
      logForDebugging(
        `[keybindings] Found ${warnings.length} validation issue(s)`,
      )
    }

    return { bindings: mergedBindings, warnings }
  } catch (error) {
    // 文件不存在 —— 使用默认值（用户可运行 /keybindings 创建）
    if (isENOENT(error)) {
      return { bindings: defaultBindings, warnings: [] }
    }

    // 其他错误 —— 记录日志并返回默认值及警告
    logForDebugging(
      `[keybindings] Error loading ${userPath}: ${errorMessage(error)}`,
    )
    return {
      bindings: defaultBindings,
      warnings: [
        {
          type: 'parse_error',
          severity: 'error',
          message: `Failed to parse keybindings.json: ${errorMessage(error)}`,
        },
      ],
    }
  }
}

/**
 * 同步加载键位绑定（用于首次渲染）。
 * 若有缓存值则使用缓存值。
 */
export function loadKeybindingsSync(): ParsedBinding[] {
  if (cachedBindings) {
    return cachedBindings
  }

  const result = loadKeybindingsSyncWithWarnings()
  return result.bindings
}

/**
 * 同步加载键位绑定并返回校验警告。
 * 若有缓存值则使用缓存值。
 *
 * 对外部用户，始终只返回默认绑定。
 * 用户自定义目前仅限 Limkenion 员工使用。
 */
export function loadKeybindingsSyncWithWarnings(): KeybindingsLoadResult {
  if (cachedBindings) {
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }

  const defaultBindings = getDefaultParsedBindings()

  // 外部用户跳过加载用户配置
  if (!isKeybindingCustomizationEnabled()) {
    cachedBindings = defaultBindings
    cachedWarnings = []
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }

  const userPath = getKeybindingsPath()

  try {
    // 同步 IO：从同步上下文调用（React useState 初始化器）
    const content = readFileSync(userPath, 'utf-8')
    const parsed: unknown = jsonParse(content)

    // 从对象包装格式中提取 bindings 数组：{ "bindings": [...] }
    let userBlocks: unknown
    if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
      userBlocks = (parsed as { bindings: unknown }).bindings
    } else {
      // 格式无效 —— 缺少 bindings 属性
      cachedBindings = defaultBindings
      cachedWarnings = [
        {
          type: 'parse_error',
          severity: 'error',
          message: 'keybindings.json must have a "bindings" array',
          suggestion: 'Use format: { "bindings": [ ... ] }',
        },
      ]
      return { bindings: cachedBindings, warnings: cachedWarnings }
    }

    // 校验结构 —— bindings 必须是有效键位绑定块组成的数组
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      cachedBindings = defaultBindings
      cachedWarnings = [
        {
          type: 'parse_error',
          severity: 'error',
          message: errorMessage,
          suggestion,
        },
      ]
      return { bindings: cachedBindings, warnings: cachedWarnings }
    }

    const userParsed = parseBindings(userBlocks)
    logForDebugging(
      `[keybindings] Loaded ${userParsed.length} user bindings from ${userPath}`,
    )
    cachedBindings = [...defaultBindings, ...userParsed]

    logCustomBindingsLoadedOncePerDay(userParsed.length)

    // 运行校验 —— 先检查原始 JSON 中的重复键
    const duplicateKeyWarnings = checkDuplicateKeysInJson(content)
    cachedWarnings = [
      ...duplicateKeyWarnings,
      ...validateBindings(userBlocks, cachedBindings),
    ]
    if (cachedWarnings.length > 0) {
      logForDebugging(
        `[keybindings] Found ${cachedWarnings.length} validation issue(s)`,
      )
    }

    return { bindings: cachedBindings, warnings: cachedWarnings }
  } catch {
    // 文件不存在或出错 —— 使用默认值（用户可运行 /keybindings 创建）
    cachedBindings = defaultBindings
    cachedWarnings = []
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }
}

/**
 * 初始化对 keybindings.json 的文件监听。
 * 在应用启动时调用一次。
 *
 * 对外部用户这是空操作，因为用户自定义已被禁用。
 */
export async function initializeKeybindingWatcher(): Promise<void> {
  if (initialized || disposed) return

  // 外部用户跳过文件监听
  if (!isKeybindingCustomizationEnabled()) {
    logForDebugging(
      '[keybindings] Skipping file watcher - user customization disabled',
    )
    return
  }

  const userPath = getKeybindingsPath()
  const watchDir = dirname(userPath)

  // 仅在父目录存在时才监听
  try {
    const stats = await stat(watchDir)
    if (!stats.isDirectory()) {
      logForDebugging(
        `[keybindings] Not watching: ${watchDir} is not a directory`,
      )
      return
    }
  } catch {
    logForDebugging(`[keybindings] Not watching: ${watchDir} does not exist`)
    return
  }

  // 仅在确认可以监听之后才设置 initialized
  initialized = true

  logForDebugging(`[keybindings] Watching for changes to ${userPath}`)

  watcher = chokidar.watch(userPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: FILE_STABILITY_THRESHOLD_MS,
      pollInterval: FILE_STABILITY_POLL_INTERVAL_MS,
    },
    ignorePermissionErrors: true,
    usePolling: false,
    atomic: true,
  })

  watcher.on('add', handleChange)
  watcher.on('change', handleChange)
  watcher.on('unlink', handleDelete)

  // 注册清理逻辑
  registerCleanup(async () => disposeKeybindingWatcher())
}

/**
 * 清理文件监听器。
 */
export function disposeKeybindingWatcher(): void {
  disposed = true
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  keybindingsChanged.clear()
}

/**
 * 订阅键位绑定变更。
 * 文件变化时，监听器会收到新解析出的绑定。
 */
export const subscribeToKeybindingChanges = keybindingsChanged.subscribe

async function handleChange(path: string): Promise<void> {
  logForDebugging(`[keybindings] Detected change to ${path}`)

  try {
    const result = await loadKeybindings()
    cachedBindings = result.bindings
    cachedWarnings = result.warnings

    // 用完整结果通知所有监听器
    keybindingsChanged.emit(result)
  } catch (error) {
    logForDebugging(`[keybindings] Error reloading: ${errorMessage(error)}`)
  }
}

function handleDelete(path: string): void {
  logForDebugging(`[keybindings] Detected deletion of ${path}`)

  // 文件被删除时重置为默认值
  const defaultBindings = getDefaultParsedBindings()
  cachedBindings = defaultBindings
  cachedWarnings = []

  keybindingsChanged.emit({ bindings: defaultBindings, warnings: [] })
}

/**
 * 获取缓存的键位绑定警告。
 * 若无警告或绑定尚未加载，则返回空数组。
 */
export function getCachedKeybindingWarnings(): KeybindingWarning[] {
  return cachedWarnings
}

/**
 * 重置内部状态以便测试。
 */
export function resetKeybindingLoaderForTesting(): void {
  initialized = false
  disposed = false
  cachedBindings = null
  cachedWarnings = []
  lastCustomBindingsLogDate = null
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  keybindingsChanged.clear()
}
