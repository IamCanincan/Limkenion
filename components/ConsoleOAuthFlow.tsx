import React, { useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { queryOpenAICompatOnce } from '../services/api/openai-compat.js';
import { saveApiKey } from '../utils/auth.js';
type Props = {
  onDone(): void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
};
type Status = 'input' | 'checking' | 'error';

/**
 * Limkenion 是纯本地工具，无远程账号/OAuth/订阅。
 * 这里的"登录"就是录入 DeepSeek（或任意 OpenAI 兼容端点）的 API Key：
 * 输入 → 校验格式 → 写进全局配置的 primaryApiKey → 发一个最小请求验证有效性。
 * 环境变量优先级更高，若已设置会在界面上明确提示。
 */
export function ConsoleOAuthFlow({
  onDone,
  startingMessage
}: Props): React.ReactNode {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<Status>('input');
  const [error, setError] = useState('');

  // 环境变量优先于 /login 保存的 key，已设置时必须说清楚，否则用户会以为没生效
  const envVar = process.env.DEEPSEEK_API_KEY ? 'DEEPSEEK_API_KEY' : process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : null;

  async function submit(): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('请先输入 API Key');
      setStatus('error');
      return;
    }
    setStatus('checking');
    setError('');
    try {
      await saveApiKey(trimmed);
      // 存下来还不够——发一个最小请求确认它真的能用
      await queryOpenAICompatOnce({
        messages: [{
          role: 'user',
          content: 'hi'
        } as any],
        systemPrompt: '',
        tools: [],
        maxTokens: 1
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  useInput((input, k) => {
    if (status === 'checking') return;
    if (k.return) {
      void submit();
      return;
    }
    if (k.backspace || k.delete) {
      setApiKey(v => v.slice(0, -1));
      return;
    }
    if (k.ctrl || k.meta || k.escape || k.tab) return;
    // 过滤控制字符，避免把不可见字符写进 key
    const cleaned = input.replace(/[\u0000-\u001f\u007f]/g, '');
    if (cleaned) setApiKey(v => (v + cleaned).trim());
  }, {
    isActive: true
  });

  const title = startingMessage ? startingMessage : '配置 DeepSeek API Key';
  const masked = apiKey.length > 12 ? `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}` : apiKey;
  return <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold={true}>{title}</Text>
      <Text dimColor={true}>在 platform.deepseek.com 创建，形如 sk-…。也可改用 DEEPSEEK_API_KEY 环境变量。</Text>
      {envVar && <Text color="warning">注意：已设置 {envVar} 环境变量，它的优先级高于这里保存的 key。</Text>}
      <Text>Key: {masked}<Text color="permission">█</Text></Text>
      {status === 'checking' && <Text>正在验证…</Text>}
      {status === 'error' && <Text color="error">失败：{error}</Text>}
      <Text dimColor={true}>Enter 保存并验证 · Esc 取消</Text>
    </Box>;
}
