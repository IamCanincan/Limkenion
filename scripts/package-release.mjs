#!/usr/bin/env node
/**
 * 出包脚本：产出一个三平台通用、内置 Node 的 Limkenion web 发布 zip（Tier C）。
 *
 * 内容（平铺在 zip 根，一份包 Windows/macOS/Linux 通用）：
 *   dist/                 前端构建产物（Vite，平台无关）
 *   server/               后端（纯 Node ESM，平台无关）
 *   node_modules/ws       唯一运行时 npm 依赖（纯 JS，平台无关）
 *   node/                 内置 Node（MIT 许可）：
 *     win-x64/node.exe
 *     linux-x64/node
 *   Limkenion.app/        macOS 入口；内置 node 放在 Contents/Resources/node/<架构>/node（随 .app 一起移动）
 *   limkenion.vbs         Windows 入口（隐藏窗口）
 *   limkenion.sh          Linux 入口
 *   limkenion.desktop     Linux 桌面项（Terminal=false）
 *   version.json          版本清单（更新器读取）
 *   NEEDS_NODE.txt        说明（已内置 Node，无需安装）
 *   README.md             启动说明
 *
 * 内置 Node 来自 nodejs.org 官方二进制（MIT 许可），由本脚本在出包时下载，仓库不塞二进制。
 * 默认取最新 LTS；可用 LIMKENION_NODE_VERSION 固定（如 v22.12.0）。
 *
 * 前提：已在 web/ 下 `npm install` 且 `npm run build`（dist 存在）。
 * 用法：node scripts/package-release.mjs
 *   可选环境变量：
 *     LIMKENION_RELEASE_URL：写入 version.json 的 assetUrl（更新器下载地址）
 *     LIMKENION_NODE_VERSION：固定内置 Node 版本
 *
 * 压缩走系统工具（Windows Compress-Archive / macOS·Linux zip），不引入 npm 依赖。
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = resolve(__dirname, '..', 'web')
const PKG = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'))
const VERSION = PKG.version
const RELEASE = join(WEB, 'release')
const STAGE = join(RELEASE, 'stage')
const OUT_ZIP = join(RELEASE, `limkenion-web-${VERSION}.zip`)

// Windows 的 tar（libarchive bsdtar）可同时解/压 .zip 与 .tar.gz，且能按扩展名出 zip（-a）。
// 关键：必须传原生路径（Windows 用反斜杠），否则 bsdtar 会把 "D:/..." 误判成 host:path。
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: WEB, stdio: 'inherit', shell: true, ...opts })
  if (r.status !== 0) throw new Error(`命令失败: ${cmd} ${args.join(' ')}`)
}

/** 解压官方 Node 包：.zip（Windows）用 PowerShell Expand-Archive；.tar.gz 用 tar（相对路径避开车符）。 */
function extractArchive(archive, tmp) {
  if (archive.endsWith('.zip')) {
    run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${archive}' -DestinationPath '${tmp}'`])
  } else {
    run('tar', ['-xf', basename(archive), '-C', basename(tmp)], { cwd: RELEASE })
  }
}

/** 递归查找文件名等于 name 的文件，返回绝对路径或 null。 */
function findFile(root, name) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === name) return p
    }
  }
  return null
}

async function fetchNodeVersion() {
  try {
    const r = await fetch('https://nodejs.org/dist/index.json')
    if (r.ok) {
      const arr = await r.json()
      for (const it of arr) if (it.lts) return it.version // 首个 LTS（如 "v22.12.0"）
    }
  } catch (e) {
    console.warn('  ⚠️ 无法查询最新 Node LTS（', e.message, '），改用兜底版本。')
  }
  return process.env.LIMKENION_NODE_VERSION || 'v22.12.0'
}

async function download(url, dest) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  writeFileSync(dest, buf)
  console.log(`    已下载 ${basename(dest)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
}

// 内置 Node 目标：win/linux 放根 node/，mac 放 .app 内部（随 .app 移动）
const NODE_TARGETS = [
  {
    sub: 'win-x64',
    dir: join(STAGE, 'node', 'win-x64'),
    bin: 'node.exe',
    url: v => `https://nodejs.org/dist/${v}/node-${v}-win-x64.zip`,
  },
  {
    sub: 'darwin-arm64',
    dir: join(STAGE, 'Limkenion.app', 'Contents', 'Resources', 'node', 'darwin-arm64'),
    bin: 'node',
    url: v => `https://nodejs.org/dist/${v}/node-${v}-darwin-arm64.tar.gz`,
  },
  {
    sub: 'darwin-x64',
    dir: join(STAGE, 'Limkenion.app', 'Contents', 'Resources', 'node', 'darwin-x64'),
    bin: 'node',
    url: v => `https://nodejs.org/dist/${v}/node-${v}-darwin-x64.tar.gz`,
  },
  {
    sub: 'linux-x64',
    dir: join(STAGE, 'node', 'linux-x64'),
    bin: 'node',
    url: v => `https://nodejs.org/dist/${v}/node-${v}-linux-x64.tar.gz`,
  },
]

