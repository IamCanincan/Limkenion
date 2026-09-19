/**
 * 服务端 agent 工具集 —— CLI 工具（tools/ 目录）的 web 镜像实现。
 *
 * 覆盖 CLI tools/ 目录下的全部工具，名称与输入 schema 对齐：
 *   文件类   Read / Write / Edit / NotebookEdit / Glob / Grep / LS
 *   执行类   Bash / PowerShell / REPL
 *   网络类   WebFetch / WebSearch
 *   协作类   Agent / TeamCreate / TeamDelete / SendMessage / SendUserMessage
 *   任务类   TodoWrite / TaskCreate / TaskGet / TaskList / TaskUpdate / TaskStop / TaskOutput
 *   流程类   PlanEnter / PlanExit / AskUserQuestion / Sleep / CronCreate
 *            / EnterWorktree / ExitWorktree
 *   配置类   Config / Skill / ToolSearch / StructuredOutput
 *   MCP 类    mcp / ListMcpResourcesTool / ReadMcpResource / McpAuth / McpPrompt / McpRegistrySearch
 *
 * 所有文件工具都限制在**会话的沙箱根**内（可以随 EnterWorktree 变化，见 paths.mjs）。
 * 默认根：LIMKENION_WEB_WORKSPACE（默认 CLI 源码根目录）。
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { execFile, execSync, spawn } from 'node:child_process'
import { recordCheckpoint, snapshotWorkspace, commandLikelyMutating } from './checkpoints.mjs'
import { screenshot as computerScreenshot, control as computerControl, computerAvailable } from './computer.mjs'
import { HOOK_EVENT, runEventHooks } from './hooks.mjs'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import vm from 'node:vm'
import {
  CLI_ROOT,
  globToRegExp,
  relToWorkspace as rel,
  safePath,
  toPosix,
  workspaceRoot,
} from './paths.mjs'
import { collectFiles, invalidateFileIndex } from './workspace.mjs'
import { MAX_DIFF_CHARS } from './config.mjs'
import { canonicalToolName } from './clicontract.mjs'
import { markUntrusted, wrapUntrusted } from './security.mjs'
import { enterWorktree, exitWorktree } from './worktree.mjs'

export { CLI_ROOT, safePath, workspaceRoot }

/**
 * 需要用户确认的危险工具：会改动磁盘、执行外部进程、或排定后续自动回合。
 * Agent 单独处理——它自身不写盘，但会把危险工具调用冒泡给外层权限确认。
 */
export const DANGEROUS_TOOLS = new Set([
  'Bash',
  'PowerShell',
  'REPL',
  'Write',
  'Edit',
  'NotebookEdit',
  'CronCreate',
  // 取消定时任务会改变后续自动回合的行为，与 CronCreate 同等对待。
  'CronDelete',
  // Computer Use：能操作用户整个桌面，是权限等级最高的工具，每次都要确认。
  'ComputerScreenshot',
  'ComputerControl',
  // worktree 改的是**会话的沙箱根**（不只是 cwd）：一次授权会把之后所有文件工具的
  // 作用范围换到另一棵树上，属于安全边界改变，所以要确认。
  'EnterWorktree',
  'ExitWorktree',
  // 一次工作流能派几十个子代理、烧掉大量 token（CLI 也是这个理由要确认）
  'Workflow',
])

/** 子代理只读工具白名单（Agent 工具内部使用）。 */
/**
 * 子代理可用的只读工具。导出是为了让"具名子代理"配置在校验时能确认：
 * 配出来的工具集只能是这个集合的**子集** —— 不给子代理任何越权的可能。
 */
export const SUBAGENT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Sleep'])

/**
 * 常驻工具：每轮都会把 schema 发给模型。其余工具进入「延迟加载」，
 * 由 ToolSearch 按需启用，避免 41 份 schema 每轮全量重发。
 */
export const CORE_TOOL_NAMES = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'LS',
  'TodoWrite', 'TaskCreate', 'TaskList', 'TaskUpdate',
  'WebFetch', 'WebSearch', 'Agent', 'AskUserQuestion',
  'PlanEnter', 'PlanExit', 'Skill', 'ToolSearch', 'Config',
])

// ---------------------------------------------------------------------------
// 沙箱与通用工具函数
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 512 * 1024
const MAX_OUTPUT_CHARS = 20_000
const BASH_TIMEOUT_MS = 30_000
const MAX_SLEEP_MS = 300_000

/**
 * 截断长文本：保留头部与尾部。
 * 命令输出、报错、总结通常都在尾部，只留头部会让模型看不到失败原因。
 */
function truncate(text, limit = MAX_OUTPUT_CHARS) {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.35)
  const tail = limit - head
  const omitted = text.length - limit
  return (
    text.slice(0, head) +
    `\n\n…（中间省略 ${omitted} 字符，全文 ${text.length} 字符）…\n\n` +
    text.slice(text.length - tail)
  )
}

/**
 * 必填字符串参数的校验。
 *
 * **每个工具都要自己校验一遍**，这不是形式主义：模型忘参数是常态（尤其第一轮），
 * 而漏校验的后果不止"少一句报错"：
 *   - `Bash` / `PowerShell` 会把 `undefined` 当命令**真的去执行**，回来一串
 *     "undefined 不是内部或外部命令"，模型得再花一轮才反应过来；
 *   - `TodoWrite` 会先把 `session.todos` 写坏（变成 undefined）再抛错，状态被污染；
 *   - `SendMessage` 会回一句"已记录消息 → ："，让模型**以为成功了**；
 *   - `Glob` / `TodoWrite` 直接抛 `TypeError: Cannot read properties of undefined`
 *     —— 这种原始 JS 异常对模型完全没有可操作性。
 * 宁可抛一句能照着改的错。
 */
function requireText(value, label, hint) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少 ${label} 参数${hint ? `：${hint}` : ''}`)
  }
  return value
}

/** diff 体积上限：超大 diff 只保留摘要，避免撑爆 WS 帧与会话内存。 */function capDiff(diff) {
  if (diff.length <= MAX_DIFF_CHARS) return diff
  return (
    diff.slice(0, MAX_DIFF_CHARS) +
    `\n…（diff 已截断，完整长度 ${diff.length} 字符）`
  )
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// 统一 diff（供前端渲染 Edit/Write 改动）
// ---------------------------------------------------------------------------

/** LCS 行级差异；超大规模退化为「全删 + 全增」避免卡死。 */
function diffOps(a, b) {
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    return [...a.map(l => ({ type: 'del', line: l })), ...b.map(l => ({ type: 'add', line: l }))]
  }
  // dp[i][j] = LCS 长度
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i++] })
    } else {
      ops.push({ type: 'add', line: b[j++] })
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] })
  while (j < m) ops.push({ type: 'add', line: b[j++] })
  return ops
}

/** 生成 unified diff 文本（带上下文折叠）。 */
function unifiedDiff(oldText, newText, fileRel, context = 3) {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const ops = diffOps(a, b)

  // 标记需要输出的行：改动行 ± context
  const keep = new Array(ops.length).fill(false)
  ops.forEach((op, idx) => {
    if (op.type === 'eq') return
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep[k] = true
  })

  const lines = [`--- ${oldText === '' ? '/dev/null' : 'a/' + fileRel}`, `+++ b/${fileRel}`]
  let oldNo = 1
  let newNo = 1
  let idx = 0
  let skipped = false
  while (idx < ops.length) {
    if (!keep[idx]) {
      skipped = true
      if (ops[idx].type !== 'add') oldNo++
      if (ops[idx].type !== 'del') newNo++
      idx++
      continue
    }
    // 找连续输出块
    const start = idx
    let oldStart = oldNo
    let newStart = newNo
    const body = []
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx]
      if (op.type === 'eq') {
        body.push(' ' + op.line)
        oldNo++
        newNo++
      } else if (op.type === 'del') {
        body.push('-' + op.line)
        oldNo++
      } else {
        body.push('+' + op.line)
        newNo++
      }
      idx++
    }
    lines.push(`@@ -${oldStart},${oldNo - oldStart} +${newStart},${newNo - newStart} @@`)
    if (skipped && start > 0) lines.push(' …')
    lines.push(...body)
    skipped = false
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 文件类工具
// ---------------------------------------------------------------------------

async function toolRead({ file_path, offset, limit, pages }) {
  const p = safePath(file_path)
  if (/\.[pP][dD][fF]$/.test(p)) {
    throw new Error('暂不支持直接读取 PDF（CLI 的 Read 走 pdf 提取器）；请先用 Bash 转换或改读文本文件。')
  }
  const content = await readFile(p, 'utf8')
  const lines = content.split('\n')
  const start = Math.max(0, (offset ?? 1) - 1)
  const end = limit !== undefined ? start + limit : lines.length
  const slice = lines.slice(start, end)
  const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5)}\t${l}`).join('\n')
  const pageNote = pages ? `（pages=${pages} 仅对 PDF 生效，文本文件忽略）` : ''
  return truncate(`文件：${rel(p)}（${lines.length} 行）${pageNote}\n\n${numbered}`)
}

async function toolWrite(input, session) {
  const { file_path, content } = input ?? {}
  const p = safePath(file_path)
  const existed = existsSync(p)
  const before = existed ? await readFile(p, 'utf8') : ''
  // 检查点：写入前快照旧内容（文件当时不存在则记 null，回滚时删除）
  recordCheckpoint(session, p, existed ? before : null)
  // 父目录不存在时自动创建（否则模型无法在新目录下建文件）
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, content, 'utf8')
  invalidateFileIndex()
  return {
    text: `已${existed ? '覆盖' : '创建'} ${rel(p)}（${content.length} 字符）`,
    diff: capDiff(unifiedDiff(before, content, rel(p))),
  }
}

async function toolEdit(input, session) {
  const { file_path, old_string, new_string, replace_all } = input ?? {}
  const p = safePath(file_path)
  const content = await readFile(p, 'utf8')
  if (!content.includes(old_string)) {
    throw new Error('old_string 未在文件中找到（要求精确匹配）')
  }
  // 检查点：编辑前快照整个文件
  recordCheckpoint(session, p, content)
  const occurrences = content.split(old_string).length - 1
  if (occurrences > 1 && !replace_all) {
    throw new Error(`old_string 出现 ${occurrences} 次，不唯一；请提供更多上下文，或传 replace_all: true 全部替换`)
  }
  const next = replace_all
    ? content.split(old_string).join(new_string)
    : content.replace(old_string, new_string)
  await writeFile(p, next, 'utf8')
  invalidateFileIndex()
  return {
    text: `已替换 ${rel(p)} 中的 ${replace_all ? occurrences : 1} 处匹配`,
    diff: capDiff(unifiedDiff(content, next, rel(p))),
  }
}

