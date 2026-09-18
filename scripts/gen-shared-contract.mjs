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

/** 要提取的常量：文件 → 导出的常量名 → 契约里的键 → 提取方式。 */
const TARGETS = [
  { file: 'entrypoints/sdk/coreTypes.ts', exportName: 'HOOK_EVENTS', key: 'hookEvents', kind: 'array' },
  { file: 'types/permissions.ts', exportName: 'EXTERNAL_PERMISSION_MODES', key: 'permissionModes', kind: 'array' },
  // Limkenion 自己的命名 + 旧名映射（shared/naming.ts 是唯一定义处）
  { file: 'shared/naming.ts', exportName: 'HOOK_EVENT_ALIASES', key: 'hookEventAliases', kind: 'record' },
  { file: 'shared/naming.ts', exportName: 'PERMISSION_MODE_ALIASES', key: 'permissionModeAliases', kind: 'record' },
  { file: 'shared/naming.ts', exportName: 'TOOL_NAME_ALIASES', key: 'toolNameAliases', kind: 'record' },
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
 * 找 `export const NAME = { k: 'v', ... }`，返回键值对象。
 * 键允许标识符或字符串，值必须是字符串字面量 —— 否则整段放弃。
 */
function extractStringRecord(sourceFile, exportName) {
  const init = findExportedInitializer(sourceFile, exportName)
  if (!init || !ts.isObjectLiteralExpression(init)) return null
  const out = {}
  for (const prop of init.properties) {
    if (!ts.isPropertyAssignment(prop)) return null
    const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ? prop.name.text
      : undefined
    const val = unwrap(prop.initializer)
    if (!key || !val || !ts.isStringLiteral(val)) return null
    out[key] = val.text
  }
  return out
}

/** 找 `export const NAME = <expr>` 的初始化器（剥掉 as const 一类包装）。 */
function findExportedInitializer(sourceFile, exportName) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === exportName && decl.initializer) {
        return unwrap(decl.initializer)
      }
    }
  }
  return null
}

function extractStringArray(sourceFile, exportName) {
  const init = findExportedInitializer(sourceFile, exportName)
  if (!init || !ts.isArrayLiteralExpression(init)) return null
  const out = []
  for (const el of init.elements) {
    const e = unwrap(el)
    if (!e || !ts.isStringLiteral(e)) return null
    out.push(e.text)
  }
  return out
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
    const values = t.kind === 'record'
      ? extractStringRecord(sf, t.exportName)
      : extractStringArray(sf, t.exportName)
    if (!values) {
      problems.push(
        `${t.file} 里找不到 export const ${t.exportName} = ` +
          (t.kind === 'record' ? '{字符串键值}' : '[字符串数组]'),
      )
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
    const v = contract[t.key]
    if (v == null) continue
    const n = Array.isArray(v) ? `${v.length} 项` : `${Object.keys(v).length} 个键`
    console.log(`  ${t.key}: ${n}`)
  }
}

main()
