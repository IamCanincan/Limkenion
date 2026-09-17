import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'
import { countCharInString } from 'src/utils/stringUtils.js'
import {
  DIFF_TIMEOUT_MS,
  getPatchForDisplay,
  getPatchFromContents,
} from '../../utils/diff.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  convertLeadingTabsToSpaces,
  readFileSyncCached,
} from '../../utils/file.js'
import type { EditInput, FileEdit } from './types.js'

// Limkenion 无法输出弯引号，因此我们在此将其定义为常量，供 Limkenion
// 在代码中使用。这样做是因为我们在应用编辑时会把弯引号
// 规范化为直引号。
export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

/**
 * 规范化字符串中的引号，将弯引号转换为直引号
 * @param str 待规范化的字符串
 * @returns 所有弯引号均被替换为直引号的字符串
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

/**
 * 去除字符串中每行末尾的空白，同时保留行尾符
 * @param str 待处理的字符串
 * @returns 每行末尾空白均被移除的字符串
 */
export function stripTrailingWhitespace(str: string): string {
  // 处理不同的行尾符：CRLF、LF、CR
  // 使用能匹配并捕获行尾符的正则
  const lines = str.split(/(\r\n|\n|\r)/)

  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]
    if (part !== undefined) {
      if (i % 2 === 0) {
        // 偶数索引是行内容
        result += part.replace(/\s+$/, '')
      } else {
        // 奇数索引是行尾符
        result += part
      }
    }
  }

  return result
}

/**
 * 在文件内容中查找与搜索字符串实际匹配的字符串，
 * 并考虑引号规范化
 * @param fileContent 要在其中搜索的文件内容
 * @param searchString 要搜索的字符串
 * @returns 文件中实际找到的字符串；未找到则为 null
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // 先尝试精确匹配
  if (fileContent.includes(searchString)) {
    return searchString
  }

  // 尝试使用规范化后的引号
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)

  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex !== -1) {
    // 找出文件中实际匹配的字符串
    return fileContent.substring(searchIndex, searchIndex + searchString.length)
  }

  return null
}

/**
 * 当 old_string 通过引号规范化匹配时（文件中是弯引号、
 * 模型给出的是直引号），对 new_string 应用相同的弯引号风格，
 * 使编辑保留文件的排版。
 *
 * 使用简单的开/闭启发式：引号字符前面是空白、
 * 字符串开头或开括号标点时视为开引号；
 * 否则视为闭引号。
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  // 若二者相同，则未发生规范化
  if (oldString === actualOldString) {
    return newString
  }

  // 检测文件中出现过哪些弯引号类型
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString
  }

  let result = newString

  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result)
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result)
  }

  return result
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true
  }
  const prev = chars[index - 1]
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '\u2014' || // em 破折号
    prev === '\u2013' // en 破折号
  )
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      )
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // 不要转换缩略形式中的撇号（例如 "don't"、"it's"）
      // 两个字母之间的撇号是缩略，而非引号
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        // 缩略形式中的撇号——使用右单弯引号
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        result.push(
          isOpeningContext(chars, i)
            ? LEFT_SINGLE_CURLY_QUOTE
            : RIGHT_SINGLE_CURLY_QUOTE,
        )
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * 转换编辑项，确保 replace_all 始终为布尔值
 * @param edits 带有可选 replace_all 的编辑数组
 * @returns replace_all 保证为布尔值的编辑数组
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace)

  if (newString !== '') {
    return f(originalContent, oldString, newString)
  }

  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')

  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString)
}

/**
 * 对文件应用一次编辑，返回 patch 和更新后的文件。
 * 不会将文件写入磁盘。
 */
export function getPatchForEdit({
  filePath,
  fileContents,
  oldString,
  newString,
  replaceAll = false,
}: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  return getPatchForEdits({
    filePath,
    fileContents,
    edits: [
      { old_string: oldString, new_string: newString, replace_all: replaceAll },
    ],
  })
}

/**
 * 对文件应用一组编辑，返回 patch 和更新后的文件。
 * 不会将文件写入磁盘。
 *
 * 注意：返回的 patch 仅供展示之用——它以空格代替了制表符
 */
