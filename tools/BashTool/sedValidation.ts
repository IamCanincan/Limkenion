import type { ToolPermissionContext } from '../../Tool.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

/**
 * 辅助函数：根据允许列表校验标志
 * 同时处理单个标志和组合标志（例如 -nE）
 * @param flags 待校验的标志数组
 * @param allowedFlags 允许的单字符标志和长标志数组
 * @returns 若所有标志均合法则返回 true，否则返回 false
 */
function validateFlagsAgainstAllowlist(
  flags: string[],
  allowedFlags: string[],
): boolean {
  for (const flag of flags) {
    // 处理 -nE 或 -Er 之类的组合标志
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
      // 逐个检查组合标志中的字符
      for (let i = 1; i < flag.length; i++) {
        const singleFlag = '-' + flag[i]
        if (!allowedFlags.includes(singleFlag)) {
          return false
        }
      }
    } else {
      // 单个标志或长标志
      if (!allowedFlags.includes(flag)) {
        return false
      }
    }
  }
  return true
}

/**
 * 模式 1：检查这是否是带 -n 标志的行打印命令
 * 允许：sed -n 'N' | sed -n 'N,M'，可选 -E、-r、-z 标志
 * 允许分号分隔的打印命令，例如：sed -n '1p;2p;3p'
 * 该模式允许文件参数
 * @internal 为测试而导出
 */
export function isLinePrintingCommand(
  command: string,
  expressions: string[],
): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // 提取所有标志
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // 校验标志——只允许 -n、-E、-r、-z 及其长形式
  const allowedFlags = [
    '-n',
    '--quiet',
    '--silent',
    '-E',
    '--regexp-extended',
    '-r',
    '-z',
    '--zero-terminated',
    '--posix',
  ]

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // 检查是否存在 -n 标志（模式 1 必需）
  let hasNFlag = false
  for (const flag of flags) {
    if (flag === '-n' || flag === '--quiet' || flag === '--silent') {
      hasNFlag = true
      break
    }
    // 在组合标志中检查
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.includes('n')) {
      hasNFlag = true
      break
    }
  }

  // 模式 1 必须有 -n 标志
  if (!hasNFlag) {
    return false
  }

  // 必须至少有一个表达式
  if (expressions.length === 0) {
    return false
  }

  // 所有表达式都必须是打印命令（严格允许列表）
  // 允许分号分隔的命令
  for (const expr of expressions) {
    const commands = expr.split(';')
    for (const cmd of commands) {
      if (!isPrintCommand(cmd.trim())) {
        return false
      }
    }
  }

  return true
}

/**
 * 辅助函数：检查单条命令是否为合法的打印命令
 * 严格允许列表——只允许以下精确形式：
 * - p（打印全部）
 * - Np（打印第 N 行，N 为数字）
 * - N,Mp（打印第 N 到第 M 行）
 * 其他任何形式（包括 w、W、e、E 命令）一律拒绝。
 * @internal 为测试而导出
 */
export function isPrintCommand(cmd: string): boolean {
  if (!cmd) return false
  // 单个严格正则，只匹配允许的打印命令
  // ^(?:\d+|\d+,\d+)?p$ 匹配：p、1p、123p、1,5p、10,200p
  return /^(?:\d+|\d+,\d+)?p$/.test(cmd)
}

/**
 * 模式 2：检查这是否是替换命令
 * 允许：sed 's/pattern/replacement/flags'，其中 flags 只能是：g、p、i、I、m、M、1-9
 * 当 allowFileWrites 为 true 时，允许 -i 标志和文件参数以进行原地编辑
 * 当 allowFileWrites 为 false（默认）时，要求仅写 stdout（无文件参数、无 -i 标志）
 * @internal 为测试而导出
 */
