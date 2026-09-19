/**
 * 具名子代理（server/subagents.mjs）。
 *
 * 重点是**边界**：新增了配置面，但不能让它变成提权的口子 ——
 *   - 工具只能是只读集的子集（Write / Bash 之类一律拒绝）
 *   - 模型只能是我们支持的型号（不因为加配置就悄悄开出别的供应商）
 *   - 删除时该作用域没定义就返回 false、不动文件
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkspace, rmDir } from './helpers.mjs'

let configDir
let ws
let subagents

const userFile = () => join(configDir, 'settings.json')

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-subagent-cfg-'))
  ws = await makeWorkspace({ 'seed.txt': 'seed\n' })
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  process.env.LIMKENION_WEB_STATE_DIR = join(ws.dir, '.state')
  subagents = await import('../server/subagents.mjs')
})

after(async () => {
  await rmDir(ws.dir)
  await rmDir(configDir)
})

test('保存并列出：带模型与工具子集', async () => {
  subagents.saveSubagent('researcher', { description: '只读调研', tools: ['Read', 'Grep'] }, 'user')
  const list = subagents.subagents()
  const one = list.find(s => s.name === 'researcher')
  assert.ok(one, '应能列出刚保存的')
  assert.deepStrictEqual(one.tools, ['Read', 'Grep'])
  assert.equal(one.source, 'user')
})

test('安全：不能给子代理只读集以外的工具', async () => {
  assert.throws(
    () => subagents.saveSubagent('evil', { description: 'x', tools: ['Write', 'Bash'] }, 'user'),
    /只读工具|Write|Bash/,
    'Write / Bash 必须被拒'
  )
  assert.ok(!subagents.subagents().some(s => s.name === 'evil'), '被拒的不该写进去')
})

test('安全：模型只能是支持的型号', async () => {
  const { MODELS } = await import('../server/config.mjs')
  const ok = MODELS[0].value
  subagents.saveSubagent('with-model', { description: 'x', model: ok }, 'user')
  assert.equal(subagents.getSubagent('with-model')?.model, ok)

  assert.throws(
    () => subagents.saveSubagent('bad-model', { description: 'x', model: 'gpt-9' }, 'user'),
    /不支持的模型/,
  )
})

test('名字校验：非法名字直接拒（不写出怪键）', async () => {
  assert.throws(() => subagents.saveSubagent('', { description: 'x' }, 'user'), /不合法/)
  assert.throws(() => subagents.saveSubagent('has space', { description: 'x' }, 'user'), /不合法/)
})

test('删除：不在该作用域时返回 false 且不动文件', async () => {
  subagents.saveSubagent('temp', { description: 'x' }, 'user')
  const before = await readFile(userFile(), 'utf8')
  assert.strictEqual(subagents.deleteSubagent('temp', 'project'), false, 'project 里没有 temp')
  assert.strictEqual(await readFile(userFile(), 'utf8'), before, '不该改动文件')

  assert.strictEqual(subagents.deleteSubagent('temp', 'user'), true)
  assert.ok(!subagents.subagents().some(s => s.name === 'temp'))
})

test('resolveSubagent：找不到时必须如实说「未执行」（不能谎称已跑）', () => {
  subagents.saveSubagent('researcher', { description: '调研' }, 'user')
  const r = subagents.resolveSubagent('nope')
  assert.strictEqual(r.ok, false)
  // 这两点是关键：① 明说未执行，② 列出可用名字让调用方能改对
  assert.match(r.error, /未执行/, '必须如实说没执行')
  assert.match(r.error, /researcher/, '应列出可用的子代理名')
  assert.doesNotMatch(r.error, /已按默认|已执行/, '不能谎称已经执行过')
})

test('resolveSubagent：不指定 → 走默认（ok，agent 为 null）', () => {
  assert.deepStrictEqual(subagents.resolveSubagent(''), { ok: true, agent: null })
  assert.deepStrictEqual(subagents.resolveSubagent(undefined), { ok: true, agent: null })
})

test('resolveSubagent：存在时返回 agent', () => {
  subagents.saveSubagent('checker', { description: '检查', tools: ['Read'] }, 'user')
  const r = subagents.resolveSubagent('checker')
  assert.strictEqual(r.ok, true)
  assert.equal(r.agent?.name, 'checker')
  assert.deepStrictEqual(r.agent?.tools, ['Read'])
})
