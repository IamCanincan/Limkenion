/**
 * PowerShell 约束语言模式（CLM）允许的类型。
 *
 * 当 PowerShell 在 AppLocker/WDAC 系统锁定下运行时，Microsoft 的 CLM
 * 会将 .NET 类型的可用范围限制在此允许清单内。凡是**不在**该集合中的类型
 * 都被视为对不可信代码执行不安全。
 *
 * 我们反其道而行之：类型字面量若不在该集合中则询问确认。用一个统一检查
 * 替代对单个危险类型（命名管道、反射、进程派生、P/Invoke 封送等）的枚举。
 * 该列表由 Microsoft 维护。
 *
 * 来源：https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes
 *
 * 归一化：条目按小写存储，同时存在短名与全名时两者都保留（PS 在运行时会将
 * [int] 之类的类型加速符解析为 System.Int32；我们匹配的是 AST 输出的内容，
 * 即其字面文本）。
 */
export const CLM_ALLOWED_TYPES: ReadonlySet<string> = new Set(
  [
    // 类型加速符（即 AST TypeName.Name 中出现的短名）
    // SECURITY: 已移除 'adsi' 与 'adsisearcher'。二者均为 Active Directory
    // 服务接口类型，转换时会发生网络绑定（bind）：
    //   [adsi]'LDAP://evil.com/...' → 连接到 LDAP 服务器
    //   [adsisearcher]'(objectClass=user)' → 绑定 AD 并查询
    // Microsoft 的 CLM 允许它们，因为这是面向受信域中的 Windows 管理员；
    // 我们将其拦截，因为目标并未校验。
    'alias',
    'allowemptycollection',
    'allowemptystring',
    'allownull',
    'argumentcompleter',
    'argumentcompletions',
    'array',
    'bigint',
    'bool',
    'byte',
    'char',
    'cimclass',
    'cimconverter',
    'ciminstance',
    // 已移除 'cimsession' —— 见下方 wmi/adsi 注释
    'cimtype',
    'cmdletbinding',
    'cultureinfo',
    'datetime',
    'decimal',
    'double',
    'dsclocalconfigurationmanager',
    'dscproperty',
    'dscresource',
    'experimentaction',
    'experimental',
    'experimentalfeature',
    'float',
    'guid',
    'hashtable',
    'int',
    'int16',
    'int32',
    'int64',
    'ipaddress',
    'ipendpoint',
    'long',
    'mailaddress',
    'norunspaceaffinity',
    'nullstring',
    'objectsecurity',
    'ordered',
    'outputtype',
    'parameter',
    'physicaladdress',
    'pscredential',
    'pscustomobject',
    'psdefaultvalue',
    'pslistmodifier',
    'psobject',
    'psprimitivedictionary',
    'pstypenameattribute',
    'ref',
    'regex',
    'sbyte',
    'securestring',
    'semver',
    'short',
    'single',
    'string',
    'supportswildcards',
    'switch',
    'timespan',
    'uint',
    'uint16',
    'uint32',
    'uint64',
    'ulong',
    'uri',
    'ushort',
    'validatecount',
    'validatedrive',
    'validatelength',
    'validatenotnull',
    'validatenotnullorempty',
    'validatenotnullorwhitespace',
    'validatepattern',
    'validaterange',
    'validatescript',
    'validateset',
    'validatetrusteddata',
    'validateuserdrive',
    'version',
    'void',
    'wildcardpattern',
    // SECURITY: 已移除 'wmi'、'wmiclass'、'wmisearcher'、'cimsession'。
    // WMI 类型转换会执行 WMI 查询，可指向远程计算机（网络请求），并访问
    // Win32_Process 等危险类。cimsession 会建立到远程主机的 CIM 会话（网络连接）。
    //   [wmi]'\\evil-host\root\cimv2:Win32_Process.Handle="1"' → 远程 WMI
    //   [wmisearcher]'SELECT * FROM Win32_Process' → 执行 WQL 查询
    // 与上面 adsi/adsisearcher 的移除理由相同。
    'x500distinguishedname',
    'x509certificate',
    'xml',
    // 可解析为 System.* 的加速符的全名（AST 可能输出其中任一形式）
    'system.array',
    'system.boolean',
    'system.byte',
    'system.char',
    'system.datetime',
    'system.decimal',
    'system.double',
    'system.guid',
    'system.int16',
    'system.int32',
    'system.int64',
    'system.numerics.biginteger',
    'system.sbyte',
    'system.single',
    'system.string',
    'system.timespan',
    'system.uint16',
    'system.uint32',
    'system.uint64',
    'system.uri',
    'system.version',
    'system.void',
    'system.collections.hashtable',
    'system.text.regularexpressions.regex',
    'system.globalization.cultureinfo',
    'system.net.ipaddress',
    'system.net.ipendpoint',
    'system.net.mail.mailaddress',
    'system.net.networkinformation.physicaladdress',
    'system.security.securestring',
    'system.security.cryptography.x509certificates.x509certificate',
    'system.security.cryptography.x509certificates.x500distinguishedname',
    'system.xml.xmldocument',
    // System.Management.Automation.* —— PS 专属加速符的全称等价类型
    'system.management.automation.pscredential',
    'system.management.automation.pscustomobject',
    'system.management.automation.pslistmodifier',
    'system.management.automation.psobject',
    'system.management.automation.psprimitivedictionary',
    'system.management.automation.psreference',
    'system.management.automation.semanticversion',
    'system.management.automation.switchparameter',
    'system.management.automation.wildcardpattern',
    'system.management.automation.language.nullstring',
    // Microsoft.Management.Infrastructure.* —— CIM 加速符的全称等价类型
    // SECURITY: 已移除 cimsession 全称 —— 与短名存在相同的网络绑定危害
    // （对远程主机建立 CIM 会话）。
    'microsoft.management.infrastructure.cimclass',
    'microsoft.management.infrastructure.cimconverter',
    'microsoft.management.infrastructure.ciminstance',
    'microsoft.management.infrastructure.cimtype',
    // 其余短名加速符的全称等价类型
    // SECURITY: 已移除 DirectoryEntry/DirectorySearcher/ManagementObject/
    // ManagementClass/ManagementObjectSearcher 全称 —— 与
    // adsi/adsisearcher/wmi/wmiclass/wmisearcher 短名存在相同的网络绑定危害
    // （LDAP 绑定、远程 WMI）。见上方短名的移除注释。
    'system.collections.specialized.ordereddictionary',
    'system.security.accesscontrol.objectsecurity',
    // 允许的类型可以构成数组（如 [string[]]）
    // normalizeTypeName 会在查找前去掉 []，因此这里存储的是基名
    'object',
    'system.object',
    // ModuleSpecification —— 全限定名
    'microsoft.powershell.commands.modulespecification',
  ].map(t => t.toLowerCase()),
)

/**
 * 对来自 AST TypeName.FullName 或 TypeName.Name 的类型名进行归一化。
 * 处理数组后缀（[]）和泛型方括号。
 */
export function normalizeTypeName(name: string): string {
  // 去掉数组后缀："String[]" → "string"（允许类型的数组是允许的）
  // 去掉泛型参数："List[int]" → "list"（采取保守策略 —— 即便类型参数安全，
  // 泛型包装类本身可能是危险的，因此我们检查外层类型）
  return name
    .toLowerCase()
    .replace(/\[\]$/, '')
    .replace(/\[.*\]$/, '')
    .trim()
}

/**
 * 若 typeName（来自 AST）在 Microsoft 的 CLM 允许清单中则为真。
 * 不在该集合中的类型会触发询问确认——它们会访问 CLM 拦截的系统 API。
 */
export function isClmAllowedType(typeName: string): boolean {
  return CLM_ALLOWED_TYPES.has(normalizeTypeName(typeName))
}
