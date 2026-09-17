import figures from 'figures';
import { homedir } from 'os';
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import type { Step } from '../../projectOnboardingState.js';
import { formatCreditAmount, getCachedReferrerReward } from '../../services/api/referral.js';
import type { LogOption } from '../../types/logs.js';
import { getCwd } from '../../utils/cwd.js';
import { formatRelativeTimeAgo } from '../../utils/format.js';
import type { FeedConfig, FeedLine } from './Feed.js';
export function createRecentActivityFeed(activities: LogOption[]): FeedConfig {
  const lines: FeedLine[] = activities.map(log => {
    const time = formatRelativeTimeAgo(log.modified);
    const description = log.summary && log.summary !== 'No prompt' ? log.summary : log.firstPrompt;
    return {
      text: description || '',
      timestamp: time
    };
  });
  return {
    title: '最近活动',
    lines,
    footer: lines.length > 0 ? '/resume 查看更多' : undefined,
    emptyMessage: '暂无最近活动'
  };
}
export function createWhatsNewFeed(releaseNotes: string[]): FeedConfig {
  const lines: FeedLine[] = releaseNotes.map(note => {
    
    return {
      text: note
    };
  });
  const emptyMessage = '前往 Limkenion 更新日志查看新内容';
  return {
    title: '更新内容',
    lines,
    footer: lines.length > 0 ? '/release-notes 查看更多' : undefined,
    emptyMessage
  };
}
export function createProjectOnboardingFeed(steps: Step[]): FeedConfig {
  const enabledSteps = steps.filter(({
    isEnabled
  }) => isEnabled).sort((a, b) => Number(a.isComplete) - Number(b.isComplete));
  const lines: FeedLine[] = enabledSteps.map(({
    text,
    isComplete
  }) => {
    const checkmark = isComplete ? `${figures.tick} ` : '';
    return {
      text: `${checkmark}${text}`
    };
  });
  const warningText = getCwd() === homedir() ? '提示：你已在主目录中启动 Limkenion。为获得最佳体验，请在项目目录中启动。' : undefined;
  if (warningText) {
    lines.push({
      text: warningText
    });
  }
  return {
    title: '上手建议',
    lines
  };
}
export function createGuestPassesFeed(): FeedConfig {
  const reward = getCachedReferrerReward();
  const subtitle = reward ? `分享 Limkenion，获赠 ${formatCreditAmount(reward)} 额外额度` : '与好友分享 Limkenion';
  return {
    title: '3 张访客通行证',
    lines: [],
    customContent: {
      content: <>
          <Box marginY={1}>
            <Text color="limkenion">[✻] [✻] [✻]</Text>
          </Box>
          <Text dimColor>{subtitle}</Text>
        </>,
      width: 48
    },
    footer: '/passes'
  };
}