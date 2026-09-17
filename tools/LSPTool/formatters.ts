import { relative } from 'path'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  SymbolInformation,
  SymbolKind,
} from 'vscode-languageserver-types'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { plural } from '../../utils/stringUtils.js'

/**
 * 将 URI 格式化为相对路径（如果可能）。
 * 处理 URI 解码，并在 URI 格式异常时优雅地回退到未解码的路径。
 * 仅在相对路径更短且不以 ../../ 开头时使用相对路径。
 */
function formatUri(uri: string | undefined, cwd?: string): string {
  // 处理 undefined/null URI - 表示 LSP 数据格式异常
  if (!uri) {
    // 注意: 本应在更早处通过适当的错误日志捕获
    // 这里是格式化层的防御性兜底
    logForDebugging(
      'formatUri 被调用时 URI 为 undefined - 表示 LSP 服务器响应格式异常',
      { level: 'warn' },
    )
    return '<未知位置>'
  }

  // 若存在 file:// 协议前缀则移除。
  // 在 Windows 上，file:///C:/path 在替换掉 file:// 后变成 /C:/path。
  // 对于 Windows 盘符路径，需要去掉开头的斜杠。
  let filePath = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }

  // 解码 URI 编码 - 优雅地处理格式异常的 URI
  try {
    filePath = decodeURIComponent(filePath)
  } catch (error) {
    // 记录日志用于调试，但使用未解码的路径继续执行
    const errorMsg = errorMessage(error)
    logForDebugging(
      `解码 LSP URI '${uri}' 失败: ${errorMsg}。改用未解码的路径: ${filePath}`,
      { level: 'warn' },
    )
    // filePath 已包含未解码的路径，仍然可用
  }

  // 若提供了 cwd，则转换为相对路径
  if (cwd) {
    // 统一分隔符为正斜杠，保证显示输出一致
    const relativePath = relative(cwd, filePath).replaceAll('\\', '/')
    // 仅当相对路径更短且不以 ../ 开头时使用相对路径
    if (
      relativePath.length < filePath.length &&
      !relativePath.startsWith('../../')
    ) {
      return relativePath
    }
  }

  // 统一分隔符为正斜杠，保证显示输出一致
  return filePath.replaceAll('\\', '/')
}

/**
 * 按文件 URI 对结果进行分组。
 * 支持 Location[] 和 SymbolInformation[] 的通用辅助函数。
 */
function groupByFile<T extends { uri: string } | { location: { uri: string } }>(
  items: T[],
  cwd?: string,
): Map<string, T[]> {
  const byFile = new Map<string, T[]>()
  for (const item of items) {
    const uri = 'uri' in item ? item.uri : item.location.uri
    const filePath = formatUri(uri, cwd)
    const existingItems = byFile.get(filePath)
    if (existingItems) {
      existingItems.push(item)
    } else {
      byFile.set(filePath, [item])
    }
  }
  return byFile
}

/**
 * 格式化 Location，包含文件路径和行/字符位置
 */
function formatLocation(location: Location, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd)
  const line = location.range.start.line + 1 // 转换为 1 起始
  const character = location.range.start.character + 1 // 转换为 1 起始
  return `${filePath}:${line}:${character}`
}

/**
 * 将 LocationLink 转换为 Location 格式以便统一处理
 */
function locationLinkToLocation(link: LocationLink): Location {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  }
}

/**
 * 判断对象是否为 LocationLink（含 targetUri），而非 Location（含 uri）
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

/**
 * 格式化 goToDefinition 的结果
 * 可能是 Location、LocationLink，或两者之一的数组
 */
