import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Markdown } from '../../components/Markdown.js';
import { Box, Text } from '../../ink.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { type IdleNotificationMessage, isIdleNotification, isPlanApprovalRequest, isPlanApprovalResponse, type PlanApprovalRequestMessage, type PlanApprovalResponseMessage } from '../../utils/teammateMailbox.js';
import { getShutdownMessageSummary } from './ShutdownMessage.js';
import { getTaskAssignmentSummary } from './TaskAssignmentMessage.js';
type PlanApprovalRequestProps = {
  request: PlanApprovalRequestMessage;
};

/**
 * 渲染一个带有 planMode 颜色边框的方案审批请求，
 * 展示方案内容以及批准/拒绝的操作说明。
 */
export function PlanApprovalRequestDisplay(t0) {
  const $ = _c(10);
  const {
    request
  } = t0;
  let t1;
  if ($[0] !== request.from) {
    t1 = <Box marginBottom={1}><Text color="planMode" bold={true}>来自 {request.from} 的方案审批请求</Text></Box>;
    $[0] = request.from;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== request.planContent) {
    t2 = <Box borderStyle="dashed" borderColor="subtle" borderLeft={false} borderRight={false} flexDirection="column" paddingX={1} marginBottom={1}><Markdown>{request.planContent}</Markdown></Box>;
    $[2] = request.planContent;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] !== request.planFilePath) {
    t3 = <Text dimColor={true}>方案文件：{request.planFilePath}</Text>;
    $[4] = request.planFilePath;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] !== t1 || $[7] !== t2 || $[8] !== t3) {
    t4 = <Box flexDirection="column" marginY={1}><Box borderStyle="round" borderColor="planMode" flexDirection="column" paddingX={1}>{t1}{t2}{t3}</Box></Box>;
    $[6] = t1;
    $[7] = t2;
    $[8] = t3;
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  return t4;
}
type PlanApprovalResponseProps = {
  response: PlanApprovalResponseMessage;
  senderName: string;
};

/**
 * 渲染一个带有成功（绿）或错误（红）边框的方案审批响应。
 */
export function PlanApprovalResponseDisplay(t0) {
  const $ = _c(13);
  const {
    response,
    senderName
  } = t0;
  if (response.approved) {
    let t1;
    if ($[0] !== senderName) {
      t1 = <Box><Text color="success" bold={true}>✓ {senderName} 已批准方案</Text></Box>;
      $[0] = senderName;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    let t2;
    if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
      t2 = <Box marginTop={1}><Text>现在你可以继续进行实现。你的 plan mode 限制已解除。</Text></Box>;
      $[2] = t2;
    } else {
      t2 = $[2];
    }
    let t3;
    if ($[3] !== t1) {
      t3 = <Box flexDirection="column" marginY={1}><Box borderStyle="round" borderColor="success" flexDirection="column" paddingX={1} paddingY={1}>{t1}{t2}</Box></Box>;
      $[3] = t1;
      $[4] = t3;
    } else {
      t3 = $[4];
    }
    return t3;
  }
  let t1;
  if ($[5] !== senderName) {
    t1 = <Box><Text color="error" bold={true}>✗ 方案被 {senderName} 拒绝</Text></Box>;
    $[5] = senderName;
    $[6] = t1;
  } else {
    t1 = $[6];
  }
  let t2;
  if ($[7] !== response.feedback) {
    t2 = response.feedback && <Box marginTop={1} borderStyle="dashed" borderColor="subtle" borderLeft={false} borderRight={false} paddingX={1}><Text>反馈：{response.feedback}</Text></Box>;
    $[7] = response.feedback;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  let t3;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box marginTop={1}><Text dimColor={true}>请根据反馈修改你的方案，并再次调用 ExitPlanMode。</Text></Box>;
    $[9] = t3;
  } else {
    t3 = $[9];
  }
  let t4;
  if ($[10] !== t1 || $[11] !== t2) {
    t4 = <Box flexDirection="column" marginY={1}><Box borderStyle="round" borderColor="error" flexDirection="column" paddingX={1} paddingY={1}>{t1}{t2}{t3}</Box></Box>;
    $[10] = t1;
    $[11] = t2;
    $[12] = t4;
  } else {
    t4 = $[12];
  }
  return t4;
}

/**
 * 尝试从原始内容解析并渲染方案审批消息。
 * 如果是方案审批消息则返回渲染后的组件，否则返回 null。
 */
export function tryRenderPlanApprovalMessage(content: string, senderName: string): React.ReactNode | null {
  const request = isPlanApprovalRequest(content);
  if (request) {
    return <PlanApprovalRequestDisplay request={request} />;
  }
  const response = isPlanApprovalResponse(content);
  if (response) {
    return <PlanApprovalResponseDisplay response={response} senderName={senderName} />;
  }
  return null;
}

/**
 * 获取方案审批消息的简短摘要文本。
 * 用于诸如收件箱队列等需要简短描述的场景。
 * 如果内容不是方案审批消息则返回 null。
 */
function getPlanApprovalSummary(content: string): string | null {
  const request = isPlanApprovalRequest(content);
  if (request) {
    return `[来自 ${request.from} 的方案审批请求]`;
  }
  const response = isPlanApprovalResponse(content);
  if (response) {
    if (response.approved) {
      return '[方案已批准] 你现在可以进行实现';
    } else {
      return `[方案被拒绝] ${response.feedback || '请修改你的方案'}`;
    }
  }
  return null;
}

/**
 * 获取空闲通知的简短摘要文本。
 */
function getIdleNotificationSummary(msg: IdleNotificationMessage): string {
  const parts: string[] = ['Agent 处于空闲'];
  if (msg.completedTaskId) {
    const status = msg.completedStatus || 'completed';
    parts.push(`任务 ${msg.completedTaskId} ${status}`);
  }
  if (msg.summary) {
    parts.push(`最后一条消息：${msg.summary}`);
  }
  return parts.join(' · ');
}

/**
 * 格式化队友消息内容以用于展示。
 * 如果是结构化消息（方案审批、关闭或空闲），返回格式化摘要。
 * 否则返回原始内容。
 */
export function formatTeammateMessageContent(content: string): string {
  const planSummary = getPlanApprovalSummary(content);
  if (planSummary) {
    return planSummary;
  }
  const shutdownSummary = getShutdownMessageSummary(content);
  if (shutdownSummary) {
    return shutdownSummary;
  }
  const idleMsg = isIdleNotification(content);
  if (idleMsg) {
    return getIdleNotificationSummary(idleMsg);
  }
  const taskAssignmentSummary = getTaskAssignmentSummary(content);
  if (taskAssignmentSummary) {
    return taskAssignmentSummary;
  }

  // 检查 teammate_terminated 消息
  try {
    const parsed = jsonParse(content) as {
      type?: string;
      message?: string;
    };
    if (parsed?.type === 'teammate_terminated' && parsed.message) {
      return parsed.message;
    }
  } catch {
    // 不是 JSON
  }
  return content;
}