import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

const DEFAULT_PORT = 8788

/**
 * /web —— 在后台启动本地 Web UI 服务器（web/server/index.mjs），
 * 并报告 URL。该服务器提供 web/dist（由
 * `cd web && npm run build` 构建）并暴露 WebSocket 聊天 API。
 */
export async function call(onDone: LocalJSXCommandOnDone): Promise<null> {
  const port = Number(process.env.LIMKENION_WEB_PORT ?? DEFAULT_PORT)
  const serverEntry = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'web',
    'server',
    'index.mjs',
  )

  if (!existsSync(serverEntry)) {
    onDone('web 服务入口不存在：web/server/index.mjs')
    return null
  }

  const distDir = join(dirname(serverEntry), '..', 'dist')
  if (!existsSync(distDir)) {
    onDone('前端尚未构建。请先执行：cd web && npm install && npm run build')
    return null
  }

  const child = spawn(process.execPath, [serverEntry], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, LIMKENION_WEB_PORT: String(port) },
  })
  child.unref()

  onDone(`Limkenion web 已启动：http://localhost:${port}（服务在后台运行）`)
  return null
}
