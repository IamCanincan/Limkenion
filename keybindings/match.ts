import type { Key } from '../ink.js'
import type { ParsedBinding, ParsedKeystroke } from './types.js'

/**
 * Ink 的 Key 类型中我们匹配时关心的修饰键。
 * 注意：Key 中的 `fn` 被有意排除，因为它很少使用，
 * 且在终端应用中通常不可配置。
 */
type InkModifiers = Pick<Key, 'ctrl' | 'shift' | 'meta' | 'super'>

/**
 * 从 Ink Key 对象中提取修饰键。
 * 该函数确保我们显式提取所关心的修饰键。
 */
function getInkModifiers(key: Key): InkModifiers {
  return {
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.meta,
    super: key.super,
  }
}

/**
 * 从 Ink 的 Key + input 中提取规范化后的键名。
 * 把 Ink 的布尔标志（key.escape、key.return 等）映射为
 * 与我们的 ParsedKeystroke.key 格式匹配的字符串名。
 */
export function getKeyName(input: string, key: Key): string | null {
  if (key.escape) return 'escape'
  if (key.return) return 'enter'
  if (key.tab) return 'tab'
  if (key.backspace) return 'backspace'
  if (key.delete) return 'delete'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.pageUp) return 'pageup'
  if (key.pageDown) return 'pagedown'
  if (key.wheelUp) return 'wheelup'
  if (key.wheelDown) return 'wheeldown'
  if (key.home) return 'home'
  if (key.end) return 'end'
  if (input.length === 1) return input.toLowerCase()
  return null
}

/**
 * 检查 Ink Key 与 ParsedKeystroke 之间的所有修饰键是否匹配。
 *
 * Alt 与 Meta：Ink 历史上用 `key.meta` 表示 Alt/Option。配置中的
 * `meta` 修饰键被视为 `alt` 的别名 —— 当 `key.meta` 为 true 时
 * 两者都匹配。
 *
 * Super（Cmd/Win）：与 alt/meta 不同。在支持的终端上只能通过
 * kitty 键盘协议传入。在不发送它的终端上，`cmd`/`super` 绑定
 * 根本不会触发。
 */
function modifiersMatch(
  inkMods: InkModifiers,
  target: ParsedKeystroke,
): boolean {
  // 检查 ctrl 修饰键
  if (inkMods.ctrl !== target.ctrl) return false

  // 检查 shift 修饰键
  if (inkMods.shift !== target.shift) return false

  // 在 Ink 中 alt 和 meta 都映射到 key.meta（终端限制）
  // 因此我们检查目标中是否要求了 alt 或 meta 中的任意一个
  const targetNeedsMeta = target.alt || target.meta
  if (inkMods.meta !== targetNeedsMeta) return false

  // Super（cmd/win）是与 alt/meta 不同的修饰键
  if (inkMods.super !== target.super) return false

  return true
}

/**
 * 检查 ParsedKeystroke 是否匹配给定的 Ink input + Key。
 *
 * 显示文本会使用符合平台习惯的名称（macOS 上为 opt，其他平台为 alt）。
 */
export function matchesKeystroke(
  input: string,
  key: Key,
  target: ParsedKeystroke,
): boolean {
  const keyName = getKeyName(input, key)
  if (keyName !== target.key) return false

  const inkMods = getInkModifiers(key)

  // 怪异行为：按下 escape 时 Ink 会设置 key.meta=true（见 input-event.ts）。
  // 这是终端中转义序列工作方式遗留的行为。
  // 在匹配 escape 键本身时我们需要忽略 meta 修饰键，
  // 否则像 “escape”（不带修饰键）这样的绑定永远不会匹配。
  if (key.escape) {
    return modifiersMatch({ ...inkMods, meta: false }, target)
  }

  return modifiersMatch(inkMods, target)
}

/**
 * 检查 Ink 的 Key + input 是否匹配某个已解析绑定的第一个按键。
 * 仅适用于单按键绑定（第 1 阶段）。
 */
export function matchesBinding(
  input: string,
  key: Key,
  binding: ParsedBinding,
): boolean {
  if (binding.chord.length !== 1) return false
  const keystroke = binding.chord[0]
  if (!keystroke) return false
  return matchesKeystroke(input, key, keystroke)
}
