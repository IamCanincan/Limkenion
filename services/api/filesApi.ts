/**
 * 用于管理文件上传下载的 Files API 客户端
 *
 * 该模块提供向 Limkenion Public Files API 下载和上传文件的功能。
 * 由 Limkenion 代理在会话启动时用于下载文件附件。
 *
 * API 参考：https://docs.limkenion.com/en/api/files-content
 */

import axios from 'axios'
import { randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { count } from '../../utils/array.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

// Files API 目前处于 beta 阶段。oauth-2025-04-20 在 public-api 路由上
// 启用了 Bearer OAuth（auth.py：beta_versions 里没有 "oauth_auth" → 404）。
const FILES_API_BETA_HEADER = 'files-api-2025-04-14,oauth-2025-04-20'
const LIMKENION_VERSION = '2023-06-01'

// API 基地址——使用 env-manager 为对应环境设置的 LIMKENION_BASE_URL
// 未设置时回退到公开 API 以便独立使用
function getDefaultApiBaseUrl(): string {
  return (
    process.env.LIMKENION_BASE_URL ||
    process.env.LIMKENION_API_BASE_URL ||
    'https://127.0.0.1'
  )
}

function logDebugError(message: string): void {
  logForDebugging(`[files-api] ${message}`, { level: 'error' })
}

function logDebug(message: string): void {
  logForDebugging(`[files-api] ${message}`)
}

/**
 * 从 CLI 参数解析出的文件规格
 * 格式：--file=<file_id>:<relative_path>
 */
export type File = {
  fileId: string
  relativePath: string
}

/**
 * Files API 客户端的配置
 */
export type FilesApiConfig = {
  /** 用于认证的 OAuth token（来自会话 JWT） */
  oauthToken: string
  /** API 基地址（默认：https://127.0.0.1） */
  baseUrl?: string
  /** 用于创建会话专用目录的会话 ID */
  sessionId: string
}

/**
 * 一次文件下载操作的结果
 */
export type DownloadResult = {
  fileId: string
  path: string
  success: boolean
  error?: string
  bytesWritten?: number
}

const MAX_RETRIES = 3
const BASE_DELAY_MS = 500
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 500MB

/**
 * 重试操作的返回类型——指示是否继续重试
 */
type RetryResult<T> = { done: true; value: T } | { done: false; error?: string }

/**
 * 以指数退避重试逻辑执行操作
 *
 * @param operation - 用于日志记录的操作名
 * @param attemptFn - 每次尝试执行的函数，返回 RetryResult
 * @returns 成功的结果值
 * @throws 所有重试耗尽时抛出 Error
 */
async function retryWithBackoff<T>(
  operation: string,
  attemptFn: (attempt: number) => Promise<RetryResult<T>>,
): Promise<T> {
  let lastError = ''

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await attemptFn(attempt)

    if (result.done) {
      return result.value
    }

    lastError = result.error || `${operation} 失败`
    logDebug(
      `${operation} 第 ${attempt}/${MAX_RETRIES} 次尝试失败：${lastError}`,
    )

    if (attempt < MAX_RETRIES) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      logDebug(`将在 ${delayMs}ms 后重试 ${operation}...`)
      await sleep(delayMs)
    }
  }

  throw new Error(`${lastError}，经过 ${MAX_RETRIES} 次尝试之后`)
}

/**
 * 从 Limkenion Public Files API 下载单个文件
 *
 * @param fileId - 文件 ID（例如 "file_011CNha8iCJcU1wXNR6q4V8w"）
 * @param config - Files API 配置
 * @returns 文件内容，作为 Buffer
 */
export async function downloadFile(
  fileId: string,
  config: FilesApiConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const url = `${baseUrl}/v1/files/${fileId}/content`

  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'limkenion-version': LIMKENION_VERSION,
    'limkenion-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`正在从 ${url} 下载文件 ${fileId}`)

  return retryWithBackoff(`下载文件 ${fileId}`, async () => {
    try {
      const response = await axios.get(url, {
        headers,
        responseType: 'arraybuffer',
        timeout: 60000, // 大文件的 60 秒超时
        validateStatus: status => status < 500,
      })

      if (response.status === 200) {
        logDebug(`已下载文件 ${fileId}（${response.data.length} 字节）`)
        return { done: true, value: Buffer.from(response.data) }
      }

      // 不可重试的错误——立即抛出
      if (response.status === 404) {
        throw new Error(`文件未找到：${fileId}`)
      }
      if (response.status === 401) {
        throw new Error('认证失败：API key 无效或缺失')
      }
      if (response.status === 403) {
        throw new Error(`无权限访问文件：${fileId}`)
      }

      return { done: false, error: `状态 ${response.status}` }
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        throw error
      }
      return { done: false, error: error.message }
    }
  })
}

