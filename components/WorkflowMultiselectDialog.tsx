import { c as _c } from "react/compiler-runtime";
import React, { useCallback, useState } from 'react';
import type { Workflow } from '../commands/install-github-app/types.js';
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Link, Text } from '../ink.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
type WorkflowOption = {
  value: Workflow;
  label: string;
};
type Props = {
  onSubmit: (selectedWorkflows: Workflow[]) => void;
  defaultSelections: Workflow[];
};
const WORKFLOWS: WorkflowOption[] = [{
  value: 'limkenion' as const,
  label: '@Limkenion - 在 issue 和 PR 评论中 @limkenion'
}, {
  value: 'limkenion-review' as const,
  label: 'Limkenion Review - 对新 PR 进行自动化代码审查'
}];
function renderInputGuide(exitState: ExitState): React.ReactNode {
  if (exitState.pending) {
    return <Text>再次按 {exitState.keyName} 退出</Text>;
  }
  return <Byline>
      <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
      <KeyboardShortcutHint shortcut="Space" action="toggle" />
      <KeyboardShortcutHint shortcut="Enter" action="confirm" />
      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
    </Byline>;
}
export function WorkflowMultiselectDialog(t0) {
  const $ = _c(14);
  const {
    onSubmit,
    defaultSelections
  } = t0;
  const [showError, setShowError] = useState(false);
  let t1;
  if ($[0] !== onSubmit) {
    t1 = selectedValues => {
      if (selectedValues.length === 0) {
        setShowError(true);
        return;
      }
      setShowError(false);
      onSubmit(selectedValues);
    };
    $[0] = onSubmit;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const handleSubmit = t1;
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      setShowError(false);
    };
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const handleChange = t2;
  let t3;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = () => {
      setShowError(true);
    };
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const handleCancel = t3;
  let t4;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Box><Text dimColor={true}>更多工作流示例（议题分类、CI 修复等）参见：{" "}<Link url="https://github.com/limkenions/limkenion-action/blob/main/examples/">https://github.com/limkenions/limkenion-action/blob/main/examples/</Link></Text></Box>;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  let t5;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = WORKFLOWS.map(_temp);
    $[5] = t5;
  } else {
    t5 = $[5];
  }
  let t6;
  if ($[6] !== defaultSelections || $[7] !== handleSubmit) {
    t6 = <SelectMulti options={t5} defaultValue={defaultSelections} onSubmit={handleSubmit} onChange={handleChange} onCancel={handleCancel} hideIndexes={true} />;
    $[6] = defaultSelections;
    $[7] = handleSubmit;
    $[8] = t6;
  } else {
    t6 = $[8];
  }
  let t7;
  if ($[9] !== showError) {
    t7 = showError && <Box><Text color="error">您必须至少选择一个工作流才能继续</Text></Box>;
    $[9] = showError;
    $[10] = t7;
  } else {
    t7 = $[10];
  }
  let t8;
  if ($[11] !== t6 || $[12] !== t7) {
    t8 = <Dialog title="选择要安装的 GitHub 工作流" subtitle="我们将为您选择的每个工作流在您的仓库中创建一个工作流文件。" onCancel={handleCancel} inputGuide={renderInputGuide}>{t4}{t6}{t7}</Dialog>;
    $[11] = t6;
    $[12] = t7;
    $[13] = t8;
  } else {
    t8 = $[13];
  }
  return t8;
}
function _temp(workflow) {
  return {
    label: workflow.label,
    value: workflow.value
  };
}