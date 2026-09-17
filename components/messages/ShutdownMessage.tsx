import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { isShutdownApproved, isShutdownRejected, isShutdownRequest, type ShutdownRejectedMessage, type ShutdownRequestMessage } from '../../utils/teammateMailbox.js';
type ShutdownRequestProps = {
  request: ShutdownRequestMessage;
};

/**
 * 渲染一个带有警告色边框的关闭请求。
 */
export function ShutdownRequestDisplay(t0) {
  const $ = _c(7);
  const {
    request
  } = t0;
  let t1;
  if ($[0] !== request.from) {
    t1 = <Box marginBottom={1}><Text color="warning" bold={true}>来自 {request.from} 的关闭请求</Text></Box>;
    $[0] = request.from;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== request.reason) {
    t2 = request.reason && <Box><Text>原因：{request.reason}</Text></Box>;
    $[2] = request.reason;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] !== t1 || $[5] !== t2) {
    t3 = <Box flexDirection="column" marginY={1}><Box borderStyle="round" borderColor="warning" flexDirection="column" paddingX={1} paddingY={1}>{t1}{t2}</Box></Box>;
    $[4] = t1;
    $[5] = t2;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  return t3;
}
type ShutdownRejectedProps = {
  response: ShutdownRejectedMessage;
};

/**
 * 渲染一个带有浅灰色（subtle）边框的关闭被拒绝消息。
 */
export function ShutdownRejectedDisplay(t0) {
  const $ = _c(8);
  const {
    response
  } = t0;
  let t1;
  if ($[0] !== response.from) {
    t1 = <Text color="subtle" bold={true}>关闭请求被 {response.from} 拒绝</Text>;
    $[0] = response.from;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== response.reason) {
    t2 = <Box marginTop={1} borderStyle="dashed" borderColor="subtle" borderLeft={false} borderRight={false} paddingX={1}><Text>原因：{response.reason}</Text></Box>;
    $[2] = response.reason;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box marginTop={1}><Text dimColor={true}>队友仍在继续工作。你可以稍后再请求关闭。</Text></Box>;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] !== t1 || $[6] !== t2) {
    t4 = <Box flexDirection="column" marginY={1}><Box borderStyle="round" borderColor="subtle" flexDirection="column" paddingX={1} paddingY={1}>{t1}{t2}{t3}</Box></Box>;
    $[5] = t1;
    $[6] = t2;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  return t4;
}

/**
 * 尝试从原始内容解析并渲染关闭消息。
 * 如果是关闭消息则返回渲染后的组件，否则返回 null。
 */
export function tryRenderShutdownMessage(content: string): React.ReactNode | null {
  const request = isShutdownRequest(content);
  if (request) {
    return <ShutdownRequestDisplay request={request} />;
  }

  // 关闭已获批准由调用方内联处理 —— 此处跳过
  if (isShutdownApproved(content)) {
    return null;
  }
  const rejected = isShutdownRejected(content);
  if (rejected) {
    return <ShutdownRejectedDisplay response={rejected} />;
  }
  return null;
}

/**
 * 获取关闭消息的简短摘要文本。
 * 用于诸如收件箱队列等需要简短描述的场景。
 * 如果内容不是关闭消息则返回 null。
 */
export function getShutdownMessageSummary(content: string): string | null {
  const request = isShutdownRequest(content);
  if (request) {
    return `[来自 ${request.from} 的关闭请求]${request.reason ? ` ：${request.reason}` : ''}`;
  }
  const approved = isShutdownApproved(content);
  if (approved) {
    return `[关闭已批准] ${approved.from} 正在退出`;
  }
  const rejected = isShutdownRejected(content);
  if (rejected) {
    return `[关闭被拒绝] ${rejected.from}：${rejected.reason}`;
  }
  return null;
}