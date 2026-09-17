export function getEnterWorktreeToolPrompt(): string {
  return `仅当用户明确要求工作时使用此工具。此工具会创建一个隔离的 git worktree，并将当前会话切换到其中。

## 何时使用

- 用户明确提到 "worktree"（例如“开始一个 worktree”、“在 worktree 中工作”、“创建一个 worktree”、“使用 worktree”）

## 何时不使用

- 用户要求创建分支、切换分支或在另一个分支上工作——请改用 git 命令
- 用户要求修复缺陷或在某个功能上工作——除非他们特别提到 worktree，否则使用常规 git 工作流
- 除非用户明确提到 "worktree"，否则绝不使用此工具

## 要求

- 必须位于 git 仓库中，或者在 settings.json 中配置了 WorktreeCreate/WorktreeRemove 钩子
- 不能已经处于 worktree 中

## 行为

- 在 git 仓库中：在 \`.limkenion/worktrees/\` 内基于 HEAD 创建带新分支的新 git worktree
- 在 git 仓库之外：将创建/删除操作委托给 WorktreeCreate/WorktreeRemove 钩子，实现与 VCS 无关的隔离
- 将会话的工作目录切换到新的 worktree
- 在会话中途使用 ExitWorktree 离开 worktree（保留或移除）。会话退出时，若仍处于 worktree 中，将提示用户保留或移除它

## 参数

- \`name\`（可选）：worktree 的名称。若不提供，将生成随机名称。
`
}
