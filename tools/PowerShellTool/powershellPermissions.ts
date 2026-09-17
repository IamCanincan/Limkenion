/**
 * PowerShell 专用的权限检查，改编自 bashPermissions.ts，
 * 用于大小写不敏感的 cmdlet 匹配。
 */

import { resolve } from 'path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from '../../types/permissions.js'
import { getCwd } from '../../utils/cwd.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import type { PermissionRule } from '../../utils/permissions/PermissionRule.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForToolName,
} from '../../utils/permissions/permissions.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
  type ShellPermissionRule,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
} from '../../utils/permissions/shellRuleMatching.js'
import {
  classifyCommandName,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  type ParsedCommandElement,
  type ParsedPowerShellCommand,
  PS_TOKENIZER_DASH_CHARS,
  parsePowerShellCommand,
  stripModulePrefix,
} from '../../utils/powershell/parser.js'
import { containsVulnerableUncPath } from '../../utils/shell/readOnlyCommandValidation.js'
import { isDotGitPathPS, isGitInternalPathPS } from './gitSafety.js'
import {
  checkPermissionMode,
  isSymlinkCreatingCommand,
} from './modeValidation.js'
import {
  checkPathConstraints,
  dangerousRemovalDeny,
  isDangerousRemovalRawPath,
} from './pathValidation.js'
import { powershellCommandIsSafe } from './powershellSecurity.js'
import {
  argLeaksValue,
  isAllowlistedCommand,
  isCwdChangingCmdlet,
  isProvablySafeStatement,
  isReadOnlyCommand,
  isSafeOutputCommand,
  resolveToCanonical,
} from './readOnlyValidation.js'
import { POWERSHELL_TOOL_NAME } from './toolName.js'

// 匹配 `$var = `、`$var += `、`$env:X = `、`$x ??= ` 等。用于在解析失败的
// 回退路径中剥离嵌套的赋值前缀。
const PS_ASSIGN_PREFIX_RE = /^\$[\w:]+\s*(?:[+\-*/%]|\?\?)?\s*=\s*/

/**
 * 可以将文件放到调用者指定路径的 cmdlet。git 内部路径防护会检查是否有任意
 * 参数是 git 内部路径（hooks/、refs/、objects/、HEAD）。非创建型写命令
 * （remove-item、clear-content）被有意排除在外——它们无法植入新的钩子。
 */
const GIT_SAFETY_WRITE_CMDLETS = new Set([
  'new-item',
  'set-content',
  'add-content',
  'out-file',
  'copy-item',
  'move-item',
  'rename-item',
  'expand-archive',
  'invoke-webrequest',
  'invoke-restmethod',
  'tee-object',
  'export-csv',
  'export-clixml',
])

/**
 * 会向 cwd 写入由归档内容控制的路径的外部解压应用。`tar -xf payload.tar;
 * git status` 会绕过 isCurrentDirectoryBareGitRepo（TOCTOU）：检查在权限判定
 * 时执行，tar 在检查之后、git 运行之前解压出 HEAD/hooks/refs/。与
 * GIT_SAFETY_WRITE_CMDLETS（那里可以检查参数是否为 git 内部路径）不同，
 * 归档内容是不透明的——任何在 git 之前的解压都必须询问。仅供名称匹配
 * （小写，含和不含 .exe）。
 */
const GIT_SAFETY_ARCHIVE_EXTRACTORS = new Set([
  'tar',
  'tar.exe',
  'bsdtar',
  'bsdtar.exe',
  'unzip',
  'unzip.exe',
  '7z',
  '7z.exe',
  '7za',
  '7za.exe',
  'gzip',
  'gzip.exe',
  'gunzip',
  'gunzip.exe',
  'expand-archive',
])

/**
 * 从 PowerShell 命令字符串中提取命令名。
 * 使用解析器从 AST 获取第一个命令名。
 */
async function extractCommandName(command: string): Promise<string> {
  const trimmed = command.trim()
  if (!trimmed) {
    return ''
  }
  const parsed = await parsePowerShellCommand(trimmed)
  const names = getAllCommandNames(parsed)
  return names[0] ?? ''
}

/**
 * 将权限规则字符串解析为结构化规则对象。
 * 委托给共享的 parsePermissionRule。
 */
export function powershellPermissionRule(
  permissionRule: string,
): ShellPermissionRule {
  return parsePermissionRule(permissionRule)
}

/**
 * 为完全匹配的命令生成权限更新建议。
 *
 * 对无法干净往返的命令跳过精确命令建议：
 * - 多行：换行无法在规范化中存活，规则将永远不匹配
 * - 字面量 *：原样存储 `Remove-Item * -Force` 会通过 hasWildcards()
 *   重新解析为通配符规则（匹配 `^Remove-Item .* -Force$`）。转义成
 *   `\*` 会产生死规则——parsePermissionRule 的精确分支返回值会保留反斜杠，
 *   因此 `Remove-Item \* -Force` 永远无法匹配传入的 `Remove-Item * -Force`。
 *   无论何种情况，对 glob 使用精确自动放行都不安全；仍然会提供前缀建议。
 *   （finding #12）
 */
function suggestionForExactCommand(command: string): PermissionUpdate[] {
  if (command.includes('\n') || command.includes('*')) {
    return []
  }
  return sharedSuggestionForExactCommand(POWERSHELL_TOOL_NAME, command)
}

/**
 * PowerShell 输入模式类型——初始实现做了精简
 */
type PowerShellInput = {
  command: string
  timeout?: number
}

/**
 * 按与输入命令匹配的内容过滤规则。
 * PowerShell 专用：全程使用大小写不敏感匹配。
 * 与 BashTool 的本地 filterRulesByContentsMatchingInput 结构相同。
 */
