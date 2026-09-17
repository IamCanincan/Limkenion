/**
 * 在 Commander.js 处理参数之前提前解析 CLI 标志值。
 * 同时支持空格分隔（--flag value）和等号分隔（--flag=value）语法。
 *
 * 此函数用于必须在 init() 之前解析的标志，例如影响配置加载的 --settings。
 * 对于常规标志解析，请依赖会自动处理的 Commander.js。
 *
 * @param flagName 含连字符的标志名（例如 '--settings'）
 * @param argv 可选的要解析的 argv 数组（默认为 process.argv）
 * @returns 找到时返回值，否则返回 undefined
 */
export function eagerParseCliFlag(
  flagName: string,
  argv: string[] = process.argv,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // 处理 --flag=value 语法
    if (arg?.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1)
    }
    // 处理 --flag value 语法
    if (arg === flagName && i + 1 < argv.length) {
      return argv[i + 1]
    }
  }
  return undefined
}

/**
 * 处理 CLI 参数中的标准 Unix `--` 分隔符约定。
 *
 * 当使用带 `.passThroughOptions()` 的 Commander.js 时，`--` 分隔符会作为
 * 位置参数透传，而不会被消耗。这意味着当用户运行：
 *   `cmd --opt value name -- subcmd --flag arg`
 *
 * Commander 会把它解析为：
 *   positional1 = "name"，positional2 = "--"，rest = ["subcmd", "--flag", "arg"]
 *
 * 此函数通过当位置参数为 `--` 时从 rest 数组提取实际命令来纠正该解析。
 *
 * @param commandOrValue - 可能是 "--" 的已解析位置参数
 * @param args - 剩余的参数数组
 * @returns 带修正后的命令和参数的对象
 */
export function extractArgsAfterDoubleDash(
  commandOrValue: string,
  args: string[] = [],
): { command: string; args: string[] } {
  if (commandOrValue === '--' && args.length > 0) {
    return {
      command: args[0]!,
      args: args.slice(1),
    }
  }
  return { command: commandOrValue, args }
}
