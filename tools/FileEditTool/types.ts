import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'

// 带可选 replace_all 的输入 schema
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('要修改文件的绝对路径'),
    old_string: z.string().describe('要替换的文本'),
    new_string: z
      .string()
      .describe(
        '用于替换它的文本（必须与 old_string 不同）',
      ),
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
    ).describe('替换所有出现的 old_string（默认为 false）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 解析后的输出——call() 收到的内容。用 z.output 而非 z.input：使用
// semanticBoolean 时输入侧是未知的（preprocess 接受任何内容）。
export type FileEditInput = z.output<InputSchema>

// 不含 file_path 的单个编辑
export type EditInput = Omit<FileEditInput, 'file_path'>

// replace_all 始终已定义时的运行时版本
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),
    status: z.enum(['modified', 'added']),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string(),
    repository: z
      .string()
      .nullable()
      .optional()
      .describe('可用的 GitHub 所有者/仓库'),
  }),
)

// FileEditTool 的输出 schema
const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('已编辑文件的路径'),
    oldString: z.string().describe('被替换的原始字符串'),
    newString: z.string().describe('替换用的新字符串'),
    originalFile: z
      .string()
      .describe('编辑前的原始文件内容'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('显示更改的差异补丁'),
    userModified: z
      .boolean()
      .describe('用户是否修改了提议的更改'),
    replaceAll: z.boolean().describe('所有出现位置是否都被替换'),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, outputSchema }