function isSubstitutionCommand(
  command: string,
  expressions: string[],
  hasFileArguments: boolean,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // 不允许文件写入时，必须没有文件参数
  if (!allowFileWrites && hasFileArguments) {
    return false
  }

  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // 提取所有标志
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // 根据模式校验标志
  // 两种模式的基础允许标志
  const allowedFlags = ['-E', '--regexp-extended', '-r', '--posix']

  // 允许文件写入时，同时允许 -i 和 --in-place
  if (allowFileWrites) {
    allowedFlags.push('-i', '--in-place')
  }

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // 必须恰好有一个表达式
  if (expressions.length !== 1) {
    return false
  }

  const expr = expressions[0]!.trim()

  // 严格允许列表：必须恰好是以 's' 开头的替换命令
  // 这会拒绝 'e'、'w file' 之类的独立命令
  if (!expr.startsWith('s')) {
    return false
  }

  // 解析替换命令：s/pattern/replacement/flags
  // 只允许 / 作为分隔符（严格）
  const substitutionMatch = expr.match(/^s\/(.*?)$/)
  if (!substitutionMatch) {
    return false
  }

  const rest = substitutionMatch[1]!

  // 找出 / 分隔符的位置
  let delimiterCount = 0
  let lastDelimiterPos = -1
  let i = 0
  while (i < rest.length) {
    if (rest[i] === '\\') {
      // 跳过转义字符
      i += 2
      continue
    }
    if (rest[i] === '/') {
      delimiterCount++
      lastDelimiterPos = i
    }
    i++
  }

  // 必须恰好找到 2 个分隔符（模式和替换）
  if (delimiterCount !== 2) {
    return false
  }

  // 提取标志（最后一个分隔符之后的所有内容）
  const exprFlags = rest.slice(lastDelimiterPos + 1)

  // 校验标志：只允许 g、p、i、I、m、M，以及可选的 1 个数字 1-9
  const allowedFlagChars = /^[gpimIM]*[1-9]?[gpimIM]*$/
  if (!allowedFlagChars.test(exprFlags)) {
    return false
  }

  return true
}

/**
 * 检查 sed 命令是否被允许列表放行。
 * 允许列表模式本身已足够严格，可拒绝危险操作。
 * @param command 待检查的 sed 命令
 * @param options.allowFileWrites 为 true 时，替换命令允许 -i 标志和文件参数
 * @returns 若命令被允许（匹配允许列表且通过拒绝列表检查）则返回 true，否则返回 false
 */
export function sedCommandIsAllowedByAllowlist(
  command: string,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // 提取 sed 表达式（引号内的内容，即真正的 sed 命令所在处）
  let expressions: string[]
  try {
    expressions = extractSedExpressions(command)
  } catch (_error) {
    // 若解析失败，视为不允许
    return false
  }

  // 检查 sed 命令是否带文件参数
  const hasFileArguments = hasFileArgs(command)

  // 检查命令是否匹配允许列表模式
  let isPattern1 = false
  let isPattern2 = false

  if (allowFileWrites) {
    // 允许文件写入时，只检查替换命令（模式 2 变体）
    // 模式 1（行打印）不需要文件写入
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments, {
      allowFileWrites: true,
    })
  } else {
    // 标准只读模式：检查两种模式
    isPattern1 = isLinePrintingCommand(command, expressions)
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments)
  }

  if (!isPattern1 && !isPattern2) {
    return false
  }

  // 模式 2 不允许分号（命令分隔符）
  // 模式 1 允许用分号分隔打印命令
  for (const expr of expressions) {
    if (isPattern2 && expr.includes(';')) {
      return false
    }
  }

  // 纵深防御：即使匹配允许列表，也要检查拒绝列表
  for (const expr of expressions) {
    if (containsDangerousOperations(expr)) {
      return false
    }
  }

  return true
}

/**
 * 检查 sed 命令是否带文件参数（而非仅 stdin）
 * @internal 为测试而导出
 */
