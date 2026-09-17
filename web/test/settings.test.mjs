/**
 * 设置文件（`~/.limkenion/settings.json` 等）的读取与权限规则匹配。
 *
 * 背景：web 端原先**完全不读设置文件** —— 用户在 CLI 那边配的权限规则在 web 端一律不生效。
 * 其中 `permissions.deny` 是硬拦截，不生效意味着"用户以为挡住了、其实没挡"。
 *
 * 注意：server 模块在 import 时读环境变量，所以要先设 env 再动态 import。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configDir
let workspace
let mod

/** 写一个设置文件（相对 workspace 或绝对路径）。 */
async function writeSettings(relPath, obj) {
  const full = join(workspace, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, JSON.stringify(obj, null, 1), 'utf8')
}

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lk-cfg-'))
  workspace = await mkdtemp(join(tmpdir(), 'lk-ws-'))

  process.env.LIMKENION_CONFIG_DIR = configDir
  process.env.LIMKENION_WEB_WORKSPACE = workspace
  process.env.LIMKENION_WEB_STATE_DIR = await mkdtemp(join(tmpdir(), 'lk-state-'))

  mod = {
    ...(await import('../server/settings.mjs')),
    ...(await import('../server/interactions.mjs')),
    ...(await import('../server/config.mjs')),
  }
})

after(async () => {
  await rm(configDir, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 规则解析与匹配
// ---------------------------------------------------------------------------

describe('规则解析', () => {
  test('裸工具名与 Tool(specifier) 都能解析', () => {
    assert.deepEqual(mod.parseRule('Bash'), { tool: 'Bash', specifier: null })
    assert.deepEqual(mod.parseRule('Bash(npm run test:*)'), { tool: 'Bash', specifier: 'npm run test:*' })
    assert.deepEqual(mod.parseRule('  Read(src/**)  '), { tool: 'Read', specifier: 'src/**' })
  })

  test('空串返回 null', () => {
    assert.equal(mod.parseRule(''), null)
    assert.equal(mod.parseRule(null), null)
  })
})

describe('规则匹配', () => {
  test('裸工具名匹配该工具的任何调用', () => {
    assert.equal(mod.matchRule('Write', 'Write', { file_path: 'a.txt' }), 'match')
    assert.equal(mod.matchRule('Write', 'Edit', { file_path: 'a.txt' }), 'no-match')
  })

  test('Bash 前缀语法 `:*`（CLI 的 legacy prefix 写法）', () => {
    const rule = 'Bash(npm run test:*)'
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'npm run test' }), 'match')
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'npm run test -- --watch' }), 'match')
    // 前缀必须成词，不能把 `npm run testing` 也算进来
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'npm run testing' }), 'no-match')
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'rm -rf /' }), 'no-match')
  })

  test('Bash 通配语法 `*`', () => {
    const rule = 'Bash(git status*)'
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'git status' }), 'match')
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'git status --short' }), 'match')
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'git push' }), 'no-match')
  })

  test('Bash 精确匹配（没有 :* 也没有 *）', () => {
    const rule = 'Bash(ls)'
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'ls' }), 'match')
    assert.equal(mod.matchRule(rule, 'Bash', { command: 'ls -la' }), 'no-match')
  })

  test('PowerShell 与 Bash 同语义（web 端两个都有）', () => {
    assert.equal(mod.matchRule('PowerShell(Get-ChildItem:*)', 'PowerShell', { command: 'Get-ChildItem -Recurse' }), 'match')
  })

  test('文件类工具按 glob 匹配 file_path', () => {
    assert.equal(mod.matchRule('Read(src/**)', 'Read', { file_path: 'src/a/b.ts' }), 'match')
    assert.equal(mod.matchRule('Read(src/*)', 'Read', { file_path: 'src/a.ts' }), 'match')
    // `*` 不跨目录
    assert.equal(mod.matchRule('Read(src/*)', 'Read', { file_path: 'src/a/b.ts' }), 'no-match')
    assert.equal(mod.matchRule('Write(README.md)', 'Write', { file_path: 'README.md' }), 'match')
  })

  test('文件类规则也认子目录里的同名文件（自动补 **/ 前缀）', () => {
    assert.equal(mod.matchRule('Write(README.md)', 'Write', { file_path: 'docs/README.md' }), 'match')
  })

  test('文件类工具认 NotebookEdit 的 notebook_path', () => {
    assert.equal(mod.matchRule('NotebookEdit(nb/*.ipynb)', 'NotebookEdit', { notebook_path: 'nb/demo.ipynb' }), 'match')
  })

  test('没实现 specifier 语义的工具返回 unsupported（不是 no-match）', () => {
    // 关键：不能当成"不匹配"就完事 —— 那样 deny 规则会给用户假的保护感
    assert.equal(mod.matchRule('Agent(Explore)', 'Agent', { description: 'Explore' }), 'unsupported')
    assert.equal(mod.matchRule('WebFetch(example.com)', 'WebFetch', { url: 'https://example.com' }), 'unsupported')
  })
})

