/**
 * Skill-discovery prefetch pipeline — the local integration point.
 *
 * Two entry points, both fully local:
 *   - startSkillDiscoveryPrefetch / collectSkillDiscoveryPrefetch: inter-turn
 *     discovery. query.ts kicks the search off while the model streams, then
 *     awaits the collected attachment list after tools run.
 *   - getTurnZeroSkillDiscovery: turn-0 (user input) discovery, called by
 *     attachments.ts userInputAttachments.
 *
 * Both return arrays of `skill_discovery` attachment descriptors that
 * utils/messages.ts renders as "Skills relevant to your task:" reminders. Every
 * result path is defensive: on any error or zero matches we return an empty
 * array so the main query loop is never broken.
 */

import {
  getSkillIndex,
  scoreSkill,
} from './localSearch.js'
import type { SkillIndexEntry } from './localSearch.js'
import { MAX_SKILLS_PER_DISCOVERY } from './featureCheck.js'
import type { DiscoverySignal } from './signals.js'

const SIGNAL: DiscoverySignal = { type: 'local_skill_search' }
const SOURCE = 'native' as const

/** A single skill surfaced by discovery. */
interface DiscoveredSkill {
  name: string
  description: string
}

/** Shape of a skill_discovery attachment descriptor. */
interface SkillDiscoveryAttachment {
  type: 'skill_discovery'
  skills: DiscoveredSkill[]
  signal: DiscoverySignal
  source: 'native' | 'aki' | 'both'
}

/** Handle returned by startSkillDiscoveryPrefetch. */
interface DiscoveryPrefetchHandle {
  promise: Promise<SkillDiscoveryAttachment[]>
  settledAt: number | null
  consumedOnIteration: number
}

// Names already surfaced this process, so we don't repeat the same skill on
// every single turn (mirrors the "already visible" filter described in prompts).
const surfacedThisProcess = new Set<string>()

/** Best-effort extraction of user text from a message list. Never throws. */
function extractUserText(messages: unknown[]): string {
  const parts: string[] = []
  try {
    for (const msg of messages) {
      const m = msg as { type?: string; message?: { content?: unknown } }
      if (m?.type !== 'user') continue
      const content = m.message?.content
      if (typeof content === 'string') {
        parts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block && typeof block.text === 'string') parts.push(block.text)
        }
      }
    }
  } catch {
    // ignore malformed messages
  }
  return parts.slice(0, 8).join('\n')
}

/**
 * Core discovery: combine the query text, rank the local index, and return the
 * top-scoring skills not yet surfaced. Defensive end-to-end.
 */
async function runLocalDiscovery(query: string): Promise<SkillDiscoveryAttachment[]> {
  try {
    const index: SkillIndexEntry[] = await getSkillIndex()
    const scored = index
      .map(e => ({ entry: e, score: scoreSkill(query, e) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)

    const chosen: DiscoveredSkill[] = []
    for (const { entry } of scored) {
      if (chosen.length >= MAX_SKILLS_PER_DISCOVERY) break
      const name = entry.name || entry.dir.split(/[\\/]/).pop() || ''
      if (!name || surfacedThisProcess.has(name)) continue
      surfacedThisProcess.add(name)
      chosen.push({ name, description: entry.description })
    }
    if (chosen.length === 0) return []
    return [{ type: 'skill_discovery', skills: chosen, signal: SIGNAL, source: SOURCE }]
  } catch {
    return []
  }
}

/**
 * Kick off an inter-turn skill-discovery search. The first arg is a signal
 * (may be null), the second is the current message list. Returns a handle whose
 * `.promise` resolves to the attachment list; collection never blocks the turn.
 */
export function startSkillDiscoveryPrefetch(
  _signal: DiscoverySignal | null,
  messages: unknown[],
  _toolUseContext: unknown,
): DiscoveryPrefetchHandle {
  const query = extractUserText(messages)
  const promise = runLocalDiscovery(query).catch(() => [])
  return {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
  }
}

/**
 * Await a pending prefetch and return its attachment list. Always an array
 * (empty on error / no matches). Callers feed each element to
 * createAttachmentMessage.
 */
export async function collectSkillDiscoveryPrefetch(
  handle: DiscoveryPrefetchHandle,
): Promise<SkillDiscoveryAttachment[]> {
  if (!handle || !handle.promise) return []
  try {
    const result = await handle.promise
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

/**
 * Turn-0 discovery from the raw user input + surrounding messages. Returns the
 * attachment array directly (empty when nothing matched). Used by
 * attachments.ts userInputAttachments.
 */
export async function getTurnZeroSkillDiscovery(
  input: string,
  messages: unknown[],
  _context: unknown,
): Promise<SkillDiscoveryAttachment[]> {
  const text =
    typeof input === 'string' && input.trim()
      ? input
      : extractUserText(Array.isArray(messages) ? messages : [])
  if (!text.trim()) return []
  return runLocalDiscovery(text)
}

export type { SkillDiscoveryAttachment }