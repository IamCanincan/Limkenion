import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import type { Redirect, SimpleCommand } from '../../utils/bash/ast.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getDirectoryForPath } from '../../utils/path.js'
import { allWorkingDirectories } from '../../utils/permissions/filesystem.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  expandTilde,
  type FileOperationType,
  formatDirectoryList,
  isDangerousRemovalPath,
  validatePath,
} from '../../utils/permissions/pathValidation.js'
import type { BashTool } from './BashTool.js'
import { stripSafeWrappers } from './bashPermissions.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

export type PathCommand =
  | 'cd'
  | 'ls'
  | 'find'
  | 'mkdir'
  | 'touch'
  | 'rm'
  | 'rmdir'
  | 'mv'
  | 'cp'
  | 'cat'
  | 'head'
  | 'tail'
  | 'sort'
  | 'uniq'
  | 'wc'
  | 'cut'
  | 'paste'
  | 'column'
  | 'tr'
  | 'file'
  | 'stat'
  | 'diff'
  | 'awk'
  | 'strings'
  | 'hexdump'
  | 'od'
  | 'base64'
  | 'nl'
  | 'grep'
  | 'rg'
  | 'sed'
  | 'git'
  | 'jq'
  | 'sha256sum'
  | 'sha1sum'
  | 'md5sum'

/**
 * 检查 rm/rmdir 命令是否指向危险路径，这类路径即使存在允许列表规则，
 * 也始终需要用户明确批准。此检查可防止 `rm -rf /` 之类的命令造成灾难性数据丢失。
 */
function checkDangerousRemovalPaths(
  command: 'rm' | 'rmdir',
  args: string[],
  cwd: string,
): PermissionResult {
  // 使用现有的路径提取器提取路径
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)

  for (const path of paths) {
    // 展开波浪号并解析为绝对路径
    // 注意：我们在不解析符号链接的情况下检查路径，因为像 /tmp 这样的危险路径
    // 应当被捕获，即便在 macOS 上 /tmp 是指向 /private/tmp 的符号链接
    const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath)

    // 检查这是否为危险路径（使用未解析符号链接的路径）
    if (isDangerousRemovalPath(absolutePath)) {
      return {
        behavior: 'ask',
        message: `检测到危险${command}操作：'${absolutePath}'\n\n该命令将删除关键系统目录。这需要明确批准，且无法通过权限规则自动放行。`,
        decisionReason: {
          type: 'other',
          reason: `关键路径上执行危险${command}操作：${absolutePath}`,
        },
        // 不提供建议——我们不想鼓励保存危险命令
        suggestions: [],
      }
    }
  }

  // 未发现危险路径
  return {
    behavior: 'passthrough',
    message: `未在 ${command} 命令中检测到危险删除`,
  }
}

/**
 * 安全：提取位置参数（非标志参数），并正确处理
 * POSIX 的 `--` 选项结束分隔符。
 *
 * 大多数命令（rm、cat、touch 等）在遇到 `--` 时停止解析选项，并将
 * 其后的所有参数都视为位置参数，即使它们以 `-` 开头。朴素的
 * `!arg.startsWith('-')` 过滤会丢弃这些参数，导致对如下攻击载荷的
 * 路径校验被静默跳过：
 *
 *   rm -- -/../.limkenion/settings.local.json
 *
 * 这里 `-/../.limkenion/settings.local.json` 以 `-` 开头，因此朴素的过滤器
 * 会丢弃它，校验看到零个路径，返回 passthrough，文件便在
 * 无提示的情况下被删除。有了 `--` 处理，该路径会被提取并
 * 校验（被 isLimkenionConfigFilePath / pathInAllowedWorkingPath 阻止）。
 */
function filterOutFlags(args: string[]): string[] {
  const result: string[] = []
  let afterDoubleDash = false
  for (const arg of args) {
    if (afterDoubleDash) {
      result.push(arg)
    } else if (arg === '--') {
      afterDoubleDash = true
    } else if (!arg?.startsWith('-')) {
      result.push(arg)
    }
  }
  return result
}

// 辅助函数：解析 grep/rg 风格的命令（先模式后路径）
function parsePatternCommand(
  args: string[],
  flagsWithArgs: Set<string>,
  defaults: string[] = [],
): string[] {
  const paths: string[] = []
  let patternFound = false
  // 安全：跟踪 `--` 选项结束分隔符。在 `--` 之后，所有参数都是
  // 位置参数，无论是否以 `-` 开头。参见 filterOutFlags() 的文档注释。
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined || arg === null) continue

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith('-')) {
      const flag = arg.split('=')[0]
      // 模式标志表示我们已经找到了模式
      if (flag && ['-e', '--regexp', '-f', '--file'].includes(flag)) {
        patternFound = true
      }
      // 如果标志需要参数，则跳过下一个参数
      if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
        i++
      }
      continue
    }

    // 第一个非标志项是模式，其余是路径
    if (!patternFound) {
      patternFound = true
      continue
    }
    paths.push(arg)
  }

  return paths.length > 0 ? paths : defaults
}