// ---------------------------------------------------------------------------
// 设置文件读取与合并
// ---------------------------------------------------------------------------

describe('设置文件读取', () => {
  test('文件不存在时不报错，规则为空', async () => {
    await rm(join(configDir, 'settings.json'), { force: true })
    const s = mod.loadSettings()
    assert.deepEqual(s.permissions.deny, [])
    assert.equal(s.permissions.defaultMode, null)
    assert.equal(s.permissions.bypassDisabled, false)
  })

  test('坏了 JSON 只忽略、不抛', async () => {
    await writeFile(join(configDir, 'settings.json'), '{ 这不是 JSON', 'utf8')
    const s = mod.loadSettings()
    assert.deepEqual(s.permissions.allow, [])
    await rm(join(configDir, 'settings.json'), { force: true })
  })

  test('用户 / 项目 / 本地三处的规则取并集，标量后者覆盖', async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      permissions: { deny: ['Bash(rm:*)'], defaultMode: 'default' },
    }), 'utf8')
    await writeSettings('.limkenion/settings.json', {
      permissions: { allow: ['Read'], defaultMode: 'acceptEdits' },
    })
    await writeSettings('.limkenion/settings.local.json', {
      permissions: { deny: ['Write(.env)'], disableBypassPermissionsMode: 'disable' },
    })

    const s = mod.loadSettings()
    assert.deepEqual(s.permissions.deny.sort(), ['Bash(rm:*)', 'Write(.env)'].sort(), 'deny 应取并集')
    assert.deepEqual(s.permissions.allow, ['Read'])
    assert.equal(s.permissions.defaultMode, 'acceptEdits', 'local > project > user')
    assert.equal(s.permissions.bypassDisabled, true)
    assert.deepEqual(s.permissions.sources, ['user', 'project', 'local'])
  })

  test('重复规则去重', async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      permissions: { deny: ['Bash(rm:*)', 'Bash(rm:*)'] },
    }), 'utf8')
    await rm(join(workspace, '.limkenion'), { recursive: true, force: true })
    assert.deepEqual(mod.loadSettings().permissions.deny, ['Bash(rm:*)'])
  })
})

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

