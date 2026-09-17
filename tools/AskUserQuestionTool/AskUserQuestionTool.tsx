import { c as _c } from "react/compiler-runtime";
import { feature } from 'bun:bundle';
import * as React from 'react';
import { getAllowedChannels, getQuestionPreviewFormat } from 'src/bootstrap/state.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { BLACK_CIRCLE } from 'src/constants/figures.js';
import { getModeColor } from 'src/utils/permissions/PermissionMode.js';
import { z } from 'zod/v4';
import { Box, Text } from '../../ink.js';
import type { Tool } from '../../Tool.js';
import { buildTool, type ToolDef } from '../../Tool.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { ASK_USER_QUESTION_TOOL_CHIP_WIDTH, ASK_USER_QUESTION_TOOL_NAME, ASK_USER_QUESTION_TOOL_PROMPT, DESCRIPTION, PREVIEW_FEATURE_PROMPT } from './prompt.js';
const questionOptionSchema = lazySchema(() => z.object({
  label: z.string().describe('用户将看到并选择的选项显示文本。应简洁（1-5 个词），并清晰描述该选项。'),
  description: z.string().describe('说明该选项的含义或选择后将发生什么。有助于说明权衡或后果方面的背景信息。'),
  preview: z.string().optional().describe('该选项被聚焦时渲染的可选预览内容。用于原型图、代码片段或帮助用户对比选项的视觉比较。预期的内容格式请参阅工具说明。')
}));
const questionSchema = lazySchema(() => z.object({
  question: z.string().describe('要询问用户的完整问题。应清晰、具体并以问号结尾。示例："我们应该使用哪个库进行日期格式化？" 如果 multiSelect 为 true，请相应措辞，例如"你想启用哪些功能？"'),
  header: z.string().describe(`显示为 chip/标签的极短标签（最多 ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} 个字符）。示例："认证方式"、"库"、"方案"。`),
  options: z.array(questionOptionSchema()).min(2).max(4).describe(`该问题的可用选项。必须有 2-4 个选项。每个选项都应是明确、互斥的选择（除非启用了 multiSelect）。不应包含"其他"选项，系统会自动提供。`),
  multiSelect: z.boolean().default(false).describe('设为 true 以允许用户一次选择多个选项而非仅一个。当选项并非互斥时使用。')
}));
const annotationsSchema = lazySchema(() => {
  const annotationSchema = z.object({
    preview: z.string().optional().describe('所选项的预览内容（如果该问题使用了预览）。'),
    notes: z.string().optional().describe('用户添加到其选择上的自由文本备注。')
  });
  return z.record(z.string(), annotationSchema).optional().describe('来自用户的可选逐题注解（例如对预览选择的备注）。以问题文本为键。');
});
const UNIQUENESS_REFINE = {
  check: (data: {
    questions: {
      question: string;
      options: {
        label: string;
      }[];
    }[];
  }) => {
    const questions = data.questions.map(q => q.question);
    if (questions.length !== new Set(questions).size) {
      return false;
    }
    for (const question of data.questions) {
      const labels = question.options.map(opt => opt.label);
      if (labels.length !== new Set(labels).size) {
        return false;
      }
    }
    return true;
  },
  message: '问题文本必须唯一，每个问题内的选项标签也必须唯一'
} as const;
const commonFields = lazySchema(() => ({
  answers: z.record(z.string(), z.string()).optional().describe('由权限组件收集的用户回答'),
  annotations: annotationsSchema(),
  metadata: z.object({
    source: z.string().optional().describe('该问题来源的可选标识符（例如 /remember 命令对应 "remember"）。用于分析追踪。')
  }).optional().describe('用于追踪和分析目的的可选元数据。不显示给用户。')
}));
const inputSchema = lazySchema(() => z.strictObject({
  questions: z.array(questionSchema()).min(1).max(4).describe('要向用户提出的问题（1-4 个问题）'),
  ...commonFields()
}).refine(UNIQUENESS_REFINE.check, {
  message: UNIQUENESS_REFINE.message
}));
type InputSchema = ReturnType<typeof inputSchema>;
const outputSchema = lazySchema(() => z.object({
  questions: z.array(questionSchema()).describe('已提出的问题'),
  answers: z.record(z.string(), z.string()).describe('用户提供的回答（问题文本 -> 回答字符串；多选回答以逗号分隔）'),
  annotations: annotationsSchema()
}));
type OutputSchema = ReturnType<typeof outputSchema>;

