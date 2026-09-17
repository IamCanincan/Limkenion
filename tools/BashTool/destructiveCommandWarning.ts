/**
 * 检测可能具有破坏性的 bash 命令，并返回用于在权限对话框中展示的警告字符串。
 * 这纯粹是信息性的——它不影响权限逻辑或自动批准。
 */

type DestructivePattern = {
  pattern: RegExp
  warning: string
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Git —— 数据丢失 / 难以回退
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    warning: '注意：可能丢弃未提交的更改',
  },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,
    warning: '注意：可能覆盖远程历史',
  },
  {
    pattern:
      /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    warning: '注意：可能永久删除未跟踪的文件',
  },
  {
    pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: '注意：可能丢弃工作区全部更改',
  },
  {
    pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: '注意：可能丢弃工作区全部更改',
  },
  {
    pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/,
    warning: '注意：可能永久移除暂存的更改',
  },
  {
    pattern:
      /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,
    warning: '注意：可能强制删除某个分支',
  },

  // Git —— 绕过安全机制
  {
    pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,
    warning: '注意：可能跳过安全钩子',
  },
  {
    pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/,
    warning: '注意：可能改写最近一次的提交',
  },

  // 文件删除（危险路径已由 checkDangerousRemovalPaths 处理）
  {
    pattern:
      /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    warning: '注意：可能递归强制删除文件',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,
    warning: '注意：可能递归删除文件',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/,
    warning: '注意：可能强制删除文件',
  },

  // 数据库
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: '注意：可能删除或清空数据库对象',
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,
    warning: '注意：可能删除数据库表中的全部行',
  },

  // 基础设施
  {
    pattern: /\bkubectl\s+delete\b/,
    warning: '注意：可能删除 Kubernetes 资源',
  },
  {
    pattern: /\bterraform\s+destroy\b/,
    warning: '注意：可能销毁 Terraform 基础设施',
  },
]

/**
 * 检查 bash 命令是否匹配已知的破坏性模式。
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
