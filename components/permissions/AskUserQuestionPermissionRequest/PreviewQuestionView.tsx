import figures from 'figures';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js';
import { Box, Text } from '../../../ink.js';
import { useKeybinding, useKeybindings } from '../../../keybindings/useKeybinding.js';
import { useAppState } from '../../../state/AppState.js';
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { getExternalEditor } from '../../../utils/editor.js';
import { toIDEDisplayName } from '../../../utils/ide.js';
import { editPromptInEditor } from '../../../utils/promptEditor.js';
import { Divider } from '../../design-system/Divider.js';
import TextInput from '../../TextInput.js';
import { PermissionRequestTitle } from '../PermissionRequestTitle.js';
import { PreviewBox } from './PreviewBox.js';
import { QuestionNavigationBar } from './QuestionNavigationBar.js';
import type { QuestionState } from './use-multiple-choice-state.js';
type Props = {
  question: Question;
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  questionStates: Record<string, QuestionState>;
  hideSubmitTab?: boolean;
  minContentHeight?: number;
  minContentWidth?: number;
  onUpdateQuestionState: (questionText: string, updates: Partial<QuestionState>, isMultiSelect: boolean) => void;
  onAnswer: (questionText: string, label: string | string[], textInput?: string, shouldAdvance?: boolean) => void;
  onTextInputFocus: (isInInput: boolean) => void;
  onCancel: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  onRespondToLimkenion: () => void;
  onFinishPlanInterview: () => void;
};

/**
 * 带预览内容的问题的并排视图。
 * 左侧显示纵向选项列表，右侧显示预览面板。
 */
