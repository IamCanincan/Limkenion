import React, { useCallback, useMemo, useState } from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { PermissionDialog } from '../../components/permissions/PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
  type ToolAnalyticsContext,
} from '../../components/permissions/PermissionPrompt.js'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'
import { PermissionRuleExplanation } from '../../components/permissions/PermissionRuleExplanation.js'
import {
  type UnaryEvent,
  usePermissionRequestLogging,
} from '../../components/permissions/hooks.js'
import { Box, Text } from '../../ink.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { recordWorkflowAutoModeConsent } from '../../utils/workflows/autoModeConsent.js'
import { parseWorkflowScript } from '../../utils/workflows/meta.js'
import type { WorkflowMeta } from '../../utils/workflows/types.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

type WorkflowOptionValue = 'yes' | 'yes-always' | 'view' | 'no'

/**
 * 在动态工作流启动前显示的批准对话框。
 *
 * 该对话框的重点是阶段列表：它是用户对即将运行多少个
 * agent 以及它们会做什么的唯一预览，也是
 * 最后一个决策点 —— 一旦运行开始，其子代理的文件编辑
 * 就会自动获批。
 */
export function WorkflowPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  const { toolUseConfirm, onDone, onReject, workerBadge } = props

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({ completion_type: 'tool_use_single', language_name: 'none' }),
    [],
  )
  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const input = toolUseConfirm.input as {
    script?: string
    name?: string
    scriptPath?: string
    args?: unknown
  }
  const script = typeof input.script === 'string' ? input.script : undefined
  const meta = useMemo(() => readMeta(input.script), [input.script])
  const workflowName = meta?.name ?? input.name ?? 'workflow'
  const description = meta?.description
  const phases = meta?.phases ?? []
  const originalCwd = getOriginalCwd()
  const showAlwaysAllow = shouldShowAlwaysAllowOptions() && Boolean(input.name)
  const [showScript, setShowScript] = useState(false)

  const options = useMemo<PermissionPromptOption<WorkflowOptionValue>[]>(() => {
    const built: PermissionPromptOption<WorkflowOptionValue>[] = [
      { label: 'Yes, run it', value: 'yes', feedbackConfig: { type: 'accept' } },
    ]
    if (showAlwaysAllow) {
      built.push({
        label: (
          <Text>
            Yes, and don&apos;t ask again for <Text bold>{workflowName}</Text> in{' '}
            <Text bold>{originalCwd}</Text>
          </Text>
        ),
        value: 'yes-always',
      })
    }
    if (script && !showScript) {
      built.push({ label: 'View raw script', value: 'view' })
    }
    built.push({ label: 'No', value: 'no', feedbackConfig: { type: 'reject' } })
    return built
  }, [showAlwaysAllow, workflowName, originalCwd, script, showScript])

  const toolAnalyticsContext = useMemo<ToolAnalyticsContext>(
    () => ({
      toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }),
    [toolUseConfirm.tool.name, toolUseConfirm.tool.isMcp],
  )

  const isAutoMode =
    toolUseConfirm.toolUseContext.getAppState().toolPermissionContext.mode ===
    'auto'

  const handleSelect = useCallback(
    (value: WorkflowOptionValue, feedback?: string) => {
      // 在自动模式下，任一形式的 Yes 即为一次性同意 —— 此后
      // 启动提示词不再出现。
      if (isAutoMode && (value === 'yes' || value === 'yes-always')) {
        recordWorkflowAutoModeConsent()
      }
      switch (value) {
        case 'yes':
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
          onDone()
          break
        case 'yes-always':
          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [
                { toolName: WORKFLOW_TOOL_NAME, ruleContent: workflowName },
              ],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ])
          onDone()
          break
        case 'view':
          // 停留在对话框中：重点就是先读脚本再
          // 决定，因此这不能以任何方式了结权限。
          setShowScript(true)
          break
        case 'no':
          toolUseConfirm.onReject(feedback)
          onReject()
          onDone()
          break
      }
    },
    [toolUseConfirm, onDone, onReject, workflowName, isAutoMode],
  )

  const handleCancel = useCallback(() => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  return (
    <PermissionDialog
      title={`Run workflow "${workflowName}"?`}
      workerBadge={workerBadge}
    >
      <Text>
        A workflow spawns many subagents in the background. Their file edits are
        auto-approved and the run can use a large number of tokens.
      </Text>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {description ? <Text dimColor>{description}</Text> : null}
        {phases.length > 0 ? (
          <Box flexDirection="column" marginTop={description ? 1 : 0}>
            <Text dimColor>Phases:</Text>
            {phases.map((phase, index) => (
              <Text key={`${phase.title}-${index}`} dimColor>
                {`  ${index + 1}. ${phase.title}`}
                {phase.detail ? ` — ${phase.detail}` : ''}
              </Text>
            ))}
          </Box>
        ) : null}
        {input.scriptPath ? (
          <Box marginTop={1}>
            <Text dimColor>{`Script: ${input.scriptPath}`}</Text>
          </Box>
        ) : null}
        {showScript && script ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Raw script:</Text>
            <Text>{clipScript(script)}</Text>
          </Box>
        ) : null}
      </Box>

      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
      </Box>
    </PermissionDialog>
  )
}

const SCRIPT_PREVIEW_LINES = 60

/** 过长的脚本会被裁剪：对话框必须保持小于终端窗口。 */
function clipScript(script: string): string {
  const lines = script.split('\n')
  if (lines.length <= SCRIPT_PREVIEW_LINES) return script
  const remaining = lines.length - SCRIPT_PREVIEW_LINES
  return (
    `${lines.slice(0, SCRIPT_PREVIEW_LINES).join('\n')}\n` +
    `… ${remaining} more lines — the full script is persisted under the session directory`
  )
}

/**
 * 读取脚本的 `meta` 用于预览。
 *
 * 这里解析可能失败 —— 工具尚未校验该脚本 —— 而有问题的
 * 脚本仍应送达工具，以便模型看到真正的解析
 * 错误，而不是对话框中的静默拒绝。
 */
function readMeta(script: string | undefined): WorkflowMeta | undefined {
  if (!script) return undefined
  const parsed = parseWorkflowScript(script)
  return 'error' in parsed ? undefined : parsed.meta
}
