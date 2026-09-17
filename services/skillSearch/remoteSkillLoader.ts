/**
 * Remote skill loader (no-op).
 *
 * Remote skills are fetched from a networked backend that does not exist in the
 * local build. loadRemoteSkill is therefore a safe no-op that returns null; it
 * is only reachable inside EXPERIMENTAL_SKILL_SEARCH guards, and callers handle
 * a null/failed result without throwing.
 */

/**
 * Load a remote skill's content by slug + source URL.
 * Returns null (nothing to load) in this local build.
 */
export async function loadRemoteSkill(
  _slug: string,
  _url: string,
): Promise<string | null> {
  return null
}