/** NotebookEdit：按 cell 编辑 .ipynb（CLI NotebookEditTool 的 web 镜像）。 */
async function toolNotebookEdit({ notebook_path, cell_id, new_source, cell_type = 'code', edit_mode = 'replace' }) {
  const p = safePath(notebook_path)
  const raw = await readFile(p, 'utf8')
  let nb
  try {
    nb = JSON.parse(raw)
  } catch (e) {
    throw new Error(`不是合法的 .ipynb JSON：${e.message}`)
  }
  if (!Array.isArray(nb.cells)) throw new Error('notebook 缺少 cells 数组')

  const source = String(new_source ?? '').split('\n').map((l, i, arr) => (i === arr.length - 1 ? l : l + '\n'))
  const matchIndex = cell_id ? nb.cells.findIndex(c => c.id === cell_id) : -1

  if (edit_mode === 'delete') {
    if (matchIndex < 0) throw new Error(`找不到 cell：${cell_id}`)
    nb.cells.splice(matchIndex, 1)
  } else if (edit_mode === 'insert') {
    const cell = { cell_type, metadata: {}, source, ...(cell_type === 'code' ? { outputs: [], execution_count: null } : {}) }
    const at = matchIndex >= 0 ? matchIndex + 1 : nb.cells.length
    nb.cells.splice(at, 0, cell)
  } else {
    if (matchIndex < 0) throw new Error(`edit_mode=replace 需要存在的 cell_id（收到：${cell_id ?? '未提供'}）`)
    nb.cells[matchIndex] = { ...nb.cells[matchIndex], cell_type, source }
  }

  const after = JSON.stringify(nb, null, 1) + '\n'
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, after, 'utf8')
  invalidateFileIndex()
  return {
    text: `已更新 ${rel(p)}（${edit_mode}，共 ${nb.cells.length} 个 cell）`,
    diff: capDiff(unifiedDiff(raw, after, rel(p))),
  }
}

async function toolLS({ path }) {
  const base = safePath(path ?? '.')
  const entries = await readdir(base, { withFileTypes: true })
  const lines = entries
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
  return `${rel(base) || '.'} 下 ${lines.length} 项：\n${lines.join('\n')}`
}

/**
 * Grep —— 带 ReDoS 防护的正则搜索。
 *
 * 模型给的正则不可信：灾难性回溯会把单线程事件循环彻底卡死。三层防护：
 *   1. 长度上限 + 嵌套量词启发式预检（`(a+)+`、`(.*)*` 这类直接拒绝）；
 *   2. 匹配过程放进 node:vm 并在 3 秒后强制中断（超时抛 ERR_SCRIPT_EXECUTION_TIMEOUT）；
 *   3. 读取阶段有文件大小与总行数预算，避免为搜索吃掉整个工作区。
 */
const MAX_PATTERN_LEN = 200
const GREP_TIMEOUT_MS = 3000
const GREP_MAX_HITS = 50
const GREP_LINE_BUDGET = 200_000

/** 嵌套/相邻重叠量词：典型灾难性回溯写法。 */
const CATASTROPHIC = [
  /\([^)]*[+*][^)]*\)\s*[+*]/,
  /\([^)]*\{\d+,\d*\}[^)]*\)\s*[+*{]/,
  /[+*?]\s*\)\s*[+*]/,
  /(\[\^?[^\]]*\]\s*[+*]){2,}/,
]

function validatePattern(pattern) {
  const p = String(pattern ?? '')
  if (p.length === 0) throw new Error('pattern 不能为空')
  if (p.length > MAX_PATTERN_LEN) {
    throw new Error(`正则过长（${p.length} > ${MAX_PATTERN_LEN} 字符），请缩小匹配范围`)
  }
  if (CATASTROPHIC.some(re => re.test(p))) {
    throw new Error(`正则含嵌套量词，可能触发灾难性回溯，请改写：${p}`)
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(p)
  } catch (e) {
    throw new Error(`正则无效：${e.message}`)
  }
  return p
}

/** 在 vm 沙箱里跑匹配，超时由 V8 中断（可打断回溯）。 */
function matchWithTimeout(pattern, fileLines, { multiline = false } = {}) {
  const script = new vm.Script(`
    (() => {
      const re = new RegExp(PATTERN, MULTILINE ? 's' : '');
      const out = [];
      for (let fi = 0; fi < FILES.length; fi++) {
        const lines = FILES[fi];
        for (let li = 0; li < lines.length; li++) {
          if (re.test(lines[li])) {
            out.push([fi, li]);
            if (out.length >= MAX_HITS) return out;
          }
        }
      }
      return out;
    })()
  `)
  const sandbox = vm.createContext({
    PATTERN: pattern,
    FILES: fileLines,
    MAX_HITS: GREP_MAX_HITS,
    MULTILINE: multiline,
  })
  try {
    return script.runInContext(sandbox, { timeout: GREP_TIMEOUT_MS })
  } catch (e) {
    if (String(e?.code ?? '').includes('TIMEOUT')) {
      throw new Error(`正则执行超时（${GREP_TIMEOUT_MS}ms），疑似灾难性回溯，请简化模式：${pattern}`)
    }
    throw new Error(`正则执行失败：${e.message}`)
  }
}

async function toolGrep({ pattern, path, glob, head_limit, offset, output_mode, context, multiline, type }) {
  const p = validatePattern(pattern)
  const base = path ? safePath(path) : workspaceRoot()
  const include = glob ?? type ? String(glob ?? type).replace(/\*/g, '') : null
  const candidates = (await collectFiles(base)).filter(f =>
    include
      ? f.includes(include)
      : /\.(ts|tsx|js|jsx|json|md|css|html|mjs|cjs|py|txt|yml|yaml|toml|sh)$/.test(f),
  )

  // 读取阶段：文件大小与总行数双重预算
  const relPaths = []
  const fileLines = []
  let budget = GREP_LINE_BUDGET
  for (const f of candidates) {
    if (budget <= 0) break
    try {
      const st = await stat(f)
      if (st.size > MAX_FILE_BYTES) continue
      const content = await readFile(f, 'utf8')
      const lines = content.split('\n')
      relPaths.push(rel(f))
      fileLines.push(lines)
      budget -= lines.length
    } catch {
      continue
    }
  }

  const maxHits = Number.isFinite(Number(head_limit)) && Number(head_limit) > 0
    ? Math.min(Number(head_limit), GREP_MAX_HITS)
    : GREP_MAX_HITS
  const skip = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0
  const mode = ['content', 'files_with_matches', 'count'].includes(output_mode) ? output_mode : 'content'

  const matches = matchWithTimeout(p, fileLines, { multiline: Boolean(multiline) })
  const page = matches.slice(skip, skip + maxHits)

  if (page.length === 0) {
    return skip > 0
      ? `跳过前 ${skip} 处后没有更多匹配「${p}」（共 ${matches.length} 处）`
      : `未找到匹配「${p}」（扫描 ${relPaths.length} 个文件）`
  }

  if (mode === 'files_with_matches') {
    const files = [...new Set(page.map(([fi]) => relPaths[fi]))]
    return `${files.length} 个文件命中「${p}」：\n${files.join('\n')}`
  }
  if (mode === 'count') {
    const counts = new Map()
    for (const [fi] of page) counts.set(relPaths[fi], (counts.get(relPaths[fi]) ?? 0) + 1)
    return `按文件统计「${p}」（共 ${matches.length} 处）：\n${[...counts].map(([f, n]) => `${f}: ${n}`).join('\n')}`
  }

  const ctx = Number.isFinite(Number(context)) && Number(context) > 0 ? Math.min(Number(context), 10) : 0
  const hits = page.map(([fi, li]) => {
    const lines = fileLines[fi]
    if (ctx === 0) return `${relPaths[fi]}:${li + 1}: ${lines[li].trim().slice(0, 160)}`
    const from = Math.max(0, li - ctx)
    const to = Math.min(lines.length - 1, li + ctx)
    const block = []
    for (let k = from; k <= to; k++) {
      block.push(`${relPaths[fi]}:${k + 1}${k === li ? ':' : '-'} ${lines[k].slice(0, 160)}`)
    }
    return block.join('\n')
  })

  const more = matches.length > skip + page.length
  return truncate(
    `共 ${matches.length}${matches.length >= GREP_MAX_HITS ? '+' : ''} 处匹配，` +
      `本次返回 ${page.length} 条（已跳过 ${skip}${more ? `，还有 ${matches.length - skip - page.length} 条可用 offset 取` : ''}）：\n` +
      hits.join('\n'),
  )
}

async function toolGlob({ pattern, path }) {
  requireText(pattern, 'pattern', '例如 {"pattern": "**/*.ts"}（`*` 不跨目录，`**` 跨目录）')
  const re = globToRegExp(pattern)
  const files = await collectFiles(path ? safePath(path) : undefined)
  const hits = files.map(f => rel(f)).filter(f => re.test(f)).slice(0, 200)
  return hits.length > 0 ? `${hits.length} 个匹配：\n${hits.join('\n')}` : `未找到匹配「${pattern}」`
}

// ---------------------------------------------------------------------------
// 执行类工具
// ---------------------------------------------------------------------------

/**
 * 连根杀掉一个进程树（不只是直接子进程）。
 *
 * 只杀 shell（cmd.exe / sh）不够 —— 真正跑命令的是它的**孙进程**：shell 死了它
 * 照样活着，继续占着 stdout 管道 / 文件锁 / 端口（Windows 上尤其明显，后续写
 * 同一个文件会被锁住）。
 * Windows 用 taskkill /T /F；Unix 用进程组 kill(-pid)（要求 spawn 时 detached）。
 *
 * 用 spawn 而非 execSync：taskkill 要几百毫秒，同步等会把整个本地服务的事件
 * 循环卡住，其他 WS 客户端跟着一起卡。
 *
 * @param {number|undefined} pid
 * @param {boolean} isWin
 * @returns {void}
 */
function killProcessTree(pid, isWin) {
  if (!pid) return
  try {
    if (isWin) {
      const k = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      k.on('error', () => {})
      k.unref?.()
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
    }
  } catch {
    /* 进程已自己退出；taskkill 失败属常见竞态，忽略即可 */
  }
}

/**
 * 前台执行一条 shell 命令。
 *
 * 两个要点（都踩过坑，见 MEMORY）：
 *  1. **不等 close 直接结算**：超时后孙进程可能仍抓着 stdout 管道，等 `close`
 *     就永不触发 → **整个回合挂死**。所以超时即 kill + 立刻结算，之后来的
 *     close 一律忽略。
 *  2. **杀进程树**：只杀 shell 会留下孤儿孙进程占文件锁/端口（见 killProcessTree）。
 *
 * @param {string} cmd
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function execShell(cmd, timeoutMs = BASH_TIMEOUT_MS) {
  return new Promise(resolveResult => {
    const isWin = process.platform === 'win32'
    const file = isWin ? 'cmd.exe' : '/bin/sh'
    const args = isWin ? ['/d', '/s', '/c', cmd] : ['-c', cmd]
    const MAX = 4 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let truncated = false
    let exitCode = /** @type {number|null} */ (null)
    let timedOut = false
    let settled = false
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer

    const child = spawn(file, args, {
      cwd: workspaceRoot(),
      windowsHide: true,
      // Unix 必须有独立进程组，超时才能用 kill(-pid) 连根杀；Windows 靠 taskkill /T
      detached: !isWin,
      env: { ...process.env, ...shellNetEnv() },
    })

    // 幂等：超时结算之后再来 close / error 都不再改结果
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const out = [
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
        truncated ? '\n[输出超过 4MB，已截断]' : null,
        timedOut ? `\n[超时 ${timeoutMs}ms，进程树已被终止]` : null,
        exitCode !== null && exitCode !== 0 && !timedOut ? `\n[退出码 ${exitCode}]` : null,
      ]
        .filter(Boolean)
        .join('\n')
      resolveResult(out || '（无输出）')
    }

    const pump = (which, d) => {
      if (settled) return
      const s = d.toString()
      if (which === 'out') {
        if (stdout.length + s.length > MAX) {
          truncated = true
          return
        }
        stdout += s
      } else {
        if (stderr.length + s.length > MAX) {
          truncated = true
          return
        }
        stderr += s
      }
    }

    child.stdout?.on('data', d => pump('out', d))
    child.stderr?.on('data', d => pump('err', d))
    child.on('error', err => {
      stderr += `\n${String(err?.message ?? err)}`
      finish()
    })
    child.on('close', code => {
      exitCode = code
      finish()
    })

    timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      killProcessTree(child.pid, isWin)
      // 关键：不等 close —— 孙进程可能还抓着 stdout，等它退出会挂死整个回合。
      finish()
    }, timeoutMs)
  })
}

