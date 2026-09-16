/**
 * unified diff 渲染（Write / Edit / NotebookEdit 的结果）。
 * 解析 `--- a/x` / `+++ b/x` / `@@ -l,c +l,c @@` 与 +/-/空格 前缀行。
 */

interface Hunk {
  header: string
  lines: { kind: 'add' | 'del' | 'ctx'; text: string }[]
}

function parseDiff(diff: string): { files: string[]; hunks: Hunk[] } {
  const files: string[] = []
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim()
      if (p !== '/dev/null' && !files.includes(p)) files.push(p.replace(/^[ab]\//, ''))
      continue
    }
    if (raw.startsWith('@@')) {
      current = { header: raw, lines: [] }
      hunks.push(current)
      continue
    }
    if (current === null) continue
    if (raw.startsWith('+')) current.lines.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) current.lines.push({ kind: 'del', text: raw.slice(1) })
    else current.lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  return { files, hunks }
}

export function DiffView({ diff, collapsed }: { diff: string; collapsed?: boolean }) {
  const { files, hunks } = parseDiff(diff)
  const added = hunks.reduce((n, h) => n + h.lines.filter(l => l.kind === 'add').length, 0)
  const removed = hunks.reduce((n, h) => n + h.lines.filter(l => l.kind === 'del').length, 0)

  return (
    <div className="diff-view">
      <div className="diff-summary">
        <span className="diff-file">{files.join('、') || '（未知文件）'}</span>
        <span className="diff-stat">
          <span className="diff-add">+{added}</span>
          <span className="diff-del">-{removed}</span>
        </span>
      </div>
      {!collapsed && (
        <pre className="diff-body">
          {hunks.map((h, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-header">{h.header}</div>
              {h.lines.map((l, li) => (
                <div key={li} className={`diff-line ${l.kind}`}>
                  <span className="diff-sign">
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
                  </span>
                  <span className="diff-text">{l.text}</span>
                </div>
              ))}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}
