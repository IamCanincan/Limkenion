/**
 * 用于命令校验的 PowerShell 专用安全分析。
 *
 * 检测危险模式：代码注入、下载摇篮（download cradle）、提权、动态命令名、
 * COM 对象等。
 *
 * 所有检查均基于 AST。若解析失败（valid=false），则单个检查全部不匹配，
 * powershellCommandIsSafe 返回 'ask'。
 */

import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
} from '../../utils/powershell/dangerousCmdlets.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../utils/powershell/parser.js'
import {
  COMMON_ALIASES,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  hasCommandNamed,
} from '../../utils/powershell/parser.js'
import { isClmAllowedType } from './clmTypes.js'

type PowerShellSecurityResult = {
  behavior: 'passthrough' | 'ask' | 'allow'
  message?: string
}

const POWERSHELL_EXECUTABLES = new Set([
  'pwsh',
  'pwsh.exe',
  'powershell',
  'powershell.exe',
])

/**
 * 从命令中提取可执行程序基名，可处理 /usr/bin/pwsh、
 * C:\Windows\...\powershell.exe 或 .\pwsh 等完整路径。
 */
function isPowerShellExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  if (POWERSHELL_EXECUTABLES.has(lower)) {
    return true
  }
  // 从路径中提取基名（同时支持 / 和 \ 分隔符）
  const lastSep = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  if (lastSep >= 0) {
    return POWERSHELL_EXECUTABLES.has(lower.slice(lastSep + 1))
  }
  return false
}

/**
 * PowerShell 接受作为 ASCII 连字符（U+002D）等价符的替代参数前缀字符。
 * PowerShell 的分词器（SpecialCharacters.IsDash）与 powershell.exe 的
 * CommandLineParameterParser 都接受全部四个破折号字符，外加 Windows
 * PowerShell 5.1 的 `/` 参数分隔符。Extent.Text 保留原始字符；
 * transformCommandAst 对 CommandParameterAst 元素使用 ce.text，
 * 因此这些字符会原样到达这里。
 */
const PS_ALT_PARAM_PREFIXES = new Set([
  '/', // Windows PowerShell 5.1（powershell.exe，而非 pwsh 7+）
  '\u2013', // en-dash 短破折号
  '\u2014', // em-dash 长破折号
  '\u2015', // horizontal bar 水平横线
])

/**
 * commandHasArgAbbreviation 的封装，同时匹配替代参数前缀（`/`、en-dash、
 * em-dash、horizontal-bar）。PowerShell 的分词器（SpecialCharacters.IsDash）
 * 对 powershell.exe 参数和 cmdlet 参数都接受这些字符，因此请在**所有**
 * PS 参数检查中使用它——而非仅限 pwsh.exe 调用。此前 checkComObject/
 * checkStartProcess/checkDangerousFilePathExecution/checkForEachMemberName
 * 使用裸的 commandHasArgAbbreviation，因此 `Start-Process foo –Verb RunAs`
 * 会被绕过。
 */
function psExeHasParamAbbreviation(
  cmd: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  if (commandHasArgAbbreviation(cmd, fullParam, minPrefix)) {
    return true
  }
  // 将替代前缀归一化为 `-` 后重新检查。构造一个参数已归一化的合成 cmd；
  // commandHasArgAbbreviation 内部处理冒号绑定值的切分。
  const normalized: ParsedCommandElement = {
    ...cmd,
    args: cmd.args.map(a =>
      a.length > 0 && PS_ALT_PARAM_PREFIXES.has(a[0]!) ? '-' + a.slice(1) : a,
    ),
  }
  return commandHasArgAbbreviation(normalized, fullParam, minPrefix)
}

/**
 * 检查 PowerShell 命令是否使用 Invoke-Expression 或其别名（iex）。
 * 它们等价于 eval，可执行任意代码。
 */
