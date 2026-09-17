/**
 * 将 BriefTool 附件上传到 private_api，使 Web 端查看器可以预览它们。
 *
 * 当 repl bridge 处于激活状态时，附件路径对 Web 端查看器没有意义（它们
 * 位于 Limkenion 的机器上）。我们上传到 /api/oauth/file_upload——与
 * MessageComposer/SpaceMessage 渲染所访问的同一个存储——并将返回的
 * file_uuid 保存在路径旁边。Web 端通过 file_uuid 解析预览；桌面/本地端
 * 优先尝试路径。
 *
 * 尽力而为：任何失败（无 token、bridge 关闭、网络错误、4xx）都仅记录
 * 调试日志并返回 undefined。附件仍携带 {path, size, isImage}，因此本地
 * 终端和同机桌面渲染不受影响。
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import { z } from 'zod/v4'

// Bridge 配置已移除——上传认证仅来自 env/oauth。
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// 与 private_api 后端限制保持一致
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

const UPLOAD_TIMEOUT_MS = 30_000

// 后端按 mime 分发：image/* → upload_image_wrapped（写入 PREVIEW/THUMBNAIL，
// 无 ORIGINAL），其余 → upload_generic_file（仅 ORIGINAL，无预览）。只将
// 转码器能可靠处理的光栅格式加入白名单——svg/bmp/ico 可能返回 400，而
// pdf 会路由到同样跳过 ORIGINAL 的 upload_pdf_file_wrapped。分发查看器对
// 图片使用 /preview，对其余内容使用 /contents，因此图片走 image/*，
// 其余走 octet-stream。
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function debug(msg: string): void {
  logForDebugging(`[brief:upload] ${msg}`)
}

/**
 * 上传的基础 URL。必须与 token 有效的主机一致。
 *
 * 子进程主机（cowork）随 LIMKENION_OAUTH_TOKEN 一起传入
 * LIMKENION_BASE_URL——优先使用它，因为 getOauthConfig() 仅在设置了
 * USE_STAGING_OAUTH 时才返回 staging，而这类主机不会设置该变量。否则
 * staging token 会命中 127.0.0.1 → 401 → 静默跳过 → Web 端查看器只能看到
 * 没有 file_uuid 的无效卡片。
 */
function getBridgeBaseUrl(): string {
  return (
    process.env.LIMKENION_BASE_URL ??
    getOauthConfig().BASE_API_URL
  )
}

// /api/oauth/file_upload 返回 ChatMessage{Image,Blob,Document}FileSchema
// 中的一种。它们都包含 file_uuid；这是我们唯一需要的字段。
const uploadResponseSchema = lazySchema(() =>
  z.object({ file_uuid: z.string() }),
)

export type BriefUploadContext = {
  replBridgeEnabled: boolean
  signal?: AbortSignal
}

/**
 * 上传单个附件。成功时返回 file_uuid，否则返回 undefined。
 * 每个提前返回都是刻意的优雅降级。
 */
export async function uploadBriefAttachment(
  fullPath: string,
  size: number,
  ctx: BriefUploadContext,
): Promise<string | undefined> {
  // 正向判断使 bun:bundle 能从非 BRIDGE_MODE 构建中消除整个函数体
  // （负向的 `if (!feature(...)) return` 无法做到）。
  if (feature('BRIDGE_MODE')) {
    if (!ctx.replBridgeEnabled) return undefined

    if (size > MAX_UPLOAD_BYTES) {
      debug(`跳过 ${fullPath}：${size} 字节超过 ${MAX_UPLOAD_BYTES} 限制`)
      return undefined
    }

    const token = process.env.LIMKENION_API_KEY
    if (!token) {
      debug('跳过：无 oauth token')
      return undefined
    }

    let content: Buffer
    try {
      content = await readFile(fullPath)
    } catch (e) {
      debug(`读取 ${fullPath} 失败：${e}`)
      return undefined
    }

    const baseUrl = getBridgeBaseUrl()
    const url = `${baseUrl}/api/oauth/file_upload`
    const filename = basename(fullPath)
    const mimeType = guessMimeType(filename)
    const boundary = `----FormBoundary${randomUUID()}`

    // 手工构造 multipart——与 filesApi.ts 的模式一致。oauth 端点只接受
    // 单个 "file" 部分（没有公有 Files API 的那个 "purpose" 字段）。
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mimeType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])

    try {
      const response = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length.toString(),
        },
        timeout: UPLOAD_TIMEOUT_MS,
        signal: ctx.signal,
        validateStatus: () => true,
      })

      if (response.status !== 201) {
        debug(
          `上传 ${fullPath} 失败：status=${response.status} body=${jsonStringify(response.data).slice(0, 200)}`,
        )
        return undefined
      }

      const parsed = uploadResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        debug(
          `${fullPath} 响应形状异常：${parsed.error.message}`,
        )
        return undefined
      }

      debug(`已上传 ${fullPath} → ${parsed.data.file_uuid}（${size} 字节）`)
      return parsed.data.file_uuid
    } catch (e) {
      debug(`上传 ${fullPath} 抛出异常：${e}`)
      return undefined
    }
  }
  return undefined
}
