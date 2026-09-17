import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath, toRelativePath } from '../../utils/path.js'
import {
  checkReadPermissionForTool,
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { getGlobExclusionsForPluginCache } from '../../utils/plugins/orphanedPluginFilter.js'
import { ripGrep } from '../../utils/ripgrep.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { plural } from '../../utils/stringUtils.js'
import { GREP_TOOL_NAME, getDescription } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z
      .string()
      .describe(
        '在文件内容中搜索的正则表达式模式',
      ),
    path: z
      .string()
      .optional()
      .describe(
        '要搜索的文件或目录（rg PATH）。默认为当前工作目录。',
      ),
    glob: z
      .string()
      .optional()
      .describe(
        '用于过滤文件的 glob 模式（例如 "*.js"、"*.{ts,tsx}"）——映射到 rg --glob',
      ),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe(
        '输出模式："content" 显示匹配行（支持 -A/-B/-C 上下文、-n 行号、head_limit），"files_with_matches" 显示文件路径（支持 head_limit），"count" 显示匹配计数（支持 head_limit）。默认为 "files_with_matches"。',
      ),
    '-B': semanticNumber(z.number().optional()).describe(
      '每个匹配之前显示的出行数（rg -B）。需要 output_mode: "content"，否则忽略。',
    ),
    '-A': semanticNumber(z.number().optional()).describe(
      '每个匹配之后显示的出行数（rg -A）。需要 output_mode: "content"，否则忽略。',
    ),
    '-C': semanticNumber(z.number().optional()).describe('上下文的别名。'),
    context: semanticNumber(z.number().optional()).describe(
      '每个匹配之前和之后显示的出行数（rg -C）。需要 output_mode: "content"，否则忽略。',
    ),
    '-n': semanticBoolean(z.boolean().optional()).describe(
      '在输出中显示行号（rg -n）。需要 output_mode: "content"，否则忽略。默认为 true。',
    ),
    '-i': semanticBoolean(z.boolean().optional()).describe(
      '不区分大小写的搜索（rg -i）',
    ),
    type: z
      .string()
      .optional()
      .describe(
        '要搜索的文件类型（rg --type）。常见类型：js、py、rust、go、java 等。对标准文件类型比 include 更高效。',
      ),
    head_limit: semanticNumber(z.number().optional()).describe(
      '将输出限制为前 N 行/条目，等价于 "| head -N"。适用于所有输出模式：content（限制输出行）、files_with_matches（限制文件路径）、count（限制计数条目）。未指定时默认为 250。传 0 表示不限制（请谨慎使用——大型结果集会浪费上下文）。',
    ),
    offset: semanticNumber(z.number().optional()).describe(
      '应用 head_limit 之前跳过前 N 行/条目，等价于 "| tail -n +N | head -N"。适用于所有输出模式。默认为 0。',
    ),
    multiline: semanticBoolean(z.boolean().optional()).describe(
      '启用多行模式，其中 . 匹配换行符且模式可跨行（rg -U --multiline-dotall）。默认：false。',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 搜索时排除的版本控制系统目录
// 这些目录会被自动排除，因为它们会在搜索结果中产生噪声
const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
] as const

// head_limit 未指定时 grep 结果的默认上限。无限制的 content 模式
// grep 可能填满 20KB 的持久化阈值（在 grep 密集的会话中约 6-24K token/次）。
// 250 对探索性搜索足够宽裕，同时可防止上下文膨胀。
// 显式传入 head_limit=0 表示不限制。
const DEFAULT_HEAD_LIMIT = 250

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  // 显式传入 0 = 无限制的逃生通道
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  // 仅在确实发生截断时才报告 appliedLimit，使模型
  // 知道可能还有更多结果，并可用 offset 分页。
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}

// 格式化 limit/offset 信息，用于在工具结果中展示。
// appliedLimit 仅在确实发生截断时才会设置（见 applyHeadLimit），
// 因此即使设置了 appliedOffset，它也可能为 undefined——有条件地拼接各部分，
// 以避免 "limit: undefined" 出现在用户可见输出中。
function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

