/**
 * /insights：对着**web 自己的会话存储**做使用分析，产出一份自包含 HTML 报告。
 *
 * CLI 的 `commands/insights.ts` 是单文件 2876 行，读 CLI 的 JSONL 项目日志
 * （`getProjectsDir` / `loadAllLogsFromSessionFile`），调 v4-pro 抽 facet，
 * 产 facets.json / meta.json + report.html，最后给一个 `file://` 链接。
 *
 * web 端的会话存储是另一套（`~/.limkenion-web/sessions.json`，字段结构也不同），
 * 所以这里不是"改个路径"，而是**对着自己的存储重新实现**：
 *
 *   - 统计全部来自真实数据（回合数、工具调用分布、失败率、token、改动文件、会话排行）；
 *   - "洞察"叙述由模型写（用强模型），**没有 key 时优雅降级为纯统计**，不留空白；
 *   - 报告是自包含 HTML（内联样式、无外部资源），落在 `<state>/insights/` 下，
 *     由 web 服务的 `/insights/` 只读路由提供（CLI 给 file://，web 给 http://）。
 *
 * 与 CLI 的差异（如实写在报告页脚）：没有 CLI 的 facets.json / meta.json 缓存，
 * 没有跨项目（CLI 会合并所有项目的日志），也没有分享上传。
 */

import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR, allSessions } from './sessions.mjs'
import { MODELS } from './config.mjs'
import { chatCompletion, getApiKey } from './deepseek.mjs'

/** 报告目录：与会话状态同一处（`LIMKENION_WEB_STATE_DIR` 可覆盖）。 */
export const INSIGHTS_DIR = join(STATE_DIR, 'insights')

/** 报告文件名允许的形态（HTTP 路由按它做白名单，别放宽）。 */
export const REPORT_NAME_RE = /^insights-[0-9T-]+\.html$/i

