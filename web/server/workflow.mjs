/**
 * 动态工作流（Workflow 工具）：用一段脚本编排多个子代理。
 *
 * CLI 那边是 `utils/workflows/`（17 文件 / 3,007 行：compile / harness / runtime /
 * runWorkflowAgent / journal / limiter…）+ `tools/WorkflowTool/`（1,190 行），
 * 支持 `agent()/parallel()/pipeline()/phase()`，可以一次性派几十个子代理
 * （规模指引 small 5 / medium 15 / large 50），有 journal 断点续跑。
 *
 * web 端这里实现**真能跑的子集**，语义尽量对齐，差异如实说明：
 *
 *   ✅ `agent(prompt, opts?)`  → 一个**只读**子代理（与 Agent 工具同一套机制）
 *   ✅ `parallel(thunks)`      → 并发执行，受并发上限约束
 *   ✅ `pipeline(items, ...stages)` → 每个 item 顺序跑各阶段，item 之间并行
 *   ✅ `phase(name)` / `log(msg)` → 过程可见（广播 notice + 记进 journal）
 *   ✅ journal：落盘到 `<state>/workflows/<runId>.json`；`resume_from` 复用已完成的 agent
 *   ❌ 子代理**不能写文件**（web 的 Agent 本来就是只读的）、没有 plugin 工作流、
 *      没有 tmux/远端执行、不认 CLI 的 `.limkenion/workflows/*.md` 预定义脚本
 *
 * 两条安全约束（这块等于"让模型写代码在本进程里跑"，必须设死）：
 *
 * 1. **沙箱**：脚本在 `node:vm` 的干净上下文里跑 —— 没有 `require`、`process`、
 *    `fs`、`fetch`，只有注入的那几个原语。脚本拿不到宿主能力。
 * 2. **预算**：`agent()` 调用次数有硬上限（默认 12，最多 50）。一个写错的脚本
 *    能烧掉的钱是有天花板的，而且到顶会明确报错，不会静默跑飞。
 *
 * **已知限制（如实写在这里，别假装没有）**：`node:vm` 不是安全边界，
 * 而且脚本里如果写同步死循环（`while(true){}`），会**卡住整个服务**。
 * 顶层同步段有 5 秒超时兜底（超过就把这个 run 判失败），但 `await` 之后的
 * 同步死循环兜不住 —— 与 CLI 一样（它也是在进程内跑工作流脚本）。
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { STATE_DIR } from './sessions.mjs'

export const WORKFLOWS_DIR = join(STATE_DIR, 'workflows')

/** 预算：一次工作流最多派多少个子代理。 */
export const DEFAULT_MAX_AGENTS = 12
export const HARD_MAX_AGENTS = 50
/** 并发上限：同时跑几个子代理（子代理本身要发 API 请求，别一把全放出去）。 */
export const DEFAULT_CONCURRENCY = 4
/** 顶层同步段（到第一个 await 之前）的执行上限，兜住 `while(true){}` 这种。 */
const SYNC_TIMEOUT_MS = 5000

/** 内存里的运行记录（`/workflows` 实时看进度用；落盘的那份是 journal）。 */
const runs = new Map()
/** 内存里保留的运行记录上限（超了淘汰最旧的；journal 在盘上，不丢数据）。 */
const MAX_RUNS_IN_MEMORY = 50

function newRunId() {
  return 'wf-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6)
}

/** 简单并发闸门。 */
function limiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--
        next()
      })
  }
  return fn =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
}

/**
 * 归一化脚本：CLI 的工作流脚本以 `export const meta = { name, description, phases }`
 * 开头（纯字面量），而我们要把脚本体包进一个 async 函数里 —— 函数体里不能有 `export`，
 * 直接塞进去是**语法错误**。所以把 `export ` 去掉，并把 meta 抓出来用。
 */
function normalizeScript(raw) {
  let src = String(raw ?? '')
  const meta = extractMeta(src)
  src = src.replace(/^\s*export\s+/gm, '')
  return { src, meta }
}

/**
 * 抓出 `export const meta = { ... }` 里的对象。
 *
 * 用花括号配平扫描，**不能用惰性正则**：meta 可能写在一行（`{ name: 'x' }`），
 * 也可能多行；`[\s\S]*?\n\}` 这种写法碰到单行就完全匹配不上（踩过）。
 */
