import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import React from 'react';
import { Markdown } from '../../components/Markdown.js';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { Box, Text } from '../../ink.js';
import type { ProgressMessage } from '../../types/message.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatFileSize } from '../../utils/format.js';
import { formatBriefTimestamp } from '../../utils/formatBriefTimestamp.js';
import type { Output } from './BriefTool.js';
export function renderToolUseMessage(): React.ReactNode {
  return '';
}
export function renderToolResultMessage(output: Output, _progressMessages: ProgressMessage[], options?: {
  isTranscriptMode?: boolean;
  isBriefOnly?: boolean;
}): React.ReactNode {
  const hasAttachments = (output.attachments?.length ?? 0) > 0;
  if (!output.message && !hasAttachments) {
    return null;
  }

  // 在 transcript 模式（ctrl+o）下，模型文本不会被过滤——保留 ⏺，使
  // SendUserMessage 与周围文本块在视觉上可区分。
  if (options?.isTranscriptMode) {
    return <Box flexDirection="row" marginTop={1}>
        <Box minWidth={2}>
          <Text color="text">{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexDirection="column">
          {output.message ? <Markdown>{output.message}</Markdown> : null}
          <AttachmentList attachments={output.attachments} />
        </Box>
      </Box>;
  }

  // 仅 Brief（聊天）视图："Limkenion" 标签 + 2 列缩进，与 UserPromptMessage
  // 应用于用户输入的 "You" 标签一致（#20889）。"N in background" 转圈状态
  // 存于 BriefSpinner（Spinner.tsx）——此处只提供无状态标签。
  if (options?.isBriefOnly) {
    const ts = output.sentAt ? formatBriefTimestamp(output.sentAt) : '';
    return <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Box flexDirection="row">
          <Text color="briefLabelLimkenion">Limkenion</Text>
          {ts ? <Text dimColor> {ts}</Text> : null}
        </Box>
        <Box flexDirection="column">
          {output.message ? <Markdown>{output.message}</Markdown> : null}
          <AttachmentList attachments={output.attachments} />
        </Box>
      </Box>;
  }

  // 默认视图：dropTextInBriefTurns（Messages.tsx）会隐藏原本会出现在此之前的
  // 冗余助手文本——SendUserMessage 是其回合中唯一类似文本的内容。无 gutter
  // 标记；按纯文本阅读。userFacingName() 返回 ''，因此 UserToolSuccessMessage
  // 会去掉其 columns-5 宽度约束，AssistantToolUseMessage 渲染为 null（无工具
  // 装饰）。空的 minWidth={2} 盒子镜像了 AssistantTextMessage 的 ⏺ gutter 间距。
  return <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2} />
      <Box flexDirection="column">
        {output.message ? <Markdown>{output.message}</Markdown> : null}
        <AttachmentList attachments={output.attachments} />
      </Box>
    </Box>;
}
type AttachmentListProps = {
  attachments: Output['attachments'];
};
export function AttachmentList(t0) {
  const $ = _c(4);
  const {
    attachments
  } = t0;
  if (!attachments || attachments.length === 0) {
    return null;
  }
  let t1;
  if ($[0] !== attachments) {
    t1 = attachments.map(_temp);
    $[0] = attachments;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1) {
    t2 = <Box flexDirection="column" marginTop={1}>{t1}</Box>;
    $[2] = t1;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  return t2;
}
function _temp(att) {
  return <Box key={att.path} flexDirection="row"><Text dimColor={true}>{figures.pointerSmall} {att.isImage ? "[图片]" : "[文件]"}{" "}</Text><Text>{getDisplayPath(att.path)}</Text><Text dimColor={true}> ({formatFileSize(att.size)})</Text></Box>;
}