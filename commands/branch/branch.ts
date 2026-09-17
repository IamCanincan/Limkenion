import { randomUUID, type UUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type {
  ContentReplacementEntry,
  Entry,
  LogOption,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import { parseJSONL } from '../../utils/json.js'
import {
  getProjectDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  isTranscriptMessage,
  saveCustomTitle,
  searchSessionsByCustomTitle,
} from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { escapeRegExp } from '../../utils/stringUtils.js'

type TranscriptEntry = TranscriptMessage & {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

/**
 * 从第一条用户消息派生单行标题基准。
 * 折叠空白——多行首条消息（粘贴的堆栈、代码）否则会流入已保存的
 * 标题并破坏恢复提示。
 */
export function deriveFirstPrompt(
  firstUserMessage: Extract<SerializedMessage, { type: 'user' }> | undefined,
): string {
  const content = firstUserMessage?.message?.content
  if (!content) return '分支对话'
  const raw =
    typeof content === 'string'
      ? content
      : content.find(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )?.text
  if (!raw) return '分支对话'
  return (
    raw.replace(/\s+/g, ' ').trim().slice(0, 100) || '分支对话'
  )
}

/**
 * 通过从 transcript 文件复制来创建当前对话的一个分支。
 * 保留全部原始元数据（时间戳、gitBranch 等），同时更新
 * sessionId 并添加 forkedFrom 可追溯性。
 */
async function createFork(customTitle?: string): Promise<{
  sessionId: UUID
  title: string | undefined
  forkPath: string
  serializedMessages: SerializedMessage[]
  contentReplacementRecords: ContentReplacementEntry['replacements']
}> {
  const forkSessionId = randomUUID() as UUID
  const originalSessionId = getSessionId()
  const projectDir = getProjectDir(getOriginalCwd())
  const forkSessionPath = getTranscriptPathForSession(forkSessionId)
  const currentTranscriptPath = getTranscriptPath()

  // 确保项目目录存在
  await mkdir(projectDir, { recursive: true, mode: 0o700 })

  // 读取当前 transcript 文件
  let transcriptContent: Buffer
  try {
    transcriptContent = await readFile(currentTranscriptPath)
  } catch {
    throw new Error('没有可分支的对话')
  }

  if (transcriptContent.length === 0) {
    throw new Error('没有可分支的对话')
  }

  // 解析全部 transcript 条目（消息 + 内容替换等元数据条目）
  const entries = parseJSONL<Entry>(transcriptContent)

  // 只过滤出主对话消息（排除侧链与非消息条目）
  const mainConversationEntries = entries.filter(
    (entry): entry is TranscriptMessage =>
      isTranscriptMessage(entry) && !entry.isSidechain,
  )

  // 原始 session 的内容替换条目。它们记录每个消息预算
  // 用预览替换了哪些 tool_result 块。
  // 如果 fork JSONL 中没有它们，`limkenion -r {forkId}` 会用一个空的
  // replacements Map 重建状态 → 先前被替换的结果会被分类为
  // FROZEN 并以完整内容发送（提示词缓存未命中 + 永久超额）。
  // sessionId 必须被重写，因为 loadTranscriptFile 是按会话的
  // 消息 sessionId 做键查找的。
  const contentReplacementRecords = entries
    .filter(
      (entry): entry is ContentReplacementEntry =>
        entry.type === 'content-replacement' &&
        entry.sessionId === originalSessionId,
    )
    .flatMap(entry => entry.replacements)

  if (mainConversationEntries.length === 0) {
    throw new Error('没有可分支的消息')
  }

  // 用新的 sessionId 构建分支条目，并保留元数据
  let parentUuid: UUID | null = null
  const lines: string[] = []
  const serializedMessages: SerializedMessage[] = []

  for (const entry of mainConversationEntries) {
    // 创建保留所有原始元数据的分支 transcript 条目
    const forkedEntry: TranscriptEntry = {
      ...entry,
      sessionId: forkSessionId,
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId: originalSessionId,
        messageUuid: entry.uuid,
      },
    }

    // 为 LogOption 构建序列化消息
    const serialized: SerializedMessage = {
      ...entry,
      sessionId: forkSessionId,
    }

    serializedMessages.push(serialized)
    lines.push(jsonStringify(forkedEntry))
    if (entry.type !== 'progress') {
      parentUuid = entry.uuid
    }
  }

  // 如有内容替换条目，则用它所属 session 的 sessionId 追加。
  // 作为单个条目写入（与 insertContentReplacement 形状相同），
  // 以便 loadTranscriptFile 的内容替换分支能识别它。
  if (contentReplacementRecords.length > 0) {
    const forkedReplacementEntry: ContentReplacementEntry = {
      type: 'content-replacement',
      sessionId: forkSessionId,
      replacements: contentReplacementRecords,
    }
    lines.push(jsonStringify(forkedReplacementEntry))
  }

  // 写入分支会话文件
  await writeFile(forkSessionPath, lines.join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })

  return {
    sessionId: forkSessionId,
    title: customTitle,
    forkPath: forkSessionPath,
    serializedMessages,
    contentReplacementRecords,
  }
}

/**
 * 通过检查与既有会话名的冲突来生成唯一分支名。
 * 若 "baseName (Branch)" 已存在，则尝试 "baseName (Branch 2)"、
 * "baseName (Branch 3)" 等。
 */
async function getUniqueForkName(baseName: string): Promise<string> {
  const candidateName = `${baseName} (Branch)`

  // 检查这个确切的名字是否已存在
  const existingWithExactName = await searchSessionsByCustomTitle(
    candidateName,
    { exact: true },
  )

  if (existingWithExactName.length === 0) {
    return candidateName
  }

  // 名字冲突——找一个唯一的数字后缀
  // 搜索所有以该基准模式开头的会话
  const existingForks = await searchSessionsByCustomTitle(`${baseName} (Branch`)

  // 提取既有分支号以找到下一个可用编号
  const usedNumbers = new Set<number>([1]) // 将 " (Branch)" 视为编号 1
  const forkNumberPattern = new RegExp(
    `^${escapeRegExp(baseName)} \\(Branch(?: (\\d+))?\\)$`,
  )

  for (const session of existingForks) {
    const match = session.customTitle?.match(forkNumberPattern)
    if (match) {
      if (match[1]) {
        usedNumbers.add(parseInt(match[1], 10))
      } else {
        usedNumbers.add(1) // " (Branch)" 无编号时按 1 处理
      }
    }
  }

  // 找到下一个可用编号
  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) {
    nextNumber++
  }

  return `${baseName} (Branch ${nextNumber})`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const customTitle = args?.trim() || undefined

  const originalSessionId = getSessionId()

  try {
    const {
      sessionId,
      title,
      forkPath,
      serializedMessages,
      contentReplacementRecords,
    } = await createFork(customTitle)

    // 为恢复构建 LogOption
    const now = new Date()
    const firstPrompt = deriveFirstPrompt(
      serializedMessages.find(m => m.type === 'user'),
    )

    // 保存自定义标题——用提供的标题或 firstPrompt 作为默认值
    // 这确保 /status 与 /resume 显示相同的会话名
    // 始终添加 " (Branch)" 后缀，以明确指出这是分支会话
    // 通过添加数字后缀处理冲突（例如 " (Branch 2)"、" (Branch 3)"）
    const baseName = title ?? firstPrompt
    const effectiveTitle = await getUniqueForkName(baseName)
    await saveCustomTitle(sessionId, effectiveTitle, forkPath)

    logEvent('limkenion_conversation_forked', {
      message_count: serializedMessages.length,
      has_custom_title: !!title,
    })

    const forkLog: LogOption = {
      date: now.toISOString().split('T')[0]!,
      messages: serializedMessages,
      fullPath: forkPath,
      value: now.getTime(),
      created: now,
      modified: now,
      firstPrompt,
      messageCount: serializedMessages.length,
      isSidechain: false,
      sessionId,
      customTitle: effectiveTitle,
      contentReplacements: contentReplacementRecords,
    }

    // 恢复进入分支
    const titleInfo = title ? ` "${title}"` : ''
    const resumeHint = `\n要恢复原对话：limkenion -r ${originalSessionId}`
    const successMessage = `已创建分支对话${titleInfo}。你现在处于该分支中。${resumeHint}`

    if (context.resume) {
      await context.resume(sessionId, forkLog, 'fork')
      onDone(successMessage, { display: 'system' })
    } else {
      // 无恢复能力时的回退
      onDone(
        `已创建分支对话${titleInfo}。用 /resume ${sessionId} 恢复`,
      )
    }

    return null
  } catch (error) {
    const message =
      error instanceof Error ? error.message : '未知错误'
    onDone(`创建对话分支失败：${message}`)
    return null
  }
}
