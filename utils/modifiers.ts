export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false

/**
 * 提前加载原生模块以进行预热。
 * 尽早调用可避免首次使用时出现延迟。
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  // 在后台加载模块
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prewarm } = require('modifiers-napi') as { prewarm: () => void }
    prewarm()
  } catch {
    // 预热期间忽略错误
  }
}

/**
 * 检查某个特定修饰键当前是否被按下（同步）。
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  // 动态导入，避免在顶层加载原生模块
  const { isModifierPressed: nativeIsModifierPressed } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('modifiers-napi') as { isModifierPressed: (m: string) => boolean }
  return nativeIsModifierPressed(modifier)
}