// ---------------------------------------------------------------------------
// Bash 后台任务：run_in_background=true 时立即返回任务 ID，输出驻留内存
// （每任务上限 64KB），用 TaskOutput(taskId) 轮询、TaskStop(taskId) 终止。
// 与待办类 TaskOutput/TaskStop 共用工具名，靠 bg- 前缀区分。
// ---------------------------------------------------------------------------
const BG_MAX_BYTES = 64 * 1024
/** 同时在跑的后台任务上限（超过就拒绝启动，防 map 与子进程无限增长）。 */
const BG_MAX_RUNNING = 30
const bgTasks = new Map() // id -> task
let bgSeq = 0

function bgAppend(task, chunk) {
  task.bytes += chunk.length
  task.chunks.push(chunk)
  let size = task.chunks.reduce((n, x) => n + x.length, 0)
  while (size > BG_MAX_BYTES && task.chunks.length > 1) size -= task.chunks.shift().length
}

function bgSnapshot(task) {
  const status = task.killed
    ? 'stopped'
    : task.done
      ? `done（退出码 ${task.exitCode ?? '?'}）`
      : 'running'
  const out = task.chunks.join('') || task.error || '（暂无输出）'
  const secs = Math.round((Date.now() - task.startedAt) / 1000)
  return `后台任务 ${task.id}：${status}\n命令：${task.command}\n已运行 ${secs}s\n输出：\n${out}`
}

function startBackgroundShell(session, command) {
  const id = `bg-${++bgSeq}`
  const isWin = process.platform === 'win32'
  const file = isWin ? 'cmd.exe' : '/bin/sh'
  const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
  const proc = spawn(file, args, {
    cwd: workspaceRoot(),
    windowsHide: true,
    detached: !isWin,
    env: { ...process.env, ...shellNetEnv() },
  })
  const task = {
    id, sessionId: session?.id ?? '', command, startedAt: Date.now(),
    chunks: [], bytes: 0, done: false, killed: false, exitCode: /** @type {number|null} */ (null), error: /** @type {string|null} */ (null), proc,
  }
  proc.stdout.on('data', d => bgAppend(task, d))
  proc.stderr.on('data', d => bgAppend(task, d))
  proc.on('error', err => { task.error = String(err.message ?? err); task.done = true })
  proc.on('close', code => { task.done = true; task.exitCode = code })
  bgTasks.set(id, task)
  // 防泄漏：超过 30 个时淘汰已结束的旧任务
  if (bgTasks.size > 30) {
    for (const [k, t] of bgTasks) {
      if (t.done && bgTasks.size > 30) bgTasks.delete(k)
    }
  }
  // 只淘汰「已结束」的是不够的：若 30 个**全在跑**，一个都淘汰不掉，
  // map 与子进程数会无限增长（每个任务最多还占 64KB 输出）。这里对正在跑的
  // 任务也设硬上限，超了就明确拒绝并给出可操作的提示 —— 静默失败最糟。
  let runningNow = 0
  for (const t of bgTasks.values()) if (!t.done) runningNow++
  if (runningNow > BG_MAX_RUNNING) {
    bgTasks.delete(id)
    try {
      task.proc?.kill('SIGKILL')
    } catch {
      /* 刚起的，杀不掉就算了 */
    }
    return (
      `后台任务已达并发上限（同时在跑 ${runningNow - 1} 个，上限 ${BG_MAX_RUNNING}）。` +
      `请先用 TaskStop 结束掉一些，或改用前台 Bash。命令未启动：${command}`
    )
  }
  return `已在后台启动（任务 ID：${id}）\n命令：${command}\n用 TaskOutput {"taskId":"${id}"} 查看输出；TaskStop {"taskId":"${id}"} 终止。`
}

/** 服务退出时终止全部后台任务（防孤儿进程占着端口/管道）。 */
export function stopAllBackgroundShells() {
  let n = 0
  for (const [id, t] of bgTasks) {
    if (t.done) continue
    try { stopBackgroundShell(id); n++ } catch { /* 尽力而为 */ }
  }
  return n
}
function stopBackgroundShell(id) {
  const task = bgTasks.get(id)
  if (!task) throw new Error(`后台任务不存在：${id}（任务结束并输出完会被回收）`)
  if (task.done) return `后台任务 ${id} 已结束（退出码 ${task.exitCode ?? '?'}），无需停止。`
  task.killed = true
  const isWin = process.platform === 'win32'
  try {
    if (isWin) {
      // 套着 cmd.exe 的进程树要连根杀：只 kill 直接子进程会留下孤儿占着 stdout
      execSync(`taskkill /T /F /PID ${task.proc.pid}`, { stdio: 'ignore' })
    } else {
      try { process.kill(-task.proc.pid) } catch { task.proc.kill('SIGKILL') }
    }
  } catch (err) {
    // taskkill 失败常见于竞态：进程已自己退出、close 事件还没到（task.done 未置位）。
    // 先探活：已死就不用再报"终止"，如实说明即可。
    let alive = true
    try { alive = task.proc.kill(0) } catch { alive = false }
    if (!alive) return `后台任务 ${id} 已结束（进程已自行退出）。`
    try { task.proc.kill('SIGKILL') } catch { /* 彻底没了 */ }
    return `已发送终止信号（${String(err.message ?? err)}）：${id}`
  }
  return `已终止后台任务 ${id}。`
}

function shellNetEnv() {
  // 尽力而为的网络开关：LIMKENION_WEB_SHELL_NET=off 时给子进程一个
  // 指向死端口的代理 —— curl/npm/pip 这类守规矩的 CLI 会立即失败。
  // 局限：不走代理的原始 socket / 自定义 DNS 拦不住（OS 级沙箱才能根治）。
  if (process.env.LIMKENION_WEB_SHELL_NET !== "off") return {}
  const dead = "http://127.0.0.1:9"
  return { HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead, http_proxy: dead, https_proxy: dead, all_proxy: dead }
}

async function toolBash(input, session) {
  const command = input?.command
  requireText(command, 'command', 'Bash 需要一条要执行的命令，例如 {"command": "ls -la"}')
  if (input?.run_in_background) return startBackgroundShell(session, String(command))
  // 前台：超时可配（默认 30s，上限 10 分钟）
  const timeout = Math.min(Math.max(Number(input?.timeout) || BASH_TIMEOUT_MS, 1000), 600_000)
  // 变更类命令先做工作区快照（Bash 改文件没有 Write/Edit 那样的检查点，rewind 盲区补偿）
  if (commandLikelyMutating(command)) {
    try { await snapshotWorkspace(session, workspaceRoot()) } catch { /* 快照失败不阻断 */ }
  }
  return truncate(`$ ${command}\n\n${await execShell(command, timeout)}`)
}


async function toolPowerShell({ command }) {
  requireText(command, 'command', 'PowerShell 需要一条要执行的命令，例如 {"command": "Get-ChildItem"}')
  if (process.platform !== 'win32') {
    throw new Error('PowerShell 工具仅在 Windows 平台可用（当前平台：' + process.platform + '）')
  }
  const out = await new Promise(resolveResult => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd: workspaceRoot(), timeout: BASH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolveResult(
          [
            stdout && `stdout:\n${stdout}`,
            stderr && `stderr:\n${stderr}`,
            error && error.killed ? `\n[超时 ${BASH_TIMEOUT_MS}ms]` : null,
            error && error.code !== 0 && !error.killed ? `\n[退出码 ${error.code}]` : null,
          ]
            .filter(Boolean)
            .join('\n') || '（无输出）',
        )
      },
    )
  })
  return truncate(`PS> ${command}\n\n${out}`)
}

/** REPL：在受限 vm 沙箱里执行 JS 片段（CLI REPLTool 的 web 镜像）。 */
async function toolREPL({ code }) {
  requireText(code, 'code', '要执行的 JS 片段，例如 {"code": "return [1,2,3].map(n => n * 2)"}')
  const logs = []
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')),
      error: (...a) => logs.push('[err] ' + a.map(String).join(' ')),
    },
    Math,
    JSON,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    Promise,
  }
  const context = vm.createContext(sandbox)
  let result
  try {
    result = await new vm.Script(`(async () => { ${code} })()`).runInContext(context, { timeout: 5000 })
  } catch (e) {
    throw new Error(`REPL 执行失败：${e.message}`)
  }
  const parts = []
  if (logs.length > 0) parts.push(logs.join('\n'))
  if (result !== undefined) parts.push('=> ' + (typeof result === 'string' ? result : JSON.stringify(result)))
  return truncate(parts.join('\n') || '（无输出）')
}

// ---------------------------------------------------------------------------
// 网络类工具
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LimkenionWeb/0.4'

