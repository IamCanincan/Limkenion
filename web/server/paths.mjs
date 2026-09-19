/**
 * 路径解析与沙箱校验（被 tools / config / workspace / settings 共用，因此单独成模块避免循环依赖）。
 *
 * **沙箱根是「按会话」的，不是进程级的**（这一条是安全边界，改之前先读完本节）：
 *   - 进程启动时的根 = `LIMKENION_WEB_WORKSPACE` || CLI 源码根，叫 **默认根**；
 *   - 回合/命令处理期间，根可以是**当前会话的根** —— 会话进入 git worktree 后会变；
 *   - 还可以有**额外可访问目录**（设置文件里的 `permissions.additionalDirectories`）。
 *
 * 承载方式是 Node 自带的 `AsyncLocalStorage`，不是模块级可变变量。原因：
 *   1. 模块级可变变量在并发回合之间会互相串味（会话 A 切了 worktree，会话 B 的
 *      safePath 也跟着变了 —— 那就是越界读写的口子）；
 *   2. 用 ALS 之后 `safePath(p)` / `isInsideWorkspace(p)` 的**签名一个都不用改**，
 *      于是不可能漏掉某个调用点 —— 只要它在回合内执行，就自动拿到正确的根。
 *
 * 只在协议边界（每个 WS 消息）与回合边界（runTurn）进入作用域，
 * 其余地方一律走 `withWorkspace()`；**不要直接读 WORKSPACE_ROOT 常量做沙箱判断**。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 本文件所在目录。
 *
 * **刻意不用 `import.meta.dirname`**：它要 Node 20.11+ 才有，在 20.0~20.10 上是
 * `undefined` —— 而下面 `CLI_ROOT` 是**模块加载时**就求值的顶层常量，一旦拿到
 * undefined，`join(undefined, …)` 会抛 TypeError，结果是**整个服务起不来、测试全红**，
 * 且只有老一点的 Node 20 才复现（本地 Node 22/24 测不出来 —— CI 用的正是 Node 20）。
 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 定位 CLI 源码根，按优先级取第一个含 commands/ 的候选：
 *   1. LIMKENION_CLI_ROOT —— 显式指定
 *   2. 包内相对位置 —— web/ 位于 CLI 仓库内（源码模式）
 *   3. 进程工作目录 —— 全局安装后在任意项目里启动
 * 全局安装时包内相对位置会落在 node_modules/ 下，因此必须回退到工作目录。
 */
function detectCliRoot() {
  const fallback = process.cwd()
  // `.filter(Boolean)` 在 TS 里**不做类型收窄**（仍是 `(string|undefined)[]`），
  // 所以这里显式断言一次 —— 语义上 filter 已经把 falsy 全去掉了。
  const candidates = /** @type {string[]} */ ([
    process.env.LIMKENION_CLI_ROOT,
    join(HERE, '..', '..'),
    fallback,
  ].filter(Boolean))
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'commands'))) return resolve(c)
    } catch { /* 候选目录不可访问则跳过 */ }
  }
  return resolve(fallback)
}

/** CLI 源码根：命令注册表扫描、/agents 等镜像功能的来源目录。**不随会话变化。** */
export const CLI_ROOT = detectCliRoot()

/**
 * 进程默认沙箱根：显式环境变量 > CLI 源码根。**不随会话变化。**
 * 会话没设根时用它；设置文件也按它定位（见 settings.mjs 的说明）。
 */
export const DEFAULT_WORKSPACE_ROOT = resolve(process.env.LIMKENION_WEB_WORKSPACE ?? CLI_ROOT)

/**
 * @deprecated 只是**默认根**，不反映当前会话的根（例如进入 worktree 之后）。
 * 沙箱判断一律用 `isInsideWorkspace()` / `safePath()`；要拿根用 `workspaceRoot()`。
 */
export const WORKSPACE_ROOT = DEFAULT_WORKSPACE_ROOT

/** 沙箱作用域载体（异步安全，见文件头说明）。 */
const als = new AsyncLocalStorage()

/** 当前作用域。默认为「默认根 + 无额外目录」。 */
function currentScope() {
  return als.getStore() ?? { root: DEFAULT_WORKSPACE_ROOT, additions: [] }
}

/** 当前生效的沙箱根（回合内 = 该会话的根，可能是某个 git worktree）。 */
export function workspaceRoot() {
  return currentScope().root
}

/** 当前可访问的全部根：主根在前，额外目录在后。 */
export function workspaceRoots() {
  const { root, additions } = currentScope()
  return [root, ...additions]
}

/**
 * 在指定沙箱作用域里执行一段代码（异步安全）。
 * @param {{root?: string, additions?: string[]}} scope
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
export function withWorkspace(scope, fn) {
  const root = resolve(scope?.root ?? DEFAULT_WORKSPACE_ROOT)
  const additions = []
  for (const a of scope?.additions ?? []) {
    if (typeof a !== 'string' || !a.trim()) continue
    const abs = resolve(a.trim())
    // 额外目录与主根重合时不必重复；自己不能被"加"成主根的父级
    if (abs !== root && !additions.includes(abs)) additions.push(abs)
  }
  return als.run({ root, additions }, fn)
}

/** 由会话对象构造作用域（会话没设根就用默认根）。 */
export function scopeForSession(session) {
  return {
    root: session?.workspaceRoot ?? null,
    additions: session?.workspaceAdditions ?? [],
  }
}

