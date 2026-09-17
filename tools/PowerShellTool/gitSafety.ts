/**
 * Git 可通过两种途径被用于绕过沙箱：
 * 1. 裸仓库攻击：若 cwd 包含 HEAD + objects/ + refs/ 但没有有效的 .git/HEAD，
 *    Git 会把 cwd 当作裸仓库，并从 cwd 运行钩子。
 * 2. Git 内部写入 + git：复合命令先创建 HEAD/objects/refs/hooks/，
 *    再运行 git——git 子命令会执行刚创建好的恶意钩子。
 */

import { basename, posix, resolve, sep } from 'path'
import { getCwd } from '../../utils/cwd.js'
import { PS_TOKENIZER_DASH_CHARS } from '../../utils/powershell/parser.js'

/**
 * 若归一化路径以 `../<cwd-基名>/` 开头，说明它经由父目录重新进入 cwd——
 * 则将其解析为相对于 cwd 的形式。posix.normalize 会保留前导 `..`
 * （无 cwd 上下文），因此 cwd=/x/project 时 `../project/hooks` 仍是
 * `../project/hooks`，会错失对 `hooks/` 前缀的匹配，尽管它在运行时解析到
 * 的是同一个目录。检查/使用偏差：校验器看到 `../project/hooks`，
 * 而 PowerShell 相对于 cwd 解析得到 `hooks`。
 */
function resolveCwdReentry(normalized: string): string {
  if (!normalized.startsWith('../')) return normalized
  const cwdBase = basename(getCwd()).toLowerCase()
  if (!cwdBase) return normalized
  // 迭代式地剥离 `../<cwd-基名>/`（处理 `../../p/p/hooks`，尽管 cwd 含重复
  // 基名段的场景不太可能，但一层是最常见的攻击方式）。
  const prefix = '../' + cwdBase + '/'
  let s = normalized
  while (s.startsWith(prefix)) {
    s = s.slice(prefix.length)
  }
  // 也处理精确的 `../<cwd-基名>`（无尾随斜杠）
  if (s === '../' + cwdBase) return '.'
  return s
}

/**
 * 将 PS 参数文本归一化为用于 git 内部匹配的规范路径。
 * 顺序很关键：先做结构性剥离（冒号绑定参数、引号、反引号转义、提供程序
 * 前缀、驱动器相对前缀），再做 NTFS 逐组件尾随剥离（空格总是剥离；点号仅
 * 在空格剥离后不是 `./..` 时才剥离），然后 posix.normalize（解析 `..`、`.`、
 * `//`），最后转为小写。
 */
