#!/usr/bin/env node
/**
 * 从同源代码树补齐 Limkenion CLI 缺失的模块文件。
 *
 * 背景：Limkenion 的 CLI 源码树有 175 个被 import 的文件不存在，导致整个仓库
 * 无法构建（esbuild 报 2558 个错误，82% 的文件被传递拖垮）。这些文件在另一个
 * 同源项目里是完整的——两边是同一份代码的不同改名版本：
 *
 *     Limkenion 的 limkenion / Limkenion / LIMKENION   ↔   上游的 CC / CC / CC
 *     Limkenion 的 @limkenion-ai/sdk                   ↔   上游的 @上游兼容-ai/sdk
 *     Limkenion 的 LIMKENION_* 环境变量                 ↔   上游的 CC_* 与 上游_*
 *
 * 本脚本只做「补齐缺失文件」这一件事：它**不覆盖任何已存在的文件**，
 * 因此不会改动你已有的代码，也不会碰 web/ 子项目。
 *
 * 用法：
 *   # 1) 先干跑，看会补哪些文件（默认就是干跑，不写盘）
 *   node scripts/restore-missing-files.mjs --from "<同源项目>/src"
 *
 *   # 2) 确认无误后真正写入
 *   node scripts/restore-missing-files.mjs --from "<同源项目>/src" --apply
 *
 *   # 3) 指向副本试跑（推荐先用这步验证）
 *   node scripts/restore-missing-files.mjs --from "<同源项目>/src" --target /path/to/copy --apply
 *
 * 退出码：0 正常；1 参数或路径有问题。
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TARGET = resolve(HERE, '..')

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const getArg = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const FROM = getArg('--from')
const TARGET = resolve(getArg('--target') ?? DEFAULT_TARGET)
const APPLY = args.includes('--apply')

if (!FROM) {
  console.error('缺少 --from：请指向同源项目的 src 目录，例如')
  console.error('  node scripts/restore-missing-files.mjs --from "D:/下载/agent/upstream-ref-impl/src"')
  process.exit(1)
}
if (!existsSync(FROM)) {
  console.error(`--from 指向的目录不存在：${FROM}`)
  process.exit(1)
}
if (!existsSync(join(TARGET, 'main.tsx'))) {
  console.error(`--target 不像 Limkenion CLI 源码根（没找到 main.tsx）：${TARGET}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 改名映射：上游 → Limkenion
// ---------------------------------------------------------------------------

/** 顺序重要：先长后短，避免 @上游兼容-ai/sdk 被 上游_ 规则吃掉。 */
const RENAMES = [
  [/@上游兼容-ai\/sdk/g, '@limkenion-ai/sdk'],
  [/上游_/g, 'LIMKENION_'],
  [/CC_/g, 'LIMKENION_'],
  [/CCCode/g, 'Limkenion'],
  [/上游 CLI 原型/g, 'Limkenion'],
  [/CC/g, 'Limkenion'],
  [/CC/g, 'LIMKENION'],
  [/CC/g, 'limkenion'],
]

/** 把上游源码内容改写成 Limkenion 命名。 */
function rename(content) {
  let out = content
  for (const [re, to] of RENAMES) out = out.replace(re, to)
  return out
}

/** 路径也做同样的改名（目录名里含 limkenion/CC 的情况）。 */
function renamePath(p) {
  return p.replace(/limkenion/gi, 'CC')
}

/**
 * 改名之外的重命名：上游在新版本里给某些文件换了名字。
 * 这些是实测比对出来的，不是猜的。
 */
const PATH_ALIASES = [
  [/^constants\/sessionIdCompat(\.\w+)?$/, 'constants/CCCodeCompatibility$1'],
]

/** 生成上游可能的路径候选（改名 + 别名 + 原样 + 换 上游兼容 前缀）。 */
function upstreamPathCandidates(rel) {
  const out = []
  for (const [re, to] of PATH_ALIASES) {
    if (re.test(rel)) out.push(rel.replace(re, to))
  }
  out.push(renamePath(rel))
  // permissions_limkenion.txt 这类在真正上游里叫 permissions_上游兼容.txt
  out.push(rel.replace(/limkenion/gi, '上游兼容'))
  out.push(rel)
  return [...new Set(out)]
}

// ---------------------------------------------------------------------------
// 扫描 Limkenion，找出所有解析不到的 import
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.workbuddy-ai', 'web', 'scripts'])
const CANDIDATE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.txt', '.md']

function collectSourceFiles(dir, base = '', out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) collectSourceFiles(full, rel, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push({ abs: full, rel })
  }
  return out
}