/**
 * 从命令参数中为各类路径命令提取路径。
 * 每个命令处理路径和标志的方式都有各自的特定逻辑。
 */
export const PATH_EXTRACTORS: Record<
  PathCommand,
  (args: string[]) => string[]
> = {
  // cd：特殊情况 —— 所有参数构成一个路径
  cd: args => (args.length === 0 ? [homedir()] : [args.join(' ')]),

  // ls：过滤标志，默认使用当前目录
  ls: args => {
    const paths = filterOutFlags(args)
    return paths.length > 0 ? paths : ['.']
  },

  // find：持续收集路径直到遇到真正的标志，同时检查接受路径的标志
  // 安全：`find -- -path` 会让 `-path` 成为起始点（而非谓词）。
  // GNU find 支持 `--`，以允许以 `-` 开头的搜索根目录。在 `--` 之后，
  // 我们保守地把所有剩余参数都收集为待校验路径。这会
  // 过度包含 `-name foo` 这类谓词，但 find 是只读操作，且
  // 谓词会解析为 cwd 内的路径（允许），因此对
  // 合法用法不会产生误阻止。这种过度包含可确保像
  // `find -- -/../../etc` 这样的攻击路径被捕获。
  find: args => {
    const paths: string[] = []
    const pathFlags = new Set([
      '-newer',
      '-anewer',
      '-cnewer',
      '-mnewer',
      '-samefile',
      '-path',
      '-wholename',
      '-ilname',
      '-lname',
      '-ipath',
      '-iwholename',
    ])
    const newerPattern = /^-newer[acmBt][acmtB]$/
    let foundNonGlobalFlag = false
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue

      if (afterDoubleDash) {
        paths.push(arg)
        continue
      }

      if (arg === '--') {
        afterDoubleDash = true
        continue
      }

      // 处理标志
      if (arg.startsWith('-')) {
        // 全局选项不会停止收集
        if (['-H', '-L', '-P'].includes(arg)) continue

        // 标记我们已看到一个非全局标志
        foundNonGlobalFlag = true

        // 检查该标志是否接受路径参数
        if (pathFlags.has(arg) || newerPattern.test(arg)) {
          const nextArg = args[i + 1]
          if (nextArg) {
            paths.push(nextArg)
            i++ // 跳过我们刚处理过的路径
          }
        }
        continue
      }

      // 仅收集第一个非全局标志之前的非标志参数
      if (!foundNonGlobalFlag) {
        paths.push(arg)
      }
    }
    return paths.length > 0 ? paths : ['.']
  },

  // 所有简单命令：只需过滤掉标志
  mkdir: filterOutFlags,
  touch: filterOutFlags,
  rm: filterOutFlags,
  rmdir: filterOutFlags,
  mv: filterOutFlags,
  cp: filterOutFlags,
  cat: filterOutFlags,
  head: filterOutFlags,
  tail: filterOutFlags,
  sort: filterOutFlags,
  uniq: filterOutFlags,
  wc: filterOutFlags,
  cut: filterOutFlags,
  paste: filterOutFlags,
  column: filterOutFlags,
  file: filterOutFlags,
  stat: filterOutFlags,
  diff: filterOutFlags,
  awk: filterOutFlags,
  strings: filterOutFlags,
  hexdump: filterOutFlags,
  od: filterOutFlags,
  base64: filterOutFlags,
  nl: filterOutFlags,
  sha256sum: filterOutFlags,
  sha1sum: filterOutFlags,
  md5sum: filterOutFlags,

  // tr：特殊情况 —— 跳过字符集
  tr: args => {
    const hasDelete = args.some(
      a =>
        a === '-d' ||
        a === '--delete' ||
        (a.startsWith('-') && a.includes('d')),
    )
    const nonFlags = filterOutFlags(args)
    return nonFlags.slice(hasDelete ? 1 : 2) // 跳过 SET1 或 SET1+SET2
  },

  // grep：先模式后路径，默认为 stdin
  grep: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '--exclude',
      '--include',
      '--exclude-dir',
      '--include-dir',
      '-m',
      '--max-count',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    const paths = parsePatternCommand(args, flags)
    // 特殊：如果存在 -r/-R 标志且没有路径，则使用当前目录
    if (
      paths.length === 0 &&
      args.some(a => ['-r', '-R', '--recursive'].includes(a))
    ) {
      return ['.']
    }
    return paths
  },

  // rg：先模式后路径，默认为当前目录
  rg: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '-t',
      '--type',
      '-T',
      '--type-not',
      '-g',
      '--glob',
      '-m',
      '--max-count',
      '--max-depth',
      '-r',
      '--replace',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    return parsePatternCommand(args, flags, ['.'])
  },

  // sed：就地处理文件或从 stdin 读取
  sed: args => {
    const paths: string[] = []
    let skipNext = false
    let scriptFound = false
    // 安全：跟踪 `--` 选项结束分隔符。在 `--` 之后，所有参数都是
    // 位置参数，无论是否以 `-` 开头。参见 filterOutFlags() 的文档注释。
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      if (skipNext) {
        skipNext = false
        continue
      }

      const arg = args[i]
      if (!arg) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      // 处理标志（仅在 `--` 之前）
      if (!afterDoubleDash && arg.startsWith('-')) {
        // -f 标志：下一个参数是需要校验的脚本文件
        if (['-f', '--file'].includes(arg)) {
          const scriptFile = args[i + 1]
          if (scriptFile) {
            paths.push(scriptFile) // 将脚本文件加入待校验路径
            skipNext = true
          }
          scriptFound = true
        }
        // -e 标志：下一个参数是表达式，不是文件
        else if (['-e', '--expression'].includes(arg)) {
          skipNext = true
          scriptFound = true
        }
        // 组合标志，如 -ie 或 -nf
        else if (arg.includes('e') || arg.includes('f')) {
          scriptFound = true
        }
        continue
      }

      // 第一个非标志项是脚本（如果尚未通过 -e/-f 找到）
      if (!scriptFound) {
        scriptFound = true
        continue
      }

      // 其余是文件路径
      paths.push(arg)
    }

    return paths
  },

  // jq：先过滤器后文件路径（与 grep 类似）
  // jq 的命令结构是：jq [flags] filter [files...]
  // 如果未提供文件，jq 会从 stdin 读取
  jq: args => {
    const paths: string[] = []
    const flagsWithArgs = new Set([
      '-e',
      '--expression',
      '-f',
      '--from-file',
      '--arg',
      '--argjson',
      '--slurpfile',
      '--rawfile',
      '--args',
      '--jsonargs',
      '-L',
      '--library-path',
      '--indent',
      '--tab',
    ])
    let filterFound = false
    // 安全：跟踪 `--` 选项结束分隔符。在 `--` 之后，所有参数都是
    // 位置参数，无论是否以 `-` 开头。参见 filterOutFlags() 的文档注释。
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === undefined || arg === null) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      if (!afterDoubleDash && arg.startsWith('-')) {
        const flag = arg.split('=')[0]
        // 模式标志表示我们已经找到了过滤器
        if (flag && ['-e', '--expression'].includes(flag)) {
          filterFound = true
        }
        // 如果标志需要参数，则跳过下一个参数
        if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
          i++
        }
        continue
      }

      // 第一个非标志项是过滤器，其余是文件路径
      if (!filterFound) {
        filterFound = true
        continue
      }
      paths.push(arg)
    }

    // 如果没有文件路径，jq 会从 stdin 读取（没有需要校验的路径）
    return paths
  },

  // git：处理会访问仓库之外任意文件的子命令
  git: args => {
    // git diff --no-index 比较特殊 —— 它会显式比较 git 控制范围之外的文件
    // 该标志允许 git diff 比较文件系统上的任意两个文件，而不只是
    // 仓库内的文件，这正是它需要路径校验的原因
    if (args.length >= 1 && args[0] === 'diff') {
      if (args.includes('--no-index')) {
        // 安全：git diff --no-index 接受文件路径之前的 `--`。
        // 使用能正确处理 `--` 的 filterOutFlags，而不是朴素的
        // startsWith('-') 过滤，以捕获像 `-/../etc/passwd` 这样的路径。
        const filePaths = filterOutFlags(args.slice(1))
        return filePaths.slice(0, 2) // git diff --no-index 期望恰好 2 个路径
      }
    }
    // 其他 git 命令（add、rm、mv、show 等）在仓库上下文内运行，
    // 并且已经受到 git 自身安全模型的约束，因此不需要
    // 额外的路径校验
    return []
  },
}

