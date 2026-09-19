/**
 * 主题的一致性。
 *
 * 加配色要改**四处**（config 白名单 / styles.css 变量块 / ThemeMode 类型 /
 * SettingsControls 的标签），漏一处就会出现"界面能选、切过去没变化"这种
 * 最难发现的问题。这里把能自动验的部分钉住：
 *   1. 白名单里每个配色，styles.css 必须真有对应的 [data-theme='x'] 块
 *   2. validateSetting('theme', …) 接受所有白名单值、拒绝未知值
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cssPath = join(here, '..', 'src', 'styles.css')

let config
let css

before(async () => {
  process.env.LIMKENION_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'lk-theme-cfg-'))
  config = await import('../server/config.mjs')
  css = await readFile(cssPath, 'utf8')
})

test('每个配色主题都在 styles.css 里有对应的变量块', () => {
  // dark 是 :root 本身（没有也不需要独立的 [data-theme='dark'] 块）
  const colors = config.THEMES.filter(t => t !== 'system' && t !== 'dark')
  assert.ok(colors.length >= 1, '除 dark 外至少还要有一套配色')
  for (const t of colors) {
    assert.ok(
      css.includes(`[data-theme='${t}']`),
      `styles.css 缺少 [data-theme='${t}'] 的配色块 —— 界面能选但切过去没变化`,
    )
  }
})

test('每个配色块都覆盖了同一套变量（不会有的主题缺变量导致显示错乱）', () => {
  // 以 :root 里声明的变量为准，逐个配色块检查是否都给了值
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  const declared = [...rootBlock.matchAll(/(--[a-z-]+)\s*:/g)].map(m => m[1])
  // 尺寸/圆角这类常量不属于配色，不要求每个主题都覆盖
  const palette = declared.filter(v => v !== '--radius')
  assert.ok(palette.length > 0, '应能从 :root 里解析出配色变量')

  for (const t of config.THEMES.filter(x => x !== 'system' && x !== 'dark')) {
    const block = css.match(new RegExp(`\\[data-theme='${t}'\\]\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? ''
    const missing = palette.filter(v => !block.includes(`${v}:`))
    assert.deepStrictEqual(
      missing,
      [],
      `[data-theme='${t}'] 缺少变量：${missing.join('、')}`,
    )
  }
})

test('validateSetting 接受白名单里的主题、拒绝未知值', () => {
  for (const t of config.THEMES) {
    assert.strictEqual(config.validateSetting('theme', t), true, `应接受主题 ${t}`)
  }
  assert.strictEqual(config.validateSetting('theme', 'not-a-theme'), false)
  assert.strictEqual(config.validateSetting('theme', ''), false)
})
