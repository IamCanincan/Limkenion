import { c as _c } from "react/compiler-runtime";
/**
 * 将 KeybindingProvider 集成到应用中的设置工具。
 *
 * 本文件提供绑定以及一个组合好的 provider，可添加到
 * 应用的组件树中。它会从 ~/.limkenion/keybindings.json 加载
 * 默认绑定和用户自定义绑定，并在文件变化时
 * 支持热重载。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNotifications } from '../context/notifications.js';
import type { InputEvent } from '../ink/events/input-event.js';
// ChordInterceptor 有意使用 useInput 在其他处理器之前拦截所有按键 ——
// 这是支持组合键序列所必需的
// eslint-disable-next-line custom-rules/prefer-use-keybindings
import { type Key, useInput } from '../ink.js';
import { count } from '../utils/array.js';
import { logForDebugging } from '../utils/debug.js';
import { plural } from '../utils/stringUtils.js';
import { KeybindingProvider } from './KeybindingContext.js';
import { initializeKeybindingWatcher, type KeybindingsLoadResult, loadKeybindingsSyncWithWarnings, subscribeToKeybindingChanges } from './loadUserBindings.js';
import { resolveKeyWithChordState } from './resolver.js';
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js';
import type { KeybindingWarning } from './validate.js';

/**
 * 组合键序列的超时时间（毫秒）。
 * 如果用户未在此时间内完成组合键，则取消。
 */
const CHORD_TIMEOUT_MS = 1000;
type Props = {
  children: React.ReactNode;
};

/**
 * 键位绑定 provider，包含默认绑定 + 用户绑定，并支持热重载。
 *
 * 用法：用该 provider 包裹你的应用即可启用键位绑定支持。
 *
 * ```tsx
 * <AppStateProvider>
 *   <KeybindingSetup>
 *     <REPL ... />
 *   </KeybindingSetup>
 * </AppStateProvider>
 * ```
 *
 * 特性：
 * - 从代码中加载默认绑定
 * - 与 ~/.limkenion/keybindings.json 中的用户绑定合并
 * - 监听文件变化并自动重新加载（热重载）
 * - 用户绑定覆盖默认绑定（靠后的条目胜出）
 * - 支持组合键并带自动超时
 */
/**
 * 通过通知向用户显示键位绑定警告。
 * 显示一条简短消息，指向 /doctor 查看详情。
 */
function useKeybindingWarnings(warnings, isReload) {
  const $ = _c(9);
  const {
    addNotification,
    removeNotification
  } = useNotifications();
  let t0;
  if ($[0] !== addNotification || $[1] !== removeNotification || $[2] !== warnings) {
    t0 = () => {
      if (warnings.length === 0) {
        removeNotification("keybinding-config-warning");
        return;
      }
      const errorCount = count(warnings, _temp);
      const warnCount = count(warnings, _temp2);
      let message;
      if (errorCount > 0 && warnCount > 0) {
        message = `Found ${errorCount} keybinding ${plural(errorCount, "error")} and ${warnCount} ${plural(warnCount, "warning")}`;
      } else {
        if (errorCount > 0) {
          message = `Found ${errorCount} keybinding ${plural(errorCount, "error")}`;
        } else {
          message = `Found ${warnCount} keybinding ${plural(warnCount, "warning")}`;
        }
      }
      message = message + " \xB7 /doctor for details";
      addNotification({
        key: "keybinding-config-warning",
        text: message,
        color: errorCount > 0 ? "error" : "warning",
        priority: errorCount > 0 ? "immediate" : "high",
        timeoutMs: 60000
      });
    };
    $[0] = addNotification;
    $[1] = removeNotification;
    $[2] = warnings;
    $[3] = t0;
  } else {
    t0 = $[3];
  }
  let t1;
  if ($[4] !== addNotification || $[5] !== isReload || $[6] !== removeNotification || $[7] !== warnings) {
    t1 = [warnings, isReload, addNotification, removeNotification];
    $[4] = addNotification;
    $[5] = isReload;
    $[6] = removeNotification;
    $[7] = warnings;
    $[8] = t1;
  } else {
    t1 = $[8];
  }
  useEffect(t0, t1);
}
function _temp2(w_0) {
  return w_0.severity === "warning";
}
function _temp(w) {
  return w.severity === "error";
}
export function KeybindingSetup({
  children
}: Props): React.ReactNode {
  // 为首次渲染同步加载绑定
  const [{
    bindings,
    warnings
  }, setLoadResult] = useState<KeybindingsLoadResult>(() => {
    const result = loadKeybindingsSyncWithWarnings();
    logForDebugging(`[keybindings] KeybindingSetup initialized with ${result.bindings.length} bindings, ${result.warnings.length} warnings`);
    return result;
  });

  // 记录这是否是一次重新加载（而非初次加载）
  const [isReload, setIsReload] = useState(false);

  // 通过通知显示警告
  useKeybindingWarnings(warnings, isReload);

  // 组合键状态管理 —— 用 ref 实现即时访问，用 state 触发重新渲染
  // ref 供 resolve() 使用，以便无需等待重新渲染即可取得当前值
  // state 用于在需要时（例如 UI 更新）触发重新渲染
  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null);
  const [pendingChord, setPendingChordState] = useState<ParsedKeystroke[] | null>(null);
  const chordTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 动作回调的处理器注册表（由 ChordInterceptor 用于调用处理器）
  const handlerRegistryRef = useRef(new Map<string, Set<{
    action: string;
    context: KeybindingContextName;
    handler: () => void;
  }>>());

  // 用于键位绑定优先级解析的激活上下文跟踪
  // 使用 ref 而非 state 以实现同步更新 —— 输入处理器需要
  // 立即看到当前值，而不是等一个 React 渲染周期之后。
  const activeContextsRef = useRef<Set<KeybindingContextName>>(new Set());
  const registerActiveContext = useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.add(context);
  }, []);
  const unregisterActiveContext = useCallback((context_0: KeybindingContextName) => {
    activeContextsRef.current.delete(context_0);
  }, []);

  // 组件卸载或组合键变化时清除组合键超时
  const clearChordTimeout = useCallback(() => {
    if (chordTimeoutRef.current) {
      clearTimeout(chordTimeoutRef.current);
      chordTimeoutRef.current = null;
    }
  }, []);

  // setPendingChord 的包装，负责管理超时并同步 ref 与 state
  const setPendingChord = useCallback((pending: ParsedKeystroke[] | null) => {
    clearChordTimeout();
    if (pending !== null) {
      // 设置超时，若组合键未完成则取消
      chordTimeoutRef.current = setTimeout((pendingChordRef_0, setPendingChordState_0) => {
        logForDebugging('[keybindings] Chord timeout - cancelling');
        pendingChordRef_0.current = null;
        setPendingChordState_0(null);
      }, CHORD_TIMEOUT_MS, pendingChordRef, setPendingChordState);
    }

    // 立即更新 ref，以便在 resolve() 中同步访问
    pendingChordRef.current = pending;
    // 更新 state 以触发重新渲染，用于 UI 更新
    setPendingChordState(pending);
  }, [clearChordTimeout]);
  useEffect(() => {
    // 初始化文件监听器（幂等 —— 只运行一次）
    void initializeKeybindingWatcher();

    // 订阅变更
    const unsubscribe = subscribeToKeybindingChanges(result_0 => {
      // 任何回调调用都是一次重新加载，因为初次加载是在
      // useState 中同步发生的，而非通过此订阅
      setIsReload(true);
      setLoadResult(result_0);
      logForDebugging(`[keybindings] Reloaded: ${result_0.bindings.length} bindings, ${result_0.warnings.length} warnings`);
    });
    return () => {
      unsubscribe();
      clearChordTimeout();
    };
  }, [clearChordTimeout]);
  return <KeybindingProvider bindings={bindings} pendingChordRef={pendingChordRef} pendingChord={pendingChord} setPendingChord={setPendingChord} activeContexts={activeContextsRef.current} registerActiveContext={registerActiveContext} unregisterActiveContext={unregisterActiveContext} handlerRegistryRef={handlerRegistryRef}>
      <ChordInterceptor bindings={bindings} pendingChordRef={pendingChordRef} setPendingChord={setPendingChord} activeContexts={activeContextsRef.current} handlerRegistryRef={handlerRegistryRef} />
      {children}
    </KeybindingProvider>;
}

