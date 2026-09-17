import { c as _c } from "react/compiler-runtime";
import { feature } from 'bun:bundle';
import * as React from 'react';
import { EnterPlanModeTool } from 'src/tools/EnterPlanModeTool/EnterPlanModeTool.js';
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js';
import { useNotifyAfterTimeout } from '../../hooks/useNotifyAfterTimeout.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { AnyObject, Tool, ToolUseContext } from '../../Tool.js';
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { BashTool } from '../../tools/BashTool/BashTool.js';
import { FileEditTool } from '../../tools/FileEditTool/FileEditTool.js';
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js';
import { FileWriteTool } from '../../tools/FileWriteTool/FileWriteTool.js';
import { GlobTool } from '../../tools/GlobTool/GlobTool.js';
import { GrepTool } from '../../tools/GrepTool/GrepTool.js';
import { NotebookEditTool } from '../../tools/NotebookEditTool/NotebookEditTool.js';
import { PowerShellTool } from '../../tools/PowerShellTool/PowerShellTool.js';
import { SkillTool } from '../../tools/SkillTool/SkillTool.js';
import { WebFetchTool } from '../../tools/WebFetchTool/WebFetchTool.js';
import type { AssistantMessage } from '../../types/message.js';
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js';
import { AskUserQuestionPermissionRequest } from './AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js';
import { BashPermissionRequest } from './BashPermissionRequest/BashPermissionRequest.js';
import { EnterPlanModePermissionRequest } from './EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js';
import { ExitPlanModePermissionRequest } from './ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js';
import { FallbackPermissionRequest } from './FallbackPermissionRequest.js';
import { FileEditPermissionRequest } from './FileEditPermissionRequest/FileEditPermissionRequest.js';
import { FilesystemPermissionRequest } from './FilesystemPermissionRequest/FilesystemPermissionRequest.js';
import { FileWritePermissionRequest } from './FileWritePermissionRequest/FileWritePermissionRequest.js';
import { NotebookEditPermissionRequest } from './NotebookEditPermissionRequest/NotebookEditPermissionRequest.js';
import { PowerShellPermissionRequest } from './PowerShellPermissionRequest/PowerShellPermissionRequest.js';
import { SkillPermissionRequest } from './SkillPermissionRequest/SkillPermissionRequest.js';
import { WebFetchPermissionRequest } from './WebFetchPermissionRequest/WebFetchPermissionRequest.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const ReviewArtifactTool = feature('REVIEW_ARTIFACT') ? (require('../../tools/ReviewArtifactTool/ReviewArtifactTool.js') as typeof import('../../tools/ReviewArtifactTool/ReviewArtifactTool.js')).ReviewArtifactTool : null;
const ReviewArtifactPermissionRequest = feature('REVIEW_ARTIFACT') ? (require('./ReviewArtifactPermissionRequest/ReviewArtifactPermissionRequest.js') as typeof import('./ReviewArtifactPermissionRequest/ReviewArtifactPermissionRequest.js')).ReviewArtifactPermissionRequest : null;
const WorkflowTool = feature('WORKFLOW_SCRIPTS') ? (require('../../tools/WorkflowTool/WorkflowTool.js') as typeof import('../../tools/WorkflowTool/WorkflowTool.js')).WorkflowTool : null;
const WorkflowPermissionRequest = feature('WORKFLOW_SCRIPTS') ? (require('../../tools/WorkflowTool/WorkflowPermissionRequest.js') as typeof import('../../tools/WorkflowTool/WorkflowPermissionRequest.js')).WorkflowPermissionRequest : null;
const MonitorTool = feature('MONITOR_TOOL') ? (require('../../tools/MonitorTool/MonitorTool.js') as typeof import('../../tools/MonitorTool/MonitorTool.js')).MonitorTool : null;
const MonitorPermissionRequest = feature('MONITOR_TOOL') ? (require('./MonitorPermissionRequest/MonitorPermissionRequest.js') as typeof import('./MonitorPermissionRequest/MonitorPermissionRequest.js')).MonitorPermissionRequest : null;
import type { ContentBlockParam } from '../../types/llm-protocol.js';
/* eslint-enable @typescript-eslint/no-require-imports */
import type { z } from 'zod/v4';
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js';
import type { WorkerBadgeProps } from './WorkerBadge.js';
function permissionComponentForTool(tool: Tool): React.ComponentType<PermissionRequestProps> {
  switch (tool) {
    case FileEditTool:
      return FileEditPermissionRequest;
    case FileWriteTool:
      return FileWritePermissionRequest;
    case BashTool:
      return BashPermissionRequest;
    case PowerShellTool:
      return PowerShellPermissionRequest;
    case ReviewArtifactTool:
      return ReviewArtifactPermissionRequest ?? FallbackPermissionRequest;
    case WebFetchTool:
      return WebFetchPermissionRequest;
    case NotebookEditTool:
      return NotebookEditPermissionRequest;
    case ExitPlanModeV2Tool:
      return ExitPlanModePermissionRequest;
    case EnterPlanModeTool:
      return EnterPlanModePermissionRequest;
    case SkillTool:
      return SkillPermissionRequest;
    case AskUserQuestionTool:
      return AskUserQuestionPermissionRequest;
    case WorkflowTool:
      return WorkflowPermissionRequest ?? FallbackPermissionRequest;
    case MonitorTool:
      return MonitorPermissionRequest ?? FallbackPermissionRequest;
    case GlobTool:
    case GrepTool:
    case FileReadTool:
      return FilesystemPermissionRequest;
    default:
      return FallbackPermissionRequest;
  }
}
export type PermissionRequestProps<Input extends AnyObject = AnyObject> = {
  toolUseConfirm: ToolUseConfirm<Input>;
  toolUseContext: ToolUseContext;
  onDone(): void;
  onReject(): void;
  verbose: boolean;
  workerBadge: WorkerBadgeProps | undefined;
  /**
   * 注册要在可滚动区域下方固定页脚中渲染的 JSX。
   * 仅全屏模式可用（非全屏没有固定区域——终端
   * 回滚会同时移动所有内容）。传入 null 以清空。
   *
   * 由 ExitPlanModePermissionRequest 使用，让用户滚动较长的计划时
   * 响应选项保持可见。该回调是稳定的——
   * 传入的 JSX 应使用 ref 来引用那些闭包捕获组件状态的回调，
   * 以避免过期闭包（React 会调和该 JSX，保留 Select
   * 内部的焦点/输入状态）。
   */
  setStickyFooter?: (jsx: React.ReactNode | null) => void;
};
export type ToolUseConfirm<Input extends AnyObject = AnyObject> = {
  assistantMessage: AssistantMessage;
  tool: Tool<Input>;
  description: string;
  input: z.infer<Input>;
  toolUseContext: ToolUseContext;
  toolUseID: string;
  permissionResult: PermissionDecision;
  permissionPromptStartTimeMs: number;
  /**
   * 在用户与许可对话框交互时（如箭头键、Tab、输入）调用。
   * 这可以防止异步自动批准机制（如 bash 分类器）在用户
   * 主动操作对话框时将其关闭。
   */
  classifierCheckInProgress?: boolean;
  classifierAutoApproved?: boolean;
  classifierMatchedRule?: string;
  workerBadge?: WorkerBadgeProps;
  onUserInteraction(): void;
  onAbort(): void;
  onDismissCheckmark?(): void;
  onAllow(updatedInput: z.infer<Input>, permissionUpdates: PermissionUpdate[], feedback?: string, contentBlocks?: ContentBlockParam[]): void;
  onReject(feedback?: string, contentBlocks?: ContentBlockParam[]): void;
  recheckPermission(): Promise<void>;
};
function getNotificationMessage(toolUseConfirm: ToolUseConfirm): string {
  const toolName = toolUseConfirm.tool.userFacingName(toolUseConfirm.input as never);
  if (toolUseConfirm.tool === ExitPlanModeV2Tool) {
    return 'Limkenion 需要您批准该计划';
  }
  if (toolUseConfirm.tool === EnterPlanModeTool) {
    return 'Limkenion 想要进入计划模式';
  }
  if (feature('REVIEW_ARTIFACT') && toolUseConfirm.tool === ReviewArtifactTool) {
    return 'Limkenion 需要您批准审查产物';
  }
  if (!toolName || toolName.trim() === '') {
    return 'Limkenion 需要您的关注';
  }
  return `Limkenion 需要您的权限来使用 ${toolName}`;
}

