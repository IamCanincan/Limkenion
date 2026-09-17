import { c as _c } from "react/compiler-runtime";
import React from 'react';
import Text from '../../ink/components/Text.js';
type Props = {
  /** 要显示的按键或和弦键（例如 "ctrl+o"、"Enter"、"↑/↓"） */
  shortcut: string;
  /** 该按键执行的动作（例如 "expand"、"select"、"navigate"） */
  action: string;
  /** 是否用括号包裹提示。默认：false */
  parens?: boolean;
  /** 是否以粗体渲染快捷键。默认：false */
  bold?: boolean;
};

/**
 * 渲染快捷键提示，例如 "ctrl+o to expand" 或 "(tab to toggle)"
 *
 * 用 <Text dimColor> 包裹可获得常见的暗色样式。
 *
 * @example
 * // 简单的提示，包裹在暗色 Text 中
 * <Text dimColor><KeyboardShortcutHint shortcut="esc" action="cancel" /></Text>
 *
 * // 带括号："(ctrl+o to expand)"
 * <Text dimColor><KeyboardShortcutHint shortcut="ctrl+o" action="expand" parens /></Text>
 *
 * // 快捷键加粗："Enter to confirm"（Enter 加粗）
 * <Text dimColor><KeyboardShortcutHint shortcut="Enter" action="confirm" bold /></Text>
 *
 * // 用中点分隔符连接多个提示——使用 Byline
 * <Text dimColor>
 *   <Byline>
 *     <KeyboardShortcutHint shortcut="Enter" action="confirm" />
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 */
export function KeyboardShortcutHint(t0) {
  const $ = _c(9);
  const {
    shortcut,
    action,
    parens: t1,
    bold: t2
  } = t0;
  const parens = t1 === undefined ? false : t1;
  const bold = t2 === undefined ? false : t2;
  let t3;
  if ($[0] !== bold || $[1] !== shortcut) {
    t3 = bold ? <Text bold={true}>{shortcut}</Text> : shortcut;
    $[0] = bold;
    $[1] = shortcut;
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  const shortcutText = t3;
  if (parens) {
    let t4;
    if ($[3] !== action || $[4] !== shortcutText) {
      t4 = <Text>({shortcutText} 用于 {action})</Text>;
      $[3] = action;
      $[4] = shortcutText;
      $[5] = t4;
    } else {
      t4 = $[5];
    }
    return t4;
  }
  let t4;
  if ($[6] !== action || $[7] !== shortcutText) {
    t4 = <Text>{shortcutText} 用于 {action}</Text>;
    $[6] = action;
    $[7] = shortcutText;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  return t4;
}