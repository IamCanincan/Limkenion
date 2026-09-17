/**
 * Local skill index used by the on-device skill-discovery search.
 *
 * Scans the project's on-disk skills (bundled + user/project /skills dirs),
 * builds a small in-memory index, and exposes a keyword-relevance scorer used
 * by prefetch.ts. Fully local — no remote backend, no network.
 *
 * All public functions are defensive: any failure (missing dirs, unreadable
 * files, malformed frontmatter) degrades to an empty index / zero score rather
 * than throwing, so the main query loop never breaks.
 */

import { getProjectRoot } from '../../bootstrap/state.js'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SkillIndexEntry {
  /** Absolute directory containing the skill (the SKILL.md's parent). */
  dir: string
  /** Skill name (directory name, or frontmatter `name` if present). */
  name: string
  /** Short human description pulled from frontmatter or the first paragraph. */
  description: string
  /** Parsed frontmatter as a flat record (empty when none). */
  frontmatter: Record<string, unknown>
  /** Raw SKILL.md content (readme) used for deeper relevance matching. */
  readme: string
}

// Default candidates for skill directories, relative to the project root.
const DEFAULT_SUBDIRS = ['skills/bundled', 'skills', '.limkenion/skills']

let cachedIndex: SkillIndexEntry[] | null = null

/** Parse a YAML-ish frontmatter block into a flat record. Best-effort. */
function parseFrontmatter(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!m) return result
  for (const rawLine of m[1]!.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('-')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value: unknown = line.slice(idx + 1).trim()
    value = value.replace(/^['"]|['"]$/g, '')
    if (key) result[key] = value
  }
  return result
}

/** Derive a one-line description from the readme body when frontmatter lacks one. */
function deriveDescription(readme: string): string {
  const body = readme.replace(/^---[\s\S]*?---\s*/, '')
  const firstLine = body
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)[0]
  if (!firstLine) return ''
  return firstLine.replace(/^[#>*\-\s]+/, '').slice(0, 160)
}

/** Attempt to load one skill directory, returning null on any failure. */
async function loadSkillDir(dir: string): Promise<SkillIndexEntry | null> {
  const skillFile = join(dir, 'SKILL.md')
  let content: string
  try {
    content = await readFile(skillFile, 'utf-8')
  } catch {
    return null
  }
  const frontmatter = parseFrontmatter(content)
  const nameRaw = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
  const name = nameRaw || dir.split(/[\\/]/).pop() || ''
  const descRaw =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  const description = descRaw || deriveDescription(content)
  return { dir, name, description, frontmatter, readme: content }
}

/**
 * Build/re-scan the full index from disk. Memoized; see getSkillIndex().
 * Pass `extraPaths` to layer additional skill directories on top of the
 * default set (override path list).
 */
export async function buildSkillIndex(
  extraPaths?: string[],
): Promise<SkillIndexEntry[]> {
  const root = getProjectRoot()
  const candidates: string[] = [...DEFAULT_SUBDIRS, ...(extraPaths ?? [])].map(
    d => join(root, d),
  )

  // Expand each candidate into its immediate subdirectories.
  const entries: SkillIndexEntry[] = []
  for (const candidate of candidates) {
    let subs: string[]
    try {
      subs = await readdir(candidate, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory() && !sub.isSymbolicLink()) continue
      const entry = await loadSkillDir(join(candidate, sub.name))
      if (entry) entries.push(entry)
    }
  }
  // De-duplicate by name (first wins) to keep the listing stable.
  const seen = new Set<string>()
  return entries.filter(e => (seen.has(e.name) ? false : (seen.add(e.name), true)))
}

/**
 * Memoized access to the local skill index. Callers that need a re-scan after
 * on-disk changes (e.g. MCP connection changes, `/reload-plugins`) call
 * clearSkillIndexCache() first — see getSkillIndex callers in commands.ts and
 * useManageMCPConnections.ts. Never throws: returns [] on any failure.
 */
export async function getSkillIndex(
  extraPaths?: string[],
): Promise<SkillIndexEntry[]> {
  if (cachedIndex) return cachedIndex
  try {
    cachedIndex = await buildSkillIndex(extraPaths)
  } catch {
    cachedIndex = []
  }
  return cachedIndex
}

/** Drop the memoized index so the next getSkillIndex() re-scans from disk. */
export function clearSkillIndexCache(): void {
  cachedIndex = null
}

/** Split freeform text into lowercased keyword tokens. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter(Boolean)
}

/**
 * Keyword-relevance score of a query against a single index entry.
 * Higher is better; 0 means no overlap. Used by prefetch.ts to rank skills
 * before injection. Never throws.
 */
export function scoreSkill(q: string, entry: SkillIndexEntry): number {
  const haystack = [entry.name, entry.description, entry.readme]
    .join(' ')
    .toLowerCase()
  let score = 0
  for (const tok of tokenize(q)) {
    if (haystack.includes(tok)) score += 1
    if (entry.name.toLowerCase() === tok) score += 1
  }
  return score
}