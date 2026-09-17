/**
 * Remote-skill session state (no-op).
 *
 * Remote skill discovery/loading requires a networked backend that is not part
 * of the local build. All state operations are safe no-ops: callers use them
 * inside EXPERIMENTAL_SKILL_SEARCH guards, so this never runs in the default
 * path, but if it ever does it degrades cleanly (nothing discovered, no
 * canonical-prefix matching) instead of throwing.
 */

export interface RemoteSkillMeta {
  slug: string
  name: string
  description: string
  url: string
}

const discovered = new Map<string, RemoteSkillMeta>()

/** Look up a remote skill discovered this session. Returns null if absent. */
export function getDiscoveredRemoteSkill(slug: string): RemoteSkillMeta | null {
  return discovered.get(slug) ?? null
}



/**
 * Strip a canonical remote-skill prefix from a name. Returns the slug when the
 * name has the canonical marker, else null. No-ops to null locally (no remote
 * naming scheme is active).
 */
export function stripCanonicalPrefix(name: string): string | null {
  if (typeof name !== 'string') return null
  return name.startsWith('_canonical_') ? name.slice('_canonical_'.length) : null
}

