import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getLastAPIRequest } from 'src/bootstrap/state.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { getLastAssistantMessage, normalizeMessagesForAPI } from 'src/utils/messages.js';
import type { CommandResultDisplay } from '../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, useInput } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { queryHaiku } from '../services/api/limkenion.js';
import { startsWithApiErrorPrefix } from '../services/api/errors.js';
import type { Message } from '../types/message.js';
import { openBrowser } from '../utils/browser.js';
import { logForDebugging } from '../utils/debug.js';
import { env } from '../utils/env.js';
import { getLimkenionConfigHomeDir } from '../utils/envUtils.js';
import { type GitRepoState, getGitState, getIsGit } from '../utils/git.js';
import { getInMemoryErrors, logError } from '../utils/log.js';
import { extractTeammateTranscriptsFromTasks, getTranscriptPath, loadAllSubagentTranscriptsFromDisk, MAX_TRANSCRIPT_READ_BYTES } from '../utils/sessionStorage.js';
import { jsonStringify } from '../utils/slowOperations.js';
import { asSystemPrompt } from '../utils/systemPromptType.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Byline } from './design-system/Byline.js';
import { Dialog } from './design-system/Dialog.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import TextInput from './TextInput.js';

// This value was determined experimentally by testing the URL length limit
const GITHUB_URL_LIMIT = 7250;
const GITHUB_ISSUES_REPO_URL = 'https://github.com/limkenions/limkenion/issues';
type Props = {
  abortSignal: AbortSignal;
  messages: Message[];
  initialDescription?: string;
  onDone(result: string, options?: {
    display?: CommandResultDisplay;
  }): void;
  backgroundTasks?: {
    [taskId: string]: {
      type: string;
      identity?: {
        agentId: string;
      };
      messages?: Message[];
    };
  };
};
type Step = 'userInput' | 'consent' | 'submitting' | 'done';
type FeedbackData = {
  // latestAssistantMessageId is the message ID from the latest main model call
  latestAssistantMessageId: string | null;
  message_count: number;
  datetime: string;
  description: string;
  platform: string;
  gitRepo: boolean;
  version: string | null;
  transcript: Message[];
  subagentTranscripts?: {
    [agentId: string]: Message[];
  };
  rawTranscriptJsonl?: string;
};

