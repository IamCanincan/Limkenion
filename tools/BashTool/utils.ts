import type {
  Base64ImageSource,
  ContentBlockParam,
  ToolResultBlockParam,
} from '../../types/llm-protocol.js'
import { readFile, stat } from 'fs/promises'
import { getOriginalCwd } from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { pathInAllowedWorkingPath } from 'src/utils/permissions/filesystem.js'
import { setCwd } from 'src/utils/Shell.js'
import { shouldMaintainProjectWorkingDir } from '../../utils/envUtils.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { getMaxOutputLength } from '../../utils/shell/outputLimits.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'
/**
 * 去除首尾仅含空白/换行的行。
 * 与 trim() 不同，这会保留内容行内的空白，只移除
 * 开头和结尾处完全为空的行。
 */
export function stripEmptyLines(content: string): string {
  const lines = content.split('\n')

  // 查找第一个非空行
  let startIndex = 0
  while (startIndex < lines.length && lines[startIndex]?.trim() === '') {
    startIndex++
  }

  // 查找最后一个非空行
  let endIndex = lines.length - 1
  while (endIndex >= 0 && lines[endIndex]?.trim() === '') {
    endIndex--
  }

  // 若所有行都为空，返回空字符串
  if (startIndex > endIndex) {
    return ''
  }

  // 返回包含非空行的切片
  return lines.slice(startIndex, endIndex + 1).join('\n')
}

/**
 * 检查内容是否为 base64 编码的图片 data URL
 */
export function isImageOutput(content: string): boolean {
  return /^data:image\/[a-z0-9.+_-]+;base64,/i.test(content)
}

const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/

/**
 * 将 data-URI 字符串解析为媒体类型和 base64 负载。
 * 匹配前会先对输入做 trim。
 */
export function parseDataUri(
  s: string,
): { mediaType: string; data: string } | null {
  const match = s.trim().match(DATA_URI_RE)
  if (!match || !match[1] || !match[2]) return null
  return { mediaType: match[1], data: match[2] }
}

/**
 * 从含 data URI 的 shell stdout 构建图片 tool_result 块。
 * 解析失败时返回 null，以便调用方降级到文本处理。
 */
export function buildImageToolResult(
  stdout: string,
  toolUseID: string,
): ToolResultBlockParam | null {
  const parsed = parseDataUri(stdout)
  if (!parsed) return null
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType as Base64ImageSource['media_type'],
          data: parsed.data,
        },
      },
    ],
  }
}

// 将文件读取上限设为 20 MB——任何大于此值的图片 data URI
// 都远超 API 的接受范围（5 MB base64），读入内存
// 会导致 OOM。
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024

/**
 * 调整来自 shell 工具的图片输出大小。从 shell 输出文件读回时，stdout 会被
 * getMaxOutputLength() 截断——若完整输出已落盘，则从磁盘重新读取，
 * 因为被截断的 base64 解码后会得到损坏的图片，要么在此处抛错，
 * 要么被 API 拒绝。同时限制尺寸：compressImageBuffer 只检查字节大小，
 * 因此一个小体积但高 DPI 的 PNG（例如 matplotlib 的 dpi=300）会以完整
 * 分辨率通过，并拖累多图请求（CC-304）。
 *
 * 成功时返回重新编码后的 data URI；
 * 若源内容无法解析为 data URI 则返回 null
 * （由调用方决定是否翻转 isImage）。
 */
export async function resizeShellImageOutput(
  stdout: string,
  outputFilePath: string | undefined,
  outputFileSize: number | undefined,
): Promise<string | null> {
  let source = stdout
  if (outputFilePath) {
    const size = outputFileSize ?? (await stat(outputFilePath)).size
    if (size > MAX_IMAGE_FILE_SIZE) return null
    source = await readFile(outputFilePath, 'utf8')
  }
  const parsed = parseDataUri(source)
  if (!parsed) return null
  const buf = Buffer.from(parsed.data, 'base64')
  const ext = parsed.mediaType.split('/')[1] || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(
    buf,
    buf.length,
    ext,
  )
  return `data:image/${resized.mediaType};base64,${resized.buffer.toString('base64')}`
}

export function formatOutput(content: string): {
  totalLines: number
  truncatedContent: string
  isImage?: boolean
} {
  const isImage = isImageOutput(content)
  if (isImage) {
    return {
      totalLines: 1,
      truncatedContent: content,
      isImage,
    }
  }

  const maxOutputLength = getMaxOutputLength()
  if (content.length <= maxOutputLength) {
    return {
      totalLines: countCharInString(content, '\n') + 1,
      truncatedContent: content,
      isImage,
    }
  }

  const truncatedPart = content.slice(0, maxOutputLength)
  const remainingLines = countCharInString(content, '\n', maxOutputLength) + 1
  const truncated = `${truncatedPart}\n\n... [${remainingLines} lines truncated] ...`

  return {
    totalLines: countCharInString(content, '\n') + 1,
    truncatedContent: truncated,
    isImage,
  }
}

export const stdErrAppendShellResetMessage = (stderr: string): string =>
  `${stderr.trim()}\nShell cwd was reset to ${getOriginalCwd()}`

export function resetCwdIfOutsideProject(
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const cwd = getCwd()
  const originalCwd = getOriginalCwd()
  const shouldMaintain = shouldMaintainProjectWorkingDir()
  if (
    shouldMaintain ||
    // 快速路径：originalCwd 无条件存在于 allWorkingDirectories 中
    // （filesystem.ts），因此当 cwd 未变动时，pathInAllowedWorkingPath
    // 必然为真——在无 cd 的常见场景下跳过其系统调用。
    (cwd !== originalCwd &&
      !pathInAllowedWorkingPath(cwd, toolPermissionContext))
  ) {
    // 若保持项目目录，或位于允许的工作目录之外，则重置到原始目录
    setCwd(originalCwd)
    if (!shouldMaintain) {
      logEvent('limkenion_bash_tool_reset_to_original_dir', {})
      return true
    }
  }
  return false
}

