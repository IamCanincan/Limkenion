/**
 * git worktree 支持（EnterWorktree / ExitWorktree 的真实现）。
 *
 * CLI 那边的语义（`utils/worktree.ts` + `tools/{Enter,Exit}WorktreeTool/`）：
 *   在 `<repo>/.limkenion/worktrees/<slug>` 下基于 HEAD 建一个带新分支的 worktree，
 *   并把**会话的工作目录**切过去；退出时可以保留或移除。
 * 本模块照这个语义实现，但有三条 web 端必须说清楚的取舍：
 *
 * 1. **切的是「沙箱根」**，不只是 cwd。web 端所有文件工具都受 `safePath` 约束，
 *    而 `safePath` 的界限来自会话的根（见 paths.mjs）。所以进入 worktree = 这个会话
 *    只能看见那棵新树 —— 这正是隔离的本意，但要说出来，否则用户会以为"还能看老目录"。
 * 2. **只在当前沙箱内建**。目标路径必须落在当前根里；仓库主根在沙箱外时拒绝，
 *    并告诉用户把仓库根加进 `permissions.additionalDirectories`。
 *    不这么做的话，"创建 worktree"就变成了一个绕过沙箱写文件的通道。
 * 3. **分支放在自己的命名空间**（`limkenion-wt/<slug>`）。用 `-B` 重置同名分支是
 *    必要的（worktree 目录被删过之后会留下孤儿分支），但绝不能重置用户已有的分支。
 *
 * `node_modules` 之类未受版本控制的目录不会被带过去（git 的行为），
 * 所以新建的 worktree 里跑构建/测试往往要先装依赖 —— 返回结果里会提醒。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { toPosix, workspaceRoot } from './paths.mjs'
import { HOOK_EVENT, hooksEnabled, runEventHooks, sessionHookInput } from './hooks.mjs'

const GIT_TIMEOUT_MS = 60_000

/** 目录包含判断（含相等）。 */
function insideDir(root, abs) {
  const rel = relative(resolve(root), resolve(abs))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 分支命名空间：避免 -B 重置到用户自己的分支。 */
export const BRANCH_PREFIX = 'limkenion-wt/'

/** 跑一条 git 命令。 */
function git(args, cwd) {
  return new Promise(resolveResult => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolveResult({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim(),
          error: error ? String(error.message ?? error) : null,
        })
      },
    )
  })
}

/** 当前根是否在 git 仓库里；返回仓库主根（linked worktree 也能拿到主仓库）。 */
export async function repoRootOf(root = workspaceRoot()) {
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)
  if (!common.ok) return null
  // --git-common-dir 指向主仓库的 .git（linked worktree 也是同一个），其父目录即主根
  const dotGit = resolve(root, common.stdout)
  return dirname(dotGit)
}

/**
 * 校验 worktree 名称。
 * 与 CLI 的 `validateWorktreeSlug` 一致：按 `/` 分段，每段只允许字母/数字/点/下划线/短横线，
 * 总长 ≤ 64。`..` 明确拒绝（它会顺着 path.join 逃出 worktrees 目录）。
 */
export function validateWorktreeSlug(slug) {
  const s = String(slug ?? '').trim()
  if (!s) throw new Error('worktree 名称不能为空')
  if (s.length > 64) throw new Error(`worktree 名称过长（${s.length} > 64）`)
  for (const seg of s.split('/')) {
    if (!seg) throw new Error('worktree 名称不能有空段（连续的 /）')
    if (seg === '.' || seg === '..') throw new Error(`worktree 名称不允许出现 ${seg}`)
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) {
      throw new Error(`worktree 名称的每一段只能包含字母、数字、点、下划线和短横线：${seg}`)
    }
  }
  return s
}

/** 嵌套 slug 扁平化（`user/feature` → `user+feature`），目录名与分支名都用它。 */
function flattenSlug(slug) {
  return slug.split('/').join('+')
}

function worktreesDir(repoRoot) {
  return join(repoRoot, '.limkenion', 'worktrees')
}

function randomSlug() {
  return 'wt-' + Math.random().toString(36).slice(2, 8)
}

/** 当前会话是否已经在某个 worktree 里。 */
export function currentWorktree(session) {
  return session?.worktree ?? null
}

/**
 * 进入（创建）一个 worktree，并把会话的沙箱根切过去。
 * @returns {Promise<{worktreePath: string, worktreeBranch: string, message: string}>}
 */
/**
 * 列出仓库的分支（供"新会话选分支"用）。
 * @param {string} [root]
 * @returns {Promise<string[]>}
 */
export async function listBranches(root = workspaceRoot()) {
  const repoRoot = await repoRootOf(root)
  if (!repoRoot) return []
  const res = await git(['branch', '--format=%(refname:short)'], repoRoot)
  if (!res.ok) return []
  return res.stdout
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .sort()
}

