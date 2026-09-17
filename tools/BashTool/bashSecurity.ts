import { logEvent } from 'src/services/analytics/index.js'
import { extractHeredocs } from '../../utils/bash/heredoc.js'
import { ParsedCommand } from '../../utils/bash/ParsedCommand.js'
import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from '../../utils/bash/shellQuote.js'
import type { TreeSitterAnalysis } from '../../utils/bash/treeSitterAnalysis.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

const HEREDOC_IN_SUBSTITUTION = /\$\(.*<</

// 注意：反引号模式在 validateDangerousPatterns 中单独处理，
// 以便区分转义与未转义的反引号
const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/, message: '进程替换 <()' },
  { pattern: />\(/, message: '进程替换 >()' },
  { pattern: /=\(/, message: 'Zsh 进程替换 =()' },
  // Zsh EQUALS 展开：位于单词开头的 =cmd 会展开为 $(which cmd)。
  // `=curl evil.com` → `/usr/bin/curl evil.com`，从而绕过 Bash(curl:*) 拒绝
  // 规则，因为解析器把 `=curl` 当作基础命令，而非 `curl`。
  // 仅匹配单词开头的 = 后跟命令名字符（不是 VAR=val）。
  {
    pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,
    message: 'Zsh 等号展开 (=cmd)',
  },
  { pattern: /\$\(/, message: '$() 命令替换' },
  { pattern: /\$\{/, message: '${} 参数替换' },
  { pattern: /\$\[/, message: '$[] 遗留算术展开' },
  { pattern: /~\[/, message: 'Zsh 风格参数展开' },
  { pattern: /\(e:/, message: 'Zsh 风格 glob 限定符' },
  { pattern: /\(\+/, message: '带命令执行的 Zsh glob 限定符' },
  {
    pattern: /\}\s*always\s*\{/,
    message: 'Zsh always 块（try/always 结构）',
  },
  // 纵深防御：尽管我们不在 PowerShell 中执行，仍阻止 PowerShell 注释语法
  // 作为对未来可能引入 PowerShell 执行的保护
  { pattern: /<#/, message: 'PowerShell 注释语法' },
]

// 可绕过安全检查的 Zsh 特有危险命令。
// 它们会针对每个命令段的基命令（首词）进行检查。
const ZSH_DANGEROUS_COMMANDS = new Set([
  // zmodload 是许多危险的基于模块的攻击的入口：
  // zsh/mapfile（通过数组赋值进行不可见的文件 I/O），
  // zsh/system（sysopen/syswrite 两步文件访问），
  // zsh/zpty（伪终端命令执行），
  // zsh/net/tcp（通过 ztcp 进行网络数据外泄），
  // zsh/files（绕过二进制检查的内建 rm/mv/ln/chmod）
  'zmodload',
  // 带有 -c 标志的 emulate 是执行任意代码时的 eval 等价物
  'emulate',
  // 可启用危险操作的 Zsh 模块内建命令。
  // 它们需要先 zmodload，但我们以纵深防御方式将其阻止，
  // 以防 zmodload 以某种方式被绕过或模块被预加载。
  'sysopen', // 以细粒度控制打开文件 (zsh/system)
  'sysread', // 从文件描述符读取 (zsh/system)
  'syswrite', // 写入文件描述符 (zsh/system)
  'sysseek', // 在文件描述符上定位 (zsh/system)
  'zpty', // 在伪终端上执行命令 (zsh/zpty)
  'ztcp', // 创建 TCP 连接用于外泄数据 (zsh/net/tcp)
  'zsocket', // 创建 Unix/TCP 套接字 (zsh/net/socket)
  'mapfile', // 并非真正的命令，但关联数组通过 zmodload 设置
  'zf_rm', // zsh/files 的内建 rm
  'zf_mv', // zsh/files 的内建 mv
  'zf_ln', // zsh/files 的内建 ln
  'zf_chmod', // zsh/files 的内建 chmod
  'zf_chown', // zsh/files 的内建 chown
  'zf_mkdir', // zsh/files 的内建 mkdir
  'zf_rmdir', // zsh/files 的内建 rmdir
  'zf_chgrp', // zsh/files 的内建 chgrp
])

// bash 安全检查的数字标识符（避免记录字符串）
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  JQ_FILE_ARGUMENTS: 3,
  OBFUSCATED_FLAGS: 4,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  NEWLINES: 7,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,
  IFS_INJECTION: 11,
  GIT_COMMIT_SUBSTITUTION: 12,
  PROC_ENVIRON_ACCESS: 13,
  MALFORMED_TOKEN_INJECTION: 14,
  BACKSLASH_ESCAPED_WHITESPACE: 15,
  BRACE_EXPANSION: 16,
  CONTROL_CHARACTERS: 17,
  UNICODE_WHITESPACE: 18,
  MID_WORD_HASH: 19,
  ZSH_DANGEROUS_COMMANDS: 20,
  BACKSLASH_ESCAPED_OPERATORS: 21,
  COMMENT_QUOTE_DESYNC: 22,
  QUOTED_NEWLINE: 23,
} as const

type ValidationContext = {
  originalCommand: string
  baseCommand: string
  unquotedContent: string
  fullyUnquotedContent: string
  /** fullyUnquoted 在 stripSafeRedirections 之前的版本——供 validateBraceExpansion 使用，
   * 避免重定向剥离生成了反斜杠相邻而产生误判 */
  fullyUnquotedPreStrip: string
  /** 类似 fullyUnquotedPreStrip，但保留引号字符（'/"）：例如
   * echo 'x'# → echo ''#（引号字符保留，从而揭示与 # 的相邻关系） */
  unquotedKeepQuoteChars: string
  /** Tree-sitter 分析数据（如果可用）。验证器可在存在时据此做更精确的分析，
   * 否则回退到正则。 */
  treeSitter?: TreeSitterAnalysis | null
}

type QuoteExtraction = {
  withDoubleQuotes: string
  fullyUnquoted: string
  /** 类似 fullyUnquoted，但保留引号字符（'/"）：剥离引号内的内容同时保留定界符。
   * 供 validateMidWordHash 检测与引号相邻的 #（例如 'x'#，此时普通的引号剥离会
   * 隐藏相邻关系）。 */
  unquotedKeepQuoteChars: string
}

function extractQuotedContent(command: string, isJq = false): QuoteExtraction {
  let withDoubleQuotes = ''
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (escaped) {
      escaped = false
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      unquotedKeepQuoteChars += char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      unquotedKeepQuoteChars += char
      // 对于 jq，提取时包含引号，确保内容被正确分析
      if (!isJq) continue
    }

    if (!inSingleQuote) withDoubleQuotes += char
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
    if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

function stripSafeRedirections(content: string): string {
  // 安全要点：三个模式都必须带结尾边界 (?=\s|$)。
  // 否则 `> /dev/nullo` 会把 `/dev/null` 作为前缀匹配，剥离 `> /dev/null`
  // 后留下 `o`，于是 `echo hi > /dev/nullo` 变成 `echo hi o`。
  // validateRedirections 因此看不到 `>` 而通过。对 /dev/nullo 的文件写入
  // 会经由只读路径（checkReadOnlyConstraints）被自动允许。
  // 主流程 bashPermissions 受到保护（checkPathConstraints 会校验原始命令），
  // 但 speculation.ts 仅单独使用 checkReadOnlyConstraints。
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
}

/**
 * 检查内容中是否出现未转义的单个字符。
 * 正确处理 bash 转义序列，即反斜杠会转义其后的字符。
 *
 * 重要提示：此函数只处理单个字符，不处理字符串。若需要扩展为处理多字符字符串，
 * 请对 shell 的 ANSI-C 引号（如 $'\n'、$'\x41'、$'\u0041'）格外小心，它们可以用
 * 极难正确解析的方式编码任意字符和字符串。处理不当可能引入安全漏洞，使攻击者
 * 得以绕过安全检查。
 *
 * @param content - 要搜索的字符串（通常来自 extractQuotedContent）
 * @param char - 要搜索的单个字符（例如 '`'）
 * @returns 若找到未转义字符则返回 true，否则返回 false
 *
 * 示例：
 *   hasUnescapedChar("test \`safe\`", '`') → false（已转义的反引号）
 *   hasUnescapedChar("test `dangerous`", '`') → true（未转义的反引号）
 *   hasUnescapedChar("test\\`date`", '`') → true（转义的反斜杠 + 未转义的反引号）
 */
function hasUnescapedChar(content: string, char: string): boolean {
  if (char.length !== 1) {
    throw new Error('hasUnescapedChar 只能处理单个字符')
  }

  let i = 0
  while (i < content.length) {
    // 若见到反斜杠，跳过它和下一个字符（它们构成一个转义序列）
    if (content[i] === '\\' && i + 1 < content.length) {
      i += 2 // 跳过反斜杠和被转义的字符
      continue
    }
    // 检查当前字符是否匹配
    if (content[i] === char) {
      return true // 找到未转义的字符
    }

    i++
  }

  return false // 未找到未转义的字符
}

function validateEmpty(context: ValidationContext): PermissionResult {
  if (!context.originalCommand.trim()) {
    return {
      behavior: 'allow',
      updatedInput: { command: context.originalCommand },
      decisionReason: { type: 'other', reason: '空命令是安全的' },
    }
  }
  return { behavior: 'passthrough', message: '命令非空' }
}

function validateIncompleteCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  const trimmed = originalCommand.trim()

  if (/^\s*\t/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: '命令看起来是不完整的片段（以制表符开头）',
    }
  }

  if (trimmed.startsWith('-')) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: '命令看起来是不完整的片段（以标志开头）',
    }
  }

  if (/^\s*(&&|\|\||;|>>?|<)/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message: '命令看起来是延续行（以操作符开头）',
    }
  }

  return { behavior: 'passthrough', message: '命令看起来完整' }
}

/**
 * 检查命令是否为可绕过通用 $() 验证器的"安全"heredoc-in-substitution 模式。
 *
 * 这是一条"提前放行"路径：返回 `true` 会让 bashCommandIsSafe 返回
 * `passthrough`，从而跳过此后所有的验证器。鉴于这种权限级别，该检查
 * 必须是"可证明安全"，而非"可能安全"。
 *
 * 我们唯一允许的模式是：
 *   [前缀] $(cat <<'DELIM'\n
 *   [正文行]\n
 *   DELIM\n
 *   ) [后缀]
 *
 * 其中：
 * - 定界符必须带单引号（'DELIM'）或被转义（\DELIM），使正文成为逐字文本且无任何展开
 * - 闭合定界符必须独占一行（或仅带尾部空白 + `)`，用于 $(cat <<'EOF'\n...\nEOF) 内联形式）
 * - 闭合定界符必须是第一个这样的行——与 bash 的行为完全一致（不会跳过更早的
 *   定界符去找到 EOF））
 * - 在 $( 之前必须有非空白文本（即该替换处于参数位置，而非命令名位置）。
 *   否则 heredoc 正文会变成任意命令名，[后缀] 则成为其参数。
 * - 剩余文本（已剥离 heredoc）必须通过所有验证器
 *
 * 该实现采用基于"行"的匹配而非 [\s\S]*? 正则，以便精确复现 bash 的
 * heredoc 闭合行为。
 */
function isSafeHeredoc(command: string): boolean {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return false

  // 安全要点：<< 和定界符之间使用 [ \t]（而非 \s）。\s 会匹配换行，
  // 但 bash 要求定界符与 << 位于同一行。跨行匹配可能接受 bash 会拒绝的
  // 畸形语法。处理引号变体：'EOF'、''EOF''（splitCommand 可能会破坏引号）。
  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let match
  type HeredocMatch = {
    start: number
    operatorEnd: number
    delimiter: string
    isDash: boolean
  }
  const safeHeredocs: HeredocMatch[] = []

  while ((match = heredocPattern.exec(command)) !== null) {
    const delimiter = match[2] || match[3]
    if (delimiter) {
      safeHeredocs.push({
        start: match.index,
        operatorEnd: match.index + match[0].length,
        delimiter,
        isDash: match[1] === '-',
      })
    }
  }

  // 若没有找到安全 heredoc 模式，则不安全
  if (safeHeredocs.length === 0) return false

  // 安全要点：对每个 heredoc，使用基于"行"的匹配来精确定位闭合定界符，
  // 精确复现 bash 的行为。bash 会在第一个恰好等于定界符的行处闭合 heredoc。
  // 随后定界符的任何再次出现都只是内容（或一条新命令）。正则 [\s\S]*?
  // 可能跳过第一个定界符去匹配更靠后的 `DELIM)` 模式，从而在两个定界符
  // 之间隐藏被注入的命令。
  type VerifiedHeredoc = { start: number; end: number }
  const verified: VerifiedHeredoc[] = []

  for (const { start, operatorEnd, delimiter, isDash } of safeHeredocs) {
    // 起始行必须在定界符之后立即结束（换行前只允许水平空白）。若还有其他
    // 内容（如 `; rm -rf /`），这不是一个简单的安全 heredoc。
    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) return false // 完全没有内容
    const openLineTail = afterOperator.slice(0, openLineEnd)
    if (!/^[ \t]*$/.test(openLineTail)) return false // 起始行有额外内容

    // 正文从换行之后开始
    const bodyStart = operatorEnd + openLineEnd + 1
    const body = command.slice(bodyStart)
    const bodyLines = body.split('\n')

    // 找到闭合 heredoc 的第一个行。有两种合法形式：
    //   1. 某行单独只有 `DELIM`（bash 标准形式），下一行（其前只有空白）为 `)`
    //   2. 某行上是 `DELIM)`（内联 $(cat <<'EOF'\n...\nEOF) 形式，
    //      其中 bash 的 PST_EOFTOKEN 同时关闭 heredoc 和替换）
    // 对于 <<-，匹配前会先剥离开头的制表符。
    let closingLineIdx = -1
    let closeParenLineIdx = -1 // `)` 出现的行下标
    let closeParenColIdx = -1 // `)` 在该行中的列下标

    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine

      // 形式 1：定界符独占一行
      if (line === delimiter) {
        closingLineIdx = i
        // `)` 必须在下一行，且其前只有空白
        const nextLine = bodyLines[i + 1]
        if (nextLine === undefined) return false // 没有闭合 `)`
        const parenMatch = nextLine.match(/^([ \t]*)\)/)
        if (!parenMatch) return false // `)` 不在下一行行首
        closeParenLineIdx = i + 1
        closeParenColIdx = parenMatch[1]!.length // `)` 的位置
        break
      }

      // 形式 2：定界符后紧跟 `)`（PST_EOFTOKEN 形式）
      // 定界符与 `)` 之间只允许空白。
      if (line.startsWith(delimiter)) {
        const afterDelim = line.slice(delimiter.length)
        const parenMatch = afterDelim.match(/^([ \t]*)\)/)
        if (parenMatch) {
          closingLineIdx = i
          closeParenLineIdx = i
          // 列位置在 rawLine（去制表符之前）中计算，因此需重新计算
          const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? '') : ''
          closeParenColIdx =
            tabPrefix.length + delimiter.length + parenMatch[1]!.length
          break
        }
        // 行的开头是定界符但有其他尾部内容——
        // 这不是闭合行（bash 要求精确匹配或 EOF`）`）。
        // 但这也是一个危险信号：若在 $() 内部，bash 可能通过 PST_EOFTOKEN
        // 配合其他 shell 元字符提前闭合。
        // 这种情况已在 extractHeredocs 中处理——这里只是拒绝它不匹配我们的
        // 安全模式。
        if (/^[)}`|&;(<>]/.test(afterDelim)) {
          return false // 有歧义的提前闭合模式
        }
      }
    }

    if (closingLineIdx === -1) return false // 未找到闭合定界符

    // 计算绝对结束位置（`)` 字符之后的一个位置）
    let endPos = bodyStart
    for (let i = 0; i < closeParenLineIdx; i++) {
      endPos += bodyLines[i]!.length + 1 // +1 计入换行
    }
    endPos += closeParenColIdx + 1 // +1 把 `)` 本身也包含进来

    verified.push({ start, end: endPos })
  }

  // 安全要点：拒绝嵌套匹配。正则会在原始文本中查找 $(cat <<'X' 模式，
  // 而不理解带引号的 heredoc 语义。当外层 heredoc 使用带引号的定界符（<<'A'）时，
  // 在 bash 里它的正文是逐字文本——任何内层的 $(cat <<'B' 都只是字符，不是真正的
  // heredoc。但我们的正则两者都会匹配，产生"嵌套"区间。剥离嵌套区间会破坏下标：
  // 剥离内层区间后，外层区间的 `end` 已过期（指向收缩后字符串的更远处），导致
  // `remaining.slice(end)` 返回 ''，从而默默丢弃任何后缀（如 `; rm -rf /`）。
  // 由于我们匹配的所有 heredoc 都使用带引号/转义的定界符，正文内的嵌套匹配
  // 总是逐字文本——没有正常用户会写出这种模式。直接回到安全的回退路径。
  for (const outer of verified) {
    for (const inner of verified) {
      if (inner === outer) continue
      if (inner.start > outer.start && inner.start < outer.end) {
        return false
      }
    }
  }

  // 从命令中剥离所有已验证的 heredoc，构造 `remaining`。
  // 以逆序处理，使较早的下标保持有效。
  const sortedVerified = [...verified].sort((a, b) => b.start - a.start)
  let remaining = command
  for (const { start, end } of sortedVerified) {
    remaining = remaining.slice(0, start) + remaining.slice(end)
  }

  // 安全要点：若剥离后的 heredoc 位置之后有非空白内容，剩余文本不能仅以空白开头。
  // 如果 $() 处于命令名位置（无前缀），其输出就变成要执行的命令，任何后缀文本
  // 成为其参数：
  //   $(cat <<'EOF'\nchmod\nEOF\n) 777 /etc/shadow
  //   → 运行 `chmod 777 /etc/shadow`
  // 我们只允许替换出现在参数位置：$( 之前必须有一个命令词。
  // 剥离后，`remaining` 看起来应像 `cmd args... [more args]`。
  // 如果 remaining 仅以空白开头（或是空的），说明 $() 本身就是命令——
  // 只有在其后没有任何参数时才安全。
  const trimmedRemaining = remaining.trim()
  if (trimmedRemaining.length > 0) {
    // 有前缀命令——很好。但要验证原始命令在第一个 $( 之前也有非空白前缀
    //（heredoc 可能有多个；我们需要取第一个的前缀）。
    const firstHeredocStart = Math.min(...verified.map(v => v.start))
    const prefix = command.slice(0, firstHeredocStart)
    if (prefix.trim().length === 0) {
      // $() 处于命令名位置但后面还有文本——不安全。
      // heredoc 正文成为命令名，尾部文本成为其参数。
      return false
    }
  }

  // 检查剩余文本是否只含安全字符。
  // 剥离安全 heredoc 后，剩余文本应只含命令名、参数、引号和空白。拒绝任何
  // shell 元字符，以防操作符（|、&、&&、||、;）或展开（$、`、{、<、>）
  // 被用来在安全 heredoc 之后串联危险命令。
  // 安全要点：只使用显式的 ASCII 空格/制表符——\s 会匹配像 \u00A0 之类的
  // Unicode 空白，可用于隐藏内容。换行同样被阻止（它们会表明 heredoc 正文
  // 之外存在多行命令）。
  if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) return false

  // 安全要点：剩余文本（剥离 heredoc 后的命令）也必须通过所有安全验证器。
  // 否则，把一个安全 heredoc 追加到危险命令（例如 `zmodload zsh/system
  // $(cat <<'EOF'\nx\nEOF\n)`）后，此提前放行路径返回 passthrough，绕过
  // validateZshDangerousCommands、validateProcEnvironAccess 以及任何其他
  // 检查安全字符模式的主验证器。
  // 无递归风险：`remaining` 不含 `$(... <<` 模式，因此递归调用中的
  // validateSafeCommandSubstitution 会立即返回 passthrough。
  if (bashCommandIsSafe_DEPRECATED(remaining).behavior !== 'passthrough')
    return false

  return true
}