export function PreviewQuestionView({
  question,
  questions,
  currentQuestionIndex,
  answers,
  questionStates,
  hideSubmitTab = false,
  minContentHeight,
  minContentWidth,
  onUpdateQuestionState,
  onAnswer,
  onTextInputFocus,
  onCancel,
  onTabPrev,
  onTabNext,
  onRespondToLimkenion,
  onFinishPlanInterview
}: Props): React.ReactNode {
  const isInPlanMode = useAppState(s => s.toolPermissionContext.mode) === 'plan';
  const [isFooterFocused, setIsFooterFocused] = useState(false);
  const [footerIndex, setFooterIndex] = useState(0);
  const [isInNotesInput, setIsInNotesInput] = useState(false);
  const [cursorOffset, setCursorOffset] = useState(0);
  const editor = getExternalEditor();
  const editorName = editor ? toIDEDisplayName(editor) : null;
  const questionText = question.question;
  const questionState = questionStates[questionText];

  // 仅真实选项——预览问题没有“其他”
  const allOptions = question.options;

  // 跟踪当前聚焦的选项（用于预览显示）
  const [focusedIndex, setFocusedIndex] = useState(0);

  // 导航到不同问题时重置 focusedIndex
  const prevQuestionText = useRef(questionText);
  if (prevQuestionText.current !== questionText) {
    prevQuestionText.current = questionText;
    const selected = questionState?.selectedValue as string | undefined;
    const idx = selected ? allOptions.findIndex(opt => opt.label === selected) : -1;
    setFocusedIndex(idx >= 0 ? idx : 0);
  }
  const focusedOption = allOptions[focusedIndex];
  const selectedValue = questionState?.selectedValue as string | undefined;
  const notesValue = questionState?.textInputValue || '';
  const handleSelectOption = useCallback((index: number) => {
    const option = allOptions[index];
    if (!option) return;
    setFocusedIndex(index);
    onUpdateQuestionState(questionText, {
      selectedValue: option.label
    }, false);
    onAnswer(questionText, option.label);
  }, [allOptions, questionText, onUpdateQuestionState, onAnswer]);
  const handleNavigate = useCallback((direction: 'up' | 'down' | number) => {
    if (isInNotesInput) return;
    let newIndex: number;
    if (typeof direction === 'number') {
      newIndex = direction;
    } else if (direction === 'up') {
      newIndex = focusedIndex > 0 ? focusedIndex - 1 : focusedIndex;
    } else {
      newIndex = focusedIndex < allOptions.length - 1 ? focusedIndex + 1 : focusedIndex;
    }
    if (newIndex >= 0 && newIndex < allOptions.length) {
      setFocusedIndex(newIndex);
    }
  }, [focusedIndex, allOptions.length, isInNotesInput]);

  // 处理 ctrl+g 以通过外部编辑器编辑备注
  useKeybinding('chat:externalEditor', async () => {
    const currentValue = questionState?.textInputValue || '';
    const result = await editPromptInEditor(currentValue);
    if (result.content !== null && result.content !== currentValue) {
      onUpdateQuestionState(questionText, {
        textInputValue: result.content
      }, false);
    }
  }, {
    context: 'Chat',
    isActive: isInNotesInput && !!editor
  });

  // 处理左右方向键和 Tab 切换问题。
  // 这项工作必须在子组件中完成（而非仅在父组件中），因为子组件的 useInput
  // 处理器会在事件分发器上率先注册，并在父组件处理器之前触发。
  // 否则，父组件的 useKeybindings 可能因事件分发器中的监听器顺序而无法可靠触发。
  useKeybindings({
    'tabs:previous': () => onTabPrev?.(),
    'tabs:next': () => onTabNext?.()
  }, {
    context: 'Tabs',
    isActive: !isInNotesInput && !isFooterFocused
  });

  // 退出备注输入时重新提交答案（纯标签）。
  // 备注存储在 questionStates 中，提交时通过注解一并收集。
  const handleNotesExit = useCallback(() => {
    setIsInNotesInput(false);
    onTextInputFocus(false);
    if (selectedValue) {
      onAnswer(questionText, selectedValue);
    }
  }, [selectedValue, questionText, onAnswer, onTextInputFocus]);
  const handleDownFromPreview = useCallback(() => {
    setIsFooterFocused(true);
  }, []);
  const handleUpFromFooter = useCallback(() => {
    setIsFooterFocused(false);
  }, []);

  // 处理选项/页脚/备注导航的键盘输入。
  // 始终激活——处理器根据 isFooterFocused/isInNotesInput 在内部路由。
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (isFooterFocused) {
      if (e.key === 'up' || e.ctrl && e.key === 'p') {
        e.preventDefault();
        if (footerIndex === 0) {
          handleUpFromFooter();
        } else {
          setFooterIndex(0);
        }
        return;
      }
      if (e.key === 'down' || e.ctrl && e.key === 'n') {
        e.preventDefault();
        if (isInPlanMode && footerIndex === 0) {
          setFooterIndex(1);
        }
        return;
      }
      if (e.key === 'return') {
        e.preventDefault();
        if (footerIndex === 0) {
          onRespondToLimkenion();
        } else {
          onFinishPlanInterview();
        }
        return;
      }
      if (e.key === 'escape') {
        e.preventDefault();
        onCancel();
      }
      return;
    }
    if (isInNotesInput) {
      // 备注输入模式下，处理 Escape 以返回选项导航
      if (e.key === 'escape') {
        e.preventDefault();
        handleNotesExit();
      }
      return;
    }

    // Handle option navigation (vertical)
    if (e.key === 'up' || e.ctrl && e.key === 'p') {
      e.preventDefault();
      if (focusedIndex > 0) {
        handleNavigate('up');
      }
    } else if (e.key === 'down' || e.ctrl && e.key === 'n') {
      e.preventDefault();
      if (focusedIndex === allOptions.length - 1) {
        // 位于选项底部，进入页脚
        handleDownFromPreview();
      } else {
        handleNavigate('down');
      }
    } else if (e.key === 'return') {
      e.preventDefault();
      handleSelectOption(focusedIndex);
    } else if (e.key === 'n' && !e.ctrl && !e.meta) {
      // 按 'n' 聚焦备注输入
      e.preventDefault();
      setIsInNotesInput(true);
      onTextInputFocus(true);
    } else if (e.key === 'escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key.length === 1 && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const idx_0 = parseInt(e.key, 10) - 1;
      if (idx_0 < allOptions.length) {
        handleNavigate(idx_0);
      }
    }
  }, [isFooterFocused, footerIndex, isInPlanMode, isInNotesInput, focusedIndex, allOptions.length, handleUpFromFooter, handleDownFromPreview, handleNavigate, handleSelectOption, handleNotesExit, onRespondToLimkenion, onFinishPlanInterview, onCancel, onTextInputFocus]);
  const previewContent = focusedOption?.preview || null;

  // 右侧面板可用宽度为终端宽度减去左侧面板和间距。
  const LEFT_PANEL_WIDTH = 30;
  const GAP = 4;
  const {
    columns
  } = useTerminalSize();
  const previewMaxWidth = columns - LEFT_PANEL_WIDTH - GAP;

  // 内容区域内非预览内容占用的行数：
  // 1: 并排容器的 marginTop
  // 2: PreviewBox 上下边框（顶 + 底）
  // 2: 备注区域（marginTop=1 + 文本）
  // 2: 页脚区域（marginTop=1 + 分隔线）
  // 1: “关于此进行对话”行
  // 1: 计划模式行（可能显示也可能不显示）
  // 2: 帮助文本（marginTop=1 + 文本）
  const PREVIEW_OVERHEAD = 11;

  // 根据父组件的
  // 高度预算计算预览内容可用的最大行数，以防止终端溢出。我们刻意不将较短的选项
  // 补齐到与最长选项一致——外层容器的 minHeight 负责跨问题
  // 布局的一致性，问题内部的偏移是可接受的。
  const previewMaxLines = useMemo(() => {
    return minContentHeight ? Math.max(1, minContentHeight - PREVIEW_OVERHEAD) : undefined;
  }, [minContentHeight]);
  return <Box flexDirection="column" marginTop={1} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Divider color="inactive" />
      <Box flexDirection="column" paddingTop={0}>
        <QuestionNavigationBar questions={questions} currentQuestionIndex={currentQuestionIndex} answers={answers} hideSubmitTab={hideSubmitTab} />
        <PermissionRequestTitle title={question.question} color={'text'} />

        <Box flexDirection="column" minHeight={minContentHeight}>
          {/* 左右布局：左侧为选项，右侧为预览 */}
          <Box marginTop={1} flexDirection="row" gap={4}>
            {/* 左面板：纵向选项列表 */}
            <Box flexDirection="column" width={30}>
              {allOptions.map((option_0, index_0) => {
              const isFocused = focusedIndex === index_0;
              const isSelected = selectedValue === option_0.label;
              return <Box key={option_0.label} flexDirection="row">
                    {isFocused ? <Text color="suggestion">{figures.pointer}</Text> : <Text> </Text>}
                    <Text dimColor> {index_0 + 1}.</Text>
                    <Text color={isSelected ? 'success' : isFocused ? 'suggestion' : undefined} bold={isFocused}>
                      {' '}
                      {option_0.label}
                    </Text>
                    {isSelected && <Text color="success"> {figures.tick}</Text>}
                  </Box>;
            })}
            </Box>

            {/* 右面板：预览 + 备注 */}
            <Box flexDirection="column" flexGrow={1}>
              <PreviewBox content={previewContent || '无预览可用'} maxLines={previewMaxLines} minWidth={minContentWidth} maxWidth={previewMaxWidth} />
              <Box marginTop={1} flexDirection="row" gap={1}>
                <Text color="suggestion">备注：</Text>
                {isInNotesInput ? <TextInput value={notesValue} placeholder="为此设计添加备注…" onChange={value => {
                onUpdateQuestionState(questionText, {
                  textInputValue: value
                }, false);
              }} onSubmit={handleNotesExit} onExit={handleNotesExit} focus={true} showCursor={true} columns={60} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} /> : <Text dimColor italic>
                    {notesValue || '按 n 添加备注'}
                  </Text>}
              </Box>
            </Box>
          </Box>

          {/* 页脚部分 */}
          <Box flexDirection="column" marginTop={1}>
            <Divider color="inactive" />
            <Box flexDirection="row" gap={1}>
              {isFooterFocused && footerIndex === 0 ? <Text color="suggestion">{figures.pointer}</Text> : <Text> </Text>}
              <Text color={isFooterFocused && footerIndex === 0 ? 'suggestion' : undefined}>
                关于此进行对话
              </Text>
            </Box>
            {isInPlanMode && <Box flexDirection="row" gap={1}>
                {isFooterFocused && footerIndex === 1 ? <Text color="suggestion">{figures.pointer}</Text> : <Text> </Text>}
                <Text color={isFooterFocused && footerIndex === 1 ? 'suggestion' : undefined}>
                  跳过访谈并立即规划
                </Text>
              </Box>}
          </Box>
          <Box marginTop={1}>
            <Text color="inactive" dimColor>
              按 Enter 选择 · {figures.arrowUp}/{figures.arrowDown}
              导航 · 按 n 添加备注
              {questions.length > 1 && <> · 按 Tab 切换问题</>}
              {isInNotesInput && editorName && <> · 按 ctrl+g 在 {editorName} 中编辑</>}{' '}
              · 按 Esc 取消
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>;
}