const SUPPORTED_PATH_COMMANDS = Object.keys(PATH_EXTRACTORS) as PathCommand[]

const ACTION_VERBS: Record<PathCommand, string> = {
  cd: '切换目录到',
  ls: '列出文件于',
  find: '在……中搜索文件',
  mkdir: '在……中创建目录',
  touch: '在……中创建或修改文件',
  rm: '从……中删除文件',
  rmdir: '从……中删除目录',
  mv: '向/从……移动文件',
  cp: '向/从……复制文件',
  cat: '从……拼接文件',
  head: '从……读取文件开头',
  tail: '从……读取文件末尾',
  sort: '对……中的文件内容排序',
  uniq: '过滤……中重复行',
  wc: '统计……中文件的行/词/字节数',
  cut: '从……中提取列',
  paste: '合并……中的文件',
  column: '格式化……中的文件',
  tr: '转换……中文件的文本',
  file: '检查……中的文件类型',
  stat: '读取……中文件的统计信息',
  diff: '比较……中的文件',
  awk: '处理……中文件的文本',
  strings: '提取……中文件的字符串',
  hexdump: '显示……中文件的十六进制转储',
  od: '显示……中文件的八进制转储',
  base64: '对……中的文件进行编码/解码',
  nl: '给……中的文件行编号',
  grep: '在……中搜索模式',
  rg: '在……中搜索模式',
  sed: '在……中编辑文件',
  git: '通过 git 访问……中的文件',
  jq: '处理……中文件的 JSON',
  sha256sum: '计算……中文件的 SHA-256 校验和',
  sha1sum: '计算……中文件的 SHA-1 校验和',
  md5sum: '计算……中文件的 MD5 校验和',
}

