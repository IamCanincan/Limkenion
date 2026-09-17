import { feature } from 'bun:bundle';
import chalk from 'chalk';
import * as path from 'path';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { useCommandQueue } from 'src/hooks/useCommandQueue.js';
import { type IDEAtMentioned, useIdeAtMentioned } from 'src/hooks/useIdeAtMentioned.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { type AppState, useAppState, useAppStateStore, useSetAppState } from 'src/state/AppState.js';
import type { FooterItem } from 'src/state/AppStateStore.js';
import { getCwd } from 'src/utils/cwd.js';
import { isQueuedCommandEditable, popAllEditable } from 'src/utils/messageQueueManager.js';
import stripAnsi from 'strip-ansi';
import { FastModePicker } from '../../commands/fast/fast.js';
import { isUltrareviewEnabled } from '../../commands/review/ultrareviewEnabled.js';
import { getNativeCSIuTerminalDisplayName } from '../../commands/terminalSetup/terminalSetup.js';
import { type Command, hasCommand } from '../../commands.js';
import { useIsModalOverlayActive } from '../../context/overlayContext.js';
import { useSetPromptOverlayDialog } from '../../context/promptOverlayContext.js';
import { formatImageRef, formatPastedTextRef, getPastedTextRefNumLines, parseReferences } from '../../history.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import { type HistoryMode, useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js';
import { useDoublePress } from '../../hooks/useDoublePress.js';
import { useHistorySearch } from '../../hooks/useHistorySearch.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { useInputBuffer } from '../../hooks/useInputBuffer.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTypeahead } from '../../hooks/useTypeahead.js';
import type { BorderTextOptions } from '../../ink/render-border.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, type ClickEvent, type Key, Text, useInput } from '../../ink.js';
import { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js';
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';
import { abortPromptSuggestion, logSuggestionSuppressed } from '../../services/PromptSuggestion/promptSuggestion.js';
import { type ActiveSpeculationState, abortSpeculation } from '../../services/PromptSuggestion/speculation.js';
import { getActiveAgentForInput, getViewedTeammateTask } from '../../state/selectors.js';
import { enterTeammateView, exitTeammateView, stopOrDismissAgent } from '../../state/teammateViewHelpers.js';
import type { ToolPermissionContext } from '../../Tool.js';
import { getRunningTeammatesSorted } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js';
import { isPanelAgentTask, type LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { isBackgroundTask } from '../../tasks/types.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js';
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js';
import type { Message } from '../../types/message.js';
import type { PermissionMode } from '../../types/permissions.js';
import type { BaseTextInputProps, PromptInputMode, VimMode } from '../../types/textInputTypes.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { count } from '../../utils/array.js';
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js';
import { Cursor } from '../../utils/Cursor.js';
import { getGlobalConfig, type PastedContent, saveGlobalConfig } from '../../utils/config.js';
import { logForDebugging } from '../../utils/debug.js';
import { parseDirectMemberMessage, sendDirectMemberMessage } from '../../utils/directMemberMessage.js';
import type { EffortLevel } from '../../utils/effort.js';
import { env } from '../../utils/env.js';
import { errorMessage } from '../../utils/errors.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import { getFastModeUnavailableReason, isFastModeAvailable, isFastModeCooldown, isFastModeEnabled, isFastModeSupportedByModel } from '../../utils/fastMode.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js';
import { getImageFromClipboard, PASTE_THRESHOLD } from '../../utils/imagePaste.js';
import type { ImageDimensions } from '../../utils/imageResizer.js';
import { cacheImagePath, storeImage } from '../../utils/imageStore.js';
import { isMacosOptionChar, MACOS_OPTION_SPECIAL_CHARS } from '../../utils/keyboardShortcuts.js';
import { logError } from '../../utils/log.js';
import { is1mContextMergeEnabled, modelDisplayString } from '../../utils/model/model.js';
import { setAutoModeActive } from '../../utils/permissions/autoModeState.js';
import { cyclePermissionMode, getNextPermissionMode } from '../../utils/permissions/getNextPermissionMode.js';
import { transitionPermissionMode } from '../../utils/permissions/permissionSetup.js';
import { getPlatform } from '../../utils/platform.js';
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js';
import { editPromptInEditor } from '../../utils/promptEditor.js';
import { hasAutoModeOptIn } from '../../utils/settings/settings.js';
import { findBtwTriggerPositions } from '../../utils/sideQuestion.js';
import { findSlashCommandPositions } from '../../utils/suggestions/commandSuggestions.js';
import { findSlackChannelPositions, getKnownChannelsVersion, hasSlackMcpServer, subscribeKnownChannels } from '../../utils/suggestions/slackChannelSuggestions.js';
import { isInProcessEnabled } from '../../utils/swarm/backends/registry.js';
import { syncTeammateMode } from '../../utils/swarm/teamHelpers.js';
import type { TeamSummary } from '../../utils/teamDiscovery.js';
import { getTeammateColor } from '../../utils/teammate.js';
import { isInProcessTeammate } from '../../utils/teammateContext.js';
import { writeToMailbox } from '../../utils/teammateMailbox.js';
import type { TextHighlight } from '../../utils/textHighlighting.js';
import type { Theme } from '../../utils/theme.js';
import { findThinkingTriggerPositions, getRainbowColor, isUltrathinkEnabled } from '../../utils/thinking.js';
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js';
import { findUltraplanTriggerPositions, findUltrareviewTriggerPositions } from '../../utils/ultraplan/keyword.js';
import { AutoModeOptInDialog } from '../AutoModeOptInDialog.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { getVisibleAgentTasks, useCoordinatorTaskCount } from '../CoordinatorAgentStatus.js';
import { getEffortNotificationText } from '../EffortIndicator.js';
import { getFastIconString } from '../FastIcon.js';
import { GlobalSearchDialog } from '../GlobalSearchDialog.js';
import { HistorySearchDialog } from '../HistorySearchDialog.js';
import { ModelPicker } from '../ModelPicker.js';
import { QuickOpenDialog } from '../QuickOpenDialog.js';
import TextInput from '../TextInput.js';
import { ThinkingToggle } from '../ThinkingToggle.js';
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js';
import { shouldHideTasksFooter } from '../tasks/taskStatusUtils.js';
import { TeamsDialog } from '../teams/TeamsDialog.js';
import { getModeFromInput, getValueFromInput } from './inputModes.js';
import { FOOTER_TEMPORARY_STATUS_TIMEOUT, Notifications } from './Notifications.js';
import PromptInputFooter from './PromptInputFooter.js';
import type { SuggestionItem } from './PromptInputFooterSuggestions.js';
import { PromptInputModeIndicator } from './PromptInputModeIndicator.js';
import { PromptInputQueuedCommands } from './PromptInputQueuedCommands.js';
import { PromptInputStashNotice } from './PromptInputStashNotice.js';
import { useMaybeTruncateInput } from './useMaybeTruncateInput.js';
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js';
import { useShowFastIconHint } from './useShowFastIconHint.js';
import { useSwarmBanner } from './useSwarmBanner.js';
import { isNonSpacePrintable, isVimModeEnabled } from './utils.js';
type Props = {
  debug: boolean;
  ideSelection: IDESelection | undefined;
  toolPermissionContext: ToolPermissionContext;
  setToolPermissionContext: (ctx: ToolPermissionContext) => void;
  apiKeyStatus: VerificationStatus;
  commands: Command[];
  agents: AgentDefinition[];
  isLoading: boolean;
  verbose: boolean;
  messages: Message[];
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  input: string;
  onInputChange: (value: string) => void;
  mode: PromptInputMode;
  onModeChange: (mode: PromptInputMode) => void;
  stashedPrompt: {
    text: string;
    cursorOffset: number;
    pastedContents: Record<number, PastedContent>;
  } | undefined;
  setStashedPrompt: (value: {
    text: string;
    cursorOffset: number;
    pastedContents: Record<number, PastedContent>;
  } | undefined) => void;
  submitCount: number;
  onShowMessageSelector: () => void;
  /** Fullscreen message actions: shift+↑ enters cursor. */
  onMessageActionsEnter?: () => void;
  mcpClients: MCPServerConnection[];
  pastedContents: Record<number, PastedContent>;
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>;
  vimMode: VimMode;
  setVimMode: (mode: VimMode) => void;
  showBashesDialog: string | boolean;
  setShowBashesDialog: (show: string | boolean) => void;
  onExit: () => void;
  getToolUseContext: (messages: Message[], newMessages: Message[], abortController: AbortController, mainLoopModel: string) => ProcessUserInputContext;
  onSubmit: (input: string, helpers: PromptInputHelpers, speculationAccept?: {
    state: ActiveSpeculationState;
    speculationSessionTimeSavedMs: number;
    setAppState: (f: (prev: AppState) => AppState) => void;
  }, options?: {
    fromKeybinding?: boolean;
  }) => Promise<void>;
  onAgentSubmit?: (input: string, task: InProcessTeammateTaskState | LocalAgentTaskState, helpers: PromptInputHelpers) => Promise<void>;
  isSearchingHistory: boolean;
  setIsSearchingHistory: (isSearching: boolean) => void;
  onDismissSideQuestion?: () => void;
  isSideQuestionVisible?: boolean;
  helpOpen: boolean;
  setHelpOpen: React.Dispatch<React.SetStateAction<boolean>>;
  hasSuppressedDialogs?: boolean;
  isLocalJSXCommandActive?: boolean;
  insertTextRef?: React.MutableRefObject<{
    insert: (text: string) => void;
    setInputWithCursor: (value: string, cursor: number) => void;
    cursorOffset: number;
  } | null>;
  voiceInterimRange?: {
    start: number;
    end: number;
  } | null;
};

// 底部槽位 maxHeight="50%"；为底部栏、边框、状态保留行数。
const PROMPT_FOOTER_LINES = 5;
const MIN_INPUT_VIEWPORT_LINES = 3;
function PromptInput({
  debug,
  ideSelection,
  toolPermissionContext,
  setToolPermissionContext,
  apiKeyStatus,
  commands,
  agents,
  isLoading,
  verbose,
  messages,
  onAutoUpdaterResult,
  autoUpdaterResult,
  input,
  onInputChange,
  mode,
  onModeChange,
  stashedPrompt,
  setStashedPrompt,
  submitCount,
  onShowMessageSelector,
  onMessageActionsEnter,
  mcpClients,
  pastedContents,
  setPastedContents,
  vimMode,
  setVimMode,
  showBashesDialog,
  setShowBashesDialog,
  onExit,
  getToolUseContext,
  onSubmit: onSubmitProp,
  onAgentSubmit,
  isSearchingHistory,
  setIsSearchingHistory,
  onDismissSideQuestion,
  isSideQuestionVisible,
  helpOpen,
  setHelpOpen,
  hasSuppressedDialogs,
  isLocalJSXCommandActive = false,
  insertTextRef,
  voiceInterimRange
}: Props): React.ReactNode {
  const mainLoopModel = useMainLoopModel();
  // local-jsx 命令（例如 /mcp 在代理运行时）通过 immediate-command 路径，
  // 在 PromptInput 之上渲染一个全屏对话框（shouldHidePromptInput: false）。
  // 这些对话框不注册到 overlay 系统，因此这里将其视为模态覆盖层，
  // 以阻止导航键泄漏到 TextInput/footer 处理器中并叠加第二个对话框。
  const isModalOverlayActive = useIsModalOverlayActive() || isLocalJSXCommandActive;
  const [isAutoUpdating, setIsAutoUpdating] = useState(false);
  const [exitMessage, setExitMessage] = useState<{
    show: boolean;
    key?: string;
  }>({
    show: false
  });
  const [cursorOffset, setCursorOffset] = useState<number>(input.length);
  // 跟踪通过内部处理器设置的最后一个输入值，以便识别外部输入变化
  //（例如语音转文本注入）并将光标移到末尾。
  const lastInternalInputRef = React.useRef(input);
  if (input !== lastInternalInputRef.current) {
    // 输入从外部变化（未经过任何内部处理器）——将光标移到末尾
    setCursorOffset(input.length);
    lastInternalInputRef.current = input;
  }
  // 包装 onInputChange 以在触发重渲染之前跟踪内部变化
  const trackAndSetInput = React.useCallback((value: string) => {
    lastInternalInputRef.current = value;
    onInputChange(value);
  }, [onInputChange]);
  // 暴露 insertText 函数，使调用方（如 STT）能在当前光标位置
  // 拼接文本，而不是替换整个输入。
  if (insertTextRef) {
    insertTextRef.current = {
      cursorOffset,
      insert: (text: string) => {
        const needsSpace = cursorOffset === input.length && input.length > 0 && !/\s$/.test(input);
        const insertText = needsSpace ? ' ' + text : text;
        const newValue = input.slice(0, cursorOffset) + insertText + input.slice(cursorOffset);
        lastInternalInputRef.current = newValue;
        onInputChange(newValue);
        setCursorOffset(cursorOffset + insertText.length);
      },
      setInputWithCursor: (value: string, cursor: number) => {
        lastInternalInputRef.current = value;
        onInputChange(value);
        setCursorOffset(cursor);
      }
    };
  }
  const store = useAppStateStore();
  const setAppState = useSetAppState();
  const tasks = useAppState(s => s.tasks);
  const replBridgeConnected = useAppState(s => s.replBridgeConnected);
  const replBridgeExplicit = useAppState(s => s.replBridgeExplicit);
  const replBridgeReconnecting = useAppState(s => s.replBridgeReconnecting);
  // 必须与 BridgeStatusIndicator 的渲染条件（PromptInputFooter.tsx）一致——
  // 对于隐式且非重连状态，弹丸返回 null，因此导航也必须如此，
  // 否则桥接会成为不可见的选择停靠点。
  const bridgeFooterVisible = replBridgeConnected && (replBridgeExplicit || replBridgeReconnecting);
  // Tmux 弹丸（某些版本）——当存在活动 tungsten 会话时可见
  const hasTungstenSession = useAppState(s => false);
  const tmuxFooterVisible = false;
  // WebBrowser 弹丸——浏览器打开时可见
  const bagelFooterVisible = useAppState(s => false);
  const teamContext = useAppState(s => s.teamContext);
  const queuedCommands = useCommandQueue();
  const promptSuggestionState = useAppState(s => s.promptSuggestion);
  const speculation = useAppState(s => s.speculation);
  const speculationSessionTimeSavedMs = useAppState(s => s.speculationSessionTimeSavedMs);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const viewSelectionMode = useAppState(s => s.viewSelectionMode);
  const showSpinnerTree = useAppState(s => s.expandedView) === 'teammates';
  // 桌宠（companion）功能已移除。
  // 简洁模式：BriefSpinner/BriefIdleStatus 负责输入框上方 2 行的空间。
  // 在这里去掉 marginTop 可以让 spinner 紧贴输入栏。viewingAgentTaskId
  // 镜像了两者的门控（Spinner.tsx、REPL.tsx）——队友视图回退到自带
  // marginTop 的 SpinnerWithVerbInner，因此即使没有我们的 gap 也保持不变。
  const briefOwnsGap = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s => s.isBriefOnly) && !viewingAgentTaskId : false;
  const mainLoopModel_ = useAppState(s => s.mainLoopModel);
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession);
  const thinkingEnabled = useAppState(s => s.thinkingEnabled);
  const isFastMode = useAppState(s => isFastModeEnabled() ? s.fastMode : false);
  const effortValue = useAppState(s => s.effortValue);
  const viewedTeammate = getViewedTeammateTask(store.getState());
  const viewingAgentName = viewedTeammate?.identity.agentName;
  // identity.color 被类型化为 `string | undefined`（而非 AgentColorName），因为
  // 队友身份来自基于文件的配置。在强制转换前先校验，确保只使用
  // 有效的颜色名（无效时回退到青色）。
  const viewingAgentColor = viewedTeammate?.identity.color && AGENT_COLORS.includes(viewedTeammate.identity.color as AgentColorName) ? viewedTeammate.identity.color as AgentColorName : undefined;
  // 进程内队友按字母排序，用于底部团队选择器
  const inProcessTeammates = useMemo(() => getRunningTeammatesSorted(tasks), [tasks]);

  // 团队模式：所有后台任务都是进程内队友
  const isTeammateMode = inProcessTeammates.length > 0 || viewedTeammate !== undefined;

  // 在查看队友时，在其底部栏显示其权限模式，而非领导者的
  const effectiveToolPermissionContext = useMemo((): ToolPermissionContext => {
    if (viewedTeammate) {
      return {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode
      };
    }
    return toolPermissionContext;
  }, [viewedTeammate, toolPermissionContext]);
  const {
    historyQuery,
    setHistoryQuery,
    historyMatch,
    historyFailedMatch
  } = useHistorySearch(entry => {
    setPastedContents(entry.pastedContents);
    void onSubmit(entry.display);
  }, input, trackAndSetInput, setCursorOffset, cursorOffset, onModeChange, mode, isSearchingHistory, setIsSearchingHistory, setPastedContents, pastedContents);
  // 粘贴 ID 计数器（图片和文本共用）。
  // 初始值基于已有消息一次性计算（用于 --continue/--resume）。
  // useRef(fn()) 在每次渲染时都求值 fn() 并丢弃结果——getInitialPasteId
  // 会遍历所有消息并正则扫描文本块，因此用懒初始化模式
  // 确保它只运行一次。
  const nextPasteIdRef = useRef(-1);
  if (nextPasteIdRef.current === -1) {
    nextPasteIdRef.current = getInitialPasteId(messages);
  }
  // 由 onImagePaste 布防；如果紧接着的下一个按键是非空格的
  // 可打印字符，inputFilter 会在其前插入一个空格。任何其他输入
  //（方向键、esc、退格、粘贴、空格）会解除布防而不插入。
  const pendingSpaceAfterPillRef = useRef(false);
  const [showTeamsDialog, setShowTeamsDialog] = useState(false);
  const [teammateFooterIndex, setTeammateFooterIndex] = useState(0);
  // -1 哨兵值：任务弹丸被选中，但尚未选中任何具体代理行。
  // 第一次 ↓ 选中弹丸，第二次 ↓ 移动到第 0 行。当后台任务（弹丸）
  // 和 fork 代理（行）同时可见时，防止弹丸 + 行被双重选中。
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex);
  const setCoordinatorTaskIndex = useCallback((v: number | ((prev: number) => number)) => setAppState(prev => {
    const next = typeof v === 'function' ? v(prev.coordinatorTaskIndex) : v;
    if (next === prev.coordinatorTaskIndex) return prev;
    return {
      ...prev,
      coordinatorTaskIndex: next
    };
  }), [setAppState]);
  const coordinatorTaskCount = useCoordinatorTaskCount();
  // 弹丸（BackgroundTaskStatus）仅在存在非 local_agent 后台任务时渲染。
  // 当只有 local_agent 任务运行（协调者/fork 模式）时，弹丸不存在，
  // 因此 -1 哨兵值会导致视觉上没有选中任何内容。此时跳过 -1，
  // 将 0 视为最小可选索引。
  const hasBgTaskPill = useMemo(() => Object.values(tasks).some(t => isBackgroundTask(t) && !(false)), [tasks]);
  const minCoordinatorIndex = hasBgTaskPill ? -1 : 0;
  // 当任务完成且列表在光标下方收缩时钳制索引
  useEffect(() => {
    if (coordinatorTaskIndex >= coordinatorTaskCount) {
      setCoordinatorTaskIndex(Math.max(minCoordinatorIndex, coordinatorTaskCount - 1));
    } else if (coordinatorTaskIndex < minCoordinatorIndex) {
      setCoordinatorTaskIndex(minCoordinatorIndex);
    }
  }, [coordinatorTaskCount, coordinatorTaskIndex, minCoordinatorIndex]);
  const [isPasting, setIsPasting] = useState(false);
  const [isExternalEditorActive, setIsExternalEditorActive] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const [showFastModePicker, setShowFastModePicker] = useState(false);
  const [showThinkingToggle, setShowThinkingToggle] = useState(false);
  const [showAutoModeOptIn, setShowAutoModeOptIn] = useState(false);
  const [previousModeBeforeAuto, setPreviousModeBeforeAuto] = useState<PermissionMode | null>(null);
  const autoModeOptInTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 检查光标是否位于输入的第一行
  const isCursorOnFirstLine = useMemo(() => {
    const firstNewlineIndex = input.indexOf('\n');
    if (firstNewlineIndex === -1) {
      return true; // 无换行，光标始终在第一行
    }
    return cursorOffset <= firstNewlineIndex;
  }, [input, cursorOffset]);
  const isCursorOnLastLine = useMemo(() => {
    const lastNewlineIndex = input.lastIndexOf('\n');
    if (lastNewlineIndex === -1) {
      return true; // 无换行，光标始终在最后一行
    }
    return cursorOffset > lastNewlineIndex;
  }, [input, cursorOffset]);

  // 从 teamContext 派生团队信息（无需文件系统 I/O）
  // 一次会话只能领导一个团队
  const cachedTeams: TeamSummary[] = useMemo(() => {
    if (!isAgentSwarmsEnabled()) return [];
    // 进程内模式使用 Shift+下/上 导航，而非底部菜单
    if (isInProcessEnabled()) return [];
    if (!teamContext) {
      return [];
    }
    const teammateCount = count(Object.values(teamContext.teammates), t => t.name !== 'team-lead');
    return [{
      name: teamContext.teamName,
      memberCount: teammateCount,
      runningCount: 0,
      idleCount: 0
    }];
  }, [teamContext]);

  // ─── 底部弹丸导航 ─────────────────────────────────────────────
  // 输入框下方渲染哪些弹丸。此处的顺序就是导航顺序
  //（下/右 = 前进，上/左 = 后退）。选择状态存于 AppState，以便
  // 在 PromptInput 之外渲染的弹丸（CompanionSprite）可以读取焦点。
  const runningTaskCount = useMemo(() => count(Object.values(tasks), t => t.status === 'running'), [tasks]);
  // 面板也会显示保留的已完成代理（getVisibleAgentTasks），因此只要
  // 面板有行，弹丸就必须保持可导航——而不仅仅是某物运行中时。
  const tasksFooterVisible = (runningTaskCount > 0 || false) && !shouldHideTasksFooter(tasks, showSpinnerTree);
  const teamsFooterVisible = cachedTeams.length > 0;
  const footerItems = useMemo(() => [tasksFooterVisible && 'tasks', tmuxFooterVisible && 'tmux', bagelFooterVisible && 'bagel', teamsFooterVisible && 'teams', bridgeFooterVisible && 'bridge'].filter(Boolean) as FooterItem[], [tasksFooterVisible, tmuxFooterVisible, bagelFooterVisible, teamsFooterVisible, bridgeFooterVisible]);

  // 有效选中：如果被选中的弹丸停止渲染（桥接断开、任务完成），则为 null。
  // 此推导立即让 UI 正确；下面的 useEffect 清除原始状态，使同一弹丸
  // 重新出现时（新任务开始 → 焦点被抢占）不会复活。
  const rawFooterSelection = useAppState(s => s.footerSelection);
  const footerItemSelected = rawFooterSelection && footerItems.includes(rawFooterSelection) ? rawFooterSelection : null;
  useEffect(() => {
    if (rawFooterSelection && !footerItemSelected) {
      setAppState(prev => prev.footerSelection === null ? prev : {
        ...prev,
        footerSelection: null
      });
    }
  }, [rawFooterSelection, footerItemSelected, setAppState]);
  const tasksSelected = footerItemSelected === 'tasks';
  const tmuxSelected = footerItemSelected === 'tmux';
  const bagelSelected = footerItemSelected === 'bagel';
  const teamsSelected = footerItemSelected === 'teams';
  const bridgeSelected = footerItemSelected === 'bridge';
  function selectFooterItem(item: FooterItem | null): void {
    setAppState(prev => prev.footerSelection === item ? prev : {
      ...prev,
      footerSelection: item
    });
    if (item === 'tasks') {
      setTeammateFooterIndex(0);
      setCoordinatorTaskIndex(minCoordinatorIndex);
    }
  }

  // delta：+1 = 下/右，-1 = 上/左。发生导航时返回 true
  //（包括在起点取消选中），到达边界时返回 false。
  function navigateFooter(delta: 1 | -1, exitAtStart = false): boolean {
    const idx = footerItemSelected ? footerItems.indexOf(footerItemSelected) : -1;
    const next = footerItems[idx + delta];
    if (next) {
      selectFooterItem(next);
      return true;
    }
    if (delta < 0 && exitAtStart) {
      selectFooterItem(null);
      return true;
    }
    return false;
  }

  // 提示建议钩子——读取查询循环中 fork 代理生成的建议
  const {
    suggestion: promptSuggestion,
    markAccepted,
    logOutcomeAtSubmission,
    markShown
  } = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading
  });
  const displayedValue = useMemo(() => isSearchingHistory && historyMatch ? getValueFromInput(typeof historyMatch === 'string' ? historyMatch : historyMatch.display) : input, [isSearchingHistory, historyMatch, input]);
  const thinkTriggers = useMemo(() => findThinkingTriggerPositions(displayedValue), [displayedValue]);
  const ultraplanSessionUrl = useAppState(s => s.ultraplanSessionUrl);
  const ultraplanLaunching = useAppState(s => s.ultraplanLaunching);
  const ultraplanTriggers = useMemo(() => feature('ULTRAPLAN') && !ultraplanSessionUrl && !ultraplanLaunching ? findUltraplanTriggerPositions(displayedValue) : [], [displayedValue, ultraplanSessionUrl, ultraplanLaunching]);
  const ultrareviewTriggers = useMemo(() => isUltrareviewEnabled() ? findUltrareviewTriggerPositions(displayedValue) : [], [displayedValue]);
  const btwTriggers = useMemo(() => findBtwTriggerPositions(displayedValue), [displayedValue]);
  // 已移除 Buddy 伴侣功能——无触发位置。
  const buddyTriggers: never[] = [];
  const slashCommandTriggers = useMemo(() => {
    const positions = findSlashCommandPositions(displayedValue);
    // 仅高亮有效命令
    return positions.filter(pos => {
      const commandName = displayedValue.slice(pos.start + 1, pos.end); // +1 跳过 "/"
      return hasCommand(commandName, commands);
    });
  }, [displayedValue, commands]);
  const tokenBudgetTriggers = useMemo(() => feature('TOKEN_BUDGET') ? findTokenBudgetPositions(displayedValue) : [], [displayedValue]);
  const knownChannelsVersion = useSyncExternalStore(subscribeKnownChannels, getKnownChannelsVersion);
  const slackChannelTriggers = useMemo(() => hasSlackMcpServer(store.getState().mcp.clients) ? findSlackChannelPositions(displayedValue) : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps -- store is a stable ref
  [displayedValue, knownChannelsVersion]);

  // 查找 @name 提及并使用队友颜色高亮
  const memberMentionHighlights = useMemo((): Array<{
    start: number;
    end: number;
    themeColor: keyof Theme;
  }> => {
    if (!isAgentSwarmsEnabled()) return [];
    if (!teamContext?.teammates) return [];
    const highlights: Array<{
      start: number;
      end: number;
      themeColor: keyof Theme;
    }> = [];
    const members = teamContext.teammates;
    if (!members) return highlights;

    // 查找输入中的所有 @name 模式
    const regex = /(^|\s)@([\w-]+)/g;
    const memberValues = Object.values(members);
    let match;
    while ((match = regex.exec(displayedValue)) !== null) {
      const leadingSpace = match[1] ?? '';
      const nameStart = match.index + leadingSpace.length;
      const fullMatch = match[0].trimStart();
      const name = match[2];

      // 检查该名称是否匹配某个队友
      const member = memberValues.find(t => t.name === name);
      if (member?.color) {
        const themeColor = AGENT_COLOR_TO_THEME_COLOR[member.color as AgentColorName];
        if (themeColor) {
          highlights.push({
            start: nameStart,
            end: nameStart + fullMatch.length,
            themeColor
          });
        }
      }
    }
    return highlights;
  }, [displayedValue, teamContext]);
  const imageRefPositions = useMemo(() => parseReferences(displayedValue).filter(r => r.match.startsWith('[Image')).map(r => ({
    start: r.index,
    end: r.index + r.match.length
  })), [displayedValue]);

  // chip.start 是"选中"状态：反显的 chip 即为光标本身。
  // chip.end 保持普通位置，这样你可以像其他字符一样把光标停在 `]` 之后。
  const cursorAtImageChip = imageRefPositions.some(r => r.start === cursorOffset);

  // 上下移动或全屏点击可能把光标恰好落在 chip 内部；
  // 吸附到较近的边界，使其绝不支持逐字符编辑。
  useEffect(() => {
    const inside = imageRefPositions.find(r => cursorOffset > r.start && cursorOffset < r.end);
    if (inside) {
      const mid = (inside.start + inside.end) / 2;
      setCursorOffset(cursorOffset < mid ? inside.start : inside.end);
    }
  }, [cursorOffset, imageRefPositions, setCursorOffset]);
  const combinedHighlights = useMemo((): TextHighlight[] => {
    const highlights: TextHighlight[] = [];

    // 当光标位于 chip.start（"选中"状态）时反转 [Image #N] chip，
    // 使退格删除的视觉反馈更明显。
    for (const ref of imageRefPositions) {
      if (cursorOffset === ref.start) {
        highlights.push({
          start: ref.start,
          end: ref.end,
          color: undefined,
          inverse: true,
          priority: 8
        });
      }
    }
    if (isSearchingHistory && historyMatch && !historyFailedMatch) {
      highlights.push({
        start: cursorOffset,
        end: cursorOffset + historyQuery.length,
        color: 'warning',
        priority: 20
      });
    }

    // 添加 "btw" 高亮（实心黄色）
    for (const trigger of btwTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'warning',
        priority: 15
      });
    }

    // 添加 /command 高亮（蓝色）
    for (const trigger of slashCommandTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5
      });
    }

    // 添加 token 预算高亮（蓝色）
    for (const trigger of tokenBudgetTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5
      });
    }
    for (const trigger of slackChannelTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5
      });
    }

    // 使用队友颜色添加 @name 高亮
    for (const mention of memberMentionHighlights) {
      highlights.push({
        start: mention.start,
        end: mention.end,
        color: mention.themeColor,
        priority: 5
      });
    }

    // 变暗显示临时的语音转文字中间文本
    if (voiceInterimRange) {
      highlights.push({
        start: voiceInterimRange.start,
        end: voiceInterimRange.end,
        color: undefined,
        dimColor: true,
        priority: 1
      });
    }

    // 对 ultrathink 关键词进行彩虹高亮（逐字符循环换色）
    if (isUltrathinkEnabled()) {
      for (const trigger of thinkTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10
          });
        }
      }
    }

    // 对 ultraplan 关键词应用相同的彩虹处理
    if (feature('ULTRAPLAN')) {
      for (const trigger of ultraplanTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10
          });
        }
      }
    }

    // 对 ultrareview 关键词应用相同的彩虹处理
    for (const trigger of ultrareviewTriggers) {
      for (let i = trigger.start; i < trigger.end; i++) {
        highlights.push({
          start: i,
          end: i + 1,
          color: getRainbowColor(i - trigger.start),
          shimmerColor: getRainbowColor(i - trigger.start, true),
          priority: 10
        });
      }
    }

    // /buddy 的彩虹效果
    for (const trigger of buddyTriggers) {
      for (let i = trigger.start; i < trigger.end; i++) {
        highlights.push({
          start: i,
          end: i + 1,
          color: getRainbowColor(i - trigger.start),
          shimmerColor: getRainbowColor(i - trigger.start, true),
          priority: 10
        });
      }
    }
    return highlights;
  }, [isSearchingHistory, historyQuery, historyMatch, historyFailedMatch, cursorOffset, btwTriggers, imageRefPositions, memberMentionHighlights, slashCommandTriggers, tokenBudgetTriggers, slackChannelTriggers, displayedValue, voiceInterimRange, thinkTriggers, ultraplanTriggers, ultrareviewTriggers, buddyTriggers]);
  const {
    addNotification,
    removeNotification
  } = useNotifications();

  // 显示 ultrathink 通知
  useEffect(() => {
    if (thinkTriggers.length && isUltrathinkEnabled()) {
      addNotification({
        key: 'ultrathink-active',
        text: '本轮已把努力级别设为高',
        priority: 'immediate',
        timeoutMs: 5000
      });
    } else {
      removeNotification('ultrathink-active');
    }
  }, [addNotification, removeNotification, thinkTriggers.length]);
  useEffect(() => {
    if (feature('ULTRAPLAN') && ultraplanTriggers.length) {
      addNotification({
        key: 'ultraplan-active',
        text: '此提示将启动一次网页端 ultraplan 会话',
        priority: 'immediate',
        timeoutMs: 5000
      });
    } else {
      removeNotification('ultraplan-active');
    }
  }, [addNotification, removeNotification, ultraplanTriggers.length]);
  useEffect(() => {
    if (isUltrareviewEnabled() && ultrareviewTriggers.length) {
      addNotification({
        key: 'ultrareview-active',
        text: '完成后运行 /ultrareview 以在云端审阅这些更改',
        priority: 'immediate',
        timeoutMs: 5000
      });
    }
  }, [addNotification, ultrareviewTriggers.length]);

  // 跟踪输入长度以用于暂存提示
  const prevInputLengthRef = useRef(input.length);
  const peakInputLengthRef = useRef(input.length);

  // 用户进行任何输入改动时关闭暂存提示
  const dismissStashHint = useCallback(() => {
    removeNotification('stash-hint');
  }, [removeNotification]);

  // 当用户逐渐清空大量输入时显示暂存提示
  useEffect(() => {
    const prevLength = prevInputLengthRef.current;
    const peakLength = peakInputLengthRef.current;
    const currentLength = input.length;
    prevInputLengthRef.current = currentLength;

    // 输入增长时更新峰值
    if (currentLength > peakLength) {
      peakInputLengthRef.current = currentLength;
      return;
    }

    // 输入为空时重置状态
    if (currentLength === 0) {
      peakInputLengthRef.current = 0;
      return;
    }

    // 检测渐进式清空：峰值很高但当前很低，且这不是单次大跳变
    // （像 esc-esc 这类快速清除会一步从 20+ 降到 0）
    const clearedSubstantialInput = peakLength >= 20 && currentLength <= 5;
    const wasRapidClear = prevLength >= 20 && currentLength <= 5;
    if (clearedSubstantialInput && !wasRapidClear) {
      const config = getGlobalConfig();
      if (!config.hasUsedStash) {
        addNotification({
          key: 'stash-hint',
          jsx: <Text dimColor>
              提示:{' '}
              <ConfigurableShortcutHint action="chat:stash" context="Chat" fallback="ctrl+s" description="暂存" />
            </Text>,
          priority: 'immediate',
          timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT
        });
      }
      peakInputLengthRef.current = currentLength;
    }
  }, [input.length, addNotification]);

  // 初始化输入缓冲区以支持撤销功能
  const {
    pushToBuffer,
    undo,
    canUndo,
    clearBuffer
  } = useInputBuffer({
    maxBufferSize: 50,
    debounceMs: 1000
  });
  useMaybeTruncateInput({
    input,
    pastedContents,
    onInputChange: trackAndSetInput,
    setCursorOffset,
    setPastedContents
  });
  const defaultPlaceholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName
  });
  const onChange = useCallback((value: string) => {
    if (value === '?') {
      logEvent('limkenion_help_toggled', {});
      setHelpOpen(v => !v);
      return;
    }
    setHelpOpen(false);

    // 用户进行任何输入改动时关闭暂存提示
    dismissStashHint();

    // 用户输入时取消任何挂起的提示建议和推测
    abortPromptSuggestion();
    abortSpeculation(setAppState);

    // 检查是否是在开头插入单个字符
    const isSingleCharInsertion = value.length === input.length + 1;
    const insertedAtStart = cursorOffset === 0;
    const mode = getModeFromInput(value);
    if (insertedAtStart && mode !== 'prompt') {
      if (isSingleCharInsertion) {
        onModeChange(mode);
        return;
      }
      // 向空输入中插入多字符（例如通过 tab 收下 "! gcloud auth login"）
      if (input.length === 0) {
        onModeChange(mode);
        const valueWithoutMode = getValueFromInput(value).replaceAll('\t', '    ');
        pushToBuffer(input, cursorOffset, pastedContents);
        trackAndSetInput(valueWithoutMode);
        setCursorOffset(valueWithoutMode.length);
        return;
      }
    }
    const processedValue = value.replaceAll('\t', '    ');

    // 做出改动前将当前状态压入缓冲区
    if (input !== processedValue) {
      pushToBuffer(input, cursorOffset, pastedContents);
    }

    // 用户输入时取消底部选中项
    setAppState(prev => prev.footerSelection === null ? prev : {
      ...prev,
      footerSelection: null
    });
    trackAndSetInput(processedValue);
  }, [trackAndSetInput, onModeChange, input, cursorOffset, pushToBuffer, pastedContents, dismissStashHint, setAppState]);
  const {
    resetHistory,
    onHistoryUp,
    onHistoryDown,
    dismissSearchHint,
    historyIndex
  } = useArrowKeyHistory((value: string, historyMode: HistoryMode, pastedContents: Record<number, PastedContent>) => {
    onChange(value);
    onModeChange(historyMode);
    setPastedContents(pastedContents);
  }, input, pastedContents, setCursorOffset, mode);

  // 用户开始搜索时关闭搜索提示
  useEffect(() => {
    if (isSearchingHistory) {
      dismissSearchHint();
    }
  }, [isSearchingHistory, dismissSearchHint]);

  // 仅当斜杠命令建议为 0 或 1 条时才使用历史导航。
  // 底部导航不在此处——当某项被选中时 TextInput focus=false，
  // 这些永远不会触发。底部按键绑定上下文负责处理 ↑/↓。
  function handleHistoryUp() {
    if (suggestions.length > 1) {
      return;
    }

    // 只有当光标位于第一行时才导航历史。
    // 在多行输入中，上箭头应移动光标（由 TextInput 处理），
    // 只有处于输入顶部时才触发历史。
    if (!isCursorOnFirstLine) {
      return;
    }

    // 若有可编辑的排队命令，按上箭头时把它移到输入中以便编辑
    const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable);
    if (hasEditableCommand) {
      void popAllCommandsFromQueue();
      return;
    }
    onHistoryUp();
  }
  function handleHistoryDown() {
    if (suggestions.length > 1) {
      return;
    }

    // 只有当光标位于最后一行时才导航历史/底部。
    // 在多行输入中，下箭头应移动光标（由 TextInput 处理），
    // 只有处于输入底部时才触发导航。
    if (!isCursorOnLastLine) {
      return;
    }

    // 位于历史底部 → 进入底部并定位到第一个可见的 pill
    if (onHistoryDown() && footerItems.length > 0) {
      const first = footerItems[0]!;
      selectFooterItem(first);
      if (first === 'tasks' && !getGlobalConfig().hasSeenTasksHint) {
        saveGlobalConfig(c => c.hasSeenTasksHint ? c : {
          ...c,
          hasSeenTasksHint: true
        });
      }
    }
  }

  // 直接创建一个建议状态——稍后与 useTypeahead 同步
  const [suggestionsState, setSuggestionsStateRaw] = useState<{
    suggestions: SuggestionItem[];
    selectedSuggestion: number;
    commandArgumentHint?: string;
  }>({
    suggestions: [],
    selectedSuggestion: -1,
    commandArgumentHint: undefined
  });

  // 建议状态的 setter
  const setSuggestionsState = useCallback((updater: typeof suggestionsState | ((prev: typeof suggestionsState) => typeof suggestionsState)) => {
    setSuggestionsStateRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);
  const onSubmit = useCallback(async (inputParam: string, isSubmittingSlashCommand = false) => {
    inputParam = inputParam.trimEnd();

    // 若正在打开某个底部指示器则不提交。从
    // store 直接读取——footer:openSelected 会在同一 tick 内先调用
    // selectFooterItem(null) 再调用 onSubmit，而闭包值尚未更新。沿用
    // footerItemSelected 的"是否仍可见"推导，使过期的选中项（pill 已消失）
    // 不会吞掉回车。
    const state = store.getState();
    if (state.footerSelection && footerItems.includes(state.footerSelection)) {
      return;
    }

    // 选中模式下的回车确认选中（useBackgroundTaskNavigation）。
    // BaseTextInput 的 useInput 在该 hook 之前注册（子组件副作用先触发），
    // 若无此保护，回车会双重触发并自动提交建议。
    if (state.viewSelectionMode === 'selecting-agent') {
      return;
    }

    // 尽早检查是否有图片——供下方建议逻辑使用
    const hasImages = Object.values(pastedContents).some(c => c.type === 'image');

    // 若输入为空或匹配建议则提交。
    // 但若有图片附加，则不自动接受建议——
    // 用户只想提交图片本身。
    // 仅在主导者视图生效——提示建议是主导者上下文，而非队友。
    const suggestionText = promptSuggestionState.text;
    const inputMatchesSuggestion = inputParam.trim() === '' || inputParam === suggestionText;
    if (inputMatchesSuggestion && suggestionText && !hasImages && !state.viewingAgentTaskId) {
      // 若推测处于活动状态，则在流式输出时立即注入消息
      if (speculation.status === 'active') {
        markAccepted();
        // skipReset：resetSuggestion 会在我们接受之前终止推测
        logOutcomeAtSubmission(suggestionText, {
          skipReset: true
        });
        void onSubmitProp(suggestionText, {
          setCursorOffset,
          clearBuffer,
          resetHistory
        }, {
          state: speculation,
          speculationSessionTimeSavedMs: speculationSessionTimeSavedMs,
          setAppState
        });
        return; // 跳过普通查询——推测已处理
      }

      // 常规建议接受（要求 shownAt > 0）
      if (promptSuggestionState.shownAt > 0) {
        markAccepted();
        inputParam = suggestionText;
      }
    }

    // 处理 @name 直接消息
    if (isAgentSwarmsEnabled()) {
      const directMessage = parseDirectMemberMessage(inputParam);
      if (directMessage) {
        const result = await sendDirectMemberMessage(directMessage.recipientName, directMessage.message, teamContext, writeToMailbox);
        if (result.success) {
          addNotification({
            key: 'direct-message-sent',
            text: `已发送到 @${result.recipientName}`,
            priority: 'immediate',
            timeoutMs: 3000
          });
          trackAndSetInput('');
          setCursorOffset(0);
          clearBuffer();
          resetHistory();
          return;
        } else if (result.error === 'no_team_context') {
          // 无团队上下文——回退到正常提示提交
        } else {
          // 未知接收者——回退到正常提示提交
          // 这样允许例如 "@utils explain this code" 作为提示发送
        }
      }
    }

    // 即使没有文本，若有图片附加也允许提交
    if (inputParam.trim() === '' && !hasImages) {
      return;
    }

    // PromptInput 体验：检查建议下拉框是否正在显示
    // 对于目录建议，允许提交（Tab 用于补全）
    const hasDirectorySuggestions = suggestionsState.suggestions.length > 0 && suggestionsState.suggestions.every(s => s.description === 'directory');
    if (suggestionsState.suggestions.length > 0 && !isSubmittingSlashCommand && !hasDirectorySuggestions) {
      logForDebugging(`[onSubmit] early return: suggestions showing (count=${suggestionsState.suggestions.length})`);
      return; // 不提交，用户需先清除建议
    }

    // 若存在建议则记录其输出结果
    if (promptSuggestionState.text && promptSuggestionState.shownAt > 0) {
      logOutcomeAtSubmission(inputParam);
    }

    // 提交时清除暂存提示通知
    removeNotification('stash-hint');

    // 将输入路由到被查看的代理（in-process 队友或具名 local_agent）。
    const activeAgent = getActiveAgentForInput(store.getState());
    if (activeAgent.type !== 'leader' && onAgentSubmit) {
      logEvent('limkenion_transcript_input_to_teammate', {});
      await onAgentSubmit(inputParam, activeAgent.task, {
        setCursorOffset,
        clearBuffer,
        resetHistory
      });
      return;
    }

    // 正常的主导者提交
    await onSubmitProp(inputParam, {
      setCursorOffset,
      clearBuffer,
      resetHistory
    });
  }, [promptSuggestionState, speculation, speculationSessionTimeSavedMs, teamContext, store, footerItems, suggestionsState.suggestions, onSubmitProp, onAgentSubmit, clearBuffer, resetHistory, logOutcomeAtSubmission, setAppState, markAccepted, pastedContents, removeNotification]);
  const {
    suggestions,
    selectedSuggestion,
    commandArgumentHint,
    inlineGhostText,
    maxColumnWidth
  } = useTypeahead({
    commands,
    onInputChange: trackAndSetInput,
    onSubmit,
    setCursorOffset,
    input,
    cursorOffset,
    mode,
    agents,
    setSuggestionsState,
    suggestionsState,
    suppressSuggestions: isSearchingHistory || historyIndex > 0,
    markAccepted,
    onModeChange
  });

  // Track if prompt suggestion should be shown (computed later with terminal width).
  // Hidden in teammate view — suggestion is leader-context only.
  const showPromptSuggestion = mode === 'prompt' && suggestions.length === 0 && promptSuggestion && !viewingAgentTaskId;
  if (showPromptSuggestion) {
    markShown();
  }

  // 若建议已生成但因时机问题无法显示，则记录被抑制的情况。
  // 排除队友视图：markShown() 在上方被门控，故那里 shownAt 保持 0——
  // 但那不是时机失败，返回主导者时该建议是有效的。
  if (promptSuggestionState.text && !promptSuggestion && promptSuggestionState.shownAt === 0 && !viewingAgentTaskId) {
    logSuggestionSuppressed('timing', promptSuggestionState.text);
    setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      }
    }));
  }
  function onImagePaste(image: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, sourcePath?: string) {
    logEvent('limkenion_paste_image', {});
    onModeChange('prompt');
    const pasteId = nextPasteIdRef.current++;
    const newContent: PastedContent = {
      id: pasteId,
      type: 'image',
      content: image,
      mediaType: mediaType || 'image/png',
      // 若未提供则默认使用 PNG
      filename: filename || 'Pasted image',
      dimensions,
      sourcePath
    };

    // 立即（快速）缓存路径，使链接在渲染时就可用
    cacheImagePath(newContent);

    // 在后台将图片存到磁盘
    void storeImage(newContent);

    // 更新界面
    setPastedContents(prev => ({
      ...prev,
      [pasteId]: newContent
    }));
    // 多图粘贴会在循环中调用 onImagePaste。若 ref 已经就绪，
    // 上一个 pill 的懒空格会在本 pill 之前触发，而不是丢失。
    const prefix = pendingSpaceAfterPillRef.current ? ' ' : '';
    insertTextAtCursor(prefix + formatImageRef(pasteId));
    pendingSpaceAfterPillRef.current = true;
  }

  // 剪除其 [Image #N] 占位符不再存在于输入文本中的图片。
  // 涵盖 pill 退格、Ctrl+U、逐字符删除——任何会去掉该引用的编辑。
  // onImagePaste 在同一事件中批量调用 setPastedContents + insertTextAtCursor，
  // 因此本副作用会看到占位符已存在。
  useEffect(() => {
    const referencedIds = new Set(parseReferences(input).map(r => r.id));
    setPastedContents(prev => {
      const orphaned = Object.values(prev).filter(c => c.type === 'image' && !referencedIds.has(c.id));
      if (orphaned.length === 0) return prev;
      const next = {
        ...prev
      };
      for (const img of orphaned) delete next[img.id];
      return next;
    });
  }, [input, setPastedContents]);
  function onTextPaste(rawText: string) {
    pendingSpaceAfterPillRef.current = false;
    // 清理粘贴文本——去除 ANSI 转义序列并规范换行和制表符
    let text = stripAnsi(rawText).replace(/\r/g, '\n').replaceAll('\t', '    ');

    // 与输入/自动建议一致：粘贴到空输入的 `!cmd` 进入 bash 模式。
    if (input.length === 0) {
      const pastedMode = getModeFromInput(text);
      if (pastedMode !== 'prompt') {
        onModeChange(pastedMode);
        text = getValueFromInput(text);
      }
    }
    const numLines = getPastedTextRefNumLines(text);
    // 限制输入中显示的行数。
    // 若整体布局过高，Ink 会重绘整个终端。
    // 实际所需高度取决于内容，这里只是估算。
    const maxLines = Math.min(rows - 10, 2);

    // 对较长的粘贴文本（超过 PASTE_THRESHOLD 字符）使用特殊处理，
    // 或当行数超过我们希望显示的行数时
    if (text.length > PASTE_THRESHOLD || numLines > maxLines) {
      const pasteId = nextPasteIdRef.current++;
      const newContent: PastedContent = {
        id: pasteId,
        type: 'text',
        content: text
      };
      setPastedContents(prev => ({
        ...prev,
        [pasteId]: newContent
      }));
      insertTextAtCursor(formatPastedTextRef(pasteId, numLines));
    } else {
      // 对于较短的粘贴，直接正常插入文本
      insertTextAtCursor(text);
    }
  }
  const lazySpaceInputFilter = useCallback((input: string, key: Key): string => {
    if (!pendingSpaceAfterPillRef.current) return input;
    pendingSpaceAfterPillRef.current = false;
    if (isNonSpacePrintable(input, key)) return ' ' + input;
    return input;
  }, []);
  function insertTextAtCursor(text: string) {
    // 插入前将当前状态压入缓冲区
    pushToBuffer(input, cursorOffset, pastedContents);
    const newInput = input.slice(0, cursorOffset) + text + input.slice(cursorOffset);
    trackAndSetInput(newInput);
    setCursorOffset(cursorOffset + text.length);
  }
  const doublePressEscFromEmpty = useDoublePress(() => {}, () => onShowMessageSelector());

  // 获取待编辑的排队命令。若命令已被弹出则返回 true。
  const popAllCommandsFromQueue = useCallback((): boolean => {
    const result = popAllEditable(input, cursorOffset);
    if (!result) {
      return false;
    }
    trackAndSetInput(result.text);
    onModeChange('prompt'); // 排队命令一律使用提示模式
    setCursorOffset(result.cursorOffset);

    // 将排队命令中的图片恢复到 pastedContents
    if (result.images.length > 0) {
      setPastedContents(prev => {
        const newContents = {
          ...prev
        };
        for (const image of result.images) {
          newContents[image.id] = image;
        }
        return newContents;
      });
    }
    return true;
  }, [trackAndSetInput, onModeChange, input, cursorOffset, setPastedContents]);

  // 当收到来自 IDE 的 @引用 通知时，插入该引用文本（文件路径以及可选的行范围）。
  const onIdeAtMentioned = function (atMentioned: IDEAtMentioned) {
    logEvent('limkenion_ext_at_mentioned', {});
    let atMentionedText: string;
    const relativePath = path.relative(getCwd(), atMentioned.filePath);
    if (atMentioned.lineStart && atMentioned.lineEnd) {
      atMentionedText = atMentioned.lineStart === atMentioned.lineEnd ? `@${relativePath}#L${atMentioned.lineStart} ` : `@${relativePath}#L${atMentioned.lineStart}-${atMentioned.lineEnd} `;
    } else {
      atMentionedText = `@${relativePath} `;
    }
    const cursorChar = input[cursorOffset - 1] ?? ' ';
    if (!/\s/.test(cursorChar)) {
      atMentionedText = ` ${atMentionedText}`;
    }
    insertTextAtCursor(atMentionedText);
  };
  useIdeAtMentioned(mcpClients, onIdeAtMentioned);

  // chat:undo 处理器——撤销上一次编辑
  const handleUndo = useCallback(() => {
    if (canUndo) {
      const previousState = undo();
      if (previousState) {
        trackAndSetInput(previousState.text);
        setCursorOffset(previousState.cursorOffset);
        setPastedContents(previousState.pastedContents);
      }
    }
  }, [canUndo, undo, trackAndSetInput, setPastedContents]);

  // chat:newline 处理器——在光标位置插入换行
  const handleNewline = useCallback(() => {
    pushToBuffer(input, cursorOffset, pastedContents);
    const newInput = input.slice(0, cursorOffset) + '\n' + input.slice(cursorOffset);
    trackAndSetInput(newInput);
    setCursorOffset(cursorOffset + 1);
  }, [input, cursorOffset, trackAndSetInput, setCursorOffset, pushToBuffer, pastedContents]);

  // Handler for chat:externalEditor - edit in $EDITOR
  const handleExternalEditor = useCallback(async () => {
    logEvent('limkenion_external_editor_used', {});
    setIsExternalEditorActive(true);
    try {
      // 传入 pastedContents 以展开折叠的文本引用
      const result = await editPromptInEditor(input, pastedContents);
      if (result.error) {
        addNotification({
          key: 'external-editor-error',
          text: result.error,
          color: 'warning',
          priority: 'high'
        });
      }
      if (result.content !== null && result.content !== input) {
        // 做出改动前将当前状态压入缓冲区
        pushToBuffer(input, cursorOffset, pastedContents);
        trackAndSetInput(result.content);
        setCursorOffset(result.content.length);
      }
    } catch (err) {
      if (err instanceof Error) {
        logError(err);
      }
      addNotification({
        key: 'external-editor-error',
        text: `外部编辑器失败：${errorMessage(err)}`,
        color: 'warning',
        priority: 'high'
      });
    } finally {
      setIsExternalEditorActive(false);
    }
  }, [input, cursorOffset, pastedContents, pushToBuffer, trackAndSetInput, addNotification]);

  // chat:stash 处理器——暂存/恢复提示
  const handleStash = useCallback(() => {
    if (input.trim() === '' && stashedPrompt !== undefined) {
      // 输入为空时弹出暂存
      trackAndSetInput(stashedPrompt.text);
      setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    } else if (input.trim() !== '') {
      // 压入暂存（保存文本、光标位置和粘贴内容）
      setStashedPrompt({
        text: input,
        cursorOffset,
        pastedContents
      });
      trackAndSetInput('');
      setCursorOffset(0);
      setPastedContents({});
      // 记录 /discover 的使用并停止显示提示
      saveGlobalConfig(c => {
        if (c.hasUsedStash) return c;
        return {
          ...c,
          hasUsedStash: true
        };
      });
    }
  }, [input, cursorOffset, stashedPrompt, trackAndSetInput, setStashedPrompt, pastedContents, setPastedContents]);

  // chat:modelPicker 处理器——切换模型选择器
  const handleModelPicker = useCallback(() => {
    setShowModelPicker(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // chat:fastMode 处理器——切换快速模式选择器
  const handleFastModePicker = useCallback(() => {
    setShowFastModePicker(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // chat:thinkingToggle 处理器——切换思维模式
  const handleThinkingToggle = useCallback(() => {
    setShowThinkingToggle(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // chat:cycleMode 处理器——循环切换权限模式
  const handleCycleMode = useCallback(() => {
    // 当查看队友时，循环切换他们而非主导者的模式
    if (isAgentSwarmsEnabled() && viewedTeammate && viewingAgentTaskId) {
      const teammateContext: ToolPermissionContext = {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode
      };
      // 传入 undefined 作为 teamContext（未使用，但为保持 API 兼容）
      const nextMode = getNextPermissionMode(teammateContext, undefined);
      logEvent('limkenion_mode_cycle', {
        to: nextMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      const teammateTaskId = viewingAgentTaskId;
      setAppState(prev => {
        const task = prev.tasks[teammateTaskId];
        if (!task || task.type !== 'in_process_teammate') {
          return prev;
        }
        if (task.permissionMode === nextMode) {
          return prev;
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [teammateTaskId]: {
              ...task,
              permissionMode: nextMode
            }
          }
        };
      });
      if (helpOpen) {
        setHelpOpen(false);
      }
      return;
    }

    // 先计算下一模式，而不触发副作用
    logForDebugging(`[auto-mode] handleCycleMode: currentMode=${toolPermissionContext.mode} isAutoModeAvailable=${toolPermissionContext.isAutoModeAvailable} showAutoModeOptIn=${showAutoModeOptIn} timeoutPending=${!!autoModeOptInTimeoutRef.current}`);
    const nextMode = getNextPermissionMode(toolPermissionContext, teamContext);

    // 检查用户是否首次进入自动模式。以持久设置标志（hasAutoModeOptIn）为门控，
    // 而非更宽泛的 hasAutoModeOptInAnySource，使 --enable-auto-mode 用户
    // 也能看到一次警告对话框——该 CLI 标志应授予轮播访问权，
    // 而非绕过安全提示文本。
    let isEnteringAutoModeFirstTime = false;
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      isEnteringAutoModeFirstTime = nextMode === 'auto' && toolPermissionContext.mode !== 'auto' && !hasAutoModeOptIn() && !viewingAgentTaskId; // 仅为主代理显示，子代理不显示
    }
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (isEnteringAutoModeFirstTime) {
        // 保存先前模式，以便用户拒绝时能够回退
        setPreviousModeBeforeAuto(toolPermissionContext.mode);

        // 仅更新界面上的模式标签——暂不调用 transitionPermissionMode
        // 或 cyclePermissionMode；尚未与用户确认。
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: 'auto'
          }
        }));
        setToolPermissionContext({
          ...toolPermissionContext,
          mode: 'auto'
        });

        // 400ms 防抖后显示选择加入对话框
        if (autoModeOptInTimeoutRef.current) {
          clearTimeout(autoModeOptInTimeoutRef.current);
        }
        autoModeOptInTimeoutRef.current = setTimeout((setShowAutoModeOptIn, autoModeOptInTimeoutRef) => {
          setShowAutoModeOptIn(true);
          autoModeOptInTimeoutRef.current = null;
        }, 400, setShowAutoModeOptIn, autoModeOptInTimeoutRef);
        if (helpOpen) {
          setHelpOpen(false);
        }
        return;
      }
    }

    // 若正在显示或挂起自动模式选择加入对话框则将其关闭（用户正在循环切走）。
    // 此处不要回退到 previousModeBeforeAuto——shift+tab 表示"推进轮播"，
    // 而非"拒绝"。回退会导致乒乓循环：自动模式会回退到先前模式，
    // 而该模式的下一模式又是自动模式，永无止境。
    // 对话框自身的"拒绝"按钮（handleAutoModeOptInDecline）负责回退。
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (showAutoModeOptIn || autoModeOptInTimeoutRef.current) {
        if (showAutoModeOptIn) {
          logEvent('limkenion_auto_mode_opt_in_dialog_decline', {});
        }
        setShowAutoModeOptIn(false);
        if (autoModeOptInTimeoutRef.current) {
          clearTimeout(autoModeOptInTimeoutRef.current);
          autoModeOptInTimeoutRef.current = null;
        }
        setPreviousModeBeforeAuto(null);
        // 继续向下执行——模式仍为 'auto'，下方的 cyclePermissionMode 会转到 'default'。
      }
    }

    // 既然已知这不是首次进入自动模式路径，
    // 调用 cyclePermissionMode 以应用副作用（例如清除
    // 危险权限、激活分类器）
    const {
      context: preparedContext
    } = cyclePermissionMode(toolPermissionContext, teamContext);
    logEvent('limkenion_mode_cycle', {
      to: nextMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });

    // 记录用户进入计划模式的时刻
    if (nextMode === 'plan') {
      saveGlobalConfig(current => ({
        ...current,
        lastPlanModeUse: Date.now()
      }));
    }

    // 通过 setAppState 直接设置模式，因为 setToolPermissionContext
    // 有意保留现有模式（防止工作代理破坏协调者模式）。随后调用
    // setToolPermissionContext 以触发对排队权限提示的复查。
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...preparedContext,
        mode: nextMode
      }
    }));
    setToolPermissionContext({
      ...preparedContext,
      mode: nextMode
    });

    // 若是队友，更新 config.json，使团队领导能看到该变更
    syncTeammateMode(nextMode, teamContext?.teamName);

    // 在循环切模式时若帮助提示处于开启状态则将其关闭
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [toolPermissionContext, teamContext, viewingAgentTaskId, viewedTeammate, setAppState, setToolPermissionContext, helpOpen, showAutoModeOptIn]);

  // 自动模式选择加入对话框"接受"处理器
  const handleAutoModeOptInAccept = useCallback(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      setShowAutoModeOptIn(false);
      setPreviousModeBeforeAuto(null);

      // 既然用户已接受，应用完整转换：激活自动模式后端
      //（分类器、beta 请求头）并清除危险权限
      //（例如 Bash(*) 始终允许规则）。
      const strippedContext = transitionPermissionMode(previousModeBeforeAuto ?? toolPermissionContext.mode, 'auto', toolPermissionContext);
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...strippedContext,
          mode: 'auto'
        }
      }));
      setToolPermissionContext({
        ...strippedContext,
        mode: 'auto'
      });

      // 启用自动模式时若帮助提示处于开启状态则将其关闭
      if (helpOpen) {
        setHelpOpen(false);
      }
    }
  }, [helpOpen, setHelpOpen, previousModeBeforeAuto, toolPermissionContext, setAppState, setToolPermissionContext]);

  // 自动模式选择加入对话框"拒绝"处理器
  const handleAutoModeOptInDecline = useCallback(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      logForDebugging(`[auto-mode] handleAutoModeOptInDecline: reverting to ${previousModeBeforeAuto}, setting isAutoModeAvailable=false`);
      setShowAutoModeOptIn(false);
      if (autoModeOptInTimeoutRef.current) {
        clearTimeout(autoModeOptInTimeoutRef.current);
        autoModeOptInTimeoutRef.current = null;
      }

      // 回退到先前模式，并在本次会话其余时间内从轮播中移除 auto
      if (previousModeBeforeAuto) {
        setAutoModeActive(false);
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: previousModeBeforeAuto,
            isAutoModeAvailable: false
          }
        }));
        setToolPermissionContext({
          ...toolPermissionContext,
          mode: previousModeBeforeAuto,
          isAutoModeAvailable: false
        });
        setPreviousModeBeforeAuto(null);
      }
    }
  }, [previousModeBeforeAuto, toolPermissionContext, setAppState, setToolPermissionContext]);

  // chat:imagePaste 处理器——从剪贴板粘贴图片
  const handleImagePaste = useCallback(() => {
    void getImageFromClipboard().then(imageData => {
      if (imageData) {
        onImagePaste(imageData.base64, imageData.mediaType);
      } else {
        const shortcutDisplay = getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v');
        const message = env.isSSH() ? "剪贴板中没有找到图片。你处于 SSH 环境；试试 scp？" : `剪贴板中没有找到图片。使用 ${shortcutDisplay} 粘贴图片。`;
        addNotification({
          key: 'no-image-in-clipboard',
          text: message,
          priority: 'immediate',
          timeoutMs: 1000
        });
      }
    });
  }, [addNotification, onImagePaste]);

  // 直接在处理器注册表中注册 chat:submit 处理器（而非通过
  // useKeybindings），以便只有 ChordInterceptor 才能为和弦
  // 完成页调用它（例如 "ctrl+e s"）。提交的默认回车绑定由
  // TextInput 直接处理（通过 onSubmit prop）以及 useTypeahead（用于
  // 自动补全接受）。使用 useKeybindings 会在回车时触发
  // stopImmediatePropagation，从而阻止自动补全看到该按键。
  const keybindingContext = useOptionalKeybindingContext();
  useEffect(() => {
    if (!keybindingContext || isModalOverlayActive) return;
    return keybindingContext.registerHandler({
      action: 'chat:submit',
      context: 'Chat',
      handler: () => {
        void onSubmit(input);
      }
    });
  }, [keybindingContext, isModalOverlayActive, onSubmit, input]);

  // Chat 上下文的编辑快捷方式按键绑定。
  // 注意：history:previous/history:next 不在此处处理。它们作为
  // onHistoryUp/onHistoryDown props 传给 TextInput，使 useTextInput 的
  // upOrHistoryUp/downOrHistoryDown 可以先尝试移动光标，仅在
  // 光标无法继续移动时才回退到历史。
  const chatHandlers = useMemo(() => ({
    'chat:undo': handleUndo,
    'chat:newline': handleNewline,
    'chat:externalEditor': handleExternalEditor,
    'chat:stash': handleStash,
    'chat:modelPicker': handleModelPicker,
    'chat:thinkingToggle': handleThinkingToggle,
    'chat:cycleMode': handleCycleMode,
    'chat:imagePaste': handleImagePaste
  }), [handleUndo, handleNewline, handleExternalEditor, handleStash, handleModelPicker, handleThinkingToggle, handleCycleMode, handleImagePaste]);
  useKeybindings(chatHandlers, {
    context: 'Chat',
    isActive: !isModalOverlayActive
  });

  // Shift+↑ 进入消息操作光标。单独的 isActive 使 ctrl+r 搜索
  // 在光标退出重挂载时不会留下过期的 isSearchingHistory。
  useKeybinding('chat:messageActions', () => onMessageActionsEnter?.(), {
    context: 'Chat',
    isActive: !isModalOverlayActive && !isSearchingHistory
  });

  // 快速模式按键绑定仅在快速模式已启用且可用时生效
  useKeybinding('chat:fastMode', handleFastModePicker, {
    context: 'Chat',
    isActive: !isModalOverlayActive && isFastModeEnabled() && isFastModeAvailable()
  });

  // 处理 help:dismiss 按键（ESC 关闭帮助菜单）。
  // 这与 Chat 上下文分开注册，使其在帮助菜单打开时
  // 对 CancelRequestHandler 具有优先权。
  useKeybinding('help:dismiss', () => {
    setHelpOpen(false);
  }, {
    context: 'Help',
    isActive: helpOpen
  });

  // Quick Open / Global Search。Hook 调用是无条件的（Hook 规则）；
  // 处理器主体由 feature() 门控，使 setState 调用和组件引用
  // 在外部构建中被 tree-shaking。
  const quickSearchActive = feature('QUICK_SEARCH') ? !isModalOverlayActive : false;
  useKeybinding('app:quickOpen', () => {
    if (feature('QUICK_SEARCH')) {
      setShowQuickOpen(true);
      setHelpOpen(false);
    }
  }, {
    context: 'Global',
    isActive: quickSearchActive
  });
  useKeybinding('app:globalSearch', () => {
    if (feature('QUICK_SEARCH')) {
      setShowGlobalSearch(true);
      setHelpOpen(false);
    }
  }, {
    context: 'Global',
    isActive: quickSearchActive
  });
  useKeybinding('history:search', () => {
    if (feature('HISTORY_PICKER')) {
      setShowHistoryPicker(true);
      setHelpOpen(false);
    }
  }, {
    context: 'Global',
    isActive: feature('HISTORY_PICKER') ? !isModalOverlayActive : false
  });

  // 处理空闲（非加载中）时 Ctrl+C 以终止推测。
  // CancelRequestHandler 仅在活动任务期间处理 Ctrl+C
  useKeybinding('app:interrupt', () => {
    abortSpeculation(setAppState);
  }, {
    context: 'Global',
    isActive: !isLoading && speculation.status === 'active'
  });

  // 底部指示器导航按键。↑/↓ 在此处（而非在
  // handleHistoryUp/Down 中），因为当某个 pill 被选中时 TextInput focus=false——
  // 其 useInput 处于未激活状态，因此这是唯一路径。
  useKeybindings({
    'footer:up': () => {
      // ↑ 在离开 pill 之前于协调者任务列表内向上滚动
      if (tasksSelected && false && coordinatorTaskCount > 0 && coordinatorTaskIndex > minCoordinatorIndex) {
        setCoordinatorTaskIndex(prev => prev - 1);
        return;
      }
      navigateFooter(-1, true);
    },
    'footer:down': () => {
      // ↓ 在协调者任务列表内向下滚动，绝不离开 pill
      if (tasksSelected && false && coordinatorTaskCount > 0) {
        if (coordinatorTaskIndex < coordinatorTaskCount - 1) {
          setCoordinatorTaskIndex(prev => prev + 1);
        }
        return;
      }
      if (tasksSelected && !isTeammateMode) {
        setShowBashesDialog(true);
        selectFooterItem(null);
        return;
      }
      navigateFooter(1);
    },
    'footer:next': () => {
      // 队友模式：←/→ 在团队成员列表内循环
      if (tasksSelected && isTeammateMode) {
        const totalAgents = 1 + inProcessTeammates.length;
        setTeammateFooterIndex(prev => (prev + 1) % totalAgents);
        return;
      }
      navigateFooter(1);
    },
    'footer:previous': () => {
      if (tasksSelected && isTeammateMode) {
        const totalAgents = 1 + inProcessTeammates.length;
        setTeammateFooterIndex(prev => (prev - 1 + totalAgents) % totalAgents);
        return;
      }
      navigateFooter(-1);
    },
    'footer:openSelected': () => {
      if (viewSelectionMode === 'selecting-agent') {
        return;
      }
      switch (footerItemSelected) {
        case 'tasks':
          if (isTeammateMode) {
            // 回车切换到所选中代理的视图
            if (teammateFooterIndex === 0) {
              exitTeammateView(setAppState);
            } else {
              const teammate = inProcessTeammates[teammateFooterIndex - 1];
              if (teammate) enterTeammateView(teammate.id, setAppState);
            }
          } else if (coordinatorTaskIndex === 0 && coordinatorTaskCount > 0) {
            exitTeammateView(setAppState);
          } else {
            const selectedTaskId = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1]?.id;
            if (selectedTaskId) {
              enterTeammateView(selectedTaskId, setAppState);
            } else {
              setShowBashesDialog(true);
              selectFooterItem(null);
            }
          }
          break;
        case 'tmux':
          
          break;
        case 'bagel':
          break;
        case 'teams':
          setShowTeamsDialog(true);
          selectFooterItem(null);
          break;
        case 'bridge':
          // 已移除 bridge——无需显示对话框。
          selectFooterItem(null);
          break;
      }
    },
    'footer:clearSelection': () => {
      selectFooterItem(null);
    },
    'footer:close': () => {
      if (tasksSelected && coordinatorTaskIndex >= 1) {
        const task = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1];
        if (!task) return false;
        // 当选中行正是被查看的代理时，'x' 会输入到
        // 转向输入中。任何其他行——直接将其关闭。
        if (viewSelectionMode === 'viewing-agent' && task.id === viewingAgentTaskId) {
          onChange(input.slice(0, cursorOffset) + 'x' + input.slice(cursorOffset));
          setCursorOffset(cursorOffset + 1);
          return;
        }
        stopOrDismissAgent(task.id, setAppState);
        if (task.status !== 'running') {
          setCoordinatorTaskIndex(i => Math.max(minCoordinatorIndex, i - 1));
        }
        return;
      }
      // 未处理——让 'x' 落入输入以退出
      return false;
    }
  }, {
    context: 'Footer',
    isActive: !!footerItemSelected && !isModalOverlayActive
  });
  useInput((char, key) => {
    // 当全屏对话框打开时跳过所有输入处理。这些对话框
    // 通过提前返回渲染，但 hook 会无条件运行——因此若无此保护，
    // 对话框内的 Escape 会泄漏到双击消息选择器。
    if (showTeamsDialog || showQuickOpen || showGlobalSearch || showHistoryPicker) {
      return;
    }

    // 检测 macOS 上失败的 Alt 快捷方式（Option 键产生特殊字符）
    if (getPlatform() === 'macos' && isMacosOptionChar(char)) {
      const shortcut = MACOS_OPTION_SPECIAL_CHARS[char];
      const terminalName = getNativeCSIuTerminalDisplayName();
      const jsx = terminalName ? <Text dimColor>
          要启用 {shortcut}，请在{' '}
          {terminalName} 偏好设置（⌘,）中将 <Text bold>Option 视为 Meta</Text>
        </Text> : <Text dimColor>要启用 {shortcut}，请运行 /terminal-setup</Text>;
      addNotification({
        key: 'option-meta-hint',
        jsx,
        priority: 'immediate',
        timeoutMs: 5000
      });
      // 不返回——让字符被输入，让用户看到问题所在
    }

    // 底部导航已在上方通过 useKeybindings（Footer 上下文）处理

    // 注意：ctrl+_、ctrl+g、ctrl+s 已在上方通过 Chat 上下文按键绑定处理

    // 输入退出底部：当某个 pill 被选中时输入可打印字符会重新聚焦
    // 输入框并输入该字符。导航键被上方的 useKeybindings 捕获，
    // 因此能到达这里的内容确实不是底部操作。
    // onChange 会清除 footerSelection，因此无需显式取消选中。
    if (footerItemSelected && char && !key.ctrl && !key.meta && !key.escape && !key.return) {
      onChange(input.slice(0, cursorOffset) + char + input.slice(cursorOffset));
      setCursorOffset(cursorOffset + char.length);
      return;
    }

    // 在光标位置 0 按下退格/退出/删除/ctrl+u 时退出特殊模式
    if (cursorOffset === 0 && (key.escape || key.backspace || key.delete || key.ctrl && char === 'u')) {
      onModeChange('prompt');
      setHelpOpen(false);
    }

    // 输入为空且按下退格时退出帮助模式
    if (helpOpen && input === '' && (key.backspace || key.delete)) {
      setHelpOpen(false);
    }

    // esc 有些重载：
    // - 当正在加载响应时，用于取消请求
    // - 否则用于显示消息选择器
    // - 双击时用于清空输入
    // - 输入为空时，从命令队列中弹出

    // 处理 ESC 键
    if (key.escape) {
      // 终止活动的推测
      if (speculation.status === 'active') {
        abortSpeculation(setAppState);
        return;
      }

      // 若可见则关闭侧问响应
      if (isSideQuestionVisible && onDismissSideQuestion) {
        onDismissSideQuestion();
        return;
      }

      // 帮助菜单若打开则关闭
      if (helpOpen) {
        setHelpOpen(false);
        return;
      }

      // 底部选中项的清除现由 Footer 上下文按键绑定处理
      //（footer:clearSelection 动作绑定到 escape）
      // 若选中了某个底部项，让 Footer 按键绑定处理它
      if (footerItemSelected) {
        return;
      }

      // 若有可编辑的排队命令，按 ESC 时把它移到输入中以便编辑
      const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable);
      if (hasEditableCommand) {
        void popAllCommandsFromQueue();
        return;
      }
      if (messages.length > 0 && !input && !isLoading) {
        doublePressEscFromEmpty();
      }
    }
    if (key.return && helpOpen) {
      setHelpOpen(false);
    }
  });
  const swarmBanner = useSwarmBanner();
  const fastModeCooldown = isFastModeEnabled() ? isFastModeCooldown() : false;
  const showFastIcon = isFastModeEnabled() ? isFastMode && (isFastModeAvailable() || fastModeCooldown) : false;
  const showFastIconHint = useShowFastIconHint(showFastIcon ?? false);

  // 启动时以及努力级别变化时显示努力通知。
  // 在 brief/assistant 模式下被抑制——该值反映的是本地
  // 客户端的努力级别，而非所连接代理的。
  const effortNotificationText = briefOwnsGap ? undefined : getEffortNotificationText(effortValue, mainLoopModel);
  useEffect(() => {
    if (!effortNotificationText) {
      removeNotification('effort-level');
      return;
    }
    addNotification({
      key: 'effort-level',
      text: effortNotificationText,
      priority: 'high',
      timeoutMs: 12_000
    });
  }, [effortNotificationText, addNotification, removeNotification]);
  // 已移除 Buddy 伴侣功能——从不发言，也没有保留列。
  const companionSpeaking = false;
  const {
    columns,
    rows
  } = useTerminalSize();
  const textInputColumns = columns - 3;

  // POC：点击定位光标。鼠标跟踪仅在 <AlternateScreen> 内启用，
  // 因此在普通主屏 REPL 中处于休眠状态。
  // localCol/localRow 相对于 onClick Box 的左上角；该 Box
  // 紧贴文本输入，因此它们直接映射到 Cursor 换行模型中的
  //（列、行）。MeasuredText.getOffsetFromPosition 会处理
  // 宽字符、换行，并把点到结尾之外点击钳制到行尾。
  const maxVisibleLines = isFullscreenEnvEnabled() ? Math.max(MIN_INPUT_VIEWPORT_LINES, Math.floor(rows / 2) - PROMPT_FOOTER_LINES) : undefined;
  const handleInputClick = useCallback((e: ClickEvent) => {
    // 历史搜索期间显示的文本是 historyMatch，而非 input，
    // 而且 showCursor 反正为 false——跳过，而不是
    // 针对错误的字符串计算偏移。
    if (!input || isSearchingHistory) return;
    const c = Cursor.fromText(input, textInputColumns, cursorOffset);
    const viewportStart = c.getViewportStartLine(maxVisibleLines);
    const offset = c.measuredText.getOffsetFromPosition({
      line: e.localRow + viewportStart,
      column: e.localCol
    });
    setCursorOffset(offset);
  }, [input, textInputColumns, isSearchingHistory, cursorOffset, maxVisibleLines]);
  const handleOpenTasksDialog = useCallback((taskId?: string) => setShowBashesDialog(taskId ?? true), [setShowBashesDialog]);
  const placeholder = showPromptSuggestion && promptSuggestion ? promptSuggestion : defaultPlaceholder;

  // 计算输入是否包含多行
  const isInputWrapped = useMemo(() => input.includes('\n'), [input]);

  // 对模型选择器回调进行记忆化，避免在无关状态（如通知）
  // 变化时重新渲染。这样在通知到达时，内联模型选择器
  // 不会在视觉上"跳动"。
  const handleModelSelect = useCallback((model: string | null, _effort: EffortLevel | undefined) => {
    let wasFastModeDisabled = false;
    setAppState(prev => {
      wasFastModeDisabled = isFastModeEnabled() && !isFastModeSupportedByModel(model) && !!prev.fastMode;
      return {
        ...prev,
        mainLoopModel: model,
        mainLoopModelForSession: null,
        // 如切换到不支持快速模式的模型，则关闭快速模式
        ...(wasFastModeDisabled && {
          fastMode: false
        })
      };
    });
    setShowModelPicker(false);
    const effectiveFastMode = (isFastMode ?? false) && !wasFastModeDisabled;
    let message = `模型已设为 ${modelDisplayString(model)}`;
    if (isBilledAsExtraUsage(model, effectiveFastMode, is1mContextMergeEnabled())) {
      message += ' · 计为额外用量';
    }
    if (wasFastModeDisabled) {
      message += ' · 快速模式已关闭';
    }
    addNotification({
      key: 'model-switched',
      jsx: <Text>{message}</Text>,
      priority: 'immediate',
      timeoutMs: 3000
    });
    logEvent('limkenion_model_picker_hotkey', {
      model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
  }, [setAppState, addNotification, isFastMode]);
  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  // 对模型选择器元素进行记忆化，避免在 AppState 因无关原因（如通知到达）变化时产生不必要的重新渲染
  const modelPickerElement = useMemo(() => {
    if (!showModelPicker) return null;
    return <Box flexDirection="column" marginTop={1}>
        <ModelPicker initial={mainLoopModel_} sessionModel={mainLoopModelForSession} onSelect={handleModelSelect} onCancel={handleModelCancel} isStandaloneCommand showFastModeNotice={isFastModeEnabled() && isFastMode && isFastModeSupportedByModel(mainLoopModel_) && isFastModeAvailable()} />
      </Box>;
  }, [showModelPicker, mainLoopModel_, mainLoopModelForSession, handleModelSelect, handleModelCancel]);
  const handleFastModeSelect = useCallback((result?: string) => {
    setShowFastModePicker(false);
    if (result) {
      addNotification({
        key: 'fast-mode-toggled',
        jsx: <Text>{result}</Text>,
        priority: 'immediate',
        timeoutMs: 3000
      });
    }
  }, [addNotification]);

  // 对快速模式选择器元素进行记忆化
  const fastModePickerElement = useMemo(() => {
    if (!showFastModePicker) return null;
    return <Box flexDirection="column" marginTop={1}>
        <FastModePicker onDone={handleFastModeSelect} unavailableReason={getFastModeUnavailableReason()} />
      </Box>;
  }, [showFastModePicker, handleFastModeSelect]);

  // 记忆化的思维开关回调
  const handleThinkingSelect = useCallback((enabled: boolean) => {
    setAppState(prev => ({
      ...prev,
      thinkingEnabled: enabled
    }));
    setShowThinkingToggle(false);
    logEvent('limkenion_thinking_toggled_hotkey', {
      enabled
    });
    addNotification({
      key: 'thinking-toggled-hotkey',
      jsx: <Text color={enabled ? 'suggestion' : undefined} dimColor={!enabled}>
            思维模式 {enabled ? '开启' : '关闭'}
          </Text>,
      priority: 'immediate',
      timeoutMs: 3000
    });
  }, [setAppState, addNotification]);
  const handleThinkingCancel = useCallback(() => {
    setShowThinkingToggle(false);
  }, []);

  // 对思维开关元素进行记忆化
  const thinkingToggleElement = useMemo(() => {
    if (!showThinkingToggle) return null;
    return <Box flexDirection="column" marginTop={1}>
        <ThinkingToggle currentValue={thinkingEnabled ?? true} onSelect={handleThinkingSelect} onCancel={handleThinkingCancel} isMidConversation={messages.some(m => m.type === 'assistant')} />
      </Box>;
  }, [showThinkingToggle, thinkingEnabled, handleThinkingSelect, handleThinkingCancel, messages.length]);

  // 将对话框以 Portal 方式挂载到全屏下的 DialogOverlay，使其脱离底部
  // 槽位的 overflowY:hidden 裁剪（与 SuggestionsOverlay 相同模式）。
  // 必须在下方提前返回之前调用，以满足 rules-of-hooks。
  // 已记忆化，使 portal 副作用不会在每次 PromptInput 渲染时抖动。
  const autoModeOptInDialog = useMemo(() => feature('TRANSCRIPT_CLASSIFIER') && showAutoModeOptIn ? <AutoModeOptInDialog onAccept={handleAutoModeOptInAccept} onDecline={handleAutoModeOptInDecline} /> : null, [showAutoModeOptIn, handleAutoModeOptInAccept, handleAutoModeOptInDecline]);
  useSetPromptOverlayDialog(isFullscreenEnvEnabled() ? autoModeOptInDialog : null);
  if (showBashesDialog) {
    return <BackgroundTasksDialog onDone={() => setShowBashesDialog(false)} toolUseContext={getToolUseContext(messages, [], new AbortController(), mainLoopModel)} initialDetailTaskId={typeof showBashesDialog === 'string' ? showBashesDialog : undefined} />;
  }
  if (isAgentSwarmsEnabled() && showTeamsDialog) {
    return <TeamsDialog initialTeams={cachedTeams} onDone={() => {
      setShowTeamsDialog(false);
    }} />;
  }
  if (feature('QUICK_SEARCH')) {
    const insertWithSpacing = (text: string) => {
      const cursorChar = input[cursorOffset - 1] ?? ' ';
      insertTextAtCursor(/\s/.test(cursorChar) ? text : ` ${text}`);
    };
    if (showQuickOpen) {
      return <QuickOpenDialog onDone={() => setShowQuickOpen(false)} onInsert={insertWithSpacing} />;
    }
    if (showGlobalSearch) {
      return <GlobalSearchDialog onDone={() => setShowGlobalSearch(false)} onInsert={insertWithSpacing} />;
    }
  }
  if (feature('HISTORY_PICKER') && showHistoryPicker) {
    return <HistorySearchDialog initialQuery={input} onSelect={entry => {
      const entryMode = getModeFromInput(entry.display);
      const value = getValueFromInput(entry.display);
      onModeChange(entryMode);
      trackAndSetInput(value);
      setPastedContents(entry.pastedContents);
      setCursorOffset(value.length);
      setShowHistoryPicker(false);
    }} onCancel={() => setShowHistoryPicker(false)} />;
  }

  // 需要时显示循环模式菜单（仅版本，外部构建中已消除）
  if (modelPickerElement) {
    return modelPickerElement;
  }
  if (fastModePickerElement) {
    return fastModePickerElement;
  }
  if (thinkingToggleElement) {
    return thinkingToggleElement;
  }

  const baseProps: BaseTextInputProps = {
    multiline: true,
    onSubmit,
    onChange,
    value: historyMatch ? getValueFromInput(typeof historyMatch === 'string' ? historyMatch : historyMatch.display) : input,
    // 历史导航通过 TextInput props（onHistoryUp/onHistoryDown）处理，
    // 而非 useKeybindings。这样 useTextInput 的 upOrHistoryUp/downOrHistoryDown
    // 可以先尝试移动光标，仅在光标无法继续移动时才回退到历史导航
    //（对换行文本和多行输入很重要）。
    onHistoryUp: handleHistoryUp,
    onHistoryDown: handleHistoryDown,
    onHistoryReset: resetHistory,
    placeholder,
    onExit,
    onExitMessage: (show, key) => setExitMessage({
      show,
      key
    }),
    onImagePaste,
    columns: textInputColumns,
    maxVisibleLines,
    disableCursorMovementForUpDownKeys: suggestions.length > 0 || !!footerItemSelected,
    disableEscapeDoublePress: suggestions.length > 0,
    cursorOffset,
    onChangeCursorOffset: setCursorOffset,
    onPaste: onTextPaste,
    onIsPastingChange: setIsPasting,
    focus: !isSearchingHistory && !isModalOverlayActive && !footerItemSelected,
    showCursor: !footerItemSelected && !isSearchingHistory && !cursorAtImageChip,
    argumentHint: commandArgumentHint,
    onUndo: canUndo ? () => {
      const previousState = undo();
      if (previousState) {
        trackAndSetInput(previousState.text);
        setCursorOffset(previousState.cursorOffset);
        setPastedContents(previousState.pastedContents);
      }
    } : undefined,
    highlights: combinedHighlights,
    inlineGhostText,
    inputFilter: lazySpaceInputFilter
  };
  const getBorderColor = (): keyof Theme => {
    const modeColors: Record<string, keyof Theme> = {
      bash: 'bashBorder'
    };

    // 模式颜色优先，然后是队友颜色，最后是默认颜色
    if (modeColors[mode]) {
      return modeColors[mode];
    }

    // In-process 队友无头运行——不要给主导者界面应用队友颜色
    if (isInProcessTeammate()) {
      return 'promptBorder';
    }

    // 从环境检查队友颜色
    const teammateColorName = getTeammateColor();
    if (teammateColorName && AGENT_COLORS.includes(teammateColorName as AgentColorName)) {
      return AGENT_COLOR_TO_THEME_COLOR[teammateColorName as AgentColorName];
    }
    return 'promptBorder';
  };
  if (isExternalEditorActive) {
    return <Box flexDirection="row" alignItems="center" justifyContent="center" borderColor={getBorderColor()} borderStyle="round" borderLeft={false} borderRight={false} borderBottom width="100%">
        <Text dimColor italic>
          保存并关闭编辑器以继续…
        </Text>
      </Box>;
  }
  // 已移除 Vim 输入——始终使用普通 TextInput。
  const textInputElement = <TextInput {...baseProps} />;
  return <Box flexDirection="column" marginTop={briefOwnsGap ? 0 : 1}>
      {!isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
      {hasSuppressedDialogs && <Box marginTop={1} marginLeft={2}>
          <Text dimColor>等待权限…</Text>
        </Box>}
      <PromptInputStashNotice hasStash={stashedPrompt !== undefined} />
      {swarmBanner ? <>
          <Text color={swarmBanner.bgColor}>
            {swarmBanner.text ? <>
                {'─'.repeat(Math.max(0, columns - stringWidth(swarmBanner.text) - 4))}
                <Text backgroundColor={swarmBanner.bgColor} color="inverseText">
                  {' '}
                  {swarmBanner.text}{' '}
                </Text>
                {'──'}
              </> : '─'.repeat(columns)}
          </Text>
          <Box flexDirection="row" width="100%">
            <PromptInputModeIndicator mode={mode} isLoading={isLoading} viewingAgentName={viewingAgentName} viewingAgentColor={viewingAgentColor} />
            <Box flexGrow={1} flexShrink={1} onClick={handleInputClick}>
              {textInputElement}
            </Box>
          </Box>
          <Text color={swarmBanner.bgColor}>{'─'.repeat(columns)}</Text>
        </> : <Box flexDirection="row" alignItems="flex-start" justifyContent="flex-start" borderColor={getBorderColor()} borderStyle="round" borderLeft={false} borderRight={false} borderBottom width="100%" borderText={buildBorderText(showFastIcon ?? false, showFastIconHint, fastModeCooldown)}>
          <PromptInputModeIndicator mode={mode} isLoading={isLoading} viewingAgentName={viewingAgentName} viewingAgentColor={viewingAgentColor} />
          <Box flexGrow={1} flexShrink={1} onClick={handleInputClick}>
            {textInputElement}
          </Box>
        </Box>}
      <PromptInputFooter apiKeyStatus={apiKeyStatus} debug={debug} exitMessage={exitMessage} vimMode={isVimModeEnabled() ? vimMode : undefined} mode={mode} autoUpdaterResult={autoUpdaterResult} isAutoUpdating={isAutoUpdating} verbose={verbose} onAutoUpdaterResult={onAutoUpdaterResult} onChangeIsUpdating={setIsAutoUpdating} suggestions={suggestions} selectedSuggestion={selectedSuggestion} maxColumnWidth={maxColumnWidth} toolPermissionContext={effectiveToolPermissionContext} helpOpen={helpOpen} suppressHint={input.length > 0} isLoading={isLoading} tasksSelected={tasksSelected} teamsSelected={teamsSelected} bridgeSelected={bridgeSelected} tmuxSelected={tmuxSelected} teammateFooterIndex={teammateFooterIndex} ideSelection={ideSelection} mcpClients={mcpClients} isPasting={isPasting} isInputWrapped={isInputWrapped} messages={messages} isSearching={isSearchingHistory} historyQuery={historyQuery} setHistoryQuery={setHistoryQuery} historyFailedMatch={historyFailedMatch} onOpenTasksDialog={isFullscreenEnvEnabled() ? handleOpenTasksDialog : undefined} />
      {isFullscreenEnvEnabled() ? null : autoModeOptInDialog}
      {isFullscreenEnvEnabled() ?
    // position=absolute 占用零布局高度，使通知出现/消失时
    // spinner 不会移位。Yoga 将绝对定位的子元素锚定在父元素的
    // content-box 原点；marginTop=-1 把它拉进提示边框上方的
    // marginTop=1 间隙行。在 brief 模式下没有该间隙（briefOwnsGap
    // 会移除我们的 marginTop），BriefSpinner 紧贴边框——
    // marginTop=-2 会跳过 spinner 内容进入
    // BriefSpinner 自身的 marginTop=1 空行。height=1 +
    // overflow=hidden 会把多行通知裁剪为单行。
    // flex-end 锚定底部行，使可见行始终是最新的。在斜杠覆盖层或
    // 自动模式选择加入对话框弹出期间，通过 height=0（非卸载）抑制——
    // 该 Box 在树序中渲染得更晚，因此会覆盖到它们的底部行。
    // 保持 Notifications 挂载可防止 AutoUpdater 的
    // initial-check 副作用在每次斜杠补全切换时重新触发
    //（PR#22413）。
    <Box position="absolute" marginTop={briefOwnsGap ? -2 : -1} height={suggestions.length === 0 && !showAutoModeOptIn ? 1 : 0} width="100%" paddingLeft={2} paddingRight={1} flexDirection="column" justifyContent="flex-end" overflow="hidden">
          <Notifications apiKeyStatus={apiKeyStatus} autoUpdaterResult={autoUpdaterResult} debug={debug} isAutoUpdating={isAutoUpdating} verbose={verbose} messages={messages} onAutoUpdaterResult={onAutoUpdaterResult} onChangeIsUpdating={setIsAutoUpdating} ideSelection={ideSelection} mcpClients={mcpClients} isInputWrapped={isInputWrapped} />
        </Box> : null}
    </Box>;
}

/**
 * 计算初始粘贴 ID——通过查找现有消息中使用的最大 ID 得到。
 * 处理 --continue/--resume 场景，此时我们需要避免 ID 冲突。
 */
function getInitialPasteId(messages: Message[]): number {
  let maxId = 0;
  for (const message of messages) {
    if (message.type === 'user') {
      // 检查图片粘贴 ID
      if (message.imagePasteIds) {
        for (const id of message.imagePasteIds) {
          if (id > maxId) maxId = id;
        }
      }
      // 检查消息内容中的文本粘贴引用
      if (Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            const refs = parseReferences(block.text);
            for (const ref of refs) {
              if (ref.id > maxId) maxId = ref.id;
            }
          }
        }
      }
    }
  }
  return maxId + 1;
}
function buildBorderText(showFastIcon: boolean, showFastIconHint: boolean, fastModeCooldown: boolean): BorderTextOptions | undefined {
  if (!showFastIcon) return undefined;
  const fastSeg = showFastIconHint ? `${getFastIconString(true, fastModeCooldown)} ${chalk.dim('/fast')}` : getFastIconString(true, fastModeCooldown);
  return {
    content: ` ${fastSeg} `,
    position: 'top',
    align: 'end',
    offset: 0
  };
}
export default React.memo(PromptInput);