/** 用强模型写叙述（与 CLI 一致：facet 提取用最好的模型）。 */
function strongModel() {
  return MODELS.find(m => String(m.value).includes('v4-pro'))?.value ?? MODELS[0]?.value ?? 'deepseek-flash'
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 把会话数据聚合成可展示的统计。
 * @returns {object}
 */
export function collectInsights() {
  const sessions = [...allSessions()]
  const totals = {
    sessions: sessions.length,
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    filesChanged: 0,
    firstAt: null,
    lastAt: null,
  }
  const toolMap = new Map() // name → { calls, errors, totalMs, durCount }
  const fileMap = new Map() // path → 出现次数
  const perSession = []

  for (const s of sessions) {
    const msgs = s.messages ?? []
    totals.messages += msgs.length
    totals.turns += s.turnCount ?? 0
    totals.toolCalls += s.toolCallCount ?? 0
    totals.inputTokens += s.usage?.inputTokens ?? 0
    totals.outputTokens += s.usage?.outputTokens ?? 0
    totals.filesChanged += (s.filesChanged ?? []).length

    for (const p of s.filesChanged ?? []) fileMap.set(p, (fileMap.get(p) ?? 0) + 1)

    let sessionToolCalls = 0
    for (const m of msgs) {
      if (m.role === 'user') totals.userMessages++
      else if (m.role === 'assistant') totals.assistantMessages++
      if (!m.timestamp) continue
      if (totals.firstAt === null || m.timestamp < totals.firstAt) totals.firstAt = m.timestamp
      if (totals.lastAt === null || m.timestamp > totals.lastAt) totals.lastAt = m.timestamp
      for (const tc of m.toolCalls ?? []) {
        sessionToolCalls++
        const name = String(tc.name ?? '未知')
        const rec = toolMap.get(name) ?? { calls: 0, errors: 0, totalMs: 0, durCount: 0 }
        rec.calls++
        if (tc.status === 'error') rec.errors++
        if (Number.isFinite(tc.durationMs)) {
          rec.totalMs += tc.durationMs
          rec.durCount++
        }
        toolMap.set(name, rec)
      }
    }

    perSession.push({
      title: s.title ?? '（未命名）',
      messages: msgs.length,
      turns: s.turnCount ?? 0,
      toolCalls: s.toolCallCount ?? sessionToolCalls,
      inputTokens: s.usage?.inputTokens ?? 0,
      outputTokens: s.usage?.outputTokens ?? 0,
      updatedAt: s.updatedAt ?? null,
      worktree: s.worktree?.path ?? null,
    })
  }

  const tools = [...toolMap.entries()]
    .map(([name, r]) => ({
      name,
      calls: r.calls,
      errors: r.errors,
      avgMs: r.durCount > 0 ? Math.round(r.totalMs / r.durCount) : null,
      errorRate: r.calls > 0 ? r.errors / r.calls : 0,
    }))
    .sort((a, b) => b.calls - a.calls)

  const files = [...fileMap.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  perSession.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  return {
    generatedAt: Date.now(),
    totals,
    tools,
    files,
    sessions: perSession,
    stateFile: join(STATE_DIR, 'sessions.json'),
  }
}

/** 给模型看的紧凑摘要（别把整个会话记录塞进去）。 */
function digestForModel(d) {
  const lines = [
    `统计窗口：${d.totals.firstAt ? new Date(d.totals.firstAt).toISOString().slice(0, 16).replace('T', ' ') : '（无）'}` +
      ` ~ ${d.totals.lastAt ? new Date(d.totals.lastAt).toISOString().slice(0, 16).replace('T', ' ') : '（无）'}`,
    `会话 ${d.totals.sessions} 个、消息 ${d.totals.messages} 条（用户 ${d.totals.userMessages} / 助手 ${d.totals.assistantMessages}）、回合 ${d.totals.turns}`,
    `工具调用 ${d.totals.toolCalls} 次、token 输入 ${fmtTokens(d.totals.inputTokens)} / 输出 ${fmtTokens(d.totals.outputTokens)}`,
    `改动过的文件 ${d.totals.filesChanged} 个`,
    '',
    '工具使用（前 12）：',
    ...d.tools.slice(0, 12).map(t => `- ${t.name}：${t.calls} 次，失败 ${t.errors} 次${t.avgMs !== null ? `，平均 ${t.avgMs}ms` : ''}`),
    '',
    '最常改动的文件（前 8）：',
    ...(d.files.length ? d.files.slice(0, 8).map(f => `- ${f.path}（${f.count} 次）`) : ['- （无）']),
    '',
    '会话排行（按最近更新，前 8）：',
    ...d.sessions.slice(0, 8).map(s => `- ${s.title}：消息 ${s.messages}、回合 ${s.turns}、工具 ${s.toolCalls}`),
  ]
  return lines.join('\n')
}

/** 调模型写洞察；失败或无 key 时返回 null（由调用方降级）。 */
async function writeNarrative(d) {
  if (!getApiKey()) return { narrative: null, warning: '未配置 DEEPSEEK_API_KEY，报告只含统计、没有模型写的洞察。' }
  try {
    const res = await chatCompletion({
      model: strongModel(),
      messages: [
        {
          role: 'system',
          content:
            '你在为「Limkenion」（一个本地 AI 编程助手）生成使用洞察报告的文字部分。' +
            '只依据给定数据，不要编造。用中文，3~6 条要点，每条一句话，可以带一两个具体数字。' +
            '重点：他把 agent 用在什么上、哪些环节最费时间或最容易失败、有什么可操作的改进建议。' +
            '不要写客套话，不要复述全部数字，不要用 Markdown 标题。',
        },
        { role: 'user', content: digestForModel(d) },
      ],
      reasoningEffort: 'low',
    })
    const text = String(res?.text ?? '').trim()
    return { narrative: text || null, warning: text ? null : '模型没有返回内容，报告只含统计。' }
  } catch (err) {
    return { narrative: null, warning: `模型生成洞察失败（${String(err?.message ?? err)}），报告只含统计。` }
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** 自包含 HTML（内联样式、无外部资源）。 */
export function renderInsightsHtml(d, narrative, warnings = []) {
  const maxCalls = Math.max(1, ...d.tools.map(t => t.calls))
  const bar = (v, max, color = '#4a86e8') =>
    `<div style="background:${color};height:8px;border-radius:4px;width:${Math.round((v / max) * 100)}%"></div>`

  const toolRows = d.tools
    .slice(0, 30)
    .map(
      t => `<tr>
      <td style="padding:4px 8px;font-family:ui-monospace,Consolas,monospace">${esc(t.name)}</td>
      <td style="padding:4px 8px;text-align:right">${t.calls}</td>
      <td style="padding:4px 8px;text-align:right;color:${t.errors > 0 ? '#e24b4a' : '#888'}">${t.errors}</td>
      <td style="padding:4px 8px;text-align:right">${t.avgMs === null ? '—' : fmtDuration(t.avgMs)}</td>
      <td style="padding:4px 8px;width:160px">${bar(t.calls, maxCalls)}</td>
    </tr>`,
    )
    .join('')

  const fileRows = d.files
    .map(
      f => `<tr><td style="padding:4px 8px;font-family:ui-monospace,Consolas,monospace">${esc(f.path)}</td>
      <td style="padding:4px 8px;text-align:right">${f.count}</td></tr>`,
    )
    .join('')

  const sessionRows = d.sessions
    .slice(0, 30)
    .map(
      s => `<tr>
      <td style="padding:4px 8px">${esc(s.title)}</td>
      <td style="padding:4px 8px;text-align:right">${s.messages}</td>
      <td style="padding:4px 8px;text-align:right">${s.turns}</td>
      <td style="padding:4px 8px;text-align:right">${s.toolCalls}</td>
      <td style="padding:4px 8px;text-align:right">${fmtTokens(s.inputTokens + s.outputTokens)}</td>
      <td style="padding:4px 8px;color:#888">${s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '—'}</td>
    </tr>`,
    )
    .join('')

  const narrativeBlock = narrative
    ? narrative
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => `<li style="margin:6px 0">${esc(l.replace(/^[-*•]\s*/, ''))}</li>`)
        .join('')
    : '<li>（没有模型写的洞察）</li>'

  const warningBlock = warnings.length
    ? `<div style="border:1px solid #854f0b;background:#2a2113;color:#faeeda;padding:10px 12px;border-radius:8px;margin:12px 0">
        ${warnings.map(w => esc(w)).join('<br>')}
      </div>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Limkenion 使用洞察</title>
<style>
  body{margin:0;padding:24px;background:#181818;color:#e6e6e6;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  h1{font-size:20px;font-weight:500;margin:0 0 4px}
  h2{font-size:15px;font-weight:500;margin:28px 0 8px;color:#cfcfcf}
  .sub{color:#888;font-size:12px}
  .cards{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
  .card{background:#232323;border:1px solid #333;border-radius:12px;padding:12px 16px;min-width:140px}
  .card b{display:block;font-size:20px;font-weight:500;margin-bottom:2px}
  .card span{color:#888;font-size:12px}
  table{border-collapse:collapse;width:100%;background:#1f1f1f;border:1px solid #333;border-radius:8px;overflow:hidden}
  th{text-align:left;padding:6px 8px;background:#262626;color:#aaa;font-weight:400;font-size:12px}
  td{border-top:1px solid #2c2c2c}
  ul{margin:8px 0;padding-left:20px}
  footer{margin-top:32px;color:#666;font-size:12px;border-top:1px solid #2c2c2c;padding-top:12px}
</style></head><body>
<h1>Limkenion 使用洞察</h1>
<div class="sub">生成于 ${new Date(d.generatedAt).toLocaleString('zh-CN')}　·　数据来源 ${esc(d.stateFile)}</div>
${warningBlock}
<div class="cards">
  <div class="card"><b>${d.totals.sessions}</b><span>会话</span></div>
  <div class="card"><b>${d.totals.messages}</b><span>消息（用户 ${d.totals.userMessages}）</span></div>
  <div class="card"><b>${d.totals.turns}</b><span>回合</span></div>
  <div class="card"><b>${d.totals.toolCalls}</b><span>工具调用</span></div>
  <div class="card"><b>${fmtTokens(d.totals.inputTokens)}</b><span>输入 token</span></div>
  <div class="card"><b>${fmtTokens(d.totals.outputTokens)}</b><span>输出 token</span></div>
  <div class="card"><b>${d.totals.filesChanged}</b><span>改动过的文件</span></div>
</div>

<h2>模型写的洞察</h2>
<ul>${narrativeBlock}</ul>

<h2>工具使用</h2>
<table><thead><tr><th>工具</th><th>次数</th><th>失败</th><th>平均耗时</th><th>占比</th></tr></thead>
<tbody>${toolRows || '<tr><td colspan="5" style="padding:8px;color:#888">还没有工具调用记录</td></tr>'}</tbody></table>

<h2>改动最多的文件</h2>
<table><thead><tr><th>文件</th><th>次数</th></tr></thead>
<tbody>${fileRows || '<tr><td colspan="2" style="padding:8px;color:#888">还没有文件改动记录</td></tr>'}</tbody></table>

<h2>会话排行</h2>
<table><thead><tr><th>会话</th><th>消息</th><th>回合</th><th>工具</th><th>token</th><th>最近更新</th></tr></thead>
<tbody>${sessionRows || '<tr><td colspan="6" style="padding:8px;color:#888">还没有会话</td></tr>'}</tbody></table>

<footer>
数据全部来自 web 端自己的会话存储（${esc(d.stateFile)}）。<br>
与 CLI 的 /insights 相比没有：facets.json / meta.json 缓存、跨项目合并、分享上传。
</footer>
</body></html>`
}

/**
 * 生成报告。
 * @returns {Promise<{name: string, path: string, url: string, data: object, narrative: string|null, warnings: string[]}>}
 */
export async function generateInsights({ narrative = true } = {}) {
  const data = collectInsights()
  const warnings = []
  let text = null
  if (narrative) {
    const r = await writeNarrative(data)
    text = r.narrative
    if (r.warning) warnings.push(r.warning)
  }
  if (data.totals.messages === 0) {
    warnings.push('这个 web 实例还没有任何对话记录，报告里的统计基本都是空的。')
  }
  const html = renderInsightsHtml(data, text, warnings)
  await mkdir(INSIGHTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `insights-${stamp}.html`
  const path = join(INSIGHTS_DIR, name)
  await writeFile(path, html, 'utf8')
  return { name, path, url: `/insights/${name}`, data, narrative: text, warnings }
}

/** 最近一份报告的文件名（供 `/insights` 直接给链接）。 */
export async function latestReport() {
  try {
    const names = (await readdir(INSIGHTS_DIR)).filter(n => REPORT_NAME_RE.test(n)).sort()
    return names.at(-1) ?? null
  } catch {
    return null
  }
}

/** 取某份报告的内容（HTTP 路由用；名字必须过白名单 + 落在目录内）。 */
export async function readReport(name) {
  if (!REPORT_NAME_RE.test(name)) return null
  const path = join(INSIGHTS_DIR, name)
  try {
    const st = await stat(path)
    if (!st.isFile()) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** `/insights` 命令的输出。 */
export function insightsSummary(result) {
  const t = result.data.totals
  const lines = [
    `报告已生成：${result.path}`,
    `网页打开：http://127.0.0.1:${process.env.LIMKENION_WEB_PORT ?? 8788}${result.url}`,
    '',
    `会话 ${t.sessions} 个 · 消息 ${t.messages} 条（用户 ${t.userMessages} / 助手 ${t.assistantMessages}）· 回合 ${t.turns}`,
    `工具调用 ${t.toolCalls} 次 · token 输入 ${fmtTokens(t.inputTokens)} / 输出 ${fmtTokens(t.outputTokens)} · 改动文件 ${t.filesChanged} 个`,
  ]
  if (result.data.tools.length > 0) {
    lines.push('', '最常用工具：' + result.data.tools.slice(0, 5).map(x => `${x.name}(${x.calls})`).join('、'))
    const flaky = result.data.tools.filter(x => x.errors > 0).slice(0, 5)
    if (flaky.length > 0) {
      lines.push('有失败记录的工具：' + flaky.map(x => `${x.name}(${x.errors}/${x.calls})`).join('、'))
    }
  }
  if (result.warnings.length > 0) lines.push('', ...result.warnings)
  if (result.narrative) lines.push('', '模型写的洞察：', result.narrative)
  return lines.join('\n')
}
