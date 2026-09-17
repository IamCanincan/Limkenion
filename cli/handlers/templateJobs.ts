/**
 * 任务模板 CLI —— 本地 `limkenion new|list|reply` 子命令。
 *
 * 模板保存在 `~/.limkenion/templates.json`，结构：
 *   {
 *     "review-pr": {
 *       "name": "review-pr",
 *       "description": "Code review 的提示词模板",
 *       "prompt": "请对最近改动做一次 code review……",
 *       "tags": ["review", "code"],
 *       "createdAt": 1700000000000,
 *       "updatedAt": 1700000000000
 *     }
 *   }
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'

export interface TaskTemplate {
  name: string
  description: string
  prompt: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export type TemplateStore = Record<string, TaskTemplate>

function templatesFile(): string {
  return join(homedir(), '.limkenion', 'templates.json')
}

function loadStore(): TemplateStore {
  const f = templatesFile()
  if (!existsSync(f)) return {}
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as TemplateStore
  } catch {
    return {}
  }
}

function saveStore(store: TemplateStore): void {
  const f = templatesFile()
  mkdirSync(join(homedir(), '.limkenion'), { recursive: true })
  writeFileSync(f, JSON.stringify(store, null, 2), 'utf8')
}

function printUsage(): void {
  console.log(`任务模板 —— 复用常用的提示词

用法:
  limkenion list                         列出全部模板
  limkenion new <name> "<prompt>"        新建模板（可选 --description "..." --tag a --tag b）
  limkenion reply <name> [附加上下文..]   输出该模板 + 附加上下文组合后的提示词`)
}

function parseNewArgs(args: string[]): {
  name?: string
  prompt?: string
  description: string
  tags: string[]
} {
  let name: string | undefined
  let prompt: string | undefined
  const description: string[] = []
  const tags: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--description') description.push(args[++i])
    else if (a === '--tag') tags.push(args[++i])
    else if (a?.startsWith('-')) rest.push(a) // ignore unknown flags
    else if (name === undefined) name = a
    else if (prompt === undefined) prompt = a
    else prompt += ' ' + a
  }
  return { name, prompt, description: description.join(' '), tags }
}

export async function templatesMain(args: string[]): Promise<void> {
  const command = args[0]
  const store = loadStore()

  switch (command) {
    case 'list': {
      const names = Object.keys(store)
      if (names.length === 0) {
        console.log('（暂无模板，用 `limkenion new <name> "<prompt>"` 创建一个）')
        return
      }
      console.log('任务模板:')
      for (const name of names) {
        const t = store[name]
        const tags = t.tags.length ? ` [${t.tags.join(', ')}]` : ''
        const desc = t.description ? ` — ${t.description}` : ''
        console.log(`  • ${name}${tags}${desc}`)
      }
      return
    }

    case 'new': {
      const { name, prompt, description, tags } = parseNewArgs(args.slice(1))
      if (!name || !prompt) {
        console.error('用法：limkenion new <name> "<prompt>"')
        process.exitCode = 2
        return
      }
      if (store[name]) {
        console.error(`模板已存在：${name}（用 ` + 'limkenion reply ' + `${name} 查看，或先删除再重建）`)
        process.exitCode = 2
        return
      }
      store[name] = {
        name,
        description,
        prompt,
        tags,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      saveStore(store)
      console.log(`已创建模板：${name}`)
      return
    }

    case 'reply': {
      const name = args[1]
      const extra = args.slice(2).join(' ')
      const t = store[name]
      if (!t) {
        console.error(`找不到模板：${name}（用 \`limkenion list\` 查看）`)
        process.exitCode = 2
        return
      }
      const out = extra ? `${t.prompt}\n\n附加上下文：${extra}` : t.prompt
      console.log(out)
      return
    }

    default:
      printUsage()
  }
}