export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
  cd: 'read',
  ls: 'read',
  find: 'read',
  mkdir: 'create',
  touch: 'create',
  rm: 'write',
  rmdir: 'write',
  mv: 'write',
  cp: 'write',
  cat: 'read',
  head: 'read',
  tail: 'read',
  sort: 'read',
  uniq: 'read',
  wc: 'read',
  cut: 'read',
  paste: 'read',
  column: 'read',
  tr: 'read',
  file: 'read',
  stat: 'read',
  diff: 'read',
  awk: 'read',
  strings: 'read',
  hexdump: 'read',
  od: 'read',
  base64: 'read',
  nl: 'read',
  grep: 'read',
  rg: 'read',
  sed: 'write',
  git: 'read',
  jq: 'read',
  sha256sum: 'read',
  sha1sum: 'read',
  md5sum: 'read',
}

/**
 * 在路径校验之前运行的命令专属校验器。
 * 如果命令有效则返回 true，如果应被拒绝则返回 false。
 * 用于阻止带有可能绕过路径校验的标志的命令。
 */
const COMMAND_VALIDATOR: Partial<
  Record<PathCommand, (args: string[]) => boolean>
> = {
  mv: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
  cp: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
}

function validateCommandPaths(
  command: PathCommand,
  args: string[],
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  operationTypeOverride?: FileOperationType,
): PermissionResult {
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)
  const operationType = operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]

  // 安全：检查命令专属校验器（例如阻止可能绕过路径校验的标志）
  // 某些命令（如 mv/cp）带有可绕过路径提取的标志（--target-directory=PATH），
  // 因此我们为这些命令阻止所有标志以确保安全。
  const validator = COMMAND_VALIDATOR[command]
  if (validator && !validator(args)) {
    return {
      behavior: 'ask',
      message: `${command} 带标志的命令需要手动批准以确保路径安全。出于安全考虑，Limkenion 无法自动校验使用标志的 ${command} 命令，因为某些标志（如 --target-directory=PATH）可能绕过路径校验。`,
      decisionReason: {
        type: 'other',
        reason: `${command} 带标志的命令需要手动批准`,
      },
    }
  }

  // 安全：阻止包含 'cd' 的复合命令中的写操作
  // 这可防止在操作之前通过切换目录绕过路径安全检查。
  // 攻击示例：cd .limkenion/ && mv test.txt settings.json
  // 这会绕过对 .limkenion/settings.json 的检查，因为路径是相对于
  // 原始 CWD 解析的，并未考虑 cd 的影响。
  //
  // 替代方案：与其阻止所有带 cd 的写操作，我们可以沿命令链跟踪
  // 生效的 CWD（例如，在 "cd .limkenion/" 之后，后续命令
  // 将以 CWD=".limkenion/" 进行校验）。这样更宽松，
  // 但需要谨慎处理：
  // - 相对路径（cd ../foo）
  // - 特殊的 cd 目标（cd ~、cd -、不带参数的 cd）
  // - 连续出现的多条 cd 命令
  // - 无法确定 cd 目标的错误情形
  // 目前我们采取保守做法，要求人工批准。
  if (compoundCommandHasCd && operationType !== 'read') {
    return {
      behavior: 'ask',
      message: `先切换目录再执行写操作的命令需要明确批准，以确保路径被正确求值。出于安全考虑，当复合命令中使用 'cd' 时，Limkenion 无法自动确定最终工作目录。`,
      decisionReason: {
        type: 'other',
        reason:
          '复合命令含 cd 与写操作——需要手动批准以防路径解析被绕过',
      },
    }
  }

  for (const path of paths) {
    const { allowed, resolvedPath, decisionReason } = validatePath(
      path,
      cwd,
      toolPermissionContext,
      operationType,
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // 如果可用，使用安全检查的自定义原因（type: 'other' 或 'safetyCheck'）
      // 否则使用标准的 "was blocked" 消息
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : `${command} 在 '${resolvedPath}' 中被阻止。出于安全考虑，Limkenion 在本次会话中只能${ACTION_VERBS[command]}允许的工作目录：${dirListStr}。`

      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
      }
    }
  }

  // 所有路径均有效 —— 返回 passthrough
  return {
    behavior: 'passthrough',
    message: `${command} 命令路径校验通过`,
  }
}

