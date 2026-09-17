/**
 * Feature gate for local skill search.
 *
 * This is the single source of truth the rest of the codebase consults via
 * `skillSearchFeatureCheck?.isSkillSearchEnabled()` (prompts.ts, attachments.ts)
 * and the spread in SkillTool.ts. When this feature is compiled in (i.e.
 * 'EXPERIMENTAL_SKILL_SEARCH' has been removed from the disabled-set in
 * bun-bundle-stub.ts), these modules actually load and this returns true so the
 * discovery surfaces activate. Every call site guards with optional chaining,
 * so an unexpected `false` here degrades cleanly to "no discovery" rather than
 * throwing.
 */

/** Whether automatic skill discovery is enabled for the current process. */
export function isSkillSearchEnabled(): boolean {
  return true
}

/**
 * Total number of skills the discovery pass may surface as a single attachment.
 * Kept here so prompts/attachments and the search itself share one budget.
 */
export const MAX_SKILLS_PER_DISCOVERY = 5