/**
 * 检测格式良好的 $(cat <<'DELIM'...DELIM) heredoc 替换模式。
 * 返回已剥离匹配 heredoc 的命令，若未找到则返回 null。
 * 预拆分阶段用它剥离安全 heredoc 并对剩余部分重新检查。
 */
export function stripSafeHeredocSubstitutions(command: string): string | null {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return null

  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let result = command
  let found = false
  let match
  const ranges: Array<{ start: number; end: number }> = []
  while ((match = heredocPattern.exec(command)) !== null) {
    if (match.index > 0 && command[match.index - 1] === '\\') continue
    const delimiter = match[2] || match[3]
    if (!delimiter) continue
    const isDash = match[1] === '-'
    const operatorEnd = match.index + match[0].length

    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) continue
    if (!/^[ \t]*$/.test(afterOperator.slice(0, openLineEnd))) continue

    const bodyStart = operatorEnd + openLineEnd + 1
    const bodyLines = command.slice(bodyStart).split('\n')
    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine
      if (line.startsWith(delimiter)) {
        const after = line.slice(delimiter.length)
        let closePos = -1
        if (/^[ \t]*\)/.test(after)) {
          const lineStart =
            bodyStart +
            bodyLines.slice(0, i).join('\n').length +
            (i > 0 ? 1 : 0)
          closePos = command.indexOf(')', lineStart)
        } else if (after === '') {
          const nextLine = bodyLines[i + 1]
          if (nextLine !== undefined && /^[ \t]*\)/.test(nextLine)) {
            const nextLineStart =
              bodyStart + bodyLines.slice(0, i + 1).join('\n').length + 1
            closePos = command.indexOf(')', nextLineStart)
          }
        }
        if (closePos !== -1) {
          ranges.push({ start: match.index, end: closePos + 1 })
          found = true
        }
        break
      }
    }
  }
  if (!found) return null
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!
    result = result.slice(0, r.start) + result.slice(r.end)
  }
  return result
}