// Utility function to redact sensitive information from strings
export function redactSensitiveInfo(text: string): string {
  let redacted = text;

  // Limkenion API keys (sk-ant...) with or without quotes
  // First handle the case with quotes
  redacted = redacted.replace(/"(sk-ant[^\s"']{24,})"/g, '"[REDACTED_API_KEY]"');
  // Then handle the cases without quotes - more general pattern
  redacted = redacted.replace(
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .replace(re, string) on /bug path: no-match returns same string (Object.is)
  /(?<![A-Za-z0-9"'])(sk-ant-?[A-Za-z0-9_-]{10,})(?![A-Za-z0-9"'])/g, '[REDACTED_API_KEY]');

  // AWS keys - AWSXXXX format - add the pattern we need for the test
  redacted = redacted.replace(/AWS key: "(AWS[A-Z0-9]{20,})"/g, 'AWS key: "[REDACTED_AWS_KEY]"');

  // AWS AKIAXXX keys
  redacted = redacted.replace(/(AKIA[A-Z0-9]{16})/g, '[REDACTED_AWS_KEY]');

  // Google Cloud keys
  redacted = redacted.replace(
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
  /(?<![A-Za-z0-9])(AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9])/g, '[REDACTED_GCP_KEY]');

  // Vertex AI service account keys
  redacted = redacted.replace(
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
  /(?<![A-Za-z0-9])([a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com)(?![A-Za-z0-9])/g, '[REDACTED_GCP_SERVICE_ACCOUNT]');

  // Generic API keys in headers
  redacted = redacted.replace(/(["']?x-api-key["']?\s*[:=]\s*["']?)[^"',\s)}\]]+/gi, '$1[REDACTED_API_KEY]');

  // Authorization headers and Bearer tokens
  redacted = redacted.replace(/(["']?authorization["']?\s*[:=]\s*["']?(bearer\s+)?)[^"',\s)}\]]+/gi, '$1[REDACTED_TOKEN]');

  // AWS environment variables
  redacted = redacted.replace(/(AWS[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED_AWS_VALUE]');

  // GCP environment variables
  redacted = redacted.replace(/(GOOGLE[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED_GCP_VALUE]');

  // Environment variables with keys
  redacted = redacted.replace(/((API[-_]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED]');
  return redacted;
}

// Get sanitized error logs with sensitive information redacted
function getSanitizedErrorLogs(): Array<{
  error?: string;
  timestamp?: string;
}> {
  // Sanitize error logs to remove any API keys
  return getInMemoryErrors().map(errorInfo => {
    // Create a copy of the error info to avoid modifying the original
    const errorCopy = {
      ...errorInfo
    } as {
      error?: string;
      timestamp?: string;
    };

    // Sanitize error if present and is a string
    if (errorCopy && typeof errorCopy.error === 'string') {
      errorCopy.error = redactSensitiveInfo(errorCopy.error);
    }
    return errorCopy;
  });
}
async function loadRawTranscriptJsonl(): Promise<string | null> {
  try {
    const transcriptPath = getTranscriptPath();
    const {
      size
    } = await stat(transcriptPath);
    if (size > MAX_TRANSCRIPT_READ_BYTES) {
      logForDebugging(`Skipping raw transcript read: file too large (${size} bytes)`, {
        level: 'warn'
      });
      return null;
    }
    return await readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}
export function Feedback({
  abortSignal,
  messages,
  initialDescription,
  onDone,
  backgroundTasks = {}
}: Props): React.ReactNode {
  const [step, setStep] = useState<Step>('userInput');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [description, setDescription] = useState(initialDescription ?? '');
  const [feedbackId, setFeedbackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envInfo, setEnvInfo] = useState<{
    isGit: boolean;
    gitState: GitRepoState | null;
  }>({
    isGit: false,
    gitState: null
  });
  const [title, setTitle] = useState<string | null>(null);
  const textInputColumns = useTerminalSize().columns - 4;
  useEffect(() => {
    async function loadEnvInfo() {
      const isGit = await getIsGit();
      let gitState: GitRepoState | null = null;
      if (isGit) {
        gitState = await getGitState();
      }
      setEnvInfo({
        isGit,
        gitState
      });
    }
    void loadEnvInfo();
  }, []);
  const submitReport = useCallback(async () => {
    setStep('submitting');
    setError(null);
    setFeedbackId(null);

    // Get sanitized errors for the report
    const sanitizedErrors = getSanitizedErrorLogs();

    // Extract last assistant message ID from messages array
    const lastAssistantMessage = getLastAssistantMessage(messages);
    const lastAssistantMessageId = lastAssistantMessage?.requestId ?? null;
    const [diskTranscripts, rawTranscriptJsonl] = await Promise.all([loadAllSubagentTranscriptsFromDisk(), loadRawTranscriptJsonl()]);
    const teammateTranscripts = extractTeammateTranscriptsFromTasks(backgroundTasks);
    const subagentTranscripts = {
      ...diskTranscripts,
      ...teammateTranscripts
    };
    const reportData = {
      latestAssistantMessageId: lastAssistantMessageId,
      message_count: messages.length,
      datetime: new Date().toISOString(),
      description,
      platform: env.platform,
      gitRepo: envInfo.isGit,
      terminal: env.terminal,
      version: MACRO.VERSION,
      transcript: normalizeMessagesForAPI(messages),
      errors: sanitizedErrors,
      lastApiRequest: getLastAPIRequest(),
      ...(Object.keys(subagentTranscripts).length > 0 && {
        subagentTranscripts
      }),
      ...(rawTranscriptJsonl && {
        rawTranscriptJsonl
      })
    };
    const [result, t] = await Promise.all([submitFeedback(reportData, abortSignal), generateTitle(description, abortSignal)]);
    setTitle(t);
    if (result.success) {
      if (result.feedbackId) {
        setFeedbackId(result.feedbackId);
        logEvent('limkenion_bug_report_submitted', {
          feedback_id: result.feedbackId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          last_assistant_message_id: lastAssistantMessageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        // 原本这里还会把反馈正文通过 logEventTo1P 上报到第一方遥测端点。
        // Limkenion 无云服务，且那是用户原文 —— 不再外发，只留在本地文件里。
      }
      setStep('done');
    } else {
      if (result.isZdrOrg) {
        setError('对于采用自定义数据保留策略的组织，无法收集反馈。');
      } else {
        setError('无法提交反馈。请稍后重试。');
      }
      // Stay on userInput step so user can retry with their content preserved
      setStep('userInput');
    }
  }, [description, envInfo.isGit, messages]);

  // Handle cancel - this will be called by Dialog's automatic Esc handling
  const handleCancel = useCallback(() => {
    // Don't cancel when done - let other keys close the dialog
    if (step === 'done') {
      if (error) {
        onDone('提交反馈 / Bug 报告时出错', {
          display: 'system'
        });
      } else {
        onDone('反馈 / Bug 报告已提交', {
          display: 'system'
        });
      }
      return;
    }
    onDone('反馈 / Bug 报告已取消', {
      display: 'system'
    });
  }, [step, error, onDone]);

  // During text input, use Settings context where only Escape (not 'n') triggers confirm:no.
  // This allows typing 'n' in the text field while still supporting Escape to cancel.
  useKeybinding('confirm:no', handleCancel, {
    context: 'Settings',
    isActive: step === 'userInput'
  });
  useInput((input, key) => {
    // Allow any key press to close the dialog when done or when there's an error
    if (step === 'done') {
      if (key.return && title) {
        // Open GitHub issue URL when Enter is pressed
        const issueUrl = createGitHubIssueUrl(feedbackId ?? '', title, description, getSanitizedErrorLogs());
        void openBrowser(issueUrl);
      }
      if (error) {
        onDone('提交反馈 / Bug 报告时出错', {
          display: 'system'
        });
      } else {
        onDone('反馈 / Bug 报告已提交', {
          display: 'system'
        });
      }
      return;
    }

    // When in userInput step with error, allow user to edit and retry
    // (don't close on any keypress - they can still press Esc to cancel)
    if (error && step !== 'userInput') {
      onDone('提交反馈 / Bug 报告时出错', {
        display: 'system'
      });
      return;
    }
    if (step === 'consent' && (key.return || input === ' ')) {
      void submitReport();
    }
  });
  return <Dialog title="提交反馈 / Bug 报告" onCancel={handleCancel} isCancelActive={step !== 'userInput'} inputGuide={exitState => exitState.pending ? <Text>再次按 {exitState.keyName} 退出</Text> : step === 'userInput' ? <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="continue" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
          </Byline> : step === 'consent' ? <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="submit" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
          </Byline> : null}>
      {step === 'userInput' && <Box flexDirection="column" gap={1}>
          <Text>请在下方描述问题：</Text>
          <TextInput value={description} onChange={value => {
        setDescription(value);
        // Clear error when user starts editing to allow retry
        if (error) {
          setError(null);
        }
      }} columns={textInputColumns} onSubmit={() => setStep('consent')} onExitMessage={() => onDone('反馈已取消', {
        display: 'system'
      })} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} showCursor />
          {error && <Box flexDirection="column" gap={1}>
              <Text color="error">{error}</Text>
              <Text dimColor>
                编辑并按 Enter 重试，或按 Esc 取消
              </Text>
            </Box>}
        </Box>}

      {step === 'consent' && <Box flexDirection="column">
          <Text>此报告将包含：</Text>
          <Box marginLeft={2} flexDirection="column">
            <Text>
              - 您的反馈 / Bug 描述：{' '}
              <Text dimColor>{description}</Text>
            </Text>
            <Text>
              - 环境信息：{' '}
              <Text dimColor>
                {env.platform}, {env.terminal}, v{MACRO.VERSION}
              </Text>
            </Text>
            {envInfo.gitState && <Text>
                - Git 仓库元数据：{' '}
                <Text dimColor>
                  {envInfo.gitState.branchName}
                  {envInfo.gitState.commitHash ? `, ${envInfo.gitState.commitHash.slice(0, 7)}` : ''}
                  {envInfo.gitState.remoteUrl ? ` @ ${envInfo.gitState.remoteUrl}` : ''}
                  {!envInfo.gitState.isHeadOnRemote && ', 未同步'}
                  {!envInfo.gitState.isClean && ', 有本地修改'}
                </Text>
              </Text>}
            <Text>- 当前会话记录</Text>
          </Box>
          <Box marginTop={1}>
            <Text wrap="wrap" dimColor>
                  我们将使用您的反馈来调试相关问题或改进{' '}
                  Limkenion 的功能（例如，降低将来出现 Bug 的风险）。
                </Text>
          </Box>
          <Box marginTop={1}>
            <Text>
              按 <Text bold>Enter</Text> 确认并提交。
            </Text>
          </Box>
        </Box>}

      {step === 'submitting' && <Box flexDirection="row" gap={1}>
          <Text>正在提交报告…</Text>
        </Box>}

      {step === 'done' && <Box flexDirection="column">
          {error ? <Text color="error">{error}</Text> : <Text color="success">感谢您的报告！</Text>}
          {feedbackId && <Text dimColor>反馈 ID：{feedbackId}</Text>}
          <Box marginTop={1}>
            <Text>按 </Text>
            <Text bold>Enter </Text>
            <Text>
              打开浏览器起草一个 GitHub 问题，或按任意其他键关闭。
            </Text>
          </Box>
        </Box>}
    </Dialog>;
}
export function createGitHubIssueUrl(feedbackId: string, title: string, description: string, errors: Array<{
  error?: string;
  timestamp?: string;
}>): string {
  const sanitizedTitle = redactSensitiveInfo(title);
  const sanitizedDescription = redactSensitiveInfo(description);
  const bodyPrefix = `**Bug Description**\n${sanitizedDescription}\n\n` + `**Environment Info**\n` + `- Platform: ${env.platform}\n` + `- Terminal: ${env.terminal}\n` + `- Version: ${MACRO.VERSION || 'unknown'}\n` + `- Feedback ID: ${feedbackId}\n` + `\n**Errors**\n\`\`\`json\n`;
  const errorSuffix = `\n\`\`\`\n`;
  const errorsJson = jsonStringify(errors);
  const baseUrl = `${GITHUB_ISSUES_REPO_URL}/new?title=${encodeURIComponent(sanitizedTitle)}&labels=user-reported,bug&body=`;
  const truncationNote = `\n**Note:** Content was truncated.\n`;
  const encodedPrefix = encodeURIComponent(bodyPrefix);
  const encodedSuffix = encodeURIComponent(errorSuffix);
  const encodedNote = encodeURIComponent(truncationNote);
  const encodedErrors = encodeURIComponent(errorsJson);

  // Calculate space available for errors
  const spaceForErrors = GITHUB_URL_LIMIT - baseUrl.length - encodedPrefix.length - encodedSuffix.length - encodedNote.length;

  // If description alone exceeds limit, truncate everything
  if (spaceForErrors <= 0) {
    const ellipsis = encodeURIComponent('…');
    const buffer = 50; // Extra safety margin
    const maxEncodedLength = GITHUB_URL_LIMIT - baseUrl.length - ellipsis.length - encodedNote.length - buffer;
    const fullBody = bodyPrefix + errorsJson + errorSuffix;
    let encodedFullBody = encodeURIComponent(fullBody);
    if (encodedFullBody.length > maxEncodedLength) {
      encodedFullBody = encodedFullBody.slice(0, maxEncodedLength);
      // Don't cut in middle of %XX sequence
      const lastPercent = encodedFullBody.lastIndexOf('%');
      if (lastPercent >= encodedFullBody.length - 2) {
        encodedFullBody = encodedFullBody.slice(0, lastPercent);
      }
    }
    return baseUrl + encodedFullBody + ellipsis + encodedNote;
  }

  // If errors fit, no truncation needed
  if (encodedErrors.length <= spaceForErrors) {
    return baseUrl + encodedPrefix + encodedErrors + encodedSuffix;
  }

  // Truncate errors to fit (prioritize keeping description)
  // Slice encoded errors directly, then trim to avoid cutting %XX sequences
  const ellipsis = encodeURIComponent('…');
  const buffer = 50; // Extra safety margin
  let truncatedEncodedErrors = encodedErrors.slice(0, spaceForErrors - ellipsis.length - buffer);
  // If we cut in middle of %XX, back up to before the %
  const lastPercent = truncatedEncodedErrors.lastIndexOf('%');
  if (lastPercent >= truncatedEncodedErrors.length - 2) {
    truncatedEncodedErrors = truncatedEncodedErrors.slice(0, lastPercent);
  }
  return baseUrl + encodedPrefix + truncatedEncodedErrors + ellipsis + encodedSuffix + encodedNote;
}
async function generateTitle(description: string, abortSignal: AbortSignal): Promise<string> {
  try {
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt(['Generate a concise, technical issue title (max 80 chars) for a public GitHub issue based on this bug report for Limkenion.', 'Limkenion is an agentic coding CLI based on the Limkenion API.', 'The title should:', '- Include the type of issue [Bug] or [Feature Request] as the first thing in the title', '- Be concise, specific and descriptive of the actual problem', '- Use technical terminology appropriate for a software issue', '- For error messages, extract the key error (e.g., "Missing Tool Result Block" rather than the full message)', '- Be direct and clear for developers to understand the problem', '- If you cannot determine a clear issue, use "Bug Report: [brief description]"', '- Any LLM API errors are from the Limkenion API, not from any other model provider', 'Your response will be directly used as the title of the Github issue, and as such should not contain any other commentary or explaination', 'Examples of good titles include: "[Bug] Auto-Compact triggers to soon", "[Bug] Limkenion API Error: Missing Tool Result Block", "[Bug] Error: Invalid Model Name for Opus"']),
      userPrompt: description,
      signal: abortSignal,
      options: {
        hasAppendSystemPrompt: false,
        toolChoice: undefined,
        isNonInteractiveSession: false,
        agents: [],
        querySource: 'feedback',
        mcpTools: []
      }
    });
    const title = response.message.content[0]?.type === 'text' ? response.message.content[0].text : 'Bug Report';

    // Check if the title contains an API error message
    if (startsWithApiErrorPrefix(title)) {
      return createFallbackTitle(description);
    }
    return title;
  } catch (error) {
    // If there's any error in title generation, use a fallback title
    logError(error);
    return createFallbackTitle(description);
  }
}
function createFallbackTitle(description: string): string {
  // Create a safe fallback title based on the bug description

  // Try to extract a meaningful title from the first line
  const firstLine = description.split('\n')[0] || '';

  // If the first line is very short, use it directly
  if (firstLine.length <= 60 && firstLine.length > 5) {
    return firstLine;
  }

  // For longer descriptions, create a truncated version
  // Truncate at word boundaries when possible
  let truncated = firstLine.slice(0, 60);
  if (firstLine.length > 60) {
    // Find the last space before the 60 char limit
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 30) {
      // Only trim at word if we're not cutting too much
      truncated = truncated.slice(0, lastSpace);
    }
    truncated += '...';
  }
  return truncated.length < 10 ? 'Bug Report' : truncated;
}

// Helper function to sanitize and log errors without exposing API keys
function sanitizeAndLogError(err: unknown): void {
  if (err instanceof Error) {
    // Create a copy with potentially sensitive info redacted
    const safeError = new Error(redactSensitiveInfo(err.message));

    // Also redact the stack trace if present
    if (err.stack) {
      safeError.stack = redactSensitiveInfo(err.stack);
    }
    logError(safeError);
  } else {
    // For non-Error objects, convert to string and redact sensitive info
    const errorString = redactSensitiveInfo(String(err));
    logError(new Error(errorString));
  }
}
async function submitFeedback(data: FeedbackData, signal?: AbortSignal): Promise<{
  success: boolean;
  feedbackId?: string;
  isZdrOrg?: boolean;
}> {
  // Limkenion 无任何网站与云服务：反馈不再上报远端
  // （原本 POST 到 https://127.0.0.1/api/limkenion_cli_feedback，该端点并不存在，
  // 必然失败）。改为**写到本地文件**，用户可自行查看或转交。
  // signal 保留在签名里以兼容调用方，本地写入无需中断处理。
  void signal;
  try {
    const dir = join(getLimkenionConfigHomeDir(), 'feedback');
    await mkdir(dir, { recursive: true });
    const now = new Date();
    const feedbackId = `fb_${now.getTime().toString(36)}`;
    const file = join(
      dir,
      `${now.toISOString().replace(/[:.]/g, '-')}-${feedbackId}.json`,
    );
    await writeFile(
      file,
      jsonStringify({ feedbackId, createdAt: now.toISOString(), ...data }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    );
    logForDebugging(`反馈已保存到本地：${file}`);
    return {
      success: true,
      feedbackId
    };
  } catch (err) {
    // Use our safe error logging function to avoid leaking API keys
    sanitizeAndLogError(err);
    return {
      success: false
    };
  }
}