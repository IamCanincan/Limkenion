import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { Box, Text } from '../ink.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';
import { Spinner } from './Spinner.js';

// 内联 require 打破了这个文件本来会形成的循环依赖：
// sessionStorage → commands → exit → ExitFlow → 此处。所有调用点
// 都在回调内部，因此惰性 require 永远不会遇到未定义的 import。
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  ;
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onCancel?: () => void;
};
export function WorktreeExitDialog({
  onDone,
  onCancel
}: Props): React.ReactNode {
  const [status, setStatus] = useState<'loading' | 'asking' | 'keeping' | 'removing' | 'done'>('loading');
  const [changes, setChanges] = useState<string[]>([]);
  const [commitCount, setCommitCount] = useState<number>(0);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const worktreeSession = getCurrentWorktreeSession();
  useEffect(() => {
    async function loadChanges() {
      let changeLines: string[] = [];
      const gitStatus = await execFileNoThrow('git', ['status', '--porcelain']);
      if (gitStatus.stdout) {
        changeLines = gitStatus.stdout.split('\n').filter(_ => _.trim() !== '');
        setChanges(changeLines);
      }

      // Check for commits to eject
      if (worktreeSession) {
        // Get commits in worktree that are not in original branch
        const {
          stdout: commitsStr
        } = await execFileNoThrow('git', ['rev-list', '--count', `${worktreeSession.originalHeadCommit}..HEAD`]);
        const count = parseInt(commitsStr.trim()) || 0;
        setCommitCount(count);

        // If no changes and no commits, clean up silently
        if (changeLines.length === 0 && count === 0) {
          setStatus('removing');
          void cleanupWorktree().then(() => {
            process.chdir(worktreeSession.originalCwd);
            setCwd(worktreeSession.originalCwd);
            recordWorktreeExit();
            getPlansDirectory.cache.clear?.();
            setResultMessage('工作树已移除（无更改）');
          }).catch(error => {
            logForDebugging(`Failed to clean up worktree: ${error}`, {
              level: 'error'
            });
            setResultMessage('工作树清理失败，仍将退出');
          }).then(() => {
            setStatus('done');
          });
          return;
        } else {
          setStatus('asking');
        }
      }
    }
    void loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [worktreeSession]);
  useEffect(() => {
    if (status === 'done') {
      onDone(resultMessage);
    }
  }, [status, onDone, resultMessage]);
  if (!worktreeSession) {
    onDone('未找到活动的工作树会话', {
      display: 'system'
    });
    return null;
  }
  if (status === 'loading' || status === 'done') {
    return null;
  }
  async function handleSelect(value: string) {
    if (!worktreeSession) return;
    const hasTmux = Boolean(worktreeSession.tmuxSessionName);
    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('limkenion_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length
      });
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(`工作树已保留。你的工作保存在 ${worktreeSession.worktreePath} 的分支 ${worktreeSession.worktreeBranch} 上。使用以下命令重新附加 tmux 会话：tmux attach -t ${worktreeSession.tmuxSessionName}`);
      } else {
        setResultMessage(`工作树已保留。你的工作保存在 ${worktreeSession.worktreePath} 的分支 ${worktreeSession.worktreeBranch} 上。`);
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('limkenion_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(`工作树已保留在 ${worktreeSession.worktreePath} 的分支 ${worktreeSession.worktreeBranch} 上。tmux 会话已终止。`);
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      setStatus('removing');
      logEvent('limkenion_worktree_removed', {
        commits: commitCount,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      try {
        await cleanupWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
      } catch (error) {
        logForDebugging(`Failed to clean up worktree: ${error}`, {
          level: 'error'
        });
        setResultMessage('工作树清理失败，仍将退出');
        setStatus('done');
        return;
      }
      const tmuxNote = hasTmux ? ' tmux 会话已终止。' : '';
      if (commitCount > 0 && changes.length > 0) {
        setResultMessage(`工作树已移除。${commitCount} 个提交及未提交的更改已被丢弃。${tmuxNote}`);
      } else if (commitCount > 0) {
        setResultMessage(`工作树已移除。${worktreeSession.worktreeBranch} 上的 ${commitCount} 个提交已被丢弃。${tmuxNote}`);
      } else if (changes.length > 0) {
        setResultMessage(`工作树已移除。未提交的更改已被丢弃。${tmuxNote}`);
      } else {
        setResultMessage(`工作树已移除。${tmuxNote}`);
      }
      setStatus('done');
    }
  }
  if (status === 'keeping') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>正在保留工作树…</Text>
      </Box>;
  }
  if (status === 'removing') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>正在移除工作树…</Text>
      </Box>;
  }
  const branchName = worktreeSession.worktreeBranch;
  const hasUncommitted = changes.length > 0;
  const hasCommits = commitCount > 0;
  let subtitle = '';
  if (hasUncommitted && hasCommits) {
    subtitle = `你在 ${branchName} 上有 ${changes.length} 个未提交文件和 ${commitCount} 个提交。如果移除，将全部丢失。`;
  } else if (hasUncommitted) {
    subtitle = `你有 ${changes.length} 个未提交文件。移除工作树后这些将丢失。`;
  } else if (hasCommits) {
    subtitle = `你在 ${branchName} 上有 ${commitCount} 个提交。移除工作树后该分支将被删除。`;
  } else {
    subtitle = '你正在工作树中工作。保留它以在此继续工作，或移除它以清理。';
  }
  function handleCancel() {
    if (onCancel) {
      // 中止退出并返回会话
      onCancel();
      return;
    }
    // 兜底：如果没有提供 onCancel，则将 Escape 视为"保留"
    void handleSelect('keep');
  }
  const removeDescription = hasUncommitted || hasCommits ? '所有更改和提交都将丢失。' : '清理工作树目录。';
  const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName);
  const options = hasTmuxSession ? [{
    label: '保留工作树和 tmux 会话',
    value: 'keep-with-tmux',
    description: `保留在 ${worktreeSession.worktreePath}。重新附加：tmux attach -t ${worktreeSession.tmuxSessionName}`
  }, {
    label: '保留工作树，终止 tmux 会话',
    value: 'keep-kill-tmux',
    description: `将工作树保留在 ${worktreeSession.worktreePath}，并终止 tmux 会话。`
  }, {
    label: '移除工作树和 tmux 会话',
    value: 'remove-with-tmux',
    description: removeDescription
  }] : [{
    label: '保留工作树',
    value: 'keep',
    description: `保留在 ${worktreeSession.worktreePath}`
  }, {
    label: '移除工作树',
    value: 'remove',
    description: removeDescription
  }];
  const defaultValue = hasTmuxSession ? 'keep-with-tmux' : 'keep';
  return <Dialog title="退出工作树会话" subtitle={subtitle} onCancel={handleCancel}>
      <Select defaultFocusValue={defaultValue} options={options} onChange={handleSelect} />
    </Dialog>;
}