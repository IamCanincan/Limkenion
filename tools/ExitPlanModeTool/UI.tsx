import * as React from 'react';
import { Markdown } from 'src/components/Markdown.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { RejectedPlanMessage } from 'src/components/messages/UserToolResultMessage/RejectedPlanMessage.js';
import { BLACK_CIRCLE } from 'src/constants/figures.js';
import { getModeColor } from 'src/utils/permissions/PermissionMode.js';
import { Box, Text } from '../../ink.js';
import type { ToolProgressData } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import { getDisplayPath } from '../../utils/file.js';
import { getPlan } from '../../utils/plans.js';
import type { ThemeName } from '../../utils/theme.js';
import type { Output } from './ExitPlanModeV2Tool.js';
export function renderToolUseMessage(): React.ReactNode {
  return null;
}
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], {
  theme: _theme
}: {
  theme: ThemeName;
}): React.ReactNode {
  const {
    plan,
    filePath
  } = output;
  const isEmpty = !plan || plan.trim() === '';
  const displayPath = filePath ? getDisplayPath(filePath) : '';
  const awaitingLeaderApproval = output.awaitingLeaderApproval;

  // 空方案的简化消息
  if (isEmpty) {
    return <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
          <Text> 已退出计划模式</Text>
        </Box>
      </Box>;
  }

  // 等待团队负责人审批时，显示不同的消息
  if (awaitingLeaderApproval) {
    return <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
          <Text> 方案已提交给团队负责人审批</Text>
        </Box>
        <MessageResponse>
          <Box flexDirection="column">
            {filePath && <Text dimColor>方案文件：{displayPath}</Text>}
            <Text dimColor>等待团队负责人审阅并批准……</Text>
          </Box>
        </MessageResponse>
      </Box>;
  }
  return <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
        <Text> 用户已批准 Limkenion&apos;s 的方案</Text>
      </Box>
      <MessageResponse>
        <Box flexDirection="column">
          {filePath && <Text dimColor>方案已保存到：{displayPath} · 使用 /plan 编辑</Text>}
          <Markdown>{plan}</Markdown>
        </Box>
      </MessageResponse>
    </Box>;
}
export function renderToolUseRejectedMessage({
  plan
}: {
  plan?: string;
}, {
  theme: _theme
}: {
  theme: ThemeName;
}): React.ReactNode {
  const planContent = plan ?? getPlan() ?? '未找到方案';
  return <Box flexDirection="column">
      <RejectedPlanMessage plan={planContent} />
    </Box>;
}