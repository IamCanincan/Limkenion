import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useCallback, useState } from 'react';
import { useDoublePress } from '../hooks/useDoublePress.js';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import { backgroundAll, hasForegroundTasks } from '../tasks/LocalShellTask/LocalShellTask.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { env } from '../utils/env.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
type Props = {
  onBackgroundSession: () => void;
  isLoading: boolean;
};

/**
 * 当用户按 Ctrl+B 将当前会话放到后台时显示提示。
 * 采用双击模式：第一次按下显示提示，800ms 内的第二次按下真正放到后台。
 *
 * 仅在以下情况下激活：
 * 1. isLoading 为 true（有查询正在进行）
 * 2. 没有前台任务（bash/agent）正在运行（它们优先占用 Ctrl+B）
 */
export function SessionBackgroundHint(t0) {
  const $ = _c(10);
  const {
    onBackgroundSession,
    isLoading
  } = t0;
  const setAppState = useSetAppState();
  const appStateStore = useAppStateStore();
  const [showSessionHint, setShowSessionHint] = useState(false);
  const handleDoublePress = useDoublePress(setShowSessionHint, onBackgroundSession, _temp);
  let t1;
  if ($[0] !== appStateStore || $[1] !== handleDoublePress || $[2] !== isLoading || $[3] !== setAppState) {
    t1 = () => {
      if (isEnvTruthy(process.env.LIMKENION_DISABLE_BACKGROUND_TASKS)) {
        return;
      }
      const state = appStateStore.getState();
      if (hasForegroundTasks(state)) {
        backgroundAll(() => appStateStore.getState(), setAppState);
        if (!getGlobalConfig().hasUsedBackgroundTask) {
          saveGlobalConfig(_temp2);
        }
      } else {
        if (isEnvTruthy("false") && isLoading) {
          handleDoublePress();
        }
      }
    };
    $[0] = appStateStore;
    $[1] = handleDoublePress;
    $[2] = isLoading;
    $[3] = setAppState;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const handleBackground = t1;
  const hasForeground = useAppState(hasForegroundTasks);
  let t2;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = isEnvTruthy("false");
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const sessionBgEnabled = t2;
  const t3 = hasForeground || sessionBgEnabled && isLoading;
  let t4;
  if ($[6] !== t3) {
    t4 = {
      context: "Task",
      isActive: t3
    };
    $[6] = t3;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  useKeybinding("task:background", handleBackground, t4);
  const baseShortcut = useShortcutDisplay("task:background", "Task", "ctrl+b");
  const shortcut = env.terminal === "tmux" && baseShortcut === "ctrl+b" ? "ctrl+b ctrl+b" : baseShortcut;
  if (!isLoading || !showSessionHint) {
    return null;
  }
  let t5;
  if ($[8] !== shortcut) {
    t5 = <Box paddingLeft={2}><Text dimColor={true}><KeyboardShortcutHint shortcut={shortcut} action="后台" /></Text></Box>;
    $[8] = shortcut;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
function _temp2(c) {
  return c.hasUsedBackgroundTask ? c : {
    ...c,
    hasUsedBackgroundTask: true
  };
}
function _temp() {}