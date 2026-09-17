import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Text } from '../ink.js';
import type { ValidationError } from '../utils/settings/validation.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { ValidationErrorsList } from './ValidationErrorsList.js';
type Props = {
  settingsErrors: ValidationError[];
  onContinue: () => void;
  onExit: () => void;
};

/**
 * 当配置文件存在校验错误时显示的对话框。
 * 用户必须选择继续（跳过无效文件）或退出以修复它们。
 */
export function InvalidSettingsDialog(t0) {
  const $ = _c(13);
  const {
    settingsErrors,
    onContinue,
    onExit
  } = t0;
  let t1;
  if ($[0] !== onContinue || $[1] !== onExit) {
    t1 = function handleSelect(value) {
      if (value === "exit") {
        onExit();
      } else {
        onContinue();
      }
    };
    $[0] = onContinue;
    $[1] = onExit;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const handleSelect = t1;
  let t2;
  if ($[3] !== settingsErrors) {
    t2 = <ValidationErrorsList errors={settingsErrors} />;
    $[3] = settingsErrors;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  let t3;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text dimColor={true}>带有错误的文件会被整体跳过，而不仅仅是无效的配置。</Text>;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = [{
      label: "退出并手动修复",
      value: "exit"
    }, {
      label: "不带这些配置继续",
      value: "continue"
    }];
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== handleSelect) {
    t5 = <Select options={t4} onChange={handleSelect} />;
    $[7] = handleSelect;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  if ($[9] !== onExit || $[10] !== t2 || $[11] !== t5) {
    t6 = <Dialog title="配置错误" onCancel={onExit} color="warning">{t2}{t3}{t5}</Dialog>;
    $[9] = onExit;
    $[10] = t2;
    $[11] = t5;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  return t6;
}