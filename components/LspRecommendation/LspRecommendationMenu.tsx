import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { Select } from '../CustomSelect/select.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
type Props = {
  pluginName: string;
  pluginDescription?: string;
  fileExtension: string;
  onResponse: (response: 'yes' | 'no' | 'never' | 'disable') => void;
};
const AUTO_DISMISS_MS = 30_000;
export function LspRecommendationMenu({
  pluginName,
  pluginDescription,
  fileExtension,
  onResponse
}: Props): React.ReactNode {
  // Use ref to avoid timer reset when onResponse changes
  const onResponseRef = React.useRef(onResponse);
  onResponseRef.current = onResponse;

  // 30-second auto-dismiss timer - counts as ignored (no)
  React.useEffect(() => {
    const timeoutId = setTimeout(ref => ref.current('no'), AUTO_DISMISS_MS, onResponseRef);
    return () => clearTimeout(timeoutId);
  }, []);
  function onSelect(value: string): void {
    switch (value) {
      case 'yes':
        onResponse('yes');
        break;
      case 'no':
        onResponse('no');
        break;
      case 'never':
        onResponse('never');
        break;
      case 'disable':
        onResponse('disable');
        break;
    }
  }
  const options = [{
    label: <Text>
          是，安装 <Text bold>{pluginName}</Text>
        </Text>,
    value: 'yes'
  }, {
    label: '暂不',
    value: 'no'
  }, {
    label: <Text>
          永不为 <Text bold>{pluginName}</Text> 推荐
        </Text>,
    value: 'never'
  }, {
    label: '禁用所有 LSP 推荐',
    value: 'disable'
  }];
  return <PermissionDialog title="LSP 插件推荐">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text dimColor>
            LSP 提供代码智能，例如跳转到定义和错误检查
          </Text>
        </Box>
        <Box>
          <Text dimColor>插件：</Text>
          <Text> {pluginName}</Text>
        </Box>
        {pluginDescription && <Box>
            <Text dimColor>{pluginDescription}</Text>
          </Box>}
        <Box>
          <Text dimColor>触发来源：</Text>
          <Text> {fileExtension} 文件</Text>
        </Box>
        <Box marginTop={1}>
          <Text>是否安装此 LSP 插件？</Text>
        </Box>
        <Box>
          <Select options={options} onChange={onSelect} onCancel={() => onResponse('no')} />
        </Box>
      </Box>
    </PermissionDialog>;
}