/**
 * 对相对路径做规范化，去除冗余前缀，并构建
 * {basePath}/{session_id}/uploads/ 下的完整下载路径。
 * 若路径无效（例如路径穿越）则返回 null。
 */
export function buildDownloadPath(
  basePath: string,
  sessionId: string,
  relativePath: string,
): string | null {
  const normalized = path.normalize(relativePath)
  if (normalized.startsWith('..')) {
    logDebugError(
      `无效的文件路径：${relativePath}。路径不得越出工作区目录之上`,
    )
    return null
  }

  const uploadsBase = path.join(basePath, sessionId, 'uploads')
  const redundantPrefixes = [
    path.join(basePath, sessionId, 'uploads') + path.sep,
    path.sep + 'uploads' + path.sep,
  ]
  const matchedPrefix = redundantPrefixes.find(p => normalized.startsWith(p))
  const cleanPath = matchedPrefix
    ? normalized.slice(matchedPrefix.length)
    : normalized
  return path.join(uploadsBase, cleanPath)
}

/**
 * 下载文件并保存到会话专属的工作区目录
 *
 * @param attachment - 要下载的文件附件
 * @param config - Files API 配置
 * @returns 带成功/失败状态的下载结果
 */
export async function downloadAndSaveFile(
  attachment: File,
  config: FilesApiConfig,
): Promise<DownloadResult> {
  const { fileId, relativePath } = attachment
  const fullPath = buildDownloadPath(getCwd(), config.sessionId, relativePath)

  if (!fullPath) {
    return {
      fileId,
      path: '',
      success: false,
      error: `无效的文件路径：${relativePath}`,
    }
  }

  try {
    // 下载文件内容
    const content = await downloadFile(fileId, config)

    // 确保父目录存在
    const parentDir = path.dirname(fullPath)
    await fs.mkdir(parentDir, { recursive: true })

    // 写入文件
    await fs.writeFile(fullPath, content)

    logDebug(`已将文件 ${fileId} 保存到 ${fullPath}（${content.length} 字节）`)

    return {
      fileId,
      path: fullPath,
      success: true,
      bytesWritten: content.length,
    }
  } catch (error) {
    logDebugError(`下载文件 ${fileId} 失败：${errorMessage(error)}`)
    if (error instanceof Error) {
      logError(error)
    }

    return {
      fileId,
      path: fullPath,
      success: false,
      error: errorMessage(error),
    }
  }
}

// 并行下载的默认并发上限
const DEFAULT_CONCURRENCY = 5

/**
 * 以受限并发执行 promise
 *
 * @param items - 要处理的项目
 * @param fn - 应用于每个项目的异步函数
 * @param concurrency - 最大并发操作数
 * @returns 与输入项目顺序一致的结果
 */
async function parallelWithLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++
      const item = items[index]
      if (item !== undefined) {
        results[index] = await fn(item, index)
      }
    }
  }

  // 启动最多到并发上限数量的 worker
  const workers: Promise<void>[] = []
  const workerCount = Math.min(concurrency, items.length)
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker())
  }

  await Promise.all(workers)
  return results
}

/**
 * 并行下载某个会话的全部文件附件
 *
 * @param attachments - 要下载的文件附件列表
 * @param config - Files API 配置
 * @param concurrency - 最大并发下载数（默认：5）
 * @returns 与输入顺序一致的下载结果数组
 */
