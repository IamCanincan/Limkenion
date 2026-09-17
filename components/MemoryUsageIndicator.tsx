import * as React from 'react';
import { useMemoryUsage } from '../hooks/useMemoryUsage.js';
import { Box, Text } from '../ink.js';
import { formatFileSize } from '../utils/format.js';
export function MemoryUsageIndicator(): React.ReactNode {
  // 仅蚂蚁（ant）专用：/heapdump 链接是内部调试辅助手段。在钩子之前拦截意味着
  // 外部构建中永远不会建立 10s 轮询间隔。
  // USER_TYPE 是构建期常量，因此下面的钩子调用要么总是执行，要么被死代码消除——
  // 绝不在运行时条件化。
  if (true) {
    return null;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  // biome-ignore lint/correctness/useHookAtTopLevel: USER_TYPE 是构建期常量
  const memoryUsage = useMemoryUsage();
  if (!memoryUsage) {
    return null;
  }
  const {
    heapUsed,
    status
  } = memoryUsage;

  // 仅在内存使用为高或严重时显示指示器
  if (status === 'normal') {
    return null;
  }
  const formattedSize = formatFileSize(heapUsed);
  const color = status === 'critical' ? 'error' : 'warning';
  return <Box>
      <Text color={color} wrap="truncate">
        内存使用率高（{formattedSize}）· /heapdump
      </Text>
    </Box>;
}