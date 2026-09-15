/**
 * 命令注册表：把第一个 token 映到那条命令。
 *
 * **命令自己带元信息**，这里只做两件事——按顺序收在一起
 * （顺序就是帮助里的顺序），以及按名字查。加一条命令 = 写它自己的模块 + 在这里加一行。
 *
 * 这里**不再有**「名字 → 怎么跑」的映射表配上一份独立的元信息数据：从前那是两个文件各写一半，
 * 而漏掉数据那一半不会报错，只会让帮助里静默少一行。现在两者是同一个对象，漏不掉。
 */

import { authCommand } from "./auth.ts";
import type { Command } from "./command.ts";
import { doctorCommand } from "./doctor.ts";
import { reviewCommand } from "./review.ts";
import { rewindCommand } from "./rewind.ts";
import { searchCommand } from "./search.ts";
import { selfCommand } from "./self.ts";
import { sessionsCommand } from "./sessions.ts";
import { webCommand } from "./web.ts";

/**
 * 全部子命令，按帮助里要出现的顺序排列。
 *
 * `auth` 只登记到子命令粒度（`auth login`）：`auth` 自己还有 `status`，那一层归它自己解析——
 * 注册表管的是「第一个 token 交给谁」，不是把每个子命令的参数都描述一遍。
 */
export const COMMANDS: readonly Command[] = [
	webCommand,
	authCommand,
	sessionsCommand,
	doctorCommand,
	rewindCommand,
	reviewCommand,
	searchCommand,
	selfCommand,
];

/**
 * 按名字找一条命令；没有就返回 undefined。
 *
 * 用数组查找，而不是拿名字去索引一个对象：`argv[0]` 是用户给的任意字符串，对象索引会让
 * `constructor`、`toString` 这类名字顺着原型链命中，把一次打错当成一次正常调用。
 *
 * **找不到不是错误**：`limkenion "把 README 的错别字改掉"` 是正式用法，它与打错子命令的第一个
 * token 长得一模一样，没法区分，所以调用方只能把没命中的继续当「一条指令」处理。
 */
export function findCommand(name: string | undefined): Command | undefined {
	if (name === undefined) {
		return undefined;
	}
	return COMMANDS.find((command) => command.name === name);
}
