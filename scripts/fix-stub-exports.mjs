#!/usr/bin/env node
/**
 * Fix "@generated stub" modules that are missing named exports.
 *
 * Background: an earlier pass auto-generated placeholder modules for files that
 * were missing from this source tree. Each placeholder ends with
 *   export default stub           (a Proxy that fakes any property)
 * plus a handful of hand-listed named exports.
 *
 * The problem: ES module named exports are STATIC. A Proxy on `default` does
 * NOT provide arbitrary named exports, so any `import { foo } from './stub.js'`
 * that wasn't hand-listed resolves to `undefined`, and calling it throws
 * "foo is not a function" at runtime.
 *
 * This script:
 *   1. finds every file containing the "@generated stub" marker
 *   2. finds every named import the rest of the codebase pulls from that module
 *   3. appends the missing ones as explicit exports bound to the Proxy
 *
 * Run it after adding/restoring files, then rebuild.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve, sep } from 'node:path'

const ROOT = resolve(process.cwd())
const SKIP = new Set(['node_modules', '.git', 'dist', 'web', '.workbuddy-ai', 'scripts'])

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(ROOT)

// 1) stub modules
const stubs = files.filter(f => readFileSync(f, 'utf8').includes('@generated stub'))
if (stubs.length === 0) {
  console.log('No @generated stub files found.')
  process.exit(0)
}

// Build a lookup: module specifier (as used in imports, e.g. './assistant/index.js')
// -> absolute stub file.
const bySpec = new Map()
for (const f of stubs) {
  const rel = relative(ROOT, f).split(sep).join('/')
  const noExt = rel.replace(/\.(ts|tsx)$/, '')
  for (const spec of [noExt, `${noExt}.js`, `${noExt}.ts`, rel, `${noExt}/index.js`, `${noExt}/index.ts`]) {
    bySpec.set(spec, f)
    bySpec.set(`./${spec}`, f)
  }
}

// 2) collect named imports per stub
const wanted = new Map() // stubFile -> Set(name)
for (const f of files) {
  if (stubs.includes(f)) continue
  const src = readFileSync(f, 'utf8')
  // Two forms to scan:
  //   import { a, b } from './x.js'
  //   const { a, b } = require('./x.js')     <- also used, and equally broken
  const forms = [
    // import { a, b } from './x.js'
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
    // const { a, b } = require('./x.js')
    /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
    // const { a, b } = await import('./x.js')
    /const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const importRe of forms) {
    for (const m of src.matchAll(importRe)) {
      const names = m[1].split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(n => /^[A-Za-z_$][\w$]*$/.test(n))
      const spec = m[2]
      const base = resolve(dirname(f), spec)
      const relBase = relative(ROOT, base).split(sep).join('/')
      const stubFile = bySpec.get(relBase) ?? bySpec.get(relBase.replace(/\.(js|ts|tsx)$/, '')) ?? bySpec.get(spec) ?? bySpec.get(spec.replace(/^\.\//, ''))

      if (stubFile) {
        if (!wanted.has(stubFile)) wanted.set(stubFile, new Set())
        for (const n of names) wanted.get(stubFile).add(n)
      }
    }
  }
}

// 2b) namespace-style usage: const m = await import('./x.js'); m.foo()
//     or const m = require('./x.js'); m.foo()
// The destructuring scan above cannot see these, so map local var -> module,
// then look for `var.method(` usages.
const nsVarRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\))/g
for (const f of files) {
  if (stubs.includes(f)) continue
  const src = readFileSync(f, 'utf8')
  const varToStub = new Map()
  for (const m of src.matchAll(nsVarRe)) {
    const varName = m[1]
    const spec = m[2] ?? m[3]
    const base = resolve(dirname(f), spec)
    const relBase = relative(ROOT, base).split(sep).join('/')
    const stubFile = bySpec.get(relBase) ?? bySpec.get(relBase.replace(/\.(js|ts|tsx)$/, '')) ?? bySpec.get(spec)
    if (stubFile) varToStub.set(varName, stubFile)
  }
  for (const [varName, stubFile] of varToStub) {
    const usageRe = new RegExp(`\\b${varName}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g')
    for (const u of src.matchAll(usageRe)) {
      if (!wanted.has(stubFile)) wanted.set(stubFile, new Set())
      wanted.get(stubFile).add(u[1])
    }
  }
}

let totalAdded = 0
for (const [stubFile, names] of wanted) {
  const content = readFileSync(stubFile, 'utf8')
  const existing = new Set()
  for (const m of content.matchAll(/export\s+(?:const|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    existing.add(m[1])
  }

  const missing = [...names].filter(n => !existing.has(n))
  if (missing.length === 0) continue

  const block =
    '\n// --- auto-added by scripts/fix-stub-exports.mjs ---\n' +
    missing.map(n => `export const ${n} = stub`).join('\n') +
    '\n'

  writeFileSync(stubFile, content + block)
  console.log(`  ${relative(ROOT, stubFile)}: +${missing.length} (${missing.join(', ')})`)
  totalAdded += missing.length
}

console.log(`\nAdded ${totalAdded} named exports across ${wanted.size} stub module(s).`)
console.log('Now rebuild: node scripts/build-cli.mjs')
