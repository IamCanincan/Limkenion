import React from 'react';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
type Props = {
  onDone(): void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
};
/**
 * Limkenion 是纯本地工具，无远程账号/OAuth/订阅。
 * 登录即设置 DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量即可（默认端点
 * https://api.deepseek.com）。此处仅展示提示并等待用户按 Enter 继续。
 */
export function ConsoleOAuthFlow({
  onDone,
  startingMessage
}: Props): React.ReactNode {
  useKeybinding('confirm:yes', () => {
    onDone();
  }, {
    context: 'Confirmation',
    isActive: true
  });
  const title = startingMessage ? startingMessage : "Limkenion 只以 DeepSeek 为模型后端，请通过 DeepSeek / OpenAI 兼容 API Key 接入。";
  const body = "设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 环境变量（默认端点 https://api.deepseek.com），然后重启 Limkenion。";
  return <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold={true}>{title}</Text>
      <Text>{body}</Text>
      <Text color="warning">这里不做实际登录。环境变量改完后需要重启 Limkenion 才会生效。按 <Text bold={true}>Enter</Text> 继续…</Text>
    </Box>;
}