export function hasFileArgs(command: string): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return true
  const parsed = parseResult.tokens

  try {
    let argCount = 0
    let hasEFlag = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // 同时处理字符串参数和 glob 模式（如 *.log）
      if (typeof arg !== 'string' && typeof arg !== 'object') continue

      // 若是 glob 模式，则视为文件参数
      if (
        typeof arg === 'object' &&
        arg !== null &&
        'op' in arg &&
        arg.op === 'glob'
      ) {
        return true
      }

      // 跳过不是 glob 模式的非字符串参数
      if (typeof arg !== 'string') continue

      // 处理 -e 标志后跟表达式的情况
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        hasEFlag = true
        i++ // 跳过下一个参数，因为它是表达式
        continue
      }

      // 处理 --expression=value 形式
      if (arg.startsWith('--expression=')) {
        hasEFlag = true
        continue
      }

      // 处理 -e=value 形式（非标准，但属于纵深防御）
      if (arg.startsWith('-e=')) {
        hasEFlag = true
        continue
      }

      // 跳过其他标志
      if (arg.startsWith('-')) continue

      argCount++

      // 若使用了 -e 标志，则所有非标志参数都是文件参数
      if (hasEFlag) {
        return true
      }

      // 若未使用 -e 标志，则第一个非标志参数是 sed 表达式，
      // 因此需要有超过 1 个非标志参数才算有文件参数
      if (argCount > 1) {
        return true
      }
    }

    return false
  } catch (_error) {
    return true // 解析失败时按危险处理
  }
}

/**
 * 从命令中提取 sed 表达式，忽略标志和文件名
 * @param command 完整的 sed 命令
 * @returns 用于检查危险操作的 sed 表达式数组
 * @throws 解析失败时抛出 Error
 * @internal 为测试而导出
 */