function validateSafeCommandSubstitution(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  if (!HEREDOC_IN_SUBSTITUTION.test(originalCommand)) {
    return {
      behavior: 'passthrough',
      message: '替换中没有 heredoc',
    }
  }

  if (isSafeHeredoc(originalCommand)) {
    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason:
          '安全命令替换：cat 使用带引号/转义的 heredoc 定界符',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: '命令替换需要验证',
  }
}

function validateGitCommit(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'git' || !/^git\s+commit\s+/.test(originalCommand)) {
    return { behavior: 'passthrough', message: '不是 git commit' }
  }

  // 安全要点：反斜杠会导致我们的正则误判引号边界
  // （例如 `git commit -m "test\"msg" && evil`）。合法的提交信息几乎从不
  // 包含反斜杠，因此直接进入完整的验证器链。
  if (originalCommand.includes('\\')) {
    return {
      behavior: 'passthrough',
      message: 'git commit 包含反斜杠，需要完整验证',
    }
  }

  // 安全要点：`-m` 之前的 `.*?` 绝不能匹配 shell 操作符。此前 `.*?`
  // 匹配除 `\n` 外的任何字符，包括 `;`、`&`、`|`、`` ` ``、`$(`。
  // 对于 `git commit ; curl evil.com -m 'x'`，`.*?` 吞掉了 `; curl evil.com `，
  // 留下 remainder=``（为假 → 跳过 remainder 检查）→ 对复合命令返回 `allow`。
  // 提前放行会跳过所有主验证器（约第 1908 行），使 validateQuotedNewline、
  // validateBackslashEscapedOperators 等全部失去作用。
  // 尽管 splitCommand 目前会在下游拦截这种情况，但提前放行是一条"正向断言"，
  // 承诺整条命令是安全的——但事实并非如此。
  //
  // 另外：`git` 与 `commit` 之间的 `\s+` 绝不能匹配 `\n`/`\r`（bash 中的命令
  // 分隔符）。请使用只匹配水平空白的 `[ \t]+`。
  //
  // `[^;&|`$<>()\n\r]*?` 这个字符类排除了 shell 元字符。此处也排除了 `<` 和
  // `>`（重定向）——在 REMAINDER 中它们可用于 `--author="Name <email>"`，
  // 但绝不允许出现在 `-m` 之前。
  const messageMatch = originalCommand.match(
    /^git[ \t]+commit[ \t]+[^;&|`$<>()\n\r]*?-m[ \t]+(["'])([\s\S]*?)\1(.*)$/,
  )

  if (messageMatch) {
    const [, quote, messageContent, remainder] = messageMatch

    if (quote === '"' && messageContent && /\$\(|`|\$\{/.test(messageContent)) {
      logEvent('limkenion_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.GIT_COMMIT_SUBSTITUTION,
        subId: 1,
      })
      return {
        behavior: 'ask',
        message: 'git commit 信息包含命令替换模式',
      }
    }

    // 安全要点：检查 remainder 中可能串联命令或重定向输出的 shell 操作符。
    // 正则中 `-m` 之前的 `.*` 可能吞掉 `--amend` 等标志，把 `&& evil` 或
    // `> ~/.bashrc` 留在 remainder 中。此前我们只检查 $() / `` / ${}，
    // 漏掉了 ; | & && || < > 等操作符。
    //
    // `<` 和 `>` 可以合法地出现在 --author 值的引号内，如
    // `--author="Name <email>"`。未加引号的 `>` 才是 shell 重定向操作符。
    // 由于 validateGitCommit 是一个早期验证器，在这里返回 `allow` 会短路
    // bashCommandIsSafe 并跳过 validateRedirections。因此对于未加引号的 `<>`，
    // 我们必须回到 passthrough，让主验证器去处理。
    //
    // 攻击：`git commit --allow-empty -m 'payload' > ~/.bashrc`
    //   validateGitCommit 返回 allow → bashCommandIsSafe 短路 →
    //   validateRedirections 从不运行 → ~/.bashrc 被 git 的 stdout（含
    //   `payload`）覆盖 → 下次 shell 登录时 RCE。
    if (remainder && /[;|&()`]|\$\(|\$\{/.test(remainder)) {
      return {
        behavior: 'passthrough',
        message: 'git commit 的 remainder 包含 shell 元字符',
      }
    }
    if (remainder) {
      // 剥离带引号的内容，然后检查是否存在 `<` 或 `>`。带引号的 `<>`（--author
      // 中的邮箱尖括号）是安全的；未加引号的 `<>` 是 shell 重定向。
      // 注意：这个简单的引号跟踪器没有任何反斜杠处理。引号外的 `\'`/`\"`
      // 会让它失步（bash：\' = 字面 `'`，而跟踪器：切换 SQ）。但第 584 行已经
      // 对 originalCommand 中任何反斜杠做了放行，因此我们绝不会带着反斜杠走到这里。
      // 对于不含反斜杠的输入，简单的引号切换是正确的（在没有 \\ 的情况下法转义引号）。
      let unquoted = ''
      let inSQ = false
      let inDQ = false
      for (let i = 0; i < remainder.length; i++) {
        const c = remainder[i]
        if (c === "'" && !inDQ) {
          inSQ = !inSQ
          continue
        }
        if (c === '"' && !inSQ) {
          inDQ = !inDQ
          continue
        }
        if (!inSQ && !inDQ) unquoted += c
      }
      if (/[<>]/.test(unquoted)) {
        return {
          behavior: 'passthrough',
          message: 'git commit 的 remainder 包含未加引号的重定向操作符',
        }
      }
    }

    // 安全加固：阻止以连字符开头的消息
    // 这能捕获 `git commit -m "---"` 这类潜在的混淆模式
    if (messageContent && messageContent.startsWith('-')) {
      logEvent('limkenion_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
        subId: 5,
      })
      return {
        behavior: 'ask',
        message: '命令的标志名中包含带引号的字符',
      }
    }

    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason: '允许带简单带引号消息的 git commit',
      },
    }
  }

  return { behavior: 'passthrough', message: 'git commit 需要验证' }
}

function validateJqCommand(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'jq') {
    return { behavior: 'passthrough', message: '不是 jq' }
  }

  if (/\bsystem\s*\(/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_SYSTEM_FUNCTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'jq 命令包含 system() 函数，它会执行任意命令',
    }
  }

  // 文件参数现在被允许——它们会在 readOnlyValidation.ts 中由路径验证校验
  // 只阻止可能把文件读入 jq 变量的危险标志
  const afterJq = originalCommand.substring(3).trim()
  if (
    /(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(
      afterJq,
    )
  ) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_FILE_ARGUMENTS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'jq 命令包含可能执行代码或读取任意文件的危险标志',
    }
  }

  return { behavior: 'passthrough', message: 'jq 命令安全' }
}

function validateShellMetacharacters(
  context: ValidationContext,
): PermissionResult {
  const { unquotedContent } = context
  const message =
    '命令的参数中包含 shell 元字符（;、| 或 &）'

  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(unquotedContent)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 1,
    })
    return { behavior: 'ask', message }
  }

  const globPatterns = [
    /-name\s+["'][^"']*[;|&][^"']*["']/,
    /-path\s+["'][^"']*[;|&][^"']*["']/,
    /-iname\s+["'][^"']*[;|&][^"']*["']/,
  ]

  if (globPatterns.some(p => p.test(unquotedContent))) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 2,
    })
    return { behavior: 'ask', message }
  }

  if (/-regex\s+["'][^"']*[;&][^"']*["']/.test(unquotedContent)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 3,
    })
    return { behavior: 'ask', message }
  }

  return { behavior: 'passthrough', message: '没有元字符' }
}

function validateDangerousVariables(
  context: ValidationContext,
): PermissionResult {
  const { fullyUnquotedContent } = context

  if (
    /[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
    /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
  ) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_VARIABLES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        '命令在危险上下文中使用了变量（重定向或管道）',
    }
  }

  return { behavior: 'passthrough', message: '没有危险变量' }
}

function validateDangerousPatterns(
  context: ValidationContext,
): PermissionResult {
  const { unquotedContent } = context

  // 对反引号特殊处理——只检查"未转义"的反引号
  // 已转义的反引号（例如 \`）是安全的，且常用于 SQL 命令
  if (hasUnescapedChar(unquotedContent, '`')) {
    return {
      behavior: 'ask',
      message: '命令包含用于命令替换的反引号（`）',
    }
  }

  // 其他命令替换检查（包含双引号内的内容）
  for (const { pattern, message } of COMMAND_SUBSTITUTION_PATTERNS) {
    if (pattern.test(unquotedContent)) {
      logEvent('limkenion_bash_security_check_triggered', {
        checkId:
          BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION,
        subId: 1,
      })
      return { behavior: 'ask', message: `命令包含 ${message}` }
    }
  }

  return { behavior: 'passthrough', message: '没有危险模式' }
}

function validateRedirections(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context

  if (/</.test(fullyUnquotedContent)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_INPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含输入重定向（<），可能读取敏感文件',
    }
  }

  if (/>/.test(fullyUnquotedContent)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_OUTPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含输出重定向（>），可能写入任意文件',
    }
  }

  return { behavior: 'passthrough', message: '没有重定向' }
}

function validateNewlines(context: ValidationContext): PermissionResult {
  // 使用 fullyUnquotedPreStrip（在 stripSafeRedirections 之前），以防止剥离
  // `>/dev/null` 产生幻影反斜杠-换行延续的绕过。
  // 例如 `cmd \>/dev/null\nwhoami` → 剥离后变成 `cmd \\nwhoami`，
  // 看起来是安全的延续，实际上隐藏了第二条命令。
  const { fullyUnquotedPreStrip } = context

  // 检查未加引号的内容中是否有换行
  if (!/[\n\r]/.test(fullyUnquotedPreStrip)) {
    return { behavior: 'passthrough', message: '没有换行' }
  }

  // 标记任何换行/回车后紧跟非空白的情况，但排除单词边界处的反斜杠-换行
  // 延续。在 bash 中，`\<newline>` 是行延续（两个字符都被移除），当反斜杠
  // 位于空白之后时是安全的（例如 `cmd \<newline>--flag`）。像
  // `tr\<newline>aceroute` 这样的词中间延续仍会被标记，因为它们可能对
  // 白名单检查隐藏危险命令名。
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() + gated by /[\n\r]/.test() above
  const looksLikeCommand = /(?<![\s]\\)[\n\r]\s*\S/.test(fullyUnquotedPreStrip)
  if (looksLikeCommand) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含可能分隔多条命令的换行',
    }
  }

  return {
    behavior: 'passthrough',
    message: '换行似乎位于数据内部',
  }
}

