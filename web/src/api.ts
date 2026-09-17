import type { ClientMessage, ServerMessage } from './types'

/**
 * Thin WebSocket client with auto-reconnect and a subscribe API.
 * Kept dependency-free so the whole frontend rides React state alone
 * (no browser storage, no external stores).
 *
 * 握手需要一次性 token：生产模式由服务端注入 <meta name="limkenion-token">，
 * 开发模式（Vite 伺服页面）从 /ws-token 取。两者都拿不到就不连——服务端会拒。
 */
export class LimkenionConnection {
  private ws: WebSocket | null = null
  private listeners = new Set<(msg: ServerMessage) => void>()
  private stateListeners = new Set<(open: boolean) => void>()
  private closedByUser = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private token = ''

  /** 解析握手 token：meta 优先，开发模式回退到 /ws-token。 */
  private async resolveToken(): Promise<string> {
    const meta = document
      .querySelector('meta[name="limkenion-token"]')
      ?.getAttribute('content')
      ?.trim()
    if (meta && !meta.includes('__LIMKENION_TOKEN__')) return meta
    try {
      const res = await fetch('/ws-token', { cache: 'no-store' })
      if (res.ok) {
        const body = (await res.json()) as { token?: string }
        return body.token ?? ''
      }
    } catch {
      /* 取不到就让服务端拒，走重连 */
    }
    return ''
  }

  async connect(): Promise<void> {
    this.closedByUser = false
    if (!this.token) this.token = await this.resolveToken()
    if (this.closedByUser) return

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : ''
    const ws = new WebSocket(`${proto}://${location.host}/ws${query}`)
    this.ws = ws

    ws.onopen = () => {
      this.stateListeners.forEach(fn => fn(true))
    }
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data as string) as ServerMessage
        this.listeners.forEach(fn => fn(msg))
      } catch {
        // 忽略格式错误的帧。
      }
    }
    ws.onclose = () => {
      this.stateListeners.forEach(fn => fn(false))
      this.ws = null
      if (!this.closedByUser && this.retryTimer === null) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          // 服务端重启后 token 会变，重连时重新取一次
          this.token = ''
          void this.connect()
        }, 2000)
      }
    }
  }

  disconnect(): void {
    this.closedByUser = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.ws?.close()
    this.ws = null
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  onMessage(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onStateChange(fn: (open: boolean) => void): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }
}