export function getPatchForEdits({
  filePath,
  fileContents,
  edits,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  let updatedFile = fileContents
  const appliedNewStrings: string[] = []

  // 空文件的特殊处理。
  if (
    !fileContents &&
    edits.length === 1 &&
    edits[0] &&
    edits[0].old_string === '' &&
    edits[0].new_string === ''
  ) {
    const patch = getPatchForDisplay({
      filePath,
      fileContents,
      edits: [
        {
          old_string: fileContents,
          new_string: updatedFile,
          replace_all: false,
        },
      ],
    })
    return { patch, updatedFile: '' }
  }

  // 逐条应用编辑并检查它是否真正改动了文件
  for (const edit of edits) {
    // 检查前先去掉 old_string 末尾的换行
    const oldStringToCheck = edit.old_string.replace(/\n+$/, '')

    // 检查 old_string 是否是先前任一已应用 new_string 的子串
    for (const previousNewString of appliedNewStrings) {
      if (
        oldStringToCheck !== '' &&
        previousNewString.includes(oldStringToCheck)
      ) {
        throw new Error(
          'Cannot edit file: old_string is a substring of a new_string from a previous edit.',
        )
      }
    }

    const previousContent = updatedFile
    updatedFile =
      edit.old_string === ''
        ? edit.new_string
        : applyEditToFile(
            updatedFile,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          )

    // 若该编辑未产生任何改动，则抛出错误
    if (updatedFile === previousContent) {
      throw new Error('String not found in file. Failed to apply edit.')
    }

    // 记录已应用的 new_string
    appliedNewStrings.push(edit.new_string)
  }

  if (updatedFile === fileContents) {
    throw new Error(
      'Original and edited file match exactly. Failed to apply edit.',
    )
  }

  // 我们已经有前后内容，因此直接调用 getPatchFromContents。
  // 此前这会经过 getPatchForDisplay 且 edits=[{old:fileContents,new:updatedFile}]，
  // 从而对 fileContents 做两次变换（一次作为 preparedFileContents，又一次作为 reduce 内部的
  // escapedOldString）并执行一次空操作的全内容 .replace()。这在大文件上节省约 20%。
  const patch = getPatchFromContents({
    filePath,
    oldContent: convertLeadingTabsToSpaces(fileContents),
    newContent: convertLeadingTabsToSpaces(updatedFile),
  })

  return { patch, updatedFile }
}

// edited_text_file 附件片段的长度上限。此前对大文件执行保存时格式化
// 会每回合注入整个文件（观测到最大 16.1KB、约 14K
// token/会话）。8KB 既保留有意义的上下文，又限定了最坏情况。
const DIFF_SNIPPET_MAX_BYTES = 8192

/**
 * 用于附件，在文件变化时展示片段。
 *
 * TODO: 将此处的片段逻辑与其他片段逻辑统一。
 */
export function getSnippetForTwoFileDiff(
  fileAContents: string,
  fileBContents: string,
): string {
  const patch = structuredPatch(
    'file.txt',
    'file.txt',
    fileAContents,
    fileBContents,
    undefined,
    undefined,
    {
      context: 8,
      timeout: DIFF_TIMEOUT_MS,
    },
  )

  if (!patch) {
    return ''
  }

  const full = patch.hunks
    .map(_ => ({
      startLine: _.oldStart,
      content: _.lines
        // 过滤掉已删除的行以及 diff 元数据行
        .filter(_ => !_.startsWith('-') && !_.startsWith('\\'))
        .map(_ => _.slice(1))
        .join('\n'),
    }))
    .map(addLineNumbers)
    .join('\n...\n')

  if (full.length <= DIFF_SNIPPET_MAX_BYTES) {
    return full
  }

  // 在上限内能容纳的最后一个行边界处截断。
  // 标记格式与 BashTool/utils.ts 一致。
  const cutoff = full.lastIndexOf('\n', DIFF_SNIPPET_MAX_BYTES)
  const kept =
    cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES)
  const remaining = countCharInString(full, '\n', kept.length) + 1
  return `${kept}\n\n... [${remaining} lines truncated] ...`
}

const CONTEXT_LINES = 4

/**
 * 从文件中获取片段，展示带行号的 patch 周边上下文。
 * @param originalFile 应用 patch 之前的原始文件内容
 * @param patch 用于确定片段位置的 diff 块
 * @param newFile 应用 patch 之后的文件内容
 * @returns 带行号的片段文本以及起始行号
 */