export function createPathChecker(
  command: PathCommand,
  operationTypeOverride?: FileOperationType,
) {
  return (
    args: string[],
    cwd: string,
    context: ToolPermissionContext,
    compoundCommandHasCd?: boolean,
  ): PermissionResult => {
    // 首先检查常规路径校验（其中包含显式拒绝规则）
    const result = validateCommandPaths(
      command,
      args,
      cwd,
      context,
      compoundCommandHasCd,
      operationTypeOverride,
    )

    // 如果被显式拒绝，则尊重该结果（不要用危险路径消息覆盖）
    if (result.behavior === 'deny') {
      return result
    }

    // 在显式拒绝规则之后、但在其他结果之前检查危险删除路径
    // 这可确保即使用户有允许列表规则、或 glob 模式被拒绝，该检查仍会运行，
    // 同时尊重显式拒绝规则。危险模式会得到一条具体的
    // 错误消息，它会覆盖通用的 glob 模式拒绝消息。
    if (command === 'rm' || command === 'rmdir') {
      const dangerousPathResult = checkDangerousRemovalPaths(command, args, cwd)
      if (dangerousPathResult.behavior !== 'passthrough') {
        return dangerousPathResult
      }
    }

    // 如果是 passthrough，则直接返回
    if (result.behavior === 'passthrough') {
      return result
    }

    // 如果是 ask 决策，则根据操作类型添加建议
    if (result.behavior === 'ask') {
      const operationType =
        operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]
      const suggestions: PermissionUpdate[] = []

      // 只有在存在被阻止的路径时，才建议添加目录/规则
      if (result.blockedPath) {
        if (operationType === 'read') {
          // 对于读操作，建议为该目录添加 Read 规则（仅当目录存在时）
          const dirPath = getDirectoryForPath(result.blockedPath)
          const suggestion = createReadRuleSuggestion(dirPath, 'session')
          if (suggestion) {
            suggestions.push(suggestion)
          }
        } else {
          // 对于写/创建操作，建议添加该目录
          suggestions.push({
            type: 'addDirectories',
            directories: [getDirectoryForPath(result.blockedPath)],
            destination: 'session',
          })
        }
      }

      // 对于写操作，还建议启用 accept-edits 模式
      if (operationType === 'write' || operationType === 'create') {
        suggestions.push({
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        })
      }

      result.suggestions = suggestions
    }

    // 直接返回该决策
    return result
  }
}

/**
 * 使用 shell-quote 解析命令参数，将 glob 对象转换为字符串。
 * 这是必要的，因为 shell-quote 会把像 *.txt 这样的模式解析为 glob 对象，
 * 而路径校验需要它们为字符串。
 */
function parseCommandArguments(cmd: string): string[] {
  const parseResult = tryParseShellCommand(cmd, env => `$${env}`)
  if (!parseResult.success) {
    // shell 语法格式错误，返回空数组
    return []
  }
  const parsed = parseResult.tokens
  const extractedArgs: string[] = []

  for (const arg of parsed) {
    if (typeof arg === 'string') {
      // 包含空字符串 —— 它们是有效参数（例如 grep "" /tmp/t）
      extractedArgs.push(arg)
    } else if (
      typeof arg === 'object' &&
      arg !== null &&
      'op' in arg &&
      arg.op === 'glob' &&
      'pattern' in arg
    ) {
      // shell-quote 会把 glob 模式解析为对象，但校验时我们需要字符串
      extractedArgs.push(String(arg.pattern))
    }
  }

  return extractedArgs
}

/**
 * 针对路径约束和 shell 安全性校验单条命令。
 *
 * 该函数会：
 * 1. 解析命令参数
 * 2. 检查它是否为路径命令（cd、ls、find）
 * 3. 校验是否存在 shell 注入模式
 * 4. 校验所有路径都位于允许的目录内
 *
 * @param cmd - 要校验的命令字符串
 * @param cwd - 当前工作目录
 * @param toolPermissionContext - 包含允许目录的上下文
 * @param compoundCommandHasCd - 整个复合命令中是否包含 cd
 * @returns PermissionResult - 如果不是路径命令则为 'passthrough'，否则为校验结果
 */
function validateSinglePathCommand(
  cmd: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // 安全：在提取基础命令之前剥离包装命令（timeout、nice、nohup、time）
  // 若不这样做，用这些工具包装的危险命令将绕过路径校验，因为
  // 被检查的会是包装命令（例如 'timeout'）而非
  // 实际命令（例如 'rm'）。
  // 示例：'timeout 10 rm -rf /' 否则会把 'timeout' 视为基础命令。
  const strippedCmd = stripSafeWrappers(cmd)

  // 将命令解析为参数，处理引号和 glob
  const extractedArgs = parseCommandArguments(strippedCmd)
  if (extractedArgs.length === 0) {
    return {
      behavior: 'passthrough',
      message: '空命令——无路径可校验',
    }
  }

  // 检查这是否是我们需要校验的路径命令
  const [baseCmd, ...args] = extractedArgs
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `命令 '${baseCmd}' 不是受路径限制的命令`,
    }
  }

  // 对于只读的 sed 命令（例如 sed -n '1,10p' file.txt），
  // 将文件路径按读操作而非写操作校验。
  // sed 在路径校验中通常被归类为 'write'，但当命令是纯读取
  //（用 -n 打印行）时，文件参数是只读的。
  const operationTypeOverride =
    baseCmd === 'sed' && sedCommandIsAllowedByAllowlist(strippedCmd)
      ? ('read' as FileOperationType)
      : undefined

  // 校验所有路径都位于允许的目录内
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

