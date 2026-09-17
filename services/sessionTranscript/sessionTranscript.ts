/**
 * 会话转写 —— 把每次 compact 前的消息段落到本地会话转写文件。
 *
 * 纯本地、纯 Node。每次调用把一段消息序列化为一行的 JSON，追加到
 * `~/.limkenion/transcripts/<sessionId>.jsonl`，便于回看每个会话的完整
 * 转写。任何错误都内部吞掉（fire-and-forget），绝不影响主流程。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, appendFileSync } from 'node:fs'
import { getSessionId } from 'src/bootstrap/state.js'

interface TranscriptSegment {
  type: 'segment'
  at: string
  sessionId: string
  roles: { role: string; count: number }[]
  preview: string
}

function transcriptsFile(): string {
  const sessionId = getSessionId() ?? 'unknown'
  return join(homedir(), '.limkenion', 'transcripts', `${sessionId}.jsonl`)
}

function roleOf(m: any): string {
  const role = m?.message?.role
  if (role) return String(role)
  return m?.type ?? 'unknown'
}

function previewOf(m: any): string {
  const content = m?.message?.content ?? m?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
    return text
  }
  if (content && typeof content === 'object') {
    // 保守取第一段文本
    const c = Array.isArray(content) ? content[0] : null
    if (c?.type === 'text') return String(c.text)
  }
  return ''
}

export function writeSessionTranscriptSegment(messages: unknown[]): void {
  try {
    const arr = Array.isArray(messages) ? messages : []
    if (arr.length === 0) return
    const roleCount = new Map<string, number>()
    const previews: string[] = []
    for (const m of arr) {
      const r = roleOf(m)
      roleCount.set(r, (roleCount.get(r) ?? 0) + 1)
      if (previews.length < 8) {
        const p = previewOf(m)
        if (p) previews.push(p.slice(0, 200))
      }
    }
    const segment: TranscriptSegment = {
      type: 'segment',
      at: new Date().toISOString(),
      sessionId: getSessionId() ?? 'unknown',
      roles: [...roleCount.entries()].map(([role, count]) => ({ role, count })),
      preview: previews.join(' ').slice(0, 800),
    }
    const f = transcriptsFile()
    mkdirSync(join(homedir(), '.limkenion', 'transcripts'), { recursive: true })
    appendFileSync(f, JSON.stringify(segment) + '\n', 'utf8')
  } catch {
    // fire-and-forget：转写失败不影响主流程
  }
}