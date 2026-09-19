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
let workspaceRoot
let workspaceRoots
let isInsideWorkspace
let withWorkspace

before(async () => {
  ws = await makeWorkspace({ 'a/b.txt': 'hello' })
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir
  ;({ safePath, workspaceRoot, workspaceRoots, isInsideWorkspace, withWorkspace } = await import(
    '../server/paths.mjs'
  ))
  WORKSPACE_ROOT = workspaceRoot()
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

  test('拒绝 \\\\?\\ 扩展前缀（会绕过 normalize，实测指向区外时能被拦）', () => {
    if (process.platform !== 'win32') return
    const outside = 'C:\\Windows\\win.ini'
    assert.throws(() => safePath('\\\\?\\' + outside), /越界/)
  })

  test('拒绝 UNC 网络路径', () => {
    if (process.platform !== 'win32') return
    assert.throws(() => safePath('\\\\localhost\\c$\\Windows\\win.ini'), /越界/)
  })

  test('区内路径换大小写仍放行（Windows 大小写不敏感，别误伤）', () => {
    if (process.platform !== 'win32') return
    const p = safePath('a/b.txt')
    assert.ok(safePath(p.toUpperCase()).length > 0, '大写形式也应放行')
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

/**
 * 沙箱根是**按会话**的（会话可以进入 git worktree）。
 *
 * 这一组的重点是"作用域不会串味"：如果哪天有人把 AsyncLocalStorage 换回模块级
 * 可变变量，下面那条并发用例会**在会话之间互相看见对方的目录** —— 那就是越界读写。
 */
describe('沙箱作用域（按会话的根）', () => {
  // 注意：不能在 describe 回调里就用 WORKSPACE_ROOT —— 那时文件级 before 还没跑。
  let otherDir
  let extraDir
  before(() => {
    otherDir = join(WORKSPACE_ROOT, '..', 'limkenion-other-root')
    extraDir = join(WORKSPACE_ROOT, '..', 'limkenion-extra-dir')
  })

  test('回合外用默认根', () => {
    assert.equal(workspaceRoot(), WORKSPACE_ROOT)
    assert.deepEqual(workspaceRoots(), [WORKSPACE_ROOT])
  })

  test('withWorkspace 改根，退出后还原', () => {
    let inner
    const ret = withWorkspace({ root: otherDir }, () => {
      inner = safePath('x.txt')
      assert.equal(workspaceRoot(), otherDir)
      // 默认根里的路径在这个作用域里应当**越界**
      assert.equal(isInsideWorkspace(join(WORKSPACE_ROOT, 'a', 'b.txt')), false)
      return 'ret'
    })
    assert.equal(ret, 'ret')
    assert.equal(inner, join(otherDir, 'x.txt'))
    assert.equal(workspaceRoot(), WORKSPACE_ROOT, '退出作用域后必须还原')
  })

  test('并发作用域互不串味（这是不能用模块级变量的原因）', async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const seen = []
    await Promise.all([
      withWorkspace({ root: otherDir }, async () => {
        await sleep(25)
        seen.push(['A', workspaceRoot(), safePath('f.txt')])
      }),
      withWorkspace({ root: extraDir }, async () => {
        await sleep(5)
        seen.push(['B', workspaceRoot(), safePath('f.txt')])
      }),
    ])
    const a = seen.find(s => s[0] === 'A')
    const b = seen.find(s => s[0] === 'B')
    assert.equal(a[1], otherDir, `A 作用域被串味成 ${a[1]}`)
    assert.equal(a[2], join(otherDir, 'f.txt'))
    assert.equal(b[1], extraDir, `B 作用域被串味成 ${b[1]}`)
    assert.equal(b[2], join(extraDir, 'f.txt'))
  })

  test('额外可访问目录（additionalDirectories）在根之外也放行', () => {
    withWorkspace({ root: WORKSPACE_ROOT, additions: [extraDir] }, () => {
      assert.equal(safePath(join(extraDir, 'y.txt')), join(extraDir, 'y.txt'))
      assert.deepEqual(workspaceRoots(), [WORKSPACE_ROOT, extraDir])
      // 额外目录之外仍然拦
      assert.throws(() => safePath(join(extraDir, '..', 'elsewhere.txt')), /越界/)
    })
  })

  test('额外目录不会反过来把主根踢出沙箱', () => {
    withWorkspace({ root: WORKSPACE_ROOT, additions: [extraDir] }, () => {
      assert.equal(isInsideWorkspace(join(WORKSPACE_ROOT, 'a', 'b.txt')), true)
      assert.equal(safePath('a/b.txt'), join(WORKSPACE_ROOT, 'a', 'b.txt'))
    })
  })

  test('越界时错误信息把全部沙箱根都列出来', () => {
    withWorkspace({ root: WORKSPACE_ROOT, additions: [extraDir] }, () => {
      try {
        safePath('../nope.txt')
        assert.fail('应当越界')
      } catch (err) {
        assert.match(err.message, /越界/)
        assert.ok(err.message.includes(WORKSPACE_ROOT), '要能看出主根')
        assert.ok(err.message.includes(extraDir), '也要能看出额外目录 —— 否则排错时会以为没生效')
      }
    })
  })

  test('作用域内抛错不会把根留在里面', () => {
    assert.throws(() => withWorkspace({ root: otherDir }, () => { throw new Error('boom') }), /boom/)
    assert.equal(workspaceRoot(), WORKSPACE_ROOT)
  })
})

// ---------------------------------------------------------------------------
// 软链逃逸（实测可绕过：路径看着在沙箱内，实际指向外面）
// ---------------------------------------------------------------------------

describe('软链逃逸', () => {
  /** 建一个工作区外的目录，里面放个文件。 */
  async function outsideDir(content = 'TOP-SECRET') {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'lk-outside-'))
    const file = join(dir, 'secret.txt')
    await writeFile(file, content)
    return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) }
  }

  test('指向区外的软链必须被拒绝（否则沙箱被绕过）', async () => {
    const out = await outsideDir()
    const { symlinkSync } = await import('node:fs')
    const link = join(ws.dir, 'innocent.txt')
    try {
      symlinkSync(out.file, link)
    } catch (err) {
      // 这台机器建不了软链（Windows 需要管理员/开发者模式）—— 无法验证，如实跳过
      await out.cleanup()
      return
    }
    assert.throws(() => safePath(link), /越界/, '软链指向区外时必须拒绝')
    await out.cleanup()
  })

  test('指向区内的软链要放行（不能误伤合法软链）', async () => {
    const { symlinkSync, writeFileSync } = await import('node:fs')
    const target = join(ws.dir, 'real.txt')
    writeFileSync(target, 'inside')
    const link = join(ws.dir, 'alias.txt')
    try {
      symlinkSync(target, link)
    } catch {
      return // 建不了软链，跳过
    }
    assert.equal(safePath(link), link, '区内软链不该被拦')
  })

  test('悬空软链（目标还不存在）指向区外也要拒绝', async () => {
    const { symlinkSync } = await import('node:fs')
    const link = join(ws.dir, 'dangling.txt')
    const outsideTarget = join(await import('node:os').then(m => m.tmpdir()), 'lk-not-exist-xyz.txt')
    try {
      symlinkSync(outsideTarget, link)
    } catch {
      return
    }
    // realpath 会因为目标不存在而失败 —— 只能靠 lstat + readlink 认出来
    assert.throws(() => safePath(link), /越界/, '悬空软链指向区外时必须拒绝')
  })

  test('普通文件照常放行（防过度收紧）', () => {
    assert.equal(safePath('a/b.txt'), join(ws.dir, 'a/b.txt'))
  })

  test('目录遍历不跟随软链（否则扫到区外、Grep 会读到区外内容）', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { symlinkSync } = await import('node:fs')
    const out = await mkdtemp(join(tmpdir(), 'lk-walk-out-'))
    await writeFile(join(out, 'outside.txt'), 'nope')

    const link = join(ws.dir, 'linked-dir')
    try {
      symlinkSync(out, link, 'dir')
    } catch {
      await rm(out, { recursive: true, force: true })
      return // 建不了目录软链，跳过
    }

    // 前置条件：软链确实能通到区外（否则这条就是白测 —— 谁都能"扫不到"）
    const { existsSync } = await import('node:fs')
    assert.ok(
      existsSync(join(link, 'outside.txt')),
      '前置条件不成立：软链没能通到区外文件，这条用例没测到东西',
    )

    const { collectFiles } = await import('../server/workspace.mjs')
    const files = await collectFiles(ws.dir)
    assert.ok(
      !files.some(f => f.includes('lk-walk-out-')),
      '遍历不该穿过软链扫到区外的文件：' + files.filter(f => f.includes('lk-walk-out-')).join('、'),
    )
    await rm(out, { recursive: true, force: true })
  })

  test('工作区根自己在链接下时，区内文件不能误判成越界', async () => {
    // 关键回归点：只 realpath 文件、不 realpath 根的话，
    // 根在 /tmp → /private/tmp 这类链接下时区内文件会被全判越界。
    const { realpathSync, symlinkSync } = await import('node:fs')
    const realRoot = realpathSync(ws.dir)
    assert.ok(safePath(join(realRoot, 'a', 'b.txt')).length > 0, '真实路径形式也应放行')
    // 再把根换成"链接形式"走一遍
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const holder = await mkdtemp(join(tmpdir(), 'lk-holder-'))
    const alias = join(holder, 'ws-alias')
    try {
      symlinkSync(ws.dir, alias, 'dir')
      withWorkspace({ root: alias }, () => {
        assert.ok(
          isInsideWorkspace(join(alias, 'a', 'b.txt')),
          '根是软链时，区内文件仍应判为在沙箱内',
        )
      })
    } catch {
      // 建不了目录软链就跳过（Windows 常见）
    } finally {
      await (await import('node:fs/promises')).rm(holder, { recursive: true, force: true })
    }
  })
})
