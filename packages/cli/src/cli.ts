#!/usr/bin/env node

/**
 * 命令行入口：分发子命令，装配 Agent，决定走一次性模式还是交互模式。
 *
 * 参数解析在 args.ts，`auth` 与 `web` 两个子命令各自在 commands/ 下，这里只做调度。
 *
 * 首行的 shebang 不能删：npm 安装时靠它识别解释器来生成启动器。少了它，Windows 上
 * 生成的 .cmd 会直接执行 .js 文件，POSIX 上的符号链接也跑不起来。
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, CheckpointStore } from "limkenion-core";
import { askApproval } from "./approval-prompt.ts";
import { normalizePlanArgv, type Options, parseOptions, readStdin } from "./args.ts";
import { findCommand } from "./commands/registry.ts";
import { createReviewRuntime } from "./commands/review.ts";
import { APP_NAME, getAgentDir, VERSION } from "./config.ts";
import { reviewPlan } from "./plan-review.ts";
import { createRenderer } from "./render.ts";
import { startRepl } from "./repl.ts";
import { runReview } from "./review.ts";
import { createRunRuntime, type RunRuntime } from "./run-agent.ts";
import { Session } from "./session.ts";
import { readSettings } from "./settings.ts";

/**
 * 包一层逐轮快照：开始一轮 → 跑完 → 提交。
 *
 * 中途失败或被打断的轮次不会提交，因此不会污染回滚链——回滚永远回到「上一轮之前」。
 */
async function withCheckpoint<T>(checkpoints: CheckpointStore | undefined, run: () => Promise<T>): Promise<T> {
	checkpoints?.begin();
	try {
		return await run();
	} finally {
		checkpoints?.commit();
	}
}

/** 打开或新建会话 */
function openSession(cwd: string, continueSession: boolean): Session {
	if (continueSession) {
		return Session.latest(cwd) ?? Session.create(cwd);
	}
	return Session.create(cwd);
}

/**
 * 按解析结果装配运行时（Agent 本体 + 后台任务 / 子代理进度 / 逐轮快照 / 待办与目标）。
 *
 * 装配只有一处：`createRunRuntime()`（命令行与浏览器界面共用），这里只负责把**命令行特有的东西**
 * 填进去——渲染器、终端里的确认与方案评审、设置里的钩子、重试提示。
 *
 * 从前这里是另一份手写的 `new Agent({...})`，两份之间掉了一样东西：`subagents` 没传，于是
 * **终端里根本没有子代理工具**（`createSystemTools` 只在收到它时才注册那四个）。同一份能力不该
 * 因为载体不同就少一块，所以现在两边走同一个工厂。
 *
 * `observe` 用来旁观事件（一次性模式靠它判断这一轮到底成没成），渲染仍由内部完成，
 * 调用方不需要自己拼一个渲染器。
 */
