/**
 * hooks：工具执行前后的策略钩子（读 CLI 同款设置文件的 `hooks` 段）。
 *
 * CLI 的 `utils/hooks/` 是 17 个文件 / 3600 行、27 种事件、4 种执行方式
 * （command / prompt / agent / http）的子系统。web 端这里实现的是**能真用起来的子集**：
 *
 *   ✅ 事件：PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit /
 *           SessionStart / SessionEnd / Stop / SubagentStop
 *   ✅ 执行方式：command（本地跑命令，stdin 收 JSON、stdout 回 JSON）
 *   ❌ 其余 19 种事件、prompt / agent / http 三种执行方式 —— **如实列出来，不假装支持**
 *
 * 为什么不做 http：它要配 SSRF 防护（CLI 有独立的 `ssrfGuard.ts`），
 * 半做等于给用户一个能被内网打穿的入口。
 *
 * ## 协议（与 CLI 对齐，别自己发明）
 *
 * stdin：一行 JSON
 *   { session_id, cwd, hook_event_name, tool_name?, tool_input?, ... }
 * stdout：可选的 JSON
 *   { continue?: false, stopReason?, systemMessage?,
 *     decision?: 'approve'|'block', reason?,
 *     hookSpecificOutput?: {
 *       hookEventName: 'PreToolUse',
 *       permissionDecision?: 'allow'|'deny'|'ask',
 *       permissionDecisionReason?, updatedInput?, additionalContext? } }
 * 退出码：
 *   0 → 成功（stdout 有 JSON 就按上面的协议解读）
 *   2 → **阻断**，理由取 stderr（没有则取 stdout）
 *   其它非 0 → 错误（不阻断，只提示）
 *
 * ## 与权限系统的优先级（重要，别改乱）
 *
 *   1. PreToolUse 钩子**先跑**（这样审计类钩子能看到每一次调用，包括之后被拒的）
 *   2. 设置文件 `permissions.deny` 硬拦截 —— **钩子的 allow 不能覆盖它**
 *   3. shell 守卫硬拦截（灾难性命令）
 *   4. 钩子的 deny → 直接拒绝
 *   5. 权限判定：钩子的 allow 可以免确认，但**不能绕过 escalate**
 *      （升级确认的意义就是"这次不算数"，不可信内容/工作区外路径仍然要问）
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { settingsSources } from './settings.mjs'
import { workspaceRoot } from './paths.mjs'
import {
  ALL_HOOK_EVENTS,
  unknownAgainstContract,
} from './clicontract.mjs'

/**
 * web 端**真正接线**了的钩子事件。
 *
 * 这个清单是 web 自己的事实（实现了就是实现了），不能从 CLI 推出来，所以手写。
 * 但下面会拿它去和共享契约比对 —— 拼错了、或 CLI 改了名，启动时就能发现。
 */
export const HOOK_EVENTS_SUPPORTED = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStop',
]

/**
 * CLI 有定义、但 web 端没接线的事件。
 *
 * **不再手写**：从共享契约里的全量事件减去已支持的那些自动算出来。
 * 以前这里手抄了 19 个名字，CLI 加一个事件 web 就漏一个 —— 而漏了既不报错
 * 也不提示，用户只会觉得"我配的钩子怎么没反应"。
 */
export const HOOK_EVENTS_UNSUPPORTED = ALL_HOOK_EVENTS.filter(e => !HOOK_EVENTS_SUPPORTED.includes(e))

// 启动自检：web 声明支持的事件名，必须都在 CLI 契约里。
// 对不上只有两种可能 —— 这边拼错了，或 CLI 改名了。两种都值得立刻停下来看一眼，
// 否则用户配了个钩子却永远不触发，而且没有任何提示。
{
  const unknown = unknownAgainstContract('钩子事件', HOOK_EVENTS_SUPPORTED, ALL_HOOK_EVENTS)
  if (unknown.length > 0) {
    console.warn(
      `HOOK_EVENTS_SUPPORTED 里有 CLI 契约中不存在的事件名：${unknown.join('、')}\n` +
        '  要么是这边拼错了，要么是 CLI 改了名。重新生成契约：node scripts/gen-shared-contract.mjs',
    )
  }
}

/** 已支持的执行方式 / 未支持的执行方式。 */
export const HOOK_TYPES_SUPPORTED = ['command']
export const HOOK_TYPES_UNSUPPORTED = ['prompt', 'agent', 'http']

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 12_000