export function getSnippetForPatch(
  patch: StructuredPatchHunk[],
  newFile: string,
): { formattedSnippet: string; startLine: number } {
  if (patch.length === 0) {
    // 无变化，返回空片段
    return { formattedSnippet: '', startLine: 1 }
  }

  // 找出所有 diff 块中首个和最后一个变更行
  let minLine = Infinity
  let maxLine = -Infinity

  for (const hunk of patch) {
    if (hunk.oldStart < minLine) {
      minLine = hunk.oldStart
    }
    // 对于结束行，需要考虑新增行数，因为展示的是新文件
    const hunkEnd = hunk.oldStart + (hunk.newLines || 0) - 1
    if (hunkEnd > maxLine) {
      maxLine = hunkEnd
    }
  }

  // 计算带上下文的范围
  const startLine = Math.max(1, minLine - CONTEXT_LINES)
  const endLine = maxLine + CONTEXT_LINES

  // 将新文件按行拆分并获取片段
  const fileLines = newFile.split(/\r?\n/)
  const snippetLines = fileLines.slice(startLine - 1, endLine)
  const snippet = snippetLines.join('\n')

  // 添加行号
  const formattedSnippet = addLineNumbers({
    content: snippet,
    startLine,
  })

  return { formattedSnippet, startLine }
}

/**
 * 从文件中获取片段，展示单次编辑周边的上下文。
 * 这是一个便捷函数，使用原始算法。
 * @param originalFile 原始文件内容
 * @param oldString 要替换的文本
 * @param newString 用于替换的文本
 * @param contextLines 变更前后要展示的行数
 * @returns 片段以及起始行号
 */
export function getSnippet(
  originalFile: string,
  oldString: string,
  newString: string,
  contextLines: number = 4,
): { snippet: string; startLine: number } {
  // 使用 FileEditTool.tsx 中的原始算法
  const before = originalFile.split(oldString)[0] ?? ''
  const replacementLine = before.split(/\r?\n/).length - 1
  const newFileLines = applyEditToFile(
    originalFile,
    oldString,
    newString,
  ).split(/\r?\n/)

  // 计算片段的起始和结束行号
  const startLine = Math.max(0, replacementLine - contextLines)
  const endLine =
    replacementLine + contextLines + newString.split(/\r?\n/).length

  // 获取片段
  const snippetLines = newFileLines.slice(startLine, endLine)
  const snippet = snippetLines.join('\n')

  return { snippet, startLine: startLine + 1 }
}

export function getEditsForPatch(patch: StructuredPatchHunk[]): FileEdit[] {
  return patch.map(hunk => {
    // 从该 diff 块中提取变更
    const contextLines: string[] = []
    const oldLines: string[] = []
    const newLines: string[] = []

    // 解析每一行并归类
    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        // 上下文行——两个版本中都存在
        contextLines.push(line.slice(1))
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith('-')) {
        // 删除行——仅存在于旧版本
        oldLines.push(line.slice(1))
      } else if (line.startsWith('+')) {
        // 新增行——仅存在于新版本
        newLines.push(line.slice(1))
      }
    }

    return {
      old_string: oldLines.join('\n'),
      new_string: newLines.join('\n'),
      replace_all: false,
    }
  })
}

/**
 * 包含用于把来自 Limkenion 的字符串还原（去净化）的替换项
 * 由于 Limkenion 看不到这些字符串中的任何一个（已在 API 中净化）
 * 它会在编辑响应中输出净化后的版本
 */
const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
}

/**
 * 通过应用特定替换项来规范化匹配字符串
 * 这有助于处理因格式差异导致精确匹配失败的情况
 * @returns 规范化后的字符串以及所应用的替换项
 */
function desanitizeMatchString(matchString: string): {
  result: string
  appliedReplacements: Array<{ from: string; to: string }>
} {
  let result = matchString
  const appliedReplacements: Array<{ from: string; to: string }> = []

  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const beforeReplace = result
    result = result.replaceAll(from, to)

    if (beforeReplace !== result) {
      appliedReplacements.push({ from, to })
    }
  }

  return { result, appliedReplacements }
}

/**
 * 为 FileEditTool 规范化输入
 * 若在文件中找不到要替换的字符串，则尝试使用规范化版本
 * 成功时返回规范化后的输入，否则返回原始输入
 */