export async function downloadSessionFiles(
  files: File[],
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<DownloadResult[]> {
  if (files.length === 0) {
    return []
  }

  logDebug(
    `正在为会话 ${config.sessionId} 下载 ${files.length} 个文件`,
  )
  const startTime = Date.now()

  // 以受限并发并行下载文件
  const results = await parallelWithLimit(
    files,
    file => downloadAndSaveFile(file, config),
    concurrency,
  )

  const elapsedMs = Date.now() - startTime
  const successCount = count(results, r => r.success)
  logDebug(
    `在 ${elapsedMs}ms 内下载了 ${successCount}/${files.length} 个文件`,
  )

  return results
}

// ============================================================================
// 上传相关函数（BYOC 模式）
// ============================================================================

/**
 * 一次文件上传操作的结果
 */
export type UploadResult =
  | {
      path: string
      fileId: string
      size: number
      success: true
    }
  | {
      path: string
      error: string
      success: false
    }

/**
 * 向 Files API 上传单个文件（BYOC 模式）
 *
 * 在读取文件之后执行大小校验，以避免 TOCTOU 竞态条件——
 * 即文件大小在初次检查与上传之间可能发生变化。
 *
 * @param filePath - 要上传文件的绝对路径
 * @param relativePath - 文件的相对路径（在 API 中用作文件名）
 * @param config - Files API 配置
 * @returns 带成功/失败状态的上传结果
 */
export async function uploadFile(
  filePath: string,
  relativePath: string,
  config: FilesApiConfig,
  opts?: { signal?: AbortSignal },
): Promise<UploadResult> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const url = `${baseUrl}/v1/files`

  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'limkenion-version': LIMKENION_VERSION,
    'limkenion-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`正在将文件 ${filePath} 上传为 ${relativePath}`)

  // 先读取文件内容（放在重试循环之外，因为它不是网络操作）
  let content: Buffer
  try {
    content = await fs.readFile(filePath)
  } catch (error) {
    logEvent('limkenion_file_upload_failed', {
      error_type:
        'file_read' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: errorMessage(error),
      success: false,
    }
  }

  const fileSize = content.length

  if (fileSize > MAX_FILE_SIZE_BYTES) {
    logEvent('limkenion_file_upload_failed', {
      error_type:
        'file_too_large' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: `文件超过最大大小 ${MAX_FILE_SIZE_BYTES} 字节（实际：${fileSize}）`,
      success: false,
    }
  }

  // 用 crypto.randomUUID 生成 boundary，避免多个上传在同一毫秒启动时发生碰撞
  const boundary = `----FormBoundary${randomUUID()}`
  const filename = path.basename(relativePath)

  // 构建 multipart 请求体
  const bodyParts: Buffer[] = []

  // 文件部分
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  )
  bodyParts.push(content)
  bodyParts.push(Buffer.from('\r\n'))

  // purpose 部分
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
        `user_data\r\n`,
    ),
  )

  // 结束 boundary
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`))

  const body = Buffer.concat(bodyParts)

  try {
    return await retryWithBackoff(`Upload file ${relativePath}`, async () => {
      try {
        const response = await axios.post(url, body, {
          headers: {
            ...headers,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length.toString(),
          },
          timeout: 120000, // 上传的 2 分钟超时
          signal: opts?.signal,
          validateStatus: status => status < 500,
        })

        if (response.status === 200 || response.status === 201) {
          const fileId = response.data?.id
          if (!fileId) {
            return {
              done: false,
              error: '上传成功但未返回文件 ID',
            }
          }
          logDebug(`已上传文件 ${filePath} -> ${fileId}（${fileSize} 字节）`)
          return {
            done: true,
            value: {
              path: relativePath,
              fileId,
              size: fileSize,
              success: true as const,
            },
          }
        }

        // 不可重试的错误——抛出以退出重试循环
        if (response.status === 401) {
          logEvent('limkenion_file_upload_failed', {
            error_type:
              'auth' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError(
            '认证失败：API key 无效或缺失',
          )
        }

        if (response.status === 403) {
          logEvent('limkenion_file_upload_failed', {
            error_type:
              'forbidden' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError('无权限进行上传')
        }

        if (response.status === 413) {
          logEvent('limkenion_file_upload_failed', {
            error_type:
              'size' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError('文件过大，无法上传')
        }

        return { done: false, error: `状态 ${response.status}` }
      } catch (error) {
        // 不可重试的错误向上传播
        if (error instanceof UploadNonRetriableError) {
          throw error
        }
        if (axios.isCancel(error)) {
          throw new UploadNonRetriableError('上传已取消')
        }
        // 网络错误可重试
        if (axios.isAxiosError(error)) {
          return { done: false, error: error.message }
        }
        throw error
      }
    })
  } catch (error) {
    if (error instanceof UploadNonRetriableError) {
      return {
        path: relativePath,
        error: error.message,
        success: false,
      }
    }
    logEvent('limkenion_file_upload_failed', {
      error_type:
        'network' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: errorMessage(error),
      success: false,
    }
  }
}

/** 不可重试上传失败的错误类 */
class UploadNonRetriableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadNonRetriableError'
  }
}

/**
 * 以受限并发并行上传多个文件（BYOC 模式）
 *
 * @param files - 要上传的文件数组（path 和 relativePath）
 * @param config - Files API 配置
 * @param concurrency - 最大并发上传数（默认：5）
 * @returns 与输入顺序一致的上传结果数组
 */
export async function uploadSessionFiles(
  files: Array<{ path: string; relativePath: string }>,
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<UploadResult[]> {
  if (files.length === 0) {
    return []
  }

  logDebug(`正在为会话 ${config.sessionId} 上传 ${files.length} 个文件`)
  const startTime = Date.now()

  const results = await parallelWithLimit(
    files,
    file => uploadFile(file.path, file.relativePath, config),
    concurrency,
  )

  const elapsedMs = Date.now() - startTime
  const successCount = count(results, r => r.success)
  logDebug(`在 ${elapsedMs}ms 内上传了 ${successCount}/${files.length} 个文件`)

  return results
}

// ============================================================================
// 列出文件相关函数（1P/Cloud 模式）
// ============================================================================

/**
 * listFilesCreatedAfter 返回的文件元数据
 */
export type FileMetadata = {
  filename: string
  fileId: string
  size: number
}

/**
 * 列出在给定时间戳之后创建的文件（1P/Cloud 模式）。
 * 使用带 after_created_at 查询参数的公开 GET /v1/files 端点。
 * 当 has_more 为 true 时通过 after_id 游标进行分页。
 *
 * @param afterCreatedAt - 用于筛选其后创建文件的 ISO 8601 时间戳
 * @param config - Files API 配置
 * @returns 在时间戳之后创建的文件的元数据数组
 */
export async function listFilesCreatedAfter(
  afterCreatedAt: string,
  config: FilesApiConfig,
): Promise<FileMetadata[]> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'limkenion-version': LIMKENION_VERSION,
    'limkenion-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`正在列出 ${afterCreatedAt} 之后创建的文件`)

  const allFiles: FileMetadata[] = []
  let afterId: string | undefined

  // 对结果进行分页
  while (true) {
    const params: Record<string, string> = {
      after_created_at: afterCreatedAt,
    }
    if (afterId) {
      params.after_id = afterId
    }

    const page = await retryWithBackoff(
      `列出 ${afterCreatedAt} 之后的文件`,
      async () => {
        try {
          const response = await axios.get(`${baseUrl}/v1/files`, {
            headers,
            params,
            timeout: 60000,
            validateStatus: status => status < 500,
          })

          if (response.status === 200) {
            return { done: true, value: response.data }
          }

          if (response.status === 401) {
            logEvent('limkenion_file_list_failed', {
              error_type:
                'auth' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            throw new Error('认证失败：API key 无效或缺失')
          }
          if (response.status === 403) {
            logEvent('limkenion_file_list_failed', {
              error_type:
                'forbidden' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            throw new Error('无权限列出文件')
          }

          return { done: false, error: `状态 ${response.status}` }
        } catch (error) {
          if (!axios.isAxiosError(error)) {
            throw error
          }
          logEvent('limkenion_file_list_failed', {
            error_type:
              'network' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return { done: false, error: error.message }
        }
      },
    )

    const files = page.data || []
    for (const f of files) {
      allFiles.push({
        filename: f.filename,
        fileId: f.id,
        size: f.size_bytes,
      })
    }

    if (!page.has_more) {
      break
    }

    // 使用最后一个文件的 ID 作为下一页的游标
    const lastFile = files.at(-1)
    if (!lastFile?.id) {
      break
    }
    afterId = lastFile.id
  }

  logDebug(`已列出 ${allFiles.length} 个在 ${afterCreatedAt} 之后创建的文件`)
  return allFiles
}

// ============================================================================
// 解析相关函数
// ============================================================================

/**
 * 从 CLI 参数解析文件附件规格
 * 格式：<file_id>:<relative_path>
 *
 * @param fileSpecs - 文件规格字符串数组
 * @returns 已解析的文件附件
 */
export function parseFileSpecs(fileSpecs: string[]): File[] {
  const files: File[] = []

  // Sandbox-gateway 可能以单个空格分隔的字符串传入多个规格
  const expandedSpecs = fileSpecs.flatMap(s => s.split(' ').filter(Boolean))

  for (const spec of expandedSpecs) {
    const colonIndex = spec.indexOf(':')
    if (colonIndex === -1) {
      continue
    }

    const fileId = spec.substring(0, colonIndex)
    const relativePath = spec.substring(colonIndex + 1)

    if (!fileId || !relativePath) {
      logDebugError(
        `无效的文件规格：${spec}。file_id 和路径都是必需的`,
      )
      continue
    }

    files.push({ fileId, relativePath })
  }

  return files
}