function filterRulesByContentsMatchingInput(
  input: PowerShellInput,
  rules: Map<string, PermissionRule>,
  matchMode: 'exact' | 'prefix',
  behavior: 'deny' | 'ask' | 'allow',
): PermissionRule[] {
  const command = input.command.trim()

  function strEquals(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase()
  }
  function strStartsWith(str: string, prefix: string): boolean {
    return str.toLowerCase().startsWith(prefix.toLowerCase())
  }
  // 安全性：对规则名应用 stripModulePrefix 会扩大二次规范形式的匹配范围——
  // deny 规则 `Module\Remove-Item:*` 能拦截 `rm` 是期望行为（保守过度匹配），
  // 但 allow 规则 `ModuleA\Get-Thing:*` 同时匹配 `ModuleB\Get-Thing` 则是
  // 开发式故障。deny/ask 过度匹配没问题；allow 绝不能过度匹配。
  function stripModulePrefixForRule(name: string): string {
    if (behavior === 'allow') {
      return name
    }
    return stripModulePrefix(name)
  }

  // 从输入中提取第一个词（命令名）用于规范形式匹配。
  // 同时保留原始形式（用于对原始 `command` 字符串切片）和被剥离的形式
  // （用于规范形式解析）。对于模块限定输入如
  // `Microsoft.PowerShell.Utility\Invoke-Expression foo`，rawCmdName 保存
  // 完整的令牌，这样 `command.slice(rawCmdName.length)` 能得出正确的其余部分。
  const rawCmdName = command.split(/\s+/)[0] ?? ''
  const inputCmdName = stripModulePrefix(rawCmdName)
  const inputCanonical = resolveToCanonical(inputCmdName)

  // 构造一个用规范命令名替换后的命令版本，
  // 例如 'rm foo.txt' -> 'remove-item foo.txt'，这样针对 Remove-Item 的 deny
  // 规则也能拦截 rm。
  // 安全性：将名称与参数之间的空白分隔符规范化为单个空格。PowerShell 接受
  // 任何空白（tab 等）作为分隔符，但前缀规则匹配使用 `prefix + ' '`（字面
  // 空格）。若不如此，`rm\t./x` 会规范化为 `remove-item\t./x` 而错过 deny 规则
  // `Remove-Item:*`，而 acceptEdits 自动放行（使用 AST cmd.name）却仍能匹配
  // ——这是 deny 规则绕过。无条件构造（不仅仅在规范形式不同时），这样非空格
  // 分隔的原始命令也会被规范化。
  const rest = command.slice(rawCmdName.length).replace(/^\s+/, ' ')
  const canonicalCommand = inputCanonical + rest

  return Array.from(rules.entries())
    .filter(([ruleContent]) => {
      const rule = powershellPermissionRule(ruleContent)

      // 也将规则命令名解析为规范形式以进行交叉匹配，
      // 例如 deny 规则 'rm' 也应该拦截 'Remove-Item'
      function matchesCommand(cmd: string): boolean {
        switch (rule.type) {
          case 'exact':
            return strEquals(rule.command, cmd)
          case 'prefix':
            switch (matchMode) {
              case 'exact':
                return strEquals(rule.prefix, cmd)
              case 'prefix': {
                if (strEquals(cmd, rule.prefix)) {
                  return true
                }
                return strStartsWith(cmd, rule.prefix + ' ')
              }
            }
            break
          case 'wildcard':
            if (matchMode === 'exact') {
              return false
            }
            return matchWildcardPattern(rule.pattern, cmd, true)
        }
      }

      // 针对原始命令检查
      if (matchesCommand(command)) {
        return true
      }

      // 也针对命令的规范形式检查
      // 这确保 'deny Remove-Item' 也能拦截 'rm'、'del'、'ri' 等。
      if (matchesCommand(canonicalCommand)) {
        return true
      }

      // 也将规则命令名解析为规范形式进行交叉比较，
      // 这确保 'deny rm' 也能拦截 'Remove-Item'
      // 安全性：stripModulePrefix 也应用于 DENY/ASK 规则命令
      // 名，而不仅仅是输入。否则，写成 `Microsoft.PowerShell.Management\Remove-Item:*`
      // 的 deny 规则会被 `rm`、`del` 或普通 `Remove-Item` 绕过——resolveToCanonical
      // 无法将模块限定形式与 COMMON_ALIASES 匹配。
      if (rule.type === 'exact') {
        const rawRuleCmdName = rule.command.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical) {
          // 规则与输入解析为相同的规范 cmdlet
          // 安全性：使用规范化的 `rest` 而非从 `command` 的原始重新切片。
          // 原始切片保留 tab 分隔符，因此
          // `Remove-Item\t./secret.txt` 与 deny 规则 `rm ./secret.txt` 会错过。
          // 对两边进行一致的规范化。
          const ruleRest = rule.command
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const inputRest = rest
          if (strEquals(ruleRest, inputRest)) {
            return true
          }
        }
      } else if (rule.type === 'prefix') {
        const rawRuleCmdName = rule.prefix.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical) {
          const ruleRest = rule.prefix
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const canonicalPrefix = inputCanonical + ruleRest
          if (matchMode === 'exact') {
            if (strEquals(canonicalPrefix, canonicalCommand)) {
              return true
            }
          } else {
            if (
              strEquals(canonicalCommand, canonicalPrefix) ||
              strStartsWith(canonicalCommand, canonicalPrefix + ' ')
            ) {
              return true
            }
          }
        }
      } else if (rule.type === 'wildcard') {
        // 解析通配符模式的命令名为规范形式并重新匹配
        // 这确保 'deny rm *' 也能拦截 'Remove-Item secret.txt'
        const rawRuleCmdName = rule.pattern.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical && matchMode !== 'exact') {
          // 用规范 cmdlet 名重建模式
          // 分隔符规范化方式与精确和前缀分支一致。
          // 若不如此，通配符规则 `rm\t*` 会生成带字面 tab 的
          // canonicalPattern，永远无法匹配经过空格规范化的
          // canonicalCommand。
          const ruleRest = rule.pattern
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const canonicalPattern = inputCanonical + ruleRest
          if (matchWildcardPattern(canonicalPattern, canonicalCommand, true)) {
            return true
          }
        }
      }

      return false
    })
    .map(([, rule]) => rule)
}

/**
 * 为输入获取所有规则类型（deny、ask、allow）的匹配规则
 */
function matchingRulesForInput(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
  matchMode: 'exact' | 'prefix',
) {
  const denyRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'deny',
  )
  const matchingDenyRules = filterRulesByContentsMatchingInput(
    input,
    denyRuleByContents,
    matchMode,
    'deny',
  )

  const askRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'ask',
  )
  const matchingAskRules = filterRulesByContentsMatchingInput(
    input,
    askRuleByContents,
    matchMode,
    'ask',
  )

  const allowRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'allow',
  )
  const matchingAllowRules = filterRulesByContentsMatchingInput(
    input,
    allowRuleByContents,
    matchMode,
    'allow',
  )

  return { matchingDenyRules, matchingAskRules, matchingAllowRules }
}

/**
 * 检查命令是否为权限规则的完全匹配。
 */
