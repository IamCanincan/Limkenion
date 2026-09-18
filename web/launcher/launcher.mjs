#!/usr/bin/env node
/**
 * Limkenion 跨平台「无终端」启动器（纯 Node，零依赖）。
 *
 * 职责：
 *  1. 单实例：端口已被占用（服务已在跑）→ 直接打开浏览器并退出，避免起第二个服务；
 *  2. 确保前端构建产物 dist/ 存在（缺失则触发一次 vite build）；
 *  3. 以后台方式拉起 Node 服务（server/index.mjs），stdout/stderr 写入 limkenion.log；
 *  4. 等服务就绪后打开系统默认浏览器到 http://<host>:<port>；
 *  5. 捕获退出信号，干净杀掉子进程。
 *
 * 各平台入口（双击都不会弹出终端）：
 *  - Windows：limkenion.vbs（WScript 以隐藏窗口运行本文件）
 *  - macOS：  Limkenion.app/Contents/MacOS/limkenion（Finder 直接执行）
 *  - Linux：  limkenion.desktop → limkenion.sh
 */

import { spawn, exec } from 'node:child_process'
import { existsSync, openSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { checkUpdate, applyUpdate } from './updater.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(__dirname, '..')
const SERVER_ENTRY = join(PKG_ROOT, 'server', 'index.mjs')
const DIST_DIR = join(PKG_ROOT, 'dist')
const LOG_FILE = join(__dirname, 'limkenion.log')

const PORT = Number(process.env.LIMKENION_WEB_PORT ?? 8788)
const HOST = process.env.LIMKENION_WEB_HOST ?? '127.0.0.1'
// 浏览器可视地址：绑 0.0.0.0 时仍用 localhost 访问
const OPEN_HOST = HOST === '0.0.0.0' ? 'localhost' : HOST
const APP_URL = `http://${OPEN_HOST}:${PORT}`

function log(...args) {
  const line = `[limkenion-launcher] ${args.map(String).join(' ')}\n`
  try {
    appendFileSync(LOG_FILE, line)
  } catch {
    /* 日志不可写也不要阻塞启动 */
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `cmd /c start "" "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, err => {
    if (err) log('打开浏览器失败：', err.message)
  })
}

async function ensureDist() {
  if (existsSync(DIST_DIR)) return
  log('dist 缺失，正在构建前端（仅首次）……')
  await new Promise((res, rej) => {
    const p = spawn('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'ignore', shell: true })
    p.on('exit', code => (code === 0 ? res() : rej(new Error(`vite build 失败，退出码 ${code}`))))
  })
}

/** 探测端口是否空闲（与服务器使用同一 HOST 绑定，避免误判）。 */
function portFree() {
  return new Promise(resolve => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(PORT, HOST)
  })
}

/** 轮询直到服务返回 200（最多约 30s）。 */
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`)
      if (r.ok) return true
    } catch {
      /* 尚未就绪 */
    }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

function startServer() {
  const logFd = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PKG_ROOT,
    env: process.env,
    stdio: ['ignore', logFd, logFd],
    detached: process.platform === 'win32',
    windowsHide: true,
  })
  if (process.platform === 'win32') child.unref()
  child.on('exit', code => log('服务进程退出，code=', code))
  return child
}

async function main() {
  if (!existsSync(SERVER_ENTRY)) {
    log('找不到 server/index.mjs，启动器可能未随包正确安装。')
    return
  }
  if (!(await portFree())) {
    log('端口被占用，服务可能已在运行，直接打开浏览器。')
    openBrowser(APP_URL)
    return
  }
  try {
    await ensureDist()
  } catch (e) {
    log('构建前端失败：', e.message)
    return
  }
  const child = startServer()
  const ok = await waitReady()
  if (ok) {
    log('服务就绪，打开浏览器：', APP_URL)
    openBrowser(APP_URL)
  } else {
    log('服务启动超时，请查看', LOG_FILE)
  }

  // 更新自检（非阻塞）：配置了更新源才检查；仅当 LIMKENION_AUTO_UPDATE=1 才自动应用。
  maybeAutoUpdate()

  const shutdown = () => {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 忽略：进程可能已退出 */
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGHUP', shutdown)
  // 常驻：保持父进程存活，服务才不会被回收
  await new Promise(() => {})
}

main().catch(e => {
  log('启动器异常：', e)
  process.exit(1)
})

/** 启动后异步检查更新；自动应用需显式开启 LIMKENION_AUTO_UPDATE=1。 */
async function maybeAutoUpdate() {
  if (!process.env.LIMKENION_UPDATE_URL) return
  try {
    const r = await checkUpdate()
    if (!r.available) return
    log('发现新版本', r.latest, '（当前', r.current, '）')
    if (process.env.LIMKENION_AUTO_UPDATE === '1') {
      log('自动更新已开启，正在应用……')
      await applyUpdate(r.assetUrl)
    } else {
      log('未开启自动更新（设置 LIMKENION_AUTO_UPDATE=1 可启用），可在界面点「检查更新」手动升级。')
    }
  } catch (e) {
    log('更新检查失败：', e.message)
  }
}
