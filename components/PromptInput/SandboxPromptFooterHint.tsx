import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Box, Text } from '../../ink.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
export function SandboxPromptFooterHint() {
  const $ = _c(6);
  const [recentViolationCount, setRecentViolationCount] = useState(0);
  const timerRef = useRef(null);
  const detailsShortcut = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  let t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = () => {
      if (!SandboxManager.isSandboxingEnabled()) {
        return;
      }
      const store = SandboxManager.getSandboxViolationStore();
      let lastCount = store.getTotalCount();
      const unsubscribe = store.subscribe(() => {
        const currentCount = store.getTotalCount();
        const newViolations = currentCount - lastCount;
        if (newViolations > 0) {
          setRecentViolationCount(newViolations);
          lastCount = currentCount;
          if (timerRef.current) {
            clearTimeout(timerRef.current);
          }
          timerRef.current = setTimeout(setRecentViolationCount, 5000, 0);
        }
      });
      return () => {
        unsubscribe();
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
      };
    };
    t1 = [];
    $[0] = t0;
    $[1] = t1;
  } else {
    t0 = $[0];
    t1 = $[1];
  }
  useEffect(t0, t1);
  if (!SandboxManager.isSandboxingEnabled() || recentViolationCount === 0) {
    return null;
  }
  const t2 = recentViolationCount === 1 ? "次操作" : "次操作";
  let t3;
  if ($[2] !== detailsShortcut || $[3] !== recentViolationCount || $[4] !== t2) {
    t3 = <Box paddingX={0} paddingY={0}><Text color="inactive" wrap="truncate">⧈ 沙箱已拦截 {recentViolationCount}{" "}{t2} ·{" "}{detailsShortcut} 查看详情 · /sandbox 禁用</Text></Box>;
    $[2] = detailsShortcut;
    $[3] = recentViolationCount;
    $[4] = t2;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  return t3;
}