import {
  hasUsedBackslashReturn,
  isShiftEnterKeyBindingInstalled,
} from '../../commands/terminalSetup/terminalSetup.js'
import type { Key } from '../../ink.js'
import { getGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'
/**
 * 辅助函数：检查 vim 模式当前是否已启用
 * @returns 返回布尔值，指示 vim 模式是否激活
 */
export function isVimModeEnabled(): boolean {
  const config = getGlobalConfig()
  return config.editorMode === 'vim'
}

export function getNewlineInstructions(): string {
  // macOS 上的 Apple Terminal 使用原生修饰键检测 Shift+Enter
  if (env.terminal === 'Apple_Terminal' && process.platform === 'darwin') {
    return 'shift + ⏎ 换行'
  }

  // 对于 iTerm2 和 VSCode，若已安装则显示 Shift+Enter 提示
  if (isShiftEnterKeyBindingInstalled()) {
    return 'shift + ⏎ 换行'
  }

  // 否则显示反斜杠+回车提示
  return hasUsedBackslashReturn()
    ? '\\⏎ 换行'
    : '反斜杠 (\\) + 回车 (⏎) 换行'
}

/**
 * 当按键是可打印字符且不以空白开头时为 true——即用户输入的
 * 普通字母/数字/符号。用于门控在图片弹丸之后插入的懒空格。
 */
export function isNonSpacePrintable(input: string, key: Key): boolean {
  if (
    key.ctrl ||
    key.meta ||
    key.escape ||
    key.return ||
    key.tab ||
    key.backspace ||
    key.delete ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end
  ) {
    return false
  }
  return input.length > 0 && !/^\s/.test(input) && !input.startsWith('\x1b')
}
