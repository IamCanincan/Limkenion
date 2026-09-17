import { c as _c } from "react/compiler-runtime";
import type { ToolResultBlockParam } from '../../types/llm-protocol.js';
import React from 'react';
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Box, Text } from '../../ink.js';
import { getDisplayPath } from '../../utils/file.js';
import { extractTag } from '../../utils/messages.js';
import type { Input, Output } from './LSPTool.js';
import { getSymbolAtPosition } from './symbolContext.js';

// 操作专属标签的查找表
const OPERATION_LABELS: Record<Input['operation'], {
  singular: string;
  plural: string;
  special?: string;
}> = {
  goToDefinition: {
    singular: '定义',
    plural: '定义'
  },
  findReferences: {
    singular: '引用',
    plural: '引用'
  },
  documentSymbol: {
    singular: '符号',
    plural: '符号'
  },
  workspaceSymbol: {
    singular: '符号',
    plural: '符号'
  },
  hover: {
    singular: '悬停信息',
    plural: '悬停信息',
    special: '可用'
  },
  goToImplementation: {
    singular: '实现',
    plural: '实现'
  },
  prepareCallHierarchy: {
    singular: '调用项',
    plural: '调用项'
  },
  incomingCalls: {
    singular: '调用方',
    plural: '调用方'
  },
  outgoingCalls: {
    singular: '被调用方',
    plural: '被调用方'
  }
};

/**
 * LSP 结果摘要的可复用组件，支持折叠/展开视图
 */
function LSPResultSummary(t0) {
  const $ = _c(24);
  const {
    operation,
    resultCount,
    fileCount,
    content,
    verbose
  } = t0;
  let t1;
  if ($[0] !== operation) {
    t1 = OPERATION_LABELS[operation] || {
      singular: "结果",
      plural: "结果"
    };
    $[0] = operation;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const labelConfig = t1;
  const countLabel = resultCount === 1 ? labelConfig.singular : labelConfig.plural;
  let t2;
  if ($[2] !== countLabel || $[3] !== labelConfig.special || $[4] !== operation || $[5] !== resultCount) {
    t2 = operation === "hover" && resultCount > 0 && labelConfig.special ? <Text>悬停信息 {labelConfig.special}</Text> : <Text>找到 <Text bold={true}>{resultCount} </Text>{countLabel}</Text>;
    $[2] = countLabel;
    $[3] = labelConfig.special;
    $[4] = operation;
    $[5] = resultCount;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  const primaryText = t2;
  let t3;
  if ($[7] !== fileCount) {
    t3 = fileCount > 1 ? <Text>{" "}跨 <Text bold={true}>{fileCount} </Text>个文件</Text> : null;
    $[7] = fileCount;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  const secondaryText = t3;
  if (verbose) {
    let t4;
    if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = <Text dimColor={true}>  ⎿  </Text>;
      $[9] = t4;
    } else {
      t4 = $[9];
    }
    let t5;
    if ($[10] !== primaryText || $[11] !== secondaryText) {
      t5 = <Box flexDirection="row"><Text>{t4}{primaryText}{secondaryText}</Text></Box>;
      $[10] = primaryText;
      $[11] = secondaryText;
      $[12] = t5;
    } else {
      t5 = $[12];
    }
    let t6;
    if ($[13] !== content) {
      t6 = <Box marginLeft={5}><Text>{content}</Text></Box>;
      $[13] = content;
      $[14] = t6;
    } else {
      t6 = $[14];
    }
    let t7;
    if ($[15] !== t5 || $[16] !== t6) {
      t7 = <Box flexDirection="column">{t5}{t6}</Box>;
      $[15] = t5;
      $[16] = t6;
      $[17] = t7;
    } else {
      t7 = $[17];
    }
    return t7;
  }
  let t4;
  if ($[18] !== resultCount) {
    t4 = resultCount > 0 && <CtrlOToExpand />;
    $[18] = resultCount;
    $[19] = t4;
  } else {
    t4 = $[19];
  }
  let t5;
  if ($[20] !== primaryText || $[21] !== secondaryText || $[22] !== t4) {
    t5 = <MessageResponse height={1}><Text>{primaryText}{secondaryText} {t4}</Text></MessageResponse>;
    $[20] = primaryText;
    $[21] = secondaryText;
    $[22] = t4;
    $[23] = t5;
  } else {
    t5 = $[23];
  }
  return t5;
}
export function userFacingName(): string {
  return 'LSP';
}
export function renderToolUseMessage(input: Partial<Input>, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!input.operation) {
    return null;
  }
  const parts: string[] = [];

  // 对于基于位置的操作（goToDefinition、findReferences、hover、goToImplementation），
  // 显示该位置的符号以获得更好的上下文
  if ((input.operation === 'goToDefinition' || input.operation === 'findReferences' || input.operation === 'hover' || input.operation === 'goToImplementation') && input.filePath && input.line !== undefined && input.character !== undefined) {
    // 从 1 起始（用户输入）转换为 0 起始（内部文件读取）
    const symbol = getSymbolAtPosition(input.filePath, input.line - 1, input.character - 1);
    const displayPath = verbose ? input.filePath : getDisplayPath(input.filePath);
    if (symbol) {
      parts.push(`operation: "${input.operation}"`);
      parts.push(`symbol: "${symbol}"`);
      parts.push(`in: "${displayPath}"`);
    } else {
      parts.push(`operation: "${input.operation}"`);
      parts.push(`file: "${displayPath}"`);
      parts.push(`position: ${input.line}:${input.character}`);
    }
    return parts.join(', ');
  }

  // 对于其他操作（documentSymbol、workspaceSymbol），
  // 显示操作和文件，不包含位置细节
  parts.push(`operation: "${input.operation}"`);
  if (input.filePath) {
    const displayPath = verbose ? input.filePath : getDisplayPath(input.filePath);
    parts.push(`file: "${displayPath}"`);
  }
  return parts.join(', ');
}
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    return <MessageResponse>
        <Text color="error">LSP 操作失败</Text>
      </MessageResponse>;
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}
export function renderToolResultMessage(output: Output, _progressMessages: unknown[], {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  // 若有数量信息则使用折叠/展开视图
  if (output.resultCount !== undefined && output.fileCount !== undefined) {
    return <LSPResultSummary operation={output.operation} resultCount={output.resultCount} fileCount={output.fileCount} content={output.result} verbose={verbose} />;
  }

  // 处理数量不可用的错误情况的兜底
  // （例如，LSP 服务器初始化失败、请求错误）
  return <MessageResponse>
      <Text>{output.result}</Text>
    </MessageResponse>;
}