/**
 * 跑钩子用的 shell（返回 shell 可执行文件路径，交给 `spawn(cmd, { shell })`）。
 *
 * CLI 在 Windows 上钩子走 git-bash；web 端不能假定用户装了 git-bash，所以：
 *   LIMKENION_WEB_HOOK_SHELL 显式指定 > LIMKENION_GIT_BASH_PATH（CLI 已有的约定）> 平台默认。
 * `/hooks` 会把实际用的是哪个 shell 打出来 —— 钩子脚本写错了 shell 语法时，
 * 这句话能省掉半小时排查。
 *
 * 注意：**不要自己拼 `cmd.exe /d /s /c "..."`**。带引号的可执行路径
 * （`"D:\nodejs\node.exe" "script.mjs"`）在 cmd.exe 里会被引号规则拆坏，报
 * "不是内部或外部命令"。交给 `spawn(…, { shell })`，Node 自己会正确处理。
 */
export function hookShell() {
  const explicit = process.env.LIMKENION_WEB_HOOK_SHELL
  if (explicit) return { shell: explicit, label: explicit }
  const gitBash = process.env.LIMKENION_GIT_BASH_PATH
  if (process.platform === 'win32' && gitBash && existsSync(gitBash)) {
    return { shell: gitBash, label: `${gitBash}（git-bash）` }
  }
  if (process.platform === 'win32') return { shell: 'cmd.exe', label: 'cmd.exe' }
  return { shell: '/bin/sh', label: '/bin/sh' }
}

/** 归一化一份 hooks 配置：{ event: [{ source, matcher, entry }] }。 */
function readConfigs() {
  const out = []
  for (const { source, path, data } of settingsSources()) {
    const hooks = data?.hooks
    if (!hooks || typeof hooks !== 'object') continue
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        const entries = Array.isArray(group?.hooks) ? group.hooks : []
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue
          out.push({
            event,
            matcher: typeof group?.matcher === 'string' ? group.matcher : '',
            type: String(entry.type ?? 'command'),
            command: typeof entry.command === 'string' ? entry.command : '',
            timeout: entry.timeout,
            // CLI 的 `if` 条件表达式语法 web 端没实现：不静默忽略，单独标出来
            ifCondition: typeof entry.if === 'string' && entry.if.trim() ? entry.if.trim() : null,
            source,
            path,
          })
        }
      }
    }
  }
  return out
}

/**
 * 带 TTL 的配置缓存。
 *
 * 为什么要缓存：`runEventHooks()` 在一次工具调用里会被问两遍（Pre 与 Post），
 * 每次都重读 3 个设置文件太浪费。
 * 为什么用 TTL 而不是"加载一次"：用户改完 hooks 配置不必重启服务，
 * 但也不至于每次调用都去读盘 —— 3 秒的窗口够短，不至于让人以为"配置没生效"。
 */
const CONFIG_TTL_MS = 3_000

/**
 * 一条可执行的钩子配置。
 * @typedef {{event: string, matcher: string, type: string, command: string,
 *   timeout: number, ifCondition: string, source: string, path: string}} HookConfig
 */

/**
 * `list` 必须显式标类型：写成 `[]` 会被推断成 `never[]`，
 * 之后每一处 `hook.event` / `hook.command` 都会报「属性不存在于 never」——
 * 一次性冒出 20 多条报错，全是同一个根因。
 * @type {{at: number, list: HookConfig[]}}
 */
let configCache = { at: 0, list: [] }

/** 立即刷新（`/hooks`、`/reload-settings` 用）。 */
export function refreshHooks() {
  configCache = { at: Date.now(), list: readConfigs() }
  return configCache.list
}

function currentConfigs() {
  if (Date.now() - configCache.at > CONFIG_TTL_MS) refreshHooks()
  return configCache.list
}

/** 有没有任何**能生效**的钩子（引擎用它跳过整段钩子逻辑）。 */
export function hooksEnabled() {
  return currentConfigs().some(
    h => HOOK_EVENTS_SUPPORTED.includes(h.event) && HOOK_TYPES_SUPPORTED.includes(h.type) && h.command.trim() && !h.ifCondition,
  )
}

/**
 * matcher 是否命中该工具名（与 CLI 一致：正则；空 / `*` 表示全部）。
 * 正则非法视为不命中 —— `configuredHooks()` 会把它标成"不生效"并说明原因。
 */
function matcherHits(matcher, toolName) {
  const m = String(matcher ?? '').trim()
  if (!m || m === '*') return true
  try {
    return new RegExp(m).test(toolName)
  } catch {
    return false
  }
}

/**
 * 当前配置里"能生效"的钩子（供 /hooks 与 summary 使用）。
 * @returns {{event: string, matcher: string, type: string, source: string, usable: boolean, reason: string|null}[]}
 */