async function bundleNode(nv) {
  console.log(`内置 Node 版本：${nv}`)
  for (const t of NODE_TARGETS) {
    const archiveBase = t.url(nv).split('/').pop() // 真实文件名（.zip/.tar.gz），便于 bsdtar 自动识别格式
    const tmpBase = `node-tmp-${t.sub}`
    const archive = join(RELEASE, archiveBase)
    const tmp = join(RELEASE, tmpBase)
    try {
      await download(t.url(nv), archive)
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(tmp, { recursive: true })
      // .zip（Windows）走 PowerShell，.tar.gz 走 tar（相对路径避开车符）
      extractArchive(archive, tmp)
      const bin = findFile(tmp, t.bin)
      if (!bin) throw new Error(`在 ${t.sub} 包中找不到 ${t.bin}`)
      mkdirSync(t.dir, { recursive: true })
      cpSync(bin, join(t.dir, t.bin))
      const lic = findFile(tmp, 'LICENSE')
      if (lic) cpSync(lic, join(STAGE, 'node', 'LICENSE'), { force: true }) // 仅存一份
      console.log(`  ✓ 内置 ${t.sub}`)
    } catch (e) {
      console.warn(`  ⚠️ 内置 ${t.sub} 失败：${e.message}（将回退系统 Node + 启动提醒）`)
    } finally {
      rmSync(archive, { force: true })
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

async function main() {
  // 1. 确保前端已构建
  if (!existsSync(join(WEB, 'dist'))) {
    console.log('dist 不存在，先构建前端……')
    run('npm', ['run', 'build'])
  }
  // 2. 确保 ws 已安装
  if (!existsSync(join(WEB, 'node_modules', 'ws'))) {
    console.log('node_modules/ws 不存在，先 npm install……')
    run('npm', ['install'])
  }

  // 3. 准备暂存目录
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(STAGE, { recursive: true })

  cpSync(join(WEB, 'dist'), join(STAGE, 'dist'), { recursive: true })
  cpSync(join(WEB, 'server'), join(STAGE, 'server'), { recursive: true })
  cpSync(join(WEB, 'node_modules', 'ws'), join(STAGE, 'node_modules', 'ws'), { recursive: true })

  for (const f of ['limkenion.vbs', 'limkenion.sh', 'limkenion.desktop', 'README.md', 'version.json']) {
    cpSync(join(WEB, 'launcher', f), join(STAGE, f), { recursive: false })
  }
  cpSync(join(WEB, 'launcher', 'Limkenion.app'), join(STAGE, 'Limkenion.app'), { recursive: true })

  // 4. 内置 Node（先拷好 .app 骨架，再把 node 放进去）
  const nv = await fetchNodeVersion()
  await bundleNode(nv)

  // 5. 根目录提醒：已内置 Node，无需安装
  writeFileSync(
    join(STAGE, 'NEEDS_NODE.txt'),
    [
      'Limkenion 桌面启动器 · 运行前须知',
      '================================',
      '',
      '本软件已内置 Node.js（MIT 许可，许可证见 node/LICENSE），通常无需你另行安装。',
      '',
      '  Windows：使用内置 node\\win-x64\\node.exe',
      '  macOS  ：使用内置 Limkenion.app/Contents/Resources/node/<架构>/node',
      '  Linux  ：使用内置 node/linux-x64/node',
      '',
      '仅当内置 Node 被误删、且系统也未安装 Node.js 时，双击才会弹出提示引导安装。',
      '如需手动安装：https://nodejs.org （版本 >= 20.11，并确保 node 在 PATH 中）。',
      '',
      '各平台入口：',
      '  Windows : limkenion.vbs',
      '  macOS   : Limkenion.app',
      '  Linux   : limkenion.desktop / limkenion.sh',
    ].join('\n') + '\n',
  )

  // 6. 写版本清单
  const versionJson = {
    version: VERSION,
    assetUrl: process.env.LIMKENION_RELEASE_URL ?? '',
    info: `Limkenion web ${VERSION}（内置 Node ${nv}）`,
  }
  writeFileSync(join(STAGE, 'version.json'), JSON.stringify(versionJson, null, 2))

  // 7. 压缩（Windows 用自带 bsdtar -a 按扩展名出 zip，相对路径避开车符；POSIX 用 zip）
  rmSync(OUT_ZIP, { force: true })
  if (process.platform === 'win32') {
    run('tar', ['-a', '-cf', basename(OUT_ZIP), '-C', 'stage', '.'], { cwd: RELEASE })
  } else {
    run('zip', ['-r', '-q', OUT_ZIP, '.'], { cwd: STAGE })
  }

  console.log(`\n已生成发布包（内置 Node ${nv}）：\n  ${OUT_ZIP}`)
  console.log('三平台通用，解压即双击可用，无需安装 Node。')
  if (!versionJson.assetUrl) {
    console.log('提示：设置 LIMKENION_RELEASE_URL 可把更新包地址写进 version.json，启用应用内「检查更新」。')
  }
  // 清理暂存
  rmSync(STAGE, { recursive: true, force: true })
}

main().catch(e => {
  console.error('出包失败：', e)
  process.exit(1)
})