export function normalizeFileEditInput({
  file_path,
  edits,
}: {
  file_path: string
  edits: EditInput[]
}): {
  file_path: string
  edits: EditInput[]
} {
  if (edits.length === 0) {
    return { file_path, edits }
  }

  // Markdown 用两个行尾空格表示硬换行——剥离会
  // 悄然改变语义。对 .md/.mdx 跳过 stripTrailingWhitespace。
  const isMarkdown = /\.(md|mdx)$/i.test(file_path)

  try {
    const fullPath = expandPath(file_path)

    // 使用带缓存的文件读取，避免冗余 I/O 操作。
    // 若文件不存在，readFileSyncCached 会抛出 ENOENT，由下方的
    // catch 处理并返回原始输入（不做 TOCTOU 预检查）。
    const fileContent = readFileSyncCached(fullPath)

    return {
      file_path,
      edits: edits.map(({ old_string, new_string, replace_all }) => {
        const normalizedNewString = isMarkdown
          ? new_string
          : stripTrailingWhitespace(new_string)

        // 若精确字符串匹配成功，则保持不变
        if (fileContent.includes(old_string)) {
          return {
            old_string,
            new_string: normalizedNewString,
            replace_all,
          }
        }

        // 若精确匹配失败，尝试对字符串去净化
        const { result: desanitizedOldString, appliedReplacements } =
          desanitizeMatchString(old_string)

        if (fileContent.includes(desanitizedOldString)) {
          // 对 new_string 应用相同的精确替换
          let desanitizedNewString = normalizedNewString
          for (const { from, to } of appliedReplacements) {
            desanitizedNewString = desanitizedNewString.replaceAll(from, to)
          }

          return {
            old_string: desanitizedOldString,
            new_string: desanitizedNewString,
            replace_all,
          }
        }

        return {
          old_string,
          new_string: normalizedNewString,
          replace_all,
        }
      }),
    }
  } catch (error) {
    // 若读取文件出现任何错误，直接返回原始输入。
    // 当文件尚不存在（例如新文件）时，ENOENT 属预期情况。
    if (!isENOENT(error)) {
      logError(error)
    }
  }

  return { file_path, edits }
}

/**
 * 通过将两组编辑分别应用到原始内容并比较结果，
 * 判断它们是否等价。
 * 这处理了编辑内容不同但产生相同结果的情况。
 */
export function areFileEditsEquivalent(
  edits1: FileEdit[],
  edits2: FileEdit[],
  originalContent: string,
): boolean {
  // 快速路径：检查编辑是否字面完全相同
  if (
    edits1.length === edits2.length &&
    edits1.every((edit1, index) => {
      const edit2 = edits2[index]
      return (
        edit2 !== undefined &&
        edit1.old_string === edit2.old_string &&
        edit1.new_string === edit2.new_string &&
        edit1.replace_all === edit2.replace_all
      )
    })
  ) {
    return true
  }

  // 尝试应用两组编辑
  let result1: { patch: StructuredPatchHunk[]; updatedFile: string } | null =
    null
  let error1: string | null = null
  let result2: { patch: StructuredPatchHunk[]; updatedFile: string } | null =
    null
  let error2: string | null = null

  try {
    result1 = getPatchForEdits({
      filePath: 'temp',
      fileContents: originalContent,
      edits: edits1,
    })
  } catch (e) {
    error1 = errorMessage(e)
  }

  try {
    result2 = getPatchForEdits({
      filePath: 'temp',
      fileContents: originalContent,
      edits: edits2,
    })
  } catch (e) {
    error2 = errorMessage(e)
  }

  // 若两者都抛错，仅当错误相同时才视为相等
  if (error1 !== null && error2 !== null) {
    // 规范化错误消息以便比较
    return error1 === error2
  }

  // 若一个抛错而另一个没有，则二者不相等
  if (error1 !== null || error2 !== null) {
    return false
  }

  // 两者都成功——比较结果
  return result1!.updatedFile === result2!.updatedFile
}

/**
 * 统一函数，用于检查两组文件编辑输入是否等价。
 * 处理文件编辑（FileEditTool）。
 */
export function areFileEditsInputsEquivalent(
  input1: {
    file_path: string
    edits: FileEdit[]
  },
  input2: {
    file_path: string
    edits: FileEdit[]
  },
): boolean {
  // 快速路径：文件不同
  if (input1.file_path !== input2.file_path) {
    return false
  }

  // 快速路径：字面相等
  if (
    input1.edits.length === input2.edits.length &&
    input1.edits.every((edit1, index) => {
      const edit2 = input2.edits[index]
      return (
        edit2 !== undefined &&
        edit1.old_string === edit2.old_string &&
        edit1.new_string === edit2.new_string &&
        edit1.replace_all === edit2.replace_all
      )
    })
  ) {
    return true
  }

  // 语义比较（需要读取文件）。若文件不存在，
  // 则与空内容比较（不做 TOCTOU 预检查）。
  let fileContent = ''
  try {
    fileContent = readFileSyncCached(input1.file_path)
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }

  return areFileEditsEquivalent(input1.edits, input2.edits, fileContent)
}