function extractMeta(src) {
  const start = src.search(/export\s+const\s+meta\s*=\s*\{/)
  if (start < 0) return null
  const open = src.indexOf('{', start)
  let depth = 0
  let inStr = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === inStr) inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          // meta 约定是纯字面量，用 vm 求值最省事（不引入新依赖）
          return vm.runInNewContext(`(${src.slice(open, i + 1)})`, {}, { timeout: 1000 })
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * 跑一个工作流脚本。
 *
 * @param {object} opts
 * @param {string} opts.script 工作流脚本（用 agent/parallel/pipeline/phase/log 原语）
 * @param {string} [opts.name] 运行名（只用于展示）
 * @param {string} [opts.resumeFrom] 复用某次运行的已完成 agent 结果
 * @param {number} [opts.maxAgents] 子代理上限
 * @param {unknown} [opts.args] 逐字暴露给脚本的 `args` 全局
 * @param {(prompt: string, description: string) => Promise<string>} opts.runAgent 子代理执行器（引擎注入）
 * @param {(msg: string) => void} [opts.emit] 过程通知
 * @param {string} [opts.sessionId]
 */
export async function runWorkflow({
  script,
  name,
  resumeFrom,
  maxAgents,
  args,
  runAgent,
  emit = () => {},
  sessionId,
}) {
  const raw = String(script ?? '')
  if (!raw.trim()) throw new Error('script 不能为空')
  if (typeof runAgent !== 'function') throw new Error('当前服务端未挂载子代理执行器（runAgent 缺失）')

  const { src, meta } = normalizeScript(raw)

  const budget = Math.min(
    HARD_MAX_AGENTS,
    Math.max(1, Number.isFinite(Number(maxAgents)) && Number(maxAgents) > 0 ? Math.floor(Number(maxAgents)) : DEFAULT_MAX_AGENTS),
  )

  const runId = newRunId()
  /**
   * `phases/logs/agents` 写成 `[]` 会被推断成 `never[]`（后面每一次 push 都报错），
   * `finishedAt/error/status` 写成 null / 'running' 会被推断成 **字面量类型 null / 'running'**
   * （于是"改成别的值"也报错）。一次性标清楚。
   *
   * @type {{runId: string, name: string, description: string|null, sessionId: string|null,
   *   startedAt: number, finishedAt: number|null, status: string,
   *   phases: Array<{name: string, at: number}>, logs: string[],
   *   agents: Array<{id: number, prompt: string, label: string|undefined,
   *     status: string, result: any}>,
   *   error: string|null, budget: any, tokensUsed: number, result?: string}}
   */
  const run = {
    runId,
    name: (name ? String(name) : null) || (meta?.name ? String(meta.name) : null) || '工作流',
    description: meta?.description ? String(meta.description) : null,
    sessionId: sessionId ?? null,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    phases: [],
    logs: [],
    agents: [],
    error: null,
    budget,
    tokensUsed: 0,
  }
  runs.set(runId, run)
  // 内存里的运行记录要有上限：长驻服务会跑很多次工作流，只增不删就成了泄漏。
  // 淘汰最旧的**只从内存移除** —— journal 已落盘，loadRun() 会回退读盘，数据不丢。
  if (runs.size > MAX_RUNS_IN_MEMORY) {
    const oldest = [...runs.keys()].slice(0, runs.size - MAX_RUNS_IN_MEMORY)
    for (const k of oldest) runs.delete(k)
  }

  // ---- 复用上次运行里已完成的 agent（按 prompt 匹配），模拟 CLI 的断点续跑 ----
  const reusable = new Map()
  if (resumeFrom) {
    const prev = await loadRun(resumeFrom)
    if (!prev) throw new Error(`找不到要续跑的运行：${resumeFrom}`)
    for (const a of prev.agents ?? []) {
      if (a.status === 'done') reusable.set(a.prompt, a.result)
    }
    run.logs.push(`续跑自 ${resumeFrom}：复用 ${reusable.size} 个已完成的子代理结果`)
  }

  const gate = limiter(DEFAULT_CONCURRENCY)
  let agentSeq = 0

  /** agent()：派一个只读子代理。 */
  const agent = async (prompt, opts = {}) => {
    const p = String(prompt ?? '').trim()
    if (!p) throw new Error('agent() 需要一个非空 prompt')
    const label = opts.label ? String(opts.label) : undefined

    if (reusable.has(p)) {
      const cached = reusable.get(p)
      run.agents.push({ id: ++agentSeq, prompt: p, label, status: 'reused', result: cached })
      emit(`[workflow] 复用已有结果：${label ?? p.slice(0, 40)}`)
      return cached
    }
    if (run.agents.length >= budget) {
      throw new Error(
        `工作流已达子代理上限（${budget} 个）。把任务拆小，或用 max_agents 明确提高上限（最多 ${HARD_MAX_AGENTS}）。`,
      )
    }

    const id = ++agentSeq
    /** `result: null` 会被推断成字面量类型 `null`，之后赋字符串就报错 —— 标出来。 */
    const rec = /** @type {{id: number, prompt: string, label: string|undefined, status: string, result: any}} */ ({
      id, prompt: p, label, status: 'running', result: null,
    })
    run.agents.push(rec)
    emit(`[workflow] 派子代理 #${id}：${label ?? p.slice(0, 40)}`)
    try {
      const text = await gate(() => runAgent(p, label ?? `工作流子代理 #${id}`))
      rec.status = 'done'
      rec.result = text
      return text
    } catch (err) {
      rec.status = 'error'
      rec.result = `（子代理失败：${String(err?.message ?? err)}）`
      throw err
    }
  }

  /** parallel()：并发执行（受并发上限约束）。 */
  const parallel = async thunks => {
    if (!Array.isArray(thunks)) throw new Error('parallel() 需要一个函数数组')
    return Promise.all(
      thunks.map((t, i) => {
        if (typeof t !== 'function') throw new Error(`parallel() 的第 ${i + 1} 项不是函数`)
        return Promise.resolve().then(t)
      }),
    )
  }

  /** pipeline()：每个 item 顺序跑各阶段，item 之间并行。 */
  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new Error('pipeline() 的第一个参数应当是数组')
    for (const [i, s] of stages.entries()) {
      if (typeof s !== 'function') throw new Error(`pipeline() 的第 ${i + 1} 个阶段不是函数`)
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value = item
        for (const stage of stages) {
          value = await stage(value, index)
        }
        return value
      }),
    )
  }

  const phase = name2 => {
    const label = String(name2 ?? '').trim() || '（未命名阶段）'
    run.phases.push({ name: label, at: Date.now() })
    emit(`[workflow] 阶段：${label}`)
    return label
  }

  const log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' ')
    run.logs.push(line)
    emit(`[workflow] ${line}`)
  }

  // ---- 沙箱：只有下面这些能进脚本上下文 ----
  const sandbox = {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    // `args` 逐字暴露（与 CLI 一致：传进来的数组/对象保持原样，不要 JSON 字符串）
    args: args ?? {},
    console: { log, error: log, warn: log },
    JSON,
    Math,
    Date,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Error,
    setTimeout: undefined, // 显式去掉：脚本不需要计时器，留着只会拖长运行
  }
  const context = vm.createContext(sandbox, { name: `workflow:${runId}` })

  // 包成 async 函数；返回值就是这个工作流的结果
  const wrapped = `(async () => {\n${src}\n})()`

  try {
    // runInContext 的 timeout 只管**同步段**（到第一个 await 之前）。
    // 它能兜住顶层 `while(true){}`，兜不住 await 之后的同步死循环 —— 注释里写清了。
    const promise = vm.runInContext(wrapped, context, {
      timeout: SYNC_TIMEOUT_MS,
      filename: `${runId}.workflow.mjs`,
    })
    const result = await promise
    run.status = 'done'
    run.result = typeof result === 'string' ? result : safeJson(result)
  } catch (err) {
    run.status = 'error'
    run.error = String(err?.message ?? err)
  } finally {
    run.finishedAt = Date.now()
    void persistRun(run)
  }

  if (run.status === 'error') {
    throw new Error(
      `工作流执行失败：${run.error}\n` +
        `已经跑完的子代理：${run.agents.filter(a => a.status === 'done' || a.status === 'reused').length} 个` +
        `（用 /workflows show ${runId} 看详情，或用 resume_from="${runId}" 复用已完成的结果）。`,
    )
  }
  return run
}

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** 落盘 journal。 */
async function persistRun(run) {
  try {
    await mkdir(WORKFLOWS_DIR, { recursive: true })
    await writeFile(join(WORKFLOWS_DIR, `${run.runId}.json`), JSON.stringify(run, null, 1), 'utf8')
  } catch (err) {
    console.warn('工作流 journal 写盘失败：', String(err))
  }
}

