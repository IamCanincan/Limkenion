/**
 * 生成斜杠命令清单（给 web 端消费）。
 *
 * 为什么需要这个：
 *   web/server/commands.mjs 原来**用正则扫描 CLI 的 commands/ 源码文本**提取
 *   name/description/aliases/argumentHint。那套做法靠"猜缩进最浅的那个 name:"，
 *   只要命令文件里别处出现一个 name 字段就会被误判 —— 真的发生过：
 *   `commands/insights.ts` 里报告分节的 `name: 'project_areas'`（缩进 4）盖过了
 *   真正的命令名 `insights`（缩进 2，在 1600 行之后），于是注册表里多了一个
 *   不存在的命令、少了一个真实命令，而且毫无报错。
 *
 * 做法：用 TypeScript 编译器 API 解析 AST，只取**默认导出对象字面量的直接属性**
 *   —— 嵌套对象天然不会被误取，也不受缩进/换行/引号风格影响。
 *
 * 产物：web/server/data/commands-manifest.json（提交进仓库，web 端不依赖 CLI 构建）。
 * 用法：node scripts/gen-command-manifest.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const ROOT = process.cwd()
const COMMANDS_DIR = join(ROOT, 'commands')
const OUT = join(ROOT, 'web', 'server', 'data', 'commands-manifest.json')

/** 清单里要保留的字段（都是 web 端展示用的静态元数据）。 */
const FIELDS = ['name', 'description', 'aliases', 'argumentHint', 'type', 'isHidden', 'supportsNonInteractive']

/** 剥掉 `as X` / `satisfies X` / `(...)` 这些包装，拿到真正的表达式。 */
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
 * 取一个属性值的字面量。
 * @returns {{value: unknown, dynamic?: boolean}}
 */
function literalValue(node) {
  const n = unwrap(node)
  if (!n) return { value: undefined }
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return { value: n.text }
  if (ts.isNumericLiteral(n)) return { value: Number(n.text) }
  if (n.kind === ts.SyntaxKind.TrueKeyword) return { value: true }
  if (n.kind === ts.SyntaxKind.FalseKeyword) return { value: false }
  if (n.kind === ts.SyntaxKind.NullKeyword) return { value: null }
  if (ts.isArrayLiteralExpression(n)) {
    const out = []
    for (const el of n.elements) {
      const v = literalValue(el)
      // 数组里只要有一个是动态的，整个字段就不可靠 —— 宁可不给，也不要给错的
      if (v.dynamic) return { value: undefined, dynamic: true }
      out.push(v.value)
    }
    return { value: out }
  }
  // 函数 / 调用 / 标识符引用等：运行时才知道，静态拿不到
  return { value: undefined, dynamic: true }
}

/** 从对象字面量里取指定字段（只认**直接**属性，嵌套对象一概不管）。 */
function pickFields(obj) {
  const out = {}
  if (!obj || !ts.isObjectLiteralExpression(obj)) return out
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ? prop.name.text
      : undefined
    if (!key || !FIELDS.includes(key)) continue
    const { value, dynamic } = literalValue(prop.initializer)
    if (dynamic) continue
    out[key] = value
  }
  return out
}

/**
 * 从一个表达式里尽力取出命令定义的对象字面量。
 *
 * 要穿透的包装（都是实际存在的写法）：
 *   `{...} satisfies Command` / `{...} as Command` / `({...})`
 *   `() => ({...})`                      —— 懒加载（`commands/login/index.ts`）
 *   `createMovedToPluginCommand({...})`  —— 工厂函数（`commands/security-review.ts`）
 */
function throughArrow(node) {
  let cur = unwrap(node)
  // 连着剥几层：() => (factory({...}) satisfies Command) 这种也有
  for (let i = 0; i < 4 && cur; i++) {
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      cur = unwrap(cur.body)
    } else if (ts.isCallExpression(cur)) {
      const argObj = cur.arguments.map(unwrap).find(a => a && ts.isObjectLiteralExpression(a))
      if (!argObj) return null
      cur = argObj
    } else {
      break
    }
  }
  return cur
}

/**
 * 找出一个文件里**所有**可能被注册为命令的对象字面量。
 *
 * CLI 侧（`commands.ts` 的 `COMMANDS()`）是手工 import 后列数组的，
 * 一个文件可以有多个导出同时被注册 —— 典型如 `commands/context/index.ts`
 * 同时导出 `context`（交互版）与 `contextNonInteractive`（非交互版），两者
 * `name` 都是 'context'，靠 `isEnabled()` 区分场景。所以这里不能只取默认导出。
 *
 * 支持的形状：
 *   export default { ... }
 *   export default () => ({ ... })        // 懒加载
 *   const cmd = { ... }; export default cmd
 *   export const cmd = { ... }            // 命名导出
 */
