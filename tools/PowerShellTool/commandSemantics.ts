/**
 * 用于解释 PowerShell 中退出码的命令语义配置。
 *
 * PowerShell 原生 cmdlet 不需要退出码语义：
 *   - Select-String（grep 等价物）无匹配时退出码为 0（返回 $null）
 *   - Compare-Object（diff 等价物）无论是否相同都退出 0
 *   - Test-Path 无论结果如何都退出 0（通过管道返回布尔值）
 * 原生 cmdlet 通过终止性错误（$?）而非退出码来表达失败。
 *
 * 然而，从 PowerShell 中调用的**外部可执行程序**确实会设置 $LASTEXITCODE，
 * 并且许多程序用非零退出码传达的是信息而非失败：
 *   - grep.exe / rg.exe（Git for Windows、scoop 等）：1 = 无匹配
 *   - findstr.exe（Windows 原生）：1 = 无匹配
 *   - robocopy.exe（Windows 原生）：0-7 = 成功，8+ = 出错（著名坑！）
 *
 * 若没有此模块，PowerShellTool 会对任何非零退出抛出 ShellError，
 * 于是 `robocopy` 报告"文件复制成功"（退出码 1）也会显示为错误。
 */

export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * 默认语义：仅将 0 视为成功，其余全部视为错误
 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `命令执行失败，退出码为 ${exitCode}` : undefined,
})

/**
 * grep / ripgrep：0 = 找到匹配，1 = 无匹配，2+ = 错误
 */
const GREP_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? '未找到匹配项' : undefined,
})

/**
 * 外部可执行程序的命令专用语义。
 * 键为小写命令名（不含 .exe 后缀）。
 *
 * 有意省略的命令：
 *   - 'diff'：语义含糊。Windows PowerShell 5.1 将 `diff` 别名映射到 Compare-Object
 *     （不同时退出 0），但 PS Core / Git for Windows 可能解析为 diff.exe
 *     （不同时退出 1）。无法可靠解释。
 *   - 'fc'：语义含糊。PowerShell 将 `fc` 别名映射到 Format-Custom（原生 cmdlet），
 *     但 `fc.exe` 是 Windows 文件比较工具（退出 1 = 文件不同）。
 *     与 `diff` 存在同样的别名问题。
 *   - 'find'：语义含糊。Windows 的 find.exe（文本搜索）与 Unix 的 find.exe
 *     （通过 Git for Windows 进行文件搜索）语义不同。
 *   - 'test'、'['：不是 PowerShell 结构。
 *   - 'select-string'、'compare-object'、'test-path'：原生 cmdlet，退出 0。
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // 外部 grep/ripgrep（Git for Windows、scoop、choco）
  ['grep', GREP_SEMANTIC],
  ['rg', GREP_SEMANTIC],

  // findstr.exe：Windows 原生文本搜索
  // 0 = 找到匹配，1 = 无匹配，2 = 错误
  ['findstr', GREP_SEMANTIC],

  // robocopy.exe：Windows 原生稳健文件复制
  // 退出码是位掩码——0-7 为成功，8+ 表示至少出现一次失败：
  //   0 = 未复制文件、无差异、无失败（已同步）
  //   1 = 文件复制成功
  //   2 = 检测到多余文件/目录（未复制）
  //   4 = 检测到不匹配的文件/目录
  //   8 = 部分文件/目录无法复制（复制错误）
  //  16 = 严重错误（robocopy 未复制任何文件）
  // 这是 Windows 上最常见的"CI 报错但一切正常"的坑。
  [
    'robocopy',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 8,
      message:
        exitCode === 0
          ? '未复制任何文件（已同步）'
          : exitCode >= 1 && exitCode < 8
            ? exitCode & 1
              ? '文件复制成功'
              : 'Robocopy 已完成（无错误）'
            : undefined,
    }),
  ],
])

/**
 * 从单个管道段中提取命令名。
 * 去掉前导 `&` / `.` 调用运算符和 `.exe` 后缀，并转为小写。
 */
function extractBaseCommand(segment: string): string {
  // 去掉 PowerShell 调用运算符：& "cmd"、. "cmd"
  // （段首的 & 和 . 后跟空白时用于调用下一个令牌）
  const stripped = segment.trim().replace(/^[&.]\s+/, '')
  const firstToken = stripped.split(/\s+/)[0] || ''
  // 若命令以 & "grep.exe" 方式调用则去掉两端引号
  const unquoted = firstToken.replace(/^["']|["']$/g, '')
  // 去掉路径：C:\bin\grep.exe → grep.exe、.\rg.exe → rg.exe
  const basename = unquoted.split(/[\\/]/).pop() || unquoted
  // 去掉 .exe 后缀（Windows 大小写不敏感）
  return basename.toLowerCase().replace(/\.exe$/, '')
}

/**
 * 从 PowerShell 命令行中提取主命令。
 * 取最后一个管道段，因为它决定了退出码。
 *
 * 启发式地在 `;` 和 `|` 处切分——对带引号字符串或复杂结构可能出错。
 * **不要**将其用于安全判断；它仅用于退出码解释（误判时只会回退到默认语义）。
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = command.split(/[;|]/).filter(s => s.trim())
  const last = segments[segments.length - 1] || command
  return extractBaseCommand(last)
}

/**
 * 根据语义规则解释命令结果
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): {
  isError: boolean
  message?: string
} {
  const baseCommand = heuristicallyExtractBaseCommand(command)
  const semantic = COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC
  return semantic(exitCode, stdout, stderr)
}