// SDK schemas 与内部 schemas 完全一致，因为 'preview' 和 'annotations' 现已公开（可通过 'toolConfig.askUserQuestion' 配置）。
export const _sdkInputSchema = inputSchema;
export type Question = z.infer<ReturnType<typeof questionSchema>>;
export type QuestionOption = z.infer<ReturnType<typeof questionOptionSchema>>;
export type Output = z.infer<OutputSchema>;
function AskUserQuestionResultMessage(t0) {
  const $ = _c(3);
  const {
    answers
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Box flexDirection="row"><Text color={getModeColor("default")}>{BLACK_CIRCLE} </Text><Text>用户已回答 Limkenion 的问题：</Text></Box>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  if ($[1] !== answers) {
    t2 = <Box flexDirection="column" marginTop={1}>{t1}<MessageResponse><Box flexDirection="column">{Object.entries(answers).map(_temp)}</Box></MessageResponse></Box>;
    $[1] = answers;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  return t2;
}
function _temp(t0) {
  const [questionText, answer] = t0;
  return <Text key={questionText} color="inactive">· {questionText} → {answer}</Text>;
}
export const AskUserQuestionTool: Tool<InputSchema, Output> = buildTool({
  name: ASK_USER_QUESTION_TOOL_NAME,
  searchHint: '向用户提出一个多项选择问题',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION;
  },
  async prompt() {
    const format = getQuestionPreviewFormat();
    if (format === undefined) {
      // 尚未选择预览格式的 SDK 使用者——省略预览指引（他们可能根本不渲染该字段）。
      return ASK_USER_QUESTION_TOOL_PROMPT;
    }
    return ASK_USER_QUESTION_TOOL_PROMPT + PREVIEW_FEATURE_PROMPT[format];
  },
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  userFacingName() {
    return '';
  },
  isEnabled() {
    // 当 --channels 处于活动状态时，用户很可能正在使用 Telegram/Discord，而非
    // 盯着 TUI。多项选择对话框会因无人操作键盘而一直挂起。频道权限中继
    // 已经跳过 requiresUserInteraction() 工具（interactiveHandler.ts），因此
    // 不存在替代的批准路径。
    if ((feature('KAIROS') || feature('KAIROS_CHANNELS')) && getAllowedChannels().length > 0) {
      return false;
    }
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  isReadOnly() {
    return true;
  },
  toAutoClassifierInput(input) {
    return input.questions.map(q => q.question).join(' | ');
  },
  requiresUserInteraction() {
    return true;
  },
  async validateInput({
    questions
  }) {
    if (getQuestionPreviewFormat() !== 'html') {
      return {
        result: true
      };
    }
    for (const q of questions) {
      for (const opt of q.options) {
        const err = validateHtmlPreview(opt.preview);
        if (err) {
          return {
            result: false,
            message: `问题 "${q.question}" 中的选项 "${opt.label}"：${err}`,
            errorCode: 1
          };
        }
      }
    }
    return {
      result: true
    };
  },
  async checkPermissions(input) {
    return {
      behavior: 'ask' as const,
      message: '回答问题？',
      updatedInput: input
    };
  },
  renderToolUseMessage() {
    return null;
  },
  renderToolUseProgressMessage() {
    return null;
  },
  renderToolResultMessage({
    answers
  }, _toolUseID) {
    return <AskUserQuestionResultMessage answers={answers} />;
  },
  renderToolUseRejectedMessage() {
    return <Box flexDirection="row" marginTop={1}>
        <Text color={getModeColor('default')}>{BLACK_CIRCLE}&nbsp;</Text>
        <Text>用户拒绝回答问题</Text>
      </Box>;
  },
  renderToolUseErrorMessage() {
    return null;
  },
  async call({
    questions,
    answers = {},
    annotations
  }, _context) {
    return {
      data: {
        questions,
        answers,
        ...(annotations && {
          annotations
        })
      }
    };
  },
  mapToolResultToToolResultBlockParam({
    answers,
    annotations
  }, toolUseID) {
    const answersText = Object.entries(answers).map(([questionText, answer]) => {
      const annotation = annotations?.[questionText];
      const parts = [`"${questionText}"="${answer}"`];
      if (annotation?.preview) {
        parts.push(`选中的预览：\n${annotation.preview}`);
      }
      if (annotation?.notes) {
        parts.push(`用户备注：${annotation.notes}`);
      }
      return parts.join(' ');
    }).join(', ');
    return {
      type: 'tool_result',
      content: `用户已回答你的问题：${answersText}。你现在可以结合用户的回答继续。`,
      tool_use_id: toolUseID
    };
  }
} satisfies ToolDef<InputSchema, Output>);

// 轻量级 HTML 片段检查。这并不是解析器——HTML5 解析器按规范具有
// 错误恢复能力并接受任何内容。我们检查的是模型意图（是否输出了 HTML），
// 并对我们事先告知其不要做的特定行为进行拦截。
function validateHtmlPreview(preview: string | undefined): string | null {
  if (preview === undefined) return null;
  if (/<\s*(html|body|!doctype)\b/i.test(preview)) {
    return 'preview 必须是 HTML 片段，而非完整文档（不能包含 <html>、<body> 或 <!DOCTYPE>）';
  }
  // SDK 使用者通常通过 innerHTML 设置该内容——禁止可执行/样式标签，
  // 以免预览运行代码或重设宿主页面样式。内联事件处理器（onclick 等）仍然
  // 可能；使用者应自行进行净化。
  if (/<\s*(script|style)\b/i.test(preview)) {
    return 'preview 不得包含 <script> 或 <style> 标签。如需请通过 style 属性使用内联样式。';
  }
  if (!/<[a-z][^>]*>/i.test(preview)) {
    return 'preview 必须包含 HTML（previewFormat 设置为 "html"）。请用类似 <div> 或 <pre> 的标签包裹内容。';
  }
  return null;
}