/**
 * 类似 validateSinglePathCommand，但直接操作由 AST 派生的 argv，
 * 而不是用 shell-quote 重新解析命令字符串。可避开
 * shell-quote 的单引号反斜杠缺陷 —— 该缺陷会导致 parseCommandArguments
 * 静默返回 [] 并跳过路径校验。
 */
function validateSinglePathCommandArgv(
  cmd: SimpleCommand,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  const argv = stripWrappersFromArgv(cmd.argv)
  if (argv.length === 0) {
    return {
      behavior: 'passthrough',
      message: '空命令——无路径可校验',
    }
  }
  const [baseCmd, ...args] = argv
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `命令 '${baseCmd}' 不是受路径限制的命令`,
    }
  }
  // sed 只读覆盖：允许列表检查使用 .text，因为
  // sedCommandIsAllowedByAllowlist 接受字符串。argv 已被
  // 剥离包装命令，但 .text 是原始的 tree-sitter 片段（包含
  // `timeout 5 ` 前缀），所以这里也要剥离。
  const operationTypeOverride =
    baseCmd === 'sed' &&
    sedCommandIsAllowedByAllowlist(stripSafeWrappers(cmd.text))
      ? ('read' as FileOperationType)
      : undefined
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

function validateOutputRedirections(
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // 安全：阻止包含 'cd' 的复合命令中的输出重定向
  // 这可防止在重定向之前通过切换目录绕过路径安全检查。
  // 攻击示例：cd .limkenion/ && echo "malicious" > settings.json
  // 重定向目标会相对于原始 CWD 校验，但
  // 实际写入发生在 'cd' 执行后的新目录中。
  if (compoundCommandHasCd && redirections.length > 0) {
    return {
      behavior: 'ask',
      message: `先切换目录再通过输出重定向写入的命令需要明确批准，以确保路径被正确求值。出于安全考虑，当复合命令中使用 'cd' 时，Limkenion 无法自动确定最终工作目录。`,
      decisionReason: {
        type: 'other',
        reason:
          '复合命令含 cd 与输出重定向——需要手动批准以防路径解析被绕过',
      },
    }
  }
  for (const { target } of redirections) {
    // /dev/null 始终安全 —— 它会丢弃输出
    if (target === '/dev/null') {
      continue
    }
    const { allowed, resolvedPath, decisionReason } = validatePath(
      target,
      cwd,
      toolPermissionContext,
      'create', // 将 > 和 >> 视为创建操作
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // 如果可用，使用安全检查的自定义原因（type: 'other' 或 'safetyCheck'）
      // 否则使用拒绝规则或工作目录限制的标准消息
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : decisionReason?.type === 'rule'
            ? `对 '${resolvedPath}' 的输出重定向被拒绝规则阻止。`
            : `对 '${resolvedPath}' 的输出重定向被阻止。出于安全考虑，Limkenion 在本次会话中只能写入允许的工作目录中的文件：${dirListStr}。`

      // 如果被拒绝规则拒绝，则返回 'deny' 行为
      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
        suggestions: [
          {
            type: 'addDirectories',
            directories: [getDirectoryForPath(resolvedPath)],
            destination: 'session',
          },
        ],
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: '未发现不安全的输出重定向',
  }
}

/**
 * 检查访问文件系统的命令（cd、ls、find）的路径约束。
 * 同时校验输出重定向，确保它们位于允许的目录内。
 *
 * @returns
 * - 如果任何路径命令或重定向试图访问允许目录之外，则返回 'ask'
 * - 如果未找到路径命令，或所有路径命令都在允许目录内，则返回 'passthrough'
 */
export function checkPathConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astRedirects?: Redirect[],
  astCommands?: SimpleCommand[],
): PermissionResult {
  // 安全：进程替换 >(cmd) 可以执行写入文件的命令，
  // 而这些文件不会表现为重定向目标。例如：
  //   echo secret > >(tee .git/config)
  // tee 命令会写入 .git/config，但它不会被识别为重定向。
  // 任何包含进程替换的命令都需要显式批准。
  // 在 AST 路径上跳过 —— process_substitution 属于 DANGEROUS_TYPES，
  // 并且在到达此处之前已返回 too-complex。
  if (!astCommands && />>\s*>\s*\(|>\s*>\s*\(|<\s*\(/.test(input.command)) {
    return {
      behavior: 'ask',
      message:
        '进程替换（>(...) 或 <(...)）可执行任意命令，需要手动批准',
      decisionReason: {
        type: 'other',
        reason: '进程替换需要手动批准',
      },
    }
  }

  // 安全：当有由 AST 派生的重定向可用时，直接使用它们，
  // 而不用 shell-quote 重新解析。shell-quote 存在已知的
  // 单引号反斜杠缺陷，会在解析成功时把重定向操作符静默合并为
  // 乱码 token（这不是解析失败，因此
  // 故障关闭保护无济于事）。AST 已正确解析目标，
  // 且 checkSemantics 已对其完成校验。
  const { redirections, hasDangerousRedirection } = astRedirects
    ? astRedirectsToOutputRedirections(astRedirects)
    : extractOutputRedirections(input.command)

  // 安全：如果我们发现某个重定向操作符的目标包含 shell 展开
  // 语法（$VAR 或 %VAR%），则要求人工批准，因为该目标无法被安全校验。
  if (hasDangerousRedirection) {
    return {
      behavior: 'ask',
      message: '路径中的 shell 展开语法需要手动批准',
      decisionReason: {
        type: 'other',
        reason: '路径中的 shell 展开语法需要手动批准',
      },
    }
  }
  const redirectionResult = validateOutputRedirections(
    redirections,
    cwd,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  if (redirectionResult.behavior !== 'passthrough') {
    return redirectionResult
  }

  // 安全：当有由 AST 派生的命令可用时，使用预先解析好的 argv 遍历它们，
  // 而不是通过 splitCommand_DEPRECATED + shell-quote 重新解析。
  // shell-quote 存在单引号反斜杠缺陷，会导致
  // parseCommandArguments 静默返回 [] 并跳过路径校验
  //（isDangerousRemovalPath 等）。AST 已正确解析 argv。
  if (astCommands) {
    for (const cmd of astCommands) {
      const result = validateSinglePathCommandArgv(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  } else {
    const commands = splitCommand_DEPRECATED(input.command)
    for (const cmd of commands) {
      const result = validateSinglePathCommand(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  }

  // 始终返回 passthrough，让其他权限检查处理该命令
  return {
    behavior: 'passthrough',
    message: '所有路径命令均校验成功',
  }
}

/**
 * 将 AST 派生的 Redirect[] 转换为
 * validateOutputRedirections 期望的格式。过滤出仅输出的重定向（排除
 * 像 2>&1 这样的 fd 复制），并把操作符映射为 '>' | '>>'。
 */
function astRedirectsToOutputRedirections(redirects: Redirect[]): {
  redirections: Array<{ target: string; operator: '>' | '>>' }>
  hasDangerousRedirection: boolean
} {
  const redirections: Array<{ target: string; operator: '>' | '>>' }> = []
  for (const r of redirects) {
    switch (r.op) {
      case '>':
      case '>|':
      case '&>':
        redirections.push({ target: r.target, operator: '>' })
        break
      case '>>':
      case '&>>':
        redirections.push({ target: r.target, operator: '>>' })
        break
      case '>&':
        // >&N（仅数字）是 fd 复制（例如 2>&1、>&10），不是文件
        // 写入。>&file 是 &>file 的废弃形式（重定向到文件）。
        if (!/^\d+$/.test(r.target)) {
          redirections.push({ target: r.target, operator: '>' })
        }
        break
      case '<':
      case '<<':
      case '<&':
      case '<<<':
        // 输入重定向 —— 跳过
        break
    }
  }
  // AST 目标已完全解析（无 shell 展开）—— checkSemantics
  // 已完成校验。不可能存在危险的重定向。
  return { redirections, hasDangerousRedirection: false }
}

// ───────────────────────────────────────────────────────────────────────────
// Argv 层面的安全包装命令剥离（timeout、nice、stdbuf、env、time、nohup）
//
// 这里是权威版本（CANONICAL）的 stripWrappersFromArgv。bashPermissions.ts 仍
// 导出较旧的、范围更窄的副本（仅 timeout/nice-n-N），那是死代码
// —— 没有生产环境消费者 —— 但不能删除：bashPermissions.ts 恰好
// 处于 Bun feature() DCE 复杂度阈值上，从该模块删除约 80 行会
// 静默破坏 feature('BASH_CLASSIFIER') 的求值（丢弃所有
// pendingClassifierCheck 展开）。已在 PR #21503 第 3 轮验证：
// 基线分类器测试 30/30 通过，删除后 22/30 失败。参见
// 团队记忆：bun-feature-dce-cliff.md。在 PR #21075 中命中 3 次、在
// #21503 中命中 2 次。扩展版本因此放在这里（唯一的生产环境消费者）。
//
// 保持同步的对象：
//   - bashPermissions.ts 中的 SAFE_WRAPPER_PATTERNS（基于文本的 stripSafeWrappers）
//   - checkSemantics 中的包装命令剥离循环（src/utils/bash/ast.ts 约 1860 行）
// 如果你在任一处新增了包装命令，也请在此处添加。不对称意味着
// checkSemantics 会把被包装的命令暴露给语义检查，但路径
// 校验只看到包装命令名 → passthrough → 被包装的路径永远不会
// 被校验（PR #21503 评审评论 2907319120）。
// ───────────────────────────────────────────────────────────────────────────

// 安全：timeout 标志取值（VALUE）的允许列表（信号为 TERM/KILL/9，
// 时长为 5/5s/10.5）。拒绝 $ ( ) ` | ; & 和换行符 —— 它们此前
// 会通过 [^ \t]+ 匹配上 —— `timeout -k$(id) 10 ls` 必须不被剥离。
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * 解析 timeout 的 GNU 标志（长标志 + 短标志，粘连形式 + 空格分隔形式），
 * 返回 DURATION token 的 argv 索引；如果标志无法解析则返回 -1。
 */
function skipTimeoutFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (
      arg === '--foreground' ||
      arg === '--preserve-status' ||
      arg === '--verbose'
    )
      i++
    else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (arg === '--') {
      i++
      break
    } // 选项结束标记
    else if (arg.startsWith('--')) return -1
    else if (arg === '-v') i++
    else if (
      (arg === '-k' || arg === '-s') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (arg.startsWith('-')) return -1
    else break
  }
  return i
}

/**
 * 解析 stdbuf 的标志（-i/-o/-e 的粘连/空格分隔/长标志 = 形式）。
 * 返回被包装 COMMAND 的 argv 索引；如果无法解析或未消费任何标志
 *（不带标志的 stdbuf 是惰性的）则返回 -1。与 checkSemantics（ast.ts）保持一致。
 */
function skipStdbufFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (/^-[ioe]$/.test(arg) && a[i + 1]) i += 2
    else if (/^-[ioe]./.test(arg)) i++
    else if (/^--(input|output|error)=/.test(arg)) i++
    else if (arg.startsWith('-'))
      return -1 // 未知标志：失败即拒绝
    else break
  }
  return i > 1 && i < a.length ? i : -1
}

/**
 * 解析 env 的 VAR=val 和安全标志（-i/-0/-v/-u NAME）。返回被包装 COMMAND
 * 的 argv 索引；如果无法解析或没有包装命令则返回 -1。拒绝 -S（argv
 * 拆分器）、-C/-P（altwd/altpath）。与 checkSemantics（ast.ts）保持一致。
 */
function skipEnvFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (arg.includes('=') && !arg.startsWith('-')) i++
    else if (arg === '-i' || arg === '-0' || arg === '-v') i++
    else if (arg === '-u' && a[i + 1]) i += 2
    else if (arg.startsWith('-'))
      return -1 // -S/-C/-P/未知：失败即拒绝
    else break
  }
  return i < a.length ? i : -1
}

/**
 * stripSafeWrappers（bashPermissions.ts）在 argv 层面的对应实现。从 AST 派生的
 * argv 中剥离包装命令。环境变量已分离到
 * SimpleCommand.envVars 中，因此这里不做环境变量剥离。
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      // 安全（PR #21503 第 3 轮）：无法识别的时长（`.5`、`+5`、
      // `inf` —— GNU timeout 接受的 strtod 格式）→ 原样返回 a。
      // 这是安全的，因为 checkSemantics（ast.ts）对相同输入会失败即拒绝（CLOSED）
      // 且它在 bashToolHasPermission 中最先运行，所以我们永远不会走到这里。
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (a[0] === 'nice') {
      // 安全（PR #21503 第 3 轮）：与 checkSemantics 保持一致 —— 处理裸
      // `nice cmd` 和旧式 `nice -N cmd`，而不仅是 `nice -n N cmd`。
      // 此前只剥离 `-n N`：`nice rm /outside` →
      // baseCmd='nice' → passthrough → /outside 从未被路径校验。
      if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2]))
        a = a.slice(a[3] === '--' ? 4 : 3)
      else if (a[1] && /^-\d+$/.test(a[1])) a = a.slice(a[2] === '--' ? 3 : 2)
      else a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'stdbuf') {
      // 安全（PR #21503 第 3 轮）：PR 扩大了范围。PR 之前，`stdbuf -o0 -eL rm`
      // 会被片段检查拒绝（旧的 checkSemantics slice(2) 留下的
      // name='-eL'）。PR 之后，checkSemantics 会剥离两个标志 → name='rm'
      // → 通过。但 stripWrappersFromArgv 原样返回 →
      // baseCmd='stdbuf' → 不在 SUPPORTED_PATH_COMMANDS 中 → passthrough。
      const i = skipStdbufFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else if (a[0] === 'env') {
      // 同样的不对称：checkSemantics 会剥离 env，而我们没有。
      const i = skipEnvFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else {
      return a
    }
  }
}