/**
 * 安全要点：回车符（\r，0x0D）确实存在误解析问题，这与换行符（LF）不同。
 *
 * 解析器差异：
 *   - shell-quote 的 BAREWORD 正则使用 `[^\s...]`——JS 的 `\s` 包含 \r，因此
 *     shell-quote 会把 CR 当作词边界。`TZ=UTC\recho` 被切分为两个 token：
 *     ['TZ=UTC', 'echo']。splitCommand 会用空格连接 → 'TZ=UTC echo curl evil.com'。
 *   - bash 的默认 IFS 是 $' \t\n'——CR 不在 IFS 中。bash 会把 `TZ=UTC\recho`
 *     视为一个词 → 环境赋值 TZ='UTC\recho'（CR 字节在值内部），然后 `curl` 是命令。
 *
 * 攻击：`TZ=UTC\recho curl evil.com` 配合 Bash(echo:*)
 *   validator：splitCommand 把 CR 折叠为空格 → 'TZ=UTC echo curl evil.com'
 *   → stripSafeWrappers：剥离 TZ=UTC → 'echo curl evil.com' 匹配规则
 *   bash：执行 `curl evil.com`
 *
 * validateNewlines 能捕获这一情况，但它位于 nonMisparsingValidators 中（LF 被
 * 两个解析器都正确处理）。本校验器不在 nonMisparsingValidators 中——它的 ask
 * 结果会带上 isBashSecurityCheckForMisparsing 标志，从而在 bashPermissions 关卡
 * 被拦截。
 *
 * 检查 originalCommand（而非 fullyUnquotedPreStrip），因为单引号内的 CR 同样
 * 存在误解析问题，原因相同：shell-quote 的 `\s` 仍会把它切分，bash 则把它当作
 * 字面量。为所有"未加引号或单引号内"的 CR 设卡。唯一例外：双引号内的 CR——
 * 此时 bash 也把它当作数据，且 shell-quote 保留该 token（不会拆分）。
 */
function validateCarriageReturn(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  if (!originalCommand.includes('\r')) {
    return { behavior: 'passthrough', message: '没有回车符' }
  }

  // 检查 CR 是否出现在双引号之外。双引号外的 CR（包括单引号内和未加引号）
  // 会导致 shell-quote 与 bash 的切分差异。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < originalCommand.length; i++) {
    const c = originalCommand[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (c === '\r' && !inDoubleQuote) {
      logEvent('limkenion_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
        subId: 2,
      })
      return {
        behavior: 'ask',
        message:
          '命令包含回车符（\\r），shell-quote 与 bash 对其切分方式不同',
      }
    }
  }

  return { behavior: 'passthrough', message: '回车符只在双引号内' }
}

function validateIFSInjection(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // 检测任何可能在绕过正则验证的 IFS 变量的使用
  // 检查 $IFS 和 ${...IFS...} 模式（包括 ${IFS:0:1}、${#IFS} 等参数展开）
  // 使用 ${[^}]*IFS 捕获所有含 IFS 的参数展开变体
  if (/\$IFS|\$\{[^}]*IFS/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.IFS_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含可能绕过安全验证的 IFS 变量使用',
    }
  }

  return { behavior: 'passthrough', message: '未检测到 IFS 注入' }
}

// 额外加固，防止通过 /proc 文件系统读取环境变量。
// 路径验证通常会阻止 /proc 访问，但这里提供纵深防御。
// /proc 中的环境文件可能暴露 API 密钥和机密等敏感数据。
function validateProcEnvironAccess(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // 检查可能暴露环境变量的 /proc 路径
  // 这能捕获如下模式：
  // - /proc/self/environ
  // - /proc/1/environ
  // - /proc/*/environ（任意 PID）
  if (/\/proc\/.*\/environ/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.PROC_ENVIRON_ACCESS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        '命令访问 /proc/*/environ，可能暴露敏感的环境变量',
    }
  }

  return {
    behavior: 'passthrough',
    message: '未检测到 /proc/environ 访问',
  }
}

/**
 * 检测带有畸形 token（不配对的定界符）以及命令分隔符的命令。这能捕获潜在
 * 的注入模式，即利用有歧义的 shell 语法进行攻击。
 *
 * 安全：此检查可捕获 HackerOne 审查中发现的 eval 绕过。
 * 当 shell-quote 解析像 `echo {"hi":"hi;evil"}` 这样有歧义的模式时，
 * 可能产生不配对的 token（例如 `{hi:"hi`）。结合命令分隔符，这可能导致
 * 通过 eval 重新解析而造成的意外命令执行。
 *
 * 通过强制这些模式需要用户批准，我们确保用户在被批准之前确切看到
 * 将要执行的内容。
 */
function validateMalformedTokenInjection(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  const parseResult = tryParseShellCommand(originalCommand)
  if (!parseResult.success) {
    // 解析失败——这已在其他地方处理（bashToolHasPermission 会检查这一点）
    return {
      behavior: 'passthrough',
      message: '解析失败，已在别处处理',
    }
  }

  const parsed = parseResult.tokens

  // 检查命令分隔符（;、&&、||）
  const hasCommandSeparator = parsed.some(
    entry =>
      typeof entry === 'object' &&
      entry !== null &&
      'op' in entry &&
      (entry.op === ';' || entry.op === '&&' || entry.op === '||'),
  )

  if (!hasCommandSeparator) {
    return { behavior: 'passthrough', message: '没有命令分隔符' }
  }

  // 检查畸形 token（不配对的定界符）
  if (hasMalformedTokens(originalCommand, parsed)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MALFORMED_TOKEN_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含可能被误解的带命令分隔符的歧义语法',
    }
  }

  return {
    behavior: 'passthrough',
    message: '未检测到畸形 token 注入',
  }
}

