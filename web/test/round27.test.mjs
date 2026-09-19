/**
 * 第 27 轮：PreviewUrl。
 * （Computer Use 已于 2026-09-19 按用户要求整体删除，相关用例一并移除。）
 */

import { test, describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configDir
let ws
let tools
let engine
let sessions

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-r27-cfg-'))
  ws = await mkdtemp(join(tmpdir(), 'lk-r27-ws-'))
  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = ws
  process.env.LIMKENION_WEB_STATE_DIR = join(ws, '.state')
  await writeFile(join(configDir, 'settings.json'), '{}', 'utf8')
  const bus = await import('../server/bus.mjs')
  const { fakeClient } = await import('./helpers.mjs')
  bus.addClient(fakeClient({}).ws)
  engine = await import('../server/engine.mjs')
  sessions = await import('../server/sessions.mjs')
  tools = await import('../server/tools.mjs')
})

after(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => {})
  await rm(configDir, { recursive: true, force: true }).catch(() => {})
})

const emitted = []
const ctx = () => ({
  session: sessions.createSession(),
  emit: ev => emitted.push(ev),
})

describe('PreviewUrl', () => {
  it('localhost 地址 → 播报 preview_open 并返回说明', async () => {
    const e = []
    const out = await tools.executeTool('PreviewUrl', { url: 'http://localhost:5173/' }, {
      session: sessions.createSession(),
      emit: ev => e.push(ev),
    })
    assert.match(String(out), /已在预览面板打开/)
    const ev = e.find(v => v.type === 'preview_open')
    assert.ok(ev, '应播报 preview_open')
    assert.equal(ev.url, 'http://localhost:5173/')
  })

  it('非本机地址 → 拒绝', async () => {
    await assert.rejects(
      () => tools.executeTool('PreviewUrl', { url: 'https://example.com' }, ctx()),
      /仅支持预览本机地址/,
    )
  })

  it('非法 URL → 拒绝', async () => {
    await assert.rejects(() => tools.executeTool('PreviewUrl', { url: 'not-a-url' }, ctx()), /不是合法的 URL/)
  })
})

