import { getPlatform } from '../utils/platform.js'

/**
 * 通常会被操作系统、终端或 shell 拦截的快捷键，
 * 很可能永远到不了应用。
 */
export type ReservedShortcut = {
  key: string
  reason: string
  severity: 'error' | 'warning'
}

/**
 * 无法重新绑定的快捷键 —— 它们在 Limkenion 中硬编码。
 */
export const NON_REBINDABLE: ReservedShortcut[] = [
  {
    key: 'ctrl+c',
    reason: 'Cannot be rebound - used for interrupt/exit (hardcoded)',
    severity: 'error',
  },
  {
    key: 'ctrl+d',
    reason: 'Cannot be rebound - used for exit (hardcoded)',
    severity: 'error',
  },
  {
    key: 'ctrl+m',
    reason:
      'Cannot be rebound - identical to Enter in terminals (both send CR)',
    severity: 'error',
  },
]

/**
 * 会被终端/操作系统拦截的终端控制快捷键。
 * 它们很可能永远到不了应用。
 *
 * 注意：ctrl+s（XOFF）和 ctrl+q（XON）不包含在此，因为：
 * - 大多数现代终端默认禁用流控
 * - 我们把 ctrl+s 用于 stash 功能
 */
export const TERMINAL_RESERVED: ReservedShortcut[] = [
  {
    key: 'ctrl+z',
    reason: 'Unix process suspend (SIGTSTP)',
    severity: 'warning',
  },
  {
    key: 'ctrl+\\',
    reason: 'Terminal quit signal (SIGQUIT)',
    severity: 'error',
  },
]

/**
 * 会被操作系统拦截的 macOS 专属快捷键。
 */
export const MACOS_RESERVED: ReservedShortcut[] = [
  { key: 'cmd+c', reason: 'macOS system copy', severity: 'error' },
  { key: 'cmd+v', reason: 'macOS system paste', severity: 'error' },
  { key: 'cmd+x', reason: 'macOS system cut', severity: 'error' },
  { key: 'cmd+q', reason: 'macOS quit application', severity: 'error' },
  { key: 'cmd+w', reason: 'macOS close window/tab', severity: 'error' },
  { key: 'cmd+tab', reason: 'macOS app switcher', severity: 'error' },
  { key: 'cmd+space', reason: 'macOS Spotlight', severity: 'error' },
]

/**
 * 获取当前平台的所有保留快捷键。
 * 包含不可重新绑定的快捷键和终端保留的快捷键。
 */
export function getReservedShortcuts(): ReservedShortcut[] {
  const platform = getPlatform()
  // 不可重新绑定的快捷键在前（最高优先级）
  const reserved = [...NON_REBINDABLE, ...TERMINAL_RESERVED]

  if (platform === 'macos') {
    reserved.push(...MACOS_RESERVED)
  }

  return reserved
}

/**
 * 规范化按键字符串以便比较（小写、修饰键排序）。
 * 组合键（如 “ctrl+x ctrl+b” 这样以空格分隔的步骤）按步骤
 * 分别规范化 —— 先按 '+' 拆分会把 “x ctrl” 弄成一个 mainKey，
 * 被下一步覆盖，从而把组合键坍缩成它的最后一个键。
 */
export function normalizeKeyForComparison(key: string): string {
  return key.trim().split(/\s+/).map(normalizeStep).join(' ')
}

function normalizeStep(step: string): string {
  const parts = step.split('+')
  const modifiers: string[] = []
  let mainKey = ''

  for (const part of parts) {
    const lower = part.trim().toLowerCase()
    if (
      [
        'ctrl',
        'control',
        'alt',
        'opt',
        'option',
        'meta',
        'cmd',
        'command',
        'shift',
      ].includes(lower)
    ) {
      // 规范化修饰键名称
      if (lower === 'control') modifiers.push('ctrl')
      else if (lower === 'option' || lower === 'opt') modifiers.push('alt')
      else if (lower === 'command' || lower === 'cmd') modifiers.push('cmd')
      else modifiers.push(lower)
    } else {
      mainKey = lower
    }
  }

  modifiers.sort()
  return [...modifiers, mainKey].join('+')
}