export function createCliRuntime(
	cwd: string,
	options: Options,
	session: Session | null,
	observe?: (event: AgentEvent) => void,
): RunRuntime {
	const render = createRenderer({
		verbose: options.verbose,
		// 取值函数：`/model` 换过模型之后，用量那一行的上下文占用要按**新**模型的窗口算
		getModel: () => runtime.agent.model,
		// 工具行按工具自陈的那一句打（与网页同一套），而不是把入参压成一坨 JSON
		summarize: (name, input) =>
			runtime.agent
				.listTools()
				.find((tool) => tool.name === name)
				?.summarize(input) ?? "",
	});
	// 工厂要一个「当前压缩开关」的取值函数，而真值在 Agent 上（`/compact` 改的就是它）：
	// 先声明再赋值的写法让闭包能读到它——闭包在这一刻之后才被调用。
	const runtime: RunRuntime = createRunRuntime({
		session,
		cwd,
		host: {
			// 命令行这一侧密钥是启动时就定好的：直接给一个常量函数，形状与网页那边一致
			resolveApiKey: () => options.apiKey,
			modelId: options.model,
			baseUrl: options.baseUrl,
			maxTurns: options.maxTurns,
			retries: options.retries,
			// 全局 AGENTS.md 放在配置目录里，项目 AGENTS.md 由 Agent 自己沿路径向上找。
			globalConfigDir: getAgentDir(),
			// 过大的工具输出落盘，模型需要时自己去读；目录放在配置目录下，不污染工作目录。
			spillDir: join(getAgentDir(), "spill"),
			hooks: readSettings().hooks?.preToolUse,
			onRetry: ({ attempt, delayMs }) => {
				// 重试是「系统在自救」，属于状态信息，按输出约定走 stderr。
				// 等待时间按人话打：服务端给的 Retry-After 可能是几分钟（内核现在照它等），
				// `300000ms` 要心算才看得懂；一秒以内保留毫秒。
				const seconds = delayMs / 1000;
				const wait =
					seconds < 1
						? `${Math.round(delayMs)}ms`
						: seconds < 60
							? `${seconds.toFixed(1)} 秒`
							: `${Math.round(seconds / 60)} 分钟`;
				process.stderr.write(`上游不可用，${wait}后重试（第 ${attempt} 次）…\n`);
			},
		},
		modes: {
			approval: options.approval,
			plan: options.plan,
			style: options.style,
			compaction: options.compaction,
		},
		// 取值函数而不是当前值：终端里能随时改（/compact），之后起的子代理要跟着当前值跑
		getCompaction: () => runtime.agent.compactionEnabled,
		// onApproval 在 ask 模式下每次读写都会用；auto 档下只有「疑似危险命令」与「越界写入」会用。
		// 非交互环境直接拒绝，见 askApproval。
		onApproval: askApproval,
		// 方案评审只在交互终端里有意义；非交互时这个回调会明确要求模型把方案写成回答。
		onPlanReview: reviewPlan,
		onEvent:
			observe === undefined
				? render
				: (event: AgentEvent) => {
						observe(event);
						render(event);
					},
	});
	return runtime;
}

/** 交互模式：读一行、答一轮，直到用户退出 */
async function runInteractive(cwd: string, options: Options): Promise<number> {
	const session = openSession(cwd, options.continueSession);
	// 逐轮快照由运行时一并建好（一轮 = 一条用户指令，回滚的单位与人的直觉一致）。
	const { agent, checkpoints, jobs, subagents, todos, goals } = createCliRuntime(cwd, options, session);
	if (checkpoints === undefined) {
		// 交互模式一定有会话文件，快照必然建得出来；这句只为把类型收紧。
		throw new Error("交互模式缺少逐轮快照");
	}
	process.stderr.write(`${APP_NAME} ${VERSION}（模型 ${options.model}，输入 /help 查看命令）\n`);
	await startRepl({
		// 自定义命令目录：<配置目录>/commands
		commandsDir: join(getAgentDir(), "commands"),
		agent,
		session,
		checkpoints,
		// 终端也要能看到这些（/jobs、/subagents、待办与目标），它们就是工具层在改的那几份
		jobs,
		subagents,
		todos,
		goals,
		runTurn: (prompt, signal) => withCheckpoint(checkpoints, () => agent.prompt(prompt, signal)),
		// /review 用独立的一次性代理，不写会话、不改文件。
		review: async () => {
			const outcome = await runReview(createReviewRuntime(options, cwd), { cwd });
			return outcome.ok ? { ok: true, text: outcome.report } : { ok: false, text: `评审没能进行：${outcome.error}` };
		},
	});
	return 0;
}

