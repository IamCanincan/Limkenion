/**
 * hooks 向后兼容集成测试：用户 settings.json 里写旧事件名（PreToolUse 等），
 * getAllHooks 必须归一化成新契约名后返回——这是"老配置不用改就能继续用"的承诺。
 *
 * 手法：LIMKENION_CONFIG_DIR 重定向到临时目录 + 写入老名配置 +
 * enableConfigs() 解除 config 访问门禁。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

// ⚠ 必须在任何 CLI 模块 import 之前设置：配置根目录是记忆化的
const tmpConfig = mkdtempSync(join(tmpdir(), 'limkenion-hooks-test-'))
process.env.LIMKENION_CONFIG_DIR = tmpConfig

// ⚠ 在 import 之前写入配置：settings 读取有缓存，导入链（enableConfigs 等）
// 可能把"文件不存在"的状态缓存住。这也更贴近真实启动顺序——CLI 启动前
// settings.json 就已经在盘上。
writeFileSync(join(tmpConfig, 'settings.json'), JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] },
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: 'echo start' }] },
    ],
    'tool-before': [
      // 同事件（tool-before）用新名再声明一次，matcher 相同但命令不同，
      // 用于验证旧名 + 新名同事件声明会被 MERGE 而非静默丢弃。
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo new-name' }] },
    ],
  },
}), 'utf8')

const { enableConfigs } = await import('../utils/config.js')
enableConfigs()

const { getAllHooks, isHookEqual } = await import('../utils/hooks/hooksSettings.js')
const { getSettingsFilePathForSource } = await import('../utils/settings/settings.js')

function tempDir(): string {
  return tmpConfig
}

after(() => {
  rmSync(tmpConfig, { recursive: true, force: true })
})

describe('hooksSettings 旧名归一化（集成）', () => {
  it('settings.json 写旧名 PreToolUse/SessionStart → 归一化；新名 tool-before 直通', () => {
    const userSettingsPath = getSettingsFilePathForSource('userSettings')
    assert.ok(userSettingsPath, 'userSettings 应有配置文件路径')
    assert.ok(userSettingsPath!.startsWith(tempDir()), 'userSettings 路径必须被 LIMKENION_CONFIG_DIR 重定向')

    const fakeAppState = { sessionHooks: new Map() }
    const hooks = getAllHooks(fakeAppState as never)

    const pre = hooks.find(h => (h.config as { command?: string }).command === 'echo pre')
    assert.ok(pre, '应能读到 PreToolUse 配置的钩子')
    assert.equal(pre!.event, 'tool-before', '旧名 PreToolUse 必须归一化为 tool-before')
    assert.equal(pre!.matcher, 'Bash')
    assert.equal(pre!.source, 'userSettings')

    const start = hooks.find(h => (h.config as { command?: string }).command === 'echo start')
    assert.ok(start, '应能读到 SessionStart 配置的钩子')
    assert.equal(start!.event, 'session-open', '旧名 SessionStart 必须归一化为 session-open')

    const newName = hooks.find(h => (h.config as { command?: string }).command === 'echo new-name')
    assert.ok(newName, '新名配置直通不受影响')
    assert.equal(newName!.event, 'tool-before')
  })

  it('同事件用旧名 + 新名各声明一次 → 两条钩子都保留（MERGE，不静默丢弃）', () => {
    const fakeAppState = { sessionHooks: new Map() }
    const hooks = getAllHooks(fakeAppState as never)
    const bashHooks = hooks.filter(
      h => h.event === 'tool-before' && h.matcher === 'Bash',
    )
    const commands = bashHooks.map(h => (h.config as { command?: string }).command)
    assert.ok(commands.includes('echo pre'), '旧名 PreToolUse 声明必须保留')
    assert.ok(commands.includes('echo new-name'), '新名 tool-before 声明必须保留')
    assert.equal(
      bashHooks.length,
      2,
      '同事件旧名+新名两条声明都应出现在结果里，不能因 schema 拒绝旧键而整段丢弃',
    )
  })

  it('isHookEqual：命令内容相同则相等；shell / if 条件参与身份判定', () => {
    const a = { type: 'command' as const, command: 'echo hi' }
    assert.equal(isHookEqual(a, { type: 'command', command: 'echo hi' }), true)
    assert.equal(isHookEqual(a, { type: 'command', command: 'echo hi', shell: 'pwsh' }), false)
    assert.equal(isHookEqual(a, { type: 'command', command: 'echo hi', if: 'Bash(git *)' }), false)
    assert.equal(isHookEqual(a, { type: 'command', command: 'echo other' }), false)
    assert.equal(isHookEqual(a, { type: 'prompt', prompt: 'echo hi' }), false)
  })
})

// 防止"测试文件被当模块加载却没跑"的静态检查误报
void tempDir
void existsSync
void readFileSync
