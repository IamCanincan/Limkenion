/**
 * 沙箱路径校验测试。
 * 覆盖目录穿越、盘符相对路径、Windows 保留设备名、NTFS 备用数据流。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { makeWorkspace } from './helpers.mjs'

let ws
let safePath
let WORKSPACE_ROOT

before(async () => {
  ws = await makeWorkspace({ 'a/b.txt': 'hello' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  ;({ safePath, WORKSPACE_ROOT } = await import('../server/paths.mjs'))
})

after(async () => {
  await ws?.cleanup()
})

describe('safePath', () => {
  test('放行工作区内相对路径', () => {
    assert.equal(safePath('a/b.txt'), join(WORKSPACE_ROOT, 'a', 'b.txt'))
    assert.equal(safePath('./a/b.txt'), join(WORKSPACE_ROOT, 'a', 'b.txt'))
  })

  test('放行工作区根自身', () => {
    assert.equal(safePath('.'), WORKSPACE_ROOT)
  })

  test('拒绝 ../ 越界', () => {
    assert.throws(() => safePath('../outside.txt'), /越界/)
    assert.throws(() => safePath('a/../../outside.txt'), /越界/)
  })

  test('拒绝绝对路径越界', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
    assert.throws(() => safePath(outside), /越界/)
  })

  test('拒绝盘符相对路径（isAbsolute 为 false 但会跳到盘根）', () => {
    assert.throws(() => safePath('C:foo'), /盘符相对路径/)
  })

  test('拒绝 Windows 保留设备名', () => {
    if (process.platform !== 'win32') return
    assert.throws(() => safePath('NUL'), /保留设备名/)
    assert.throws(() => safePath('a/CON.txt'), /保留设备名/)
    assert.throws(() => safePath('COM1'), /保留设备名/)
  })

  test('拒绝备用数据流', () => {
    if (process.platform !== 'win32') return
    assert.throws(() => safePath('a/b.txt:secret'), /备用数据流/)
  })

  test('拒绝空路径与非法类型', () => {
    assert.throws(() => safePath(''), /不能为空/)
    assert.throws(() => safePath('   '), /不能为空/)
    assert.throws(() => safePath(null), /不能为空/)
    assert.throws(() => safePath(123), /不能为空/)
  })

  test('路径里的 .. 只要没越界就放行', () => {
    assert.equal(safePath('a/../a/b.txt'), join(WORKSPACE_ROOT, 'a', 'b.txt'))
  })
})
