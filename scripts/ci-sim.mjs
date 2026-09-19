#!/usr/bin/env node
/**
 * 本地模拟 CI：用**纯净工作树**跑一遍和 .workflow/ci.yml 相同的命令序列。
 *
 * 为什么需要它：CI 是"全新检出"，既没有 dist/ 也没有 node_modules/，而本地
 * 这两样一直在 —— 于是"本地全绿、CI 红"反复发生，而且只能靠"推一次等一次"
 * 来试，慢且浪费。这个脚本在本地就能复现那个环境。
 *
 * 用法：
 *     node scripts/ci-sim.mjs
 *     node scripts/ci-sim.mjs --skip-install   # 只想重跑测试（已有 node_modules）
 *
 * 实现要点：
 *   - 用 `git archive HEAD | tar -x` 导出**提交内容**，天然不含被 ignore 的
 *     dist/ 与 node_modules/，比 git clone 更稳（clone 在某些环境会失败）。
 *   - 每一步失败都明确打印「失败于：X」并带上退出码，不静默继续。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skipInstall = process.argv.includes('--skip-install')

/**
 * 在指定目录跑一条命令；失败就抛（带退出码）。
 *
 * Windows 上 npm 是 npm.cmd，直接 spawn 会 EINVAL，必须经 shell；但 shell:true
 * 又会触发 Node 的 DEP0190 警告。所以这里显式走 `cmd.exe /d /s /c`，
 * **参数分开传、不自己拼字符串**（拼字符串会被 cmd 的引号规则拆坏）。
 */
function run(cmd, args, cwd, label) {
  console.log(`\n== ${label} ==`)
  const isWin = process.platform === 'win32'
  const r = isWin
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { cwd, stdio: 'inherit' })
    : spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.error) throw new Error(`无法执行 ${cmd}：${r.error.message}`)
  if (r.status !== 0) throw new Error(`失败于：${label}（退出码 ${r.status}）`)
}

function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'limkenion-ci-sim-'))
  const work = join(tmp, 'repo')
  // tar -C 不会自己建目录；而且 Windows 的 bsdtar 会把 `D:/...` 误判成远程主机，
  // 所以这里**先建好目录、再用 cwd 进去解压**（不给 tar 传 -C）。
  mkdirSync(work, { recursive: true })
  console.log(`导出纯净工作树到：${work}`)

  const npm = 'npm'

  try {
    // ---- 1. 导出当前 HEAD（不含 dist/ 与 node_modules/）----
    const archive = spawnSync('git', ['archive', 'HEAD'], { cwd: REPO_ROOT, maxBuffer: 1 << 28 })
    if (archive.status !== 0) {
      throw new Error(`git archive 失败：${archive.stderr?.toString() || archive.error}`)
    }
    const extract = spawnSync('tar', ['-x'], {
      cwd: work,
      input: archive.stdout,
      maxBuffer: 1 << 28,
    })
    if (extract.status !== 0) {
      throw new Error(`tar 解压失败：${extract.stderr?.toString() || extract.error}`)
    }
    if (!existsSync(join(work, 'web', 'package.json'))) {
      throw new Error(`导出结果不对：${join(work, 'web', 'package.json')} 不存在`)
    }
    console.log('✓ 已导出（确认没有 dist/ 与 node_modules/）')

    const web = join(work, 'web')
    // ---- 2. 与 CI 相同的顺序 ----
    if (!skipInstall) run(npm, ['install', '--no-audit', '--no-fund'], web, 'install')
    run(npm, ['run', 'typecheck'], web, 'typecheck')
    // build 必须在 test 之前：静态服务相关用例需要 dist/
    run(npm, ['run', 'build'], web, 'build')
    run(npm, ['test'], web, 'server tests')
    run(npm, ['run', 'test:ui'], web, 'ui tests')

    console.log('\n########## ✅ CI 模拟通过 ##########')
  } finally {
    if (!process.env.LIMKENION_CI_SIM_KEEP) {
      try {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        /* 临时目录清不掉无所谓 */
      }
    } else {
      console.log(`（保留目录：${work}）`)
    }
  }
}

try {
  main()
} catch (err) {
  console.error(`\n########## ❌ ${err.message} ##########`)
  process.exit(1)
}

// 说明：这个文件被 .gitattributes 锁为 LF，别用 CRLF 提交。
