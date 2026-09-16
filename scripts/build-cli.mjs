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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ESBUILD = join(ROOT, 'web', 'node_modules', 'esbuild', 'bin', 'esbuild')

const outfileIdx = process.argv.indexOf('--outfile')
const outfile = outfileIdx > -1 ? process.argv[outfileIdx + 1] : join(ROOT, 'dist', 'cli.mjs')

const BANNER =
  "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"

const args = [
  join(ROOT, 'main.tsx'),
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
console.log(`\n✔ built → ${outfile}`)