export function formatGoToDefinitionResult(
  result: Location | Location[] | LocationLink | LocationLink[] | null,
  cwd?: string,
): string {
  if (!result) {
    return '未找到定义。这可能是由于光标不在某个符号上，或定义位于 LSP 服务器未索引的外部库中。'
  }

  if (Array.isArray(result)) {
    // 将 LocationLinks 转为 Locations 以便统一处理
    const locations: Location[] = result.map(item =>
      isLocationLink(item) ? locationLinkToLocation(item) : item,
    )

    // 记录并过滤掉 uri 为 undefined 的位置
    const invalidLocations = locations.filter(loc => !loc || !loc.uri)
    if (invalidLocations.length > 0) {
      logForDebugging(
        `formatGoToDefinitionResult: 过滤掉 ${invalidLocations.length} 个无效位置 - 这本应在更早处捕获`,
        { level: 'warn' },
      )
    }

    const validLocations = locations.filter(loc => loc && loc.uri)

    if (validLocations.length === 0) {
      return '未找到定义。这可能是由于光标不在某个符号上，或定义位于 LSP 服务器未索引的外部库中。'
    }
    if (validLocations.length === 1) {
      return `定义于 ${formatLocation(validLocations[0]!, cwd)}`
    }
    const locationList = validLocations
      .map(loc => `  ${formatLocation(loc, cwd)}`)
      .join('\n')
    return `找到 ${validLocations.length} 个定义:\n${locationList}`
  }

  // 单个结果 - 必要时转换 LocationLink
  const location = isLocationLink(result)
    ? locationLinkToLocation(result)
    : result
  return `定义于 ${formatLocation(location, cwd)}`
}

/**
 * 格式化 findReferences 的结果
 */
export function formatFindReferencesResult(
  result: Location[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '未找到引用。这可能是由于该符号没有任何用法，或 LSP 服务器尚未完全索引工作区。'
  }

  // 记录并过滤掉 uri 为 undefined 的位置
  const invalidLocations = result.filter(loc => !loc || !loc.uri)
  if (invalidLocations.length > 0) {
    logForDebugging(
      `formatFindReferencesResult: 过滤掉 ${invalidLocations.length} 个无效位置 - 这本应在更早处捕获`,
      { level: 'warn' },
    )
  }

  const validLocations = result.filter(loc => loc && loc.uri)

  if (validLocations.length === 0) {
    return '未找到引用。这可能是由于该符号没有任何用法，或 LSP 服务器尚未完全索引工作区。'
  }

  if (validLocations.length === 1) {
    return `找到 1 个引用:\n  ${formatLocation(validLocations[0]!, cwd)}`
  }

  // 按文件对引用进行分组
  const byFile = groupByFile(validLocations, cwd)

  const lines: string[] = [
    `在 ${byFile.size} 个文件中找到 ${validLocations.length} 个引用:`,
  ]

  for (const [filePath, locations] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const loc of locations) {
      const line = loc.range.start.line + 1
      const character = loc.range.start.character + 1
      lines.push(`  行 ${line}:${character}`)
    }
  }

  return lines.join('\n')
}

/**
 * 从 MarkupContent 或 MarkedString 中提取文本内容
 */
function extractMarkupText(
  contents: MarkupContent | MarkedString | MarkedString[],
): string {
  if (Array.isArray(contents)) {
    return contents
      .map(item => {
        if (typeof item === 'string') {
          return item
        }
        return item.value
      })
      .join('\n\n')
  }

  if (typeof contents === 'string') {
    return contents
  }

  if ('kind' in contents) {
    // MarkupContent
    return contents.value
  }

  // MarkedString 对象
  return contents.value
}

/**
 * 格式化 hover 的结果
 */
export function formatHoverResult(result: Hover | null, _cwd?: string): string {
  if (!result) {
    return '没有可用的悬停信息。这可能是由于光标不在某个符号上，或 LSP 服务器尚未完全索引该文件。'
  }

  const content = extractMarkupText(result.contents)

  if (result.range) {
    const line = result.range.start.line + 1
    const character = result.range.start.character + 1
    return `位置 ${line}:${character} 的悬停信息:\n\n${content}`
  }

  return content
}

/**
 * 将 SymbolKind 枚举映射为可读字符串
 */
