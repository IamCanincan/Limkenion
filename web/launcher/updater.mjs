#!/usr/bin/env node
/**
 * Limkenion 零依赖更新器（运行时模块，不引入任何 npm 包）。
 *
 * 流程：读取本地 version.json → 拉取更新源（LIMKENION_UPDATE_URL 指向的 version.json）
 * → 比较语义化版本 → 下载最新 release zip → 用系统解压工具覆盖到安装目录 → 重启 launcher。
 *
 * 解压走系统工具（Windows 的 Expand-Archive / macOS·Linux 的 unzip），避免引入解压库。
 * 所有网络/解压失败都 fail-closed：不更新、不打断当前运行。
 */

import { spawn, execFile } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  createWriteStream,
  readdirSync,
  copyFileSync,
} from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** 安装目录 = 本文件所在目录（出包后 launcher/updater/version.json 都平铺在此）。 */
const INSTALL_DIR = __dirname
const VERSION_FILE = join(INSTALL_DIR, 'version.json')
const UPDATE_URL = process.env.LIMKENION_UPDATE_URL ?? ''

function getText(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? httpsGet : httpGet
    const req = get(url, res => {
      const code = res.statusCode ?? 0
      // 跟随一次重定向（部分 CDN/Release 会 302）
      if (code >= 300 && code < 400 && res.headers.location) {
        get(res.headers.location, res2 => {
          let data = ''
          res2.setEncoding('utf8')
          res2.on('data', c => (data += c))
          res2.on('end', () => resolve(data))
        }).on('error', reject)
        return
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', c => (data += c))
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.end()
  })
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? httpsGet : httpGet
    const req = get(url, res => {
      const code = res.statusCode ?? 0
      if (code >= 300 && code < 400 && res.headers.location) {
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (code !== 200) {
        reject(new Error(`下载更新包失败，HTTP ${code}`))
        return
      }
      const f = createWriteStream(dest)
      res.pipe(f)
      f.on('finish', () => f.close(() => resolve(dest)))
    })
    req.on('error', reject)
    req.end()
  })
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function currentVersion() {
  try {
    return JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function fetchLatest() {
  if (!UPDATE_URL) return null
  try {
    return JSON.parse(await getText(UPDATE_URL))
  } catch {
    return null
  }
}

export async function checkUpdate() {
  const current = currentVersion()
  const latest = await fetchLatest()
  if (!latest || !latest.version) {
    return { available: false, current, reason: '未配置更新源（LIMKENION_UPDATE_URL）或无法获取版本清单' }
  }
  const available = compareSemver(current, latest.version) < 0
  return { available, current, latest: latest.version, assetUrl: latest.assetUrl ?? '', info: latest.info ?? '' }
}

async function unzip(archive, dest) {
  await new Promise((resolve, reject) => {
    let cmd
    if (process.platform === 'win32') {
      cmd = `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archive}' -DestinationPath '${dest}'"`
    } else {
      // macOS/Linux：优先 unzip，缺失则退 tar（仅当包为 .tar.gz）
      cmd =
        archive.endsWith('.tar.gz') || archive.endsWith('.tgz')
          ? `tar -xzf '${archive}' -C '${dest}'`
          : `unzip -o -q '${archive}' -d '${dest}'`
    }
    execFile(cmd, { shell: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || String(err)))
      else resolve(undefined)
    })
  })
}

/** 解压产物里是否应跳过（保留内置 Node 不被更新覆盖）。 */
function skipNodePath(relParts) {
  if (relParts[0] === 'node') return true // 顶层 node/（win/linux 内置）
  if (
    relParts[0] === 'Limkenion.app' &&
    relParts[1] === 'Contents' &&
    relParts[2] === 'Resources' &&
    relParts[3] === 'node'
  ) {
    return true // .app 内的内置 node
  }
  return false
}

/** 把提取目录树拷贝到安装目录，跳过内置 node/。 */
function applyTree(srcRoot, destRoot) {
  const walk = dir => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const s = join(dir, e.name)
      const relParts = relative(srcRoot, s).split(/[\\/]/).filter(Boolean)
      if (skipNodePath(relParts)) continue
      const d = join(destRoot, ...relParts)
      if (e.isDirectory()) {
        mkdirSync(d, { recursive: true })
        walk(s)
      } else {
        mkdirSync(dirname(d), { recursive: true })
        copyFileSync(s, d)
      }
    }
  }
  walk(srcRoot)
}

/** 下载并覆盖安装目录（跳过内置 node/），然后重启 launcher（本进程退出）。 */
export async function applyUpdate(assetUrl) {
  const url = assetUrl ?? (await fetchLatest())?.assetUrl
  if (!url) throw new Error('没有可用的更新包地址')
  const tmp = join(INSTALL_DIR, '.update-tmp')
  const archive = join(INSTALL_DIR, '.update-tmp.zip')
  await download(url, archive)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  await unzip(archive, tmp)
  applyTree(tmp, INSTALL_DIR) // 跳过 node/，内置 Node 保持稳定
  rmSync(tmp, { recursive: true, force: true })
  rmSync(archive, { force: true })
  relaunch()
}

function relaunch() {
  const child = spawn(process.execPath, [join(INSTALL_DIR, 'launcher.mjs')], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  child.unref()
  process.exit(0)
}
