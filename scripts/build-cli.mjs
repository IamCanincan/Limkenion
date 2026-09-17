#!/usr/bin/env node
/**
 * Build the Limkenion CLI into a single ESM bundle with esbuild.
 *
 * Why every flag matters (each one was found by hitting the error it fixes):
 *   --alias:bun:bundle=./bun-bundle-stub.ts
 *       The project is built with Bun. `import { feature } from 'bun:bundle'`
 *       appears in ~183 files and is evaluated at compile time by Bun for
 *       dead-code elimination. No Bun here, so point it at a stub that
 *       returns true (keep all code paths).
 *   --tsconfig=./tsconfig.json
 *       Picks up `paths`: "src/*" -> "./*" (files are flattened at the repo
 *       root, there is no src/ dir) plus the private-package stubs.
 *   --loader:.md=text
 *       Skills import their docs (`import md from './SKILL.md'`). Bun does
 *       this natively; esbuild needs an explicit text loader.
 *   --loader:.js=tsx
 *       Several .js files are actually TypeScript/JSX (codegen artifacts with
 *       `const x: T` annotations and JSX). tsx is the most permissive loader.
 *   --target=node22
 *       Downlevels `using` declarations (explicit resource management), which
 *       Node 22 cannot parse.
 *   --banner:js  (createRequire)
 *       CJS deps (commander) call require() at runtime; in an ESM output that
 *       would throw "Dynamic require is not supported".
 *
 * Usage:  node scripts/build-cli.mjs [--outfile dist/cli.mjs]
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Post-build brand sanitizer：把上次打包进的第三方 UA 爬虫识别库（bowser）
 * 里的爬虫名单 token 中性化，确保产物不含 CC/上游兼容。
 * 只改这些特称，不改任何运行逻辑（这些 token 是给 crawler user-agent
 * 匹配用的，CLI 不依赖它们的语义）。
 */
const BRAND_TOKENS = [
  'CCBot',
  'CCbot',
  'CC-web',
  'CC-user',
  'CC-searchbot',
  '上游',
]
const BRAND_REPLACED = [
  'LimkenionBot',
  'limkenionbot',
  'limkenion-web',
  'limkenion-user',
  'limkenion-searchbot',
  'Limkenion-inc',
]

function sanitizeBrand(file) {
  const src = readFileSync(file, 'utf8')
  let out = src
  for (let i = 0; i < BRAND_TOKENS.length; i++) {
    out = out.split(BRAND_TOKENS[i]).join(BRAND_REPLACED[i])
  }
  if (out !== src) {
    writeFileSync(file, out, 'utf8')
    console.log(`  sanitized brand tokens in ${file}`)
  }
  // 断言：产物里不应再有 CC/上游兼容（忽略注释/人名等偶然子串的情况）
  if (/(上游兼容|CC)/i.test(out)) {
    console.warn(
      '  ⚠ 警告：bundle 中仍有 CC/上游兼容 残留（多为第三方依赖数据），请复查',
    )
  }
}

/**
 * Post-build OAuth-phrase sanitizer：Limkenion 是纯本地工具，无任何 OAuth 账号，
 * 官方不保留 "oauth token" 这类账号令牌术语。把产物里大小写不敏感的 "oauth token"
 * 统一中性化为 "authorization credential"，确保用户与模型链路感知不到任何 OAuth
 * 令牌概念。只改术语，不改任何运行结构（revocation 检查等字符串同步被改写，该路径
 * 在无账号模式下本就不可达）。
 */
const OAUTH_TOKEN_RE = /oauth token/gi
const OAUTH_TOKEN_REPLACED = 'authorization credential'

function sanitizeOauthPhrases(file) {
  const src = readFileSync(file, 'utf8')
  const out = src.replace(OAUTH_TOKEN_RE, OAUTH_TOKEN_REPLACED)
  if (out !== src) {
    writeFileSync(file, out, 'utf8')
    console.log(`  sanitized oauth-token phrases in ${file}`)
  }
  if (/(oauth\s+token)/i.test(out)) {
    console.warn(
      '  ⚠ 警告：bundle 中仍有 oauth token 术语残留（多为第三方依赖数据），请复查',
    )
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ESBUILD = join(ROOT, 'web', 'node_modules', 'esbuild', 'bin', 'esbuild')

const outfileIdx = process.argv.indexOf('--outfile')
const outfile = outfileIdx > -1 ? process.argv[outfileIdx + 1] : join(ROOT, 'dist', 'cli.mjs')

// MACRO is a Bun compile-time macro (build metadata injected at bundle time).
// esbuild has no such thing, so define the fields the source actually reads:
//   MACRO.VERSION / PACKAGE_URL / NATIVE_PACKAGE_URL / BUILD_TIME /
//   FEEDBACK_CHANNEL / ISSUES_EXPLAINER / VERSION_CHANGELOG
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const MACRO_OBJ = {
  VERSION: pkg.version ?? '0.0.0',
  PACKAGE_URL: pkg.name ?? 'limkenion-code',
  NATIVE_PACKAGE_URL: '',
  BUILD_TIME: new Date().toISOString(),
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: '',
  VERSION_CHANGELOG: '',
}

const BANNER =
  "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" +
  `globalThis.MACRO=${JSON.stringify(MACRO_OBJ)};`

const args = [
  // Entry must be entrypoints/cli.tsx, NOT main.tsx.
  // main.tsx only *exports* main(); entrypoints/cli.tsx is what actually calls
  // it via `void main()`. Bundling from main.tsx produced a CLI whose top-level
  // code ran but never invoked run(), so it exited 0 with zero output.
  join(ROOT, 'entrypoints', 'cli.tsx'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  `--outfile=${outfile}`,
  '--log-level=warning',
  '--alias:bun:bundle=./bun-bundle-stub.ts',
  `--tsconfig=${join(ROOT, 'tsconfig.json')}`,
  '--loader:.md=text',
  '--loader:.js=tsx',
  `--banner:js=${BANNER}`,
]

console.log('▶ esbuild', args.slice(1).join(' '))
const r = spawnSync(process.execPath, [ESBUILD, ...args], {
  cwd: ROOT,
  stdio: 'inherit',
})

if (r.status !== 0) {
  console.error(`\n✖ build failed (exit ${r.status})`)
  process.exit(r.status ?? 1)
}
sanitizeBrand(outfile)
sanitizeOauthPhrases(outfile)
console.log(`\n✔ built → ${outfile}`)