function symbolKindToString(kind: SymbolKind): string {
  const kinds: Record<SymbolKind, string> = {
    [1]: '文件',
    [2]: '模块',
    [3]: '命名空间',
    [4]: '包',
    [5]: '类',
    [6]: '方法',
    [7]: '属性',
    [8]: '字段',
    [9]: '构造函数',
    [10]: '枚举',
    [11]: '接口',
    [12]: '函数',
    [13]: '变量',
    [14]: '常量',
    [15]: '字符串',
    [16]: '数字',
    [17]: '布尔',
    [18]: '数组',
    [19]: '对象',
    [20]: '键',
    [21]: '空值',
    [22]: '枚举成员',
    [23]: '结构体',
    [24]: '事件',
    [25]: '运算符',
    [26]: '类型参数',
  }
  return kinds[kind] || '未知'
}

/**
 * 格式化单个 DocumentSymbol，带缩进
 */
function formatDocumentSymbolNode(
  symbol: DocumentSymbol,
  indent: number = 0,
): string[] {
  const lines: string[] = []
  const prefix = '  '.repeat(indent)
  const kind = symbolKindToString(symbol.kind)

  let line = `${prefix}${symbol.name} (${kind})`
  if (symbol.detail) {
    line += ` ${symbol.detail}`
  }

  const symbolLine = symbol.range.start.line + 1
  line += ` - 行 ${symbolLine}`

  lines.push(line)

  // 递归格式化子节点
  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1))
    }
  }

  return lines
}

/**
 * 格式化 documentSymbol 的结果（层级大纲）
 * 同时处理 DocumentSymbol[]（层级结构，含 range）和 SymbolInformation[]（扁平结构，含 location.range），
 * 因为 LSP 规范允许 textDocument/documentSymbol 返回其中任一种格式
 */
export function formatDocumentSymbolResult(
  result: DocumentSymbol[] | SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '文档中未找到符号。这可能是由于文件为空、LSP 服务器不支持该文件，或服务器尚未完全索引该文件。'
  }

  // 检测格式: DocumentSymbol 直接包含 'range'，SymbolInformation 包含 'location.range'
  // 检查第一个有效元素以确定格式
  const firstSymbol = result[0]
  const isSymbolInformation = firstSymbol && 'location' in firstSymbol

  if (isSymbolInformation) {
    // 交给工作区符号格式化函数处理，它支持 SymbolInformation[]
    return formatWorkspaceSymbolResult(result as SymbolInformation[], cwd)
  }

  // 处理 DocumentSymbol[] 格式（层级结构）
  const lines: string[] = ['文档符号:']

  for (const symbol of result as DocumentSymbol[]) {
    lines.push(...formatDocumentSymbolNode(symbol))
  }

  return lines.join('\n')
}

/**
 * 格式化 workspaceSymbol 的结果（扁平的符号列表）
 */
export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '工作区中未找到符号。这可能是由于工作区为空，或 LSP 服务器尚未完成对项目的索引。'
  }

  // 记录并过滤掉 location.uri 为 undefined 的符号
  const invalidSymbols = result.filter(
    sym => !sym || !sym.location || !sym.location.uri,
  )
  if (invalidSymbols.length > 0) {
    logForDebugging(
      `formatWorkspaceSymbolResult: 过滤掉 ${invalidSymbols.length} 个无效符号 - 这本应在更早处捕获`,
      { level: 'warn' },
    )
  }

  const validSymbols = result.filter(
    sym => sym && sym.location && sym.location.uri,
  )

  if (validSymbols.length === 0) {
    return '工作区中未找到符号。这可能是由于工作区为空，或 LSP 服务器尚未完成对项目的索引。'
  }

  const lines: string[] = [
    `在工作区中找到 ${validSymbols.length} 个${plural(validSymbols.length, '符号')}:`,
  ]

  // 按文件分组
  const byFile = groupByFile(validSymbols, cwd)

  for (const [filePath, symbols] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const symbol of symbols) {
      const kind = symbolKindToString(symbol.kind)
      const line = symbol.location.range.start.line + 1
      let symbolLine = `  ${symbol.name} (${kind}) - 行 ${line}`

      // 若存在所属容器名称则附加
      if (symbol.containerName) {
        symbolLine += ` 位于 ${symbol.containerName} 中`
      }

      lines.push(symbolLine)
    }
  }

  return lines.join('\n')
}