/**
 * 校验分支名 —— 这个字符串最终会拼进 git 的参数，必须挡住参数注入
 * （以 `-` 开头会被当成选项；空格 / `..` 之类也要拒）。
 * @param {string} branch
 * @returns {string}
 */
function validateBranchName(branch) {
  const b = String(branch ?? '').trim()
  if (!/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith('-') || b.includes('..') || b.includes('//')) {
    throw new Error(
      `分支名不合法：${branch}（只允许字母数字与 . _ / -，不能以 - 开头，不接受 ..）`,
    )
  }
  return b
}

/**
 * 进入 worktree。
 *
 * 不传 `branch` 时保持原行为：建自己的命名空间分支 `limkenion-wt/<slug>`（基于 HEAD），
 * 绝不碰用户已有的分支。传了 `branch` 时按用户指定的分支建：分支已存在就检出它，
 * 不存在则以 HEAD 为起点新建 —— 这就是界面上"选分支启动新会话"要用到的分支。
 *
 * @param {object} session
 * @param {string} [name] worktree 目录名（slug）；空则随机
 * @param {string} [branch] 要检出的分支；空则用自带的命名空间分支
 */
export async function enterWorktree(session, name, branch) {
  const root = session?.workspaceRoot ?? workspaceRoot()
  const existing = currentWorktree(session)
  if (existing) {
    throw new Error(`会话已经在 worktree 里（${existing.path}），先 ExitWorktree 再进新的`)
  }

  // 先校验参数再看仓库：名称非法是调用方的错，不该被"不是 git 仓库"这种环境问题盖住。
  const slug = name ? validateWorktreeSlug(name) : randomSlug()
  const flat = flattenSlug(slug)

  const repoRoot = await repoRootOf(root)
  if (!repoRoot) {
    throw new Error(
      `当前沙箱根不是 git 仓库，无法创建 worktree：${root}\n` +
        '（CLI 在仓库外会委托 WorktreeCreate 钩子，web 端没有钩子可委托）',
    )
  }

  const path = join(worktreesDir(repoRoot), flat)
  // 指定了分支就用它（先校验，别把任意字符串喂给 git）；否则用自己的命名空间分支。
  const target = branch ? validateBranchName(branch) : BRANCH_PREFIX + flat

  // 取舍 2：只在**本会话的沙箱根**内建，避免"创建 worktree"变成绕过沙箱写文件的通道。
  // 这里必须用 `root`（会话的根）自己判，不能依赖调用方已经进了正确的 ALS 作用域 ——
  // 工具可以被任何上下文调用，安全判断不能建立在"调用方记得包 withWorkspace"之上。
  if (!insideDir(root, path)) {
    throw new Error(
      `目标 worktree 落在当前沙箱之外，已拒绝：${path}\n` +
        `当前沙箱：${root}\n` +
        '如果确实要在那个仓库里工作，把仓库根加进设置文件的 permissions.additionalDirectories。',
    )
  }

  mkdirSync(dirname(path), { recursive: true })

  if (!existsSync(path)) {
    // 两种建法：
    //  - 指定分支：分支已存在就检出它；不存在则以 HEAD 为起点 -b 新建。
    //  - 未指定：-B 自己的命名空间分支（目录被删过可能留下孤儿分支，重置它），
    //    命名空间是 limkenion-wt/ 前缀，不会碰到用户已有的分支。
    const known = branch ? await listBranches(repoRoot) : []
    const args = branch && known.includes(target)
      ? ['worktree', 'add', path, target]
      : ['worktree', 'add', '-b', target, path, 'HEAD']
    const add = await git(args, repoRoot)
    if (!add.ok) {
      throw new Error(`git worktree add 失败：${add.stderr || add.error}`)
    }
  }

  session.worktree = { path, branch: target, base: session.workspaceRoot ?? null }
  session.workspaceRoot = path

  const base = session.worktree.base ?? root
  if (hooksEnabled()) {
    void runEventHooks(HOOK_EVENT.WORKTREE_CREATE, {
      hookInput: sessionHookInput(session, { path: toPosix(path), branch: target }),
    })
  }
  return {
    worktreePath: toPosix(path),
    worktreeBranch: target,
    message:
      `已进入 worktree：${toPosix(path)}（分支 ${target}）\n` +
      `会话沙箱根现在是这个目录 —— 原目录（${toPosix(base)}）不再可访问，` +
      '这是隔离的本意；要看原目录请先 ExitWorktree。\n' +
      '注意：未受版本控制的目录（如 node_modules）不会被带过来，跑构建/测试前可能要装依赖。',
  }
}