function validateObfuscatedFlags(context: ValidationContext): PermissionResult {
  // 阻止利用 shell 引号绕过我们正则中负向前瞻的引号绕过模式，这些负向前瞻用于拦截已知危险标志

  const { originalCommand, baseCommand } = context

  // echo 对于混淆标志是安全的，但只适用于简单的 echo 命令。
  // 对于复合命令（含 |、&、;），需要检查整条命令，
  // 因为危险的 ANSI-C 引号可能出现在操作符之后。
  const hasShellOperators = /[|&;]/.test(originalCommand)
  if (baseCommand === 'echo' && !hasShellOperators) {
    return {
      behavior: 'passthrough',
      message: 'echo 命令安全且没有危险标志',
    }
  }

  // 全面的混淆检测
  // 这些检查能捕获使用 shell 引号隐藏标志的各种方式

  // 1. 阻止 ANSI-C 引号（$'...'）——可通过转义序列编码任意字符
  // 简单的模式，匹配任意位置的 $'...'。这能正确处理：
  // - grep '$' file => 不匹配（引号内的 $ 是正则锚点，不是 $'...' 结构）
  // - 'test'$'-exec' => 匹配（ANSI-C 引号与引号串联）
  // - 零宽空格等不可见字符 => 匹配
  // 该模式要求 $' 后跟内容（可以为空）再跟闭合的 '
  if (/\$'[^']*'/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 5,
    })
    return {
      behavior: 'ask',
      message: '命令包含可隐藏字符的 ANSI-C 引号',
    }
  }

  // 2. 阻止 locale 引号（$"..."）——同样可以使用转义序列
  // 与上面的 ANSI-C 引号使用相同的简单模式
  if (/\$"[^"]*"/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 6,
    })
    return {
      behavior: 'ask',
      message: '命令包含可隐藏字符的 locale 引号',
    }
  }

  // 3. 阻止空 ANSI-C 或 locale 引号后跟连字符
  // $''-exec 或 $""-exec
  if (/\$['"]{2}\s*-/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 9,
    })
    return {
      behavior: 'ask',
      message:
        '命令在连字符前包含空的特殊引号（潜在的绕过）',
    }
  }

  // 4. 阻止任意空引号序列后跟连字符
  // 这能捕获：''-  ""-  ''""-  ""''-  ''""''-  等等
  // 该模式查找一个或多个空引号对，后跟可选的空白和连字符
  if (/(?:^|\s)(?:''|"")+\s*-/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 7,
    })
    return {
      behavior: 'ask',
      message: '命令在连字符前包含空引号（潜在的绕过）',
    }
  }

  // 4b. 安全要点：阻止紧接着带引号连字符的同质空引号对。
  // 像 `"""-f"`（空 `""` + 带引号的 `"-f"`）这样的模式在 bash 中串联成
  // `-f`，但会从上述所有检查中溜走：
  //   - 上面的正则 (4)：`(?:''|"")+\s*-` 匹配 `""` 对，然后期望可选空格
  //     和连字符——但遇到的是第三个 `"`。不匹配。
  //   - 引号内容扫描器（下方）：看到第一个内容为空的 `""` 对（不以连字符
  //     开头）。第三个 `"` 打开一个新的带引号区域，由主引号状态跟踪器处理。
  //   - 引号状态跟踪器：`""` 来回切换 inDoubleQuote；第三个 `"`
  //     再次打开它。`"-f"` 内的 `-` 位于引号内 → 被跳过。
  //   - 标志扫描器：寻找 `-` 前的 `\s`。而 `-` 前是 `"`。
  //   - fullyUnquotedContent：`""` 和 `"-f"` 都被剥离。
  //
  // 在 bash 中，`"""-f"` = 空字符串 + 字符串 "-f" = `-f`。这种绕过对任何
  // 危险标志检查（jq -f、find -exec、fc -e）都有效，只要其带有匹配的前缀
  // 权限（Bash(jq:*)、Bash(find:*)）。
  //
  // 正则 `(?:""|'')+['"]-` 匹配：
  //   - 一个或多个同质的空对（`""` 或 `''`）——bash 将空字符串与标志连接的
  //     连接点。
  //   - 紧跟着的任意引号字符——打开带引号的标志区域。
  //   - 紧跟着的 `-`——即被混淆的标志。
  //
  // 位置无关：我们不要求词首（`(?:^|\s)`），因为像 `$x"""-f"`（未设置/为空的
  // 变量）这样的前缀会以同样的方式串联。同质空对的要求过滤掉了 `'"'"'` 惯用法
  // （没有同质空对——它是"闭合、双引号内容、开启"）。
  //
  // 误报：会匹配 `echo '"""-f" text'`（单引号字符串内的模式）。
  // 极其罕见（需要原样回显攻击字面量）。可以接受。
  if (/(?:""|'')+['"]-/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 10,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含与带引号连字符相邻的空引号对（潜在的标志混淆）',
    }
  }

  // 4c. 安全要点：即使没有紧跟连字符，也阻止词首出现的 3+ 个连续引号。
  // 这是针对上面未枚举的多引号混淆模式的更广泛安全网
  // （例如 `"""x"-f`，其中引号之间的内容移动了连字符的位置）。
  // 当 `"x"` 已经可用时，合法命令绝不会需要 `"""x"`。
  if (/(?:^|\s)['"]{3,}/.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 11,
    })
    return {
      behavior: 'ask',
      message:
        '命令在词首包含连续引号字符（潜在的混淆）',
    }
  }

  // 跟踪引号状态，避免对带引号字符串内的标志产生误报
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length - 1; i++) {
    const currentChar = originalCommand[i]
    const nextChar = originalCommand[i + 1]

    // 更新引号状态
    if (escaped) {
      escaped = false
      continue
    }

    // 安全要点：只把单引号外的反斜杠当作转义符。在 bash 中，`'...'` 内的
    // `\` 是字面量。没有此保护，`'\'` 会让引号跟踪器失步：`\` 设置
    // escaped=true，闭合的 `'` 被上面的 escaped-skip 消耗掉，而不是切换
    // inSingleQuote。解析器保持在单引号模式，而第 ~1121 行的
    // `if (inSingleQuote || inDoubleQuote) continue` 会跳过命令其余部分的所有
    // 标志检测。例如：`jq '\' "-f" evil`——bash 拿到 `-f` 参数，但失步的
    // 解析器认为 ` "-f" evil` 在引号内 → 标志检测被绕过。
    // 纵深防御：hasShellQuoteSingleQuoteBug 会在本代码约第 ~1856 行之前捕获
    // `'\'` 模式。但为与本文件其它地方的正确实现（hasBackslashEscaped*、
    // extractQuotedContent，都用 `!inSingleQuote` 保护）保持一致，我们仍修复
    // 跟踪器。
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 仅当不在带引号字符串内部时才查找标志
    // 这能防止像 make test TEST="file.py -v" 这样的误报
    if (inSingleQuote || inDoubleQuote) {
      continue
    }

    // 查找后跟含连引号的引号（潜在的标志混淆）的空白
    // 安全要点：阻止任何以连字符开头的带引号内容——宁可误伤也要求安全
    // 捕获："-"exec、"-file"、"--flag"、'-'output 等等
    // 若是合法情况（如 find . -name "-file"），用户可手动批准
    if (
      currentChar &&
      nextChar &&
      /\s/.test(currentChar) &&
      /['"`]/.test(nextChar)
    ) {
      const quoteChar = nextChar
      let j = i + 2 // 从开始引号之后的位置开始
      let insideQuote = ''

      // 收集引号内的内容
      while (j < originalCommand.length && originalCommand[j] !== quoteChar) {
        insideQuote += originalCommand[j]!
        j++
      }

      // 若找到闭合引号且内容看起来像混淆的标志，则阻止它。
      // 要捕获的三种攻击模式：
      //   1. 引号内的标志名："--flag"、"-exec"、"-X"（内部有连字符 + 字母）
      //   2. 拆引号标志："-"exec、"--"output（内部有连字符，引号后跟字母继续）
      //   3. 链式引号："-""exec"（第一个引号有连字符，第二个引号含字母）
      // 纯粹由连字符组成的字符串（如 "---" 或 "--" 后跟空白/分隔符）是分隔符，
      // 不是标志，不应触发此检查。
      const charAfterQuote = originalCommand[j + 1]
      // 在双引号内，$VAR 和 `cmd` 会在运行时展开，因此 "-$VAR" 可能变成 -exec。
      // 在这里阻止 $ 和 ` 会过度阻止单引号字面量（如 grep '-$'，其中 $ 是
      // 字面量），但主检查的 startsWith('-') 已经阻止了它们——这只是恢复
      // 原状，并非新的误报。
      // 花括号展开（{）不会在引号内发生，因此这里不需要 {。
      const hasFlagCharsInside = /^-+[a-zA-Z0-9$`]/.test(insideQuote)
      // 可在闭合引号后延续标志的字符。这能捕获：
      //   a-zA-Z0-9: "-"exec → -exec（直接串联）
      //   \\:        "-"\exec → -exec（反斜杠转义被剥离）
      //   -:         "-"-output → --output（额外的连字符）
      //   {:         "-"{exec,delete} → -exec -delete（花括号展开）
      //   $:         "-"$VAR → 当 VAR=exec 时 → -exec（变量展开）
      //   `:         "-"`echo exec` → -exec（命令替换）
      // 注意：glob 字符（*?[）被省略——它们需要 CWD 中受攻击者控制的文件名
      // 才能利用，并且阻止它们会破坏像 `ls -- "-"*` 这样列出连字符开头文件
      // 的模式。
      const FLAG_CONTINUATION_CHARS = /[a-zA-Z0-9\\${`-]/
      const hasFlagCharsContinuing =
        /^-+$/.test(insideQuote) &&
        charAfterQuote !== undefined &&
        FLAG_CONTINUATION_CHARS.test(charAfterQuote)
      // 处理相邻引号链式连接："-""exec"、"-""-"exec 或 """-"exec 在 shell 中
      // 连接成 -exec。沿相邻带引号段的链条查找，直到找到含字母数字字符的段
      // 或遇到非引号边界。
      // 也处理空前缀引号："""-"exec，其中 "" 后跟 "-"exec。
      // 若组合段含连字符后跟字母数字，则构成标志。
      const hasFlagCharsInNextQuote =
        // 触发条件：第一段只含连字符或为空（可能是标志的前缀）
        (insideQuote === '' || /^-+$/.test(insideQuote)) &&
        charAfterQuote !== undefined &&
        /['"`]/.test(charAfterQuote) &&
        (() => {
          let pos = j + 1 // 从 charAfterQuote（一个起始引号）开始
          let combinedContent = insideQuote // 跟踪 shell 将看到的内容
          while (
            pos < originalCommand.length &&
            /['"`]/.test(originalCommand[pos]!)
          ) {
            const segQuote = originalCommand[pos]!
            let end = pos + 1
            while (
              end < originalCommand.length &&
              originalCommand[end] !== segQuote
            ) {
              end++
            }
            const segment = originalCommand.slice(pos + 1, end)
            combinedContent += segment

            // 检查到目前为止的组合内容是否构成标志模式。
            // 把 $ 和 ` 纳入引号内展开："-""$VAR" → -exec
            if (/^-+[a-zA-Z0-9$`]/.test(combinedContent)) return true

            // 若该段含字母数字/展开且我们已经有了连字符，则它是标志。
            // 捕获 "-""$*"，其中 segment='$*' 没有字母数字，但在运行时展开为
            // 位置参数。
            // 防止 segment.length === 0 的情况：slice(0, -0) → slice(0, 0) → ''。
            const priorContent =
              segment.length > 0
                ? combinedContent.slice(0, -segment.length)
                : combinedContent
            if (/^-+$/.test(priorContent)) {
              if (/[a-zA-Z0-9$`]/.test(segment)) return true
            }

            if (end >= originalCommand.length) break // 未闭合的引号
            pos = end + 1 // 越过闭合引号，检查下一个段
          }
          // 也检查链条末尾的未加引号字符
          if (
            pos < originalCommand.length &&
            FLAG_CONTINUATION_CHARS.test(originalCommand[pos]!)
          ) {
            // 若组合内容中有连字符，则尾部字符完成一个标志
            if (/^-+$/.test(combinedContent) || combinedContent === '') {
              // 检查是否要用后续内容构成标志
              const nextChar = originalCommand[pos]!
              if (nextChar === '-') {
                // 更多连字符，仍可能构成标志
                return true
              }
              if (/[a-zA-Z0-9\\${`]/.test(nextChar) && combinedContent !== '') {
                // 我们有连字符，现在后面是字母数字/展开
                return true
              }
            }
            // 原有的"连字符后跟字母数字"检查
            if (/^-/.test(combinedContent)) {
              return true
            }
          }
          return false
        })()
      if (
        j < originalCommand.length &&
        originalCommand[j] === quoteChar &&
        (hasFlagCharsInside ||
          hasFlagCharsContinuing ||
          hasFlagCharsInNextQuote)
      ) {
        logEvent('limkenion_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
          subId: 4,
        })
        return {
          behavior: 'ask',
          message: '命令的标志名中包含带引号的字符',
        }
      }
    }

    // 查找后跟连字符的空白——这会开始一个标志
    if (currentChar && nextChar && /\s/.test(currentChar) && nextChar === '-') {
      let j = i + 1 // 从连字符开始
      let flagContent = ''

      // 收集标志内容
      while (j < originalCommand.length) {
        const flagChar = originalCommand[j]
        if (!flagChar) break

        // 一旦遇到空白或等号就结束标志内容
        if (/[\s=]/.test(flagChar)) {
          break
        }
        // 若遇到后跟非标志字符的引号则结束标志收集。这是为了处理像 -d"," 这样
        // 应解析为仅 -d 的情况
        if (/['"`]/.test(flagChar)) {
          // cut -d 标志的特殊情况：定界符值可以被引号包裹
          // 示例：cut -d'"' 应解析为标志名：-d，值：'"'
          // 注意：此特例仅用于 cut -d，以避免出现绕过。
          // 若不加此限制，像 `find -e"xec"` 这样的命令会被解析为标志名 -e，
          // 绕过我们对 -exec 的黑名单。通过限定于 cut -d，
          // 我们既允许合法的使用场景，又防止了在带引号的标志值可能隐藏危险
          // 标志名的其他命令上的混淆攻击。
          if (
            baseCommand === 'cut' &&
            flagContent === '-d' &&
            /['"`]/.test(flagChar)
          ) {
            // 这是 cut -d 后跟带引号的定界符——flagContent 已经是 '-d'
            break
          }

          // 前瞻查看引号后是什么
          if (j + 1 < originalCommand.length) {
            const nextFlagChar = originalCommand[j + 1]
            if (nextFlagChar && !/[a-zA-Z0-9_'"-]/.test(nextFlagChar)) {
              // 引号后跟着明显不属于标志的内容，结束解析
              break
            }
          }
        }
        flagContent += flagChar
        j++
      }

      if (flagContent.includes('"') || flagContent.includes("'")) {
        logEvent('limkenion_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
          subId: 1,
        })
        return {
          behavior: 'ask',
          message: '命令的标志名中包含带引号的字符',
        }
      }
    }
  }

  // 也处理以引号开头的标志："--"output、'-'-output 等。
  // 使用 fullyUnquotedContent 以避免像 echo "---" 这样合法带引号内容的误报
  if (/\s['"`]-/.test(context.fullyUnquotedContent)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: '命令的标志名中包含带引号的字符',
    }
  }

  // 也处理像 ""--output 这样的案例
  // 使用 fullyUnquotedContent 以避免合法带引号内容的误报
  if (/['"`]{2}-/.test(context.fullyUnquotedContent)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message: '命令的标志名中包含带引号的字符',
    }
  }

  return { behavior: 'passthrough', message: '未检测到混淆标志' }
}

/**
 * 检测引号之外的反斜杠转义空白字符（空格、制表符）。
 *
 * 在 bash 中，`echo\ test` 是一个单独 token（名为 "echo test" 的命令），但
 * shell-quote 会把转义解码出来并产生 `echo test`（两个独立 token）。这种差异
 * 允许路径穿越攻击，例如：
 *   echo\ test/../../../usr/bin/touch /tmp/file
 * 解析器把它看成 `echo test/.../touch /tmp/file`（一条 echo 命令），但 bash
 * 解析为 `/usr/bin/touch /tmp/file`（通过 "echo test" 这个目录）。
 */
function hasBackslashEscapedWhitespace(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar === ' ' || nextChar === '\t') {
          return true
        }
      }
      // 跳过被转义的字符（在引号外和双引号内都是如此，
      // 其中 \\、\"、\$、\` 是合法的转义序列）
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
  }

  return false
}

function validateBackslashEscapedWhitespace(
  context: ValidationContext,
): PermissionResult {
  if (hasBackslashEscapedWhitespace(context.originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含可能改变命令解析方式的反斜杠转义空白',
    }
  }

  return {
    behavior: 'passthrough',
    message: '没有反斜杠转义空白',
  }
}

/**
 * 检测引号外、shell 操作符前紧邻的反斜杠。
 *
 * 安全要点：splitCommand 会把 `\;` 规范化成其输出字符串中的裸 `;`。当下游代码
 * （checkReadOnlyConstraints、checkPathConstraints 等）重新解析那段规范化后的
 * 字符串时，裸 `;` 被视为一个操作符并导致错误的拆分。这会在绕过路径检查时
 * 实现任意文件读取：
 *
 *   cat safe.txt \; echo ~/.ssh/id_rsa
 *
 * 在 bash 中：一条解析 safe.txt 的 cat 命令、;、echo、把 ~/.ssh/id_rsa 当文件。
 * 经 splitCommand 规范化后："cat safe.txt ; echo ~/.ssh/id_rsa"
 * 嵌套重新解析：["cat safe.txt", "echo ~/.ssh/id_rsa"]——两个段都通过了
 * isCommandReadOnly，隐藏在 echo 段中的敏感路径从未被路径约束校验。被自动允许。
 * 私钥泄露。
 *
 * 此检查标记任何 \<操作符>，而不论反斜杠的奇偶性。偶数个（\\;）在 bash 中也
 * 是危险的（\\ → \，; 分隔命令）。奇数个（\;）在 bash 中安全，但会触发上面的
 * 双重解析 bug。两者都必须被标记。
 *
 * 已知误报：`find . -exec cmd {} \;` —— 用户会被提示一次。
 *
 * 注意：`(` 和 `)` 不在这个集合中——splitCommand 在其输出中保留 `\(` 和 `\)`
 *（往返安全），因此它们不会触发双重解析 bug。这让 `find . \( -name x -o -name
 * y \)` 无需误报即可通过。
 */
const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])

function hasBackslashEscapedOperator(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    // 安全要点：先处理反斜杠，再处理引号切换。在 bash 中，双引号内的 `\"`
    // 是产生字面 `"` 的转义序列——它不会闭合引号。如果我们先处理引号切换，
    // `"..."` 内的 `\"` 会使跟踪器失步：
    //   - `\` 被忽略（受 !inDoubleQuote 门控）
    //   - `"` 把 inDoubleQuote 切换到 FALSE（错误——bash 说仍在引号内）
    //   - 下一个 `"`（真正的闭合引号）切回 TRUE——永久失步
    //   - 后面的 `\;` 因 !inDoubleQuote 为 false 而被漏掉
    // 攻击：`tac "x\"y" \; echo ~/.ssh/id_rsa` —— bash 只运行一条把全部参数
    // 当文件读取的 tac（泄露 id_rsa），但失步的跟踪器漏掉 `\;`，splitCommand
    // 的双重解析规范化"看到"两条安全命令。
    //
    // 修复结构与 hasBackslashEscapedWhitespace 一致（它在 d000dfe84e 之前的
    // 提交中已被正确修复）：先做反斜杠检查，仅受 !inSingleQuote 门控（因为
    // 反斜杠在 '...' 内确实是字面量），无条件 i++ 跳过即使在双引号内也
    // 被转义的字符。
    if (char === '\\' && !inSingleQuote) {
      // 仅在双引号外标记 \<操作符>（在双引号内，像 ;|&<> 这样的操作符本来
      // 就不特殊，因此 \; 在那里是无害的）。
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return true
        }
      }
      // 无条件跳过被转义的字符。在双引号内，这会正确消耗反斜杠对：
      // `"x\\"` → 位置 6（`\`）跳过位置 7（`\`），然后位置 8（`"`）正确地把
      // inDoubleQuote 关掉。若无条件跳过，位置 7 会看到 `\`，把位置 8（`"`）
      // 视作 nextChar 并跳过它，那么闭合引号永远不会切换 inDoubleQuote——
      // 从而永久失步并漏掉引号外的后续 `\;`。
      // 攻击：`cat "x\\" \; echo /etc/passwd` —— bash 读取 /etc/passwd。
      //
      // 这能正确处理反斜杠奇偶性：奇数个 `\;`（1、3、5...）会被标记（`;` 前
      // 未配对的 `\` 被检测到）。偶数个 `\\;`（2、4...）不会被标记，这是正确的
      // ——bash 把 `\\` 当作字面 `\`，把 `;` 当作分隔符，因此 splitCommand 会
      // 正常处理它（没有双重解析 bug）。这与 hasBackslashEscapedWhitespace
      // 的第 ~1340 行一致。
      i++
      continue
    }

    // 引号切换在反斜杠处理之后（反斜杠已经跳过了任何被转义的引号字符，
    // 因此这些切换只会在未转义的引号上触发）。
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
  }

  return false
}

