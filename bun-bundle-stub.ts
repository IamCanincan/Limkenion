/**
 * Stub for `bun:bundle` when running outside Bun.
 * `feature(name)` returns `true` to preserve all code paths.
 * In real Bun builds, this module is replaced by the runtime
 * and `feature()` is evaluated at compile-time for dead-code elimination.
 */
export function feature(_name: string): boolean {
  return true
}
