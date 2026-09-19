/**
 * 权限规则 specifier 语义。
 *
 * 重点不是"能不能匹配"，而是**猜不猜**：
 *  - 显式的 `key:pattern` → 语义确定，支持（消掉 unhonored 告警）
 *  - 裸 specifier（其它工具）→ 依旧不猜，返回 unsupported（不给 deny 假的保护感）
 *  - Bash / 文件类的老行为必须**原样保留**（不能被 key 形式抢走，
 *    否则 `Bash(git:*)` 会被误读成 key=git、`Edit(C:\x\*)` 会被误读成 key=C）
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkspace, rmDir } from './helpers.mjs'

let configDir
let ws
let settings

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-permspec-cfg-'))
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  settings = await import('../server/settings.mjs')
})

after(async () => {
  await rmDir(ws.dir)
  await rmDir(configDir)
})

test('显式 key:pattern 能匹配指定输入字段', () => {
  const r = settings.matchRule('WebFetch(url:https://example.com/**)', 'WebFetch', {
    url: 'https://example.com/a/b',
  })
  assert.strictEqual(r, 'match')
})

test('key:pattern 不匹配时是 no-match（不是 unsupported）', () => {
  const r = settings.matchRule('WebFetch(url:https://example.com/**)', 'WebFetch', {
    url: 'https://other.com/x',
  })
  assert.strictEqual(r, 'no-match', '字段存在但不匹配 → no-match')
})

test('* 会跨越 /（URL / 正则这类值才不反直觉）', () => {
  const r = settings.matchRule('Grep(pattern:TODO*)', 'Grep', { pattern: 'TODO: fix me' })
  assert.strictEqual(r, 'match')
})

test('裸 specifier 依旧不猜 → unsupported（不给 deny 假的保护感）', () => {
  const r = settings.matchRule('WebFetch(example.com)', 'WebFetch', { url: 'https://example.com' })
  assert.strictEqual(r, 'unsupported')
})

test('老行为不回退：Bash(git:*) 仍是命令前缀匹配', () => {
  assert.strictEqual(
    settings.matchRule('Bash(git:*)', 'Bash', { command: 'git status' }),
    'match',
    'Bash(git:*) 不能被当成 key=git',
  )
  assert.strictEqual(
    settings.matchRule('Bash(git:*)', 'Bash', { command: 'gitx status' }),
    'no-match',
  )
})

test('老行为不回退：Windows 路径不会被误读成 key', () => {
  // specifier 以 "C:" 开头 —— 若把冒号前当 key 就会错匹配
  const r = settings.matchRule('Edit(C:\\foo\\*)', 'Edit', { file_path: 'C:\\foo\\bar.txt' })
  assert.notStrictEqual(r, 'unsupported', '文件类工具应走文件匹配，不该落到 key 解析')
})

test('unhonoredRules：显式 key 形式不再算"未生效"，裸写法仍列出', async () => {
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify(
      { permissions: { deny: ['WebFetch(url:https://example.com/**)', 'Agent(bare-thing)'] } },
      null,
      1,
    ),
    'utf8',
  )
  settings.loadSettings()
  const unhonored = settings.unhonoredRules()

  assert.ok(
    !unhonored.some(u => String(u.rule).includes('url:')),
    '显式 key 形式已支持，不该再列为未生效',
  )
  assert.ok(
    unhonored.some(u => String(u.rule).includes('bare-thing')),
    '裸 specifier 仍应如实列为未生效',
  )
})
