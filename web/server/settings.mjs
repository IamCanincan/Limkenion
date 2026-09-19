/**
 * 读取 Limkenion 的设置文件（与 CLI 用的是同一套文件）。
 *
 * **为什么需要这个模块**：web 端原先**完全不读设置文件** —— 用户在
 * `~/.limkenion/settings.json` 里配的权限规则、默认权限模式，在 web 端一律不生效。
 * CLI 那边 `Bash(npm run test:*)` 预授权之后就不再弹确认，web 却每次都弹；
 * 更糟的是 `permissions.deny` 本该是硬拦截，web 会照常放行。
 *
 * 支持的部分（与 CLI 的 `utils/settings/types.ts` 对齐）：
 *   permissions.deny     硬拦截，不弹确认
 *   permissions.ask      强制确认（即使工具本身不危险）
 *   permissions.allow    免确认
 *   permissions.defaultMode                  新会话的默认权限模式
 *   permissions.disableBypassPermissionsMode 禁掉 bypassPermissions
 *   permissions.additionalDirectories        额外可访问目录（沙箱根之外）
 *   hooks                                    工具前后钩子（见 hooks.mjs）
 *   mcpServers                               MCP 服务器（见 mcp.mjs）
 *
 * 规则语法与 CLI 一致：`Tool` 或 `Tool(specifier)`。
 *   - 裸工具名（如 `Bash`）→ 匹配该工具的任何调用
 *   - Bash / PowerShell 的 specifier → `npm run:*)` 前缀匹配、`npm run *` 通配、否则精确匹配
 *   - 文件类工具的 specifier → 对 file_path 做 glob（`*` 不跨目录、`**` 跨目录）
 *   - 其他工具：支持**显式的 `key:pattern`**（如 `WebFetch(url:https://a/**)`）——
 *     由用户指明匹配哪个输入字段，语义确定；`*` 会跨越 `/`（便于 URL / 正则 / 片段）。
 *   - 其他工具的**裸** specifier → 依旧**不做猜测匹配**，记进 `unhonored` 供上层提示 ——
 *     宁可明说"这条规则在 web 端不生效"，也不要给用户一个假的保护感。
 *
 * **项目级设置固定从「进程默认根」读，不跟着会话的 worktree 漂移。**
 * 这是刻意的安全选择：会话进入某个 git worktree 之后，如果项目级设置改成从新根读，
 * 而新根里没有 `.limkenion/settings.json`（git worktree 只检出受版本控制的文件），
 * 用户配的 `permissions.deny` 就会**静默失效** —— 那是"以为挡住了、其实没挡"。
 * 策略不随 worktree 变化，越权面才可预测。
 *
 * 没实现的（如实记录，不要以为有）：
 *   hooks 的 prompt / agent / http 三种执行方式，以及 web 未接线的钩子事件
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve, dirname } from 'node:path'
import { globToRegExp, toPosix, DEFAULT_WORKSPACE_ROOT, workspaceRoot } from './paths.mjs'
import { canonicalToolName } from './clicontract.mjs'

/** 文件类工具：specifier 按 glob 匹配 file_path（与 CLI 的 filePatternTools 对齐）。 */
const FILE_PATTERN_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'NotebookRead', 'NotebookEdit'])

/** 命令类工具：specifier 按命令前缀 / 通配匹配（CLI 的 bashPrefixTools 是 ['Bash']，这里加上 PowerShell）。 */
const BASH_PREFIX_TOOLS = new Set(['Bash', 'PowerShell'])

/** 这些键会按 specifier 做匹配，取哪个字段。 */
const PATH_INPUT_KEYS = ['file_path', 'notebook_path', 'path']

/**
 * 设置文件的位置。顺序即优先级（后面的覆盖前面的标量键；数组一律取并集）。
 * 与 CLI 的 userSettings / projectSettings / localSettings 对应。
 *
 * 项目级/本地级固定在**进程默认根**下（见文件头"为什么"）—— 不随会话的 worktree 变。
 */
export function settingsFilePaths() {
  const configDir = process.env.LIMKENION_CONFIG_DIR ?? join(homedir(), '.limkenion')
  const root = DEFAULT_WORKSPACE_ROOT
  return [
    { source: 'user', path: join(configDir, 'settings.json') },
    { source: 'project', path: join(root, '.limkenion', 'settings.json') },
    { source: 'local', path: join(root, '.limkenion', 'settings.local.json') },
  ]
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    // 设置文件坏了不该让服务起不来，但要说出来
    console.warn(`设置文件解析失败，已忽略（${path}）：`, String(err))
    return null
  }
}

