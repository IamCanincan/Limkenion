/**
 * schema 漂移检查：把镜像的工具 schema 与 CLI 源码里的 inputSchema 对照。
 *
 * 为什么需要：web 端工具是「读 CLI 源码手抄」出来的，参数名很容易抄错或漏掉。
 * 之前就漏了 Grep 的 head_limit、Edit 的 replace_all，TaskStop 还写成了 taskId。
 * 这个测试直接解析 CLI 的 inputSchema（花括号深度 + 跳过字符串字面量），
 * 一旦两侧不一致就失败，把漂移挡在提交前。
 *
 * CLI 源码树缺失（全局安装在非 CLI 目录启动）时自动跳过。
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL_SCHEMAS } from '../server/tools.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI_TOOLS_DIR = join(REPO_ROOT, 'tools')
const HAS_CLI_SOURCE = existsSync(CLI_TOOLS_DIR)

/**
 * 抽取 `const inputSchema = ...(z.strictObject|z.object)({ ... })` 的顶层键。
 * 逐字符扫描：跟踪花括号深度、跳过字符串字面量，只在深度 1 且处于键位时取值。
 */
function extractInputKeys(src) {
  const m = src.match(/inputSchema\s*=\s*[\s\S]{0,200}?(?:strictObject|object)\s*\(\s*\{/)
  if (!m) return null
  let i = src.indexOf('{', m.index + m[0].length - 1)
  let depth = 0
  let expectKey = false
  const keys = []
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '{') {
      depth++
      expectKey = depth === 1
      continue
    }
    if (c === '}') {
      depth--
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    if (c === ',') {
      expectKey = true
      continue
    }
    if (/\s/.test(c)) continue
    if (expectKey) {
      const km = src.slice(i).match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/)
      if (km) {
        keys.push(km[1])
        i += km[0].length - 1
      }
      expectKey = false
    }
  }
  return [...new Set(keys)].sort()
}

/**
 * 扫 CLI tools/ 目录，得到全部工具名（不依赖 inputSchema 能否解析）。
 * 有些工具的 schema 不在 `inputSchema` 常量里，只用来做名称比对。
 */
function readCliToolNames() {
  const names = new Set()
  for (const entry of readdirSync(CLI_TOOLS_DIR)) {
    const dir = join(CLI_TOOLS_DIR, entry)
    if (!statSync(dir).isDirectory()) continue
    let src = ''
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.ts')) src += readFileSync(join(dir, f), 'utf8')
    }
    // 收集**全部** TOOL_NAME 常量，不是只取第一个。
    //
    // 原实现用 `match()` 只拿第一个匹配，于是「一个目录里定义多个工具」的情况会漏。
    // 真实案例：`ScheduleCronTool/` 下有 CronCreate / CronList / CronDelete 三个工具
    // （各自的常量在 prompt.ts 里），只取第一个就只登记了 CronCreate ——
    // 补上后两个工具时，这个测试会误报「CLI tools/ 里找不到」。
    //
    // 但**必须排除 `LEGACY_*_TOOL_NAME`**：那是向后兼容的旧连线名，不是独立工具。
    // 已确认的两处：AgentTool 的 `LEGACY_AGENT_TOOL_NAME = 'Task'`、
    // BriefTool 的 `LEGACY_BRIEF_TOOL_NAME = 'Brief'` —— 收进来会变成假的「漏镜像」。
    const named = [...src.matchAll(/(\b[A-Z_]*TOOL_NAME)\s*=\s*'([^']+)'/g)]
      .filter(m => !m[1].startsWith('LEGACY_'))
      .map(m => m[2])
    const fallback = entry.replace(/Tool$/, '')
    if (named.length > 0) {
      for (const n of named) names.add(n)
    } else if (fallback === 'MCP') {
      // MCPTool.ts 用 `name: 'mcp'` 定义工具名，不是 TOOL_NAME 常量
      names.add('mcp')
    } else {
      names.add(fallback)
    }
  }
  return names
}

/** 扫 CLI tools/ 目录，得到 工具名 → 输入参数名。 */
function readCliSchemas() {
  const out = new Map()
  for (const entry of readdirSync(CLI_TOOLS_DIR)) {
    const dir = join(CLI_TOOLS_DIR, entry)
    if (!statSync(dir).isDirectory()) continue
    let src = ''
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.ts')) src += readFileSync(join(dir, f), 'utf8')
    }
    const named = src.match(/TOOL_NAME = '([^']+)'/)
    const name = named ? named[1] : entry.replace(/Tool$/, '')
    const keys = extractInputKeys(src)
    if (keys && keys.length > 0) out.set(name, keys)
  }
  return out
}

let cli
let cliNames

before(() => {
  cli = HAS_CLI_SOURCE ? readCliSchemas() : new Map()
  cliNames = HAS_CLI_SOURCE ? readCliToolNames() : new Set()
})

