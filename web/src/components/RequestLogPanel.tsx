/**
 * 模型请求追踪面板。
 *
 * 数据来自服务端的内存环形缓冲（`web/server/requestLog.mjs`）——
 * 记录每次模型调用的耗时、状态、token 用量。**失败也记**，因为排查"为什么卡住"时
 * 失败那条往往是关键。
 *
 * 这是 Web 端独有的能力：CLI 里没地方展示可筛选的表格。
 */
import { useEffect, useMemo, useState } from 'react'
import type { RequestLogEntry, RequestSummary } from '../types'

interface Props {
  requests: RequestLogEntry[]
  summary: RequestSummary | null
  onRefresh: () => void
  onClear: () => void
  onClose: () => void
}

type Filter = 'all' | 'ok' | 'failed'

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

/** 耗时相对最长请求的百分比，用来画条形图。 */
function barWidth(ms: number, maxMs: number): string {
  if (maxMs <= 0) return '0%'
  return `${Math.max(2, Math.round((ms / maxMs) * 100))}%`
}

export function RequestLogPanel({ requests, summary, onRefresh, onClear, onClose }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // 打开时自动拉一次
  useEffect(() => {
    onRefresh()
  }, [onRefresh])

  const shown = useMemo(() => {
    if (filter === 'ok') return requests.filter(r => r.ok)
    if (filter === 'failed') return requests.filter(r => !r.ok)
    return requests
  }, [requests, filter])

  const maxMs = useMemo(
    () => requests.reduce((m, r) => Math.max(m, r.durationMs), 0),
    [requests],
  )

  return (
    <div className="request-log-panel">
      <div className="request-log-head">
        <strong>请求追踪</strong>
        {summary && (
          <span className="request-log-summary">
            共 {summary.count} 次 · 成功 {summary.ok} · 失败 {summary.failed} · 平均{' '}
            {formatDuration(summary.avgMs)} · 最慢 {formatDuration(summary.maxMs)} ·{' '}
            {formatTokens(summary.inputTokens)}→{formatTokens(summary.outputTokens)} token
          </span>
        )}
        <span className="request-log-actions">
          <button className="request-log-btn" onClick={onRefresh}>
            刷新
          </button>
          <button className="request-log-btn" onClick={onClear}>
            清空
          </button>
          <button className="request-log-btn" onClick={onClose}>
            关闭
          </button>
        </span>
      </div>

      <div className="request-log-filters">
        {(
          [
            ['all', `全部 ${requests.length}`],
            ['ok', `成功 ${requests.filter(r => r.ok).length}`],
            ['failed', `失败 ${requests.filter(r => !r.ok).length}`],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className="request-log-filter"
            data-active={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="request-log-empty">
          {requests.length === 0
            ? '还没有请求记录。发一条消息后回来看。'
            : `没有${filter === 'failed' ? '失败' : '成功'}的请求。`}
        </div>
      ) : (
        <div className="request-log-body">
          <div className="request-log-row request-log-header">
            <span className="rl-col-time">时间</span>
            <span className="rl-col-model">模型</span>
            <span className="rl-col-bar">耗时</span>
            <span className="rl-col-status">状态</span>
            <span className="rl-col-tokens">token</span>
          </div>
          {shown.map(r => (
            <div key={r.id}>
              <button
                className="request-log-row"
                data-ok={r.ok}
                onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
              >
                <span className="rl-col-time">{formatTime(r.at)}</span>
                <span className="rl-col-model">{r.model || '—'}</span>
                <span className="rl-col-bar">
                  <span
                    className="rl-bar"
                    data-ok={r.ok}
                    style={{ width: barWidth(r.durationMs, maxMs) }}
                  />
                  <span className="rl-ms">{formatDuration(r.durationMs)}</span>
                </span>
                <span className="rl-col-status" data-ok={r.ok}>
                  {r.ok ? '成功' : (r.code ?? '失败')}
                </span>
                <span className="rl-col-tokens">
                  {r.ok ? `${formatTokens(r.inputTokens)}→${formatTokens(r.outputTokens)}` : '—'}
                </span>
              </button>
              {expandedId === r.id && r.error && (
                <div className="request-log-detail">{r.error}</div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="request-log-hint">
        只保留最近 500 条，进程重启即清空（本构建无云服务，不上报、不落盘）。点一行可看错误详情。
      </div>
    </div>
  )
}