export function configuredHooks() {
  return currentConfigs().map(h => {
    let usable = true
    let reason = null
    if (!HOOK_EVENTS_SUPPORTED.includes(h.event)) {
      usable = false
      reason = '该事件 web 端未接线'
    } else if (!HOOK_TYPES_SUPPORTED.includes(h.type)) {
      usable = false
      reason = `执行方式 ${h.type} 未实现（只支持 command）`
    } else if (!h.command.trim()) {
      usable = false
      reason = '缺 command'
    } else if (h.ifCondition) {
      usable = false
      reason = '`if` 条件表达式未实现'
    } else if (h.matcher && h.matcher !== '*') {
      try {
        new RegExp(h.matcher)
      } catch {
        usable = false
        reason = `matcher 不是合法正则：${h.matcher}`
      }
    }
    return { event: h.event, matcher: h.matcher, type: h.type, source: h.source, usable, reason }
  })
}

/** 命中的、可执行的钩子（按事件 + 工具名过滤）。 */
function runnableHooks(event, toolName) {
  return currentConfigs().filter(
    h =>
      h.event === event &&
      HOOK_TYPES_SUPPORTED.includes(h.type) &&
      h.command.trim() &&
      !h.ifCondition &&
      matcherHits(h.matcher, toolName),
  )
}

/** 给用户/模型看的摘要文字（`/hooks` 命令用）。 */
export function hooksSummary() {
  const all = configuredHooks()
  const usable = all.filter(h => h.usable)
  const unusable = all.filter(h => !h.usable)
  const lines = [
    `钩子：配置 ${all.length} 个，其中生效 ${usable.length} 个`,
    `执行方式：只支持 command（prompt / agent / http 未实现）`,
    `已接线事件：${HOOK_EVENTS_SUPPORTED.join('、')}`,
    `未接线事件（${HOOK_EVENTS_UNSUPPORTED.length} 个）：${HOOK_EVENTS_UNSUPPORTED.join('、')}`,
    `执行钩子的 shell：${hookShell().label}`,
  ]
  if (usable.length > 0) {
    lines.push(
      '',
      '生效中的钩子：',
      ...usable.map(h => `- [${h.source}] ${h.event}${h.matcher ? ` (${h.matcher})` : ''} → ${h.type}`),
    )
  }
  if (unusable.length > 0) {
    // 这一节是刻意保留的：静默忽略一个用户以为在生效的钩子，比报错更难查
    lines.push('', '**配置了但不会生效的（别以为它在工作）**：')
    lines.push(...unusable.map(h => `- [${h.source}] ${h.event} (${h.type})：${h.reason}`))
  }
  if (all.length === 0) lines.push('', '（没有配置任何钩子）')
  return lines.join('\n')
}

