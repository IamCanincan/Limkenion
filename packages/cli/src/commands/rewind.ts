/**
 * `limkenion rewind`：回滚最近一轮对文件的改动。
 *
 * 与交互模式里的 `/rewind` 是同一套快照（`<会话文件>.checkpoints.jsonl`）——一次性模式（`-p`）
 * 也照样记快照，只是之前没有命令行入口；脚本里跑完发现改歪了，用这条命令退回去。
 */

import { CheckpointStore } from "limkenion-core";
import { APP_NAME } from "../config.ts";
import { Session } from "../session.ts";
import type { Command } from "./command.ts";
import { wantsHelp } from "./common.ts";

/** rewind 子命令：元信息住在命令自己这里 */
export const rewindCommand: Command = {
	name: "rewind",
	synopsis: "rewind [n]",
	summary: "回滚最近 n 轮对文件的改动（默认 1 轮）",
	run: (argv) => runRewindCommand(argv),
};

/** 用法说明 */
function rewindUsage(): string {
	return [
		`${APP_NAME} rewind - 回滚最近若干轮对文件的改动`,
		"",
		"用法：",
		`  ${APP_NAME} rewind            回滚最近一轮`,
		`  ${APP_NAME} rewind 2          回滚最近两轮`,
		"",
		"改动前的内容记在会话文件旁边的 checkpoints.jsonl 里，回滚会把改过的文件写回旧内容、",
		"把该轮新建的文件删掉。没有可回滚的轮次时退出码为 1。",
	].join("\n");
}

/** 运行 rewind，返回进程退出码 */
export async function runRewindCommand(argv: string[]): Promise<number> {
	if (wantsHelp(argv)) {
		process.stdout.write(`${rewindUsage()}\n`);
		return 0;
	}

	// 只回滚当前工作目录下最近的会话：会话是按目录存放的，跨目录回滚没有意义。
	const session = Session.latest(process.cwd());
	if (!session) {
		process.stderr.write("当前工作目录下没有会话，没有可回滚的内容\n");
		return 1;
	}

	const requested = Number.parseInt(argv[0] ?? "1", 10);
	const times = Number.isFinite(requested) && requested > 0 ? requested : 1;

	const store = new CheckpointStore(session.file);
	let restored = 0;
	let removed = 0;
	let skipped: string[] = [];
	let rounds = 0;
	for (let i = 0; i < times; i++) {
		const result = store.rewind();
		if (!result) {
			break;
		}
		rounds += 1;
		restored += result.restored.length;
		removed += result.removed.length;
		skipped = result.skipped;
	}

	if (rounds === 0) {
		process.stderr.write("没有可回滚的轮次（该会话还没有被记录的改动）\n");
		return 1;
	}

	const parts = [`已回滚 ${rounds} 轮：改回 ${restored} 个文件`];
	if (removed > 0) {
		parts.push(`删除 ${removed} 个新建文件`);
	}
	if (skipped.length > 0) {
		parts.push(`${skipped.length} 个文件无法回滚：${skipped.join(", ")}`);
	}
	// 回滚结果本身就是输出，走 stdout；脚本里可以直接判断退出码。
	process.stdout.write(`${parts.join("，")}\n`);
	return 0;
}
