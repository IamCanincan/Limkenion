/**
 * STUB — built-in bundled workflows.
 * Upstream upstream-ref-impl does not ship this file either; it is a codegen artifact
 * in the real build (bundled workflow definitions compiled into the binary).
 * Safe no-op: registering zero bundled workflows.
 */
export function initBundledWorkflows() {
  return []
}

export const BUNDLED_WORKFLOWS = []
export default { initBundledWorkflows, BUNDLED_WORKFLOWS }