/** 解析一条 import 说明符到实际文件；找不到返回 null。 */
function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const cands = [
    base,
    ...CANDIDATE_EXTS.map(e => base + e),
    ...CANDIDATE_EXTS.map(e => join(base, 'index' + e)),
    ...CANDIDATE_EXTS.map(e => stripped + e),
    ...CANDIDATE_EXTS.map(e => join(stripped, 'index' + e)),
  ]
  return cands.find(c => existsSync(c) && statSync(c).isFile()) ?? null
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g

const sources = collectSourceFiles(TARGET)
/** 缺失目标（绝对路径）→ 引用它的文件集合 */
const missing = new Map()

for (const { abs } of sources) {
  const text = readFileSync(abs, 'utf8')
  for (const m of text.matchAll(IMPORT_RE)) {
    const hit = resolveSpecifier(abs, m[1])
    if (!hit) {
      const key = resolve(dirname(abs), m[1])
      if (!missing.has(key)) missing.set(key, new Set())
      missing.get(key).add(relative(TARGET, abs))
    }
  }
}

// ---------------------------------------------------------------------------
// 为每个缺失目标在上游找对应文件
// ---------------------------------------------------------------------------

/**
 * 把缺失目标转成「相对 TARGET 的原始路径」。
 * 注意：这里**不做改名**——改名交给 upstreamPathCandidates，
 * 否则提前把 limkenion 换成 CC 后，后面 上游兼容 那条兜底就再也匹配不上了。
 */
function toUpstreamRel(absMissing) {
  return relative(TARGET, absMissing).split(sep).join('/')
}

/** 在上游找候选文件：先按改名后的路径，再按去掉 .js 后换扩展名。 */
function findUpstream(rel) {
  for (const candidate of upstreamPathCandidates(rel)) {
    const stripped = candidate.replace(/\.(js|jsx|mjs|cjs)$/, '')
    const cands = [
      candidate,
      ...CANDIDATE_EXTS.map(e => stripped + e),
      ...CANDIDATE_EXTS.map(e => join(stripped, 'index' + e)),
    ]
    const hit = cands.find(c => existsSync(join(FROM, c)) && statSync(join(FROM, c)).isFile())
    if (hit) return hit
  }
  return null
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const restorable = []
const notFound = []

for (const [absMissing, importers] of missing) {
  const upstreamRel = toUpstreamRel(absMissing)
  const found = findUpstream(upstreamRel)
  if (found) restorable.push({ absMissing, upstreamRel: found, importers: [...importers] })
  else notFound.push({ absMissing: relative(TARGET, absMissing), upstreamRel, importers: [...importers] })
}

console.log('Limkenion CLI 缺失文件补齐')
console.log('─'.repeat(60))
console.log(`  目标仓库：${TARGET}`)
console.log(`  上游源码：${FROM}`)
console.log(`  模式：    ${APPLY ? '写入（--apply）' : '干跑（不写盘）'}`)
console.log()
console.log(`  扫描源文件：      ${sources.length}`)
console.log(`  缺失的被 import： ${missing.size}`)
console.log(`  上游可补齐：      ${restorable.length}`)
console.log(`  上游也没有：      ${notFound.length}`)
console.log()

if (restorable.length > 0) {
  console.log('将要补齐（前 20 个）：')
  for (const r of restorable.slice(0, 20)) {
    console.log(`  ${relative(TARGET, r.absMissing).split(sep).join('/')}`)
    console.log(`       ← ${r.upstreamRel}   （被 ${r.importers.length} 个文件引用）`)
  }
  if (restorable.length > 20) console.log(`  … 其余 ${restorable.length - 20} 个`)
  console.log()
}

if (notFound.length > 0) {
  console.log('上游也没有（需要另找来源或改写调用方）：')
  for (const n of notFound.slice(0, 20)) console.log(`  ${n.absMissing}`)
  if (notFound.length > 20) console.log(`  … 其余 ${notFound.length - 20} 个`)
  console.log()
}

if (!APPLY) {
  console.log('这是干跑，没有写入任何文件。确认无误后加 --apply。')
  process.exit(0)
}

let written = 0
let skipped = 0
for (const r of restorable) {
  if (existsSync(r.absMissing)) {
    // 只补缺失，绝不覆盖已存在的文件
    skipped++
    continue
  }
  const content = rename(readFileSync(join(FROM, r.upstreamRel), 'utf8'))
  mkdirSync(dirname(r.absMissing), { recursive: true })
  writeFileSync(r.absMissing, content, 'utf8')
  written++
}

console.log(`已写入 ${written} 个文件，跳过 ${skipped} 个（已存在）。`)
console.log('提示：补齐只解决「文件不存在」，依赖清单 / tsconfig / Bun 运行时是另外的问题。')