const outputSchema = lazySchema(() =>
  z.object({
    mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    numFiles: z.number(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().optional(), // 用于 content 模式
    numMatches: z.number().optional(), // 用于 count 模式
    appliedLimit: z.number().optional(), // 实际应用的上限（若有）
    appliedOffset: z.number().optional(), // 实际应用的偏移量
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  searchHint: 'search file contents with regex (ripgrep)',
  // 20K 字符——工具结果持久化阈值
  maxResultSizeChars: 20_000,
  strict: true,
  async description() {
    return getDescription()
  },
  userFacingName() {
    return 'Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.path ? `${input.pattern} in ${input.path}` : input.pattern
  },
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  getPath({ path }): string {
    return path || getCwd()
  },
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
  async validateInput({ path }): Promise<ValidationResult> {
    // 若提供了 path，则校验其存在
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // SECURITY: 对 UNC 路径跳过文件系统操作，以防 NTLM 凭据泄露。
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

      try {
        await fs.stat(absolutePath)
      } catch (e: unknown) {
        if (isENOENT(e)) {
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Path does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
          if (cwdSuggestion) {
            message += ` Did you mean ${cwdSuggestion}?`
          }
          return {
            result: false,
            message,
            errorCode: 1,
          }
        }
        throw e
      }
    }

    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GrepTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return getDescription()
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // SearchResultSummary 显示 content（mode=content）或 filenames.join。
  // numFiles/numLines/numMatches 是装饰信息（"Found 3 files"）——跳过没问题
  // （少计，而非幻影）。Glob 通过 UI.tsx:65 复用此处。
  extractSearchText({ mode, content, filenames }) {
    if (mode === 'content' && content) return content
    return filenames.join('\n')
  },
  mapToolResultToToolResultBlockParam(
    {
      mode = 'files_with_matches',
      numFiles,
      filenames,
      content,
      numLines: _numLines,
      numMatches,
      appliedLimit,
      appliedOffset,
    },
    toolUseID,
  ) {
    if (mode === 'content') {
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      const resultContent = content || 'No matches found'
      const finalContent = limitInfo
        ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
        : resultContent
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: finalContent,
      }
    }

    if (mode === 'count') {
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      const rawContent = content || 'No matches found'
      const matches = numMatches ?? 0
      const files = numFiles ?? 0
      const summary = `\n\nFound ${matches} total ${matches === 1 ? 'occurrence' : 'occurrences'} across ${files} ${files === 1 ? 'file' : 'files'}.${limitInfo ? ` with pagination = ${limitInfo}` : ''}`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: rawContent + summary,
      }
    }

    // files_with_matches 模式
    const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
    if (numFiles === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
      }
    }
    // head_limit 已在 call() 方法中应用，因此直接显示全部文件名
    const result = `Found ${numFiles} ${plural(numFiles, 'file')}${limitInfo ? ` ${limitInfo}` : ''}\n${filenames.join('\n')}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
  async call(
    {
      pattern,
      path,
      glob,
      type,
      output_mode = 'files_with_matches',
      '-B': context_before,
      '-A': context_after,
      '-C': context_c,
      context,
      '-n': show_line_numbers = true,
      '-i': case_insensitive = false,
      head_limit,
      offset = 0,
      multiline = false,
    },
    { abortController, getAppState },
  ) {
    const absolutePath = path ? expandPath(path) : getCwd()
    const args = ['--hidden']

    // 排除 VCS 目录，避免版本控制元数据带来噪声
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push('--glob', `!${dir}`)
    }

    // 限制行长度，防止 base64/压缩内容扰乱输出
    args.push('--max-columns', '500')

    // 仅在显式请求时应用 multiline 标志
    if (multiline) {
      args.push('-U', '--multiline-dotall')
    }

    // 添加可选标志
    if (case_insensitive) {
      args.push('-i')
    }

    // 添加输出模式标志
    if (output_mode === 'files_with_matches') {
      args.push('-l')
    } else if (output_mode === 'count') {
      args.push('-c')
    }

    // 若请求则添加行号
    if (show_line_numbers && output_mode === 'content') {
      args.push('-n')
    }

    // 添加上下文标志（-C/context 优先于 context_before/context_after）
    if (output_mode === 'content') {
      if (context !== undefined) {
        args.push('-C', context.toString())
      } else if (context_c !== undefined) {
        args.push('-C', context_c.toString())
      } else {
        if (context_before !== undefined) {
          args.push('-B', context_before.toString())
        }
        if (context_after !== undefined) {
          args.push('-A', context_after.toString())
        }
      }
    }

    // 若 pattern 以短横线开头，使用 -e 标志将其指定为模式
    // 这可以防止 ripgrep 将其解释为命令行选项
    if (pattern.startsWith('-')) {
      args.push('-e', pattern)
    } else {
      args.push(pattern)
    }

    // 若指定则添加类型过滤
    if (type) {
      args.push('--type', type)
    }

    if (glob) {
      // 按逗号和空格切分，但保留带花括号的 pattern
      const globPatterns: string[] = []
      const rawPatterns = glob.split(/\s+/)

      for (const rawPattern of rawPatterns) {
        // 若 pattern 含花括号，则不再切分
        if (rawPattern.includes('{') && rawPattern.includes('}')) {
          globPatterns.push(rawPattern)
        } else {
          // 对不含花括号的 pattern 按逗号切分
          globPatterns.push(...rawPattern.split(',').filter(Boolean))
        }
      }

      for (const globPattern of globPatterns.filter(Boolean)) {
        args.push('--glob', globPattern)
      }
    }

    // 添加忽略模式
    const appState = getAppState()
    const ignorePatterns = normalizePatternsToPath(
      getFileReadIgnorePatterns(appState.toolPermissionContext),
      getCwd(),
    )
    for (const ignorePattern of ignorePatterns) {
      // 注意：ripgrep 只相对于工作目录应用 gitignore 模式
      // 因此对于非绝对路径，需要给它们加上 '**' 前缀
      // 参见：https://github.com/BurntSushi/ripgrep/discussions/2156#discussioncomment-2316335
      //
      // 还需要用 `!` 取反模式以将其排除
      const rgIgnorePattern = ignorePattern.startsWith('/')
        ? `!${ignorePattern}`
        : `!**/${ignorePattern}`
      args.push('--glob', rgIgnorePattern)
    }

    // 排除孤立的插件版本目录
    for (const exclusion of await getGlobExclusionsForPluginCache(
      absolutePath,
    )) {
      args.push('--glob', exclusion)
    }

    // WSL 下文件读取有严重性能损耗（WSL2 上慢 3-5 倍）
    // 超时由 ripgrep 自身通过 execFile 的 timeout 选项处理
    // 我们不用 AbortController 做超时，以免打断 agent 循环
    // 若 ripgrep 超时，会抛出 RipgrepTimeoutError 并向上传播，
    // 使 Limkenion 知道搜索并未完成（而不是认为没有匹配）
    const results = await ripGrep(args, absolutePath, abortController.signal)

    if (output_mode === 'content') {
      // 对于 content 模式，结果是实际的内容行
      // 将绝对路径转为相对路径以节省 token

      // 先应用 head_limit——相对化是逐行的工作，因此
      // 避免处理将被丢弃的行（宽泛的 pattern 可能
      // 返回 1 万多行，而 head_limit 只保留约 30-100 行）。
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )

      const finalLines = limitedResults.map(line => {
        // 行的格式为：/absolute/path:line_content 或 /absolute/path:num:content
        const colonIndex = line.indexOf(':')
        if (colonIndex > 0) {
          const filePath = line.substring(0, colonIndex)
          const rest = line.substring(colonIndex)
          return toRelativePath(filePath) + rest
        }
        return line
      })
      const output = {
        mode: 'content' as const,
        numFiles: 0, // 不适用于 content 模式
        filenames: [],
        content: finalLines.join('\n'),
        numLines: finalLines.length,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
      }
      return { data: output }
    }

    if (output_mode === 'count') {
      // 对于 count 模式，直接透传 ripgrep 原始输出（filename:count 格式）
      // 先应用 head_limit，避免对将被丢弃的条目做相对化。
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )

      // 将绝对路径转为相对路径以节省 token
      const finalCountLines = limitedResults.map(line => {
        // 行的格式为：/absolute/path:count
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const filePath = line.substring(0, colonIndex)
          const count = line.substring(colonIndex)
          return toRelativePath(filePath) + count
        }
        return line
      })

      // 解析 count 输出以提取总匹配数和文件数
      let totalMatches = 0
      let fileCount = 0
      for (const line of finalCountLines) {
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const countStr = line.substring(colonIndex + 1)
          const count = parseInt(countStr, 10)
          if (!isNaN(count)) {
            totalMatches += count
            fileCount += 1
          }
        }
      }

      const output = {
        mode: 'count' as const,
        numFiles: fileCount,
        filenames: [],
        content: finalCountLines.join('\n'),
        numMatches: totalMatches,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
      }
      return { data: output }
    }

    // 对于 files_with_matches 模式（默认）
    // 使用 allSettled，使单个 ENOENT（文件在 ripgrep 扫描与
    // 此次 stat 之间被删除）不会导致整批失败。失败的 stat 按 mtime 0 排序。
    const stats = await Promise.allSettled(
      results.map(_ => getFsImplementation().stat(_)),
    )
    const sortedMatches = results
      // 按修改时间排序
      .map((_, i) => {
        const r = stats[i]!
        return [
          _,
          r.status === 'fulfilled' ? (r.value.mtimeMs ?? 0) : 0,
        ] as const
      })
      .sort((a, b) => {
        if (process.env.NODE_ENV === 'test') {
          // 在测试中我们始终按文件名排序，以保证结果确定性
          return a[0].localeCompare(b[0])
        }
        const timeComparison = b[1] - a[1]
        if (timeComparison === 0) {
          // 以文件名作为并列时的排序依据
          return a[0].localeCompare(b[0])
        }
        return timeComparison
      })
      .map(_ => _[0])

    // 对排序后的文件列表应用 head_limit（类似 "| head -N"）
    const { items: finalMatches, appliedLimit } = applyHeadLimit(
      sortedMatches,
      head_limit,
      offset,
    )

    // 将绝对路径转为相对路径以节省 token
    const relativeMatches = finalMatches.map(toRelativePath)

    const output = {
      mode: 'files_with_matches' as const,
      filenames: relativeMatches,
      numFiles: relativeMatches.length,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
    }

    return {
      data: output,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