describe('权限判定', () => {
  before(async () => {
    await rm(join(workspace, '.limkenion'), { recursive: true, force: true })
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      permissions: {
        deny: ['Bash(rm -rf:*)', 'Write(.env)'],
        ask: ['Bash(git push:*)'],
        allow: ['Bash(npm run test:*)', 'Write(src/**)'],
      },
    }), 'utf8')
    mod.loadSettings()
  })

  test('deny 命中时给出拦截理由', () => {
    assert.match(mod.deniedBy('Bash', { command: 'rm -rf /' }), /被设置文件里的权限规则拒绝/)
    assert.match(mod.deniedBy('Write', { file_path: '.env' }), /权限规则拒绝/)
  })

  test('deny 未命中时返回 null', () => {
    assert.equal(mod.deniedBy('Bash', { command: 'npm run test' }), null)
    assert.equal(mod.deniedBy('Read', { file_path: 'a.txt' }), null)
  })

  test('allow 命中 → 免确认；ask 命中 → 强制确认', () => {
    assert.equal(mod.ruleDecision('Bash', { command: 'npm run test' }), 'allow')
    assert.equal(mod.ruleDecision('Write', { file_path: 'src/a.ts' }), 'allow')
    assert.equal(mod.ruleDecision('Bash', { command: 'git push origin main' }), 'ask')
    assert.equal(mod.ruleDecision('Bash', { command: 'echo hi' }), null)
  })

  test('ask 与 allow 同时命中时，ask 赢（更保守的一侧）', async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(npm:*)'], ask: ['Bash(npm publish:*)'] },
    }), 'utf8')
    mod.loadSettings()
    assert.equal(mod.ruleDecision('Bash', { command: 'npm publish' }), 'ask')
    assert.equal(mod.ruleDecision('Bash', { command: 'npm test' }), 'allow')
  })

  test('未生效的规则会被单独列出来（不能让 deny 给人假保护感）', async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      permissions: { deny: ['Agent(Explore)', 'Bash(rm:*)'], allow: ['Read'] },
    }), 'utf8')
    mod.loadSettings()
    const u = mod.unhonoredRules()
    assert.equal(u.length, 1, `只应有 Agent 那条未生效，实际 ${JSON.stringify(u)}`)
    assert.equal(u[0].rule, 'Agent(Explore)')
    assert.equal(u[0].kind, 'deny')
  })

  test('settingsSummary 在无文件与有文件时都不抛', async () => {
    const withFiles = mod.settingsSummary()
    assert.match(withFiles, /设置文件：/)
    assert.match(withFiles, /权限规则：/)

    await rm(join(configDir, 'settings.json'), { force: true })
    mod.loadSettings()
    assert.match(mod.settingsSummary(), /未找到设置文件/)
  })
})

// ---------------------------------------------------------------------------
// 接进权限流程
// ---------------------------------------------------------------------------

describe('接进 needsPermission', () => {
  before(async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      permissions: {
        deny: ['Bash(rm -rf:*)'],
        ask: ['Read'],
        allow: ['Write(src/**)'],
      },
    }), 'utf8')
    mod.loadSettings()
  })

  const session = () => ({ id: 't', settings: {}, allowedTools: new Set() })

  test('allow 规则让危险工具免确认', () => {
    // Write 在 default 模式下本来要弹窗
    assert.equal(mod.needsPermission(session(), 'Write', { input: { file_path: 'src/a.ts' } }), false)
    // 不在规则里的 Write 仍要弹
    assert.equal(mod.needsPermission(session(), 'Write', { input: { file_path: 'other/a.ts' } }), true)
  })

  test('ask 规则让只读工具也要确认', () => {
    assert.equal(mod.needsPermission(session(), 'Read', { input: { file_path: 'a.txt' } }), true)
  })

  test('升级确认不被 allow 规则绕过', () => {
    assert.equal(
      mod.needsPermission(session(), 'Write', { input: { file_path: 'src/a.ts' }, escalate: '接触过外部内容' }),
      true,
      'escalate 必须压过 allow —— 否则升级机制形同虚设',
    )
  })

  test('计划模式仍然压过 allow 规则', () => {
    const s = session()
    s.settings = { permissionMode: 'plan' }
    assert.equal(mod.needsPermission(s, 'Write', { input: { file_path: 'src/a.ts' } }), true)
  })
})

describe('设置文件里的 bypass 开关', () => {
  test('disableBypassPermissionsMode 会让 bypassPermissions 不可选', async () => {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      permissions: { disableBypassPermissionsMode: 'disable' },
    }), 'utf8')
    mod.loadSettings()
    assert.equal(mod.bypassDisabled(), true)
    assert.equal(mod.validateSetting('permissionMode', 'bypassPermissions'), false)
    assert.equal(mod.validateSetting('permissionMode', 'default'), true)

    // 取消后又能选了
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ permissions: {} }), 'utf8')
    mod.loadSettings()
    assert.equal(mod.validateSetting('permissionMode', 'bypassPermissions'), true)
  })
})