export function extractSedExpressions(command: string): string[] {
  const expressions: string[] = []

  // 通过裁掉前 N 个字符（去掉 'sed '）来计算 withoutSed
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return expressions

  const withoutSed = command.slice(sedMatch[0].length)

  // 拒绝 -ew、-eW、-ee、-we 等危险标志组合（-e/-w 与危险命令的组合）
  if (/-e[wWe]/.test(withoutSed) || /-w[eE]/.test(withoutSed)) {
    throw new Error('Dangerous flag combination detected')
  }

  // 使用 shell-quote 正确解析参数
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) {
    // shell 语法格式错误——抛出错误由调用方捕获
    throw new Error(`Malformed shell syntax: ${parseResult.error}`)
  }
  const parsed = parseResult.tokens
  try {
    let foundEFlag = false
    let foundExpression = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // 跳过非字符串参数（如控制操作符）
      if (typeof arg !== 'string') continue

      // 处理 -e 标志后跟表达式的情况
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        foundEFlag = true
        const nextArg = parsed[i + 1]
        if (typeof nextArg === 'string') {
          expressions.push(nextArg)
          i++ // 跳过下一个参数，因为它已被消费
        }
        continue
      }

      // 处理 --expression=value 形式
      if (arg.startsWith('--expression=')) {
        foundEFlag = true
        expressions.push(arg.slice('--expression='.length))
        continue
      }

      // 处理 -e=value 形式（非标准，但属于纵深防御）
      if (arg.startsWith('-e=')) {
        foundEFlag = true
        expressions.push(arg.slice('-e='.length))
        continue
      }

      // 跳过其他标志
      if (arg.startsWith('-')) continue

      // 若未发现任何 -e 标志，则第一个非标志参数是 sed 表达式
      if (!foundEFlag && !foundExpression) {
        expressions.push(arg)
        foundExpression = true
        continue
      }

      // 若已找到 -e 标志或独立表达式，
      // 则剩余的非标志参数是文件名
      break
    }
  } catch (error) {
    // 若 shell-quote 解析失败，则将该 sed 命令视为不安全
    throw new Error(
      `Failed to parse sed command: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }

  return expressions
}

/**
 * 检查 sed 表达式是否包含危险操作（拒绝列表）
 * @param expression 单个 sed 表达式（不含引号）
 * @returns 危险则返回 true，安全则返回 false
 */
function containsDangerousOperations(expression: string): boolean {
  const cmd = expression.trim()
  if (!cmd) return false

  // 保守拒绝：广泛拒绝可能危险的模式
  // 存疑时按不安全处理

  // 拒绝非 ASCII 字符（Unicode 同形字、组合字符等）
  // 示例：ｗ（全角）、ᴡ（小型大写）、w̃（组合波浪号）
  // 检查 ASCII 范围之外的字符（0x01-0x7F，不含空字节）
  // eslint-disable-next-line no-control-regex
  if (/[^\x01-\x7F]/.test(cmd)) {
    return true
  }

  // 拒绝花括号（块）——解析过于复杂
  if (cmd.includes('{') || cmd.includes('}')) {
    return true
  }

  // 拒绝换行符——多行命令过于复杂
  if (cmd.includes('\n')) {
    return true
  }

  // 拒绝注释（# 未紧跟在 s 命令之后）
  // 注释形如：#comment 或以 # 开头
  // 分隔符形如：s#pattern#replacement#
  const hashIndex = cmd.indexOf('#')
  if (hashIndex !== -1 && !(hashIndex > 0 && cmd[hashIndex - 1] === 's')) {
    return true
  }

  // 拒绝取反操作符
  // 取反可出现于：开头（!/pattern/）、地址之后（/pattern/!、1,10!、$!）
  // 分隔符形如：s!pattern!replacement!（其前有 's'）
  if (/^!/.test(cmd) || /[/\d$]!/.test(cmd)) {
    return true
  }

  // 拒绝 GNU 步长地址格式中的波浪号（digit~digit、,~digit 或 $~digit）
  // 允许波浪号两侧有空白
  if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(cmd)) {
    return true
  }

  // 拒绝开头的逗号（裸逗号是 1,$ 地址范围的简写）
  if (/^,/.test(cmd)) {
    return true
  }

  // 拒绝逗号后跟 +/-（GNU 偏移地址）
  if (/,\s*[+-]/.test(cmd)) {
    return true
  }

  // 拒绝反斜杠花招：
  // 1. s\（以反斜杠作分隔符的替换）
  // 2. \X，其中 X 可能是替代分隔符（|、#、% 等）——而非正则转义
  if (/s\\/.test(cmd) || /\\[|#%@]/.test(cmd)) {
    return true
  }

  // 拒绝转义斜杠后跟 w/W（形如 /\/path\/to\/file/w 的模式）
  if (/\\\/.*[wW]/.test(cmd)) {
    return true
  }

  // 拒绝我们无法理解的畸形/可疑模式
  // 若斜杠后跟非斜杠字符，然后是空白，再是危险命令
  // 示例：/pattern w file、/pattern e cmd、/foo X;w file
  if (/\/[^/]*\s+[wWeE]/.test(cmd)) {
    return true
  }

  // 拒绝不符合常规模式的畸形替换命令
  // 示例：s/foobareoutput.txt（缺少分隔符）、s/foo/bar//w（多出分隔符）
  if (/^s\//.test(cmd) && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(cmd)) {
    return true
  }

  // 偏执模式：拒绝任何以 's' 开头、以危险字符（w、W、e、E）结尾
  // 且不匹配已知安全替换模式的命令。这能捕获使用非斜杠分隔符、
  // 可能试图使用危险标志的畸形 s 命令。
  if (/^s./.test(cmd) && /[wWeE]$/.test(cmd)) {
    // 检查它是否是格式正确的替换（任意分隔符，不限于 /）
    const properSubst = /^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(cmd)
    if (!properSubst) {
      return true
    }
  }

  // 检查危险的写命令
  // 模式：[address]w filename、[address]W filename、/pattern/w filename、/pattern/W filename
  // 已简化以避免指数级回溯（CodeQL 问题）
  // 在 w/W 会成为命令的上下文中检查它（可带空白）
  if (
    /^[wW]\s*\S+/.test(cmd) || // 开头处：w file
    /^\d+\s*[wW]\s*\S+/.test(cmd) || // 行号之后：1w file 或 1 w file
    /^\$\s*[wW]\s*\S+/.test(cmd) || // $ 之后：$w file 或 $ w file
    /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) || // 模式之后：/pattern/w file
    /^\d+,\d+\s*[wW]\s*\S+/.test(cmd) || // 范围之后：1,10w file
    /^\d+,\$\s*[wW]\s*\S+/.test(cmd) || // 范围之后：1,$w file
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) // 模式范围之后：/s/,/e/w file
  ) {
    return true
  }

  // 检查危险的执行命令
  // 模式：[address]e [command]、/pattern/e [command]，或以 e 开头的命令
  // 已简化以避免指数级回溯（CodeQL 问题）
  // 在 e 会成为命令的上下文中检查它（可带空白）
  if (
    /^e/.test(cmd) || // 开头处：e cmd
    /^\d+\s*e/.test(cmd) || // 行号之后：1e 或 1 e
    /^\$\s*e/.test(cmd) || // $ 之后：$e 或 $ e
    /^\/[^/]*\/[IMim]*\s*e/.test(cmd) || // 模式之后：/pattern/e
    /^\d+,\d+\s*e/.test(cmd) || // 范围之后：1,10e
    /^\d+,\$\s*e/.test(cmd) || // 范围之后：1,$e
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(cmd) // 模式范围之后：/s/,/e/e
  ) {
    return true
  }

  // 检查带危险标志的替换命令
  // 模式：s<delim>pattern<delim>replacement<delim>flags，其中 flags 含 w 或 e
  // 按 POSIX，sed 允许除反斜杠和换行之外的任意字符作为分隔符
  const substitutionMatch = cmd.match(/s([^\\\n]).*?\1.*?\1(.*?)$/)
  if (substitutionMatch) {
    const flags = substitutionMatch[2] || ''

    // 检查写标志：s/old/new/w filename 或 s/old/new/gw filename
    if (flags.includes('w') || flags.includes('W')) {
      return true
    }

    // 检查执行标志：s/old/new/e 或 s/old/new/ge
    if (flags.includes('e') || flags.includes('E')) {
      return true
    }
  }

  // 检查后跟危险操作的 y（音译）命令
  // 模式：y<delim>source<delim>dest<delim> 后跟任意内容
  // y 命令使用与 s 命令相同的分隔符语法
  // 偏执模式：拒绝任何在分隔符之后出现 w/W/e/E 的 y 命令
  const yCommandMatch = cmd.match(/y([^\\\n])/)
  if (yCommandMatch) {
    // 若看到 y 命令，检查整条命令中是否存在 w、W、e 或 E
    // 这很偏执但安全——y 命令很少见，而 y 之后出现 w/e 很可疑
    if (/[wWeE]/.test(cmd)) {
      return true
    }
  }

  return false
}

/**
 * sed 命令的横切校验步骤。
 *
 * 这是一个约束检查，无论何种模式都会拦截危险的 sed 操作。
 * 对非 sed 命令或安全的 sed 命令返回 'passthrough'，
 * 对危险的 sed 操作（w/W/e/E 命令）返回 'ask'。
 *
 * @param input - 包含命令字符串的对象
 * @param toolPermissionContext - 包含模式与权限的上下文
 * @returns
 * - 若任一 sed 命令包含危险操作则返回 'ask'
 * - 若无 sed 命令或全部安全则返回 'passthrough'
 */
export function checkSedConstraints(
  input: { command: string },
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const commands = splitCommand_DEPRECATED(input.command)

  for (const cmd of commands) {
    // 跳过非 sed 命令
    const trimmed = cmd.trim()
    const baseCmd = trimmed.split(/\s+/)[0]
    if (baseCmd !== 'sed') {
      continue
    }

    // 在 acceptEdits 模式下，允许文件写入（-i 标志），但仍拦截危险操作
    const allowFileWrites = toolPermissionContext.mode === 'acceptEdits'

    const isAllowed = sedCommandIsAllowedByAllowlist(trimmed, {
      allowFileWrites,
    })

    if (!isAllowed) {
      return {
        behavior: 'ask',
        message:
          'sed 命令需要批准（可能包含潜在的危险操作）',
        decisionReason: {
          type: 'other',
          reason:
            'sed 命令包含需要明确批准的操作（例如写命令、执行命令）',
        },
      }
    }
  }

  // 未发现危险的 sed 命令（或根本没有 sed 命令）
  return {
    behavior: 'passthrough',
    message: '未检测到危险的 sed 操作',
  }
}
