import type { Key } from '../ink.js'
import { getKeyName, matchesBinding } from './match.js'
import { chordToString } from './parser.js'
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from './types.js'

export type ResolveResult =
  | { type: 'match'; action: string }
  | { type: 'none' }
  | { type: 'unbound' }

export type ChordResolveResult =
  | { type: 'match'; action: string }
  | { type: 'none' }
  | { type: 'unbound' }
  | { type: 'chord_started'; pending: ParsedKeystroke[] }
  | { type: 'chord_cancelled' }


/**
 * 从绑定中获取某个动作的显示文本（例如 “app:toggleTodos” 对应 “ctrl+t”）。
 * 按逆序搜索，以便用户覆盖优先生效。
 */
export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
): string | undefined {
  // 在该上下文中查找此动作的最后一个绑定
  const binding = bindings.findLast(
    b => b.action === action && b.context === context,
  )
  return binding ? chordToString(binding.chord) : undefined
}

/**
 * 从 Ink 的 input/key 构建 ParsedKeystroke。
 */
function buildKeystroke(input: string, key: Key): ParsedKeystroke | null {
  const keyName = getKeyName(input, key)
  if (!keyName) return null

  // 怪异行为：按下 escape 时 Ink 会设置 key.meta=true（见 input-event.ts）。
  // 这是遗留的终端行为 —— 我们不应把它记录为 escape 键本身的
  // 修饰键，否则组合键匹配会失败。
  const effectiveMeta = key.escape ? false : key.meta

  return {
    key: keyName,
    ctrl: key.ctrl,
    alt: effectiveMeta,
    shift: key.shift,
    meta: effectiveMeta,
    super: key.super,
  }
}

/**
 * 比较两个 ParsedKeystroke 是否相等。把 alt/meta 归并为一个
 * 逻辑修饰键 —— 传统终端无法区分它们（见
 * match.ts modifiersMatch），因此 “alt+k” 和 “meta+k” 是同一个键。
 * Super（cmd/win）是独立的 —— 只能通过 kitty 键盘协议传入。
 */
export function keystrokesEqual(
  a: ParsedKeystroke,
  b: ParsedKeystroke,
): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    (a.alt || a.meta) === (b.alt || b.meta) &&
    a.super === b.super
  )
}

/**
 * 检查组合键前缀是否匹配某个绑定组合键的开头。
 */
function chordPrefixMatches(
  prefix: ParsedKeystroke[],
  binding: ParsedBinding,
): boolean {
  if (prefix.length >= binding.chord.length) return false
  for (let i = 0; i < prefix.length; i++) {
    const prefixKey = prefix[i]
    const bindingKey = binding.chord[i]
    if (!prefixKey || !bindingKey) return false
    if (!keystrokesEqual(prefixKey, bindingKey)) return false
  }
  return true
}

/**
 * 检查完整组合键是否匹配某个绑定的组合键。
 */
function chordExactlyMatches(
  chord: ParsedKeystroke[],
  binding: ParsedBinding,
): boolean {
  if (chord.length !== binding.chord.length) return false
  for (let i = 0; i < chord.length; i++) {
    const chordKey = chord[i]
    const bindingKey = binding.chord[i]
    if (!chordKey || !bindingKey) return false
    if (!keystrokesEqual(chordKey, bindingKey)) return false
  }
  return true
}

/**
 * 在支持组合键状态的前提下解析按键。
 *
 * 该函数处理 “ctrl+k ctrl+s” 这类多按键组合键绑定。
 *
 * @param input - 来自 Ink 的字符输入
 * @param key - 来自 Ink 的带修饰键标志的 Key 对象
 * @param activeContexts - 当前激活的上下文数组
 * @param bindings - 所有已解析的绑定
 * @param pending - 当前组合键状态（不在组合键中时为 null）
 * @returns 带组合键状态的解析结果
 */
export function resolveKeyWithChordState(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,
): ChordResolveResult {
  // 按下 escape 时取消组合键
  if (key.escape && pending !== null) {
    return { type: 'chord_cancelled' }
  }

  // 构建当前按键
  const currentKeystroke = buildKeystroke(input, key)
  if (!currentKeystroke) {
    if (pending !== null) {
      return { type: 'chord_cancelled' }
    }
    return { type: 'none' }
  }

  // 构建要测试的完整组合键序列
  const testChord = pending
    ? [...pending, currentKeystroke]
    : [currentKeystroke]

  // 按激活上下文过滤绑定（Set 查找：O(n) 而非 O(n·m)）
  const ctxSet = new Set(activeContexts)
  const contextBindings = bindings.filter(b => ctxSet.has(b.context))

  // 检查它是否可能是更长组合键的前缀。按组合键字符串
  // 分组，这样靠后的 null 覆盖会遮蔽它所解绑的默认绑定 ——
  // 否则用 null 解绑 `ctrl+x ctrl+k` 后，`ctrl+x` 仍会进入
  // 组合键等待，前缀上的单键绑定永远不会触发。
  const chordWinners = new Map<string, string | null>()
  for (const binding of contextBindings) {
    if (
      binding.chord.length > testChord.length &&
      chordPrefixMatches(testChord, binding)
    ) {
      chordWinners.set(chordToString(binding.chord), binding.action)
    }
  }
  let hasLongerChords = false
  for (const action of chordWinners.values()) {
    if (action !== null) {
      hasLongerChords = true
      break
    }
  }

  // 如果该按键可能开启一个更长的组合键，优先按此处理
  //（即使存在精确的单键匹配）
  if (hasLongerChords) {
    return { type: 'chord_started', pending: testChord }
  }

  // 检查精确匹配（靠后者胜出）
  let exactMatch: ParsedBinding | undefined
  for (const binding of contextBindings) {
    if (chordExactlyMatches(testChord, binding)) {
      exactMatch = binding
    }
  }

  if (exactMatch) {
    if (exactMatch.action === null) {
      return { type: 'unbound' }
    }
    return { type: 'match', action: exactMatch.action }
  }

  // 无匹配，也没有可能的更长组合键
  if (pending !== null) {
    return { type: 'chord_cancelled' }
  }

  return { type: 'none' }
}