async function fetchText(url, { timeoutMs = 20_000, upgradeToHttps = false } = {}) {
  // 只有用户给的 WebFetch 地址做 https 升级；内部端点（如搜索服务）保持原样，
  // 否则本地/内网的 http 端点会被改写成 https 而连不上。
  const target = upgradeToHttps ? url.replace(/^http:\/\//i, 'https://') : url
  const res = await fetch(target, {
    headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { res, target, body: await res.text() }
}

async function toolWebFetch({ url, prompt }, ctx) {
  if (!/^https?:\/\//i.test(url ?? '')) throw new Error('url 必须是完整的 http(s) 地址')
  let out
  try {
    out = await fetchText(url, { upgradeToHttps: true })
  } catch (e) {
    throw new Error(`抓取失败（${url}）：${e.message}`)
  }
  if (!out.res.ok) throw new Error(`抓取失败（${url}）：HTTP ${out.res.status}`)

  const ctype = out.res.headers.get('content-type') ?? ''
  let text = ctype.includes('html') ? stripTags(out.body) : out.body
  if (text.trim().length === 0) text = '（页面正文为空）'

  // 与 CLI 一致：有 prompt 时交给小模型按 prompt 提炼；无引擎时直接回原文。
  let body = text
  if (prompt && typeof ctx?.summarize === 'function') {
    const summary = await ctx.summarize(text, prompt)
    if (summary) body = summary
  }

  // 外部内容一律标记为不可信：同一回合内它会触发危险工具的强制重新确认
  markUntrusted(ctx?.session, `WebFetch ${out.target}`)
  ctx?.notifyUntrusted?.(`已抓取外部页面 ${out.target}，内容按不可信资料处理`)
  return truncate(wrapUntrusted('WebFetch', out.target, body), 12_000)
}

/**
 * WebSearch：以 Bing 检索页为数据源（无 API key 依赖），解析标题/链接/摘要。
 * 结果条目为「标题 — 链接 — 摘要」，交给模型继续用 WebFetch 深挖。
 */
async function toolWebSearch({ query, allowed_domains, blocked_domains }, ctx) {
  if (!query || String(query).trim().length === 0) throw new Error('query 不能为空')
  const allow = Array.isArray(allowed_domains) ? allowed_domains.filter(Boolean) : []
  const block = Array.isArray(blocked_domains) ? blocked_domains.filter(Boolean) : []
  // 域名过滤在结果侧做（检索端点本身不支持这些参数）
  const q = String(query).trim()
  const endpoint = process.env.LIMKENION_WEB_SEARCH_ENDPOINT ?? 'https://www.bing.com/search'
  const url = `${endpoint}?q=${encodeURIComponent(q)}&count=10&setlang=zh-CN`
  let html
  try {
    const out = await fetchText(url, { timeoutMs: 15_000 })
    if (!out.res.ok) throw new Error(`HTTP ${out.res.status}`)
    html = out.body
  } catch (e) {
    throw new Error(
      `搜索请求失败（${e.message}）。可设置 LIMKENION_WEB_SEARCH_ENDPOINT 指向可用的搜索端点。`,
    )
  }

  const blocks = html.split(/<li class="b_algo"/i).slice(1, 11)
  // 两处 `.filter(Boolean)` 都不做类型收窄：map 会产出 `({...}|null)[]`，
  // 过滤后 TS 仍然认为元素可能是 null，于是 `it.href` 全线报错。显式断言一次。
  const parsed = /** @type {Array<{href: string, title: string, snippet: string}>} */ (
    blocks
      .map(b => {
        const href = (b.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i) ?? [])[1]
        const titleRaw = (b.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) ?? [])[1]
        const snipRaw = (b.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ?? [])[1]
        const title = titleRaw ? stripTags(titleRaw) : ''
        const snippet = snipRaw ? stripTags(snipRaw) : ''
        return href ? { href, title: title || href, snippet } : null
      })
      .filter(Boolean)
  )
  const items = parsed.filter(it => {
      let host = ''
      try {
        host = new URL(it.href).hostname
      } catch {
        return true
      }
      if (allow.length > 0 && !allow.some(d => host === d || host.endsWith('.' + d))) return false
      if (block.some(d => host === d || host.endsWith('.' + d))) return false
      return true
    })

  // 检索结果同样是外部内容，按不可信处理
  markUntrusted(ctx?.session, `WebSearch ${q}`)
  ctx?.notifyUntrusted?.(`已执行网络搜索「${q}」，结果按不可信资料处理`)

  if (items.length === 0) {
    return wrapUntrusted('WebSearch', url, `未解析到搜索结果（查询：${q}）。可尝试换关键词或用 WebFetch 直接抓取已知 URL。`)
  }
  return truncate(
    wrapUntrusted(
      'WebSearch',
      url,
      `「${q}」的 ${items.length} 条结果：\n\n` +
        items
          .map((it, i) => `${i + 1}. ${it.title}\n   ${it.href}\n   ${it.snippet.slice(0, 220)}`)
          .join('\n\n'),
    ),
  )
}

// ---------------------------------------------------------------------------
// 协作类工具
// ---------------------------------------------------------------------------

/**
 * McpAuth：为指定服务器发起 OAuth 授权（生成链接 + 自动开浏览器 + 回调换 token）。
 * 此前这里是一个失真的降级桩 —— OAuth 流程早在第 20 轮就实现了。
 */
async function toolComputerScreenshot(input) {
  if (!computerAvailable()) {
    throw new Error(process.platform !== 'win32'
      ? 'Computer Use 仅在 Windows 上可用（当前平台：' + process.platform + '）'
      : 'Computer Use 未启用（需设置环境变量 LIMKENION_WEB_COMPUTER_USE=1）')
  }
  const r = await computerScreenshot({ maxWidth: Number(input?.maxWidth) || 1280 })
  // 引擎识别这个前缀后，把图片以 user 消息注入模型上下文
  return `@@SCREENSHOT@@${r.dataUrl}`
}

async function toolComputerControl(input) {
  if (!computerAvailable()) {
    throw new Error(process.platform !== 'win32'
      ? 'Computer Use 仅在 Windows 上可用（当前平台：' + process.platform + '）'
      : 'Computer Use 未启用（需设置环境变量 LIMKENION_WEB_COMPUTER_USE=1）')
  }
  return computerControl(input)
}

async function toolPreviewUrl(input, ctx) {
  const url = requireText(input?.url, 'url', '本机页面地址，例如 {"url": "http://localhost:5173"}')
  let u
  try { u = new URL(url) } catch { throw new Error(`不是合法的 URL：${url}`) }
  const host = u.hostname.toLowerCase()
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https')
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
    throw new Error('仅支持预览本机地址（localhost / 127.0.0.1）—— 外部页面请让用户自己打开')
  }
  ctx?.emit?.({ type: 'preview_open', url })
  return `已在预览面板打开：${url}`
}

async function toolMcpAuth(input, ctx) {
  const server = requireText(input?.server, 'server', 'MCP 服务器名，例如 {"server": "github"}')
  if (typeof ctx?.mcpAuthFlow !== 'function') throw new Error('当前服务端未挂载 MCP 授权执行器（ctx.mcpAuthFlow 缺失）')
  return ctx.mcpAuthFlow(server)
}

async function toolMcpPrompt(input, ctx) {
  const server = requireText(input?.server, 'server', 'MCP 服务器名，例如 {"server": "github"}')
  const name = requireText(input?.name, 'name', '提示词模板名，例如 {"name": "review"}')
  if (typeof ctx?.getMcpPrompt !== 'function') throw new Error('当前服务端未挂载 MCP 提示词执行器（ctx.getMcpPrompt 缺失）')
  return ctx.getMcpPrompt(server, name, input?.arguments)
}

async function toolMcpRegistrySearch(input, ctx) {
  const query = requireText(input?.query, 'query', '搜索词，例如 {"query": "github"}')
  if (typeof ctx?.mcpRegistrySearch !== 'function') throw new Error('当前服务端未挂载 registry 查询器')
  return ctx.mcpRegistrySearch(query)
}

async function toolAgent({ description, prompt, subagent }, ctx) {
  if (typeof ctx?.runSubAgent !== 'function') {
    throw new Error('当前服务端未挂载子代理执行器（ctx.runSubAgent 缺失）')
  }
  requireText(prompt, 'prompt', '要交给子代理的任务描述（它是只读的，只能查不能改）')
  // subagent = 具名子代理（在界面上配好的那种）。校验放在 engine 侧做 ——
  // tools.mjs 不能 import subagents.mjs（那边要用这里的 SUBAGENT_TOOLS，会成环）。
  const text = await ctx.runSubAgent({ description, prompt, agent: subagent })
  return truncate(`子代理「${description ?? 'task'}」结论：\n\n${text}`, 12_000)
}

function teamOf(session) {
  if (!session.team) session.team = { name: null, members: [], log: [] }
  return session.team
}

async function toolTeamCreate({ team_name, name, description, agent_type, members }, session) {
  const teamName = String(team_name ?? name ?? '').trim()
  if (!teamName) {
    throw new Error('缺少 name 参数（或 CLI 风格的 team_name）：团队名，例如 {"name": "review", "members": ["a", "b"]}')
  }
  const team = teamOf(session)
  team.name = teamName
  team.description = description ? String(description) : undefined
  team.members = Array.isArray(members)
    ? members.map(m => (typeof m === 'string' ? { name: m, role: agent_type ?? 'agent', status: 'idle' } : { status: 'idle', ...m }))
    : []
  return (
    `已创建团队「${team.name}」${team.description ? `（${team.description}）` : ''}，` +
    `成员 ${team.members.length} 个：${team.members.map(m => m.name).join('、') || '（无）'}`
  )
}

async function toolTeamDelete(_input, session) {
  const team = teamOf(session)
  const n = team.members.length
  session.team = { name: null, members: [], log: [] }
  return `已解散团队（移除 ${n} 个成员）。`
}

async function toolSendMessage(input, ctx) {
  const { to, message, summary } = input ?? {}
  requireText(to, 'to', '收件成员名，例如 {"to": "reviewer", "message": "帮我看一下 diff"}')
  requireText(message, 'message', '要发的内容')
  const session = ctx?.session
  const team = teamOf(session)
  const entry = { to: String(to), message: String(message), summary, at: Date.now() }
  team.log.push(entry)
  if (team.members.length === 0) {
    return `已记录消息（当前无团队成员，web 端不承载真实多进程协作）：\n→ ${entry.to}：${entry.message.slice(0, 200)}`
  }
  const member = team.members.find(m => m.name === entry.to)
  if (!member) {
    return `成员「${entry.to}」不在团队中（现有：${team.members.map(m => m.name).join('、')}）。消息已记录。`
  }
  // 真派活：成员置 busy → 跑子代理 → 置回 idle 并触发 teammate-idle。
  // 这就是 teammate-idle 的事件源：此前 web 的成员只是名单，没有「干活→空闲」生命周期。
  if (typeof ctx?.runSubAgent !== 'function') {
    return `已投递给成员「${entry.to}」（子代理执行器未挂载，暂未执行）：${entry.message.slice(0, 200)}`
  }
  member.status = 'busy'
    ctx?.emit?.({ type: 'team_event', member: member.name, payload: { type: 'notice', text: `收到任务：${entry.message.slice(0, 200)}` } })
  try {
    const result = await ctx.runSubAgent({ description: `队友「${member.name}」处理消息`, prompt: entry.message, tag: member.name })
    return `队友「${member.name}」已完成：\n${result}`
  } finally {
    member.status = 'idle'
    ctx?.emit?.({ type: 'team', sessionId: session.id, team: session.team })
    void runEventHooks(HOOK_EVENT.TEAMMATE_IDLE, {
      hookInput: { session_id: session?.id ?? '', team: team.name ?? '', member: member.name },
    }).catch(() => {})
  }
}


/** SendUserMessage（CLI BriefTool）：把一条提示直接推到界面。 */
async function toolSendUserMessage({ message, attachments, status }, ctx) {
  requireText(message, 'message', '要推送到界面的提示文本')
  const text = String(message)
  if (typeof ctx?.emit === 'function') {
    ctx.emit({ type: 'notice', text, status: status ?? 'info' })
  }
  const att = Array.isArray(attachments) && attachments.length > 0 ? `（附带 ${attachments.length} 个附件引用）` : ''
  return `已向界面推送提示${att}：${text.slice(0, 200)}`
}

// ---------------------------------------------------------------------------
// 任务类工具（会话级任务表，镜像 CLI Task* 工具）
// ---------------------------------------------------------------------------

function tasksOf(session) {
  if (!session.tasks) session.tasks = []
  return session.tasks
}

let taskSeq = 0

async function toolTaskCreate({ subject, description, activeForm, metadata }, session) {
  requireText(subject, 'subject', '一句话的任务标题，例如 {"subject": "修掉登录页的抖动"}')
  const _taskCreatedHook = () => void runEventHooks(HOOK_EVENT.TASK_CREATED, {
    hookInput: { session_id: session?.id ?? '', task_subject: subject },
  }).catch(() => {})
  const tasks = tasksOf(session)
  const task = {
    id: String(++taskSeq),
    subject: String(subject ?? ''),
    description: String(description ?? ''),
    activeForm: activeForm ? String(activeForm) : undefined,
    metadata: metadata ?? undefined,
    status: 'pending',
    owner: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  tasks.push(task)
  return `已创建任务 #${task.id}：${task.subject}`
}

/**
 * 解析任务 id。缺参数时给一句**能照着改**的错，
 * 而不是 `任务不存在：#undefined` —— 后者会让模型以为"任务是存在但找不到"，
 * 于是去 TaskList 里翻半天，而真正的原因只是它忘了传 id。
 */
function requireTaskId(input) {
  const raw = input?.taskId ?? input?.task_id
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('缺少 task_id 参数（先用 TaskList 看现有任务的编号）')
  }
  return String(raw)
}

async function toolTaskGet(input, session) {
  const id = requireTaskId(input)
  const task = tasksOf(session).find(t => t.id === id)
  if (!task) throw new Error(`任务不存在：#${id}（用 TaskList 看现有编号）`)
  return JSON.stringify(task, null, 2)
}

async function toolTaskList(_input, session) {
  const tasks = tasksOf(session)
  if (tasks.length === 0) return '当前无任务。用 TaskCreate 创建。'
  return tasks
    .map(t => `#${t.id} [${t.status}] ${t.subject}${t.owner ? `（负责：${t.owner}）` : ''}`)
    .join('\n')
}

async function toolTaskUpdate(input, session) {
  const { taskId, status, subject, description, owner, activeForm, metadata, addBlocks, addBlockedBy } = input ?? {}
  const id = requireTaskId(input)
  const task = tasksOf(session).find(t => t.id === id)
  if (!task) throw new Error(`任务不存在：#${id}（用 TaskList 看现有编号）`)
  const changed = []
  if (Array.isArray(addBlocks)) {
    task.blocks = [...new Set([...(task.blocks ?? []), ...addBlocks.map(String)])]
    changed.push('blocks')
  }
  if (Array.isArray(addBlockedBy)) {
    task.blockedBy = [...new Set([...(task.blockedBy ?? []), ...addBlockedBy.map(String)])]
    changed.push('blockedBy')
  }
  for (const [k, v] of Object.entries({ status, subject, description, owner, activeForm, metadata })) {
    if (v !== undefined) {
      task[k] = v
      changed.push(k)
    }
  }
  task.updatedAt = Date.now()
  if (status === 'completed') {
    void runEventHooks(HOOK_EVENT.TASK_COMPLETED, {
      hookInput: { session_id: session?.id ?? '', task_id: String(task.id ?? id), task_subject: task.subject },
    }).catch(() => {})
  }
  return `已更新任务 #${task.id}（${changed.join('、') || '无字段变更'}）：${task.subject} [${task.status}]`
}

async function toolTaskStop(input, session) {
  const id = requireTaskId(input)
  // 后台 shell 任务（bg- 前缀）走独立的注册表
  if (String(id).startsWith('bg-')) return stopBackgroundShell(String(id))
  const task = tasksOf(session).find(t => t.id === id)
  if (!task) throw new Error(`任务不存在：#${id}（用 TaskList 看现有编号）`)
  task.status = 'stopped'
  task.updatedAt = Date.now()
  return `已停止任务 #${task.id}：${task.subject}`
}

async function toolTaskOutput(input, session) {
  const id = requireTaskId(input)
  // 后台 shell 任务（bg- 前缀）：返回状态 + 输出快照
  if (String(id).startsWith('bg-')) {
    const t = bgTasks.get(String(id))
    if (!t) throw new Error(`后台任务不存在：${id}（任务结束且被回收后即查不到）`)
    return bgSnapshot(t)
  }
  const task = tasksOf(session).find(t => t.id === id)
  if (!task) throw new Error(`任务不存在：#${id}（用 TaskList 看现有编号）`)
  return JSON.stringify(task, null, 2)
}

/** TodoWrite：更新会话待办（CLI TodoWriteTool 的 web 镜像）。 */
async function toolTodoWrite({ todos }, session) {
  // 先校验再写状态：原来的顺序是 `session.todos = todos` 后紧跟 `todos.filter(...)`，
  // 传空入参时**待办先被写成 undefined、然后才抛错** —— 会话状态被污染且没人修。
  if (!Array.isArray(todos)) {
    throw new Error(
      'todos 必须是数组，例如 [{"content": "写文档", "status": "pending"}]（status: pending | in_progress | completed）',
    )
  }
  const normalized = todos.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`todos[${i}] 必须是对象，例如 {"content": "...", "status": "pending"}`)
    const content = String(t.content ?? t.subject ?? '').trim()
    if (!content) throw new Error(`todos[${i}] 缺少 content`)
    const status = ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending'
    return { content, status, ...(t.activeForm ? { activeForm: String(t.activeForm) } : {}) }
  })
  session.todos = normalized
  const done = normalized.filter(t => t.status === 'completed').length
  return `待办已更新：${done}/${normalized.length} 完成`
}