/** 一次性模式：执行一条指令后退出 */
async function runOnce(cwd: string, options: Options, prompt: string): Promise<number> {
	// 一次性模式默认不留会话文件，避免把零散提问混进会话列表；
	// 只有显式 --continue 时才复用并续写最近的会话。
	const session = options.continueSession ? openSession(cwd, true) : null;
	// 这一轮到底成没成，只有事件流知道：接口报错、流被掐断、轮数用尽都会发 error 事件，
	// 而工具执行失败不是——它是正常一轮的一部分，不该让整条命令变成失败。
	let failed = false;
	const { agent, checkpoints } = createCliRuntime(cwd, options, session, (event) => {
		if (event.type === "error") {
			failed = true;
		}
	});

	const abort = new AbortController();
	let interrupted = false;
	process.on("SIGINT", () => {
		interrupted = true;
		abort.abort();
	});

	await withCheckpoint(checkpoints, () => agent.prompt(prompt, abort.signal));
	if (session) {
		for (const message of agent.messages.slice(1)) {
			session.append(message);
		}
	}
	if (interrupted) {
		return 130;
	}
	return failed ? 1 : 0;
}

/**
 * 程序入口，返回进程退出码。
 *
 * 退出码约定：0 正常结束，1 运行失败（接口报错、流被提前掐断、超过最大轮数），2 用法错误，
 * 130 用户中断。「工具执行失败」不算运行失败：模型拿到了失败结果并继续作答，那一轮是完整的。
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
	/*
	 * 子命令：第一个 token 命中注册表（`commands/registry.ts`）就交给它。
	 *
	 * 名字、用法片段与说明都住在命令自己的模块里，所以这里不再是一串 `if (argv[0] === …)`，
	 * 帮助文本也不必另抄一份——加一条命令只要动它自己的文件与注册表一行。
	 *
	 * **命令不解析 argv**：宿主把「解析全局选项」与「归一化 `--plan strict` 这类写法」这两件能力
	 * 交给它（`CommandHost`）。这一条也解开了循环依赖——命令模块不再 import `args.ts`。
	 *
	 * **没命中不算错**，继续当「一条指令」处理：`limkenion "把 README 的错别字改掉"` 是正式用法，
	 * 而它与打错子命令的第一个 token 长得一模一样，没法区分。
	 */
	const command = findCommand(argv[0]);
	if (command !== undefined) {
		return command.run(argv.slice(1), { parseGlobalOptions: parseOptions, normalizePlanArgv });
	}

	const options = parseOptions(argv);
	if (options === "usage-error") {
		return 2;
	}
	if (options === null) {
		return 0;
	}

	let prompt = options.prompt;
	if (prompt === undefined && !process.stdin.isTTY) {
		prompt = await readStdin();
	}

	if (options.apiKey === "") {
		process.stderr.write(
			"缺少 API Key。任选一种方式：\n" +
				`  ${APP_NAME} auth login              交互式输入并保存到本地（推荐，只需一次）\n` +
				"  设置环境变量 DEEPSEEK_API_KEY       适合 CI 或临时使用\n" +
				"  加 --api-key <key> 参数             只对本次运行有效\n" +
				"获取地址：https://platform.deepseek.com/api_keys\n",
		);
		return 1;
	}

	const cwd = process.cwd();
	if (prompt === undefined) {
		return runInteractive(cwd, options);
	}
	if (prompt === "") {
		process.stderr.write("没有收到指令内容\n");
		return 1;
	}

	return runOnce(cwd, options, prompt);
}

/**
 * 本文件是否被当作可执行入口直接运行。
 *
 * 不能直接比较字符串：Node 的 ESM 加载器会把 `import.meta.url` 解析成真实路径，而
 * `process.argv[1]` 是调用者给的那条路径。两者在 bin 启动器下并不相同——npm 生成的 shim
 * 从 `node_modules/.bin` 出发，工作区依赖是 junction，`npm link` 与 pnpm 用的是符号链接，
 * 于是 argv[1] 带链接而 import.meta.url 已解析，比较必然为假，CLI 会静默退出且退出码为 0。
 * 所以两侧都做一次 realpath 归一化。
 */
function isDirectRun(): boolean {
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		// 入口路径不存在或不可解析时按「不是直接运行」处理。
		return false;
	}
}

// 作为可执行文件直接运行时才启动，被 import 时不产生副作用。
if (isDirectRun()) {
	runCli()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			process.stderr.write(`未捕获的错误：${error instanceof Error ? error.stack : String(error)}\n`);
			process.exitCode = 1;
		});
}
