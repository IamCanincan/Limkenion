/**
 * PowerShell 权限模式校验。
 *
 * 根据当前权限模式检查命令是否应被自动允许。
 * 在“接受编辑”模式下，修改文件系统的 PowerShell cmdlet 可被自动允许。
 * 与 BashTool/modeValidation.ts 遵循相同模式。
 */

import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { ParsedPowerShellCommand } from '../../utils/powershell/parser.js'
import {
  deriveSecurityFlags,
  getPipelineSegments,
  PS_TOKENIZER_DASH_CHARS,
} from '../../utils/powershell/parser.js'
import {
  argLeaksValue,
  isAllowlistedPipelineTail,
  isCwdChangingCmdlet,
  isSafeOutputCommand,
  resolveToCanonical,
} from './readOnlyValidation.js'

/**
 * 在“接受编辑”模式下可被自动允许的、修改文件系统的 cmdlet。
 * 存储为规范（小写）cmdlet 名称。
 *
 * 参数绑定较复杂的 Tier 3 cmdlet 已被移除——它们会进入 'ask'。
 * 此处仅自动允许简单写 cmdlet（首个位置参数 = -Path），它们会经由
 * pathValidation.ts 中的 CMDLET_PATH_CONFIG 进行路径校验。
 */
const ACCEPT_EDITS_ALLOWED_CMDLETS = new Set([
  'set-content',
  'add-content',
  'remove-item',
  'clear-content',
])

function isAcceptEditsAllowedCmdlet(name: string): boolean {
  // resolveToCanonical 通过 COMMON_ALIASES 处理别名，例如 'rm' → 'remove-item'、
  // 'ac' → 'add-content'。任何解析为允许 cmdlet 的别名都会自动被允许。
  // Tier 3 cmdlet（new-item、copy-item、move-item 等）及其别名（mkdir、ni、cp、
  // mv 等）会解析为不在集合中的 cmdlet，从而进入 'ask'。
  const canonical = resolveToCanonical(name)
  return ACCEPT_EDITS_ALLOWED_CMDLETS.has(canonical)
}

/**
 * 会创建文件系统链接（重解析点或硬链接）的 New-Item -ItemType 值。
 * 三种都会在运行时重定向路径解析——符号链接和交接点是目录/文件重解析点；
 * 硬链接则别名化某个文件的索引节点。任何一种都可使后续的相对路径写入
 * 落到校验器视野之外。
 */
const LINK_ITEM_TYPES = new Set(['symboliclink', 'junction', 'hardlink'])

/**
 * 检查一个已转小写、破折号归一化的参数（已剥离冒号值）是否为 New-Item
 * 的 -ItemType 或 -Type 参数的无歧义 PowerShell 缩写。
 * 最短前缀：`-it`（避免与其他 New-Item 参数歧义）、`-ty`（避免 `-t` 与
 * `-Target` 冲突）。
 */
function isItemTypeParamAbbrev(p: string): boolean {
  return (
    (p.length >= 3 && '-itemtype'.startsWith(p)) ||
    (p.length >= 3 && '-type'.startsWith(p))
  )
}

/**
 * 检测 New-Item 创建文件系统链接（-ItemType SymbolicLink / Junction /
 * HardLink，或 -Type 别名）。链路会像 Set-Location/New-PSDrive 一样毒化
 * 后续路径解析：穿过链接的相对路径会解析到链接目标，而非校验器视野内。
 * Finding #18。
 *
 * 处理 PowerShell 参数缩写（`-it`、`-ite`、... `-itemtype`；`-ty`、`-typ`、
 * `-type`）、unicode 破折号前缀（en-dash/em-dash/horizontal-bar）以及
 * 冒号绑定值（`-it:Junction`）。
 */
