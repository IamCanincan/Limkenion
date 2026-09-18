/**
 * 后台会话管理 —— `limkenion ps|logs|attach|kill|--bg` 子命令。
 *
 * 这些命令是 `daemon/backgroundDaemon.ts` 真实现的**薄封装**：
 * 每个后台会话就是一个守护进程（名称即会话名），状态文件在
 * `~/.limkenion/daemon/<名称>.json`，日志在 `~/.limkenion/daemon/logs/`。
 *
 *   --bg "<提示词>"  → 启动守护进程并发送提示词（发射后不管，回合后台继续跑）
 *   ps               → 列出全部后台会话
 *   attach <名称>    → 交互式接入（权限请求转发到这里应答）
 *   logs <名称> [-f] → 查看 / 跟随日志
 *   kill <名称>      → 停止守护进程（会话已持久化，之后可 -r 恢复）
 *
 * 历史注：早期版本这里只登记 pending 任务、不派生进程（本地构建当时
 * 无法安全地后台运行模型调用）；daemon 真实现落地后整体迁移过去。
 */
import { daemonList, daemonLogs, daemonAttach, daemonStop, daemonStartWithPrompt } from '../daemon/backgroundDaemon.js'

export async function psHandler(_args: string[]): Promise<void> {
  await daemonList()
}

export async function logsHandler(id?: string, extra?: { follow?: boolean; lines?: number }): Promise<void> {
  if (!id) {
    console.error('用法：limkenion logs <名称> [-f]')
    process.exitCode = 2
    return
  }
  await daemonLogs(id, { follow: extra?.follow ?? process.argv.includes('-f'), lines: extra?.lines })
}

export async function attachHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('用法：limkenion attach <名称>')
    process.exitCode = 2
    return
  }
  await daemonAttach(id)
}

export async function killHandler(id?: string): Promise<void> {
  if (!id) {
    console.error('用法：limkenion kill <名称>')
    process.exitCode = 2
    return
  }
  await daemonStop(id)
}

/** `--bg` / `--background`：启动后台会话并发送提示词，发射后不管。 */
export async function handleBgFlag(args: string[]): Promise<void> {
  const prompt = args
    .filter(a => a !== '--bg' && a !== '--background' && a !== 'bg')
    .join(' ')
    .trim()
  if (!prompt) {
    console.error('用法：limkenion --bg "<提示词>"')
    process.exitCode = 2
    return
  }
  await daemonStartWithPrompt({ prompt })
}
