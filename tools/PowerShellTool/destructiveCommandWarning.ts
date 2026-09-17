/**
 * 检测可能具有破坏性的 PowerShell 命令，并返回用于在权限对话框中展示的警告
 * 字符串。这纯粹是信息性的——它不影响权限逻辑或自动批准。
 */

type DestructivePattern = {
  pattern: RegExp
  warning: string
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Remove-Item 搭配 -Recurse 和/或 -Force（及常见别名）
  // 锚定到语句开头（^、|、;、&、换行、{、()，以便 `git rm --force`
  // 不被匹配——\b 会在任意单词边界处匹配到 `rm`。`{(`
  // 用于捕获脚本块/分组体：`{ rm -Force ./x }`。结束符
  // 仅添加 `}`（而不是 `)`）——`}` 结束一个块，因此其后标志属于另一条语句
  // （`if {rm} else {... -Force}`）；而 `)` 关闭一个路径
  // 分组，其后的标志仍属于本命令的标志：
  // `Remove-Item (Join-Path $r "tmp") -Recurse -Force` 仍必须告警。
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Recurse\b[^|;&\n}]*-Force\b/i,
    warning: '注意：可能递归强制删除文件',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Force\b[^|;&\n}]*-Recurse\b/i,
    warning: '注意：可能递归强制删除文件',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Recurse\b/i,
    warning: '注意：可能递归删除文件',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Force\b/i,
    warning: '注意：可能强制删除文件',
  },

  // 对宽泛路径执行 Clear-Content
  {
    pattern: /\bClear-Content\b[^|;&\n]*\*/i,
    warning: '注意：可能清空多个文件的内容',
  },

  // Format-Volume 与 Clear-Disk
  {
    pattern: /\bFormat-Volume\b/i,
    warning: '注意：可能格式化磁盘卷',
  },
  {
    pattern: /\bClear-Disk\b/i,
    warning: '注意：可能清空磁盘',
  },

  // Git 破坏性操作（与 BashTool 一致）
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    warning: '注意：可能丢弃未提交的更改',
  },
  {
    pattern: /\bgit\s+push\b[^|;&\n]*\s+(--force|--force-with-lease|-f)\b/i,
    warning: '注意：可能覆盖远程历史',
  },
  {
    pattern:
      /\bgit\s+clean\b(?![^|;&\n]*(?:-[a-zA-Z]*n|--dry-run))[^|;&\n]*-[a-zA-Z]*f/i,
    warning: '注意：可能永久删除未跟踪的文件',
  },
  {
    pattern: /\bgit\s+stash\s+(drop|clear)\b/i,
    warning: '注意：可能永久移除暂存的更改',
  },

  // 数据库操作
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: '注意：可能删除或清空数据库对象',
  },

  // 系统操作
  {
    pattern: /\bStop-Computer\b/i,
    warning: '注意：将关闭计算机',
  },
  {
    pattern: /\bRestart-Computer\b/i,
    warning: '注意：将重启计算机',
  },
  {
    pattern: /\bClear-RecycleBin\b/i,
    warning: '注意：将永久删除回收站中的文件',
  },
]

/**
 * 检查 PowerShell 命令是否匹配已知的破坏性模式。
 * 返回人类可读的警告字符串；若未检测到破坏性模式则返回 null。
 */
export function getDestructiveCommandWarning(command: string): string | null {
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return warning
    }
  }
  return null
}