describe('schema 与 CLI 源码对齐', () => {
  test('CLI 源码树可读（否则本组测试无意义）', t => {
    if (!HAS_CLI_SOURCE) {
      t.skip(`未找到 CLI tools/ 目录：${CLI_TOOLS_DIR}`)
      return
    }
    assert.ok(cli.size > 20, `只解析出 ${cli.size} 个 CLI 工具，提取器可能失效`)
  })

  test('镜像里声明为必填的参数，CLI 侧必须存在（防凭空发明参数名）', t => {
    if (!HAS_CLI_SOURCE) return t.skip('无 CLI 源码')
    const problems = []
    for (const s of TOOL_SCHEMAS) {
      const name = s.function.name
      const upstream = cli.get(name)
      if (!upstream) continue
      const declared = new Set(Object.keys(s.function.parameters.properties ?? {}))
      for (const req of s.function.parameters.required ?? []) {
        if (!declared.has(req)) problems.push(`${name}: required 里的 ${req} 未在 properties 中声明`)
        if (!upstream.includes(req)) problems.push(`${name}: 必填参数 ${req} 在 CLI 源码里找不到`)
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'))
  })

  test('已知的高风险工具：参数名与 CLI 完全一致', t => {
    if (!HAS_CLI_SOURCE) return t.skip('无 CLI 源码')
    // 这几个是之前真出过漂移的，单独锁死
    const mustMatch = [
      'Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit',
      'WebFetch', 'WebSearch', 'TodoWrite', 'TaskCreate', 'TaskGet',
      'TaskUpdate', 'TaskStop', 'Skill', 'ToolSearch', 'Config',
      'AskUserQuestion', 'SendMessage', 'CronCreate', 'TeamCreate',
    ]
    // 这些工具的 CLI 输入 schema 不在 `inputSchema` 常量里（内联或 .tsx），
    // 提取器拿不到，因此只做存在性检查。若某天能解析了，下面的断言会提醒把它移出这个集合。
    const EXTRACTOR_GAP = new Set(['AskUserQuestion'])

    const problems = []
    for (const name of mustMatch) {
      const schema = TOOL_SCHEMAS.find(s => s.function.name === name)
      const upstream = cli.get(name)
      if (!schema) {
        problems.push(`${name}: 镜像里没有这个工具`)
        continue
      }
      if (!upstream) {
        if (EXTRACTOR_GAP.has(name)) continue
        problems.push(`${name}: CLI 源码里没解析到 inputSchema`)
        continue
      }
      if (EXTRACTOR_GAP.has(name)) {
        problems.push(`${name}: 已能解析 inputSchema，请从 EXTRACTOR_GAP 中移除并启用严格比对`)
        continue
      }
      const mirrored = Object.keys(schema.function.parameters.properties ?? {}).sort()
      const missing = upstream.filter(k => !mirrored.includes(k))
      const extra = mirrored.filter(k => !upstream.includes(k))
      if (missing.length > 0) problems.push(`${name}: 镜像缺少 CLI 参数 [${missing.join(', ')}]`)
      if (extra.length > 0) problems.push(`${name}: 镜像多出 CLI 没有的参数 [${extra.join(', ')}]`)
    }
    assert.deepEqual(problems, [], `\n${problems.join('\n')}`)
  })

  test('镜像工具名都能在 CLI 找到对应实现（除 web 特有）', t => {
    if (!HAS_CLI_SOURCE) return t.skip('无 CLI 源码')
    // web 侧补充的工具；以及 CLI tools/ 下不是工具本身的目录
    const WEB_ONLY = new Set(['LS'])
    const NOT_A_TOOL = new Set(['shared', 'testing'])
    // CLI 里被 feature() 门控的可选/实验工具。
    // 真实 Bun 构建会在编译期对 feature() 求值并做死代码消除——flag 未开时
    // 这些工具根本不会进入产物，因此不要求 web 镜像。
    // 本仓库用 bun-bundle-stub 让 feature() 恒为 true（保留全部代码路径），
    // 所以静态扫描能看到它们，需在此显式豁免。
    const FEATURE_GATED = new Set([
      'CtxInspect', // feature('CONTEXT_COLLAPSE')
      'ListPeers', // feature('UDS_INBOX')
      'Monitor', // feature('MONITOR_TOOL')
      'OverflowTest', // feature('OVERFLOW_TEST_TOOL')
      'SendUserFile', // feature('KAIROS')
      'Snip', // feature('HISTORY_SNIP')
      'SubscribePR', // feature('KAIROS_GITHUB_WEBHOOKS')
      'TerminalCapture', // feature('TERMINAL_PANEL')
      'WebBrowser', // feature('WEB_BROWSER_TOOL')
      'Workflow', // feature('WORKFLOW_SCRIPTS')
      'DiscoverSkills',
      'ReviewArtifact',
      'PushNotification',
      'SuggestBackgroundPR',
      'VerifyPlanExecution',
      'Tungsten',
    ])
    const missing = TOOL_SCHEMAS
      .map(s => s.function.name)
      .filter(n => !WEB_ONLY.has(n) && !cliNames.has(n))
    assert.deepEqual(missing, [], `这些工具在 CLI tools/ 里找不到：${missing.join(', ')}`)

    // 反向：CLI 有但镜像没有（漏镜像）
    const mirrored = new Set(TOOL_SCHEMAS.map(s => s.function.name))
    const notMirrored = [...cliNames].filter(
      n => !NOT_A_TOOL.has(n) && !FEATURE_GATED.has(n) && !mirrored.has(n),
    )
    assert.deepEqual(notMirrored, [], `CLI 有这些工具但镜像里没有：${notMirrored.join(', ')}`)
  })
})