export function powershellToolCheckExactMatchPermission(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const trimmedCommand = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')

  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${trimmedCommand} 的权限已被拒绝。`,
      decisionReason: { type: 'rule', rule: matchingDenyRules[0] },
    }
  }

  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: { type: 'rule', rule: matchingAskRules[0] },
    }
  }

  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: matchingAllowRules[0] },
    }
  }

  const decisionReason: PermissionDecisionReason = {
    type: 'other' as const,
    reason: '此命令需要审批',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: suggestionForExactCommand(trimmedCommand),
  }
}

/**
 * 检查 PowerShell 命令的权限，包含前缀匹配。
 */
export function powershellToolCheckPermission(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()

  // 1. 先检查完全匹配
  const exactMatchResult = powershellToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 1a. 如果命令有精确规则则 deny/ask
  if (
    exactMatchResult.behavior === 'deny' ||
    exactMatchResult.behavior === 'ask'
  ) {
    return exactMatchResult
  }

  // 2. 查找所有匹配规则（前缀或精确）
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'prefix')

  // 2a. 如果命令有 deny 规则则拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. 如果命令有 ask 规则则询问
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 如果命令有精确匹配的 allow 则放行
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 4. 如果命令有 allow 规则则放行
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 5. 无规则匹配则放行，将触发权限提示
  const decisionReason = {
    type: 'other' as const,
    reason: '此命令需要审批',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: suggestionForExactCommand(command),
  }
}

/**
 * 用于权限检查的子命令信息。
 */
type SubCommandInfo = {
  text: string
  element: ParsedCommandElement
  statement: ParsedPowerShellCommand['statements'][number] | null
  isSafeOutput: boolean
}

/**
 * 从解析后的命令中提取需要独立权限检查的子命令。
 * 安全输出 cmdlet（Format-Table、Select-Object 等）会被标记但不会被过滤掉——
 * 步骤 4.4 仍会针对它们检查 deny 规则（deny 始终优先），步骤 5 会跳过它们
 * 进行审批收集（它们继承前面命令的权限）。
 *
 * 同时包含来自控制流语句（if、for、foreach 等）的嵌套命令，确保隐藏在控制流
 * 中的命令也会被检查。
 *
 * 返回既包含文本也包含已解析元素的子命令信息，用于精确生成建议。
 */
async function getSubCommandsForPermissionCheck(
  parsed: ParsedPowerShellCommand,
  originalCommand: string,
): Promise<SubCommandInfo[]> {
  if (!parsed.valid) {
    // 为未解析的命令返回回退元素
    return [
      {
        text: originalCommand,
        element: {
          name: await extractCommandName(originalCommand),
          nameType: 'unknown',
          elementType: 'CommandAst',
          args: [],
          text: originalCommand,
        },
        statement: null,
        isSafeOutput: false,
      },
    ]
  }

  const subCommands: SubCommandInfo[] = []

  // 检查管道中的直接命令
  for (const statement of parsed.statements) {
    for (const cmd of statement.commands) {
      // 只检查实际命令（CommandAst），不检查表达式
      if (cmd.elementType !== 'CommandAst') {
        continue
      }
      subCommands.push({
        text: cmd.text,
        element: cmd,
        statement,
        // 安全性：nameType 门控——scripts\\Out-Null 剥离开来会
        // 匹配 SAFE_OUTPUT_CMDLETS，但 PowerShell 实际运行 .ps1 文件。
        // isSafeOutput: true 会使步骤 5 把该命令过滤出审批列表，
        // 因此它会静默执行。参见 isAllowlistedCommand。
        // 安全性：args.length === 0 门控——Out-Null -InputObject:(1 > /etc/x)
        // 曾被按安全输出（仅名称）过滤 → 步骤 5 的 subCommands 为空 →
        // 自动放行 → 括号内的重定向写入文件。只有零参数的
        // Out-String/Out-Null/Out-Host 调用才是可证明安全的。
        isSafeOutput:
          cmd.nameType !== 'application' &&
          isSafeOutputCommand(cmd.name) &&
          cmd.args.length === 0,
      })
    }

    // 也检查控制流语句中的嵌套命令
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        subCommands.push({
          text: cmd.text,
          element: cmd,
          statement,
          isSafeOutput:
            cmd.nameType !== 'application' &&
            isSafeOutputCommand(cmd.name) &&
            cmd.args.length === 0,
        })
      }
    }
  }

  if (subCommands.length > 0) {
    return subCommands
  }

  // 无子命令的命令的回退处理
  return [
    {
      text: originalCommand,
      element: {
        name: await extractCommandName(originalCommand),
        nameType: 'unknown',
        elementType: 'CommandAst',
        args: [],
        text: originalCommand,
      },
      statement: null,
      isSafeOutput: false,
    },
  ]
}

/**
 * PowerShell 工具的主权限检查函数。
 *
 * 该函数实现完整的权限流程：
 * 1. 针对 deny/ask/allow 规则检查完全匹配
 * 2. 针对规则检查前缀匹配
 * 3. 通过 powershellCommandIsSafe() 运行安全检查
 * 4. 返回合适的 PermissionResult
 *
 * @param input - PowerShell 工具输入
 * @param context - 工具使用上下文（用于中止信号与会话信息）
 * @returns 解析为 PermissionResult 的 Promise
 */
export async function powershellToolHasPermission(
  input: PowerShellInput,
  context: ToolUseContext,
): Promise<PermissionResult> {
  const toolPermissionContext = context.getAppState().toolPermissionContext
  const command = input.command.trim()

  // 空命令检查
  if (!command) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: '空命令是安全的',
      },
    }
  }

  // 只解析一次命令，并在所有子函数中复用
  const parsed = await parsePowerShellCommand(command)

  // 安全性：在解析有效性检查之前先检查 deny/ask 规则。
  // deny 规则作用于原始命令字符串，不需要解析后的 AST。
  // 这确保即使解析失败，显式 deny 规则仍能拦截命令。
  // 1. 先检查完全匹配
  const exactMatchResult = powershellToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 完全命令被拒绝
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // 2. 检查前缀/通配符规则
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  )

  // 2a. 如果命令有 deny 规则则拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. 如果命令有 ask 规则则询问——延迟到 decisions[] 中处理。
  // 此前这里是提前返回，奔跑在子命令 deny 检查之前，因此
  // `Get-Process; Invoke-Expression evil` 配合 ask(Get-Process:*) +
  // deny(Invoke-Expression:*) 会显示 ask 对话框而 deny 永远不触发。
  // 现在：存储 ask，在解析成功后推入 decisions[]。
  // 如果解析失败，在解析错误 ask 之前返回（当 pwsh 不可用时保留
  // 规则归属的 decisionReason）。
  let preParseAskDecision: PermissionResult | null = null
  if (matchingAskRules[0] !== undefined) {
    preParseAskDecision = {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 拦截 UNC 路径——从 UNC 路径读取可能触发网络请求并泄露
  // NTLM/Kerberos 凭据。延迟到 decisions[] 中处理。
  // 原始字符串 UNC 检查不得在子命令 deny（步骤 4+）之前提前返回。
  // 与上面 2b 相同的修复。
  if (preParseAskDecision === null && containsVulnerableUncPath(command)) {
    preParseAskDecision = {
      behavior: 'ask',
      message:
        '命令包含可能触发网络请求的 UNC 路径',
    }
  }

  // 2c. 精确 allow 规则仅在解析失败且没有待处理的解析前 ask（2b 前缀或 UNC）时
  // 在此短路。将 2b/UNC 从提前返回改为延迟赋值意味着 2c 会在 L648 消费
  // preParseAskDecision 之前触发——以 allow 静默覆盖 ask。解析成功路径通过
  // reduce（L917）强制 ask > allow；没有此防护时，解析失败路径不一致。
  // 这确保即使用户配置的精确 allow 规则在 pwsh 不可用时也能生效。当解析成功时，
  // 精确 allow 检查被延迟到步骤 4.4（子命令 deny/ask）之后——与 BashTool 的
  // 顺序一致，其中主流程的精确 allow（bashPermissions.ts:1520）在子命令 deny
  // 检查（1442-1458）之后运行。若不如此，复合命令上的精确 allow 会绕过其子命令
  // 上的 deny 规则。
  //
  // 安全性（解析失败分支）：步骤 5 中的 nameType 门控位于子命令循环内，
  // 该循环仅在 parsed.valid 时运行。
  // 这就是 !parsed.valid 的逃生通道。输入侧的 stripModulePrefix 是无条件的——
  // `scripts\build.exe --flag` 剥离开为 `build.exe`，canonicalCommand 匹配精确
  // allow，而没有此防护我们会在这里返回 allow 并执行本地脚本。
  // classifyCommandName 是纯字符串函数（不需要 AST）。`scripts\build.exe` →
  // 'application'（含有 `\`）。与步骤 5 相同的权衡：单独的 `build.exe` 也会被
  // 归类为 'application'（含有 `.`），因此当 pwsh 降级时合法的可执行文件精确
  // allow 会降级为 ask——保守失败。
  // 模块限定 cmdlet（Module\Cmdlet）也会被归类为 'application'（同样的 `\`）；
  // 同样是保守的过度触发。
  if (
    exactMatchResult.behavior === 'allow' &&
    !parsed.valid &&
    preParseAskDecision === null &&
    classifyCommandName(command.split(/\s+/)[0] ?? '') !== 'application'
  ) {
    return exactMatchResult
  }

  // 0. 检查命令是否可解析——如果不能，要求审批但不建议持久化
  // 这与 Bash 行为一致：无效语法会触发权限提示，但我们不
  // 建议将无效命令保存到设置中
  // 注意：此检查刻意放在 deny/ask 规则之后，这样显式规则依然生效，
  // 即使解析器失败（例如 pwsh 不可用）。
  if (!parsed.valid) {
    // 安全性：解析失败路径的子命令 deny 回退扫描。
    // L851+ 的子命令 deny 循环需要 AST；当解析失败时
    // （命令超过 MAX_COMMAND_LENGTH、pwsh 不可用、超时、错误的
    // JSON），我们会返回 'ask' 而从不检查子命令 deny 规则。
    // 攻击：`Get-ChildItem # <约2000字符填充> ; Invoke-Expression evil`
    // → 填充使 valid=false → 通用 ask 提示，deny(iex:*) 永不
    // 触发。此回退按 PowerShell 分隔符/分组切分，并对每个片段运行
    // 与步骤 2a（前缀 deny）相同的规则匹配器。
    // 保守起见：字符串字面量/注释内的片段可能误报 deny——
    // 这里安全（解析失败已是降级状态，这是 deny 降级修复）。针对完整片段
    // 而非仅首个令牌匹配，这样 `Remove-Item foo:*` 等多词规则仍会触发；
    // 匹配器的规范形式解析处理别名（`iex` → `Invoke-Expression`）。
    //
    // 安全性：反引号是 PS 转义/续行符，不是分隔符。
    // 按它切分会把 `Invoke-Ex`pression` 拆成不匹配的
    // 片段。改为：折叠反引号换行（续行）使
    // `Invoke-Ex`<换行>pression` 重新拼接，剥离剩余反引号（转义
    // 字符——``x → x），然后按实际的语句/分组分隔符切分。
    const backtickStripped = command
      .replace(/`[\r\n]+\s*/g, '')
      .replace(/`/g, '')
    for (const fragment of backtickStripped.split(/[;|\n\r{}()&]+/)) {
      const trimmedFrag = fragment.trim()
      if (!trimmedFrag) continue // 跳过空片段
      // 仅当完整命令以 cmdlet 名开头（无赋值前缀）时才跳过它。
      // 完整命令已在 2a 检查过，但 2a 使用原始文本——首令牌 `$x`
      // 的 $x %= iex 会错过 deny(iex:*) 规则。如果规范化会改变片段
      // （赋值前缀、点源），不要跳过——让它在规范化后再被重新检查。
      // （bug #10/#24）
      if (
        trimmedFrag === command &&
        !/^\$[\w:]/.test(trimmedFrag) &&
        !/^[&.]\s/.test(trimmedFrag)
      ) {
        continue
      }
      // 安全性：在规则匹配前规范化调用运算符和赋值前缀
      // （findings #5/#22）。切分器给我们原始片段
      // 文本；matchingRulesForInput 提取首个令牌作为 cmdlet 名。
      // 不规范化会：
      //   `$x = Invoke-Expression 'p'` → 首令牌 `$x` → deny(iex:*) 错过
      //   `. Invoke-Expression 'p'`    → 首令牌 `.`  → deny(iex:*) 错过
      //   `& 'Invoke-Expression' 'p'`  → 首令牌 `&` 被切分移除但
      //                                  `'Invoke-Expression'` 保留引号
      //                                  → deny(iex:*) 错过
      // 解析成功路径通过 AST 处理这些（parser.ts:839 从
      // rawNameUnstripped 剥离引号；调用运算符是独立的 AST
      // 节点）。此回退镜像了该规范化。
      // 循环剥离嵌套赋值：$x = $y = iex → $y = iex → iex
      let normalized = trimmedFrag
      let m: RegExpMatchArray | null
      while ((m = normalized.match(PS_ASSIGN_PREFIX_RE))) {
        normalized = normalized.slice(m[0].length)
      }
      normalized = normalized.replace(/^[&.]\s+/, '') // & cmd、. cmd（点源）
      const rawFirst = normalized.split(/\s+/)[0] ?? ''
      const firstTok = rawFirst.replace(/^['"]|['"]$/g, '')
      const normalizedFrag = firstTok + normalized.slice(rawFirst.length)
      // 安全性：不依赖解析的危险删除硬拒绝。
      // checkPathConstraintsForStatement 中的 isDangerousRemovalPath 检查需要
      // 有效的 AST；当 pwsh 超时或不可用时，`Remove-Item /` 会从硬拒绝降级为
      // 通用 ask。在这里检查原始位置参数，这样无论解析器是否可用，
      // 根/家目录/系统删除都会被拒绝。保守起见：仅位置
      // 参数（跳过 -Param 令牌）；降级状态下的过度拒绝是安全的
      // （与上面子命令扫描相同的 deny 降级理由）。
      if (resolveToCanonical(firstTok) === 'remove-item') {
        for (const arg of normalized.split(/\s+/).slice(1)) {
          if (PS_TOKENIZER_DASH_CHARS.has(arg[0] ?? '')) continue
          if (isDangerousRemovalRawPath(arg)) {
            return dangerousRemovalDeny(arg)
          }
        }
      }
      const { matchingDenyRules: fragDenyRules } = matchingRulesForInput(
        { command: normalizedFrag },
        toolPermissionContext,
        'prefix',
      )
      if (fragDenyRules[0] !== undefined) {
        return {
          behavior: 'deny',
          message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
          decisionReason: { type: 'rule', rule: fragDenyRules[0] },
        }
      }
    }
    // 解析失败时保留解析前的 ask 消息。延迟的 ask
    // （2b 前缀规则或 UNC）携带比通用解析错误 ask 更好的 decisionReason。
    // 子命令 deny 在没有解析的情况下无法运行 AST 循环，因此上面的回退扫描
    // 只是尽力而为。
    if (preParseAskDecision !== null) {
      return preParseAskDecision
    }
    const decisionReason = {
      type: 'other' as const,
      reason: `命令包含无法解析的畸形语法：${parsed.errors[0]?.message ?? '未知错误'}`,
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      // 无建议——不建议将无效语法持久化
    }
  }

  // ========================================================================
  // 收集后归约：解析后决策（deny > ask > allow > passthrough）
  // ========================================================================
  // 移植自 bashPermissions.ts:1446-1472。每个解析后检查都把它的
  // 决策推入单一数组；单一 reduce 应用优先级。
  // 这从结构上闭合了 ask-before-deny 缺陷类：较早检查（安全标志、提供程序路径、
  // cd+git）的 'ask' 不再能掩盖较晚检查（子命令 deny、checkPathConstraints）
  // 的 'deny'。
  //
  // 取代 commit 8f5ae6c56b 的 firstSubCommandAskRule stash——那个
  // 修复只修补了步骤 4；步骤 3、3.5、4.42 存在同样的缺陷。stash
  // 模式也很脆弱：下一位写出 `return ask` 的作者又回到了起点。
  // 收集后归约使得该绕过无法被写出来。
  //
  // 各行为类型的第一个胜出（数组顺序 = 步骤顺序），因此单检查
  // ask 消息与顺序提前返回相比不变。
  //
  // 上面解析前的 deny 检查（精确/前缀 deny）保持顺序：即使
  // pwsh 不可用它们也会触发。解析前的 ask（前缀 ask、原始 UNC）
  // 现在在此延迟，这样子命令 deny（步骤 4）能胜过它们。

  // 只收集一次子命令（用于决策 3、4 以及兜底步骤 5）。
  const allSubCommands = await getSubCommandsForPermissionCheck(parsed, command)

  const decisions: PermissionResult[] = []

  // 决策：延迟的解析前 ask（2b 前缀 ask 或 UNC 路径）。
  // 先推入这样它的消息能胜过后面的 ask（先到行为胜出），
  // 但 reduce 确保 decisions[] 中的任何 deny 仍能胜过它。
  if (preParseAskDecision !== null) {
    decisions.push(preParseAskDecision)
  }

  // 决策：安全检查——原步骤 3（:630-650）。
  // powershellCommandIsSafe 对子表达式、脚本块、编码命令、下载摇篮等返回 'ask'。
  // 仅 'ask' | 'passthrough'。
  const safetyResult = powershellCommandIsSafe(command, parsed)
  if (safetyResult.behavior !== 'passthrough') {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason:
        safetyResult.behavior === 'ask' && safetyResult.message
          ? safetyResult.message
          : '此命令包含可能带来安全风险的模式，需要审批',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }

  // 决策：using 语句 / 脚本要求——对 AST 块遍历不可见。
  // `using module ./evil.psm1` 会加载并执行模块顶层脚本体；
  // `using assembly ./evil.dll` 会加载 .NET 程序集（模块初始化器会运行）。
  // `#Requires -Modules <name>` 会触发从 PSModulePath 加载模块。
  // 它们是 ScriptBlockAst 上命名块的兄弟节点而非子节点，因此
  // Process-BlockStatements 及所有下游命令遍历器永远看不到它们。
  // 没有此检查，Get-Process 等诱饵 cmdlet 会填充 subCommands、
  // 绕过空语句回退，并被 isReadOnlyCommand 自动放行。
  if (parsed.hasUsingStatements) {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason:
        '命令包含可能加载外部代码（模块或程序集）的 `using` 语句',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }
  if (parsed.hasScriptRequirements) {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason:
        '命令包含可能触发模块加载的 `#Requires` 指令',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }

  // 决策：已解析参数的 provider/UNC 扫描——原步骤 3.5（:652-709）。
  // 提供程序路径（env:、HKLM:、function:）访问非文件系统资源。
  // UNC 路径在 Windows 上可能泄露 NTLM/Kerberos 凭据。上面的原始字符串
  // UNC 检查（解析前）会错过反引号转义形式；cmd.args 中含有解析器已解析
  // 的反引号转义。带标签的循环在第一个匹配处中断
  // （与之前的提前返回相同）。
  // provider 前缀同时匹配短形式（`env:`、`HKLM:`）和
  // 完整限定形式（`Microsoft.PowerShell.Core\Registry::HKLM\...`）。
  // 可选的 `(?:[\w.]+\\)?` 处理模块限定前缀；`::?`
  // 匹配单冒号驱动器语法或双冒号 provider 语法。
  const NON_FS_PROVIDER_PATTERN =
    /^(?:[\w.]+\\)?(env|hklm|hkcu|function|alias|variable|cert|wsman|registry)::?/i
  function extractProviderPathFromArg(arg: string): string {
    // 处理冒号参数语法：-Path:env:HOME → 提取 'env:HOME'。
    // 安全性：PowerShell 的词法分析器接受 en-dash/em-dash/horizontal-bar
    // （U+2013/2014/2015）作为参数前缀。`–Path:env:HOME`（en-dash）
    // 也必须剥离 `–Path:` 前缀，否则 NON_FS_PROVIDER_PATTERN 无法
    // 匹配（模式是 `^(env|...):` 在 `–Path:env:...` 上失败）。
    let s = arg
    if (s.length > 0 && PS_TOKENIZER_DASH_CHARS.has(s[0]!)) {
      const colonIdx = s.indexOf(':', 1) // 跳过前导短划线
      if (colonIdx > 0) {
        s = s.substring(colonIdx + 1)
      }
    }
    // 在匹配前剥离反引号转义：`Registry`::HKLM\...` 在 `::` 前
    // 有一个反引号，PS 词法分析器运行时移除它，但否则会阻止
    // ^ 锚定模式匹配。
    return s.replace(/`/g, '')
  }
  function providerOrUncDecisionForArg(arg: string): PermissionResult | null {
    const value = extractProviderPathFromArg(arg)
    if (NON_FS_PROVIDER_PATTERN.test(value)) {
      return {
        behavior: 'ask',
        message: `命令参数 '${arg}' 使用非文件系统 provider 路径，需要审批`,
      }
    }
    if (containsVulnerableUncPath(value)) {
      return {
        behavior: 'ask',
        message: `命令参数 '${arg}' 包含可能触发网络请求的 UNC 路径`,
      }
    }
    return null
  }
  providerScan: for (const statement of parsed.statements) {
    for (const cmd of statement.commands) {
      if (cmd.elementType !== 'CommandAst') continue
      for (const arg of cmd.args) {
        const decision = providerOrUncDecisionForArg(arg)
        if (decision !== null) {
          decisions.push(decision)
          break providerScan
        }
      }
    }
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        for (const arg of cmd.args) {
          const decision = providerOrUncDecisionForArg(arg)
          if (decision !== null) {
            decisions.push(decision)
            break providerScan
          }
        }
      }
    }
  }

  // 决策：按子命令的 deny/ask 规则——原步骤 4（:711-803）。
  // 每个子命令最多产生一个决策（deny 或 ask）。较晚子命令上的 deny 规则
  // 仍会通过 reduce 胜过较早子命令上的 ask 规则。
  // 无需 stash——reduce 从结构上强制 deny > ask。
  //
  // 安全性：始终从 AST 派生数据构建规范命令字符串
  // （element.name + 空格连接的参数），并同样针对它检查规则。deny
  // 和 allow 必须使用相同的规范化形式以闭合不对称性：
  //   - 调用运算符（`& 'Remove-Item' ./x`）：原始文本以 `&` 开头，
  //     按空白切分得到的是运算符而非 cmdlet 名。
  //   - 非空格空白（`rm\t./x`）：原始前缀匹配使用 `prefix + ' '`
  //     （字面空格），但 PowerShell 接受任何空白分隔符。
  //     checkPermissionMode 自动放行（使用 AST cmd.name）本会匹配，而
  //     原始文本上的 deny 规则匹配会错过——即 deny 规则绕过。
  //   - 模块前缀（`Microsoft.PowerShell.Management\Remove-Item`）：
  //     element.name 已剥离模块前缀。
  for (const { text: subCmd, element } of allSubCommands) {
    // element.name 在解析器（transformCommandAst）中已剥离引号，因此
    // `& 'Invoke-Expression' 'x'` 得到 name='Invoke-Expression'，而非
    // "'Invoke-Expression'"。canonicalSubCmd 由同样的剥离后
    // 名称构建，因此在 `Invoke-Expression:*` 上的 deny 规则前缀匹配可命中。
    const canonicalSubCmd =
      element.name !== '' ? [element.name, ...element.args].join(' ') : null

    const subInput = { command: subCmd }
    const { matchingDenyRules: subDenyRules, matchingAskRules: subAskRules } =
      matchingRulesForInput(subInput, toolPermissionContext, 'prefix')
    let matchedDenyRule = subDenyRules[0]
    let matchedAskRule = subAskRules[0]

    if (matchedDenyRule === undefined && canonicalSubCmd !== null) {
      const {
        matchingDenyRules: canonicalDenyRules,
        matchingAskRules: canonicalAskRules,
      } = matchingRulesForInput(
        { command: canonicalSubCmd },
        toolPermissionContext,
        'prefix',
      )
      matchedDenyRule = canonicalDenyRules[0]
      if (matchedAskRule === undefined) {
        matchedAskRule = canonicalAskRules[0]
      }
    }

    if (matchedDenyRule !== undefined) {
      decisions.push({
        behavior: 'deny',
        message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
        decisionReason: {
          type: 'rule',
          rule: matchedDenyRule,
        },
      })
    } else if (matchedAskRule !== undefined) {
      decisions.push({
        behavior: 'ask',
        message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
        decisionReason: {
          type: 'rule',
          rule: matchedAskRule,
        },
      })
    }
  }

  // 决策：cd+git 复合防护——原步骤 4.42（:805-833）。
  // 当 cd/Set-Location 与 git 配对时，不明示提示就不放行——
  // cd 到恶意目录会使 git 变得危险（假钩子、裸仓库
  // 攻击）。收集后归约保持了优于 BashTool 的改进：在
  // bash 中，cd+git（B9，行 1416）在子命令 deny（B11）之前运行，因此 cd+git
  // ask 会掩盖 deny。这里两者在同一决策数组中；deny 胜出。
  //
  // 安全性：不做 cd 到 CWD 的空操作排除。先前一版会把
  // `Set-Location .` 排除为空操作，但用于提取目标的“首个非短划线参数”
  // 启发式会被冒号绑定参数欺骗：
  // `Set-Location -Path:/etc .` ——真实目标是 /etc，启发式看到 `.`、
  // 触发排除，造成绕过。该 UX 场景（模型发出 `Set-Location .; foo`）
  // 很罕见；攻击面不值得为此特殊处理。复合命令中任何 cd 家族
  // cmdlet 都无条件设置此标志。
  // 仅当存在多个子命令时才把复合 cd 标记出来。单独的
  // `Set-Location ./subdir` 不是 TOCTOU 风险（没有后续语句会针对过期的 cwd
  // 解析相对路径）。若不如此，单独的 cd 会强制
  // 复合防护，抑制逐子命令自动放行路径。（bug #25）
  const hasCdSubCommand =
    allSubCommands.length > 1 &&
    allSubCommands.some(({ element }) => isCwdChangingCmdlet(element.name))
  // 符号链接创建复合防护（finding #18 / bug 001+004）：当
  // 复合命令创建文件系统链接时，后续通过该链接的写入
  // 会落在校验器视野之外。与 cwd 失同步相同的 TOCTOU 形态。
  const hasSymlinkCreate =
    allSubCommands.length > 1 &&
    allSubCommands.some(({ element }) => isSymlinkCreatingCommand(element))
  const hasGitSubCommand = allSubCommands.some(
    ({ element }) => resolveToCanonical(element.name) === 'git',
  )
  if (hasCdSubCommand && hasGitSubCommand) {
    decisions.push({
      behavior: 'ask',
      message:
        '包含 cd/Set-Location 和 git 的复合命令需要审批，以防止裸仓库攻击',
    })
  }

  // cd+write 复合防护——已被 checkPathConstraints(compoundCommandHasCd) 取代。
  // 此前该块在 hasCdSubCommand && hasAcceptEditsWrite 时推入 'ask'，但现在
  // checkPathConstraints 接收 hasCdSubCommand，并对 cd 复合命令中的任何
  // 路径操作（读或写）推入 'ask'——在路径层提供更广的覆盖（与 BashTool 一致）。
  // 步骤 5 的 !hasCdSubCommand 门控和 modeValidation 的
  // 复合 cd 防护仍作为纵深防御，针对无法到达
  // checkPathConstraints 的路径（例如不在 CMDLET_PATH_CONFIG 中的 cmdlet）。

  // 决策：裸 git 仓库防护——与 bash 一致。
  // 如果 cwd 含有 HEAD/objects/refs/ 但没有有效的 .git/HEAD，Git 会把
  // cwd 视为裸仓库并从 cwd 运行钩子。攻击者创建
  // hooks/pre-commit，删除 .git/HEAD，然后任何 git 子命令都会运行它。
  // 移植自 BashTool readOnlyValidation.ts 的 isCurrentDirectoryBareGitRepo。
  if (hasGitSubCommand && isCurrentDirectoryBareGitRepo()) {
    decisions.push({
      behavior: 'ask',
      message:
        '在含裸仓库标志（cwd 中有 HEAD、objects/、refs/ 但没有 .git/HEAD）的目录中执行 Git 命令。Git 可能会从 cwd 执行钩子。',
    })
  }

  // 决策：git 内部路径写入防护——与 bash 一致。
  // 复合命令创建 HEAD/objects/refs/hooks/ 然后运行 git → git 子命令会执行
  // 刚创建的恶意钩子。针对 git 内部模式检查所有提取的写入路径 + 重定向目标。
  // 移植自 BashTool 的 commandWritesToGitInternalPaths，针对 AST 改编。
  if (hasGitSubCommand) {
    const writesToGitInternal = allSubCommands.some(
      ({ element, statement }) => {
        // 此子命令上的重定向目标（原始 Extent.Text——引号
        // 和 ./ 保持不变；规范化器处理两者）
        for (const r of element.redirections ?? []) {
          if (isGitInternalPathPS(r.target)) return true
        }
        // 写 cmdlet 参数（new-item HEAD；mkdir hooks；set-content hooks/pre-commit）
        const canonical = resolveToCanonical(element.name)
        if (!GIT_SAFETY_WRITE_CMDLETS.has(canonical)) return false
        // 原始参数文本——规范化器剥离冒号绑定参数、引号、./、大小写。
        // PS ArrayLiteralAst（`New-Item a,hooks/pre-commit`）表现为单个
        // 逗号连接的参数——在检查前切分。
        if (
          element.args
            .flatMap(a => a.split(','))
            .some(a => isGitInternalPathPS(a))
        ) {
          return true
        }
        // 管道输入：`"hooks/pre-commit" | New-Item -ItemType File` 在运行时把
        // 字符串绑定到 -Path。路径在非 CommandAst 的管道
        // 元素中，而非 element.args。步骤 5 的 hasExpressionSource 门控
        // 已在此强制审批；此检查只是补充 git 内部
        // 警告文本。
        if (statement !== null) {
          for (const c of statement.commands) {
            if (c.elementType === 'CommandAst') continue
            if (isGitInternalPathPS(c.text)) return true
          }
        }
        return false
      },
    )
    // 也检查顶层文件重定向（> hooks/pre-commit）
    const redirWritesToGitInternal = getFileRedirections(parsed).some(r =>
      isGitInternalPathPS(r.target),
    )
    if (writesToGitInternal || redirWritesToGitInternal) {
      decisions.push({
        behavior: 'ask',
        message:
          '命令写入 git 内部路径（HEAD、objects/、refs/、hooks/、.git/）并运行 git。这可能植入 git 随后执行的恶意钩子。',
      })
    }
    // 安全性：归档解压 TOCTOU。isCurrentDirectoryBareGitRepo
    // 在权限判定时检查；`tar -xf x.tar; git status` 在该检查之后、
    // git 运行之前解压出裸仓库标志。与写 cmdlet（那里我们会检查参数是否为
    // git 内部路径）不同，归档内容是不透明的——含 git 复合命令中的任何解压
    // 都必须询问。
    const hasArchiveExtractor = allSubCommands.some(({ element }) =>
      GIT_SAFETY_ARCHIVE_EXTRACTORS.has(element.name.toLowerCase()),
    )
    if (hasArchiveExtractor) {
      decisions.push({
        behavior: 'ask',
        message:
          '复合命令解压归档并运行 git。归档内容可能植入 git 随后视为仓库根的裸仓库标志（HEAD、hooks/、refs/）。',
      })
    }
  }

  // 即使没有 git 子命令，写入 .git/ 也是危险的——被植入的
  // .git/hooks/pre-commit 会在用户下次提交时触发。与上面的
  // 裸仓库检查（它以 hasGitSubCommand 为门控，因为 `hooks/`
  // 是常见项目目录名）不同，`.git/` 是明确的。
  {
    const found =
      allSubCommands.some(({ element }) => {
        for (const r of element.redirections ?? []) {
          if (isDotGitPathPS(r.target)) return true
        }
        const canonical = resolveToCanonical(element.name)
        if (!GIT_SAFETY_WRITE_CMDLETS.has(canonical)) return false
        return element.args.flatMap(a => a.split(',')).some(isDotGitPathPS)
      }) || getFileRedirections(parsed).some(r => isDotGitPathPS(r.target))
    if (found) {
      decisions.push({
        behavior: 'ask',
        message:
          '命令写入 .git/ —— 植入的钩子或配置会在下次 git 操作时执行。',
      })
    }
  }

  // 决策：路径约束——原步骤 4.44（:835-845）。
  // 此检查具备 deny 能力，一直被较早的 ask 所掩盖。当 Edit(...) deny 规则匹配到提取的
  // 路径时返回 'deny'（pathValidation 大致在第 994、1088、1160、1210 行），对工作目录
  // 之外的路径返回 'ask'，或返回 'passthrough'。
  //
  // 贯通 hasCdSubCommand（与 BashTool compoundCommandHasCd 一致）：当
  // 复合命令含更改 cwd 的 cmdlet 时，checkPathConstraints 会对任何含路径操作的
  // 语句强制 'ask'——相对路径会针对过期的校验器 cwd 解析，而非 PowerShell 的
  // 运行时 cwd。这是对 CWD 失同步问题族（findings #3/#21/#27/#28）的架构性修复，
  // 用路径解析层的单一门控取代逐自动放行点的防护。
  const pathResult = checkPathConstraints(
    input,
    parsed,
    toolPermissionContext,
    hasCdSubCommand,
  )
  if (pathResult.behavior !== 'passthrough') {
    decisions.push(pathResult)
  }

  // 决策：精确 allow（解析成功情况）——原步骤 4.45（:861-867）。
  // 匹配 BashTool 顺序：子命令 deny → 路径约束 → 精确
  // allow。reduce 强制 deny > ask > allow，因此精确 allow 仅在
  // 没有 denry 或 ask 触发时呈现——与顺序执行相同。
  //
  // 安全性：nameType 门控——镜像 L696-700 的解析失败防护。
  // 输入侧 stripModulePrefix 是无条件的：`scripts\Get-Content`
  // 剥离开为 `Get-Content`，canonicalCommand 匹配精确 allow。没有
  // 此门控，allow 进入 decisions[] 且 reduce 在步骤 5 能检查
  // nameType 之前返回它——PowerShell 运行本地 .ps1 文件。当解析
  // 成功时，AST 对首个命令元素的 nameType 是权威的；'application' 表示
  // 脚本/可执行文件路径而非 cmdlet。
  // 安全性：与下面逐子命令循环相同的 argLeaksValue 门控
  // （finding #32）。缺少它时，`PowerShell(Write-Output:*)` 会精确匹配
  // `Write-Output $env:LIMKENION_API_KEY`，把 allow 推入 decisions[]，
  // 而 reduce 在逐子命令门控运行之前就返回它。
  // allSubCommands.every 检查确保语句中的任何命令都不泄露
  // （单命令精确 allow 有一个元素；管道则有多个）。
  //
  // 安全性：nameType 门控必须检查所有子命令，而不只是 [0]
  // （finding #10）。L171 的 canonicalCommand 把 `\n` 折叠为空格，因此
  // `code\n.\build.ps1`（两条语句）匹配精确规则
  // `PowerShell(code .\build.ps1)`。只检查 allSubCommands[0] 会让
  // 第二条语句（nameType=application、脚本路径）通过。要求
  // 每个子命令的 nameType !== 'application'。
  if (
    exactMatchResult.behavior === 'allow' &&
    allSubCommands[0] !== undefined &&
    allSubCommands.every(
      sc =>
        sc.element.nameType !== 'application' &&
        !argLeaksValue(sc.text, sc.element),
    )
  ) {
    decisions.push(exactMatchResult)
  }

  // 决策：只读允许清单——原步骤 4.5（:869-885）。
  // 镜像 Bash 对 ls、cat、git status 等的自动放行。PowerShell
  // 对应项：Get-Process、Get-ChildItem、Get-Content、git log 等。
  // reduce 将此项置于子命令 ask 规则之下（ask > allow）。
  if (isReadOnlyCommand(command, parsed)) {
    decisions.push({
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: '命令是只读的，可安全执行',
      },
    })
  }

  // 决策：文件重定向——原 :887-900。
  // 重定向（>、>>、2>）会写入任意路径。isReadOnlyCommand
  // 已在内部拒绝重定向，因此这不会与上面的只读放行冲突。
  // reduce 将其置于 checkPermissionMode 放行之上。
  const fileRedirections = getFileRedirections(parsed)
  if (fileRedirections.length > 0) {
    decisions.push({
      behavior: 'ask',
      message:
        '命令包含可能写入任意路径的文件重定向',
      suggestions: suggestionForExactCommand(command),
    })
  }

  // 决策：模式特定处理（acceptEdits）——原步骤 4.7（:902-906）。
  // checkPermissionMode 仅返回 'allow' | 'passthrough'。
  const modeResult = checkPermissionMode(input, parsed, toolPermissionContext)
  if (modeResult.behavior !== 'passthrough') {
    decisions.push(modeResult)
  }

  // REDUCE：deny > ask > allow > passthrough。各行为类型的第一个
  // 胜出（对单检查情况保留步骤顺序消息）。如果什么
  // 都没决定，则落到步骤 5 逐子命令审批收集。
  const deniedDecision = decisions.find(d => d.behavior === 'deny')
  if (deniedDecision !== undefined) {
    return deniedDecision
  }
  const askDecision = decisions.find(d => d.behavior === 'ask')
  if (askDecision !== undefined) {
    return askDecision
  }
  const allowDecision = decisions.find(d => d.behavior === 'allow')
  if (allowDecision !== undefined) {
    return allowDecision
  }

  // 5. 管道/语句切分：独立检查每个子命令。
  // 这防止 "Get-Process:*" 等前缀规则静默放行
  // "Get-Process | Stop-Process -Force" 等管道命令。
  // 注意：deny 规则已在上方（4.4）检查过，因此此循环处理
  // ask 规则、显式 allow 规则和只读允许清单回退。

  // 过滤掉安全输出 cmdlet（Format-Table 等）——它们在步骤 4.4 中已检查
  // 过 deny 规则，但在此不必进行独立审批。
  // 也过滤掉 cd/Set-Location 到 CWD（模型习惯，与 Bash 一致）。
  const subCommands = allSubCommands.filter(({ element, isSafeOutput }) => {
    if (isSafeOutput) {
      return false
    }
    // 安全性：nameType 门控——第六处。从审批
    // 列表过滤掉是一种自动放行。scripts\\Set-Location . 会匹配下面
    // （剥离后名称 'Set-Location'、参数 '.' → CWD）并被静默丢弃，
    // 然后 scripts\\Set-Location.ps1 在无提示下执行。把 'application'
    // 命令留在列表中，让它们到达 isAllowlistedCommand（会拒绝它们）。
    if (element.nameType === 'application') {
      return true
    }
    const canonical = resolveToCanonical(element.name)
    if (canonical === 'set-location' && element.args.length > 0) {
      // 安全性：使用 PS_TOKENIZER_DASH_CHARS，而非仅 ASCII 的 startsWith(' -')。
      // `Set-Location –Path .`（en-dash）否则会把 `–Path` 当作
      // 目标，针对 cwd 解析（不匹配），并把命令留在
      // 审批列表中——正确。但带 en-dash 的 `Set-Location –LiteralPath evil`
      // 会把 `–LiteralPath` 当作“目标”，与 cwd 不匹配，仍留在
      // 列表中——也是正确的。风险是相反的：Unicode 短划线参数
      // 被当作位置目标。使用词法分析器的短划线集合。
      const target = element.args.find(
        a => a.length === 0 || !PS_TOKENIZER_DASH_CHARS.has(a[0]!),
      )
      if (target && resolve(getCwd(), target) === getCwd()) {
        return false
      }
    }
    return true
  })

  // 注意：cd+git 复合防护已在步骤 4.42 运行。如果到达这里，
  // 要么复合命令中没有 cd，要么没有 git。

  const subCommandsNeedingApproval: string[] = []
  // 其子命令在下面的步骤 5 循环中被 PUSH 到 subCommandsNeedingApproval 的语句。
  // 失败关闭门控（循环之后）只推入这里未跟踪的语句——避免在
  // "Get-Process"（子命令）和 "$x = Get-Process"（完整语句）
  // 同时出现时产生重复建议。
  //
  // 安全性：仅在 PUSH 时跟踪，而非循环进入时。
  // 如果一条语句唯一子命令通过用户 allow 规则 `continue`
  // （L1113），在循环进入时将其标记为已见会使失败关闭门控
  // 跳过它——使控制流中 `$env:SECRET` 等不可见的非 CommandAst 内容
  // 自动放行。攻击示例：用户审批
  // Get-Process，然后 `if ($true) { Get-Process; $env:SECRET }`——Get-Process
  // 被 allow 规则处理（continue、不 push），$env:SECRET 是 VariableExpressionAst
  // （不是子命令），语句被标记已见 → 门控跳过 → 自动放行 →
  // 秘密泄露。仅在 push 时跟踪：语句保持未见过 → 门控触发
  // → ask。
  const statementsSeenInLoop = new Set<
    ParsedPowerShellCommand['statements'][number]
  >()

  for (const { text: subCmd, element, statement } of subCommands) {
    // 先检查 deny 规则——用户显式规则优先于允许清单
    const subInput = { command: subCmd }
    const subResult = powershellToolCheckPermission(
      subInput,
      toolPermissionContext,
    )

    if (subResult.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
        decisionReason: subResult.decisionReason,
      }
    }

    if (subResult.behavior === 'ask') {
      if (statement !== null) {
        statementsSeenInLoop.add(statement)
      }
      subCommandsNeedingApproval.push(subCmd)
      continue
    }

    // 被用户规则显式放行——但对应用/脚本除外。
    // 安全性：输入侧 stripModulePrefix 是无条件的，因此
    // `scripts\Get-Content /etc/shadow` 剥离开为 'Get-Content' 并匹配
    // allow 规则 `Get-Content:*`。没有 nameType 门控，continue
    // 会跳过所有检查并运行本地脚本。nameType 是在剥离前从
    // 原始名称判定的——`scripts\Get-Content` → 'application'（有 `\`）。
    // 模块限定 cmdlet 也归类为 'application'——保守过度触发。
    // 应用绝不应被 cmdlet allow 规则自动放行。
    if (
      subResult.behavior === 'allow' &&
      element.nameType !== 'application' &&
      !hasSymlinkCreate
    ) {
      // 安全性：用户 allow 规则断言该 cmdlet 安全，而非经由它
      // 的任意变量展开是安全的。允许
      // PowerShell(Write-Output:*) 的用户并非想自动放行
      // `Write-Output $env:LIMKENION_API_KEY`。应用与下面保护内置
      // 允许清单路径相同的 argLeaksValue
      // 门控——拒绝 Variable/Other/ScriptBlock/SubExpression elementTypes 和冒号绑定
      // 的表达式子节点。（security finding #32）
      //
      // 安全性：当复合命令含创建符号链接的命令时也跳过
      // （finding——symlink+read 缺口）。New-Item -ItemType SymbolicLink
      // 可以把后续读取重定向到任意路径。内置
      // 允许清单路径（下面）和 acceptEdits 路径都以
      // !hasSymlinkCreate 为门控；用户规则路径也必须如此。
      if (argLeaksValue(subCmd, element)) {
        if (statement !== null) {
          statementsSeenInLoop.add(statement)
        }
        subCommandsNeedingApproval.push(subCmd)
        continue
      }
      continue
    }
    if (subResult.behavior === 'allow') {
      // nameType === 'application' 且匹配 allow 规则：该规则是
      // 为 cmdlet 写的，但这是伪装成脚本/可执行文件。
      // 不要 continue；落到审批（不是 deny——用户可能
      // 确实想运行 `scripts\Get-Content` 并会看到提示）。
      if (statement !== null) {
        statementsSeenInLoop.add(statement)
      }
      subCommandsNeedingApproval.push(subCmd)
      continue
    }

    // 安全性：失败关闭门控。除非父语句是每个元素
    // 都是 CommandAst 的 PipelineAst，否则不要走允许清单捷径。
    // 这包含了之前的 hasExpressionSource 检查
    // （表达式源是语句无法通过门控的一种方式），并且从构造上
    // 也拒绝赋值、链式运算符、控制流以及任何未来的
    // AST 类型。它拦截的示例：
    //   'env:SECRET_API_KEY' | Get-Content  —— CommandExpressionAst 元素
    //   $x = Get-Process                   —— AssignmentStatementAst
    //   Get-Process && Get-Service         —— PipelineChainAst
    // 显式用户 allow 规则（上面）在此门控之前运行，但应用它们
    // 自己的 argLeaksValue 检查；两条路径现在都对参数 elementTypes 设门控。
    //
    // 安全性：复合命令含更改 cwd 的 cmdlet 时也跳过
    // （finding #27——cd+read 缺口）。isAllowlistedCommand 在隔离状态下验证 Get-Content，
    // 但 `Set-Location ~; Get-Content ./.ssh/id_rsa` 从 ~ 运行
    // Get-Content，而非从校验器的 cwd。路径校验看到了
    // /project/.ssh/id_rsa；运行时读取 ~/.ssh/id_rsa。与下面
    // checkPermissionMode 调用及 checkPathConstraints 贯通相同的门控。
    if (
      statement !== null &&
      !hasCdSubCommand &&
      !hasSymlinkCreate &&
      isProvablySafeStatement(statement) &&
      isAllowlistedCommand(element, subCmd)
    ) {
      continue
    }

    // 检查逐子命令 acceptEdits 模式（与 BashTool 一致）。
    // 在单语句 AST 上委托给 checkPermissionMode，这样它所有的防护都会生效：
    // 表达式管道源（非 CommandAst 元素）、
    // 安全标志（子表达式、脚本块、赋值、splatting 等），
    // 以及 ACCEPT_EDITS_ALLOWED_CMDLETS 允许清单。这让“什么使语句在
    // acceptEdits 模式下安全”保持单一事实来源——未来任何对
    // checkPermissionMode 的加固都会自动应用于此处。
    //
    // 传入 parsed.variables（而非 []），这样复合命令中任何语句的
    // splatting 都可见。保守起见：如果我们无法判断某个被 splat
    // 的变量影响哪条语句，就假定它影响全部。
    //
    // 安全性：当复合命令含更改 cwd 的命令
    // （Set-Location/Push-Location/Pop-Location）时跳过此自动放行路径。
    // 合成的单语句 AST 会剥离复合上下文，因此
    // checkPermissionMode 看不到其他语句中的 cd。没有此
    // 门控，`Set-Location ./.limkenion; Set-Content ./settings.json '...'` 会
    // 通过：Set-Content 在隔离状态下检查、匹配 ACCEPT_EDITS_ALLOWED_CMDLETS、
    // 并自动放行——但 PowerShell 从更改后的 cwd 运行它，写向
    // .limkenion/settings.json（路径校验器未检查的 Limkenion 配置文件）。
    // 这与 BashTool 的 compoundCommandHasCd 防护一致。
    if (statement !== null && !hasCdSubCommand && !hasSymlinkCreate) {
      const subModeResult = checkPermissionMode(
        { command: subCmd },
        {
          valid: true,
          errors: [],
          variables: parsed.variables,
          hasStopParsing: parsed.hasStopParsing,
          originalCommand: subCmd,
          statements: [statement],
        },
        toolPermissionContext,
      )
      if (subModeResult.behavior === 'allow') {
        continue
      }
    }

    // 未在允许清单中、无模式自动放行、也无显式规则——需要审批
    if (statement !== null) {
      statementsSeenInLoop.add(statement)
    }
    subCommandsNeedingApproval.push(subCmd)
  }

  // 安全性：失败关闭门控（后半部分）。上面的步骤 5 循环只
  // 遍历 getSubCommandsForPermissionCheck 呈现出来
  // 且通过安全输出过滤的子命令。产生零个
  // CommandAst 子命令的语句（裸 $env:SECRET）或唯一子命令
  // 被当作安全输出过滤掉的语句（$env:X | Out-String）永远不会进入循环。
  // 缺少此门控时，在空的 subCommandsNeedingApproval 上它们会静默自动放行。
  //
  // 只推入上面未跟踪的语句：如果循环从某条语句 PUSH 了任意
  // 子命令，用户会看到提示。再推入语句文本会
  // 产生重复建议，接受子命令规则并不会阻止再次提示。
  // 如果所有子命令都 `continue` 了（被 allow 规则 / 允许清单 / 模式放行），
  // 该语句未被跟踪，门控会在下面重新检查它——这是
  // 失败关闭属性。
  for (const stmt of parsed.statements) {
    if (!isProvablySafeStatement(stmt) && !statementsSeenInLoop.has(stmt)) {
      subCommandsNeedingApproval.push(stmt.text)
    }
  }

  if (subCommandsNeedingApproval.length === 0) {
    // 安全性：空列表自动放行仅在没有任何不可验证内容时安全。
    // 如果管道含脚本块，每个安全输出 cmdlet 都在 :1032 被过滤，
    // 但块内容未被验证——非命令 AST 节点（AssignmentStatementAst 等）
    // 对 getAllCommands 不可见。`Where-Object {$true} | Sort-Object {$env:PATH='evil'}`
    // 会在这里自动放行。hasAssignments 仅限顶层（parser.ts:1385），
    // 因此它也抓不到嵌套赋值。改为提示。
    if (deriveSecurityFlags(parsed).hasScriptBlocks) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
        decisionReason: {
          type: 'other',
          reason:
            '管道由带脚本块的输出格式化 cmdlet 构成——块内容无法验证',
        },
      }
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: '所有管道命令都被单独放行',
      },
    }
  }

  // 6. 一些子命令需要审批——构建建议
  const decisionReason = {
    type: 'other' as const,
    reason: '此命令需要审批',
  }

  const pendingSuggestions: PermissionUpdate[] = []
  for (const subCmd of subCommandsNeedingApproval) {
    pendingSuggestions.push(...suggestionForExactCommand(subCmd))
  }

  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: pendingSuggestions,
  }
}