/** posix 相对判断：abs 是否落在 root 之内（含相等）。 */
function inside(root, abs) {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 该绝对路径命中的根（主根优先，其次额外目录）；都不命中返回 null。 */
function matchedRoot(abs) {
  const { root, additions } = currentScope()
  if (inside(root, abs)) return root
  for (const a of additions) if (inside(a, abs)) return a
  return null
}

/** POSIX 风格路径（前端与工具输出统一用正斜杠）。 */
export function toPosix(p) {
  return p.split('\\').join('/')
}

/**
 * 把 glob 模式编译成正则（`*` 不跨 `/`，`**` 跨 `/`，`?` 单字符）。
 *
 * 供 Glob 工具与权限规则的文件模式匹配共用 —— 之前只在 `toolGlob` 里内联了一份，
 * 权限规则要用同样的语义，抽出来避免两处各写一套、语义漂移。
 */
export function globToRegExp(pattern) {
  return new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  )
}

/**
 * 相对沙箱根的 POSIX 路径。
 *
 * 额外目录里的文件相对**那个目录**计算（它们不属于主根，用主根算出来全是 `../..`）。
 * 一个都不命中时退回绝对 POSIX 路径 —— 越界路径仍要能显示出来，不能变成一个假相对路径。
 */
export function relToWorkspace(p) {
  const abs = resolve(p)
  const root = matchedRoot(abs)
  if (!root) return toPosix(abs)
  return toPosix(relative(root, abs))
}

/** 判断绝对路径是否落在沙箱内（含额外可访问目录）。 */
export function isInsideWorkspace(abs) {
  return matchedRoot(resolve(abs)) !== null
}

/**
 * 解析并校验路径必须在沙箱内；返回绝对路径。
 *
 * 除常规越界外，额外拦两类 Windows 陷阱：
 *   - 盘符相对路径（`C:foo`）—— `isAbsolute` 为 false，但 `resolve` 会跳到该盘根；
 *   - 设备名（CON/NUL/COM1…）与备用数据流（`file.txt:stream`）。
 */
/**
 * 真实路径（解析软链 / junction）。
 *
 * 目标还不存在时（Write 新建文件）退而解析**父目录** —— 父目录若指向外面，
 * 新建的文件同样会落到外面，这一步不能省。
 */
function realOrParent(abs) {
  try {
    return realpathSync(abs)
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs))
    } catch {
      return abs
    }
  }
}

/**
 * 拦软链逃逸：路径**看着**在沙箱内、但它指向外面。
 *
 * 只做 `resolve()` 的话，工作区里放一个软链就能读到区外的文件 —— 实测可逃逸。
 * 判断要点：
 *   - **两边都取 realpath** 再比。只 realpath 文件会误判：工作区根自己就在
 *     链接下面时（macOS 的 `/tmp` → `/private/tmp`，Windows junction），
 *     区内文件会被当成越界。
 *   - **悬空软链要单独认**：目标还不存在时 realpathSync 会失败，
 *     但它是软链这件事 `lstatSync` 能看出来，指向哪儿 `readlinkSync` 能拿到。
 */
/** 沙箱各根的真实路径（两边都取 realpath 才不会误判，理由见下面）。 */
function realRoots() {
  return workspaceRoots().map(r => {
    try {
      return realpathSync(r)
    } catch {
      return resolve(r)
    }
  })
}

/**
 * 软链逃逸检查：路径看着在沙箱内、实际指向外面时，**返回那个外面的真实路径**；
 * 没有逃逸则返回 null。
 *
 * 导出是为了让 shell 守卫复用同一套判断 —— 两边各写一份迟早会漂移。
 */
export function symlinkEscape(abs) {
  const roots = realRoots()
  const insideReal = p => roots.some(r => inside(r, p))

  try {
    if (lstatSync(abs).isSymbolicLink()) {
      const target = resolve(dirname(abs), readlinkSync(abs))
      if (!insideReal(target)) return target
    }
  } catch {
    // 路径不存在 / 不是软链 → 交给下面的 realpath 兜底
  }

  const real = realOrParent(abs)
  if (!insideReal(real)) return real
  return null
}

function assertNoSymlinkEscape(abs, inputPath) {
  const escaped = symlinkEscape(abs)
  if (escaped) {
    throw new Error(`路径越界（链接指向沙箱外：${escaped}）：${inputPath}`)
  }
}

export function safePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new Error('路径不能为空')
  }
  const raw = inputPath.trim()

  if (/^[a-zA-Z]:[^\\/]/.test(raw)) {
    throw new Error(`盘符相对路径不被允许（会跳出沙箱）：${inputPath}`)
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) && !isAbsolute(raw)) {
    throw new Error(`无法解析的盘符路径：${inputPath}`)
  }

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot(), raw)
  if (!isInsideWorkspace(abs)) {
    throw new Error(`路径越界（沙箱：${workspaceRoots().join('、')}）：${inputPath}`)
  }
  assertNoSymlinkEscape(abs, inputPath)

  // Windows 保留设备名
  const base = abs.split(/[\\/]/).pop() ?? ''
  const stem = base.split('.')[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new Error(`路径指向 Windows 保留设备名：${inputPath}`)
  }
  // NTFS 备用数据流
  if (/^[^\\/]*:[^\\/]+$/.test(base) && !/^[a-zA-Z]:$/.test(base)) {
    throw new Error('不允许访问备用数据流（ADS）：' + inputPath)
  }

  return abs
}
