/**
 * 键位绑定模板生成器。
 * 为 ~/.limkenion/keybindings.json 生成一份文档完善的模板文件
 */

import { jsonStringify } from '../utils/slowOperations.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import {
  NON_REBINDABLE,
  normalizeKeyForComparison,
} from './reservedShortcuts.js'
import type { KeybindingBlock } from './types.js'

/**
 * 过滤掉无法重新绑定的保留快捷键。
 * 它们会让 /doctor 发出警告，因此我们从模板中排除。
 */
function filterReservedShortcuts(blocks: KeybindingBlock[]): KeybindingBlock[] {
  const reservedKeys = new Set(
    NON_REBINDABLE.map(r => normalizeKeyForComparison(r.key)),
  )

  return blocks
    .map(block => {
      const filteredBindings: Record<string, string | null> = {}
      for (const [key, action] of Object.entries(block.bindings)) {
        if (!reservedKeys.has(normalizeKeyForComparison(key))) {
          filteredBindings[key] = action
        }
      }
      return { context: block.context, bindings: filteredBindings }
    })
    .filter(block => Object.keys(block.bindings).length > 0)
}

/**
 * 生成模板 keybindings.json 文件的内容。
 * 创建一个完全有效的 JSON 文件，包含用户可自定义的全部默认绑定。
 */
export function generateKeybindingsTemplate(): string {
  // 过滤掉无法重新绑定的保留快捷键
  const bindings = filterReservedShortcuts(DEFAULT_BINDINGS)

  // 格式化为带 bindings 数组的对象包装
  const config = {
    $schema: '',
    $docs: '',
    bindings,
  }

  return jsonStringify(config, null, 2) + '\n'
}