/** 截断钩子输出，避免一条刷屏的钩子把上下文吃光。 */
function cap(text) {
  const s = String(text ?? '')
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n…（输出过长，已截断 ${s.length - MAX_OUTPUT_CHARS} 字）`
}

/**
 * 杀掉钩子进程（Windows 上要用 taskkill /T 杀整棵进程树）。
 *
 * 为什么不能只用 `child.kill()`：钩子是通过 shell 启动的（cmd.exe / sh），
 * `kill()` 只杀掉 shell 本身，真正的脚本进程会活下来并**继续占着 stdout 管道** ——
 * 于是 'close' 永远不触发。踩过一次：钩子超时后整个回合挂死。
 * 所以超时时**不等 'close'**，直接结算，再尽力把进程树杀掉。
 */
function killHookTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch { /* 已经退出了 */ }
}

/** 跑一个 command 钩子。 */
function runCommandHook(hook, hookInput, { cwd }) {
  const shell = hookShell()
  const seconds = Number(hook.timeout)
  const timeoutMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS

  return new Promise(resolveResult => {
    let child
    let settled = false
    const finish = res => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(res)
    }

    try {
      child = spawn(hook.command, [], {
        shell: shell.shell,
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          LIMKENION_PROJECT_DIR: cwd,
          LIMKENION_HOOK_EVENT: hookInput.hook_event_name,
        },
      })
    } catch (err) {
      resolveResult({ ok: false, code: null, stdout: '', stderr: '', error: String(err?.message ?? err) })
      return
    }

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      killHookTree(child)
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: `钩子超时（${timeoutMs}ms）已被终止`,
        timedOut: true,
      })
    }, timeoutMs)

    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    child.on('error', err => {
      finish({ ok: false, code: null, stdout, stderr, error: String(err?.message ?? err) })
    })
    child.on('close', code => {
      finish({ ok: code === 0, code, stdout, stderr, error: null })
    })

    try {
      child.stdin.write(JSON.stringify(hookInput) + '\n', 'utf8')
      child.stdin.end()
    } catch { /* 钩子不读 stdin 就退出是正常的 */ }
  })
}

/** 解读钩子 stdout 的 JSON（字段与 CLI 一致）。取最后一行能解析成对象的。 */
function interpretOutput(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* 继续往前找 */ }
  }
  return null
}

/**
 * 把一次钩子执行的结果合并进统一结构。
 * 与 CLI 的优先级一致：`hookSpecificOutput.permissionDecision` 比顶层 `decision` 更具体。
 */
function mergeResult(acc, hook, res) {
  const json = interpretOutput(res.stdout)

  if (res.error && !res.stderr) {
    acc.messages.push(`钩子「${hook.command}」执行异常：${res.error}`)
    return
  }
  // 退出码 2 = 阻断（CLI 约定），理由取 stderr
  if (res.code === 2) {
    const reason = (res.stderr || res.stdout || '').trim() || '被钩子阻断'
    acc.decision = 'deny'
    acc.reason = reason
    acc.messages.push(`钩子阻断：${cap(reason)}`)
    return
  }
  if (res.code !== 0 && res.code !== null) {
    acc.messages.push(`钩子「${hook.command}」以退出码 ${res.code} 结束：${cap(res.stderr || res.stdout)}`)
  }
  if (!json) {
    if (res.stderr.trim()) acc.messages.push(`钩子输出：${cap(res.stderr.trim())}`)
    return
  }

  if (json.continue === false) {
    acc.preventContinuation = true
    acc.stopReason = json.stopReason ?? acc.stopReason
  }
  if (json.systemMessage) acc.messages.push(String(json.systemMessage))

  if (json.decision === 'approve') acc.decision = acc.decision === 'deny' ? 'deny' : 'allow'
  else if (json.decision === 'block') {
    acc.decision = 'deny'
    acc.reason = json.reason || '被钩子阻断'
  }

  const specific = json.hookSpecificOutput
  if (specific && typeof specific === 'object') {
    if (specific.hookEventName && specific.hookEventName !== acc.event) {
      acc.messages.push(
        `钩子返回的事件名不对：期望 ${acc.event}，实际 ${specific.hookEventName}（已忽略其输出）`,
      )
      return
    }
    const pd = specific.permissionDecision
    if (pd === 'allow') acc.decision = acc.decision === 'deny' ? 'deny' : 'allow'
    else if (pd === 'ask') acc.decision = 'ask'
    else if (pd === 'deny') {
      acc.decision = 'deny'
      acc.reason = specific.permissionDecisionReason || json.reason || '被钩子拒绝'
    } else if (pd !== undefined) {
      acc.messages.push(`钩子返回了未知的 permissionDecision：${pd}（已忽略）`)
    }
    if (specific.updatedInput && typeof specific.updatedInput === 'object') {
      acc.updatedInput = specific.updatedInput
    }
    if (specific.additionalContext) acc.additionalContext = String(specific.additionalContext)
  }
  if (acc.decision && json.reason && !acc.reason) acc.reason = String(json.reason)
}

/**
 * 跑某个事件的钩子。
 *
 * `hookInput` 是喂给钩子进程的 stdin JSON（工具相关的事件才有）。
 * 它必须写进 `@param` —— 签名里的解构默认值是 `= {}`，TS 会据此推断成
 * `{toolName?: string, cwd?: any}`，**`hookInput` 会被整个漏掉**，
 * 于是 engine.mjs / index.mjs 里所有传它的调用点都报 TS2353，
 * 而运行时其实一直是好的。类型契约与实现不符，比没有类型更糟。
 *
 * @param {string} event
 * @param {{toolName?: string, hookInput?: Record<string, any>, cwd?: string}} [opts]
 * @returns {Promise<{event:string, decision:'allow'|'ask'|'deny'|null, reason:string|null,
 *   updatedInput:object|null, additionalContext:string|null, preventContinuation:boolean,
 *   stopReason:string|null, messages:string[], ran:number}>}
 */
export async function runEventHooks(event, { toolName = '', hookInput, cwd = workspaceRoot() } = {}) {
  const acc = {
    event,
    decision: null,
    reason: null,
    updatedInput: null,
    additionalContext: null,
    preventContinuation: false,
    stopReason: null,
    messages: [],
    ran: 0,
  }
  const hooks = runnableHooks(event, toolName)
  for (const hook of hooks) {
    acc.ran++
    const res = await runCommandHook(hook, { ...hookInput, hook_event_name: event }, { cwd })
    mergeResult(acc, hook, res)
  }
  return acc
}

/** 组装 PreToolUse / PostToolUse 的输入（字段名与 CLI 一致）。 */
export function toolHookInput(session, toolName, toolInput, extra = {}) {
  return {
    session_id: session?.id ?? '',
    cwd: workspaceRoot(),
    tool_name: toolName,
    tool_input: toolInput ?? {},
    ...extra,
  }
}

/** 会话级事件的输入。 */
export function sessionHookInput(session, extra = {}) {
  return { session_id: session?.id ?? '', cwd: workspaceRoot(), ...extra }
}