/**
 * 解析一条规则字符串。
 * @returns {{tool: string, specifier: string|null}|null}
 */
export function parseRule(rule) {
  const s = String(rule ?? '').trim()
  if (!s) return null
  const m = s.match(/^([A-Za-z_][\w-]*)\s*\((.*)\)$/)
  if (!m) return { tool: s, specifier: null }
  return { tool: m[1], specifier: m[2] }
}

/** 命令类匹配：`npm run:*` 前缀、`npm run *` 通配、否则精确。 */
function matchCommandSpecifier(specifier, command) {
  const cmd = String(command ?? '').trim()
  if (!cmd) return false
  if (specifier.endsWith(':*')) {
    const prefix = specifier.slice(0, -2).trim()
    return cmd === prefix || cmd.startsWith(prefix + ' ')
  }
  if (specifier.includes('*') || specifier.includes('?')) {
    return globToRegExp(specifier).test(cmd)
  }
  return cmd === specifier.trim()
}

/**
 * 文件类匹配：对 file_path 做 glob；支持 `//abs/path`（绝对路径）写法。
 *
 * 相对路径的候选**对每个沙箱根各算一份**（会话根可能是某个 worktree，也可能有额外
 * 可访问目录），任意一份命中就算命中。刻意往"更容易命中"的方向偏：
 * `deny`/`ask` 漏判是安全问题（以为挡住了其实没挡），误判只是多弹一次确认。
 */
