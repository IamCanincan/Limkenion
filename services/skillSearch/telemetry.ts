/**
 * Skill telemetry helpers (no-op).
 *
 * Local builds have no remote telemetry sink. All reporting functions are safe
 * no-ops so callers (SkillTool.ts's executeRemoteSkill path) can invoke them
 * unconditionally without guards or null-checks.
 */

interface RemoteSkillTelemetryFields {
  slug?: string
  cacheHit?: boolean
  latencyMs?: number
  urlScheme?: string
  error?: string
}

/** Record a remote skill load outcome. No-op locally. */
export function logRemoteSkillLoaded(_fields: RemoteSkillTelemetryFields): void {
  // no-op
}


