import { readFile } from 'fs/promises'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { generateTaskId } from '../../Task.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import { hasAcceptedWorkflowsInAutoMode } from '../../utils/workflows/autoModeConsent.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { findWorkflowByName, loadWorkflows } from '../../utils/workflows/discovery.js'
import {
  areWorkflowsEnabled,
  describeWorkflowsDisabled,
  getWorkflowsDisabledReason,
} from '../../utils/workflows/enabled.js'
import { WORKFLOW_SCRIPT_MAX_BYTES } from '../../utils/workflows/constants.js'
import { createWorkflowRunId } from '../../utils/workflows/paths.js'
import { prepareWorkflowScript } from '../../utils/workflows/runtime.js'
import { launchWorkflow } from './launchWorkflow.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { getWorkflowToolPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    script: z
      .string()
      .max(WORKFLOW_SCRIPT_MAX_BYTES)
      .optional()
      .describe(
        '自包含的工作流脚本。必须以 `export const meta = { name, description, phases }` 开头 ' +
          '（纯字面量，不含计算值），后接使用 agent()/parallel()/pipeline()/phase() 的脚本主体。',
      ),
    scriptPath: z
      .string()
      .optional()
      .describe(
        '磁盘上工作流脚本文件的路径。每次 Workflow 调用都会把脚本持久化到 ' +
          '会话目录，并在工具结果中返回该路径。优先级高于 `script` 和 `name`。',
      ),
    name: z
      .string()
      .optional()
      .describe(
        '预定义工作流的名称（内置或来自 .limkenion/workflows/）。',
      ),
    args: z
      .unknown()
      .optional()
      .describe(
        '作为全局 `args` 逐字暴露给脚本的可选输入值。传入的数组/对象请用 ' +
          '实际的 JSON 值，而非 JSON 编码的字符串。',
      ),
    title: z.string().optional().describe('已忽略——请在 `meta` 中设置标题。'),
    description: z
      .string()
      .optional()
      .describe('已忽略——请在 `meta` 中设置描述。'),
    resumeFromRunId: z
      .string()
      .regex(/^wf_[a-z0-9-]{6,}$/)
      .optional()
      .describe(
        '要恢复的先前 Workflow 调用的运行 ID。参数（prompt、opts）未变化的已完成 agent() 调用 ' +
          '会立即返回其缓存结果；只有被修改或新增的调用才会重新运行。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 与上游 limkenion-code 的 sdk-tools.d.ts 中官方 WorkflowOutput
// 保持一致。可选字段在那里也是可选的，因此在某个字段存在之前
// 写入的 transcript 仍可回放，而不会因重新校验失败。
const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['async_launched', 'remote_launched']),
    taskId: z.string(),
    taskType: z.enum(['local_workflow', 'remote_agent']).optional(),
    workflowName: z.string().optional(),
    runId: z.string().optional(),
    summary: z.string().optional(),
    transcriptDir: z.string().optional(),
    scriptPath: z.string().optional(),
    sessionUrl: z.string().optional(),
    warning: z.string().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'orchestrate many subagents from a script',
  maxResultSizeChars: 100_000,
  userFacingName: () => 'Workflow',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return areWorkflowsEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isOpenWorld() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.script ?? input.scriptPath ?? input.name ?? ''
  },
  /**
   * 一次运行会派生许多 agent，其文件编辑会自动获批，因此启动
   * 本身是用户唯一能拒绝的地方。`bypassPermissions` 和
   * 非交互式运行无人可问；其他所有情况下都会提示，除非
   * 用户已将这个工作流名称加入允许列表。
   */
  async checkPermissions(input, context) {
    const appState = context?.getAppState()
    const permissionContext = appState?.toolPermissionContext
    if (
      permissionContext?.mode === 'bypassPermissions' ||
      context?.options.isNonInteractiveSession
    ) {
      return { behavior: 'allow', updatedInput: input }
    }
    // Ultracode 是对每个任务进行编排的常驻指令；每次运行都提示
    // 就意味着每个回合都要提示。
    if (appState?.ultracode === true) {
      return { behavior: 'allow', updatedInput: input }
    }
    // 自动模式每台机器只询问一次，然后记住。
    if (permissionContext?.mode === 'auto' && hasAcceptedWorkflowsInAutoMode()) {
      return { behavior: 'allow', updatedInput: input }
    }

    const ruleContent = typeof input.name === 'string' ? input.name : undefined
    if (ruleContent && permissionContext) {
      const denied = getRuleByContentsForTool(
        permissionContext,
        WorkflowTool,
        'deny',
      ).get(ruleContent)
      if (denied) {
        return {
          behavior: 'deny',
          message: `${WORKFLOW_TOOL_NAME} denied for workflow "${ruleContent}".`,
          decisionReason: { type: 'rule', rule: denied },
        }
      }
      const allowed = getRuleByContentsForTool(
        permissionContext,
        WorkflowTool,
        'allow',
      ).get(ruleContent)
      if (allowed) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'rule', rule: allowed },
        }
      }
    }

    return {
      behavior: 'ask',
      message:
        'Limkenion wants to run a dynamic workflow, which can spawn many subagents and use a large number of tokens.',
      ...(ruleContent
        ? {
            suggestions: [
              {
                type: 'addRules' as const,
                rules: [{ toolName: WORKFLOW_TOOL_NAME, ruleContent }],
                behavior: 'allow' as const,
                destination: 'localSettings' as const,
              },
            ],
          }
        : {}),
    }
  },
  async description(input) {
    if (input.name) return `Run the ${input.name} workflow`
    return 'Run a dynamic workflow'
  },
  async prompt() {
    return getWorkflowToolPrompt()
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  async call(input, toolUseContext, canUseTool) {
    const disabled = getWorkflowsDisabledReason()
    if (disabled) throw new Error(describeWorkflowsDisabled(disabled))

    const resolved = await resolveScript(input)
    if ('error' in resolved) throw new Error(resolved.error)

    const prepared = prepareWorkflowScript(resolved.script)
    if (!prepared.ok) throw new Error(prepared.error)

    const workflowRunId = input.resumeFromRunId ?? createWorkflowRunId()
    const taskId = generateTaskId('local_workflow')

    const launched = launchWorkflow({
      taskId,
      workflowRunId,
      script: resolved.script,
      scriptPath: resolved.scriptPath,
      args: input.args,
      meta: prepared.meta,
      vmScript: prepared.vmScript,
      toolUseContext,
      canUseTool,
      toolUseId: toolUseContext.toolUseId,
      isResume: input.resumeFromRunId !== undefined,
    })

    return {
      data: {
        status: 'async_launched' as const,
        taskId,
        taskType: 'local_workflow' as const,
        workflowName: prepared.meta.name,
        runId: workflowRunId,
        summary: prepared.meta.description,
        transcriptDir: launched.transcriptDir,
        scriptPath: launched.scriptPath,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * 判断本次调用应运行哪个脚本。
 *
 * `scriptPath` 优先，这样编辑过的运行可以逐字节重新启动，其次是
 * 保存的 `name`，然后是内联的 `script`。在这里按名称解析（而不是
 * 让模型把脚本再粘贴回来）正是 `/deep-research` 和
 * 已保存的工作流能成为单行调用的原因。
 */
export async function resolveScriptForTesting(input: {
  script?: string
  scriptPath?: string
  name?: string
}): Promise<{ script: string; scriptPath?: string } | { error: string }> {
  return resolveScript(input)
}

async function resolveScript(input: {
  script?: string
  scriptPath?: string
  name?: string
}): Promise<{ script: string; scriptPath?: string } | { error: string }> {
  if (input.scriptPath) {
    try {
      const script = await readFile(input.scriptPath, 'utf8')
      return { script, scriptPath: input.scriptPath }
    } catch (error) {
      return {
        error: `Failed to read workflow script file ${input.scriptPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }

  if (input.name) {
    const workflow = await findWorkflowByName(input.name)
    if (!workflow) {
      const available = (await loadWorkflows())
        .map(entry => entry.name)
        .join(', ')
      return {
        error: `Unknown workflow '${input.name}'.${available ? ` Available: ${available}` : ''}`,
      }
    }
    // 有意不传 scriptPath：该运行会获得自己的会话副本。若指向
    // 已保存的工作流，运行就会回写覆盖用户的
    // 文件，并且之后会从该文件的当时内容恢复，而不是
    // 从实际运行的内容恢复。
    return { script: workflow.script }
  }

  if (input.script) return { script: input.script }

  return {
    error: 'Workflow requires one of `script`, `scriptPath`, or `name`.',
  }
}
