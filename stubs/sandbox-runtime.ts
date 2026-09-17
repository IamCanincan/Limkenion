/**
 * STUB for @limkenion-ai/sandbox-runtime — 上游内部私有包.
 * Not published on npm; upstream does not ship it either.
 * Type-compatible no-op surface so the bundle resolves.
 * Real functionality is permanently unavailable in this build.
 *
 * 沙箱在本地 DeepSeek 构建里「永久不可用」：
 * - isSupportedPlatform() 返回 false → isSandboxingEnabled() 短路为 false，
 *   REPL/启动渲染不再崩，也不会去检测依赖。
 * - 其余被 utils/sandbox/sandbox-adapter.ts 转发的静态方法全部返回安全默认值，
 *   保证任何路径触达都不会抛 "not a function"。
 */
export type AnyModule = Record<string, any>
export function createSandboxRuntime(..._a: any[]): any { return null }
export type SandboxRuntime = any

export const SandboxRuntimeConfigSchema: any = {
  parse: (v: any) => v,
  safeParse: (v: any) => ({ success: true, data: v }),
  parseAsync: async (v: any) => v,
  safeParseAsync: async (v: any) => ({ success: true, data: v }),
}

export class SandboxViolationStore {
  constructor(..._args: any[]) {}
  add(..._args: any[]): void {}
  getViolations(..._args: any[]): any[] { return [] }
  clear(..._args: any[]): void {}
}

export default {}

export class SandboxManager {
  constructor(..._args: any[]) {}
  async start(..._args: any[]): Promise<any> { return null }
  async stop(..._args: any[]): Promise<void> {}

  /** 平台不被支持 → 沙箱全局关闭，启动不再崩溃。 */
  static isSupportedPlatform(): boolean {
    return false
  }

  static checkDependencies(_opt?: any): any {
    return { errors: [], warnings: [] }
  }

  static wrapWithSandbox(command: string, ..._args: any[]): string {
    // 沙箱不可用：原样放行命令，不包裹。
    return command
  }

  static async initialize(..._args: any[]): Promise<void> {}
  static updateConfig(..._args: any[]): void {}
  static async reset(..._args: any[]): Promise<void> {}
  static async waitForNetworkInitialization(..._args: any[]): Promise<boolean> {
    return true
  }
  static cleanupAfterCommand(..._args: any[]): void {}
  static getFsReadConfig(..._args: any[]): any { return {} }
  static getFsWriteConfig(..._args: any[]): any { return {} }
  static getNetworkRestrictionConfig(..._args: any[]): any { return {} }
  static getIgnoreViolations(..._args: any[]): any { return undefined }
  static getAllowUnixSockets(..._args: any[]): any { return undefined }
  static getAllowLocalBinding(..._args: any[]): any { return undefined }
  static getEnableWeakerNestedSandbox(..._args: any[]): any { return undefined }
  static getProxyPort(..._args: any[]): any { return undefined }
  static getSocksProxyPort(..._args: any[]): any { return undefined }
  static getLinuxHttpSocketPath(..._args: any[]): any { return undefined }
  static getLinuxSocksSocketPath(..._args: any[]): any { return undefined }
  static getSandboxViolationStore(..._args: any[]): any {
    return new SandboxViolationStore()
  }
  static annotateStderrWithSandboxFailures(_stderr: string, ..._args: any[]): string {
    return _stderr
  }
}