export function isSymlinkCreatingCommand(cmd: {
  name: string
  args: string[]
}): boolean {
  const canonical = resolveToCanonical(cmd.name)
  if (canonical !== 'new-item') return false
  for (let i = 0; i < cmd.args.length; i++) {
    const raw = cmd.args[i] ?? ''
    if (raw.length === 0) continue
    // 归一化 unicode 破折号前缀（–、—、―）和前向斜杠（PS 5.1 参数前缀）→
    // ASCII `-`，使前缀比较可用。PS 分词器将四种破折号字符加 `/` 都视为
    // 参数标记。（bug #26）
    const normalized =
      PS_TOKENIZER_DASH_CHARS.has(raw[0]!) || raw[0] === '/'
        ? '-' + raw.slice(1)
        : raw
    const lower = normalized.toLowerCase()
    // 拆分冒号绑定值：-it:SymbolicLink → param='-it', val='symboliclink'
    const colonIdx = lower.indexOf(':', 1)
    const paramRaw = colonIdx > 0 ? lower.slice(0, colonIdx) : lower
    // 去除反引号转义：-Item`Type → -ItemType (bug #22)
    const param = paramRaw.replace(/`/g, '')
    if (!isItemTypeParamAbbrev(param)) continue
    const rawVal =
      colonIdx > 0
        ? lower.slice(colonIdx + 1)
        : (cmd.args[i + 1]?.toLowerCase() ?? '')
    // 去除冒号绑定值中的反引号转义：-it:Sym`bolicLink → symboliclink
    // 与 L103 的参数名去除逻辑保持一致。空格分隔的参数使用 .value
    // （由 .NET 解析器解决反引号），但冒号绑定使用 .text（原始源码）。
    // 去除两侧引号：-it:'SymbolicLink' 或 -it:"Junction" (bug #6)
    const val = rawVal.replace(/`/g, '').replace(/^['"]|['"]$/g, '')
    if (LINK_ITEM_TYPES.has(val)) return true
  }
  return false
}

/**
 * 根据当前权限模式检查命令是否应以不同方式处理。
 *
 * 在“接受编辑”模式下，自动允许修改文件系统的 PowerShell cmdlet。
 * 检查前使用 AST 解析别名。
 *
 * @param input - PowerShell 命令输入
 * @param parsed - 命令的解析后 AST
 * @param toolPermissionContext - 包含模式与权限的上下文
 * @returns
 * - 'allow' 如果当前模式允许自动批准
 * - 'passthrough' 如果没有适用的模式相关处理
 */
export function checkPermissionMode(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  // 跳过 bypass 与 dontAsk 模式（在其他地方处理）
  if (
    toolPermissionContext.mode === 'bypassPermissions' ||
    toolPermissionContext.mode === 'dontAsk'
  ) {
    return {
      behavior: 'passthrough',
      message: '模式在主权限流程中处理',
    }
  }

  if (toolPermissionContext.mode !== 'acceptEdits') {
    return {
      behavior: 'passthrough',
      message: '无需模式相关的校验',
    }
  }

  // acceptEdits 模式：检查所有命令是否均为修改文件系统的 cmdlet
  if (!parsed.valid) {
    return {
      behavior: 'passthrough',
      message: '无法对未解析的命令进行模式校验',
    }
  }

  // SECURITY: 检查是否包含子表达式、脚本块或成员调用，
  // 这些可能被用于向 acceptEdits 模式夹带任意代码。
  const securityFlags = deriveSecurityFlags(parsed)
  if (
    securityFlags.hasSubExpressions ||
    securityFlags.hasScriptBlocks ||
    securityFlags.hasMemberInvocations ||
    securityFlags.hasSplatting ||
    securityFlags.hasAssignments ||
    securityFlags.hasStopParsing ||
    securityFlags.hasExpandableStrings
  ) {
    return {
      behavior: 'passthrough',
      message:
        '命令包含需要批准的子表达式、脚本块或成员调用',
    }
  }

  const segments = getPipelineSegments(parsed)

  // SECURITY: 解析有效但片段为空 = 没有可检查的命令，不要自动允许
  if (segments.length === 0) {
    return {
      behavior: 'passthrough',
      message: '未找到可用于 acceptEdits 模式校验的命令',
    }
  }

  // SECURITY: 复合命令 cwd 失同步防护——与 BashTool 对齐。
  // 当复合命令中的任一语句包含 Set-Location/Push-Location/Pop-Location
  // （或 cd、sl、chdir、pushd、popd 等别名）时，cwd 会在语句之间改变。
  // 路径校验针对过期的进程 cwd 解析相对路径，因此后续语句中的写 cmdlet
  // 会指向与校验器所检查目录不同的目录。
  // 示例：`Set-Location ./.limkenion; Set-Content ./settings.json '...'` ——
  // 校验器将 ./settings.json 视为 /project/settings.json，但 PowerShell 实际
  // 写入 /project/.limkenion/settings.json。拒绝自动允许任何含有 cwd 变更
  // 命令的复合命令中的写操作。这与 BashTool 的 compoundCommandHasCd 防护
  // （BashTool/pathValidation.ts:630-655）一致。
  const totalCommands = segments.reduce(
    (sum, seg) => sum + seg.commands.length,
    0,
  )
  if (totalCommands > 1) {
    let hasCdCommand = false
    let hasSymlinkCreate = false
    let hasWriteCommand = false
    for (const seg of segments) {
      for (const cmd of seg.commands) {
        if (cmd.elementType !== 'CommandAst') continue
        if (isCwdChangingCmdlet(cmd.name)) hasCdCommand = true
        if (isSymlinkCreatingCommand(cmd)) hasSymlinkCreate = true
        if (isAcceptEditsAllowedCmdlet(cmd.name)) hasWriteCommand = true
      }
    }
    if (hasCdCommand && hasWriteCommand) {
      return {
        behavior: 'passthrough',
        message:
          '复合命令包含目录变更命令（Set-Location/Push-Location/Pop-Location）与写操作——由于路径校验使用过期的 cwd，无法自动允许',
      }
    }
    // SECURITY: 创建链接的复合命令防护（finding #18）。镜像上面的
    // cd 防护。`New-Item -ItemType SymbolicLink -Path ./link -Value /etc;
    // Get-Content ./link/passwd` ——路径校验在校验时针对 cwd 解析
    // ./link/passwd（当时那里没有链接），而运行时则会跟随刚创建的链接
    // 到 /etc/passwd。与 cwd 失同步具有相同的 TOCTOU 形态。
    // 适用于 SymbolicLink、Junction 与 HardLink——三者都会在运行时重定向
    // 路径解析。
    // 不要求 hasWriteCommand：穿透链接读取同样危险（例如通过
    // Get-Content ./link/etc/shadow 外泄），并且任何在刚创建的链接之后
    // 使用路径的命令都无法校验。
    if (hasSymlinkCreate) {
      return {
        behavior: 'passthrough',
        message:
          '复合命令创建文件系统链接（New-Item -ItemType SymbolicLink/Junction/HardLink）——由于路径校验无法跟随刚刚创建的链接，无法自动允许',
      }
    }
  }

  for (const segment of segments) {
    for (const cmd of segment.commands) {
      if (cmd.elementType !== 'CommandAst') {
        // SECURITY: 此防护对三种情况都至关重要。不要收窄它。
        //
        // 1. 表达式管道来源（设计如此）：'/etc/passwd' | Remove-Item
        //    ——字符串字面量是 CommandExpressionAst，管道值绑定到 -Path。
        //    我们无法静态得知它代表的路径。
        //
        // 2. 控制流语句（偶然但被依赖）：foreach ($x in ...) { Remove-Item $x }。
        //    非 PipelineAst 语句会在 segment.commands 中产生合成的
        //    CommandExpressionAst 条目（parser.ts transformStatement）。
        //    若无此防护，嵌套命令中的 Remove-Item $x 会在下方被检查并自动
        //    允许——但 $x 是我们无法校验的循环绑定变量。
        //
        // 3. 非 PipelineAst 重定向覆盖（偶然）：cmd && cmd2 > /tmp
        //    也会在此产生合成元素。isReadOnlyCommand 依赖同一偶然行为
        //    （其允许列表拒绝合成元素的完整名称），因此两条路径会共同
        //    安全失败。
        return {
          behavior: 'passthrough',
          message: `管道包含无法静态校验的表达式来源（${cmd.elementType}）`,
        }
      }
      // SECURITY: nameType 基于 stripModulePrefix 之前的原始名称计算。
      // 'application' = 原始名称含有路径字符（. \\ /）。scripts\\Remove-Item
      // 会剥离为 Remove-Item 并匹配下面的 ACCEPT_EDITS_ALLOWED_CMDLETS，
      // 但 PowerShell 运行的是 scripts\\Remove-Item.ps1。与
      // isAllowlistedCommand 相同门槛。
      if (cmd.nameType === 'application') {
        return {
          behavior: 'passthrough',
          message: `命令 '${cmd.name}' 由路径类名称解析而来，需要批准`,
        }
      }
      // SECURITY: elementTypes 白名单——与 isAllowlistedCommand 相同。
      // 上面的 deriveSecurityFlags 检查 hasSubExpressions 等，但不会标记
      // 裸的 Variable/Other elementType。`Remove-Item $env:PATH`：
      //   elementTypes = ['StringConstant', 'Variable']
      //   deriveSecurityFlags: 无子表达式 → 通过
      //   checkPathConstraints: 将字面文本 '$env:PATH' 作为相对路径解析
      //     → cwd/$env:PATH → 在 cwd 内 → 允许
      //   运行时：PowerShell 展开 $env:PATH → 删除实际环境变量的路径
      // isAllowlistedCommand 拒绝非 StringConstant/Parameter；这是
      // acceptEdits 的对等门槛。
      //
      // 同时检查冒号绑定的表达式元字符（与 isAllowlistedCommand 的
      // 冒号绑定检查相同）。`Remove-Item -Path:(1 > /tmp/x)`：
      //   elementTypes = ['StringConstant', 'Parameter'] —— 通过上方白名单
      //   deriveSecurityFlags: .Argument 中的 ParenExpressionAst 未被检测到
      //     （ParenExpressionAst 不在 FindAll 过滤器内）
      //   checkPathConstraints: 字面文本 '-Path:(1 > /tmp/x)' 不是路径
      //   运行时：括号求值，重定向写入 /tmp/x → 任意写入
      if (cmd.elementTypes) {
        for (let i = 1; i < cmd.elementTypes.length; i++) {
          const t = cmd.elementTypes[i]
          if (t !== 'StringConstant' && t !== 'Parameter') {
            return {
              behavior: 'passthrough',
              message: `命令参数含有无法校验的类型（${t}）——变量路径无法静态解析`,
            }
          }
          if (t === 'Parameter') {
            // elementTypes[i] ↔ args[i-1]（elementTypes[0] 是命令名）。
            const arg = cmd.args[i - 1] ?? ''
            const colonIdx = arg.indexOf(':')
            if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
              return {
                behavior: 'passthrough',
                message:
                  '冒号绑定参数包含无法静态校验的表达式',
              }
            }
          }
        }
      }
      // 安全输出 cmdlet（Out-Null 等）与允许列表中的管道尾变换器
      // （Format-*、Measure-Object、Select-Object 等）不影响前面命令的
      // 语义。跳过它们，使 `Remove-Item ./foo | Out-Null` 或
      // `Set-Content ./foo hi | Format-Table` 与裸写 cmdlet 获得相同的
      // 自动允许。isAllowlistedPipelineTail 是那些从 SAFE_OUTPUT_CMDLETS
      // 移到 CMDLET_ALLOWLIST 的 cmdlet 的窄回退（argLeaksValue 校验其参数）。
      if (
        isSafeOutputCommand(cmd.name) ||
        isAllowlistedPipelineTail(cmd, input.command)
      ) {
        continue
      }
      if (!isAcceptEditsAllowedCmdlet(cmd.name)) {
        return {
          behavior: 'passthrough',
          message: `在 acceptEdits 模式下对 '${cmd.name}' 无模式相关的特殊处理`,
        }
      }
      // SECURITY: 拒绝参数类型无法归类的命令。'Other' 涵盖
      // HashtableAst、ConvertExpressionAst、BinaryExpressionAst——它们都可能
      // 包含解析器无法完全分解的嵌套重定向或代码。isAllowlistedCommand
      // （readOnlyValidation.ts）已通过 argLeaksValue 强制执行该白名单；
      // 这里关闭 acceptEdits 模式下的同一缺口。若无此项，像 @{k='payload'
      // > ~/.bashrc} 这样的 -Value 参数会因 HashtableAst 映射到 'Other' 而通过。
      // argLeaksValue 也会捕获冒号绑定的变量（-Flag:$env:SECRET）。
      if (argLeaksValue(cmd.name, cmd)) {
        return {
          behavior: 'passthrough',
          message: `在 acceptEdits 模式下无法静态校验 '${cmd.name}' 中的参数`,
        }
      }
    }

    // 也检查来自控制流语句的嵌套命令
    if (segment.nestedCommands) {
      for (const cmd of segment.nestedCommands) {
        if (cmd.elementType !== 'CommandAst') {
          // SECURITY: 同上——嵌套命令（控制流体）中的非 CommandAst 元素
          // 无法作为路径来源静态校验。
          return {
            behavior: 'passthrough',
            message: `嵌套表达式元素（${cmd.elementType}）无法静态校验`,
          }
        }
        if (cmd.nameType === 'application') {
          return {
            behavior: 'passthrough',
            message: `嵌套命令 '${cmd.name}' 由路径类名称解析而来，需要批准`,
          }
        }
        if (
          isSafeOutputCommand(cmd.name) ||
          isAllowlistedPipelineTail(cmd, input.command)
        ) {
          continue
        }
        if (!isAcceptEditsAllowedCmdlet(cmd.name)) {
          return {
            behavior: 'passthrough',
            message: `在 acceptEdits 模式下对 '${cmd.name}' 无模式相关的特殊处理`,
          }
        }
        // SECURITY: 与上方主命令循环相同的 argLeaksValue 检查。
        if (argLeaksValue(cmd.name, cmd)) {
          return {
            behavior: 'passthrough',
            message: `在 acceptEdits 模式下无法静态校验嵌套 '${cmd.name}' 中的参数`,
          }
        }
      }
    }
  }

  // 所有命令均为修改文件系统的 cmdlet —— 自动允许
  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'mode',
      mode: 'acceptEdits',
    },
  }
}