function checkInvokeExpression(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Invoke-Expression')) {
    return {
      behavior: 'ask',
      message:
        '命令使用了 Invoke-Expression，它可以执行任意代码',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查动态命令调用——即命令名本身是无法静态解析的表达式。
 *
 * PoC：
 *   & ${function:Invoke-Expression} 'payload'  — VariableExpressionAst
 *   & ('iex','x')[0] 'payload'                 — IndexExpressionAst → 'Other'
 *   & ('i'+'ex') 'payload'                     — BinaryExpressionAst → 'Other'
 *
 * 在所有情况下 cmd.name 都是字面量范围的文本（如 "('iex','x')[0]"），
 * 不匹配 hasCommandNamed('Invoke-Expression')。运行时 PowerShell 会把该
 * 表达式求值为命令名再调用。
 *
 * 合法的命令名**总是** StringConstantExpressionAst（映射为 'StringConstant'）：
 * `Get-Process`、`git`、`ls`。命令名位置出现任何其他元素类型都是动态的。
 * 与其对动态类型做黑名单（很脆弱——mapElementType 的默认分支会把未知 AST
 * 类型映射为 'Other'，而 `=== 'Variable'` 检查会漏掉），不如对
 * 'StringConstant' 做白名单。
 *
 * elementTypes[0] 是命令名元素（transformCommandAst 会先于参数元素把它推入）。
 * 当 elementTypes 缺失时 `!== undefined` 保护保证失败即放行（无法得到解析
 * 细节——若解析整体失败，valid=false 早已在链条更前面返回 'ask'）。
 */
function checkDynamicCommandName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.elementType !== 'CommandAst') {
      continue
    }
    const nameElementType = cmd.elementTypes?.[0]
    if (nameElementType !== undefined && nameElementType !== 'StringConstant') {
      return {
        behavior: 'ask',
        message:
          '命令名是动态表达式，无法进行静态校验',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查编码命令参数，此类参数会掩盖真实意图。
 * 在恶意软件中常用于绕过安全工具。
 */
function checkEncodedCommand(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      if (psExeHasParamAbbreviation(cmd, '-encodedcommand', '-e')) {
        return {
          behavior: 'ask',
          message: '命令使用了掩盖意图的编码参数',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 PowerShell 的再次调用（嵌套的 pwsh/powershell 进程）。
 *
 * 命令位置出现任何 PowerShell 可执行程序都会被标记——不仅限于 -Command/
 * -File。裸 `pwsh` 接收 stdin（`Get-Content x | pwsh`）或位置脚本路径时，
 * 会在没有显式标志的情况下执行任意代码。这与 checkStartProcess 向量 2 使用
 * 相同的"无法校验嵌套进程"逻辑：我们无法静态分析子进程将运行什么。
 */
function checkPwshCommandOrFile(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      return {
        behavior: 'ask',
        message:
          '命令派生了无法校验的嵌套 PowerShell 进程',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查下载摇篮（download cradle）模式——常见恶意软件技术，用于下载并执行远程代码。
 *
 * 语句内：捕获管道式摇篮（`IWR ... | IEX`）。
 * 跨语句：捕获拆分式摇篮（`$r = IWR ...; IEX $r.Content`）。
 * 跨语句情形已被 checkInvokeExpression（扫描所有语句）拦截，但此检查可
 * 改进告警信息。
 */
const DOWNLOADER_NAMES = new Set([
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'new-object',
  'start-bitstransfer', // MITRE T1197
])

function isDownloader(name: string): boolean {
  return DOWNLOADER_NAMES.has(name.toLowerCase())
}

function isIex(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'invoke-expression' || lower === 'iex'
}

function checkDownloadCradles(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 语句内：管道式摇篮（IWR ... | IEX）
  for (const statement of parsed.statements) {
    const cmds = statement.commands
    if (cmds.length < 2) {
      continue
    }
    const hasDownloader = cmds.some(cmd => isDownloader(cmd.name))
    const hasIex = cmds.some(cmd => isIex(cmd.name))
    if (hasDownloader && hasIex) {
      return {
        behavior: 'ask',
        message: '命令下载并执行远程代码',
      }
    }
  }

  // 跨语句：拆分式摇篮（$r = IWR ...; IEX $r.Content）。
  // 不会产生新的误报：若存在 IEX，checkInvokeExpression 已会询问。
  const all = getAllCommands(parsed)
  if (all.some(c => isDownloader(c.name)) && all.some(c => isIex(c.name))) {
    return {
      behavior: 'ask',
      message: '命令下载并执行远程代码',
    }
  }

  return { behavior: 'passthrough' }
}

/**
 * 检查独立下载工具——LOLBAS 中常用于拉取载荷的工具。与 checkDownloadCradles
 * （要求同一管道内既有下载又有 IEX）不同，此检查直接标记下载操作本身。
 *
 * Start-BitsTransfer：始终是文件传输（MITRE T1197）。
 * certutil -urlcache：经典 LOLBAS 下载。仅在携带 -urlcache 时标记；
 * 裸 `certutil` 有很多合法的证书管理用途。
 * bitsadmin /transfer：旧版 BITS 下载（早于 PowerShell）。
 */
function checkDownloadUtilities(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    // Start-BitsTransfer 专用于文件传输——没有安全变体。
    if (lower === 'start-bitstransfer') {
      return {
        behavior: 'ask',
        message: '命令通过 BITS 传输下载文件',
      }
    }
    // certutil / certutil.exe —— 仅当存在 -urlcache 时。certutil 有许多
    // 非下载用途（证书存储查询、编码等）。
    // certutil.exe 按标准 Windows 工具惯例同时接受 -urlcache 和 /urlcache
    // ——检查两种形式（下方 bitsadmin 同理）。
    if (lower === 'certutil' || lower === 'certutil.exe') {
      const hasUrlcache = cmd.args.some(a => {
        const la = a.toLowerCase()
        return la === '-urlcache' || la === '/urlcache'
      })
      if (hasUrlcache) {
        return {
          behavior: 'ask',
          message: '命令使用 certutil 从 URL 下载内容',
        }
      }
    }
    // bitsadmin /transfer —— 旧版 BITS CLI，与 Start-BitsTransfer 威胁相同。
    if (lower === 'bitsadmin' || lower === 'bitsadmin.exe') {
      if (cmd.args.some(a => a.toLowerCase() === '/transfer')) {
        return {
          behavior: 'ask',
          message: '命令通过 BITS 传输下载文件',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 Add-Type 的使用，它会在运行时编译并加载 .NET 代码。
 * 可被用于执行任意编译后的代码。
 */
function checkAddType(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Add-Type')) {
    return {
      behavior: 'ask',
      message: '命令编译并加载 .NET 代码',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 New-Object -ComObject。WScript.Shell、Shell.Application、
 * MMC20.Application、Schedule.Service、Msxml2.XMLHTTP 等 COM 对象各自
 * 拥有执行/下载能力——无需 IEX。
 *
 * 我们无法枚举所有危险的 ProgID，因此标记任何 -ComObject。仅创建对象本身
 * 是惰性的，但提示应警告用户 COM 实例化是一种执行原语。对结果的成员方法调用
 * （.Run()、.Exec()）由 checkMemberInvocations 单独捕获。
 */
function checkComObject(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.name.toLowerCase() !== 'new-object') {
      continue
    }
    // -ComObject 的最小缩写是 -com（New-Object 参数：-TypeName、-ComObject、
    // -ArgumentList、-Property、-Strict；由于 -Confirm 等公共参数，-co 在
    // PS5.1 中会有歧义，因此使用 -com）。
    if (psExeHasParamAbbreviation(cmd, '-comobject', '-com')) {
      return {
        behavior: 'ask',
        message:
          '命令实例化了一个可能具有执行能力的 COM 对象',
      }
    }
    // SECURITY: checkTypeLiterals 只能看到 parsed.typeLiterals 中的 [方括号]
    // 语法。`New-Object System.Net.WebClient` 把类型作为**字符串参数**
    //（StringConstantExpressionAst）传入，而不是 TypeExpressionAst，因此 CLM
    // 永远不会触发。这里提取 -TypeName（命名、冒号绑定或位置 0）并交由
    // isClmAllowedType 检查。可修补攻击向量 D4。
    let typeName: string | undefined
    for (let i = 0; i < cmd.args.length; i++) {
      const a = cmd.args[i]!
      const lower = a.toLowerCase()
      // -TypeName 缩写：-t 无歧义（New-Object 没有其他 -t* 参数）。
      // 先处理冒号绑定形式：-TypeName:Foo.Bar
      if (lower.startsWith('-t') && lower.includes(':')) {
        const colonIdx = a.indexOf(':')
        const paramPart = lower.slice(0, colonIdx)
        if ('-typename'.startsWith(paramPart)) {
          typeName = a.slice(colonIdx + 1)
          break
        }
      }
      // 空格分隔形式：-TypeName Foo.Bar
      if (
        lower.startsWith('-t') &&
        '-typename'.startsWith(lower) &&
        cmd.args[i + 1] !== undefined
      ) {
        typeName = cmd.args[i + 1]
        break
      }
    }
    // 位置 0 绑定到 -TypeName（NetParameterSet 默认）。命名参数（-Strict、
    // -ArgumentList、-Property、-ComObject）可能出现在位置 TypeName 之前，
    // 因此跳过去找到第一个未被消费的参数。
    if (typeName === undefined) {
      // New-Object 中会消费其后一个值参数的命名参数
      const VALUE_PARAMS = new Set(['-argumentlist', '-comobject', '-property'])
      // 开关参数（无值参数）
      const SWITCH_PARAMS = new Set(['-strict'])
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i]!
        if (a.startsWith('-')) {
          const lower = a.toLowerCase()
          // 跳过 -TypeName 变体（上面命名参数循环已处理）
          if (lower.startsWith('-t') && '-typename'.startsWith(lower)) {
            i++ // 跳过值
            continue
          }
          // 冒号绑定形式：-Param:Value（单个令牌，无需跳过）
          if (lower.includes(':')) continue
          if (SWITCH_PARAMS.has(lower)) continue
          if (VALUE_PARAMS.has(lower)) {
            i++ // 跳过值
            continue
          }
          // 未知参数——保守地跳过
          continue
        }
        // 第一个非破折号参数即位置 TypeName
        typeName = a
        break
      }
    }
    if (typeName !== undefined && !isClmAllowedType(typeName)) {
      return {
        behavior: 'ask',
        message: `New-Object 实例化的 .NET 类型 '${typeName}' 不在约束语言（ConstrainedLanguage）允许清单内`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查以 -FilePath（或 -LiteralPath）调用的 DANGEROUS_SCRIPT_BLOCK_CMDLETS。
 * 它们运行脚本文件——在树中没有 ScriptBlockAst 时执行任意代码。
 *
 * checkScriptBlockInjection 仅在 hasScriptBlocks 为真时触发。使用 -FilePath
 * 时不存在 ScriptBlockAst，因此 DANGEROUS_SCRIPT_BLOCK_CMDLETS 永远不会
 * 被检查到。此检查填补了 -FilePath 向量上的空白。
 *
 * DANGEROUS_SCRIPT_BLOCK_CMDLETS 中接受 -FilePath 的 cmdlet：
 *   Invoke-Command   -FilePath             （通过 COMMON_ALIASES 的 icm 别名）
 *   Start-Job        -FilePath, -LiteralPath
 *   Start-ThreadJob  -FilePath
 *   Register-ScheduledJob -FilePath
 * 而 *-PSSession 与 Register-*Event 条目不接受 -FilePath。
 *
 * 对这四个 cmdlet，-f 之于 -FilePath 无歧义（没有其他 -f* 参数）。
 * 对 Start-Job，-l 之于 -LiteralPath 无歧义；对另外三者是无害的空操作
 * （没有可冲突的 -l* 参数）。
 */

function checkDangerousFilePathExecution(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (!FILEPATH_EXECUTION_CMDLETS.has(resolved)) {
      continue
    }
    if (
      psExeHasParamAbbreviation(cmd, '-filepath', '-f') ||
      psExeHasParamAbbreviation(cmd, '-literalpath', '-l')
    ) {
      return {
        behavior: 'ask',
        message: `${cmd.name} -FilePath 会执行任意脚本文件`,
      }
    }
    // 位置绑定：`Start-Job script.ps1` 通过 FilePathParameterSet 解析把位置 0
    // 绑定到 -FilePath（ScriptBlock 参数则选择 ScriptBlockParameterSet）。
    // 与 checkForEachMemberName 相同的模式：任何非破折号的 StringConstant
    // 都可能是 -FilePath。过度标记（例如 `Start-Job -Name foo` 中的 `foo` 是
    // StringConstant）是安全的（fail-safe）。
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message: `${cmd.name} 的位置字符串参数会绑定到 -FilePath 并执行脚本文件`,
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 ForEach-Object -MemberName。通过字符串名对每个管道对象调用方法——
 * 语义等价于 `| % { $_.Method() }`，但树中没有任何 ScriptBlockAst 或
 * InvokeMemberExpressionAst。
 *
 * PoC：`Get-Process | ForEach-Object -MemberName Kill` → 杀掉所有进程。
 * checkScriptBlockInjection 检测不到（没有脚本块）；checkMemberInvocations
 * 检测不到（没有 .Method() 语法）。别名 `%` 和 `foreach` 经由 COMMON_ALIASES
 * 解析。
 */
function checkForEachMemberName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (resolved !== 'foreach-object') {
      continue
    }
    // ForEach-Object 以 -m 开头的参数只有 -MemberName。-m 无歧义。
    if (psExeHasParamAbbreviation(cmd, '-membername', '-m')) {
      return {
        behavior: 'ask',
        message:
          'ForEach-Object -MemberName 通过字符串名调用方法，无法校验',
      }
    }
    // PS7+：`ForEach-Object Kill` 通过 MemberSet 参数集解析把位置字符串参数
    // 绑定到 -MemberName（ScriptBlock 参数则选择 ScriptBlockSet）。扫描
    // **所有**参数——`-Verbose Kill` 或 `-ErrorAction Stop Kill` 仍会把 Kill
    // 按位置绑定。任何非破折号 StringConstant 都可能是 -MemberName；
    // 过度标记是安全的（fail-safe）。
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message:
            'ForEach-Object 的位置字符串参数会绑定到 -MemberName 并按名称调用方法',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查危险的 Start-Process 模式。
 *
 * 两个向量：
 * 1. `-Verb RunAs`——提权（UAC 提示）。
 * 2. 启动 PowerShell 可执行程序——嵌套调用。
 * `Start-Process pwsh -ArgumentList "-e <b64>"` 会绕过
 * checkEncodedCommand/checkPwshCommandOrFile，因为 cmd.name 是
 * `Start-Process` 而非 `pwsh`。-e 藏在 -ArgumentList 的字符串值里，
 * 永远不会被解析为外层命令的参数。与其解析 -ArgumentList 的内容（很脆弱——
 * 它是不透明字符串或数组），不如标记任何目标为 PS 可执行程序的 Start-Process：
 * 嵌套调用天然无法校验。
 */
function checkStartProcess(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower !== 'start-process' && lower !== 'saps' && lower !== 'start') {
      continue
    }
    // 向量 1：-Verb RunAs（空格或冒号语法）。
    // 空格语法：psExeHasParamAbbreviation 找到 -Verb/-v，然后扫描参数中的裸
    // 'runas' 令牌。
    if (
      psExeHasParamAbbreviation(cmd, '-Verb', '-v') &&
      cmd.args.some(a => a.toLowerCase() === 'runas')
    ) {
      return {
        behavior: 'ask',
        message: '命令请求提升权限',
      }
    }
    // 冒号语法——两层：
    // (a) 结构化：PR #23554 为冒号绑定的参数参数增加了 children[]。
    //     children[i] = [{type, text}] 作为绑定值。检查任何 -v* 前缀参数是否有
    //     子元素，其文本归一化（去掉引号/反引号/空白）后为 'runas'。对正则
    //     无法预料的任意引号保持稳健。
    // (b) 正则回退：用于没有 children[] 的解析输出，或作为纵深防御。
    //     -Verb:'RunAs'、-Verb:"RunAs"、-Verb:`runas 会绕过旧的 /...:runas$/
    //     模式，因为引号/反引号破坏了匹配。
    if (cmd.children) {
      for (let i = 0; i < cmd.args.length; i++) {
        // 匹配参数名前去掉反引号（bug #14）：-V`erb:RunAs
        const argClean = cmd.args[i]!.replace(/`/g, '')
        if (!/^[-\u2013\u2014\u2015/]v[a-z]*:/i.test(argClean)) continue
        const kids = cmd.children[i]
        if (!kids) continue
        for (const child of kids) {
          if (child.text.replace(/['"`\s]/g, '').toLowerCase() === 'runas') {
            return {
              behavior: 'ask',
              message: '命令请求提升权限',
            }
          }
        }
      }
    }
    if (
      cmd.args.some(a => {
        // 匹配前去掉反引号（bug #14 / review nit #2）
        const clean = a.replace(/`/g, '')
        return /^[-\u2013\u2014\u2015/]v[a-z]*:['"` ]*runas['"` ]*$/i.test(
          clean,
        )
      })
    ) {
      return {
        behavior: 'ask',
        message: '命令请求提升权限',
      }
    }
    // 向量 2：Start-Process 目标为 PowerShell 可执行程序。
    // 目标是第一个位置参数或 -FilePath 之后的值。扫描所有参数——出现任何
    // PS 可执行程序令牌都被视为启动目标。已知误报：路径值参数
    //（-WorkingDirectory、-RedirectStandard*）的基名为 pwsh/powershell——
    // isPowerShellExecutable 会从路径提取基名，因此 `-WorkingDirectory
    // C:\projects\pwsh` 会触发。可接受的取舍：Start-Process 不在
    // CMDLET_ALLOWLIST 中（无论如何都会始终询问），结果是 ask 而非 reject，
    // 且正确解析 Start-Process 参数绑定本身很脆弱。去掉解析器可能保留的引号。
    for (const arg of cmd.args) {
      const stripped = arg.replace(/^['"]|['"]$/g, '')
      if (isPowerShellExecutable(stripped)) {
        return {
          behavior: 'ask',
          message:
            'Start-Process 启动了无法校验的嵌套 PowerShell 进程',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 脚本块安全的 cmdlet（过滤/输出型 cmdlet）。
 * 管道给这些 cmdlet 的脚本块只是谓词或投影，不是任意执行。
 */
const SAFE_SCRIPT_BLOCK_CMDLETS = new Set([
  'where-object',
  'sort-object',
  'select-object',
  'group-object',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  // 不包括 foreach-object——它的块是任意脚本，不是谓词。
  // getAllCommands 会递归，因此块内的命令**确实**会被检查，但非命令的 AST
  // 节点（AssignmentStatementAst 等）对它不可见。
  // 见 powershellPermissions.ts 第 5 步的 hasScriptBlocks 防护。
])

/**
 * 检查脚本块注入模式——脚本块出现在可能执行任意代码的可疑上下文中。
 *
 * 与安全的过滤/输出 cmdlet（Where-Object、Sort-Object、Select-Object、
 * Group-Object）一起使用的脚本块是允许的。
 * 与危险 cmdlet（Invoke-Command、Invoke-Expression、Start-Job 等）一起使用
 * 的脚本块会被标记。
 */
function checkScriptBlockInjection(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  const security = deriveSecurityFlags(parsed)
  if (!security.hasScriptBlocks) {
    return { behavior: 'passthrough' }
  }

  // 检查解析结果中的所有命令。若任一命令在危险集合中则标记它。若所有带脚本
  // 块的命令都在安全集合（或允许清单）中，则允许。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          '命令含带危险 cmdlet 的脚本块，可能执行任意代码',
      }
    }
  }

  // 检查是否所有命令要么是安全脚本块消费者，要么不使用脚本块
  const allCommandsSafe = getAllCommands(parsed).every(cmd => {
    const lower = cmd.name.toLowerCase()
    // 安全过滤/输出 cmdlet
    if (SAFE_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return true
    }
    // 解析别名
    const alias = COMMON_ALIASES[lower]
    if (alias && SAFE_SCRIPT_BLOCK_CMDLETS.has(alias.toLowerCase())) {
      return true
    }
    // 出现脚本块的未知命令——标记为潜在危险
    return false
  })

  if (allCommandsSafe) {
    return { behavior: 'passthrough' }
  }

  return {
    behavior: 'ask',
    message: '命令含可能执行任意代码的脚本块',
  }
}

/**
 * 仅基于 AST 的检查：检测可隐藏命令执行的子表达式 $()。
 */
function checkSubExpressions(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSubExpressions) {
    return {
      behavior: 'ask',
      message: '命令包含子表达式 $()',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅基于 AST 的检查：检测双引号字符串中嵌入表达式（如 "$env:PATH" 或
 * "$(dangerous-command)"）的可展开字符串。它们可在字符串字面量内隐藏命令
 * 执行或变量插值。
 */
function checkExpandableStrings(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasExpandableStrings) {
    return {
      behavior: 'ask',
      message: '命令包含嵌有表达式的可展开字符串',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅基于 AST 的检查：检测可掩盖参数的 splatting（@variable）。
 */
function checkSplatting(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSplatting) {
    return {
      behavior: 'ask',
      message: '命令使用了 splatting（@variable）',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅基于 AST 的检查：检测停止解析令牌（--%），它会阻止进一步解析。
 */
function checkStopParsing(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasStopParsing) {
    return {
      behavior: 'ask',
      message: '命令使用了停止解析令牌（--%）',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅基于 AST 的检查：检测可访问系统 API 的 .NET 方法调用。
 */
function checkMemberInvocations(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasMemberInvocations) {
    return {
      behavior: 'ask',
      message: '命令调用了 .NET 方法',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅基于 AST 的检查：Microsoft 约束语言模式（CLM）允许清单之外的类型字面量。
 * CLM 会拦截除约 90 个 Microsoft 认为对不可信代码安全的基础类型/特性之外的
 * 所有 .NET 类型访问。我们信任该清单作为"安全"边界——其外的任何类型
 *（Reflection.Assembly、IO.Pipes、Diagnostics.Process、
 * InteropServices.Marshal 等）都可能在权限模型之下访问系统 API。
 *
 * 运行在 checkMemberInvocations **之后**：后者会宽泛地标记任何 ::Method /
 * .Method() 调用；本检查是更具体的"用了哪些类型"信号。两者都会在
 * [Reflection.Assembly]::Load 上触发；CLM 给出精确的消息。像 [int]$x 这类
 * 纯类型转换没有成员调用，只会命中本检查。
 */
function checkTypeLiterals(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const t of parsed.typeLiterals ?? []) {
    if (!isClmAllowedType(t)) {
      return {
        behavior: 'ask',
        message: `命令使用了约束语言（ConstrainedLanguage）允许清单之外的 .NET 类型 [${t}]`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Invoke-Item（别名 ii）用默认程序打开文件（在 Windows 上为 ShellExecute，
 * 在 Unix 上为 open/xdg-open）。若目标是 .exe/.ps1/.bat/.cmd，则相当于 RCE。
 * Bug 008：ii 不在任何黑名单里；passthrough 提示不会解释其执行风险。
 * 始终询问——没有安全变体（即便打开 .txt 也可能调用用户配置的、可接受参数的
 * 处理程序）。
 */
function checkInvokeItem(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower === 'invoke-item' || lower === 'ii') {
      return {
        behavior: 'ask',
        message:
          'Invoke-Item 会以默认程序（ShellExecute）打开文件。对可执行文件而言这会执行任意代码。',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 计划任务持久化原语。Register-ScheduledJob 已被拦截
 *（DANGEROUS_SCRIPT_BLOCK_CMDLETS）；较新的 Register-ScheduledTask cmdlet
 * 和旧版 schtasks.exe /create 原先未拦截。它们是会话结束后仍可存活的持久化
 * 手段，且此前没有任何提示说明。
 */
const SCHEDULED_TASK_CMDLETS = new Set([
  'register-scheduledtask',
  'new-scheduledtask',
  'new-scheduledtaskaction',
  'set-scheduledtask',
])

function checkScheduledTask(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (SCHEDULED_TASK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} 创建或修改计划任务（持久化原语）`,
      }
    }
    if (lower === 'schtasks' || lower === 'schtasks.exe') {
      if (
        cmd.args.some(a => {
          const la = a.toLowerCase()
          return (
            la === '/create' ||
            la === '/change' ||
            la === '-create' ||
            la === '-change'
          )
        })
      ) {
        return {
          behavior: 'ask',
          message:
            '带 create/change 的 schtasks 会修改计划任务（持久化原语）',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅基于 AST 的检查：通过 Set-Item/New-Item 在 env: 作用域上检测环境变量操作。
 */
const ENV_WRITE_CMDLETS = new Set([
  'set-item',
  'si',
  'new-item',
  'ni',
  'remove-item',
  'ri',
  'del',
  'rm',
  'rd',
  'rmdir',
  'erase',
  'clear-item',
  'cli',
  'set-content',
  // 省略 'sc'——在 PS Core 7+ 上会与 sc.exe 冲突，见 COMMON_ALIASES 注释
  'add-content',
  'ac',
])

function checkEnvVarManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  const envVars = getVariablesByScope(parsed, 'env')
  if (envVars.length === 0) {
    return { behavior: 'passthrough' }
  }
  // 检查是否存在写入类 cmdlet
  for (const cmd of getAllCommands(parsed)) {
    if (ENV_WRITE_CMDLETS.has(cmd.name.toLowerCase())) {
      return {
        behavior: 'ask',
        message: '命令修改了环境变量',
      }
    }
  }
  // 若存在涉及环境变量的赋值也标记
  if (deriveSecurityFlags(parsed).hasAssignments && envVars.length > 0) {
    return {
      behavior: 'ask',
      message: '命令修改了环境变量',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 模块加载 cmdlet 会执行 .psm1 的顶层脚本体（Import-Module），或从任意仓库
 * 下载（Install-Module、Save-Module）。像 `Import-Module:*` 这样的通配允许
 * 规则会让攻击者提供的 .psm1 以用户权限执行——与 Invoke-Expression 风险相同。
 *
 * NEVER_SUGGEST（dangerousCmdlets.ts）由该列表派生，使 UI 永远不会把这类
 * cmdlet 作为通配建议，但用户仍可手动编写允许规则。本检查保证权限引擎对这些
 * cmdlet 独立把关。
 */

function checkModuleLoading(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (MODULE_LOADING_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          '命令加载、安装或下载了 PowerShell 模块或脚本，这可以执行任意代码',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Set-Alias/New-Alias 可劫持未来命令解析：在
 * `Set-Alias Get-Content Invoke-Expression` 之后，任何后续的
 * `Get-Content $x` 都会执行任意代码。Set-Variable/New-Variable 可污染
 * `$PSDefaultParameterValues`（例如 `Set-Variable PSDefaultParameterValues
 * @{'*:Path'='/etc/passwd'}`），从而改变之后每个 cmdlet 的行为。
 * 这两者都无法静态校验——我们需要跟踪会话中所有未来的命令解析。始终询问。
 */
const RUNTIME_STATE_CMDLETS = new Set([
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
])

function checkRuntimeStateManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    // 去掉模块限定符：`Microsoft.PowerShell.Utility\Set-Alias` → `set-alias`
    const raw = cmd.name.toLowerCase()
    const lower = raw.includes('\\')
      ? raw.slice(raw.lastIndexOf('\\') + 1)
      : raw
    if (RUNTIME_STATE_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          '命令创建或修改了可能影响未来命令解析的别名或变量',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Invoke-WmiMethod / Invoke-CimMethod 是通过 WMI 实现的 Start-Process 等价物。
 * `Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "cmd /c ..."`
 * 会派生任意进程，完全绕过 checkStartProcess。不存在窄化的安全用法——
 * -Class 和 -MethodName 接受任意字符串，因此若仅针对 Win32_Process 把关，
 * 会漏过 -Class $x 或其他可派生进程的 WMI 类。任何调用都返回 ask。
 *（安全发现 #34）
 */
const WMI_SPAWN_CMDLETS = new Set([
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
])

function checkWmiProcessSpawn(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (WMI_SPAWN_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} 可通过 WMI/CIM 派生任意进程（Win32_Process Create）`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * PowerShell 安全校验的主入口。
 * 对照已知危险模式检查一条 PowerShell 命令。
 *
 * 所有检查均基于 AST。若 AST 解析失败（parsed.valid === false），单个检查
 * 都不会匹配，作为安全默认返回 'ask'。
 *
 * @param command - 要校验的 PowerShell 命令（未使用，仅为 API 兼容保留）
 * @param parsed - 由 PowerShell 原生解析器解析出的 AST（必需）
 * @returns 表示命令是否安全的安全结果
 */
export function powershellCommandIsSafe(
  _command: string,
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 若 AST 解析失败，我们无法确定安全性——询问用户
  if (!parsed.valid) {
    return {
      behavior: 'ask',
      message: '无法解析命令以进行安全分析',
    }
  }

  const validators = [
    checkInvokeExpression,
    checkDynamicCommandName,
    checkEncodedCommand,
    checkPwshCommandOrFile,
    checkDownloadCradles,
    checkDownloadUtilities,
    checkAddType,
    checkComObject,
    checkDangerousFilePathExecution,
    checkInvokeItem,
    checkScheduledTask,
    checkForEachMemberName,
    checkStartProcess,
    checkScriptBlockInjection,
    checkSubExpressions,
    checkExpandableStrings,
    checkSplatting,
    checkStopParsing,
    checkMemberInvocations,
    checkTypeLiterals,
    checkEnvVarManipulation,
    checkModuleLoading,
    checkRuntimeStateManipulation,
    checkWmiProcessSpawn,
  ]

  for (const validator of validators) {
    const result = validator(parsed)
    if (result.behavior === 'ask') {
      return result
    }
  }

  // 全部检查通过
  return { behavior: 'passthrough' }
}
