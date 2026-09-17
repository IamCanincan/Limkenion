/**
 * PowerShell 公共参数（所有 cmdlet 均可通过 [CmdletBinding()] 使用）。
 * 来源：about_CommonParameters（PowerShell 文档）+ Get-Command 输出。
 *
 * pathValidation.ts（并入各 cmdlet 的已知参数集）与 readOnlyValidation.ts
 * （并入 safeFlags 检查）之间共享。单独拆分出来是为了打破这两个文件之间
 * 原本会形成的循环导入。
 *
 * 以带前导连字符的小写存储——调用方会对输入执行 `.toLowerCase()`。
 */

export const COMMON_SWITCHES = ['-verbose', '-debug']

export const COMMON_VALUE_PARAMS = [
  '-erroraction',
  '-warningaction',
  '-informationaction',
  '-progressaction',
  '-errorvariable',
  '-warningvariable',
  '-informationvariable',
  '-outvariable',
  '-outbuffer',
  '-pipelinevariable',
]

export const COMMON_PARAMETERS: ReadonlySet<string> = new Set([
  ...COMMON_SWITCHES,
  ...COMMON_VALUE_PARAMS,
])
