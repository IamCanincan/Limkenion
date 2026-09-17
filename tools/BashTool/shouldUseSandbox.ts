import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'

type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

// 注意：excludedCommands 是对用户友好的便捷功能，并非安全边界。
// 能够绕过 excludedCommands 并非安全缺陷——沙箱权限系统（会提示用户）才是真正的安全控制。
function containsExcludedCommand(command: string): boolean {
  // 从动态配置检查被禁用的命令与子串（仅针对 ant）

  // 从设置中检查用户配置的被排除命令
  const settings = getSettings_DEPRECATED()
  const userExcludedCommands = settings.sandbox?.excludedCommands ?? []

  if (userExcludedCommands.length === 0) {
    return false
  }

  // 将复合命令（如 "docker ps && curl evil.com"）拆分为单独的子命令，
  // 并逐一与排除模式比对。这防止复合命令只因第一个子命令匹配某个
  // 排除模式就从沙箱逃逸。
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    subcommands = [command]
  }

  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    // 同时尝试去除环境变量前缀和包装命令后再匹配，这样
    // `FOO=bar bazel ...` 与 `timeout 30 bazel ...` 都能匹配 `bazel:*`。这并非
    // 安全边界（见文首注释）；上面的 && 拆分已能让
    // `export FOO=bar && bazel ...` 匹配。BINARY_HIJACK_VARS 仅作为启发式规则保留。
    //
    // 我们迭代地应用两种剥离操作，直到不再产生新的候选项（不动点），
    // 与 filterRulesByContentsMatchingInput 中的做法一致。
    // 这能处理像 `timeout 300 FOO=bar bazel run` 这样交错出现的模式，
    // 单次组合剥离可能会失败。
    const candidates = [trimmed]
    const seen = new Set(candidates)
    let startIdx = 0
    while (startIdx < candidates.length) {
      const endIdx = candidates.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = candidates[i]!
        const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
        if (!seen.has(envStripped)) {
          candidates.push(envStripped)
          seen.add(envStripped)
        }
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          candidates.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }

    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      for (const cand of candidates) {
        switch (rule.type) {
          case 'prefix':
            if (cand === rule.prefix || cand.startsWith(rule.prefix + ' ')) {
              return true
            }
            break
          case 'exact':
            if (cand === rule.command) {
              return true
            }
            break
          case 'wildcard':
            if (matchWildcardPattern(rule.pattern, cand)) {
              return true
            }
            break
        }
      }
    }
  }

  return false
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  // 仅当被明确覆盖、且策略允许非沙箱命令时，才不进入沙箱
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  if (!input.command) {
    return false
  }

  // 命令包含用户配置的排除命令时，不进入沙箱
  if (containsExcludedCommand(input.command)) {
    return false
  }

  return true
}
