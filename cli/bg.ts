/**
 * 后台会话管理 —— `limkenion ps|logs|attach|kill|--bg` 子命令。
 *
 * 会话注册表保存在 `~/.limkenion/sessions/<id>/`：
 *   - metadata.json  会话元信息（状态 / 标题 / 创建时间 / 触发命令）
 *   - prompt.txt     触发的提示词（--bg 时写入）
 *   - logs.txt       （按需写入的日志）
 *
 * 说明：本地 DeepSeek 构建不派生后台模型进程（headless 模式在缺 key 时
 * 会挂起），`--bg` 先把任务登记为 pending 并入注册表；后续可用
 * `limkenion ps` 查看、`attach` 查看其提示词、`kill` 结束。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'

type SessionStatus = 'pending' | 'running' | 'done' | 'terminated'

interface SessionMeta {
  id: string
  status: SessionStatus
  title: string
  createdAt: number
  command: string
}

function sessionsDir(): string {
  return join(homedir(), '.limkenion', 'sessions')
}

function sessionDir(id: string): string {
  return join(sessionsDir(), id)
}

function writeMeta(meta: SessionMeta): void {
  writeFileSync(join(sessionDir(meta.id), 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8')
}

function readMeta(id: string): SessionMeta | null {
  const f = join(sessionDir(id), 'metadata.json')
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as SessionMeta
  } catch {
    return null
  }
}

function listSessions(): SessionMeta[] {
  if (!existsSync(sessionsDir())) return []
  const out: SessionMeta[] = []
  for (const name of readdirSync(sessionsDir())) {
    const meta = readMeta(name)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function psHandler(_args: string[]): Promise<void> {
  const sessions = listSessions()
  if (sessions.length === 0) {
    console.log('（暂无后台会话）')
    return
  }
  console.log('后台会话:')
  for (const s of sessions) {
    const date = new Date(s.createdAt).toLocaleString()
    console.log(`  ${s.status.padEnd(10)} ${s.id} — ${s.title || '(未命名)'} （${date}）`)
  }
}

export async function logsHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('用法：limkenion logs <sessionId>')
    process.exitCode = 2
    return
  }
  const meta = readMeta(id)
  if (!meta) {
    console.error(`找不到会话：${id}（用 \`limkenion ps\` 查看）`)
    process.exitCode = 2
    return
  }
  const f = join(sessionDir(id), 'logs.txt')
  if (!existsSync(f)) {
    console.log(`（会话 ${id} 暂无日志，状态：${meta.status}）`)
    return
  }
  process.stdout.write(readFileSync(f, 'utf8'))
}

export async function attachHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('用法：limkenion attach <sessionId>')
    process.exitCode = 2
    return
  }
  const meta = readMeta(id)
  if (!meta) {
    console.error(`找不到会话：${id}（用 \`limkenion ps\` 查看）`)
    process.exitCode = 2
    return
  }
  const pf = join(sessionDir(id), 'prompt.txt')
  console.log(`会话 ${id}（状态：${meta.status}）`)
  if (existsSync(pf)) {
    console.log('\n—— 提示词 ——')
    process.stdout.write(readFileSync(pf, 'utf8'))
    console.log('\n—— 结束 ——')
  }
}

export async function killHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('用法：limkenion kill <sessionId>')
    process.exitCode = 2
    return
  }
  const meta = readMeta(id)
  if (!meta) {
    console.error(`找不到会话：${id}（用 \`limkenion ps\` 查看）`)
    process.exitCode = 2
    return
  }
  // 本地构建不派生真实进程，直接标记为已终止。
  meta.status = 'terminated'
  writeMeta(meta)
  console.log(`已终止会话：${id}`)
}

/** `--bg` / `--background`：把提示词登记为一个 pending 后台会话。 */
export async function handleBgFlag(args: string[]): Promise<void> {
  // args 形如 ["--bg", "<prompt...>"] 或 ["prompt...", "--bg", ...]
  const prompt = args.filter((a) => a !== '--bg' && a !== '--background' && a !== 'bg').join(' ')
  if (!prompt.trim()) {
    console.error('用法：limkenion --bg "<提示词>"')
    process.exitCode = 2
    return
  }
  const id = randomUUID()
  mkdirSync(sessionDir(id), { recursive: true })
  const meta: SessionMeta = {
    id,
    status: 'pending',
    title: prompt.slice(0, 60),
    createdAt: Date.now(),
    command: prompt,
  }
  writeMeta(meta)
  writeFileSync(join(sessionDir(id), 'prompt.txt'), prompt, 'utf8')
  console.log(`已登记后台会话：${id}（pending，用 \`limkenion ps\` 查看、\`attach ${id}\` 查看提示词）`)
}