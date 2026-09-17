import { feature } from 'bun:bundle';
import * as React from 'react';
import { useMemo } from 'react';
import { Box } from 'src/ink.js';
import { useAppState } from 'src/state/AppState.js';
import { STATUS_TAG, SUMMARY_TAG, TASK_NOTIFICATION_TAG } from '../../constants/xml.js';
import { QueuedMessageProvider } from '../../context/QueuedMessageContext.js';
import { useCommandQueue } from '../../hooks/useCommandQueue.js';
import type { QueuedCommand } from '../../types/textInputTypes.js';
import { isQueuedCommandVisible } from '../../utils/messageQueueManager.js';
import { createUserMessage, EMPTY_LOOKUPS, normalizeMessages } from '../../utils/messages.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { Message } from '../Message.js';
const EMPTY_SET = new Set<string>();

/**
 * 检查命令值是否是需要隐藏的空闲通知。
 * 空闲通知会被静默处理，不展示给用户。
 */
function isIdleNotification(value: string): boolean {
  try {
    const parsed = jsonParse(value);
    return parsed?.type === 'idle_notification';
  } catch {
    return false;
  }
}

// 最多显示的任务通知行数
const MAX_VISIBLE_NOTIFICATIONS = 3;

/**
 * 为超出上限的任务通知创建合成的溢出通知消息。
 */
function createOverflowNotificationMessage(count: number): string {
  return `<${TASK_NOTIFICATION_TAG}>
<${SUMMARY_TAG}>+${count} 个任务已完成</${SUMMARY_TAG}>
<${STATUS_TAG}>completed</${STATUS_TAG}>
</${TASK_NOTIFICATION_TAG}>`;
}

/**
 * 处理排队的命令，将任务通知限制在 MAX_VISIBLE_NOTIFICATIONS 行以内。
 * 其他命令类型始终完整展示。
 * 空闲通知会被完全过滤掉。
 */
function processQueuedCommands(queuedCommands: QueuedCommand[]): QueuedCommand[] {
  // 过滤掉空闲通知——它们会被静默处理
  const filteredCommands = queuedCommands.filter(cmd => typeof cmd.value !== 'string' || !isIdleNotification(cmd.value));

  // 将任务通知与其他命令分开
  const taskNotifications = filteredCommands.filter(cmd => cmd.mode === 'task-notification');
  const otherCommands = filteredCommands.filter(cmd => cmd.mode !== 'task-notification');

  // 若通知未超过限制，原样返回所有命令
  if (taskNotifications.length <= MAX_VISIBLE_NOTIFICATIONS) {
    return [...otherCommands, ...taskNotifications];
  }

  // 先显示前 (MAX_VISIBLE_NOTIFICATIONS - 1) 条通知，再显示一条汇总
  const visibleNotifications = taskNotifications.slice(0, MAX_VISIBLE_NOTIFICATIONS - 1);
  const overflowCount = taskNotifications.length - (MAX_VISIBLE_NOTIFICATIONS - 1);

  // 创建合成的溢出消息
  const overflowCommand: QueuedCommand = {
    value: createOverflowNotificationMessage(overflowCount),
    mode: 'task-notification'
  };
  return [...otherCommands, ...visibleNotifications, overflowCommand];
}
function PromptInputQueuedCommandsImpl(): React.ReactNode {
  const queuedCommands = useCommandQueue();
  const viewingAgent = useAppState(s => !!s.viewingAgentTaskId);
  // 精简布局：将队列项变暗 + 跳过 paddingX（精简消息
  // 自身已缩进）。开关与其他地方的精简加载指示/消息
  // 检查保持一致——由于查看队友时该组件会提前返回，
  // 因此无需队友视图覆盖。
  const useBriefLayout = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_0 => s_0.isBriefOnly) : false;

  // createUserMessage 每次调用都会生成新的 UUID；若不使用 memo，流的
  // 重新渲染会使 Message 的 areMessagePropsEqual（比较 uuid）失效 → 闪烁。
  const messages = useMemo(() => {
    if (queuedCommands.length === 0) return null;
    // task-notification 通过 useInboxNotification 展示；大多数 isMeta 命令
    // （定时任务、主动模式调用）由系统生成并隐藏。
    // 频道消息是例外——虽为 isMeta 但会展示，以便键盘
    // 用户看到到达的消息。
    const visibleCommands = queuedCommands.filter(isQueuedCommandVisible);
    if (visibleCommands.length === 0) return null;
    const processedCommands = processQueuedCommands(visibleCommands);
    return normalizeMessages(processedCommands.map(cmd => {
      let content = cmd.value;
      if (cmd.mode === 'bash' && typeof content === 'string') {
        content = `<bash-input>${content}</bash-input>`;
      }
      // [Image #N] 占位符内联在文本值中（在粘贴时插入），因此
      // 队列预览无需存根块即可显示它们。
      return createUserMessage({
        content
      });
    }));
  }, [queuedCommands]);

  // 查看任意智能体的会话记录时不显示主控的排队命令
  if (viewingAgent || messages === null) {
    return null;
  }
  return <Box marginTop={1} flexDirection="column">
      {messages.map((message, i) => <QueuedMessageProvider key={i} isFirst={i === 0} useBriefLayout={useBriefLayout}>
          <Message message={message} lookups={EMPTY_LOOKUPS} addMargin={false} tools={[]} commands={[]} verbose={false} inProgressToolUseIDs={EMPTY_SET} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} isTranscriptMode={false} isStatic={true} />
        </QueuedMessageProvider>)}
    </Box>;
}
export const PromptInputQueuedCommands = React.memo(PromptInputQueuedCommandsImpl);