function findCommandObjects(sourceFile) {
  const objects = []

  for (const stmt of sourceFile.statements) {
    // export default ...
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const expr = throughArrow(stmt.expression)
      if (expr && ts.isObjectLiteralExpression(expr)) {
        objects.push(expr)
        continue
      }
      // export default cmd —— 回到变量声明找初始化器
      if (expr && ts.isIdentifier(expr)) {
        const found = findVariableInitializer(sourceFile, expr.text)
        if (found) objects.push(found)
      }
      continue
    }

    // export const cmd = { ... }
    if (ts.isVariableStatement(stmt) && stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        const expr = throughArrow(decl.initializer)
        if (expr && ts.isObjectLiteralExpression(expr)) objects.push(expr)
      }
    }
  }
  return objects
}

function findVariableInitializer(sourceFile, name) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
        const expr = throughArrow(decl.initializer)
        if (expr && ts.isObjectLiteralExpression(expr)) return expr
      }
    }
  }
  return null
}

/** 收集所有命令源文件：commands/*.ts 与 commands/<dir>/index.ts。 */
function collectFiles() {
  const files = []
  if (!existsSync(COMMANDS_DIR)) return files
  for (const entry of readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const idx = join(COMMANDS_DIR, entry.name, 'index.ts')
      if (existsSync(idx)) files.push(idx)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(join(COMMANDS_DIR, entry.name))
    }
  }
  return files.sort()
}

function main() {
  const files = collectFiles()
  const commands = []
  const dynamicFields = []
  const skippedStubs = []
  const seen = new Set()

  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file).replace(/\\/g, '/')

    // fork 时自动生成的空壳占位（Proxy noop，对应原厂 feature() gated 模块）。
    // 没有真实实现，**不该**作为命令出现在注册表里 —— 旧的正则扫描靠
    // "文件名兜底"把它们列成了 /torch、/force-snip 之类，用户点了也没用。
    // 这里显式识别并记录，既是说明，也是后续清理这些死桩的清单。
    if (src.includes('@generated stub from scan-missing-imports')) {
      skippedStubs.push(rel)
      continue
    }

    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

    // 一个文件可能有多个导出被注册成命令（见 findCommandObjects 的注释）
    for (const obj of findCommandObjects(sf)) {
      const picked = pickFields(obj)
      const name = typeof picked.name === 'string' ? picked.name : null
      if (!name) continue // 没有静态 name 的（运行时才算出名字）不进清单

      // 同名去重：交互版 / 非交互版这类一对多的，web 端展示只需要一个条目
      if (seen.has(name)) continue
      seen.add(name)

      // 记录哪些字段是动态的，便于排查"为什么 web 上没描述"
      for (const f of FIELDS) {
        if (picked[f] === undefined && obj.properties.some(p =>
          ts.isPropertyAssignment(p) && p.name && p.name.text === f)) {
          dynamicFields.push({ command: name, field: f, file: rel })
        }
      }

      commands.push({
        name,
        description: typeof picked.description === 'string' ? picked.description : '',
        aliases: Array.isArray(picked.aliases) ? picked.aliases.filter(a => typeof a === 'string') : [],
        argumentHint: typeof picked.argumentHint === 'string' ? picked.argumentHint : undefined,
        type: typeof picked.type === 'string' ? picked.type : undefined,
        source: rel,
      })
    }
  }

  // 内容哈希：web 启动时用它判断"CLI 改了命令但清单没重新生成"
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(ROOT, file).replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }

  const manifest = {
    // 清单格式版本：结构变了就 +1，web 端据此判断能不能用
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-command-manifest.mjs',
    sourceHash: hash.digest('hex').slice(0, 16),
    commandCount: commands.length,
    // 动态字段不进清单，但列出来 —— 否则"web 上描述是空的"会无从查起
    dynamicFields,
    // 被跳过的空壳占位（fork 遗留的死桩，不是真命令）。留着便于后续清理。
    skippedStubs,
    commands: commands.sort((a, b) => a.name.localeCompare(b.name)),
  }

  writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`已生成 ${relative(ROOT, OUT)}`)
  console.log(`  命令 ${commands.length} 条（扫描 ${files.length} 个文件）`)
  if (dynamicFields.length > 0) {
    console.log(`  动态字段 ${dynamicFields.length} 处（运行时才算得出，未进清单）：`)
    for (const d of dynamicFields.slice(0, 10)) console.log(`    - ${d.command}.${d.field}  (${d.file})`)
  }
  if (skippedStubs.length > 0) {
    console.log(`  跳过空壳占位 ${skippedStubs.length} 个（fork 遗留死桩，非真实命令）：`)
    for (const s of skippedStubs) console.log(`    - ${s}`)
  }
}

main()
