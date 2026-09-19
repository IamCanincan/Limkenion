/**
 * Node 版本兼容性防线。
 *
 * 为什么需要它：CI（Gitee Go，`.workflow/ci.yml`）用的是 **Node 20**，而本地开发
 * 常用 22 / 24 —— 于是"本地能跑、CI 上炸"的问题**在本地完全测不出来**。
 *
 * 已经踩过一次：`import.meta.dirname` 要 **Node 20.11+** 才有，20.0~20.10 上是
 * `undefined`。而 `server/paths.mjs` 里 `CLI_ROOT` 是**模块加载时就求值**的顶层
 * 常量，拿到 undefined 后 `join(undefined, …)` 直接抛 TypeError —— 结果是
 * **整个服务起不来、测试全红**，且只在老一点的 Node 20 上复现。
 *
 * 这里扫一遍源码，把这类 API 挡在门外。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 本文件自身的注释/断言里就含有这些字样，扫描时要排除自己，否则永远红。
const SELF = fileURLToPath(import.meta.url)

/** 收集目录下所有 .mjs / .ts / .tsx（手动递归，不依赖 readdir 的 recursive 选项）。 */
function collect(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'release') continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) collect(full, out)
    else if (/\.(mjs|ts|tsx)$/.test(ent.name)) out.push(full)
  }
  return out
}

test('不得使用 import.meta.dirname（Node 20.11+ 才有，CI 上会炸）', () => {
  const files = [...collect(join(ROOT, 'server')), ...collect(join(ROOT, 'test'))].filter(f => f !== SELF)
  assert.ok(files.length > 0, '应该真的扫描到文件，否则这条测试是空转')

  // 按行扫、**跳过注释行** —— 解释性注释里提到这个 API 是常有的事，不该算命中
  const hits = files.filter(f =>
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .some(line => {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
        return t.includes('import.meta.dirname')
      }),
  )
  assert.deepStrictEqual(
    hits,
    [],
    '以下文件用了 import.meta.dirname：' +
      hits.join('、') +
      ' —— 请改用 dirname(fileURLToPath(import.meta.url))',
  )
})

test('相对导入的文件名大小写必须与磁盘一致（Linux 区分大小写）', () => {
  // 经典 CI 杀手：Windows 文件系统不区分大小写，`import './helpers.mjs'` 即使磁盘上
  // 叫 `Helpers.mjs` 也能跑；Linux 上直接 ERR_MODULE_NOT_FOUND。本地 Windows 永远绿。
  const files = [
    ...collect(join(ROOT, 'server')),
    ...collect(join(ROOT, 'src')),
    ...collect(join(ROOT, 'test')),
  ].filter(f => f !== SELF)

  const RE = /(?:from|require\(|import\()\s*['"](\.[^'"]*)['"]/g
  const bad = []
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(RE)) {
      const spec = m[1]
      const target = resolve(dirname(f), spec)
      const parent = dirname(target)
      const base = target.slice(parent.length + 1)
      let entries = []
      try {
        entries = readdirSync(parent)
      } catch {
        continue
      }
      // 精确命中，或命中「同名 + 扩展名」（省略扩展名的写法）
      if (entries.includes(base) || entries.some(e => e.startsWith(`${base}.`))) continue
      // 大小写不同才算问题
      const ci = entries.find(
        e => e.toLowerCase() === base.toLowerCase() || e.toLowerCase().startsWith(`${base.toLowerCase()}.`),
      )
      if (ci) bad.push(`${spec}（磁盘上是 ${ci}）@ ${f}`)
    }
  }
  assert.deepStrictEqual(
    bad,
    [],
    '以下相对导入大小写与磁盘不一致，Linux（CI）上会 ERR_MODULE_NOT_FOUND：\n' + bad.join('\n'),
  )
})

test('不得依赖浏览器/服务端的全局 WebSocket（Node 20 没有全局 WebSocket）', () => {
  // 前端（src/）用浏览器原生 WebSocket 是正常的，所以只查服务端与测试。
  const files = [...collect(join(ROOT, 'server')), ...collect(join(ROOT, 'test'))].filter(f => f !== SELF)
  const hits = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (!text.includes('new WebSocket(')) continue
    // 显式从 ws 包导入就没问题
    if (/from ['"]ws['"]/.test(text)) continue
    hits.push(f)
  }
  assert.deepStrictEqual(hits, [], '以下文件用了全局 WebSocket 却没有 import ws：' + hits.join('、'))
})
