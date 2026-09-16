/**
 * STUB for @limkenion-ai/sandbox-runtime — 上游 internal private package.
 * Not published on npm; upstream upstream-ref-impl does not ship it either.
 * Type-compatible no-op surface so the bundle resolves.
 * Real functionality is permanently unavailable in this build.
 */
export type AnyModule = Record<string, any>
export function createSandboxRuntime(..._a: any[]): any { return null }
export type SandboxRuntime = any
export default {}

export class SandboxManager {
  constructor(..._args: any[]) {}
  async start(..._args: any[]): Promise<any> { return null }
  async stop(..._args: any[]): Promise<void> {}
}
