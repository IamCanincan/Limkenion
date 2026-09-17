import { c as _c } from "react/compiler-runtime";
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle';
// Dead code elimination: conditional import for COORDINATOR_MODE
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModule = feature('COORDINATOR_MODE') ? require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js') : undefined;
/* eslint-enable @typescript-eslint/no-require-imports */
import { Box, Text, Link } from '../../ink.js';
import * as React from 'react';
import figures from 'figures';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { VimMode, PromptInputMode } from '../../types/textInputTypes.js';
import type { ToolPermissionContext } from '../../Tool.js';
import { isVimModeEnabled } from './utils.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { isDefaultMode, permissionModeSymbol, permissionModeTitle, getModeColor } from '../../utils/permissions/PermissionMode.js';
import { BackgroundTaskStatus } from '../tasks/BackgroundTaskStatus.js';
import { isBackgroundTask } from '../../tasks/types.js';
import { isPanelAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { getVisibleAgentTasks } from '../CoordinatorAgentStatus.js';
import { count } from '../../utils/array.js';
import { shouldHideTasksFooter } from '../tasks/taskStatusUtils.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { TeamStatus } from '../teams/TeamStatus.js';
import { isInProcessEnabled } from '../../utils/swarm/backends/registry.js';
import { useAppState, useAppStateStore } from 'src/state/AppState.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
import HistorySearchInput from './HistorySearchInput.js';
import { usePrStatus } from '../../hooks/usePrStatus.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { Byline } from '../design-system/Byline.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTasksV2 } from '../../hooks/useTasksV2.js';
import { formatDuration } from '../../utils/format.js';
import { VoiceWarmupHint } from './VoiceIndicator.js';
import { useVoiceState } from '../../context/voice.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { isXtermJs } from '../../ink/terminal.js';
import { useHasSelection, useSelection } from '../../ink/hooks/use-selection.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { getPlatform } from '../../utils/platform.js';
import { PrBadge } from '../PrBadge.js';

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../../proactive/index.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
const NO_OP_SUBSCRIBE = (_cb: () => void) => () => {};
const NULL = () => null;
const MAX_VOICE_HINT_SHOWS = 3;
type Props = {
  exitMessage: {
    show: boolean;
    key?: string;
  };
  vimMode: VimMode | undefined;
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  suppressHint: boolean;
  isLoading: boolean;
  showMemoryTypeSelector?: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  isPasting?: boolean;
  isSearching: boolean;
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  historyFailedMatch: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
};
function ProactiveCountdown() {
  const $ = _c(7);
  const nextTickAt = useSyncExternalStore(proactiveModule?.subscribeToProactiveChanges ?? NO_OP_SUBSCRIBE, proactiveModule?.getNextTickAt ?? NULL, NULL);
  const [remainingSeconds, setRemainingSeconds] = useState(null);
  let t0;
  let t1;
  if ($[0] !== nextTickAt) {
    t0 = () => {
      if (nextTickAt === null) {
        setRemainingSeconds(null);
        return;
      }
      const update = function update() {
        const remaining = Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000));
        setRemainingSeconds(remaining);
      };
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    };
    t1 = [nextTickAt];
    $[0] = nextTickAt;
    $[1] = t0;
    $[2] = t1;
  } else {
    t0 = $[1];
    t1 = $[2];
  }
  useEffect(t0, t1);
  if (remainingSeconds === null) {
    return null;
  }
  const t2 = remainingSeconds * 1000;
  let t3;
  if ($[3] !== t2) {
    t3 = formatDuration(t2, {
      mostSignificantOnly: true
    });
    $[3] = t2;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] !== t3) {
    t4 = <Text dimColor={true}>等待{" "}{t3}</Text>;
    $[5] = t3;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  return t4;
}
export function PromptInputFooterLeftSide(t0) {
  const $ = _c(27);
  const {
    exitMessage,
    vimMode,
    mode,
    toolPermissionContext,
    suppressHint,
    isLoading,
    tasksSelected,
    teamsSelected,
    tmuxSelected,
    teammateFooterIndex,
    isPasting,
    isSearching,
    historyQuery,
    setHistoryQuery,
    historyFailedMatch,
    onOpenTasksDialog
  } = t0;
  if (exitMessage.show) {
    let t1;
    if ($[0] !== exitMessage.key) {
      t1 = <Text dimColor={true} key="exit-message">再次按 {exitMessage.key} 即可退出</Text>;
      $[0] = exitMessage.key;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    return t1;
  }
  if (isPasting) {
    let t1;
    if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Text dimColor={true} key="pasting-message">正在粘贴文本…</Text>;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    return t1;
  }
  let t1;
  if ($[3] !== isSearching || $[4] !== vimMode) {
    t1 = isVimModeEnabled() && vimMode === "INSERT" && !isSearching;
    $[3] = isSearching;
    $[4] = vimMode;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  const showVim = t1;
  let t2;
  if ($[6] !== historyFailedMatch || $[7] !== historyQuery || $[8] !== isSearching || $[9] !== setHistoryQuery) {
    t2 = isSearching && <HistorySearchInput value={historyQuery} onChange={setHistoryQuery} historyFailedMatch={historyFailedMatch} />;
    $[6] = historyFailedMatch;
    $[7] = historyQuery;
    $[8] = isSearching;
    $[9] = setHistoryQuery;
    $[10] = t2;
  } else {
    t2 = $[10];
  }
  let t3;
  if ($[11] !== showVim) {
    t3 = showVim ? <Text dimColor={true} key="vim-insert">-- INSERT --</Text> : null;
    $[11] = showVim;
    $[12] = t3;
  } else {
    t3 = $[12];
  }
  const t4 = !suppressHint && !showVim;
  let t5;
  if ($[13] !== isLoading || $[14] !== mode || $[15] !== onOpenTasksDialog || $[16] !== t4 || $[17] !== tasksSelected || $[18] !== teammateFooterIndex || $[19] !== teamsSelected || $[20] !== tmuxSelected || $[21] !== toolPermissionContext) {
    t5 = <ModeIndicator mode={mode} toolPermissionContext={toolPermissionContext} showHint={t4} isLoading={isLoading} tasksSelected={tasksSelected} teamsSelected={teamsSelected} teammateFooterIndex={teammateFooterIndex} tmuxSelected={tmuxSelected} onOpenTasksDialog={onOpenTasksDialog} />;
    $[13] = isLoading;
    $[14] = mode;
    $[15] = onOpenTasksDialog;
    $[16] = t4;
    $[17] = tasksSelected;
    $[18] = teammateFooterIndex;
    $[19] = teamsSelected;
    $[20] = tmuxSelected;
    $[21] = toolPermissionContext;
    $[22] = t5;
  } else {
    t5 = $[22];
  }
  let t6;
  if ($[23] !== t2 || $[24] !== t3 || $[25] !== t5) {
    t6 = <Box justifyContent="flex-start" gap={1}>{t2}{t3}{t5}</Box>;
    $[23] = t2;
    $[24] = t3;
    $[25] = t5;
    $[26] = t6;
  } else {
    t6 = $[26];
  }
  return t6;
}
type ModeIndicatorProps = {
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  showHint: boolean;
  isLoading: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  onOpenTasksDialog?: (taskId?: string) => void;
};
function ModeIndicator({
  mode,
  toolPermissionContext,
  showHint,
  isLoading,
  tasksSelected,
  teamsSelected,
  tmuxSelected,
  teammateFooterIndex,
  onOpenTasksDialog
}: ModeIndicatorProps): React.ReactNode {
  const {
    columns
  } = useTerminalSize();
  const modeCycleShortcut = useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');
  const tasks = useAppState(s => s.tasks);
  const teamContext = useAppState(s_0 => s_0.teamContext);
  // 仅在 initialState（main.tsx --remote 模式）中设置，之后永不变化——懒加载
  // 初始化无需订阅即可捕获这个不可变的值。
  const store = useAppStateStore();
  const [remoteSessionUrl] = useState(() => store.getState().remoteSessionUrl);
  const viewSelectionMode = useAppState(s_1 => s_1.viewSelectionMode);
  const viewingAgentTaskId = useAppState(s_2 => s_2.viewingAgentTaskId);
  const expandedView = useAppState(s_3 => s_3.expandedView);
  const showSpinnerTree = expandedView === 'teammates';
  const prStatus = usePrStatus(isLoading, isPrStatusEnabled());
  const hasTmuxSession = useAppState(s_4 => false);
  const nextTickAt = useSyncExternalStore(proactiveModule?.subscribeToProactiveChanges ?? NO_OP_SUBSCRIBE, proactiveModule?.getNextTickAt ?? NULL, NULL);
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  // 语音模式已移除——始终禁用。
  const voiceEnabled = false;
  const voiceState = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useVoiceState(s_5 => s_5.voiceState) : 'idle' as const;
  const voiceWarmingUp = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useVoiceState(s_6 => s_6.voiceWarmingUp) : false;
  const hasSelection = useHasSelection();
  const selGetState = useSelection().getState;
  const hasNextTick = nextTickAt !== null;
  const isCoordinator = feature('COORDINATOR_MODE') ? coordinatorModule?.isCoordinatorMode() === true : false;
  const runningTaskCount = useMemo(() => count(Object.values(tasks), t => isBackgroundTask(t) && !(false)), [tasks]);
  const tasksV2 = useTasksV2();
  const hasTaskItems = tasksV2 !== undefined && tasksV2.length > 0;
  const escShortcut = useShortcutDisplay('chat:cancel', 'Chat', 'esc').toLowerCase();
  const todosShortcut = useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t');
  const killAgentsShortcut = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k');
  const voiceKeyShortcut = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useShortcutDisplay('voice:pushToTalk', 'Chat', 'Space') : '';
  // 挂载时捕获，这样即使另一个 CC 实例修改了计数器，提示也不会在会话中途闪烁。
  // 本次会话中首次启用语音时通过 useEffect 递增一次——近似于"提示已
  // 显示"，而无需跟踪确切的渲染时条件（该条件依赖在提前返回的 hooks 边界
  // 之后计算出的 parts/hintParts）。
  const [voiceHintUnderCap] = feature('VOICE_MODE') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useState(() => (getGlobalConfig().voiceFooterHintSeenCount ?? 0) < MAX_VOICE_HINT_SHOWS) : [false];
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  const voiceHintIncrementedRef = feature('VOICE_MODE') ? useRef(false) : null;
  useEffect(() => {
    if (feature('VOICE_MODE')) {
      if (!voiceEnabled || !voiceHintUnderCap) return;
      if (voiceHintIncrementedRef?.current) return;
      if (voiceHintIncrementedRef) voiceHintIncrementedRef.current = true;
      const newCount = (getGlobalConfig().voiceFooterHintSeenCount ?? 0) + 1;
      saveGlobalConfig(prev => {
        if ((prev.voiceFooterHintSeenCount ?? 0) >= newCount) return prev;
        return {
          ...prev,
          voiceFooterHintSeenCount: newCount
        };
      });
    }
  }, [voiceEnabled, voiceHintUnderCap]);
  const isKillAgentsConfirmShowing = useAppState(s_7 => s_7.notifications.current?.key === 'kill-agents-confirm');

  // 从 teamContext 派生团队信息（无需文件系统 I/O）
  // 与 TeamStatus 保持一致，避免尾随分隔符
  // 进程内模式使用 Shift+下/上 导航，而非底部团队菜单
  const hasTeams = isAgentSwarmsEnabled() && !isInProcessEnabled() && teamContext !== undefined && count(Object.values(teamContext.teammates), t_0 => t_0.name !== 'team-lead') > 0;
  if (mode === 'bash') {
    return <Text color="bashBorder">! 进入 bash 模式</Text>;
  }
  const currentMode = toolPermissionContext?.mode;
  const hasActiveMode = !isDefaultMode(currentMode);
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const isViewingTeammate = viewSelectionMode === 'viewing-agent' && viewedTask?.type === 'in_process_teammate';
  const isViewingCompletedTeammate = isViewingTeammate && viewedTask != null && viewedTask.status !== 'running';
  const hasBackgroundTasks = runningTaskCount > 0 || isViewingTeammate;

  // 统计主要项数量（权限模式或协调者模式、后台任务和团队）
  const primaryItemCount = (isCoordinator || hasActiveMode ? 1 : 0) + (hasBackgroundTasks ? 1 : 0) + (hasTeams ? 1 : 0);

  // PR 指示器很短（约 10 个字符）——不同于为旧的 diff 指示器调整的
  // 100 阈值。现在自动模式实质上已成为基线，大部分会话中 primaryItemCount ≥ 1；
  // 将阈值保持在足够低，以便在标准的 80 列终端上显示 PR 状态。
  const shouldShowPrStatus = isPrStatusEnabled() && prStatus.number !== null && prStatus.reviewState !== null && prStatus.url !== null && primaryItemCount < 2 && (primaryItemCount === 0 || columns >= 80);

  // 当存在 2 个主要项时隐藏 shift+tab 提示
  const shouldShowModeHint = primaryItemCount < 2;

  // 检查是否存在进程内队友（显示弹丸）
  // 在 spinning tree 模式下禁用弹丸——队友显示在 spinning tree 中
  const hasInProcessTeammates = !showSpinnerTree && hasBackgroundTasks && Object.values(tasks).some(t_1 => t_1.type === 'in_process_teammate');
  const hasTeammatePills = hasInProcessTeammates || !showSpinnerTree && isViewingTeammate;

  // 在远程模式下（`limkenion assistant`、--teleport）代理在别处运行；
  // 此处显示的本地权限模式并不反映代理的状态。
  // 在任务弹丸之前渲染，这样较长的弹丸标签（例如 ultraplan URL）
  // 不会把模式指示器挤出屏幕。
  const modePart = currentMode && hasActiveMode && !getIsRemoteMode() ? <Text color={getModeColor(currentMode)} key="mode">
        {permissionModeSymbol(currentMode)}{' '}
        {permissionModeTitle(currentMode).toLowerCase()} on
        {shouldShowModeHint && <Text dimColor>
            {' '}
            <KeyboardShortcutHint shortcut={modeCycleShortcut} action="循环" parens />
          </Text>}
      </Text> : null;

  // 构建 parts 数组——当我们有队友弹丸时排除 BackgroundTaskStatus
  //（队友弹丸有自己的一行）
  const parts = [
  // 远程会话指示器
  ...(remoteSessionUrl ? [<Link url={remoteSessionUrl} key="remote">
            <Text color="ide">{figures.circleDouble} 远程</Text>
          </Link>] : []),
  // BackgroundTaskStatus 不在 parts 中——它作为 Box 兄弟节点渲染，以便其
  // 可点击的 Box 不嵌套在 <Text wrap="truncate"> 包装器内（reconciler 对
  // Box-in-Text 会抛错）。
  // Tmux 弹丸（仅特定版本）——在导航顺序中紧跟在 tasks 之后
  ...([]), ...(isAgentSwarmsEnabled() && hasTeams ? [<TeamStatus key="teams" teamsSelected={teamsSelected} showHint={showHint && !hasBackgroundTasks} />] : []), ...(shouldShowPrStatus ? [<PrBadge key="pr-status" number={prStatus.number!} url={prStatus.url!} reviewState={prStatus.reviewState!} />] : [])];

  // 检查是否存在任何进程内队友（用于提示文本切换）
  const hasAnyInProcessTeammates = Object.values(tasks).some(t_2 => t_2.type === 'in_process_teammate' && t_2.status === 'running');
  const hasRunningAgentTasks = Object.values(tasks).some(t_3 => t_3.type === 'local_agent' && t_3.status === 'running');

  // 为潜在的第二行渲染单独获取提示部分
  const hintParts = showHint ? getSpinnerHintParts(isLoading, escShortcut, todosShortcut, killAgentsShortcut, hasTaskItems, expandedView, hasAnyInProcessTeammates, hasRunningAgentTasks, isKillAgentsConfirmShowing) : [];
  if (isViewingCompletedTeammate) {
    parts.push(<Text dimColor key="esc-return">
        <KeyboardShortcutHint shortcut={escShortcut} action="返回主控" />
      </Text>);
  } else if ((feature('PROACTIVE') || feature('KAIROS')) && hasNextTick) {
    parts.push(<ProactiveCountdown key="proactive" />);
  } else if (!hasTeammatePills && showHint) {
    parts.push(...hintParts);
  }

  // 当我们有队友弹丸时，始终将它们渲染在其他部分上方独立的行
  if (hasTeammatePills) {
    // 查看已完成队友时不追加 spinner 提示——
    // "esc 返回主控"提示已取代"esc 中断"
    const otherParts = [...(modePart ? [modePart] : []), ...parts, ...(isViewingCompletedTeammate ? [] : hintParts)];
    return <Box flexDirection="column">
        <Box>
          <BackgroundTaskStatus tasksSelected={tasksSelected} isViewingTeammate={isViewingTeammate} teammateFooterIndex={teammateFooterIndex} isLeaderIdle={!isLoading} onOpenDialog={onOpenTasksDialog} />
        </Box>
        {otherParts.length > 0 && <Box>
            <Byline>{otherParts}</Byline>
          </Box>}
      </Box>;
  }

  // 当面板有可见行时添加 "↓ 管理任务" 提示
  const hasCoordinatorTasks = false;

  // 任务弹丸作为 Box 兄弟节点（而非 parts 条目）渲染，以便其
  // 可点击的 Box 不嵌套在 <Text wrap="truncate"> 内——reconciler 对
  // Box-in-Text 会抛错。在此处计算，使下面的空行检查
  // 仍将"弹丸存在"视为非空。
  const tasksPart = hasBackgroundTasks && !hasTeammatePills && !shouldHideTasksFooter(tasks, showSpinnerTree) ? <BackgroundTaskStatus tasksSelected={tasksSelected} isViewingTeammate={isViewingTeammate} teammateFooterIndex={teammateFooterIndex} isLeaderIdle={!isLoading} onOpenDialog={onOpenTasksDialog} /> : null;
  if (parts.length === 0 && !tasksPart && !modePart && showHint) {
    parts.push(<Text dimColor key="shortcuts-hint">
        ? 查看快捷键
      </Text>);
  }

  // 仅在有待说的话时才替换空闲语音提示——否则回退，
  // 而不是显示空白的 Byline。"esc 清除"已移除（空闲时看起来
  // 像"esc 中断"；esc 清除选区是标准 UX），只保留 ctrl+c
  //（copyOnSelect 关闭）和 xterm.js 原生选择提示。
  const copyOnSelect = getGlobalConfig().copyOnSelect ?? true;
  const selectionHintHasContent = hasSelection && (!copyOnSelect || isXtermJs());

  // 预热提示优先——当用户正按住
  // 激活键时，无论其他提示如何都显示反馈。
  if (feature('VOICE_MODE') && voiceEnabled && voiceWarmingUp) {
    parts.push(<VoiceWarmupHint key="voice-warmup" />);
  } else if (isFullscreenEnvEnabled() && selectionHintHasContent) {
    // xterm.js（VS Code/Cursor/Windsurf）的强制选择修饰键是平台相关的，
    // 且仅在 macOS 上启用（SelectionService.shouldForceSelection）：
    //   macOS:      altKey && macOptionClickForcesSelection（VS Code 默认：false）
    //   非 macOS：  shiftKey
    // 在 macOS 上，如果我们收到 alt+click（lastPressHadAlt），
    // 说明 VS Code 该设置已关闭——否则 xterm.js 会吞掉该事件。
    // 告诉用户需要翻转的确切设置，而不是重复他们刚试过的
    // option+click 提示。
    // 非响应式 getState() 读取是安全的：当 hasSelection 为 true 时
    // lastPressHadAlt 是不可变的（拖拽前设置，选择时清除）。
    const isMac = getPlatform() === 'macos';
    const altClickFailed = isMac && (selGetState()?.lastPressHadAlt ?? false);
    parts.push(<Text dimColor key="selection-copy">
        <Byline>
          {!copyOnSelect && <KeyboardShortcutHint shortcut="ctrl+c" action="复制" />}
          {isXtermJs() && (altClickFailed ? <Text>请在 VS Code 设置中配置 macOptionClickForcesSelection</Text> : <KeyboardShortcutHint shortcut={isMac ? 'option+click' : 'shift+click'} action="原生选择" />)}
        </Byline>
      </Text>);
  } else if (feature('VOICE_MODE') && parts.length > 0 && showHint && voiceEnabled && voiceState === 'idle' && hintParts.length === 0 && voiceHintUnderCap) {
    parts.push(<Text dimColor key="voice-hint">
        按住 {voiceKeyShortcut} 说话
      </Text>);
  }
  if ((tasksPart || hasCoordinatorTasks) && showHint && !hasTeams) {
    parts.push(<Text dimColor key="manage-tasks">
        {tasksSelected ? <KeyboardShortcutHint shortcut="Enter" action="查看任务" /> : <KeyboardShortcutHint shortcut="↓" action="管理" />}
      </Text>);
  }

  // 全屏模式下底部区块是 flexShrink:0——这里的每一行都是
  // 从 ScrollBox 中偷走的一行。此组件必须有稳定的高度，
  // 这样底部栏永远不会增长/收缩而移位滚动内容。
  // 当 parts 为空时返回 null（例如 StatusLine 开启 → suppressHint
  // → showHint=false → 无 "? 查看快捷键"）会让稍后添加的
  // 部分（例如选择复制/原生选择提示）把列从 0 行撑到 1 行。
  // 全屏模式下始终渲染 1 行；为空时返回一个空格，
  // 以便 Yoga 保留该行且不绘制任何可见内容。
  if (parts.length === 0 && !tasksPart && !modePart) {
    return isFullscreenEnvEnabled() ? <Text> </Text> : null;
  }

  // flexShrink=0 让 mode 和弹丸保持自然宽度；其余部分
  // 在 Text 包装器内作为一个字符串在末尾截断。
  return <Box height={1} overflow="hidden">
      {modePart && <Box flexShrink={0}>
          {modePart}
          {(tasksPart || parts.length > 0) && <Text dimColor> · </Text>}
        </Box>}
      {tasksPart && <Box flexShrink={0}>
          {tasksPart}
          {parts.length > 0 && <Text dimColor> · </Text>}
        </Box>}
      {parts.length > 0 && <Text wrap="truncate">
          <Byline>{parts}</Byline>
        </Text>}
    </Box>;
}
function getSpinnerHintParts(isLoading: boolean, escShortcut: string, todosShortcut: string, killAgentsShortcut: string, hasTaskItems: boolean, expandedView: 'none' | 'tasks' | 'teammates', hasTeammates: boolean, hasRunningAgentTasks: boolean, isKillAgentsConfirmShowing: boolean): React.ReactElement[] {
  let toggleAction: string;
  if (hasTeammates) {
    // 循环：无 → 任务 → 队友 → 无
    switch (expandedView) {
      case 'none':
        toggleAction = '显示任务';
        break;
      case 'tasks':
        toggleAction = '显示队友';
        break;
      case 'teammates':
        toggleAction = '隐藏';
        break;
    }
  } else {
    toggleAction = expandedView === 'tasks' ? '隐藏任务' : '显示任务';
  }

  // 仅在有可显示的任务项或有可循环到的队友时才显示切换提示
  const showToggleHint = hasTaskItems || hasTeammates;
  return [...(isLoading ? [<Text dimColor key="esc">
            <KeyboardShortcutHint shortcut={escShortcut} action="中断" />
          </Text>] : []), ...(!isLoading && hasRunningAgentTasks && !isKillAgentsConfirmShowing ? [<Text dimColor key="kill-agents">
            <KeyboardShortcutHint shortcut={killAgentsShortcut} action="停止所有代理" />
          </Text>] : []), ...(showToggleHint ? [<Text dimColor key="toggle-tasks">
            <KeyboardShortcutHint shortcut={todosShortcut} action={toggleAction} />
          </Text>] : [])];
}
function isPrStatusEnabled(): boolean {
  return getGlobalConfig().prStatusFooterEnabled ?? true;
}