/**
 * 子命令的公共约定。
 *
 * 退出码只有三档，全项目一致，脚本才好判断：
 * - `0` 正常结束；
 * - `1` 运行失败（没有会话、连不上、启动失败……）；
 * - `2` 用法错误（参数不认识、缺参数、子命令不存在）。
 *
 * help 判定也放这里：`limkenion review --help` 与 `limkenion review help` 都该打印用法。
 * 早先一半命令按 `argv[0]` 判、一半按 `includes` 判，行为不一致。
 */

/** 是否在请求帮助：help / -h / --help 出现在任何位置都算 */
export function wantsHelp(argv: string[]): boolean {
	return argv.includes("help") || argv.includes("-h") || argv.includes("--help");
}

/** 用法错误的退出码 */
export const EXIT_USAGE = 2;
