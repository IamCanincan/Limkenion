import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Link, Text } from '../ink.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';

// 注意：以下文案已经法律审核——未经法务团队批准请勿修改。
export const AUTO_MODE_DESCRIPTION = "自动模式让 Limkenion 自动处理权限提示——在每次工具调用前，Limkenion 会检查是否存在危险操作和提示注入。Limkenion 判断为安全的操作会直接执行，而被判断为危险的操作会被拦截，Limkenion 可能会尝试其它方案。适合长时间运行的任务。会话成本略高。Limkenion 可能犯错，导致有害命令被执行，建议仅在隔离环境中使用。按 Shift+Tab 切换模式。";
type Props = {
  onAccept(): void;
  onDecline(): void;
  // 启动把关：拒绝将退出进程，因此相应调整按钮文案。
  declineExits?: boolean;
};
export function AutoModeOptInDialog(t0) {
  const $ = _c(18);
  const {
    onAccept,
    onDecline,
    declineExits
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  React.useEffect(_temp, t1);
  let t2;
  if ($[1] !== onAccept || $[2] !== onDecline) {
    t2 = function onChange(value) {
      bb3: switch (value) {
        case "accept":
          {
            logEvent("limkenion_auto_mode_opt_in_dialog_accept", {});
            updateSettingsForSource("userSettings", {
              skipAutoPermissionPrompt: true
            });
            onAccept();
            break bb3;
          }
        case "accept-default":
          {
            logEvent("limkenion_auto_mode_opt_in_dialog_accept_default", {});
            updateSettingsForSource("userSettings", {
              skipAutoPermissionPrompt: true,
              permissions: {
                defaultMode: "auto"
              }
            });
            onAccept();
            break bb3;
          }
        case "decline":
          {
            logEvent("limkenion_auto_mode_opt_in_dialog_decline", {});
            onDecline();
          }
      }
    };
    $[1] = onAccept;
    $[2] = onDecline;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const onChange = t2;
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box flexDirection="column" gap={1}><Text>{AUTO_MODE_DESCRIPTION}</Text></Box>;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = true ? [{
      label: "是，并设为我的默认模式",
      value: "accept-default" as const
    }] : [];
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  let t5;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      label: "是，启用自动模式",
      value: "accept" as const
    };
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  const t6 = declineExits ? "否，退出" : "否，返回";
  let t7;
  if ($[7] !== t6) {
    t7 = [...t4, t5, {
      label: t6,
      value: "decline" as const
    }];
    $[7] = t6;
    $[8] = t7;
  } else {
    t7 = $[8];
  }
  let t8;
  if ($[9] !== onChange) {
    t8 = value_0 => onChange(value_0 as 'accept' | 'accept-default' | 'decline');
    $[9] = onChange;
    $[10] = t8;
  } else {
    t8 = $[10];
  }
  let t9;
  if ($[11] !== onDecline || $[12] !== t7 || $[13] !== t8) {
    t9 = <Select options={t7} onChange={t8} onCancel={onDecline} />;
    $[11] = onDecline;
    $[12] = t7;
    $[13] = t8;
    $[14] = t9;
  } else {
    t9 = $[14];
  }
  let t10;
  if ($[15] !== onDecline || $[16] !== t9) {
    t10 = <Dialog title="是否启用自动模式？" color="warning" onCancel={onDecline}>{t3}{t9}</Dialog>;
    $[15] = onDecline;
    $[16] = t9;
    $[17] = t10;
  } else {
    t10 = $[17];
  }
  return t10;
}
function _temp() {
  logEvent("limkenion_auto_mode_opt_in_dialog_shown", {});
}