/**
 * 退出 worktree：把沙箱根还原，并按需移除目录。
 *
 * `discardChanges` 与 CLI 的 `discard_changes` 同义：**只有它显式为 true 才允许
 * 丢弃未提交的改动**。默认（false）时如果目录是脏的，就**拒绝移除**并把要丢的东西列出来
 * —— 原来没有这个参数，于是脏 worktree 根本无法通过工具清理（只剩"自己敲 git 命令"
 * 这条路），模型会反复重试 remove 而每次都失败。
 *
 * @param {object} session
 * @param {boolean} remove action === 'remove'
 * @param {boolean} discardChanges 是否允许丢弃未提交改动
 * @returns {Promise<{action: 'keep'|'remove', message: string}>}
 */
export async function exitWorktree(session, remove, discardChanges = false) {
  const current = currentWorktree(session)
  if (!current) throw new Error('当前会话不在任何 worktree 里')

  // **先还原沙箱根，再决定目录怎么处理。**
  // 顺序很重要：任何一条分支提前 return，都必须已经还原过 ——
  // 否则会出现"工具说已退出，会话其实还卡在 worktree 里"，
  // 而 worktree 目录可能刚被删掉，之后所有文件工具都在一个不存在的根上工作。
  // 还原成「默认根」用 null 表示（与会话对象的字段形状一致：blankSession 里就是 null）。
  // 不要用 delete —— 那会让字段变成 undefined，落盘/前端判断时又要多一处特例。
  const restored = current.base ?? null
  session.workspaceRoot = restored
  session.worktree = null

  const repoRoot = await repoRootOf(current.path)
  const backTo = toPosix(restored ?? repoRoot ?? workspaceRoot())
  /** 标成联合：`let action = 'keep'` 会被推成 string，与返回类型里的 'keep'|'remove' 对不上。 */
  let action = /** @type {'keep'|'remove'} */ ('keep')
  const notes = []

  if (remove) {
    if (!repoRoot) {
      notes.push('找不到主仓库，保留目录（请手动清理）。')
    } else {
      // 先看这棵树脏不脏：有未提交改动 / 未合并提交时**不能默默丢掉**。
      // 这一步是"拒绝"与"--force"的分水岭，所以要在动手之前做。
      let dirty = []
      if (!discardChanges) {
        const status = await git(['status', '--porcelain'], current.path)
        const unmerged = await git(['log', '--oneline', 'HEAD', '--not', '--remotes', '--branches'], current.path)
        if (status.ok && status.stdout) {
          const lines = status.stdout.split('\n').filter(Boolean)
          dirty.push(`${lines.length} 个未提交改动（如 ${lines.slice(0, 3).join('、')}${lines.length > 3 ? ' …' : ''}）`)
        }
        if (unmerged.ok && unmerged.stdout) {
          const n = unmerged.stdout.split('\n').filter(Boolean).length
          dirty.push(`${n} 个未合并提交`)
        }
      }

      if (dirty.length > 0) {
        return {
          action: 'keep',
          message:
            `已退出 worktree（沙箱根还原为 ${backTo}），但**目录没有删除**：` +
            `这棵树里有 ${dirty.join('、')}，删掉就永久没了。\n` +
            `目录保留在 ${toPosix(current.path)}（分支 ${current.branch}）。\n` +
            '确认要丢弃这些改动，再用 action:"remove" 且 discard_changes:true 重试；' +
            '想先看看改了什么，可以在进入 worktree 后用 /diff。',
        }
      }

      // 带 --force 只在调用方显式确认（discard_changes: true）后才用
      const args = ['worktree', 'remove', current.path, ...(discardChanges ? ['--force'] : [])]
      const rm = await git(args, repoRoot)
      if (rm.ok) {
        action = 'remove'
        notes.push(discardChanges ? '目录已强制移除（未提交的改动已丢弃）。' : '目录已移除。')
        const del = await git(['branch', '-D', current.branch], repoRoot)
        if (!del.ok) notes.push(`分支 ${current.branch} 未删除：${del.stderr || del.error}`)
      } else {
        notes.push(`目录未移除（git worktree remove 失败）：${rm.stderr || rm.error}`)
      }
      if (action === 'remove' && hooksEnabled()) {
        void runEventHooks(HOOK_EVENT.WORKTREE_REMOVE, {
          hookInput: sessionHookInput(session, { path: toPosix(current.path), branch: current.branch }),
        })
      }
    }
  }

  return {
    action,
    message:
      `已退出 worktree。沙箱根还原为：${backTo}\n` +
      (action === 'keep'
        ? `目录保留在 ${toPosix(current.path)}（分支 ${current.branch}），可以之后再进来。`
        : `已清理 ${toPosix(current.path)}。`) +
      (notes.length ? '\n' + notes.join('\n') : ''),
  }
}

/** 供 /status 展示一行。 */
export function worktreeSummary(session) {
  const w = currentWorktree(session)
  return w ? `${toPosix(w.path)}（分支 ${w.branch}）` : '否'
}
