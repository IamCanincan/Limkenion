/**
 * CLI 侧测试 runner：把 test-cli/*.test.ts 逐个用 esbuild 打成单文件
 * 再交给 `node --test` 跑。
 *
 * 打包口径与 scripts/build-cli.mjs 完全一致（bun:bundle alias / .md 文本
 * loader / .js 按 tsx 解析 / createRequire banner），否则 CLI 源码模块
 * 在纯 node 下会撞 `bun:bundle` 解析失败或 `Config accessed before allowed`。
 *
 * 用法：node scripts/run-cli-tests.mjs [文件名过滤…]
 */

import { build } from 'esbuild'
import { readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = join(ROOT, 'test-cli')
const OUT_DIR = join(TEST_DIR, '.build')

const filterArgs = process.argv.slice(2)

const testFiles = readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.ts'))
  .filter(f => filterArgs.length === 0 || filterArgs.some(a => f.includes(a)))
  .map(f => join(TEST_DIR, f))

if (testFiles.length === 0) {
  console.error('没有找到测试文件（test-cli/*.test.ts）')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })
const BANNER = "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"

const built = []
for (const file of testFiles) {
  const out = join(OUT_DIR, basename(file, '.ts') + '.mjs')
  try {
    await build({
      entryPoints: [file],
      outfile: out,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      alias: { 'bun:bundle': join(ROOT, 'bun-bundle-stub.ts') },
      loader: { '.md': 'text', '.js': 'tsx' },
      banner: { js: BANNER },
      tsconfig: join(ROOT, 'tsconfig.json'),
      logLevel: 'warning',
    })
    built.push(out)
  } catch (err) {
    console.error(`打包失败：${basename(file)}`)
    console.error(err?.message ?? err)
    process.exit(1)
  }
}

const result = spawnSync(process.execPath, ['--test', ...built], {
  stdio: 'inherit',
  cwd: ROOT,
})

// 保留 .build 便于排查；提供 CLEAN=1 一键清理
if (process.env.CLEAN === '1') {
  rmSync(OUT_DIR, { recursive: true, force: true })
}

process.exit(result.status ?? 1)
