import { c as _c } from "react/compiler-runtime";
import chalk from 'chalk';
import figures from 'figures';
import React, { useEffect } from 'react';
import { getAdditionalDirectoriesForLimkenionMd, setAdditionalDirectoriesForLimkenionMd } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { AddWorkspaceDirectory } from '../../components/permissions/rules/AddWorkspaceDirectory.js';
import { Box, Text } from '../../ink.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { applyPermissionUpdate, persistPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js';
import type { PermissionUpdateDestination } from '../../utils/permissions/PermissionUpdateSchema.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { addDirHelpMessage, validateDirectoryForWorkspace } from './validation.js';
function AddDirError(t0) {
  const $ = _c(10);
  const {
    message,
    args,
    onDone
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onDone) {
    t1 = () => {
      const timer = setTimeout(onDone, 0);
      return () => clearTimeout(timer);
    };
    t2 = [onDone];
    $[0] = onDone;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  useEffect(t1, t2);
  let t3;
  if ($[3] !== args) {
    t3 = <Text dimColor={true}>{figures.pointer} /add-dir {args}</Text>;
    $[3] = args;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] !== message) {
    t4 = <MessageResponse><Text>{message}</Text></MessageResponse>;
    $[5] = message;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== t3 || $[8] !== t4) {
    t5 = <Box flexDirection="column">{t3}{t4}</Box>;
    $[7] = t3;
    $[8] = t4;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext, args?: string): Promise<React.ReactNode> {
  const directoryPath = (args ?? '').trim();
  const appState = context.getAppState();

  // 处理添加目录的辅助函数（带路径与不带路径两种情况共用）
  const handleAddDirectory = async (path: string, remember = false) => {
    const destination: PermissionUpdateDestination = remember ? 'localSettings' : 'session';
    const permissionUpdate = {
      type: 'addDirectories' as const,
      directories: [path],
      destination
    };

    // 应用到会话上下文
    const latestAppState = context.getAppState();
    const updatedContext = applyPermissionUpdate(latestAppState.toolPermissionContext, permissionUpdate);
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: updatedContext
    }));

    // 更新 sandbox 配置，使 Bash 命令能够访问新目录。
    // Bootstrap state 是只属于会话的目录的唯一真相来源；持久化的目录
    // 通过 settings 订阅被获取，但为避免用户立即操作时的竞态，我们在此主动刷新。
    const currentDirs = getAdditionalDirectoriesForLimkenionMd();
    if (!currentDirs.includes(path)) {
      setAdditionalDirectoriesForLimkenionMd([...currentDirs, path]);
    }
    SandboxManager.refreshConfig();
    let message: string;
    if (remember) {
      try {
        persistPermissionUpdate(permissionUpdate);
        message = `已将 ${chalk.bold(path)} 添加为工作目录，并保存到本地设置`;
      } catch (error) {
        message = `已将 ${chalk.bold(path)} 添加为工作目录。保存到本地设置失败：${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    } else {
      message = `已将 ${chalk.bold(path)} 添加为本次会话的工作目录`;
    }
    const messageWithHint = `${message} ${chalk.dim('· 使用 /permissions 管理')}`;
    onDone(messageWithHint);
  };

  // 未提供路径时，直接显示 AddWorkspaceDirectory 输入表单，
  // 并在确认后返回 REPL
  if (!directoryPath) {
    return <AddWorkspaceDirectory permissionContext={appState.toolPermissionContext} onAddDirectory={handleAddDirectory} onCancel={() => {
      onDone('未添加工作目录。');
    }} />;
  }
  const result = await validateDirectoryForWorkspace(directoryPath, appState.toolPermissionContext);
  if (result.resultType !== 'success') {
    const message = addDirHelpMessage(result);
    return <AddDirError message={message} args={args ?? ''} onDone={() => onDone(message)} />;
  }
  return <AddWorkspaceDirectory directoryPath={result.absolutePath} permissionContext={appState.toolPermissionContext} onAddDirectory={handleAddDirectory} onCancel={() => {
    onDone(`未将 ${chalk.bold(result.absolutePath)} 添加为工作目录。`);
  }} />;
}