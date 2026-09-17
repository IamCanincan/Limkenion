// 这些常量放在独立文件中以避免循环依赖问题。
// 请勿给本文件添加 import——它必须保持零依赖。

export const NOTIFICATION_CHANNELS = [
  'auto',
  'iterm2',
  'iterm2_with_bell',
  'terminal_bell',
  'kitty',
  'ghostty',
  'notifications_disabled',
] as const

// 有效的编辑器模式（排除已废弃的 'emacs'，它会自动迁移到 'normal'）
export const EDITOR_MODES = ['normal', 'vim'] as const

// 可用的队友模式（用于生成）
// 'tmux' = 基于 tmux 的传统队友
// 'in-process' = 在同一进程中运行的程序内队友
// 'auto' = 根据上下文自动选择（默认）
export const TEAMMATE_MODES = ['auto', 'tmux', 'in-process'] as const