function validateBackslashEscapedOperators(
  context: ValidationContext,
): PermissionResult {
  // Tree-sitter 路径：如果 tree-sitter 确认 AST 中没有实际的操作符节点，
  // 那么任何 \; 都只是词参数中的一个被转义字符（例如 `find . -exec cmd {} \;`）。
  // 跳过代价高昂的正则检查。
  if (context.treeSitter && !context.treeSitter.hasActualOperatorNodes) {
    return { behavior: 'passthrough', message: 'AST 中没有操作符节点' }
  }

  if (hasBackslashEscapedOperator(context.originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_OPERATORS,
    })
    return {
      behavior: 'ask',
      message:
        '命令在 shell 操作符（;、|、&、<、>）前包含反斜杠，可能隐藏命令结构',
    }
  }

  return {
    behavior: 'passthrough',
    message: '没有反斜杠转义的操作符',
  }
}

/**
 * 通过统计 `content` 中位置 `pos` 之前的连续反斜杠数，判断该位置的字符是否被
 * 转义。奇数个表示它被转义。
 */
function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

/**
 * 检测 Bash 会展开、而 shell-quote/tree-sitter 视为字面量的未加引号花括号展开
 * 语法。这种解析差异允许权限绕过：
 *   git ls-remote {--upload-pack="touch /tmp/test",test}
 * 解析器看到一个字面参数，但 Bash 展开为：--upload-pack="touch /tmp/test" test
 *
 * 花括号展开有两种形式：
 *   1. 逗号分隔：{a,b,c} → a b c
 *   2. 序列：{1..5} → 1 2 3 4 5
 *
 * Bash 中单引号和双引号都会抑制花括号展开，因此我们使用把两类引号都剥离掉的
 * fullyUnquotedContent。反斜杠转义的花括号（\{、\}）也会抑制展开。
 */
function validateBraceExpansion(context: ValidationContext): PermissionResult {
  // 使用剥离前的内容，避免 stripSafeRedirections 生成反斜杠相邻而产生的误判
  //（例如 `\>/dev/null{a,b}` 剥离后变成 `\{a,b}`，使 isEscapedAtPosition 认为
  // 花括号被转义）。
  const content = context.fullyUnquotedPreStrip

  // 安全要点：检查 fullyUnquoted 内容中的花括号数量是否不匹配。
  // 不匹配表示带引号的花括号（例如 `'{'` 或 `"{"`）被 extractQuotedContent
  // 剥离掉了，在我们分析的内容中留下不平衡的花括号。下面的深度匹配算法假设
  // 花括号是平衡的——一旦不匹配，它会在"错误"的位置闭合，从而漏掉 bash
  // 算法本会找到的逗号。
  //
  // 攻击：`git diff {@'{'0},--output=/tmp/pwned}`
  //   - 原始串：2 个 `{`、2 个 `}`（带引号的 `'{'` 算内容，不算操作符）
  //   - fullyUnquoted：`git diff {@0},--output=/tmp/pwned}`——变成 1 个 `{`、2 个 `}`！
  //   - 我们的深度匹配：在第一个 `}`（在 `0` 之后）闭合，inner=`@0`，没有 `,`
  //   - Bash（在原始串上）：带引号的 `{` 是内容；第一个未加引号的 `}` 处还没有
  //     `,` → bash 把它当字面内容，继续扫描 → 找到 `,`
  //     → 最终 `}` 闭合 → 展开为 `@{0} --output=/tmp/pwned`
  //   - git 把 diff 写入 /tmp/pwned。任意文件写入，零权限。
  //
  // 我们只统计未转义的花括号（反斜杠转义的花括号在 bash 中是字面量）。如果
  // 数量不匹配且至少存在一个未转义的 `{`，就阻止——此时我们的深度匹配在这个
  // 内容上不可信。
  let unescapedOpenBraces = 0
  let unescapedCloseBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isEscapedAtPosition(content, i)) {
      unescapedOpenBraces++
    } else if (content[i] === '}' && !isEscapedAtPosition(content, i)) {
      unescapedCloseBraces++
    }
  }
  // 仅当"闭合"数量超过"开启"数量时才阻止——这是具体的攻击特征。`}` 多于 `{`
  // 意味着一个带引号的 `{` 被剥离了（bash 把它当内容，我们看到多余的 `}` 无
  // 法解释）。反向情况（`{` 多于 `}`）通常是像 `{foo` 或 `{a,b\}` 这样合法
  // 的未闭合/转义花括号，bash 反正不会展开。
  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        '命令在引号剥离后存在多余的闭合花括号，表明可能存在花括号展开混淆',
    }
  }

  // 安全要点：另外，检查原始命令（引号剥离之前）是否在未加引号的花括号上下文中
  // 出现 `'{'` 或 `"{"`——这是具体的攻击原语。外层未加引号 `{...}` 内部出现
  // 带引号的花括号几乎总是混淆企图；合法命令不会在花括号展开中嵌套带引号的
  // 花括号（awk/find 模式是完全带引号的，比如 `awk '{print $1}'`，其中外层
  // 花括号也在引号内）。
  //
  // 即使攻击者构造出平衡的剥离花括号有效载荷，这也能捕获它（纵深防御）。
  // 我们使用一个简单的启发式：如果原始命令有 `'{'` 或 `'}'` 或 `"{"` 或
  // `"}"`（带引号的单个花括号）同时也有一个未加引号的 `{`，那就是可疑的。
  if (unescapedOpenBraces > 0) {
    const orig = context.originalCommand
    // 查找带引号的单花括号模式：'{'、'}'、"{"
    // 这些是攻击原语——一个被引号包裹的花括号字符。
    if (/['"][{}]['"]/.test(orig)) {
      logEvent('limkenion_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
        subId: 3,
      })
      return {
        behavior: 'ask',
        message:
          '命令在花括号上下文内包含带引号的花括号字符（潜在的花括号展开混淆）',
      }
    }
  }

  // 扫描未转义的 `{` 字符，然后检查它们是否构成花括号展开。
  // 我们用手动扫描而非简单的正则 lookbehind，因为 lookbehind 无法处理双重
  // 转义的反斜杠（\\{ 是未转义的 `{`）。
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue
    if (isEscapedAtPosition(content, i)) continue

    // 通过跟踪嵌套深度找到匹配的未转义 `}`。
    // 之前的方法在嵌套 `{` 处失效，漏掉了外层 `{` 与嵌套 `{` 之间的逗号
    //（例如 `{--upload-pack="evil",{test}}`）。
    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]
      if (ch === '{' && !isEscapedAtPosition(content, j)) {
        depth++
      } else if (ch === '}' && !isEscapedAtPosition(content, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }

    if (matchingClose === -1) continue

    // 检查这个 `{` 与其匹配 `}` 之间最外层嵌套级别上的 `,` 或 `..`。
    // 只有深度为 0 的触发项才重要——bash 会在外层的逗号/序列处拆开花括号展开。
    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]
      if (ch === '{' && !isEscapedAtPosition(content, k)) {
        innerDepth++
      } else if (ch === '}' && !isEscapedAtPosition(content, k)) {
        innerDepth--
      } else if (innerDepth === 0) {
        if (
          ch === ',' ||
          (ch === '.' && k + 1 < matchingClose && content[k + 1] === '.')
        ) {
          logEvent('limkenion_bash_security_check_triggered', {
            checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
            subId: 1,
          })
          return {
            behavior: 'ask',
            message:
              '命令包含可能改变命令解析方式的花括号展开',
          }
        }
      }
    }
    // 此级别没有展开——无需跳过；内层对会被外层循环的后续迭代捕获。
  }

  return {
    behavior: 'passthrough',
    message: '未检测到花括号展开',
  }
}

