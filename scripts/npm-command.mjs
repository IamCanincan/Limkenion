/**
 * 调用 npm 的共用封装。
 *
 * 为什么不能直接 spawn `npm.cmd`：Node 从 20.12 起禁止在没有 shell 的情况下启动
 * `.cmd` / `.bat`（CVE-2024-27980 的缓解措施），spawnSync 会拿到 `status = null` 与
 * `error.code = EINVAL`，调用方看到的却是「查询失败」这类误导性结论。
 *
 * 改走 `npm_execpath` 把 npm 自己的 CLI 脚本交给 node 执行：既不需要 shell，也不会像
 * `shell: true` 加参数那样触发 DEP0190 警告。直接 `node scripts/xxx.mjs` 调用（没有
 * npm 注入的 npm_execpath）时，再退回各平台的常规方式。
 */

import { spawnSync } from "node:child_process";

/** spawnSync 的默认输出上限，npm pack 的 JSON 输出可能不小 */
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

/** 把 npm 参数拼成一条可直接执行的命令 */
function npmCommand(npmArgs) {
	const npmCli = process.env.npm_execpath;
	if (npmCli) {
		return { args: [npmCli, ...npmArgs], command: process.execPath };
	}
	if (process.platform === "win32") {
		return { args: ["/d", "/s", "/c", "npm", ...npmArgs], command: "cmd.exe" };
	}
	return { args: npmArgs, command: "npm" };
}

/**
 * 运行 npm，返回 spawnSync 的原始结果。
 *
 * 交给调用方判断 status：有的地方要读输出（`npm view`、`npm pack --json`），
 * 有的地方只要成败。`capture` 为真时用管道收集 stdout/stderr，否则全部继承。
 */
export function spawnNpm(npmArgs, options = {}) {
	const { command, args } = npmCommand(npmArgs);
	return spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});
}

/** 运行 npm，非零退出即抛错，并把输出带进错误信息 */
export function runNpm(npmArgs, options = {}) {
	const { command, args } = npmCommand(npmArgs);
	console.log(`$ ${[command, ...args].join(" ")}`);

	const result = spawnNpm(npmArgs, options);
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		throw new Error(
			output ? `命令执行失败：npm ${npmArgs.join(" ")}\n${output}` : `命令执行失败：npm ${npmArgs.join(" ")}`,
		);
	}
	return result;
}
