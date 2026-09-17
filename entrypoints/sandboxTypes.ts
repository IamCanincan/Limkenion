/**
 * Sandbox types for the Limkenion Agent SDK
 *
 * This file is the single source of truth for sandbox configuration types.
 * Both the SDK and the settings validation import from here.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

/**
 * 沙箱的网络配置 schema。
 */
export const SandboxNetworkConfigSchema = lazySchema(() =>
  z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      allowManagedDomainsOnly: z
        .boolean()
        .optional()
        .describe(
          '为 true 时（并在托管设置中设置），仅遵守来自托管设置的 allowedDomains 与 WebFetch(domain:...) 允许规则。' +
            '忽略用户、项目、本地和标识设置的网域。来自所有来源的拒绝网域仍会被遵守。',
        ),
      allowUnixSockets: z
        .array(z.string())
        .optional()
        .describe(
          '仅限 macOS：要允许的 Unix socket 路径。在 Linux 上忽略（seccomp 无法按路径过滤）。',
        ),
      allowAllUnixSockets: z
        .boolean()
        .optional()
        .describe(
          '为 true 时，允许所有 Unix socket（在两个平台上都禁用拦截）。',
        ),
      allowLocalBinding: z.boolean().optional(),
      httpProxyPort: z.number().optional(),
      socksProxyPort: z.number().optional(),
    })
    .optional(),
)

/**
 * 沙箱的文件系统配置 schema。
 */
export const SandboxFilesystemConfigSchema = lazySchema(() =>
  z
    .object({
      allowWrite: z
        .array(z.string())
        .optional()
        .describe(
          '沙箱内额外允许写入的路径。' +
            '与 Edit(...) 允许权限规则中的路径合并。',
        ),
      denyWrite: z
        .array(z.string())
        .optional()
        .describe(
          '沙箱内额外禁止写入的路径。' +
            '与 Edit(...) 拒绝权限规则中的路径合并。',
        ),
      denyRead: z
        .array(z.string())
        .optional()
        .describe(
          '沙箱内额外禁止读取的路径。' +
            '与 Read(...) 拒绝权限规则中的路径合并。',
        ),
      allowRead: z
        .array(z.string())
        .optional()
        .describe(
          '在 denyRead 区域中重新允许读取的路径。' +
            '对于匹配的路径，优先于 denyRead。',
        ),
      allowManagedReadPathsOnly: z
        .boolean()
        .optional()
        .describe(
          '为 true 时（在托管设置中设置），仅使用来自 policySettings 的 allowRead 路径。',
        ),
    })
    .optional(),
)

/**
 * 沙箱设置 schema。
 */
export const SandboxSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional(),
      failIfUnavailable: z
        .boolean()
        .optional()
        .describe(
          '当 sandbox.enabled 为 true 但沙箱无法启动时，在启动时报错退出 ' +
            '（缺少依赖、平台不受支持，或是平台不在 enabledPlatforms 中）。' +
            '为 false（默认值）时，会显示警告，命令以非沙箱方式运行。' +
            '适用于要求将沙箱作为硬性门控的托管设置部署。',
        ),
      // 注意：enabledPlatforms 是通过 .passthrough() 读取的未记录设置。
      // 它把沙箱限制到特定平台（例如 ["macos"]）。
      //
      // 为了放行 NVIDIA 企业级部署而加入：他们想启用
      // autoAllowBashIfSandboxed，但初期只在 macOS 上启用，因为 Linux/WSL
      // 上的沙箱支持较新且未经充分验证。这使他们在其它平台准备好之前，
      // 可以设置 enabledPlatforms: ["macos"] 来禁用沙箱（以及自动放行）。
      autoAllowBashIfSandboxed: z.boolean().optional(),
      allowUnsandboxedCommands: z
        .boolean()
        .optional()
        .describe(
          '允许命令通过 dangerouslyDisableSandbox 参数在沙箱之外运行。' +
            '为 false 时，dangerouslyDisableSandbox 参数会被完全忽略，所有命令都必须在沙箱中运行。' +
            '默认值：true。',
        ),
      network: SandboxNetworkConfigSchema(),
      filesystem: SandboxFilesystemConfigSchema(),
      ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
      enableWeakerNestedSandbox: z.boolean().optional(),
      enableWeakerNetworkIsolation: z
        .boolean()
        .optional()
        .describe(
          '仅限 macOS：允许在沙箱中访问 com.apple.trustd.agent。' +
            '基于 Go 的 CLI 工具（gh、gcloud、terraform 等）在通过 httpProxyPort 使用带 MITM 代理和自定义 CA 时，需要它来验证 TLS 证书。' +
            '**会降低安全性** —— 通过 trustd 服务打开潜在的数据外泄途径。默认值：false',
        ),
      excludedCommands: z.array(z.string()).optional(),
      ripgrep: z
        .object({
          command: z.string(),
          args: z.array(z.string()).optional(),
        })
        .optional()
        .describe('内置 ripgrep 支持的自定义 ripgrep 配置'),
    })
    .passthrough(),
)

// 由 schema 推断出的类型
export type SandboxSettings = z.infer<ReturnType<typeof SandboxSettingsSchema>>
export type SandboxNetworkConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxNetworkConfigSchema>>
>
export type SandboxFilesystemConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxFilesystemConfigSchema>>
>
export type SandboxIgnoreViolations = NonNullable<
  SandboxSettings['ignoreViolations']
>
