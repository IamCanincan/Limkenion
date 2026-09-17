import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { env } from '../../utils/env.js';
export type ClawdPose = 'default' | 'arms-up' // both arms raised (used during jump)
| 'look-left' // both pupils shifted left
| 'look-right'; // both pupils shifted right

type Props = {
  pose?: ClawdPose;
};

// Limkenion 吉祥物 logo：一个「实心圆内嵌 L」的像素标徽，用 block-character
// 绘制，共 9 列。4 种 pose 共用同一图形（引用名/状态机保持不动以兼容上层
// 调用）。圆用宵粉色的噪音体实心填满，L 以「左竖列 + 底横」的正形呈现，
// 圆体内侧用背景色镂空一块作为 L 的负形。
//
// Row1 是圆顶（实心），Row2 是躯干带（左竖列 + 镂空缺口），Row3（Clawd
// 底部硬编码处）是闭合圆的 L 底横。
type Segments = {
  /** row 1 left (no bg): 圆顶左段 */
  r1L: string;
  /** row 1 middle (with bg): 圆顶中段 */
  r1E: string;
  /** row 1 right (no bg): 圆顶右段 */
  r1R: string;
  /** row 2 left (no bg): L 左竖列 */
  r2L: string;
  /** row 2 right (no bg): 圆体右缘 */
  r2R: string;
};
const POSES: Record<ClawdPose, Segments> = {
  default: {
    r1L: '██',
    r1E: '█████',
    r1R: '██',
    r2L: '███',
    r2R: '██'
  },
  'look-left': {
    r1L: '██',
    r1E: '█████',
    r1R: '██',
    r2L: '███',
    r2R: '██'
  },
  'look-right': {
    r1L: '██',
    r1E: '█████',
    r1R: '██',
    r2L: '███',
    r2R: '██'
  },
  'arms-up': {
    r1L: '██',
    r1E: '█████',
    r1R: '██',
    r2L: '███',
    r2R: '██'
  }
};

// Apple Terminal 用背景填充技巧（见下），因此中段这里同样取实心圆；每个
// pose 视觉一致（同一 Limkenion 吉祥物 logo）。
const APPLE_EYES: Record<ClawdPose, string> = {
  default: '     ',
  'look-left': '     ',
  'look-right': '     ',
  'arms-up': '     '
};
export function Clawd(t0) {
  const $ = _c(26);
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
  if (env.terminal === "Apple_Terminal") {
    let t3;
    if ($[2] !== pose) {
      t3 = <AppleTerminalClawd pose={pose} />;
      $[2] = pose;
      $[3] = t3;
    } else {
      t3 = $[3];
    }
    return t3;
  }
  const p = POSES[pose];
  let t3;
  if ($[4] !== p.r1L) {
    t3 = <Text color="clawd_body">{p.r1L}</Text>;
    $[4] = p.r1L;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] !== p.r1E) {
    t4 = <Text color="clawd_body" backgroundColor="clawd_background">{p.r1E}</Text>;
    $[6] = p.r1E;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  if ($[8] !== p.r1R) {
    t5 = <Text color="clawd_body">{p.r1R}</Text>;
    $[8] = p.r1R;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  let t6;
  if ($[10] !== t3 || $[11] !== t4 || $[12] !== t5) {
    t6 = <Text>{t3}{t4}{t5}</Text>;
    $[10] = t3;
    $[11] = t4;
    $[12] = t5;
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  let t7;
  if ($[14] !== p.r2L) {
    t7 = <Text color="clawd_body">{p.r2L}</Text>;
    $[14] = p.r2L;
    $[15] = t7;
  } else {
    t7 = $[15];
  }
  let t8;
  if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
    t8 = <Text color="clawd_body" backgroundColor="clawd_background">{"    "}</Text>;
    $[16] = t8;
  } else {
    t8 = $[16];
  }
  let t9;
  if ($[17] !== p.r2R) {
    t9 = <Text color="clawd_body">{p.r2R}</Text>;
    $[17] = p.r2R;
    $[18] = t9;
  } else {
    t9 = $[18];
  }
  let t10;
  if ($[19] !== t7 || $[20] !== t9) {
    t10 = <Text>{t7}{t8}{t9}</Text>;
    $[19] = t7;
    $[20] = t9;
    $[21] = t10;
  } else {
    t10 = $[21];
  }
  let t11;
  if ($[22] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = <Text color="clawd_body">{" "}█████████{" "}</Text>;
    $[22] = t11;
  } else {
    t11 = $[22];
  }
  let t12;
  if ($[23] !== t10 || $[24] !== t6) {
    t12 = <Box flexDirection="column">{t6}{t10}{t11}</Box>;
    $[23] = t10;
    $[24] = t6;
    $[25] = t12;
  } else {
    t12 = $[25];
  }
  return t12;
}
function AppleTerminalClawd(t0) {
  const $ = _c(10);
  const {
    pose
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Text color="clawd_body">▗</Text>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const t2 = APPLE_EYES[pose];
  let t3;
  if ($[1] !== t2) {
    t3 = <Text color="clawd_background" backgroundColor="clawd_body">{t2}</Text>;
    $[1] = t2;
    $[2] = t3;
  } else {
    t3 = $[2];
  }
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Text color="clawd_body">▖</Text>;
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  let t5;
  if ($[4] !== t3) {
    t5 = <Text>{t1}{t3}{t4}</Text>;
    $[4] = t3;
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  let t6;
  let t7;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Text backgroundColor="clawd_body">{" ".repeat(7)}</Text>;
    t7 = <Text color="clawd_body">▗▀▀▀▀▀▖</Text>;
    $[6] = t6;
    $[7] = t7;
  } else {
    t6 = $[6];
    t7 = $[7];
  }
  let t8;
  if ($[8] !== t5) {
    t8 = <Box flexDirection="column" alignItems="center">{t5}{t6}{t7}</Box>;
    $[8] = t5;
    $[9] = t8;
  } else {
    t8 = $[9];
  }
  return t8;
}