// 匹配 shell-quote 视为词分隔符、但 bash 视为字面词内容的 Unicode 空白字符。
// 虽然这种差异有利于防御（shell-quote 过度拆分），但主动阻止它们能防止未来的
// 边界情况。
// eslint-disable-next-line no-misleading-character-class
const UNICODE_WS_RE =
  /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

function validateUnicodeWhitespace(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  if (UNICODE_WS_RE.test(originalCommand)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.UNICODE_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含可能导致解析不一致的 Unicode 空白字符',
    }
  }
  return { behavior: 'passthrough', message: '没有 Unicode 空白' }
}

function validateMidWordHash(context: ValidationContext): PermissionResult {
  const { unquotedKeepQuoteChars } = context
  // 匹配前面是非空白字符的 #（词中间哈希）。
  // shell-quote 把词中间的 # 当作注释起点，而 bash 把它当作字面字符，
  // 产生解析器差异。
  //
  // 使用 unquotedKeepQuoteChars（保留引号定界符但剥离带引号的内容）来捕获与
  // 引号相邻的 #（如 'x'#）——fullyUnquotedPreStrip 会把引号和内容都剥离开，
  // 把 'x'# 变成只有 #（词首）。
  //
  // 安全要点：同时检查"延续-连接后"的版本。上下文由原始命令（在延续连接之前）
  // 构建而来。对于 `foo\<NL>#bar`，连接前 `#` 前面是 `\n`（空白 → `/\S#/`
  // 不匹配），但连接后它前面是 `o`（非空白 → 匹配）。shell-quote 作用于连接后
  // 的文本（行延续在 splitCommand 中会被连接），因此解析器差异在连接后的文本上
  // 显现。虽然这不能直接利用（`#...` 片段仍会作为它自己的子命令触发提示），但
  // 这是一个纵深防御缺口——shell-quote 会把 `#` 之后的内容从路径提取中丢弃。
  //
  // 排除 ${#，它是 bash 的字符串长度语法（例如 ${#var}）。
  // 注意：lookbehind 必须紧贴 # 之前放置（而非 \S 之前），以便检查正确的
  // 2 字符窗口。
  const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    return backslashCount % 2 === 1 ? '\\'.repeat(backslashCount - 1) : match
  })
  if (
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() with atom search: fast when # absent
    /\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) ||
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    /\S(?<!\$\{)#/.test(joined)
  ) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MID_WORD_HASH,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含词中间的 #，shell-quote 与 bash 对其解析方式不同',
    }
  }
  return { behavior: 'passthrough', message: '没有词中间哈希' }
}

/**
 * 检测 `#` 注释中包含会让下游引号跟踪器（如 extractQuotedContent）失步的
 * 引号字符的情况。
 *
 * 在 bash 中，某行未加引号的 `#` 之后的所有内容都是注释——注释内的引号字符
 * 是字面文本，不是引号切换。但我们的引号跟踪函数并不处理注释，因此 `#` 后的
 * `'` 或 `"` 会切换它们的引号状态。攻击者可以构造出精确让跟踪器失步的 `# ' "`
 * 序列，导致（随后行上的）后续内容在 bash 中实际未加引号时，看起来"在引号内"。
 *
 * 攻击示例：
 *   echo "it's" # ' " <<'MARKER'\n
 *   rm -rf /\n
 *   MARKER
 * 在 bash 中：`#` 开始注释，`rm -rf /` 在第 2 行执行。
 * 在 extractQuotedContent 中：位置 14（# 之后）的 `'` 打开单引号，MARKER 前的
 * `'` 闭合它。但 MARKER 后的 `'` 又打开另一个单引号，吞掉了换行和 `rm -rf /`，
 * 因此 validateNewlines 看不到未加引号的换行。
 *
 * 防御：如果看到未加引号的 `#` 后跟同行的任何引号字符，就把它当作误解析问题。
 * 合法命令很少在注释中有引号字符（即使有，用户也可以手动批准）。
 */
function validateCommentQuoteDesync(
  context: ValidationContext,
): PermissionResult {
  // Tree-sitter 路径：tree-sitter 能正确识别注释节点和带引号的内容。此失步问题
  // 涉及正则引号跟踪被注释内的引号字符搞混。当 tree-sitter 提供引号上下文时，
  // 这种失步不会发生——无论命令是否包含注释，AST 都是权威的。
  if (context.treeSitter) {
    return {
      behavior: 'passthrough',
      message: 'tree-sitter 的引号上下文是权威的',
    }
  }

  const { originalCommand } = context

  // 使用与 extractQuotedContent 相同的（正确）逻辑逐字符跟踪引号状态：
  // 单引号不会在双引号内切换。当我们遇到未加引号的 `#` 时，检查该行的其余
  // 部分（直到换行）是否包含任何引号字符。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false
      // 双引号内的单引号是字面量——不切换
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      inDoubleQuote = true
      continue
    }

    // 未加引号的 `#`——在 bash 中，这开始一条注释。检查该行的其余部分是否
    // 含有会让其他跟踪器失步的引号字符。
    if (char === '#') {
      const lineEnd = originalCommand.indexOf('\n', i)
      const commentText = originalCommand.slice(
        i + 1,
        lineEnd === -1 ? originalCommand.length : lineEnd,
      )
      if (/['"]/.test(commentText)) {
        logEvent('limkenion_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.COMMENT_QUOTE_DESYNC,
        })
        return {
          behavior: 'ask',
          message:
            '命令的 # 注释中包含会让引号跟踪失步的引号字符',
        }
      }
      // 跳到行尾（其余部分都是注释）
      if (lineEnd === -1) break
      i = lineEnd // 循环增量会越过换行
    }
  }

  return { behavior: 'passthrough', message: '没有注释引号失步' }
}

/**
 * 检测带引号字符串内出现换行、而下一行会被 stripCommentLines 剥离（去除空白后
 * 以 `#` 开头）的情况。
 *
 * 在 bash 中，引号内的 `\n` 是字面字符，是参数的一部分。但 stripCommentLines
 *（bashPermissions 中 stripSafeWrappers 在路径验证和规则匹配之前调用）通过
 * `command.split('\n')` 逐行处理命令，而不跟踪引号状态。带引号的换行让攻击者
 * 把下一行定位为以 `#` 开头（去除空白后），使 stripCommentLines 把那整行丢弃
 * ——把敏感路径或参数从路径验证和权限规则匹配中隐藏起来。
 *
 * 攻击示例（在 acceptEdits 模式下自动允许，无需任何 Bash 规则）：
 *   mv ./decoy '<\n>#' ~/.ssh/id_rsa ./exfil_dir
 * Bash：把 ./decoy 和 ~/.ssh/id_rsa 移入 ./exfil_dir/（在 `\n#` 处报错）。
 * stripSafeWrappers：第 2 行以 `#` 开头 → 被剥离 → "mv ./decoy '"。
 * shell-quote：丢弃未配对的尾部引号 → ["mv", "./decoy"]。
 * checkPathConstraints：只看到 ./decoy（在 cwd 中）→ passthrough。
 * acceptEdits 模式：把所有路径都在 cwd 中的 mv → 允许。零点击，无警告。
 *
 * 也适用于 cp（外泄）、rm/rm -rf（删除任意文件/目录）。
 *
 * 防御：只阻止特定的 stripCommentLines 触发条件——引号内的换行，且下一行在
 * 去除空白后以 `#` 开头。这是能捕获解析器差异的最小检查，同时保留合法的多行
 * 带引号参数（echo 'line1\nline2'、grep 模式等）。
 * 安全 heredoc（$(cat <<'EOF'...)）和 git commit -m "..." 由早期验证器处理，
 * 永远不会到达此检查。
 *
 * 此验证器不在 nonMisparsingValidators 中——它的 ask 结果带上
 * isBashSecurityCheckForMisparsing: true，会在任何基于行的处理运行之前在
 * bashPermissions.ts 的权限流程中被提前拦截。
 */
function validateQuotedNewline(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // 快速路径：必须同时包含换行字节和 # 字符。
  // stripCommentLines 只剥离 trim().startsWith('#') 的行，因此
  // 没有 # 就意味着没有可能的触发点。
  if (!originalCommand.includes('\n') || !originalCommand.includes('#')) {
    return { behavior: 'passthrough', message: '没有换行或没有 # 字符' }
  }

  // 跟踪引号状态。与 extractQuotedContent / validateCommentQuoteDesync 保持一致：
  // - 单引号不会在双引号内部切换
  // - 反斜杠转义下一个字符（但在单引号内不生效）
  // stripCommentLines 按 '\n'（而非 \r）分割，因此我们只把 \n 视为行分隔符。
  // 行内的 \r 会被 trim() 移除，不会改变“trim 后以 # 开头”的判断。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 引号内的换行：下一行（从 bash 的角度看）起始于带引号的字符串内部。
    // 检查该行是否会被 stripCommentLines 剥离——即 trim() 后是否以 `#` 开头。
    // 这与行过滤逻辑完全一致：lines.filter(l => !l.trim().startsWith('#'))
    if (char === '\n' && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = originalCommand.indexOf('\n', lineStart)
      const lineEnd = nextNewline === -1 ? originalCommand.length : nextNewline
      const nextLine = originalCommand.slice(lineStart, lineEnd)
      if (nextLine.trim().startsWith('#')) {
        logEvent('limkenion_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.QUOTED_NEWLINE,
        })
        return {
          behavior: 'ask',
          message:
            '命令包含引号内换行后跟随一行以 # 开头的内容，这可能将参数藏匿起来，使其避开基于行的权限检查',
        }
      }
    }
  }

  return { behavior: 'passthrough', message: '未发现引号换行与 # 结合的模式' }
}