/** 读某次运行（先看内存，再看盘）。 */
export async function loadRun(runId) {
  if (runs.has(runId)) return runs.get(runId)
  try {
    return JSON.parse(await readFile(join(WORKFLOWS_DIR, `${runId}.json`), 'utf8'))
  } catch {
    return null
  }
}

/** 最近的运行（内存 + 盘上合并，按时间倒序）。 */
export async function listRuns(limit = 20) {
  const merged = new Map()
  try {
    const names = (await readdir(WORKFLOWS_DIR)).filter(n => n.endsWith('.json'))
    for (const n of names) {
      const id = n.replace(/\.json$/, '')
      try {
        merged.set(id, JSON.parse(await readFile(join(WORKFLOWS_DIR, n), 'utf8')))
      } catch { /* 坏文件跳过 */ }
    }
  } catch { /* 目录还不存在 */ }
  for (const [id, r] of runs) merged.set(id, r)
  return [...merged.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, limit)
}

/** 当前有没有正在跑的工作流（`/workflows` 摘要用）。 */
export function activeRunCount() {
  return [...runs.values()].filter(r => r.status === 'running').length
}

/** 一次运行的摘要文字。 */
export function formatRun(run, { verbose = false } = {}) {
  const done = run.agents?.filter(a => a.status === 'done' || a.status === 'reused').length ?? 0
  const failed = run.agents?.filter(a => a.status === 'error').length ?? 0
  const head =
    `${run.runId}　${run.status}` +
    `　子代理 ${done}/${run.agents?.length ?? 0}${failed ? `（失败 ${failed}）` : ''}` +
    `　阶段 ${run.phases?.length ?? 0}` +
    `　${run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : ''}`
  if (!verbose) return head
  const lines = [head, `名称：${run.name}`]
  if (run.phases?.length) lines.push('阶段：' + run.phases.map(p => p.name).join(' → '))
  if (run.agents?.length) {
    lines.push('子代理：')
    for (const a of run.agents) {
      lines.push(`  #${a.id} [${a.status}] ${(a.label ?? a.prompt).slice(0, 60)}`)
      if (a.result) lines.push(`      结果：${String(a.result).slice(0, 300)}`)
    }
  }
  if (run.logs?.length) lines.push('日志：', ...run.logs.slice(-20).map(l => '  ' + l))
  if (run.error) lines.push(`错误：${run.error}`)
  if (run.result) lines.push(`最终结果：${String(run.result).slice(0, 1200)}`)
  return lines.join('\n')
}

/** `/workflows` 命令输出。 */
export async function workflowsSummary() {
  const list = await listRuns(20)
  const lines = [
    `工作流：记录 ${list.length} 条${activeRunCount() ? `，正在跑 ${activeRunCount()} 个` : ''}`,
    `脚本原语：agent(prompt, opts) / parallel([fn…]) / pipeline(items, ...stages) / phase(name) / log(...)`,
    `子代理是**只读**的（与 Agent 工具同一套机制）；预算：默认最多 ${DEFAULT_MAX_AGENTS} 个子代理、并发 ${DEFAULT_CONCURRENCY}`,
    '',
  ]
  if (list.length === 0) {
    lines.push('还没有跑过工作流。让模型用 Workflow 工具写一段脚本，或在对话里说明要"用工作流并行派子代理"。')
    return lines.join('\n')
  }
  lines.push('最近的运行：')
  lines.push(...list.map(r => '- ' + formatRun(r)))
  lines.push('', '用 /workflows show <runId> 看某次的详情。')
  return lines.join('\n')
}
