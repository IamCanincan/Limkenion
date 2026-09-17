import { feature } from 'bun:bundle';
import type { TextBlockParam } from '../../types/llm-protocol.js';
import React, { useContext, useMemo } from 'react';
import { getKairosActive, getUserMsgOptIn } from '../../bootstrap/state.js';
import { Box } from '../../ink.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { useAppState } from '../../state/AppState.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { logError } from '../../utils/log.js';
import { countCharInString } from '../../utils/stringUtils.js';
import { MessageActionsSelectedContext } from '../messageActions.js';
import { HighlightedThinkingText } from './HighlightedThinkingText.js';
type Props = {
  addMargin: boolean;
  param: TextBlockParam;
  isTranscriptMode?: boolean;
  timestamp?: string;
};

// 对展示的提示文本设置硬上限。通过 stdin 管道传入大文件
// （例如 `cat 11k-line-file | limkenion`）会创建一条用户消息，其
// <Text> 节点全屏 Ink 渲染器必须在每一帧都进行换行/输出，
// 导致键击延迟超过 500ms。React.memo 会跳过 React 渲染，但
// Ink 输出阶段仍会遍历整个已挂载的文本。非全屏模式通过 <Static>
// （打印后遗忘到终端回滚区）避免了这一问题。
// 采用头+尾，因为 `{ cat file; echo prompt; } | limkenion` 会把用户
// 真正的问题放在末尾。
const MAX_DISPLAY_CHARS = 10_000;
const TRUNCATE_HEAD_CHARS = 2_500;
const TRUNCATE_TAIL_CHARS = 2_500;
export function UserPromptMessage({
  addMargin,
  param: {
    text
  },
  isTranscriptMode,
  timestamp
}: Props): React.ReactNode {
  // REPL.tsx 传入 isBriefOnly={viewedTeammateTask ? false : isBriefOnly}
  // 但该 prop 未传递到这么深 —— 这里通过直接读取 viewingAgentTaskId
  // 复刻该覆盖逻辑。在这里（而非子组件中）计算，
  // 以便父级 Box 能去掉其 backgroundColor：在 brief 模式下
  // 子组件渲染为标签式布局，而 Box 的 backgroundColor 会无条件地渲染在
  // 子组件之后（子组件无法选择退出）。
  //
  // Hook 保持在 feature() 三元表达式内部，这样外部构建不会付出
  // 逐条滚动消息存储订阅的代价（useSyncExternalStore 会绕过
  // React.memo）。与 isBriefEnabled() 一样按运行时门控，但做了内联，
  // 以避免把 BriefTool.ts → prompt.ts 里的工具名字符串引入
  // 外部构建。
  const isBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s => s.isBriefOnly) : false;
  const viewingAgentTaskId = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_0 => s_0.viewingAgentTaskId) : null;
  // 提升到挂载时执行 —— 逐消息组件，每次滚动都会重新渲染。
  const briefEnvEnabled = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useMemo(() => isEnvTruthy(process.env.LIMKENION_BRIEF), []) : false;
  const useBriefLayout = feature('KAIROS') || feature('KAIROS_BRIEF') ? (getKairosActive() || getUserMsgOptIn() && (briefEnvEnabled || getFeatureValue_CACHED_MAY_BE_STALE('limkenion_kairos_brief', false))) && isBriefOnly && !isTranscriptMode && !viewingAgentTaskId : false;

  // 在提前 return 之前截断，以保持 hook 顺序稳定。
  const displayText = useMemo(() => {
    if (text.length <= MAX_DISPLAY_CHARS) return text;
    const head = text.slice(0, TRUNCATE_HEAD_CHARS);
    const tail = text.slice(-TRUNCATE_TAIL_CHARS);
    const hiddenLines = countCharInString(text, '\n', TRUNCATE_HEAD_CHARS) - countCharInString(tail, '\n');
    return `${head}\n… +${hiddenLines} 行 …\n${tail}`;
  }, [text]);
  const isSelected = useContext(MessageActionsSelectedContext);
  if (!text) {
    logError(new Error('在用户提示消息中未找到内容'));
    return null;
  }
  return <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={isSelected ? 'messageActionsBackground' : useBriefLayout ? undefined : 'userMessageBackground'} paddingRight={useBriefLayout ? 0 : 1}>
      <HighlightedThinkingText text={displayText} useBriefLayout={useBriefLayout} timestamp={useBriefLayout ? timestamp : undefined} />
    </Box>;
}