/**
 * 校验命令是否使用了可绕过安全检查的 Zsh 专属危险命令。
 * 这些命令提供了诸如加载内核模块、原始文件 I/O、网络访问以及伪终端执行等
 * 能力，可能绕过普通权限检查。
 *
 * 此外还捕获 `fc -e`（可在命令历史上执行任意编辑器）以及 `emulate`（配合
 * `-c` 相当于 eval）。
 */
function validateZshDangerousCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // 从原始命令中提取基础命令，剥离前导空白、环境变量赋值和 Zsh 前置命令修饰符。
  // 例如："FOO=bar command builtin zmodload" -> "zmodload"
  const ZSH_PRECOMMAND_MODIFIERS = new Set([
    'command',
    'builtin',
    'noglob',
    'nocorrect',
  ])
  const trimmed = originalCommand.trim()
  const tokens = trimmed.split(/\s+/)
  let baseCmd = ''
  for (const token of tokens) {
    // 跳过环境变量赋值（VAR=value）
    if (/^[A-Za-z_]\w*=/.test(token)) continue
    // 跳过 Zsh 前置命令修饰符（它们不改变实际运行的命令）
    if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue
    baseCmd = token
    break
  }

  if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: `命令使用了 Zsh 专属命令 '${baseCmd}'，其可能绕过安全检查`,
    }
  }

  // 检查 `fc -e`，它允许通过编辑器执行任意命令
  // 不带 -e 的 fc 是安全的（仅列出历史记录），但 -e 会指定一个编辑器
  // 作用于命令，实际上相当于执行
  if (baseCmd === 'fc' && /\s-\S*e/.test(trimmed)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        '命令使用了 \'fc -e\'，其可通过编辑器执行任意命令',
    }
  }

  return {
    behavior: 'passthrough',
    message: '未发现 Zsh 危险命令',
  }
}

// 匹配在 shell 命令中没有合法用途的不可打印控制字符：
// 0x00-0x08、0x0B-0x0C、0x0E-0x1F、0x7F。排除了制表符 (0x09)、
// 换行符 (0x0A) 和回车符 (0x0D)，由其他校验器处理。
// Bash 会静默丢弃空字节并忽略大多数控制字符，因此攻击者可以借助它们
// 让元字符绕过我们的检查，同时 bash 仍会执行这些命令
// （例如 "echo safe\x00; rm -rf /"）。
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/**
 * @deprecated 遗留的正则/shell-quote 路径。仅在 tree-sitter 不可用时使用。
 * 主要入口为 parseForSecurity (ast.ts)。
 */
export function bashCommandIsSafe_DEPRECATED(
  command: string,
): PermissionResult {
  // 安全要点：在任何其他处理之前先阻止控制字符。空字节和其他不可打印字符
  // 会被 bash 静默丢弃，但会迷惑我们的校验器，使紧邻其旁的元字符得以混过检查。
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含不可打印控制字符，可能被用于绕过安全检查',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // 安全要点：检测利用 shell-quote 在单引号内对反斜杠处理错误的 '\' 模式。
  // 必须早于 shell-quote 解析运行。
  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        '命令包含单引号内的反斜杠模式，可能被用于绕过安全检查',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // 安全要点：在运行安全校验器之前先剥离 heredoc 正文。
  // 只为带引号/转义的定界符（<<'EOF'、<<\EOF）剥离正文，这些正文是逐字文本——
  // $()、反引号和 ${} 不会展开。
  // 未加引号的 heredoc（<<EOF）会经历完整 shell 展开，因此其正文可能包含
  // 校验器必须看到的可执行命令替换。
  // 当 extractHeredocs 放弃解析（无法安全解析）时，原始命令会经过所有校验器——
  // 这是安全的方向。
  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''
  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } =
    extractQuotedContent(processedCommand, baseCommand === 'jq')

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : '命令已允许',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  // 不设置 isBashSecurityCheckForMisparsing 的校验器——它们的 ask
  // 结果会走标准权限流程，而不是被提前阻止。LF 换行和重定向是
  // splitCommand 能正确处理的正常模式，不属于误解析问题。
  //
  // 注意：validateCarriageReturn 不在这里——CR 确实是误解析问题。
  // shell-quote 的 `[^\s]` 把 CR 当作单词分隔符（JS `\s` ⊃ \r），但
  // bash 的 IFS 并不包含 CR。splitCommand 会把 CR 折叠为空格，这确实属于
  // 误解析。完整的攻击追踪见 validateCarriageReturn。
  const nonMisparsingValidators = new Set([
    validateNewlines,
    validateRedirections,
  ])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlags,
    validateShellMetacharacters,
    validateDangerousVariables,
    // 在 validateNewlines 之前运行注释-引号-失去同步检查：它检测引号跟踪器
    // 因 # 注释失去同步而漏掉换行的情况。
    validateCommentQuoteDesync,
    // 在 validateNewlines 之前运行引号换行检查：它检测相反的情况
    // （引号内部的换行，validateNewlines 按设计忽略）。引号内的换行让攻击者
    // 把命令跨行拆分，使基于行的处理（stripCommentLines）丢弃敏感内容。
    validateQuotedNewline,
    // CR 检查在 validateNewlines 之前运行——CR 是误解析问题
    // （shell-quote/bash 分词差异），LF 则不是。
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateUnicodeWhitespace,
    validateMidWordHash,
    validateBraceExpansion,
    validateZshDangerousCommands,
    // 最后运行畸形符号检查——其他校验器应先捕获具体模式
    // （如 $() 替换、反引号等），因为它们有更精确的错误信息
    validateMalformedTokenInjection,
  ]

  // 安全要点：当列表后面还有误解析校验器时，如果非误解析校验器返回 'ask'，
  // 我们不能提前短路。非误解析的 ask 结果会在 bashPermissions.ts:~1301-1303
  // 处被丢弃（闸门只在设置了 isBashSecurityCheckForMisparsing 时才阻止）。
  // 如果 validateRedirections（索引 10，非误解析）先对 `>` 触发返回带标记的
  // ask，但 validateBackslashEscapedOperators（索引 12，误解析）本会用标记
  // 捕获 `\;`。提前短路会让形如 `cat safe.txt \; echo /etc/passwd > ./out`
  // 的载荷混过检查。
  //
  // 修复：延迟处理非误解析的 ask 结果。继续运行校验器；若有任何误解析校验器
  // 触发，返回该结果（带标记）。只有走到最后仍无误解析 ask，才返回被延迟的
  // 非误解析 ask。
  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: '命令通过了所有安全检查',
  }
}

/**
 * @deprecated 遗留的正则/shell-quote 路径。仅在 tree-sitter 不可用时使用。
 * 主要入口为 parseForSecurity (ast.ts)。
 *
 * bashCommandIsSafe 的异步版本，在可用时使用 tree-sitter 进行更精确的解析。
 * 当 tree-sitter 不可用时，回退到同步正则版本。
 *
 * 供异步调用方使用（bashPermissions.ts、bashCommandHelpers.ts）。
 * 同步调用方（readOnlyValidation.ts）应继续使用 bashCommandIsSafe()。
 */
export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  // 尝试获取 tree-sitter 分析结果
  const parsed = await ParsedCommand.parse(command)
  const tsAnalysis = parsed?.getTreeSitterAnalysis() ?? null

  // 若无 tree-sitter，回退到同步版本
  if (!tsAnalysis) {
    return bashCommandIsSafe_DEPRECATED(command)
  }

  // 运行相同的安全检查，但使用 tree-sitter 增强的上下文。
  // 早期检查（控制字符、shell-quote bug）不会因为 tree-sitter 而获益，
  // 因此我们以相同的方式运行它们。
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('limkenion_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        '命令包含不可打印控制字符，可能被用于绕过安全检查',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        '命令包含单引号内的反斜杠模式，可能被用于绕过安全检查',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''

  // 使用 tree-sitter 引号上下文以获得更精确的分析
  const tsQuote = tsAnalysis.quoteContext
  const regexQuote = extractQuotedContent(
    processedCommand,
    baseCommand === 'jq',
  )

  // 以 tree-sitter 引号上下文为主，但保留正则作为参照，
  // 用于发散日志记录
  const withDoubleQuotes = tsQuote.withDoubleQuotes
  const fullyUnquoted = tsQuote.fullyUnquoted
  const unquotedKeepQuoteChars = tsQuote.unquotedKeepQuoteChars

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
    treeSitter: tsAnalysis,
  }

  // 记录 tree-sitter 与正则引号提取之间的发散。
  // 跳过 heredoc 命令：tree-sitter 将（带引号的）heredoc 正文剥离为
  // 空内容，而正则路径会把它们替换为占位字符串（通过 extractHeredocs），
  // 因此两者的输出永远无法匹配。对每条 heredoc 命令都记录发散
  // 会污染信号。
  //
  // onDivergence 回调：当在扇出循环中调用时（bashPermissions.ts
  // 对子命令的 Promise.all），调用方会将其批处理为一次 logEvent
  // 而非 N 次独立调用。每次 logEvent 都会触发
  // getEventMetadata() → buildProcessMetrics() → process.memoryUsage() →
  // /proc/self/stat 读取；使用记忆化元数据时这些会作为微任务结算
  // 并饿死事件循环（CC-643）。单命令调用方省略回调并保留原有
  // 每次调用的 logEvent 行为。
  if (!tsAnalysis.dangerousPatterns.hasHeredoc) {
    const hasDivergence =
      tsQuote.fullyUnquoted !== regexQuote.fullyUnquoted ||
      tsQuote.withDoubleQuotes !== regexQuote.withDoubleQuotes
    if (hasDivergence) {
      if (onDivergence) {
        onDivergence()
      } else {
        logEvent('limkenion_tree_sitter_security_divergence', {
          quoteContextDivergence: true,
        })
      }
    }
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : '命令已允许',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  const nonMisparsingValidators = new Set([
    validateNewlines,
    validateRedirections,
  ])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlags,
    validateShellMetacharacters,
    validateDangerousVariables,
    validateCommentQuoteDesync,
    validateQuotedNewline,
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateUnicodeWhitespace,
    validateMidWordHash,
    validateBraceExpansion,
    validateZshDangerousCommands,
    validateMalformedTokenInjection,
  ]

  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: '命令通过了所有安全检查',
  }
}
