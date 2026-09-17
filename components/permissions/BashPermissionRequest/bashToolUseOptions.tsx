import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js';
import { extractOutputRedirections } from '../../../utils/bash/commands.js';
import { isClassifierPermissionsEnabled } from '../../../utils/permissions/bashClassifier.js';
import type { PermissionDecisionReason } from '../../../utils/permissions/PermissionResult.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js';
export type BashToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-prefix-edited' | 'yes-classifier-reviewed' | 'no';

/**
 * 检查描述是否已存在于允许列表中。
 * 会比较小写并去除尾部空白后的版本。
 */
function descriptionAlreadyExists(description: string, existingDescriptions: string[]): boolean {
  const normalized = description.toLowerCase().trimEnd();
  return existingDescriptions.some(existing => existing.toLowerCase().trimEnd() === normalized);
}

/**
 * 去除输出重定向，以便文件名不会以命令的形式出现在标签中。
 */
function stripBashRedirections(command: string): string {
  const {
    commandWithoutRedirections,
    redirections
  } = extractOutputRedirections(command);
  // 只有实际存在重定向时才使用去除后的版本
  return redirections.length > 0 ? commandWithoutRedirections : command;
}
export function bashToolUseOptions({
  suggestions = [],
  decisionReason,
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  onClassifierDescriptionChange,
  classifierDescription,
  initialClassifierDescriptionEmpty = false,
  existingAllowDescriptions = [],
  yesInputMode = false,
  noInputMode = false,
  editablePrefix,
  onEditablePrefixChange
}: {
  suggestions?: PermissionUpdate[];
  decisionReason?: PermissionDecisionReason;
  onRejectFeedbackChange: (value: string) => void;
  onAcceptFeedbackChange: (value: string) => void;
  onClassifierDescriptionChange?: (value: string) => void;
  classifierDescription?: string;
  /** 初始分类器描述是否为空。若为 true，则隐藏该选项。 */
  initialClassifierDescriptionEmpty?: boolean;
  existingAllowDescriptions?: string[];
  yesInputMode?: boolean;
  noInputMode?: boolean;
  /** 可编辑的前缀规则内容（例如 "npm run:*"）。设置后会替换 Haiku 生成的建议。 */
  editablePrefix?: string;
  /** 用户编辑前缀值时的回调。 */
  onEditablePrefixChange?: (value: string) => void;
}): OptionWithDescription<BashToolUseOption>[] {
  const options: OptionWithDescription<BashToolUseOption>[] = [];
  if (yesInputMode) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      placeholder: '并告诉 Limkenion 下一步要做什么',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true
    });
  } else {
    options.push({
      label: 'Yes',
      value: 'yes'
    });
  }

  // 仅当未被 allowManagedPermissionRulesOnly 限制时才显示"始终允许"选项
  if (shouldShowAlwaysAllowOptions()) {
    // 为前缀规则显示可编辑输入，而不是 Haiku 生成的建议标签——
    // 但仅当建议不包含可编辑前缀无法表示的非 Bash 项目
    //（addDirectories、Read 规则）时才这样做。
    const hasNonBashSuggestions = suggestions.some(s => s.type === 'addDirectories' || s.type === 'addRules' && s.rules?.some(r => r.toolName !== BASH_TOOL_NAME));
    if (editablePrefix !== undefined && onEditablePrefixChange && !hasNonBashSuggestions && suggestions.length > 0) {
      options.push({
        type: 'input',
        label: '是，且不再询问',
        value: 'yes-prefix-edited',
        placeholder: '命令前缀（例如 npm run:*）',
        initialValue: editablePrefix,
        onChange: onEditablePrefixChange,
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true
      });
    } else if (suggestions.length > 0) {
      const label = generateShellSuggestionsLabel(suggestions, BASH_TOOL_NAME, stripBashRedirections);
      if (label) {
        options.push({
          label,
          value: 'yes-apply-suggestions'
        });
      }
    }

    // 如果启用、初始描述非空、描述尚不存在于允许列表中，
    // 且决策原因不是服务端分类器拦截时，才添加"经分类器审核"选项
    //（当服务端分类器先触发时，基于提示的规则没有帮助）。
    // 当可编辑前缀选项已显示时跳过——它们起相同作用，
    // 有两个外观相同的"不再询问"输入会令人困惑。
    const editablePrefixShown = options.some(o => o.value === 'yes-prefix-edited');
    
  }
  if (noInputMode) {
    options.push({
      type: 'input',
      label: 'No',
      value: 'no',
      placeholder: '并告诉 Limkenion 应该怎样做不同',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true
    });
  } else {
    options.push({
      label: 'No',
      value: 'no'
    });
  }
  return options;
}