/**
 * 格式化单个 CallHierarchyItem 及其位置。
 * 在格式化前校验 URI，以处理格式异常的 LSP 数据。
 */
function formatCallHierarchyItem(
  item: CallHierarchyItem,
  cwd?: string,
): string {
  // 校验 URI - 优雅地处理 undefined/null
  if (!item.uri) {
    logForDebugging(
      'formatCallHierarchyItem: CallHierarchyItem 的 URI 为 undefined',
      { level: 'warn' },
    )
    return `${item.name} (${symbolKindToString(item.kind)}) - <未知位置>`
  }

  const filePath = formatUri(item.uri, cwd)
  const line = item.range.start.line + 1
  const kind = symbolKindToString(item.kind)
  let result = `${item.name} (${kind}) - ${filePath}:${line}`
  if (item.detail) {
    result += ` [${item.detail}]`
  }
  return result
}

/**
 * 格式化 prepareCallHierarchy 的结果
 * 返回指定位置的调用层级项
 */
export function formatPrepareCallHierarchyResult(
  result: CallHierarchyItem[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '此位置未找到调用层级项'
  }

  if (result.length === 1) {
    return `调用层级项: ${formatCallHierarchyItem(result[0]!, cwd)}`
  }

  const lines = [`找到 ${result.length} 个调用层级项:`]
  for (const item of result) {
    lines.push(`  ${formatCallHierarchyItem(item, cwd)}`)
  }
  return lines.join('\n')
}

/**
 * 格式化 incomingCalls 的结果
 * 展示所有调用该目标的函数/方法
 */
export function formatIncomingCallsResult(
  result: CallHierarchyIncomingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '未找到传入调用（没有内容调用此函数）'
  }

  const lines = [
    `找到 ${result.length} 个传入${plural(result.length, '调用')}:`,
  ]

  // 按文件分组
  const byFile = new Map<string, CallHierarchyIncomingCall[]>()
  for (const call of result) {
    if (!call.from) {
      logForDebugging(
        'formatIncomingCallsResult: CallHierarchyIncomingCall 的 from 字段为 undefined',
        { level: 'warn' },
      )
      continue
    }
    const filePath = formatUri(call.from.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) {
      existing.push(call)
    } else {
      byFile.set(filePath, [call])
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.from) {
        continue // 上面已记录日志
      }
      const kind = symbolKindToString(call.from.kind)
      const line = call.from.range.start.line + 1
      let callLine = `  ${call.from.name} (${kind}) - 行 ${line}`

      // 展示调用方内部的调用位置
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [调用位置: ${callSites}]`
      }

      lines.push(callLine)
    }
  }

  return lines.join('\n')
}

/**
 * 格式化 outgoingCalls 的结果
 * 展示目标调用的所有函数/方法
 */
export function formatOutgoingCallsResult(
  result: CallHierarchyOutgoingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return '未找到传出调用（此函数未调用任何内容）'
  }

  const lines = [
    `找到 ${result.length} 个传出${plural(result.length, '调用')}:`,
  ]

  // 按文件分组
  const byFile = new Map<string, CallHierarchyOutgoingCall[]>()
  for (const call of result) {
    if (!call.to) {
      logForDebugging(
        'formatOutgoingCallsResult: CallHierarchyOutgoingCall 的 to 字段为 undefined',
        { level: 'warn' },
      )
      continue
    }
    const filePath = formatUri(call.to.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) {
      existing.push(call)
    } else {
      byFile.set(filePath, [call])
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.to) {
        continue // 上面已记录日志
      }
      const kind = symbolKindToString(call.to.kind)
      const line = call.to.range.start.line + 1
      let callLine = `  ${call.to.name} (${kind}) - 行 ${line}`

      // 展示当前函数内部的调用位置
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [来自调用: ${callSites}]`
      }

      lines.push(callLine)
    }
  }

  return lines.join('\n')
}