import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
export type ClawdPose = 'default' | 'arms-up' // both arms raised (used during jump)
| 'look-left' // both pupils shifted left
| 'look-right'; // both pupils shifted right

type Props = {
  pose?: ClawdPose;
};

// Limkenion 吉祥物 logo：单独一个「樱粉实心 L」，是品牌的统一图标。
// 用 block-character 绘制，4 种 pose 共用同一图形（引用名/状态机保持不动
// 以兼容上层调用）。左竖 + 底横构成大写 L，无顶部横条，避免像「口」字框。
const RING_AND_L = [
  '██',
  '██',
  '██',
  '██████',
];
export function Clawd(t0) {
  const $ = _c(4);
  let t1;
  if ($[0] !== t0) {
    t1 = t0 === undefined ? {} : t0;
    $[0] = t0;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const {
    pose: t2
  } = t1;
  const pose = t2 === undefined ? "default" : t2;
  void pose; // 4 种 pose 视觉一致（同一 Limkenion 吉祥物 logo），仅为兼容上层调用而接收
  let t3;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box flexDirection="column">{RING_AND_L.map(row => <Text color="clawd_body">{row}</Text>)}</Box>;
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  return t3;
}