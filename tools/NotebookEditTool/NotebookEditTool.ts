import { feature } from 'bun:bundle'
import { extname, isAbsolute, resolve } from 'path'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from 'src/utils/fileHistory.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { NotebookCell, NotebookContent } from '../../types/notebook.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseCellId } from '../../utils/notebook.js'
import { checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

export const inputSchema = lazySchema(() =>
  z.strictObject({
    notebook_path: z
      .string()
      .describe(
        '要编辑的 Jupyter notebook 文件的绝对路径（必须是绝对路径，而非相对路径）',
      ),
    cell_id: z
      .string()
      .optional()
      .describe(
        '要编辑的单元格 ID。插入新单元格时，新单元格将插到具有此 ID 的单元格之后，若未指定则插到开头。',
      ),
    new_source: z.string().describe('单元格的新源码'),
    cell_type: z
      .enum(['code', 'markdown'])
      .optional()
      .describe(
        '单元格的类型（code 或 markdown）。若未指定，则默认为当前单元格类型。若使用 edit_mode=insert，则此项为必填。',
      ),
    edit_mode: z
      .enum(['replace', 'insert', 'delete'])
      .optional()
      .describe(
        '要执行的编辑类型（replace、insert、delete）。默认为 replace。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    new_source: z
      .string()
      .describe('写入单元格的新源码'),
    cell_id: z
      .string()
      .optional()
      .describe('被编辑单元格的 ID'),
    cell_type: z.enum(['code', 'markdown']).describe('单元格的类型'),
    language: z.string().describe('notebook 的编程语言'),
    edit_mode: z.string().describe('所使用的编辑模式'),
    error: z
      .string()
      .optional()
      .describe('操作失败时的错误消息'),
    // 用于溯源追踪的字段
    notebook_path: z.string().describe('notebook 文件的路径'),
    original_file: z
      .string()
      .describe('修改前的原始 notebook 内容'),
    updated_file: z
      .string()
      .describe('修改后的 notebook 内容'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const NotebookEditTool = buildTool({
  name: NOTEBOOK_EDIT_TOOL_NAME,
  searchHint: 'edit Jupyter notebook cells (.ipynb)',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  userFacingName() {
    return 'Edit Notebook'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing notebook ${summary}` : 'Editing notebook'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const mode = input.edit_mode ?? 'replace'
      return `${input.notebook_path} ${mode}: ${input.new_source}`
    }
    return ''
  },
  getPath(input): string {
    return input.notebook_path
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      NotebookEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  mapToolResultToToolResultBlockParam(
    { cell_id, edit_mode, new_source, error },
    toolUseID,
  ) {
    if (error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: error,
        is_error: true,
      }
    }
    switch (edit_mode) {
      case 'replace':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Updated cell ${cell_id} with ${new_source}`,
        }
      case 'insert':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Inserted cell ${cell_id} with ${new_source}`,
        }
      case 'delete':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Deleted cell ${cell_id}`,
        }
      default:
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: 'Unknown edit mode',
        }
    }
  },
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  async validateInput(
    { notebook_path, cell_type, cell_id, edit_mode = 'replace' },
    toolUseContext: ToolUseContext,
  ) {
    const fullPath = isAbsolute(notebook_path)
      ? notebook_path
      : resolve(getCwd(), notebook_path)

    // SECURITY: 对 UNC 路径跳过文件系统操作，以防 NTLM 凭据泄露。
    if (fullPath.startsWith('\\\\') || fullPath.startsWith('//')) {
      return { result: true }
    }

    if (extname(fullPath) !== '.ipynb') {
      return {
        result: false,
        message:
          'File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.',
        errorCode: 2,
      }
    }

    if (
      edit_mode !== 'replace' &&
      edit_mode !== 'insert' &&
      edit_mode !== 'delete'
    ) {
      return {
        result: false,
        message: 'Edit mode must be replace, insert, or delete.',
        errorCode: 4,
      }
    }

    if (edit_mode === 'insert' && !cell_type) {
      return {
        result: false,
        message: 'Cell type is required when using edit_mode=insert.',
        errorCode: 5,
      }
    }

    // 要求先 Read 再 Edit（与 FileEditTool/FileWriteTool 一致）。若没有
    // 这一约束，模型可能编辑从未见过的 notebook，或在外部变更后
    // 基于失效视图编辑——造成静默数据丢失。
    const readTimestamp = toolUseContext.readFileState.get(fullPath)
    if (!readTimestamp) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        errorCode: 9,
      }
    }
    if (getFileModificationTime(fullPath) > readTimestamp.timestamp) {
      return {
        result: false,
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 10,
      }
    }

    let content: string
    try {
      content = readFileSyncWithMetadata(fullPath).content
    } catch (e) {
      if (isENOENT(e)) {
        return {
          result: false,
          message: 'Notebook file does not exist.',
          errorCode: 1,
        }
      }
      throw e
    }
    const notebook = safeParseJSON(content) as NotebookContent | null
    if (!notebook) {
      return {
        result: false,
        message: 'Notebook is not valid JSON.',
        errorCode: 6,
      }
    }
    if (!cell_id) {
      if (edit_mode !== 'insert') {
        return {
          result: false,
          message: 'Cell ID must be specified when not inserting a new cell.',
          errorCode: 7,
        }
      }
    } else {
      // 首先尝试按单元格的实际 ID 查找
      const cellIndex = notebook.cells.findIndex(cell => cell.id === cell_id)

      if (cellIndex === -1) {
        // 若未找到，尝试按数字索引解析（cell-N 格式）
        const parsedCellIndex = parseCellId(cell_id)
        if (parsedCellIndex !== undefined) {
          if (!notebook.cells[parsedCellIndex]) {
            return {
              result: false,
              message: `Cell with index ${parsedCellIndex} does not exist in notebook.`,
              errorCode: 7,
            }
          }
        } else {
          return {
            result: false,
            message: `Cell with ID "${cell_id}" not found in notebook.`,
            errorCode: 8,
          }
        }
      }
    }

    return { result: true }
  },
  async call(
    {
      notebook_path,
      new_source,
      cell_id,
      cell_type,
      edit_mode: originalEditMode,
    },
    { readFileState, updateFileHistoryState },
    _,
    parentMessage,
  ) {
    const fullPath = isAbsolute(notebook_path)
      ? notebook_path
      : resolve(getCwd(), notebook_path)

    if (fileHistoryEnabled()) {
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        fullPath,
        parentMessage.uuid,
      )
    }

    try {
      // readFileSyncWithMetadata 在一次 safeResolvePath + readFileSync 中
      // 同时给出内容、编码和行尾，取代了此前
      // detectFileEncoding + readFile + detectLineEndings 的调用链（其中每一步
      // 都会重复执行 safeResolvePath 和/或一次 4KB 的 readSync）。
      const { content, encoding, lineEndings } =
        readFileSyncWithMetadata(fullPath)
      // 此处必须使用非记忆化的 jsonParse：safeParseJSON 按内容字符串缓存
      // 并返回共享的对象引用，而我们在下方会原地修改
      // notebook（cells.splice、targetCell.source = ...）。
      // 使用记忆化版本会污染 validateInput() 以及后续任何
      // 以相同文件内容调用 call() 的缓存。
      let notebook: NotebookContent
      try {
        notebook = jsonParse(content) as NotebookContent
      } catch {
        return {
          data: {
            new_source,
            cell_type: cell_type ?? 'code',
            language: 'python',
            edit_mode: 'replace',
            error: 'Notebook is not valid JSON.',
            cell_id,
            notebook_path: fullPath,
            original_file: '',
            updated_file: '',
          },
        }
      }

      let cellIndex
      if (!cell_id) {
        cellIndex = 0 // 若未提供 cell_id，默认插入到开头
      } else {
        // 首先尝试按单元格的实际 ID 查找
        cellIndex = notebook.cells.findIndex(cell => cell.id === cell_id)

        // 若未找到，尝试按数字索引解析（cell-N 格式）
        if (cellIndex === -1) {
          const parsedCellIndex = parseCellId(cell_id)
          if (parsedCellIndex !== undefined) {
            cellIndex = parsedCellIndex
          }
        }

        if (originalEditMode === 'insert') {
          cellIndex += 1 // 插入到该 ID 对应的单元格之后
        }
      }

      // 若尝试替换超出末尾的位置，则将 replace 转为 insert
      let edit_mode = originalEditMode
      if (edit_mode === 'replace' && cellIndex === notebook.cells.length) {
        edit_mode = 'insert'
        if (!cell_type) {
          cell_type = 'code' // 若未指定 cell_type，默认为 code
        }
      }

      const language = notebook.metadata.language_info?.name ?? 'python'
      let new_cell_id = undefined
      if (
        notebook.nbformat > 4 ||
        (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
      ) {
        if (edit_mode === 'insert') {
          new_cell_id = Math.random().toString(36).substring(2, 15)
        } else if (cell_id !== null) {
          new_cell_id = cell_id
        }
      }

      if (edit_mode === 'delete') {
        // 删除指定的单元格
        notebook.cells.splice(cellIndex, 1)
      } else if (edit_mode === 'insert') {
        let new_cell: NotebookCell
        if (cell_type === 'markdown') {
          new_cell = {
            cell_type: 'markdown',
            id: new_cell_id,
            source: new_source,
            metadata: {},
          }
        } else {
          new_cell = {
            cell_type: 'code',
            id: new_cell_id,
            source: new_source,
            metadata: {},
            execution_count: null,
            outputs: [],
          }
        }
        // 插入新单元格
        notebook.cells.splice(cellIndex, 0, new_cell)
      } else {
        // 查找指定的单元格
        const targetCell = notebook.cells[cellIndex]! // validateInput 确保 cell_number 在边界内
        targetCell.source = new_source
        if (targetCell.cell_type === 'code') {
          // 由于单元格已被修改，重置执行计数并清空输出
          targetCell.execution_count = null
          targetCell.outputs = []
        }
        if (cell_type && cell_type !== targetCell.cell_type) {
          targetCell.cell_type = cell_type
        }
      }
      // 写回文件
      const IPYNB_INDENT = 1
      const updatedContent = jsonStringify(notebook, null, IPYNB_INDENT)
      writeTextContent(fullPath, updatedContent, encoding, lineEndings)
      // 用写入后的 mtime 更新 readFileState（与 FileEditTool/
      // FileWriteTool 一致）。offset:undefined 会破坏 FileReadTool 的去重匹配——
      // 若没有这一处理，同一毫秒内的 Read→NotebookEdit→Read
      // 会针对上下文中失效的内容返回 file_unchanged 存根。
      readFileState.set(fullPath, {
        content: updatedContent,
        timestamp: getFileModificationTime(fullPath),
        offset: undefined,
        limit: undefined,
      })
      const data = {
        new_source,
        cell_type: cell_type ?? 'code',
        language,
        edit_mode: edit_mode ?? 'replace',
        cell_id: new_cell_id || undefined,
        error: '',
        notebook_path: fullPath,
        original_file: content,
        updated_file: updatedContent,
      }
      return {
        data,
      }
    } catch (error) {
      if (error instanceof Error) {
        const data = {
          new_source,
          cell_type: cell_type ?? 'code',
          language: 'python',
          edit_mode: 'replace',
          error: error.message,
          cell_id,
          notebook_path: fullPath,
          original_file: '',
          updated_file: '',
        }
        return {
          data,
        }
      }
      const data = {
        new_source,
        cell_type: cell_type ?? 'code',
        language: 'python',
        edit_mode: 'replace',
        error: 'Unknown error occurred while editing notebook',
        cell_id,
        notebook_path: fullPath,
        original_file: '',
        updated_file: '',
      }
      return {
        data,
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