// TODO：将其移到 Tool.renderPermissionRequest
export function PermissionRequest(t0) {
  const $ = _c(18);
  const {
    toolUseConfirm,
    toolUseContext,
    onDone,
    onReject,
    verbose,
    workerBadge,
    setStickyFooter
  } = t0;
  let t1;
  if ($[0] !== onDone || $[1] !== onReject || $[2] !== toolUseConfirm) {
    t1 = () => {
      onDone();
      onReject();
      toolUseConfirm.onReject();
    };
    $[0] = onDone;
    $[1] = onReject;
    $[2] = toolUseConfirm;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  let t2;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {
      context: "Confirmation"
    };
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  useKeybinding("app:interrupt", t1, t2);
  let t3;
  if ($[5] !== toolUseConfirm) {
    t3 = getNotificationMessage(toolUseConfirm);
    $[5] = toolUseConfirm;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  const notificationMessage = t3;
  useNotifyAfterTimeout(notificationMessage, "permission_prompt");
  let t4;
  if ($[7] !== toolUseConfirm.tool) {
    t4 = permissionComponentForTool(toolUseConfirm.tool);
    $[7] = toolUseConfirm.tool;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  const PermissionComponent = t4;
  let t5;
  if ($[9] !== PermissionComponent || $[10] !== onDone || $[11] !== onReject || $[12] !== setStickyFooter || $[13] !== toolUseConfirm || $[14] !== toolUseContext || $[15] !== verbose || $[16] !== workerBadge) {
    t5 = <PermissionComponent toolUseContext={toolUseContext} toolUseConfirm={toolUseConfirm} onDone={onDone} onReject={onReject} verbose={verbose} workerBadge={workerBadge} setStickyFooter={setStickyFooter} />;
    $[9] = PermissionComponent;
    $[10] = onDone;
    $[11] = onReject;
    $[12] = setStickyFooter;
    $[13] = toolUseConfirm;
    $[14] = toolUseContext;
    $[15] = verbose;
    $[16] = workerBadge;
    $[17] = t5;
  } else {
    t5 = $[17];
  }
  return t5;
}