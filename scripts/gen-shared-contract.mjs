/**
 * 生成 CLI ↔ web 的共享契约（web/server/data/cli-contract.json）。
 *
 * 为什么需要：web 端原先自己硬编码了一份钩子事件名与权限模式名，与 CLI 各写各的。
 * 双份维护的后果是**静默漂移** —— CLI 加了新事件/改了模式名，web 完全不知道，
 * 要么照旧显示旧名，要么把用户的配置判成无效。
 *
 * 做法与 gen-command-manifest.mjs 一致：用 TypeScript AST 从 CLI 源码里提取，
 * 生成 JSON 提交进仓库。web 端读它，并**校验**自己声明的子集确实在契约内 ——
 * 这样 CLI 侧一改名，web 启动就能发现。
 *
 * 用法：node scripts/gen-shared-contract.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'web', 'server', 'data')
const OUT = join(OUT_DIR, 'cli-contract.json')

/** 要提取的常量：文件 → 导出的常量名 → 契约里的键。 */
const TARGETS = [
  { file: 'entrypoints/sdk/coreTypes.ts', exportName: 'HOOK_EVENTS', key: 'hookEvents' },
  { file: 'types/permissions.ts', exportName: 'EXTERNAL_PERMISSION_MODES', key: 'permissionModes' },
]

/** 剥掉 `as const` / `as X` / `satisfies X` / `(...)`。 */
function unwrap(node) {
  let cur = node
  while (
    cur &&
    (ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isParenthesizedExpression(cur))
  ) {
    cur = cur.expression
  }
  return cur
}

/**
 * 找 `export const NAME = [ ... ]`，返回字符串字面量元素。
 * 数组里只要有一个元素不是字符串字面量就整段放弃 —— 宁可不给，也不要给错的。
 */
function extractStringArray(sourceFile, exportName) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== exportName) continue
      const init = unwrap(decl.initializer)
      if (!init || !ts.isArrayLiteralExpression(init)) continue
      const out = []
      for (const el of init.elements) {
        const e = unwrap(el)
        if (!e || !ts.isStringLiteral(e)) return null
        out.push(e.text)
      }
      return out
    }
  }
  return null
}

function main() {
  const contract = {}
  const problems = []

  for (const t of TARGETS) {
    const file = join(ROOT, t.file)
    if (!existsSync(file)) {
      problems.push(`${t.file} 不存在`)
      continue
    }
    const src = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const values = extractStringArray(sf, t.exportName)
    if (!values) {
      problems.push(`${t.file} 里找不到 export const ${t.exportName} = [字符串数组]`)
      continue
    }
    contract[t.key] = values
  }

  if (problems.length > 0) {
    // 契约是 web 端正确性的依据 —— 取不到就必须失败，不能静默产出一份残缺的
    for (const p of problems) console.error(`  ✖ ${p}`)
    throw new Error('共享契约提取失败，未写出文件')
  }

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-shared-contract.mjs',
    ...contract,
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8')

  console.log(`已生成 ${relative(ROOT, OUT)}`)
  for (const t of TARGETS) {
    if (contract[t.key]) console.log(`  ${t.key}: ${contract[t.key].length} 项`)
  }
}

main()
