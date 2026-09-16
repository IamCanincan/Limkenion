#!/usr/bin/env node
/**
 * limkenion-web CLI 入口 — 全局安装后的命令。
 *
 * 用法：
 *   limkenion-web [port]     启动服务（默认 8788，或 LIMKENION_WEB_PORT）
 *   limkenion-web build      构建前端（需要本包从源码安装的场景）
 *   limkenion-web --help
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(__dirname, '..')
const serverEntry = join(pkgRoot, 'server', 'index.mjs')
const distDir = join(pkgRoot, 'dist')

const args = process.argv.slice(2)

if (args[0] === '--help' || args[0] === '-h') {
  console.log(`limkenion-web — Limkenion 浏览器聊天界面

用法：
  limkenion-web [port]    启动本地服务并伺服前端（默认端口 8788）
  limkenion-web build     构建前端产物（Vite build，需从源码目录安装）
  limkenion-web --help    显示本帮助

环境变量：
  LIMKENION_WEB_PORT       服务端口（优先于位置参数）
  LIMKENION_WEB_WORKSPACE  文件工具沙箱根（默认取 CLI 源码根，找不到则用当前目录）
  LIMKENION_CLI_ROOT       CLI 源码根（用于扫描斜杠命令注册表）
  DEEPSEEK_API_KEY         设置后启用真实 DeepSeek 引擎，否则降级 mock
  DEEPSEEK_BASE_URL        可选，默认 https://api.deepseek.com

说明：
  在 CLI 源码树内启动时，工作区默认为该仓库根，斜杠命令注册表扫描 commands/。
  全局安装在任意目录启动时，工作区即当前目录，命令注册表仅含 web 自带命令。`)
  process.exit(0)
}

if (args[0] === 'build') {
  const result = spawnSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'inherit', shell: true })
  process.exit(result.status ?? 1)
}

// 端口：位置参数 > 环境变量 > 默认
const port = Number(args[0]) || Number(process.env.LIMKENION_WEB_PORT) || 8788

if (!existsSync(serverEntry)) {
  console.error('错误：找不到 server/index.mjs，安装可能不完整。')
  process.exit(1)
}

if (!existsSync(distDir)) {
  console.error('前端尚未构建，正在执行构建……')
  const result = spawnSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    console.error('构建失败。请确认本包从源码目录安装（npm install -g <源码路径>）。')
    process.exit(1)
  }
}

process.env.LIMKENION_WEB_PORT = String(port)
spawnSync(process.execPath, [serverEntry], { stdio: 'inherit', env: process.env })
