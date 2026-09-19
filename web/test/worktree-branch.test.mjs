/**
 * "新会话选分支启动" 的服务端部分：分支列举 + 按指定分支建 worktree。
 *
 * 用**真的 git 仓库**（不是 mock）：worktree 的语义就是 git 的语义，mock 等于没测。
 * 另外重点验证**分支名校验** —— 那个字符串会拼进 git 参数，必须挡住参数注入。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

let ws
let worktree
let sessions

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

before(async () => {
  ws = await mkdtemp(join(tmpdir(), 'lk-wtbranch-'))
  process.env.LIMKENION_WEB_WORKSPACE = ws.dir ?? ws
  process.env.LIMKENION_WEB_STATE_DIR = join(ws, '.state')
  process.env.DEEPSEEK_API_KEY = 'test-key'

  // 建一个真的 git 仓库，带两个分支
  const repo = ws
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'src', 'a.txt'), 'a\n', 'utf8')
  await writeFile(join(repo, 'README.md'), '# demo\n', 'utf8')
  git(['init', '-q', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'test'], repo)
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'init'], repo)
  git(['branch', 'feature/existing'], repo)

  worktree = await import('../server/worktree.mjs')
  sessions = await import('../server/sessions.mjs')
})

after(async () => {
  // worktree 会在仓库内建目录；整个临时目录一起丢掉即可
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: ws, stdio: 'ignore' })
  } catch {
    /* 忽略 */
  }
})

test('listBranches 列出已有分支', async () => {
  const list = await worktree.listBranches()
  assert.ok(list.includes('main'), `应含 main，实际：${list.join(',')}`)
  assert.ok(list.includes('feature/existing'), `应含 feature/existing，实际：${list.join(',')}`)
})

test('按已存在的分支建 worktree：检出那个分支', async () => {
  const s = sessions.createSession()
  const r = await worktree.enterWorktree(s, 'on-existing', 'feature/existing')
  assert.match(r.worktreeBranch, /feature\/existing/, '应检出指定分支')
  assert.ok(existsSync(s.worktree.path), 'worktree 目录应存在')
  // 会话沙箱根切过去了
  assert.strictEqual(s.workspaceRoot, s.worktree.path)
})

test('按不存在的分支建 worktree：以 HEAD 新建该分支', async () => {
  const s = sessions.createSession()
  const r = await worktree.enterWorktree(s, 'on-new', 'feature/brand-new')
  assert.match(r.worktreeBranch, /feature\/brand-new/)

  const list = await worktree.listBranches()
  assert.ok(list.includes('feature/brand-new'), '新分支应真的被建出来')
})

test('不传分支时保持原行为：用自己的命名空间分支，不碰用户分支', async () => {
  const s = sessions.createSession()
  const r = await worktree.enterWorktree(s, 'namespaced')
  assert.match(r.worktreeBranch, /^limkenion-wt\//, '应落在 limkenion-wt/ 命名空间')
})

test('分支名校验：挡住参数注入 / 非法字符', async () => {
  const s = sessions.createSession()
  // 以 - 开头会被 git 当成选项
  await assert.rejects(
    () => worktree.enterWorktree(s, 'x1', '--upload-pack=evil'),
    /不合法|分支名/,
    '以 - 开头的分支名必须被拒'
  )
  // 空格
  await assert.rejects(() => worktree.enterWorktree(s, 'x2', 'has space'), /不合法|分支名/)

  // 目录穿越式
  await assert.rejects(() => worktree.enterWorktree(s, 'x3', 'a..b'), /不合法|分支名/)

  // 校验失败时不能把会话弄成"半进 worktree"的状态
  assert.strictEqual(s.worktree ?? null, null, '校验失败不该改动会话')
})

test('同名 worktree 请求另一个分支：必须报错（不能静默给错分支）', async () => {
  // 用**全新**的分支：git 不允许同一个分支被多个 worktree 同时检出，
  // 复用上面用例用过的分支会直接撞在这条 git 限制上，测不到我们要测的东西。
  git(['branch', 'wt/one'], ws)
  git(['branch', 'wt/two'], ws)

  const s1 = sessions.createSession()
  await worktree.enterWorktree(s1, 'dup-name', 'wt/one')
  assert.strictEqual(s1.worktree.branch, 'wt/one')

  // 同一个目录名、换一个分支：目录已存在，若直接复用就会把用户带进 wt/one，
  // 而 session 里记的却是 wt/two —— 静默给错分支，最难查的那种。
  const s2 = sessions.createSession()
  await assert.rejects(
    () => worktree.enterWorktree(s2, 'dup-name', 'wt/two'),
    /不一致|已存在/,
    '同名 worktree 换分支必须报错，不能静默复用',
  )
  // 失败的会话不能处于"半进 worktree"的状态
  assert.strictEqual(s2.worktree ?? null, null)

  // 同目录名 + **同一个分支**则允许：幂等复用，不该报错
  const s3 = sessions.createSession()
  const r = await worktree.enterWorktree(s3, 'dup-name', 'wt/one')
  assert.strictEqual(r.worktreeBranch, 'wt/one', '同分支应可复用（幂等）')
})
