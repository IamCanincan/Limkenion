export function getExitWorktreeToolPrompt(): string {
  return `退出由 EnterWorktree 创建的 worktree 会话，并将会话恢复到原始工作目录。

## 适用范围

此工具只作用于本会话中由 EnterWorktree 创建的 worktree。它不会触碰：
- 你用 \`git worktree add\` 手动创建的 worktree
- 之前会话的 worktree（即使当时也是由 EnterWorktree 创建）
- 若 EnterWorktree 从未被调用，则不会触碰你当前所在的目录

如果在 EnterWorktree 会话之外调用，此工具是**空操作**：它会报告当前没有正在进行的 worktree 会话，且不采取任何动作。文件系统状态不变。

## 何时使用

- 用户明确要求“退出 worktree”、“离开 worktree”、“返回”或以其他方式结束 worktree 会话
- 不要主动调用——仅在用户要求时使用

## 参数

- \`action\`（必填）：\`"keep"\` 或 \`"remove"\`
  - \`"keep"\`——在磁盘上保留 worktree 目录及其分支。若用户希望稍后回来继续这项工作，或需要保留某些更改，请使用此选项。
  - \`"remove"\`——删除 worktree 目录及其分支。当工作已完成或已放弃、需要干净退出时使用。
- \`discard_changes\`（可选，默认 false）：仅当 \`action: "remove"\` 时才有意义。若 worktree 有未提交的文件或不在原分支上的提交，除非此参数设为 \`true\`，否则工具将拒绝删除。若工具返回列出更改的错误，请先与用户确认，再用 \`discard_changes: true\` 重新调用。

## 行为

- 将会话的工作目录恢复到 EnterWorktree 之前的位置
- 清除依赖 CWD 的缓存（系统提示词分段、记忆文件、计划目录），使会话状态反映原始目录
- 若存在附加到 worktree 的 tmux 会话：在 \`remove\` 时杀掉它，在 \`keep\` 时保持运行（会返回其名称，方便用户重新附加）
- 退出后，可再次调用 EnterWorktree 创建全新的 worktree
`
}