// ---------------------------------------------------------------------------
// 流程类工具
// ---------------------------------------------------------------------------

async function toolPlanEnter(_input, ctx) {
  const session = ctx.session
  session.planMode = true
  ctx.emit({ type: 'plan_mode_changed', active: true })
  return (
    '已进入计划模式。请只做只读探查（Glob / Grep / Read / WebFetch），' +
    '不要修改文件或执行有副作用的命令；设计好方案后用 PlanExit 提交给用户批准。'
  )
}

async function toolPlanExit({ plan }, ctx) {
  const session = ctx.session
  session.planMode = false
  const text = String(plan ?? '').trim()
  ctx.emit({ type: 'plan_mode_changed', active: false, plan: text })
  session.pendingPlan = text
  return text
    ? `已提交计划，等待用户批准：\n\n${text}`
    : '已退出计划模式（未附带计划文本）。'
}

/** AskUserQuestion：把问题推给前端，等待用户作答后返回答案。 */
async function toolAskUserQuestion({ questions }, ctx) {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('questions 不能为空')
  if (typeof ctx?.askQuestions !== 'function') {
    throw new Error('当前服务端未挂载问答通道（ctx.askQuestions 缺失）')
  }
  const answers = await ctx.askQuestions(questions)
  return answers
    .map(a => `「${a.question}」→ ${Array.isArray(a.answer) ? a.answer.join('、') : a.answer}`)
    .join('\n')
}

async function toolSleep({ duration_ms, durationMs, seconds, duration }) {
  const raw =
    duration_ms ?? durationMs ?? (seconds !== undefined ? Number(seconds) * 1000 : undefined) ??
    (duration !== undefined ? Number(duration) * 1000 : undefined)
  const ms = Math.max(0, Math.min(Number(raw ?? 1000), MAX_SLEEP_MS))
  await new Promise(r => setTimeout(r, ms))
  return `已等待 ${ms}ms（上限 ${MAX_SLEEP_MS}ms）。`
}

/** CronCreate：登记会话级定时回合，由服务端 setTimeout 触发。 */
/**
 * 把定时周期解析成毫秒：支持 "30s" / "5m" / "2h" / 纯毫秒数 / rrule 的 INTERVAL=n。
 *
 * 抽出来是为了**只有一套解析标准** —— 界面（cron_create）和模型（CronCreate）
 * 走同一个函数，免得出现"界面能建、模型建不了"这类不一致。
 *
 * @param {string} spec 形如 "5m" / "60000" / rrule 串
 * @param {number|string} [intervalMs] 直接给毫秒时优先用
 * @returns {number} 解析不出时为 NaN
 */
export function parseIntervalMs(spec, intervalMs) {
  let everyMs = Number(intervalMs)
  if (Number.isFinite(everyMs)) return everyMs
  const s = String(spec ?? '').trim()
  const m = s.match(/^(\d+)\s*([smh])$/i)
  if (m) {
    const unit = /** @type {Record<string, number>} */ ({ s: 1000, m: 60_000, h: 3_600_000 })[m[2].toLowerCase()]
    return Number(m[1]) * unit
  }
  if (/^\d+$/.test(s)) return Number(s)
  const iv = s.match(/INTERVAL=(\d+)/i)
  return iv ? Number(iv[1]) * 60_000 : NaN
}

async function toolCronCreate({ cron, schedule, rrule, prompt, durable, recurring, interval_ms }, ctx) {
  const spec = String(cron ?? schedule ?? rrule ?? '').trim()
  const text = String(prompt ?? '').trim()
  if (!spec || !text) throw new Error('需要 schedule（如 "5m" / "60000" / rrule）与 prompt')
  if (typeof ctx?.scheduleCron !== 'function') throw new Error('当前服务端未挂载定时器（ctx.scheduleCron 缺失）')

  // 支持 "30s" / "5m" / "2h" / 纯毫秒数；rrule 形式的分钟级 INTERVAL=n 也接受
  const everyMs = parseIntervalMs(spec, interval_ms)
  if (!Number.isFinite(everyMs) || everyMs < 5_000) {
    throw new Error(`无法解析定时周期「${spec}」；请用 30s / 5m / 2h 或毫秒数（最小 5000）`)
  }
  const entry = ctx.scheduleCron({ everyMs, prompt: text, durable: Boolean(durable), recurring: recurring !== false })
  return (
    `已创建定时任务 ${entry.id}：每 ${Math.round(everyMs / 1000)}s 触发一次` +
    `（${recurring === false ? '单次' : '循环'}${durable ? '，持久化' : '，仅本进程'}），` +
    `内容「${text.slice(0, 80)}」`
  )
}

/**
 * CronList：列出本会话的定时任务。
 *
 * CLI 的 `tools/ScheduleCronTool/` 下有 CronCreate / CronList / CronDelete 三个工具，
 * 而 web 端原先**只搬了 CronCreate** —— 于是模型建了定时任务之后列不出来、也删不掉，
 * 只能靠用户手敲 `/cron clear`。这里补齐后两个。
 *
 * 只列**本会话**的：跨会话的任务对当前回合没有意义，也会把别的会话的内容泄给模型。
 */
async function toolCronList(_input, ctx) {
  if (typeof ctx?.cronList !== 'function') throw new Error('当前服务端未挂载定时器（ctx.cronList 缺失）')
  const mine = ctx.cronList().filter(c => c.sessionId === ctx.session?.id)
  if (mine.length === 0) {
    return '本会话没有定时任务。可用 CronCreate 创建（如 cron="5m", prompt="检查构建状态"）。'
  }
  return (
    `本会话的定时任务 ${mine.length} 个：\n` +
    mine
      .map(c => `- ${c.id}：每 ${Math.round(c.everyMs / 1000)}s「${c.prompt.slice(0, 80)}」`)
      .join('\n') +
    '\n\n用 CronDelete 传入 id 可取消。'
  )
}

/** CronDelete：按 id 取消一个定时任务（任意会话的都可以，只要拿到 id）。 */
async function toolCronDelete({ id }, ctx) {
  const target = String(id ?? '').trim()
  if (!target) throw new Error('需要 id 参数（由 CronCreate 返回，或用 CronList 查看）')
  if (typeof ctx?.cronRemove !== 'function') throw new Error('当前服务端未挂载定时器（ctx.cronRemove 缺失）')
  return ctx.cronRemove(target)
    ? `已取消定时任务 ${target}。`
    : `没有找到定时任务 ${target}。用 CronList 查看当前有哪些。`
}

// ---------------------------------------------------------------------------
// 配置 / 元工具
// ---------------------------------------------------------------------------

