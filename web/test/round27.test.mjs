/**
 * 第 27 轮：PreviewUrl + Computer Use（门控/参数校验）。
 * 真实截屏需要交互桌面——本测试只断言形状或优雅报错。
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

describe('Computer Use 门控与校验', () => {
  it('总开关关闭 → 明确报未启用', async () => {
    delete process.env.LIMKENION_WEB_COMPUTER_USE
    await assert.rejects(
      () => tools.executeTool('ComputerScreenshot', {}, ctx()),
      /未启用/,
    )
    await assert.rejects(
      () => tools.executeTool('ComputerControl', { action: 'click', x: 1, y: 1 }, ctx()),
      /未启用/,
    )
  })

  it('开关打开 + 非 Windows → 明确报平台不可用（Windows 上跳过）', async () => {
    if (process.platform === 'win32') return
    process.env.LIMKENION_WEB_COMPUTER_USE = '1'
    await assert.rejects(() => tools.executeTool('ComputerScreenshot', {}, ctx()), /仅在 Windows 上可用/)
    delete process.env.LIMKENION_WEB_COMPUTER_USE
  })

  it('dangerous：ComputerControl 在危险工具清单里（默认每次确认）', async () => {
    const { isDangerousTool } = await import('../server/tools.mjs')
    assert.equal(isDangerousTool('ComputerScreenshot'), true)
    assert.equal(isDangerousTool('ComputerControl'), true)
  })

  it('Windows + 开关打开：control 非法 action 给出可选值列表', async () => {
    if (process.platform !== 'win32') return
    process.env.LIMKENION_WEB_COMPUTER_USE = '1'
    try {
      await assert.rejects(
        () => tools.executeTool('ComputerControl', { action: 'bogus' }, ctx()),
        /不支持的 action/,
      )
    } finally {
      delete process.env.LIMKENION_WEB_COMPUTER_USE
    }
  })
})

describe('ComputerScreenshot 真实截屏（Windows + 开关）', () => {
  it('返回标记前缀与 data URL（无交互桌面时优雅报错）', async () => {
    if (process.platform !== 'win32') return
    process.env.LIMKENION_WEB_COMPUTER_USE = '1'
    try {
      const out = await tools.executeTool('ComputerScreenshot', { maxWidth: 800 }, ctx())
      if (out.startsWith('@@SCREENSHOT@@')) {
        assert.match(out, /^@@SCREENSHOT@@data:image\/png;base64,/)
        assert.ok(out.length > 1000, 'base64 不应过短')
      } else {
        // 服务跑在非交互桌面（如系统服务/无头会话）——允许优雅报错
        assert.match(String(out), /显示会话|失败/)
      }
    } finally {
      delete process.env.LIMKENION_WEB_COMPUTER_USE
    }
  })
})
