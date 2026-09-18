/**
 * REPL 模式钩子快照回归测试（选项①：REPL 模式钩子冒烟）。
 *
 * 背景：REPL 与 print 共用 runToolUse → runPreToolUseHooks/runPostToolUseHooks，
 * 但 REPL 的"钩子从哪来"与 print 不同：
 *   - print 模式不调用 setup()，靠 getHooksConfigFromSnapshot() 的 *惰性* 兜底捕获；
 *   - REPL 模式在 main.tsx 启动期显式调用 setup() → captureHooksConfigSnapshot()
 *     （setup.ts:165）把快照种下，运行时再经 getHooksConfigFromSnapshot() 读回。
 *
 * 本测试锁死"REPL 启动期显式 capture 的那次快照"确实产出了**归一化 + 合并**后的钩子，
 * 即 REPL 路径会真正执行用户配置（含旧事件名）里的钩子。真机交互式 REPL 需要 TTY，
 * 本沙箱无法分配（winpty/script/expect 均不可用或拒绝管道 stdin，Ink 强制要求 TTY），
 * 故用 hermetic 方式钉死 REPL 独有的"启动期快照播种"这一环。
 *
 * 手法：LIMKENION_CONFIG_DIR 重定向 + 写老名/新名混合配置 + enableConfigs()，
 * 再显式调用 captureHooksConfigSnapshot()（模拟 setup()），经 getHooksConfigFromSnapshot() 读回断言。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠ 在任何 CLI 模块 import 之前设置：配置根目录是记忆化的
const tmpConfig = mkdtempSync(join(tmpdir(), 'limkenion-repl-snap-'))
process.env.LIMKENION_CONFIG_DIR = tmpConfig

// ⚠ 在 import 之前写入配置：settings 读取有缓存，且更贴近真实启动顺序
writeFileSync(join(tmpConfig, 'settings.json'), JSON.stringify({
  hooks: {
    // 旧事件名（本 fork 改名前的写法）——REPL 启动快照必须归一化它们
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo legacy-pre' }] },
    ],
    PostToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo legacy-post' }] },
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: 'echo legacy-session' }] },
    ],
    // 新名（canonical）再声明一次，验证旧名+新名同事件 MERGE 不丢
    'tool-before': [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo new-pre' }] },
    ],
  },
}), 'utf8')

const { enableConfigs } = await import('../utils/config.js')
enableConfigs()

const { captureHooksConfigSnapshot, getHooksConfigFromSnapshot } =
  await import('../utils/hooks/hooksConfigSnapshot.js')

after(() => {
  rmSync(tmpConfig, { recursive: true, force: true })
})

describe('REPL 启动期钩子快照（setup → captureHooksConfigSnapshot）', () => {
  it('显式 capture 后，快照里旧名已归一化为新契约名', () => {
    // 模拟 main.tsx 启动期 setup() 的那次显式捕获
    captureHooksConfigSnapshot()

    const snapshot = getHooksConfigFromSnapshot()
    assert.ok(snapshot, '快照不应为 null')

    // 旧名必须消失、新名必须出现（归一化发生在 capture 阶段）
    assert.ok(!('PreToolUse' in (snapshot as object)), '旧名 PreToolUse 不应留在快照')
    assert.ok(!('PostToolUse' in (snapshot as object)), '旧名 PostToolUse 不应留在快照')
    assert.ok(!('SessionStart' in (snapshot as object)), '旧名 SessionStart 不应留在快照')

    assert.ok(Array.isArray((snapshot as any)['tool-before']), '新名 tool-before 必须在快照')
    assert.ok(Array.isArray((snapshot as any)['tool-after']), '新名 tool-after 必须在快照')
    assert.ok(Array.isArray((snapshot as any)['session-open']), '新名 session-open 必须在快照')
  })

  it('旧名 + 新名同事件（tool-before）声明被 MERGE 而非静默丢弃', () => {
    captureHooksConfigSnapshot()
    const snapshot = getHooksConfigFromSnapshot() as any
    const preHooks = snapshot['tool-before']
    assert.ok(Array.isArray(preHooks), 'tool-before 必须存在')
    // 旧名 PreToolUse(Bash) + 新名 tool-before(Bash) 各一条 → 合并后 2 条
    const commands = preHooks.flatMap((g: any) => g.hooks.map((h: any) => h.command))
    assert.deepEqual(
      commands.sort(),
      ['echo legacy-pre', 'echo new-pre'],
      '旧名与新名同事件的钩子必须都保留（MERGE）',
    )
  })

  it('快照经 getHooksConfigFromSnapshot 多次读取幂等，且新名 tool-after 也归一化到位', () => {
    // 模拟 REPL 运行中每次工具调用都经 getHooksConfigFromSnapshot() 读回快照
    captureHooksConfigSnapshot()
    const a = getHooksConfigFromSnapshot() as any
    const b = getHooksConfigFromSnapshot() as any
    assert.strictEqual(a, b, '快照读取应幂等（返回同一份捕获结果，不重复解析磁盘）')

    // tool-after 来自旧名 PostToolUse，必须归一化到位（与 tool-before 对称验证）
    const postCmds = (a['tool-after'] as any[]).flatMap(g => g.hooks.map((h: any) => h.command))
    assert.deepEqual(postCmds, ['echo legacy-post'], '旧名 PostToolUse 应归一化为 tool-after 且命令保留')

    // session-open 来自旧名 SessionStart
    const sessionCmds = (a['session-open'] as any[]).flatMap(g => g.hooks.map((h: any) => h.command))
    assert.deepEqual(sessionCmds, ['echo legacy-session'], '旧名 SessionStart 应归一化为 session-open 且命令保留')
  })
})
