import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Box, Text } from '../../ink.js';
import { Spinner } from '../Spinner.js';
type LoadingStateProps = {
  /**
   * 显示在加载动画旁边的加载提示。
   */
  message: string;

  /**
   * 以粗体显示提示。
   * @default false
   */
  bold?: boolean;

  /**
   * 以暗色显示提示。
   * @default false
   */
  dimColor?: boolean;

  /**
   * 显示在主提示下方的可选副标题。
   */
  subtitle?: string;
};

/**
 * 用于异步操作的带加载提示的加载动画。
 *
 * @example
 * // 基础加载
 * <LoadingState message="加载中..." />
 *
 * @example
 * // 加粗的加载提示
 * <LoadingState message="加载会话" bold />
 *
 * @example
 * // 带副标题
 * <LoadingState
 *   message="加载会话"
 *   bold
 *   subtitle="正在获取你的 Limkenion 会话..."
 * />
 */
export function LoadingState(t0) {
  const $ = _c(10);
  const {
    message,
    bold: t1,
    dimColor: t2,
    subtitle
  } = t0;
  const bold = t1 === undefined ? false : t1;
  const dimColor = t2 === undefined ? false : t2;
  let t3;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Spinner />;
    $[0] = t3;
  } else {
    t3 = $[0];
  }
  let t4;
  if ($[1] !== bold || $[2] !== dimColor || $[3] !== message) {
    t4 = <Box flexDirection="row">{t3}<Text bold={bold} dimColor={dimColor}>{" "}{message}</Text></Box>;
    $[1] = bold;
    $[2] = dimColor;
    $[3] = message;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  let t5;
  if ($[5] !== subtitle) {
    t5 = subtitle && <Text dimColor={true}>{subtitle}</Text>;
    $[5] = subtitle;
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  let t6;
  if ($[7] !== t4 || $[8] !== t5) {
    t6 = <Box flexDirection="column">{t4}{t5}</Box>;
    $[7] = t4;
    $[8] = t5;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  return t6;
}