/**
 * 全局组合键拦截器，最先注册 useInput（在子组件之前）。
 *
 * 该组件拦截属于组合键序列的按键，并在其他处理器
 *（如 PromptInput）看到它们之前阻止传播。
 *
 * 没有它，组合键的第二个键（例如 “ctrl+c r” 中的 'r'）会被
 * PromptInput 捕获并加入输入框，而键位绑定系统
 * 还来不及将其识别为完成一个组合键。
 */
type HandlerRegistration = {
  action: string;
  context: KeybindingContextName;
  handler: () => void;
};
function ChordInterceptor(t0) {
  const $ = _c(6);
  const {
    bindings,
    pendingChordRef,
    setPendingChord,
    activeContexts,
    handlerRegistryRef
  } = t0;
  let t1;
  if ($[0] !== activeContexts || $[1] !== bindings || $[2] !== handlerRegistryRef || $[3] !== pendingChordRef || $[4] !== setPendingChord) {
    t1 = (input, key, event) => {
      if ((key.wheelUp || key.wheelDown) && pendingChordRef.current === null) {
        return;
      }
      const registry = handlerRegistryRef.current;
      const handlerContexts = new Set();
      if (registry) {
        for (const handlers of registry.values()) {
          for (const registration of handlers) {
            handlerContexts.add(registration.context);
          }
        }
      }
      const contexts = [...handlerContexts, ...activeContexts, "Global"];
      const wasInChord = pendingChordRef.current !== null;
      const result = resolveKeyWithChordState(input, key, contexts, bindings, pendingChordRef.current);
      bb23: switch (result.type) {
        case "chord_started":
          {
            setPendingChord(result.pending);
            event.stopImmediatePropagation();
            break bb23;
          }
        case "match":
          {
            setPendingChord(null);
            if (wasInChord) {
              const contextsSet = new Set(contexts);
              if (registry) {
                const handlers_0 = registry.get(result.action);
                if (handlers_0 && handlers_0.size > 0) {
                  for (const registration_0 of handlers_0) {
                    if (contextsSet.has(registration_0.context)) {
                      registration_0.handler();
                      event.stopImmediatePropagation();
                      break;
                    }
                  }
                }
              }
            }
            break bb23;
          }
        case "chord_cancelled":
          {
            setPendingChord(null);
            event.stopImmediatePropagation();
            break bb23;
          }
        case "unbound":
          {
            setPendingChord(null);
            event.stopImmediatePropagation();
            break bb23;
          }
        case "none":
      }
    };
    $[0] = activeContexts;
    $[1] = bindings;
    $[2] = handlerRegistryRef;
    $[3] = pendingChordRef;
    $[4] = setPendingChord;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  const handleInput = t1;
  useInput(handleInput);
  return null;
}