function normalizeGitPathArg(arg: string): string {
  let s = arg
  // 归一化参数前缀：破折号字符（–、—、―）和正斜杠（PS 5.1）。
  // /Path:hooks/pre-commit → 提取冒号绑定的值。（bug #28）
  if (s.length > 0 && (PS_TOKENIZER_DASH_CHARS.has(s[0]!) || s[0] === '/')) {
    const c = s.indexOf(':', 1)
    if (c > 0) s = s.slice(c + 1)
  }
  s = s.replace(/^['"]|['"]$/g, '')
  s = s.replace(/`/g, '')
  // PS 提供程序限定路径：FileSystem::hooks/pre-commit → hooks/pre-commit
  // 也处理全限定形式：Microsoft.PowerShell.Core\FileSystem::path
  s = s.replace(/^(?:[A-Za-z0-9_.]+\\){0,3}FileSystem::/i, '')
  // 驱动器相对形式 C:foo（冒号后无分隔符）在哪个驱动器上都是相对 cwd 的。
  // C:\foo（**带**分隔符）是绝对路径，**不能**匹配——负向先行断言保留它。
  s = s.replace(/^[A-Za-z]:(?![/\\])/, '')
  s = s.replace(/\\/g, '/')
  // Win32 CreateFileW 逐组件处理：迭代式剥离尾随空格，再剥离尾随点号，
  // 若结果变成 `.` 或 `..`（特殊值）则停止。
  // `.. ` → `..`，`.. .` → `..`，`...` → '' → `.`，`hooks .` → `hooks`。
  // 原本为 ''（前导斜杠切分）时保持不变（绝对路径标记）。
  s = s
    .split('/')
    .map(c => {
      if (c === '') return c
      let prev
      do {
        prev = c
        c = c.replace(/ +$/, '')
        if (c === '.' || c === '..') return c
        c = c.replace(/\.+$/, '')
      } while (c !== prev)
      return c || '.'
    })
    .join('/')
  s = posix.normalize(s)
  if (s.startsWith('./')) s = s.slice(2)
  return s.toLowerCase()
}

const GIT_INTERNAL_PREFIXES = ['head', 'objects', 'refs', 'hooks'] as const

/**
 * SECURITY: 将逃逸出 cwd（前导 `../` 或绝对路径）的归一化路径相对于实际
 * cwd 解析，然后检查它是否落回 cwd **内部**。若落入内部，则剥离 cwd 并返回
 * 相对于 cwd 的余下部分用于前缀匹配。若落在 cwd 之外则返回 null（真正的外部
 * 路径——那是 path-validation 的职责范围）。覆盖 posix.normalize 单独无法
 * 解析的 `..\<cwd-基名>\HEAD` 和 `C:\<完整-cwd>\HEAD`（它会把前导 `..`
 * 原样保留）。
 *
 * 这是裸仓库 HEAD 攻击的**唯一**防护。path-validation 的 DANGEROUS_FILES
 * 有意排除了裸 `HEAD`（对同名合法非 git 文件有误报风险），DANGEROUS_DIRECTORIES
 * 也只按段匹配 `.git`——因此 `<cwd>/HEAD` 能通过那一层。此处的 cwd 解析是关键
 * 承载逻辑；若不补加替代防护就不要移除它。
 */
function resolveEscapingPathToCwdRelative(n: string): string | null {
  const cwd = getCwd()
  // 从 posix 归一化形式重建一个平台可解析的路径。
  // `n` 使用正斜杠（normalizeGitPathArg 将 \\ 转为 /）；resolve()
  // 在 Windows 上可处理正斜杠。
  const abs = resolve(cwd, n)
  const cwdWithSep = cwd.endsWith(sep) ? cwd : cwd + sep
  // 大小写不敏感比较：normalizeGitPathArg 已将 `n` 转为小写，因此 resolve()
  // 输出中来自 `n` 的组件是小写的，而 cwd 可能是混合大小写（如 C:\Users\...）。
  // Windows 路径大小写不敏感。
  const absLower = abs.toLowerCase()
  const cwdLower = cwd.toLowerCase()
  const cwdWithSepLower = cwdWithSep.toLowerCase()
  if (absLower === cwdLower) return '.'
  if (!absLower.startsWith(cwdWithSepLower)) return null
  return abs.slice(cwdWithSep.length).replace(/\\/g, '/').toLowerCase()
}

function matchesGitInternalPrefix(n: string): boolean {
  if (n === 'head' || n === '.git') return true
  if (n.startsWith('.git/') || /^git~\d+($|\/)/.test(n)) return true
  for (const p of GIT_INTERNAL_PREFIXES) {
    if (p === 'head') continue
    if (n === p || n.startsWith(p + '/')) return true
  }
  return false
}

/**
 * 若参数（原始 PS 参数文本）解析为 cwd 中的 git 内部路径则为真。
 * 同时覆盖裸仓库路径（hooks/、refs/）和标准仓库路径
 * （.git/hooks/、.git/config）。
 */
export function isGitInternalPathPS(arg: string): boolean {
  const n = resolveCwdReentry(normalizeGitPathArg(arg))
  if (matchesGitInternalPrefix(n)) return true
  // SECURITY: resolveCwdReentry 和 posix.normalize 无法完全解析的前导 `../`
  // 或绝对路径。相对实际 cwd 解析——若结果落回 cwd 的 git 内部位置，防护仍须触发。
  if (n.startsWith('../') || n.startsWith('/') || /^[a-z]:/.test(n)) {
    const rel = resolveEscapingPathToCwdRelative(n)
    if (rel !== null && matchesGitInternalPrefix(rel)) return true
  }
  return false
}

/**
 * 若参数解析为 .git/（标准仓库元数据目录）内的路径则为真。
 * 与 isGitInternalPathPS 不同，它不匹配裸仓库风格的根级 `hooks/`、`refs/`
 * 等——那些是常见的项目目录名。
 */
export function isDotGitPathPS(arg: string): boolean {
  const n = resolveCwdReentry(normalizeGitPathArg(arg))
  if (matchesDotGitPrefix(n)) return true
  // SECURITY: 与 isGitInternalPathPS 相同的 cwd 解析——捕获会落回 cwd 的
  // `..\<cwd-基名>\.git\hooks\pre-commit`。
  if (n.startsWith('../') || n.startsWith('/') || /^[a-z]:/.test(n)) {
    const rel = resolveEscapingPathToCwdRelative(n)
    if (rel !== null && matchesDotGitPrefix(rel)) return true
  }
  return false
}

function matchesDotGitPrefix(n: string): boolean {
  if (n === '.git' || n.startsWith('.git/')) return true
  // NTFS 8.3 短名：.git 变成 GIT~1（若存在多个以 "git" 开头的点文件则可能是
  // GIT~2 等）。normalizeGitPathArg 已转小写，因此检查首组件是否为 git~N。
  return /^git~\d+($|\/)/.test(n)
}