const CONFIG_KEYS = new Set(['theme', 'model', 'permissionMode', 'outputStyle', 'workspace'])

function settingsOf(session) {
  if (!session.settings) session.settings = {}
  if (session.settings.theme === undefined) session.settings.theme = 'dark'
  if (session.settings.permissionMode === undefined) session.settings.permissionMode = 'default'
  return session.settings
}

async function toolConfig({ setting, value, operation }, ctx) {
  // 服务端注入了全局设置对象时以它为准（与 /config 展示一致）
  const settings = ctx?.settings ?? settingsOf(ctx?.session)
  const key = String(setting ?? '')
  if (!key) {
    return `当前设置：\n${Object.entries(settings).map(([k, v]) => `- ${k}：${v}`).join('\n')}`
  }
  if (!CONFIG_KEYS.has(key)) {
    return `不支持的设置项「${key}」。可用：${[...CONFIG_KEYS].join('、')}`
  }
  const isRead = operation === 'get' || value === undefined || value === null
  if (isRead) return `${key} = ${settings[key] ?? '（未设置）'}`
  settings[key] = value
  if (typeof ctx?.applySetting === 'function') ctx.applySetting(key, value)
  return `已设置 ${key} = ${value}`
}

/** Skill：列出或读取技能定义（CLI SkillTool 的 web 镜像）。
 *  两类技能：CLI 内置的 `skills/bundled/*.ts` 注册模块，以及带 SKILL.md 的技能目录
 *  （工作区 `skills/`、`.workbuddy-ai/skills/`，以及用户级 `~/.workbuddy-ai/skills/`）。 */