function matchFileSpecifier(specifier, input) {
  const raw = PATH_INPUT_KEYS.map(k => input?.[k]).find(v => typeof v === 'string' && v.length > 0)
  if (!raw) return false
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot(), raw)
  const posixAbs = toPosix(abs)

  let pattern = specifier.trim()
  // CLI 用 `//` 前缀表示绝对路径（见 permissionValidation 的说明）
  if (pattern.startsWith('//')) {
    return globToRegExp(toPosix(pattern.slice(1))).test(posixAbs)
  }
  pattern = toPosix(pattern.replace(/^\.\//, ''))
  const re = globToRegExp(pattern)
  const rel = globToRegExp('**/' + pattern)
  for (const root of new Set([workspaceRoot(), DEFAULT_WORKSPACE_ROOT])) {
    const relPath = toPosix(abs.slice(resolve(root).length).replace(/^[\\/]/, ''))
    if (re.test(relPath) || rel.test(relPath)) return true
  }
  return false
}

/**
 * 判断一条规则是否匹配这次工具调用。
 * @returns {'match'|'no-match'|'unsupported'}
 *   `unsupported` = 这条规则带了 specifier，但该工具的 specifier 语义 web 端没实现 ——
 *   不能当成"不匹配"就完事，要显式告诉用户它没生效。
 */
export function matchRule(rule, toolName, input) {
  const parsed = parseRule(rule)
  if (!parsed) return 'no-match'
  // **两边都要归一化**：规则里写的名字和调用时的名字可能一个是 CLI 契约里的旧名
  // （EnterPlanMode / ExitPlanMode），一个是 web 内部的规范名（PlanEnter / PlanExit）。
  // 不做归一化的话，用户照着 CLI 文档写一条 deny 规则会**静默不生效** ——
  // 那就是「以为挡住了其实没挡」，比不写还危险。
  const ruleTool = canonicalToolName(parsed.tool)
  const callTool = canonicalToolName(toolName)
  if (ruleTool !== callTool) return 'no-match'
  if (parsed.specifier === null) return 'match'

  // 命令类 / 文件类的裸 specifier 语义是确定的，优先按老行为处理。
  // 注意顺序：这也避免把 `Edit(C:\foo\*)` 这类 Windows 路径误读成 key 形式。
  if (BASH_PREFIX_TOOLS.has(callTool)) {
    return matchCommandSpecifier(parsed.specifier, input?.command) ? 'match' : 'no-match'
  }
  if (FILE_PATTERN_TOOLS.has(callTool)) {
    return matchFileSpecifier(parsed.specifier, input) ? 'match' : 'no-match'
  }
  // 其它工具：只认**显式的 key:pattern**；裸 specifier 依旧不猜（见 matchKeySpecifier 注释）。
  if (isKeySpecifier(parsed.specifier)) {
    return matchKeySpecifier(parsed.specifier, input) ? 'match' : 'no-match'
  }
  return 'unsupported'
}

/** 是否是显式 key 形式（`key:pattern`）。key 必须是合法标识符。 */
function isKeySpecifier(specifier) {
  return /^[A-Za-z_][\w]*\s*:/.test(String(specifier ?? '').trim())
}

/**
 * 显式 key 形式的匹配：`Tool(key:pattern)`，例如
 *   `WebFetch(url:https://example.com/**)`、`Grep(pattern:TODO*)`
 *
 * 为什么只对它开放、而不去猜裸 specifier 的语义：裸写法该匹配哪个输入字段只能靠猜，
 * 猜错的代价是 `deny` 规则给人**假的保护感**（以为挡住了其实没挡）—— 那比不生效
 * 更危险。让用户显式写出 key，语义才是确定的；猜不出来依旧返回 `unsupported` 让上层提示。
 *
 * 通配规则（与文件路径那套刻意区分）：`*` 匹配任意字符**含 /**，`?` 匹配单个字符。
 * 因为这里常见的值是 URL / 正则 / 命令片段，`*` 不跨 `/` 会很反直觉。
 *
 * @param {string} specifier
 * @param {Record<string, any>} input
 * @returns {boolean}
 */
function matchKeySpecifier(specifier, input) {
  const m = String(specifier ?? '')
    .trim()
    .match(/^([A-Za-z_][\w]*)\s*:([\s\S]*)$/)
  if (!m) return false
  const key = m[1]
  const pattern = String(m[2] ?? '').trim()
  const value = input?.[key]
  if (typeof value !== 'string' || value.length === 0) return false
  return wildcardToRegExp(pattern).test(value)
}

/** `*` → `.*`、`?` → `.`，其余按字面量转义（`*` 会跨越 `/`）。 */
function wildcardToRegExp(pattern) {
  let out = ''
  for (const ch of String(pattern)) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

// ---------------------------------------------------------------------------
// 加载与缓存
// ---------------------------------------------------------------------------

/**
 * 读取各来源设置文件的内容（**每次都重新读盘**，3 个小文件，代价可忽略）。
 *
 * 各功能模块（hooks / mcpServers / additionalDirectories）都用它取自己的键，
 * 避免各自再写一遍"去哪几个文件找"的逻辑 —— 路径只有 settingsFilePaths() 一处定义。
 * @returns {{source: string, path: string, data: object|null}[]}
 */
export function settingsSources() {
  return settingsFilePaths().map(f => ({ ...f, data: readJson(f.path) }))
}

let cache = null

/** 合并各来源的权限配置（数组取并集，标量后者覆盖前者）。 */
function mergePermissions(files) {
  const allow = []
  const deny = []
  const ask = []
  const additionalDirs = []
  let defaultMode = null
  let bypassDisabled = false
  const sources = []

  for (const { source, path } of files) {
    const data = readJson(path)
    if (!data) continue
    sources.push(source)
    const p = data.permissions
    if (!p || typeof p !== 'object') continue
    // 标成元组：否则被推成 `(string|any[])[][]`，`p[key]` 会报「any[] 不能当索引类型」，
    // `bucket.push` 会报「string 上没有 push」——而这段代码本身是对的。
    const buckets = /** @type {Array<[string, string[]]>} */ ([
      ['allow', allow],
      ['deny', deny],
      ['ask', ask],
    ])
    for (const [key, bucket] of buckets) {
      if (Array.isArray(p[key])) {
        for (const r of p[key]) if (typeof r === 'string' && r.trim()) bucket.push(r.trim())
      }
    }
    if (Array.isArray(p.additionalDirectories)) {
      for (const d of p.additionalDirectories) {
        if (typeof d === 'string' && d.trim()) additionalDirs.push(d.trim())
      }
    }
    if (typeof p.defaultMode === 'string') defaultMode = p.defaultMode
    if (p.disableBypassPermissionsMode === 'disable') bypassDisabled = true
  }

  return {
    allow: [...new Set(allow)],
    deny: [...new Set(deny)],
    ask: [...new Set(ask)],
    additionalDirectories: [...new Set(additionalDirs)],
    defaultMode,
    bypassDisabled,
    sources,
  }
}

/**
 * `permissions.additionalDirectories` —— 额外可访问目录（沙箱根之外）。
 *
 * 相对路径按**进程默认根**解析（与项目级设置文件的位置一致，便于写
 * `.limkenion/settings.json` 时用 `"../other-repo"` 这种相对写法）。
 * 不存在的目录会被过滤掉：把不存在的路径塞进沙箱只会在排错时误导人。
 */
export function additionalDirectories() {
  const list = getSettings().permissions.additionalDirectories ?? []
  const out = []
  for (const item of list) {
    const abs = isAbsolute(item) ? resolve(item) : resolve(DEFAULT_WORKSPACE_ROOT, item)
    if (!existsSync(abs)) continue
    if (!out.includes(abs)) out.push(abs)
  }
  return out
}

/**
 * 读取并缓存设置。启动时调一次；`/reload-settings` 可重读。
 */
export function loadSettings() {
  const files = settingsFilePaths()
  const permissions = mergePermissions(files)
  cache = {
    permissions,
    files: files.map(f => ({ ...f, exists: existsSync(f.path) })),
  }
  return cache
}

/** 取缓存（未加载过则先加载）。 */
export function getSettings() {
  return cache ?? loadSettings()
}

/**
 * 改写某个作用域的设置文件（MCP 图形化管理要用）。
 *
 * `mutate` 收到该文件的当前内容（不存在时是空对象），返回新内容。
 * 写完**立即重读缓存** —— 权限等键也可能在同一个文件里，留着旧缓存
 * 会出现"界面上改了、实际还在用旧值"这种最难查的不一致。
 *
 * @param {'user'|'project'|'local'} source
 * @param {(data: Record<string, any>) => Record<string, any>} mutate
 * @returns {Record<string, any>}
 */
export function writeSettingsScope(source, mutate) {
  const entry = settingsFilePaths().find(f => f.source === source)
  if (!entry) throw new Error(`未知设置作用域：${source}`)
  const current = readJson(entry.path) ?? {}
  const next = mutate(current) ?? current
  mkdirSync(dirname(entry.path), { recursive: true })
  writeFileSync(entry.path, `${JSON.stringify(next, null, 1)}\n`, 'utf8')
  loadSettings()
  return next
}

/** 设置文件状态摘要，供 `/permissions` 与 `/status` 展示。 */
export function settingsSummary() {
  const s = getSettings()
  const present = s.files.filter(f => f.exists)
  if (present.length === 0) {
    return '未找到设置文件（web 端会读取与 CLI 相同的路径）'
  }
  const p = s.permissions
  return (
    `设置文件：${present.map(f => `${f.source}(${f.path})`).join('、')}\n` +
    `权限规则：allow ${p.allow.length} 条、deny ${p.deny.length} 条、ask ${p.ask.length} 条` +
    (p.defaultMode ? `；默认模式 ${p.defaultMode}` : '') +
    (p.bypassDisabled ? '；已禁用 bypassPermissions' : '') +
    (p.additionalDirectories?.length
      ? `；额外可访问目录 ${p.additionalDirectories.length} 个（生效 ${additionalDirectories().length} 个）`
      : '')
  )
}

/**
 * 硬拦截判定：命中 `permissions.deny` 的规则。
 * @returns {string|null} 拦截理由
 */
export function deniedBy(toolName, input) {
  for (const rule of getSettings().permissions.deny) {
    if (matchRule(rule, toolName, input) === 'match') {
      return `工具 ${toolName} 被设置文件里的权限规则拒绝：${rule}`
    }
  }
  return null
}

/**
 * 规则判定：`ask` 优先于 `allow`（更保守的一侧赢）。
 * @returns {'ask'|'allow'|null}
 */
export function ruleDecision(toolName, input) {
  const p = getSettings().permissions
  for (const rule of p.ask) {
    if (matchRule(rule, toolName, input) === 'match') return 'ask'
  }
  for (const rule of p.allow) {
    if (matchRule(rule, toolName, input) === 'match') return 'allow'
  }
  return null
}

/** 新会话的默认权限模式（设置文件里的 `permissions.defaultMode`）。 */
export function defaultPermissionMode() {
  return getSettings().permissions.defaultMode
}

/** 是否禁用了 bypassPermissions。 */
export function bypassDisabled() {
  return getSettings().permissions.bypassDisabled
}

/**
 * 列出**在 web 端不会生效**的规则（带 specifier 但语义未实现）。
 * 上层要把这个明说给用户 —— 不能让 `deny` 规则给人假的保护感。
 */
export function unhonoredRules() {
  const p = getSettings().permissions
  const out = []
  for (const [kind, rules] of [['deny', p.deny], ['ask', p.ask], ['allow', p.allow]]) {
    for (const rule of rules) {
      const parsed = parseRule(rule)
      if (!parsed?.specifier) continue
      if (BASH_PREFIX_TOOLS.has(parsed.tool) || FILE_PATTERN_TOOLS.has(parsed.tool)) continue
      // 显式 key 形式（key:pattern）已经支持，不算"未生效"
      if (isKeySpecifier(parsed.specifier)) continue
      out.push({ kind, rule, tool: parsed.tool })
    }
  }
  return out
}