async function discoverSkills() {
  const found = new Map()

  // 1) CLI 内置技能：从 skills/bundled/*.ts 里解析 name
  const bundledDir = join(workspaceRoot(), 'skills', 'bundled')
  if (existsSync(bundledDir)) {
    let entries = []
    try {
      entries = await readdir(bundledDir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.ts')) continue
      if (e.name === 'index.ts' || e.name.endsWith('Content.ts')) continue
      const file = join(bundledDir, e.name)
      let src = ''
      try {
        src = await readFile(file, 'utf8')
      } catch {
        continue
      }
      const names = [...src.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map(m => m[1])
      for (const n of names) {
        if (!found.has(n)) found.set(n, { name: n, kind: 'bundled', file })
      }
    }
  }

  // 2) SKILL.md 技能目录
  const skillRoots = [
    join(workspaceRoot(), 'skills'),
    join(workspaceRoot(), '.workbuddy-ai', 'skills'),
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.workbuddy-ai', 'skills'),
  ]
  for (const root of skillRoots) {
    if (!root || !existsSync(root)) continue
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const skillMd = join(root, e.name, 'SKILL.md')
      if (existsSync(skillMd) && !found.has(e.name)) {
        found.set(e.name, { name: e.name, kind: 'skillmd', file: skillMd })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 从内置技能模块里抽取提示词正文（取最长的模板字面量），失败则回退整文件。 */
function extractSkillPrompt(src) {
  const blocks = [...src.matchAll(/`([\s\S]{80,})`/g)].map(m => m[1])
  if (blocks.length === 0) return src
  return blocks.reduce((a, b) => (b.length > a.length ? b : a))
}

async function toolSkill({ skill, commandName: legacyName, args }) {
  // CLI 用 skill 作为参数名；commandName 保留兼容
  const commandName = skill ?? legacyName
  const skills = await discoverSkills()

  if (!commandName || commandName === 'list') {
    if (skills.length === 0) return '未发现技能（skills/ 与 .workbuddy-ai/skills/ 下都没有技能定义）。'
    const bundled = skills.filter(s => s.kind === 'bundled')
    const md = skills.filter(s => s.kind === 'skillmd')
    return (
      `可用技能 ${skills.length} 个：\n\n` +
      (bundled.length ? `CLI 内置（${bundled.length}）：\n${bundled.map(s => `- ${s.name}`).join('\n')}\n\n` : '') +
      (md.length ? `SKILL.md 技能（${md.length}）：\n${md.map(s => `- ${s.name}`).join('\n')}\n` : '') +
      `\n用 Skill(commandName="<名称>") 载入其内容。`
    )
  }

  const hit = skills.find(s => s.name === commandName)
  if (!hit) {
    throw new Error(`未找到技能「${commandName}」（可用：${skills.map(s => s.name).join('、') || '无'}）`)
  }
  const raw = await readFile(hit.file, 'utf8')
  const body = hit.kind === 'skillmd' ? raw : extractSkillPrompt(raw)
  return truncate(
    `技能「${commandName}」${args ? `（参数：${args}）` : ''}［来源：${hit.kind === 'bundled' ? '内置' : 'SKILL.md'}］\n\n${body}`,
    15_000,
  )
}

/** ToolSearch：在当前工具注册表中检索（CLI ToolSearchTool 的 web 镜像）。 */
/**
 * ToolSearch：按关键词检索工具，并把命中的延迟工具**启用**到当前会话。
 *
 * 这是控制每轮 schema 开销的关键：常驻工具之外还有一批延迟工具，
 * 模型需要时先搜一次，之后这些工具的 schema 才会随请求发出。
 */
async function toolToolSearch({ query, enable, max_results }, ctx) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) throw new Error('query 不能为空')
  const terms = q.split(/\s+/).filter(Boolean)
  const cap = Number.isFinite(Number(max_results)) && Number(max_results) > 0
    ? Math.min(Number(max_results), 50)
    : 25
  const matches = TOOL_SCHEMAS.map(s => ({
    name: s.function.name,
    description: s.function.description,
  }))
    .filter(t => terms.some(term => (t.name + ' ' + t.description).toLowerCase().includes(term)))
    .slice(0, cap)

  if (matches.length === 0) {
    return `没有匹配「${query}」的工具。可用工具共 ${TOOL_SCHEMAS.length} 个，可用 /tools 查看分组。`
  }

  const names = matches.map(m => m.name)
  const deferred = names.filter(n => !CORE_TOOL_NAMES.has(n))
  let note = ''
  if (enable !== false && deferred.length > 0 && typeof ctx?.enableTools === 'function') {
    const newly = ctx.enableTools(deferred)
    note = newly.length > 0
      ? `\n\n已启用：${newly.join('、')}（下一轮即可直接调用）`
      : `\n\n这些工具已处于启用状态。`
  } else if (deferred.length > 0) {
    note = `\n\n延迟工具（需先启用）：${deferred.join('、')}`
  }

  return (
    `匹配 ${matches.length} 个工具：\n\n` +
    matches.map(m => `- ${m.name}：${m.description.split('\n')[0]}`).join('\n') +
    note
  )
}

/** StructuredOutput（CLI SyntheticOutputTool）：把结构化结果原样回传。 */
async function toolStructuredOutput({ data, schema }) {
  if (data === undefined) throw new Error('缺少 data 字段')
  return `结构化输出：\n${JSON.stringify(data, null, 2)}${schema ? `\n\n（schema：${JSON.stringify(schema)}）` : ''}`
}

// ---------------------------------------------------------------------------
// 降级工具：web 沙箱内无对应基础设施，返回明确说明而非静默失败
// ---------------------------------------------------------------------------

function degraded(reason) {
  return async () => {
    throw new Error(`该工具在 Limkenion web 沙箱内不可用：${reason}`)
  }
}

/**
 * MCP：通用调用入口 / 资源列表 / 资源读取。
 *
 * 已发现的 MCP 工具会以单个工具的形式注册进来（`mcp__<服务器>__<工具>`），
 * 走 `executeTool` 里的前缀分支；这三个是 CLI 里对应的通用入口。
 */
async function toolMcpGeneric({ server, tool, args }, ctx) {
  if (typeof ctx?.callMcpTool !== 'function') {
    throw new Error('当前服务端未挂载 MCP 客户端（ctx.callMcpTool 缺失）')
  }
  const { mcpToolName } = await import('./mcp.mjs')
  return ctx.callMcpTool(mcpToolName(server, tool), args ?? {})
}

async function toolListMcpResources({ server }, ctx) {
  if (typeof ctx?.listMcpResources !== 'function') {
    throw new Error('当前服务端未挂载 MCP 客户端（ctx.listMcpResources 缺失）')
  }
  return ctx.listMcpResources(server)
}

async function toolReadMcpResource({ server, uri }, ctx) {
  if (typeof ctx?.readMcpResource !== 'function') {
    throw new Error('当前服务端未挂载 MCP 客户端（ctx.readMcpResource 缺失）')
  }
  return ctx.readMcpResource(server, uri)
}

/**
 * 动态工作流：脚本里用 agent/parallel/pipeline/phase 编排多个**只读**子代理。
 * 会花掉不少 token（所以是危险工具，要用户确认）。
 */
async function toolWorkflow(input, ctx) {
  if (typeof ctx?.runWorkflow !== 'function') {
    throw new Error('当前服务端未挂载工作流执行器（ctx.runWorkflow 缺失）')
  }
  const { script, scriptPath, name, resumeFromRunId, args } = input ?? {}

  let source = typeof script === 'string' ? script : ''
  if (!source && scriptPath) {
    // scriptPath 也要过沙箱校验 —— 不能因为"是个工作流脚本"就允许读任意路径
    const abs = safePath(scriptPath)
    source = await readFile(abs, 'utf8')
  }
  if (!source && name) {
    throw new Error(
      'web 端不支持按名字调用预定义工作流（CLI 的 `.limkenion/workflows/` 与内置工作流未镜像）。' +
        '请直接把脚本放在 `script` 里，或给一个沙箱内的 `scriptPath`。',
    )
  }
  if (!source.trim()) throw new Error('必须提供 script（或沙箱内的 scriptPath）')

  const run = await ctx.runWorkflow({
    script: source,
    name,
    resumeFrom: resumeFromRunId,
    args,
  })

  const done = run.agents.filter(a => a.status === 'done' || a.status === 'reused').length
  const head =
    `工作流 ${run.runId} 完成（${run.name}）：子代理 ${done} 个` +
    `${run.phases.length ? `，阶段 ${run.phases.map(p => p.name).join(' → ')}` : ''}\n` +
    `（用 /workflows show ${run.runId} 看每个子代理的结论）\n\n`
  return head + (run.result ?? '（脚本没有返回值）')
}

/**
 * worktree 两个工具的真实现。
 *
 * 它们**会改动会话的沙箱根**（不只是 cwd），所以列进 DANGEROUS_TOOLS 需要用户确认：
 * 一次授权等于把之后所有文件工具的作用范围换到另一棵树上，属于安全边界的改变。
 */
async function toolEnterWorktree(input, session) {
  const r = await enterWorktree(session, input?.name)
  return `${r.message}\n\n（沙箱根已切换；如需可访问其他目录，配 permissions.additionalDirectories）`
}

async function toolExitWorktree(input, session) {
  const action = input?.action === 'remove' ? 'remove' : 'keep'
  // `discard_changes` 与 CLI 同名同义，必须显式为 true 才允许丢弃未提交的改动。
  const r = await exitWorktree(session, action === 'remove', input?.discard_changes === true)
  return r.message
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/**
 * 需要用户确认的工具：静态清单 + **运行时发现的 MCP 工具**。
 *
 * MCP 工具本质上是一段我们看不见的远程/进程内代码，能干任何事（写盘、发请求），
 * 所以默认按危险工具处理。用户想免确认，就用设置文件里的权限规则显式放行
 * （`mcp__server__tool` 或 `mcp__server__*`）。
 */
export function isDangerousTool(name) {
  return DANGEROUS_TOOLS.has(name) || String(name).startsWith('mcp__')
}

/**
 * 把运行时发现的 MCP 工具注册进工具集（替换上一次的 MCP 工具）。
 *
 * 为什么是"替换"而不是"追加"：MCP 服务器可能被移除/改配置，重连后工具清单会变；
 * 只追加会让已经消失的工具一直留在列表里（模型会去调用一个不存在的工具）。
 * @returns {number} 注册后的工具总数
 */
export function registerMcpTools(schemas) {
  const kept = TOOL_SCHEMAS.filter(s => !String(s.function.name).startsWith('mcp__'))
  const incoming = schemas.filter(s => String(s.function.name).startsWith('mcp__'))
  TOOL_SCHEMAS.length = 0
  TOOL_SCHEMAS.push(...kept, ...incoming)
  return TOOL_SCHEMAS.length
}

/** 当前注册进来的 MCP 工具名。 */
export function mcpToolNames() {
  return TOOL_SCHEMAS.filter(s => String(s.function.name).startsWith('mcp__')).map(s => s.function.name)
}

/** OpenAI function-calling 格式的 schema（发往 DeepSeek）。 */
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: '读取工作区内的文本文件，带行号输出。用于查看源码、配置等。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件路径（相对工作区或绝对）' },
          offset: { type: 'number', description: '起始行（从 1 开始，可选）' },
          limit: { type: 'number', description: '读取行数（可选）' },
          pages: { type: 'string', description: 'PDF 页码范围，如 "1-5"（仅 PDF 生效）' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: '创建或覆盖文件。危险操作，需用户确认。界面会展示 diff。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: '精确字符串替换编辑。old_string 必须唯一匹配。危险操作，需用户确认。界面会展示 diff。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: '为 true 时替换全部匹配（默认要求唯一）' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'NotebookEdit',
      description: '编辑 Jupyter notebook（.ipynb）的单元格。危险操作，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: '.ipynb 文件路径' },
          cell_id: { type: 'string', description: '目标 cell id（replace/delete/insert 用）' },
          new_source: { type: 'string', description: '新的 cell 源码' },
          cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'cell 类型' },
          edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: '编辑模式' },
        },
        required: ['notebook_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: '在工作区执行 shell 命令（默认 30 秒超时，可配）。危险操作，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout: { type: 'number', description: '超时毫秒数（前台模式），默认 30000，上限 600000' },
          run_in_background: { type: 'boolean', description: 'true 时立即返回任务 ID 不等待完成；输出用 TaskOutput(taskId) 轮询，TaskStop(taskId) 终止' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'PowerShell',
      description: '在 Windows 上执行 PowerShell 命令。危险操作，需用户确认。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'PowerShell 命令' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'REPL',
      description: '在受限沙箱中执行一段 JavaScript（5 秒超时），返回 console 输出与表达式结果。危险操作，需用户确认。',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '要执行的 JS 片段' } },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: '在工作区内按正则搜索文件内容（参数名对齐 CLI Grep）。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '限定搜索的文件或目录（可选）' },
          glob: { type: 'string', description: '文件名过滤，如 "*.ts"（可选）' },
          type: { type: 'string', description: '文件类型过滤（与 glob 同义，可选）' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: '输出形态，默认 content',
          },
          context: { type: 'number', description: '每处匹配附带的前后行数（上限 10）' },
          multiline: { type: 'boolean', description: '是否让 . 匹配换行（跨行模式）' },
          head_limit: { type: 'number', description: '最多返回多少条（上限 50）' },
          offset: { type: 'number', description: '跳过前 N 条' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: '按 glob 模式匹配工作区内文件路径。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '如 "**/*.ts"' },
          path: { type: 'string', description: '限定搜索目录（可选）' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'LS',
      description: '列出目录内容。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description:
        '抓取指定 URL 的内容（HTML 自动转纯文本）。传入 prompt 时会用模型按该 prompt 提炼要点。只读，不修改文件。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 http(s) 地址' },
          prompt: { type: 'string', description: '想从页面中提取什么信息（可选）' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: '用关键词做网络搜索，返回标题、链接与摘要。需要页面详情时再用 WebFetch 抓取。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          allowed_domains: { type: 'array', items: { type: 'string' }, description: '只保留这些域名（可选）' },
          blocked_domains: { type: 'array', items: { type: 'string' }, description: '排除这些域名（可选）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Agent',
      description:
        '派生一个只读子代理去独立完成调研型子任务（可读文件、搜索、抓网页），返回其结论。适合并行/独立的探查工作。',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '子任务简述（3-5 词）' },
          prompt: { type: 'string', description: '交给子代理的完整任务说明' },
          subagent: {
            type: 'string',
            description: '具名子代理（可选；在界面"子代理"面板里配好的名字，可指定另一种模型 / 更小的只读工具集）',
          },
        },
        required: ['description', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'AskUserQuestion',
      description:
        '在执行过程中向用户提选择题，用于收集偏好、澄清歧义、确认方向。用户始终可以选择「其他」自由作答。',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1-4 个问题',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '完整问题，以问号结尾' },
                header: { type: 'string', description: '不超过 12 字的短标签' },
                multiSelect: { type: 'boolean', description: '是否允许多选' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['label', 'description'],
                  },
                },
              },
              required: ['question', 'header', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'PlanEnter',
      description:
        '进入计划模式：只做只读探查并设计方案，不改文件、不执行有副作用的命令，完成后用 PlanExit 提交计划等待批准。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'PlanExit',
      description: '退出计划模式并把实现方案提交给用户批准。批准后即可开始实施。',
      parameters: {
        type: 'object',
        properties: { plan: { type: 'string', description: '给用户审阅的实现方案（Markdown）' } },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TodoWrite',
      description: '更新任务清单。状态：pending / in_progress / completed。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TaskCreate',
      description: '创建一条会话级任务，用于跟踪多步工作的进度。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '任务标题（祈使句）' },
          description: { type: 'string', description: '任务详情与验收标准' },
          activeForm: { type: 'string', description: '进行中时的展示文案（可选）' },
          metadata: { type: 'object', description: '任意附加元数据（可选）' },
        },
        required: ['subject', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TaskGet',
      description: '按 id 读取单条任务的完整信息。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TaskList',
      description: '列出当前所有任务及其状态。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TaskUpdate',
      description: '更新任务状态或字段（status / subject / description / owner）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string', description: 'pending / in_progress / completed' },
          subject: { type: 'string' },
          description: { type: 'string' },
          activeForm: { type: 'string' },
          owner: { type: 'string' },
          metadata: { type: 'object' },
          addBlocks: { type: 'array', items: { type: 'string' }, description: '追加被本任务阻塞的任务 id' },
          addBlockedBy: { type: 'array', items: { type: 'string' }, description: '追加阻塞本任务的任务 id' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TaskStop',
      description: '停止一条任务。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TaskOutput',
      description: '读取任务的当前输出/状态快照。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TeamCreate',
      description: '创建一个会话级团队，便于后续用 SendMessage 分派协作消息。',
      parameters: {
        type: 'object',
        properties: {
          team_name: { type: 'string' },
          description: { type: 'string' },
          agent_type: { type: 'string', description: '成员类型（可选）' },
        },
        required: ['team_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'TeamDelete',
      description: '解散当前会话团队。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'SendMessage',
      description: '向团队成员发送消息（会话级消息记录）。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '成员名' },
          message: { type: 'string' },
          summary: { type: 'string', description: '5-10 词摘要' },
        },
        required: ['to', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'SendUserMessage',
      description: '向用户界面直接推送一条提示（不产生新回合）。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          attachments: { type: 'array', items: { type: 'object' }, description: '附件引用（可选）' },
          status: { type: 'string', enum: ['info', 'warning', 'error'], description: '提示级别' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Skill',
      description: '列出可用技能，或按名称载入某个技能的内容（CLI 内置技能或 SKILL.md 技能）以获取其工作流说明。',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名；省略或传 "list" 则列出全部' },
          args: { type: 'string', description: '传给技能的参数（可选）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ToolSearch',
      description:
        '按关键词检索工具，并启用命中的延迟工具（下一轮即可调用）。' +
        '部分工具默认不随请求发送以节省开销，需要时先搜一次。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词（中英文均可）' },
          max_results: { type: 'number', description: '最多返回多少个（默认 25，上限 50）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Config',
      description: '读写会话设置：theme / model / permissionMode / outputStyle / workspace。',
      parameters: {
        type: 'object',
        properties: {
          setting: { type: 'string' },
          value: { description: '要写入的值；省略则为读取' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Sleep',
      description: '等待指定时长（毫秒，上限 300000）。用于等待外部状态变化。',
      parameters: {
        type: 'object',
        properties: { duration_ms: { type: 'number' } },
        required: ['duration_ms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'CronCreate',
      description:
        '登记一个会话级定时任务，按周期自动触发一次新回合。schedule 支持 30s / 5m / 2h 或毫秒数（最小 5000）。危险操作，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          cron: { type: 'string', description: '周期表达式，如 "5m" / "30s" / "60000"' },
          prompt: { type: 'string', description: '每次触发时提交的内容' },
          durable: { type: 'boolean', description: '是否持久化（web 端仅记录标记）' },
          recurring: { type: 'boolean', description: 'false 表示只触发一次' },
        },
        required: ['cron', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'CronList',
      description: '列出本会话已登记的定时任务（id / 周期 / 内容）。只读。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'CronDelete',
      description: '按 id 取消一个定时任务。id 由 CronCreate 返回或用 CronList 查看。危险操作，需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要取消的定时任务 id' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'StructuredOutput',
      description: '把结构化结果（JSON）原样回传，供程序化消费。',
      parameters: {
        type: 'object',
        properties: { data: {}, schema: {} },
        required: ['data'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ComputerScreenshot',
      description: '截取当前屏幕（缩放到最大宽 1280px）并以图片附入上下文，让你能看到用户的桌面。需要 Computer Use 总开关。',
      parameters: {
        type: 'object',
        properties: {
          maxWidth: { type: 'number', description: '截图最大宽度（默认 1280）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ComputerControl',
      description: '控制用户桌面：移动鼠标、单击/双击/右键、滚轮、输入文字（支持中文）、按键（如 ctrl+s）。每次操作都会请求用户确认。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'move / click / doubleClick / rightClick / scroll / type / press' },
          x: { type: 'number', description: '目标横坐标（虚拟屏幕像素，move/click 类必填）' },
          y: { type: 'number', description: '目标纵坐标' },
          amount: { type: 'number', description: 'scroll 滚动量（正上负下）' },
          text: { type: 'string', description: 'type 要输入的文字（支持中文）' },
          key: { type: 'string', description: 'press 要按的键，如 enter / ctrl+s / alt+tab' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'PreviewUrl',
      description: '在用户的预览面板中打开一个本机 URL（用于展示你刚启动的 dev server / 页面）。仅支持 localhost。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http://localhost:端口/...' },
        },
        required: ['url'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'mcp',
      description:
        '调用 MCP 服务器提供的工具（通用入口）。已发现的 MCP 工具会以 mcp__<服务器>__<工具> 的形式' +
        '单独出现在工具集里，能用那个就直接用；这个入口适合名字不固定或临时调用。',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string' }, tool: { type: 'string' }, args: {} },
        required: ['server', 'tool'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'McpPrompt',
      description: '取 MCP 服务器暴露的提示词模板（prompts/get），返回渲染后的提示词文本。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP 服务器名' },
          name: { type: 'string', description: '模板名' },
          arguments: { type: 'object', description: '模板参数（键值对）' },
        },
        required: ['server', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'McpRegistrySearch',
      description: '在官方 MCP registry 里搜索可接入的服务器（返回名字与描述列表）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ListMcpResourcesTool',
      description: '列出已连接的 MCP 服务器上的资源。省略 server 则列出全部服务器。',
      parameters: { type: 'object', properties: { server: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ReadMcpResource',
      description: '读取 MCP 服务器上的某个资源（uri 用 ListMcpResourcesTool 拿到的那个）。',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string' }, uri: { type: 'string' } },
        required: ['server', 'uri'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'McpAuth',
      description:
        'MCP 服务器鉴权。web 端没有 OAuth 回调流程，此工具不可用 —— 需要凭证的服务器请在 ' +
        'mcpServers 配置里用 headers 传固定 token。',
      parameters: { type: 'object', properties: { server: { type: 'string' } }, required: ['server'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'EnterWorktree',
      description:
        '创建一个隔离的 git worktree，并把本会话的沙箱根切换过去（只在用户明确提到 worktree 时使用）。' +
        '在 <仓库>/.limkenion/worktrees/ 下基于 HEAD 建新分支。注意：切换后原目录不再可访问，' +
        '且未受版本控制的目录（node_modules 等）不会被带过去。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'worktree 名称（可选）。以 / 分隔的每段只能包含字母、数字、点、下划线和短横线，总长 ≤ 64；省略则随机生成。',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ExitWorktree',
      description:
        '退出当前 worktree：把会话的沙箱根还原，并按需移除 worktree 目录。' +
        '若目录里有未提交的改动或未合并的提交，remove 会**拒绝**并列出会丢什么 —— ' +
        '确认要丢弃时再带 discard_changes:true。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['keep', 'remove'],
            description: 'keep 保留目录（默认）、remove 删除目录',
          },
          discard_changes: {
            type: 'boolean',
            description:
              '当 action 为 "remove" 且 worktree 里有未提交改动或未合并提交时，必须为 true；' +
              '否则工具会拒绝并列出这些改动，不会替你丢东西。',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Workflow',
      description:
        '执行一段动态工作流脚本，用 agent() / parallel() / pipeline() / phase() / log() 编排多个子代理。' +
        '子代理是只读的（与 Agent 工具同一套机制）。会花费大量 token，只在确实需要"并行派多个子代理"时使用。' +
        '脚本可以以 `export const meta = { name, description }` 开头（会被自动处理）。',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description:
              '自包含的工作流脚本。可用原语：agent(prompt, {label}) 返回子代理结论；' +
              'parallel([() => …]) 并发；pipeline(items, ...stages) 多阶段；phase(name) 标记阶段；log(...) 记日志。',
          },
          scriptPath: {
            type: 'string',
            description: '磁盘上的脚本路径（必须在工作区沙箱内）。优先级高于 script。',
          },
          name: { type: 'string', description: '运行名（仅用于展示）。' },
          args: { description: '作为全局 `args` 逐字暴露给脚本的输入值。' },
          title: { type: 'string', description: '已忽略 —— 请在 meta 里设置标题。' },
          description: { type: 'string', description: '已忽略 —— 请在 meta 里设置描述。' },
          resumeFromRunId: {
            type: 'string',
            description: '要续跑的运行 ID。prompt 未变的 agent() 会直接复用缓存结果，只重跑变化的那些。',
          },
        },
        required: [],
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 执行分发
// ---------------------------------------------------------------------------

/**
 * 执行一次工具调用。
 * @param {string} rawName 工具名（可能是改名前的旧名，内部归一化成新名）
 * @param {object} input 已解析的输入
 * @param {object} ctx 执行上下文：{ session, emit, requestPermission, askQuestions, runSubAgent,
 *                      summarize, scheduleCron, applySetting }
 * @returns {Promise<string | { text: string, diff?: string }>}
 */
export async function executeTool(rawName, input, ctx) {
  const session = ctx?.session
  // 工具名归一化：**唯一**的入口就在这里。
  // 改名过的工具（EnterPlanMode → PlanEnter、ExitPlanMode → PlanExit）无论模型输出旧名、还是权限规则里
  // 写着旧名，都在这里统一折成新名，后面的 switch 只需要认新名。
  const name = canonicalToolName(rawName)
  // MCP 工具是**运行时发现**的，名字形如 mcp__<服务器>__<工具>，进不了静态 switch。
  // 认前缀分派；危险工具判定那类地方也按前缀放行（见 DANGEROUS_TOOLS 的说明）。
  if (name.startsWith('mcp__')) {
    if (typeof ctx?.callMcpTool !== 'function') {
      throw new Error(`MCP 客户端未挂载，无法调用 ${name}`)
    }
    return ctx.callMcpTool(name, input ?? {})
  }
  switch (name) {
    // 文件类
    case 'Read': return toolRead(input)
    case 'Write': return toolWrite(input, ctx?.session)
    case 'Edit': return toolEdit(input, ctx?.session)
    case 'NotebookEdit': return toolNotebookEdit(input)
    case 'Grep': return toolGrep(input)
    case 'Glob': return toolGlob(input)
    case 'LS': return toolLS(input)
    // 执行类
    case 'Bash': return toolBash(input, ctx?.session)
    case 'PowerShell': return toolPowerShell(input)
    case 'REPL': return toolREPL(input)
    // 网络类
    case 'WebFetch': return toolWebFetch(input, ctx)
    case 'WebSearch': return toolWebSearch(input, ctx)
    // 协作类
    case 'Agent': return toolAgent(input, ctx)
    case 'TeamCreate': return toolTeamCreate(input, session)
    case 'TeamDelete': return toolTeamDelete(input, session)
    case 'SendMessage': return toolSendMessage(input, ctx)
    case 'SendUserMessage': return toolSendUserMessage(input, ctx)
    // 任务类
    case 'TodoWrite': return toolTodoWrite(input, session)
    case 'TaskCreate': return toolTaskCreate(input, session)
    case 'TaskGet': return toolTaskGet(input, session)
    case 'TaskList': return toolTaskList(input, session)
    case 'TaskUpdate': return toolTaskUpdate(input, session)
    case 'TaskStop': return toolTaskStop(input, session)
    case 'TaskOutput': return toolTaskOutput(input, session)
    // 流程类
    case 'PlanEnter': return toolPlanEnter(input, ctx)
    case 'PlanExit': return toolPlanExit(input, ctx)
    case 'AskUserQuestion': return toolAskUserQuestion(input, ctx)
    case 'Sleep': return toolSleep(input)
    case 'CronCreate': return toolCronCreate(input, ctx)
    case 'CronList': return toolCronList(input, ctx)
    case 'CronDelete': return toolCronDelete(input, ctx)
    // 配置 / 元
    case 'Config': return toolConfig(input, ctx)
    case 'Skill': return toolSkill(input)
    case 'ToolSearch': return toolToolSearch(input, ctx)
    case 'StructuredOutput': return toolStructuredOutput(input)
    // 降级
    // MCP：真实现（见 mcp.mjs）。发现的工具是 mcp__server__tool 形式，走下面的前缀分支。
    case 'mcp': return toolMcpGeneric(input, ctx)
    case 'McpPrompt': return toolMcpPrompt(input, ctx)
    case 'McpRegistrySearch': return toolMcpRegistrySearch(input, ctx)
    case 'ListMcpResourcesTool': return toolListMcpResources(input, ctx)
    case 'ReadMcpResource': return toolReadMcpResource(input, ctx)
    case 'McpAuth': return toolMcpAuth(input, ctx)
    case 'ComputerScreenshot': return toolComputerScreenshot(input)
    case 'ComputerControl': return toolComputerControl(input)
    case 'PreviewUrl': return toolPreviewUrl(input, ctx)
    case 'EnterWorktree': return toolEnterWorktree(input, session)
    case 'ExitWorktree': return toolExitWorktree(input, session)
    case 'Workflow': return toolWorkflow(input, ctx)
    default: throw new Error(`未知工具：${name}`)
  }
}

/** 子代理可用的只读工具名集合（供 index.mjs 过滤）。 */
export function isSubAgentTool(name) {
  return SUBAGENT_TOOLS.has(name)
}

/** 给前端一行摘要用的紧凑输入描述。 */
export function summarizeToolInput(name, input) {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return `${input.file_path ?? ''}${input.replace_all ? ' (全部替换)' : ''}`
    case 'NotebookEdit':
      return `${input.notebook_path ?? ''}${input.edit_mode ? ` (${input.edit_mode})` : ''}`
    case 'Bash':
      return input.command?.slice(0, 80) ?? ''
    case 'PowerShell':
      return input.command?.slice(0, 80) ?? ''
    case 'REPL':
      return (input.code ?? '').replace(/\s+/g, ' ').slice(0, 80)
    case 'Grep': {
      const filter = input.glob ?? input.type
      return `/${input.pattern ?? ''}/${filter ? ' ' + filter : ''}`
    }
    case 'Glob':
      return input.pattern ?? ''
    case 'LS':
      return input.path ?? '.'
    case 'WebFetch':
      return input.url ?? ''
    case 'WebSearch':
      return input.query ?? ''
    case 'Agent':
      return input.description ?? ''
    case 'AskUserQuestion':
      return (input.questions ?? []).map(q => q.header ?? q.question).join(' / ').slice(0, 80)
    case 'PlanEnter':
      return '进入计划模式'
    case 'PlanExit':
      return (input.plan ?? '').split('\n')[0].slice(0, 80)
    case 'TaskCreate':
      return input.subject ?? ''
    case 'TaskGet':
    case 'TaskUpdate':
    case 'TaskStop':
      return `#${input.task_id ?? input.taskId ?? ''}`
    case 'TaskOutput':
      return `#${input.task_id ?? input.taskId ?? ''}`
    case 'TaskList':
      return '列出任务'
    case 'TeamCreate':
      return input.team_name ?? input.name ?? ''
    case 'TeamDelete':
      return '解散团队'
    case 'SendMessage':
      return `→ ${input.to ?? ''}`
    case 'SendUserMessage':
      return (input.message ?? '').slice(0, 80)
    case 'Skill':
      return input.skill ?? input.commandName ?? 'list'
    case 'ToolSearch':
      return input.query ?? ''
    case 'Config':
      return `${input.setting ?? ''}${input.value !== undefined ? ` = ${input.value}` : ''}`
    case 'Sleep':
      return `${input.duration_ms ?? input.durationMs ?? '?'}ms`
    case 'CronCreate':
      return `${input.cron ?? input.schedule ?? ''} · ${(input.prompt ?? '').slice(0, 40)}`
    case 'StructuredOutput':
      return '结构化输出'
    case 'TodoWrite': {
      const todos = input.todos ?? []
      return `${todos.filter(t => t.status === 'completed').length}/${todos.length} 已完成`
    }
    default:
      return JSON.stringify(input ?? {}).slice(0, 80)
  }
}

export { existsSync, unifiedDiff }
