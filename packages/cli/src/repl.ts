/**
 * 交互式循环。
 *
 * 用 readline 做最朴素的逐行输入：没有差分渲染、没有光标控制、没有键盘绑定。
 * 代价是界面朴素，收益是不需要维护 1.8 万行终端 UI 代码，也不会在陌生终端上花屏。
 */

import { createInterface } from "node:readline/promises";
import {
	type Agent,
	APPROVAL_MODES,
	type ApprovalMode,
	type CheckpointStore,
	describeApprovalPrefix,
	type GoalList,
	type JobRegistry,
	OUTPUT_STYLES,
	PLAN_MODES,
	type PlanMode,
	parseApprovalMode,
	parseOutputStyle,
	parsePlanMode,
	renderGoal,
	renderJobs,
	renderSubagentProgress,
	renderTodos,
	STYLE_GUIDE,
	type SubagentProgressTable,
	type TodoList,
} from "limkenion-core";
import { formatHit } from "./commands/search.ts";
import { getSessionsDir } from "./config.ts";
import {
	buildCommandPrompt,
	type CustomCommand,
	describeCustomCommands,
	findCustomCommand,
	listCustomCommands,
} from "./custom-commands.ts";
import { diffTurn, renderTurnDiff } from "./diff.ts";
import type { Session } from "./session.ts";
import { searchSessions } from "./session-search.ts";

/** REPL 里的搜索只给最近这些条，多了会把屏幕刷掉 */
const REPL_SEARCH_LIMIT = 10;

/** REPL 参数 */
export interface ReplOptions {
	agent: Agent;
	session: Session;
	/** 逐轮快照，供 /rewind 回滚 */
	checkpoints?: CheckpointStore;
	/**
	 * 运行时要用的几样东西（与浏览器界面同一份，由 `createRunRuntime` 建好）。
	 *
	 * 终端从前看不到它们：后台任务只能让模型去查、子代理进度压根没有、待办与目标只在工具结果里
	 * 一闪而过。同一份能力不该因为载体不同就少一块，所以这几个都接过来——`/jobs`、`/subagents`、
	 * `/todos` 直接读它们，读到的就是工具层在改的那几份。
	 */
	jobs?: JobRegistry;
	subagents?: SubagentProgressTable;
	todos?: TodoList;
	goals?: GoalList;
	/** 跑一轮；CLI 在里面包了快照的 begin/commit，REPL 只负责调用 */
	runTurn?: (prompt: string, signal: AbortSignal) => Promise<void>;
	/** 自定义命令目录（<配置目录>/commands） */
	commandsDir?: string;
	/** 对当前改动跑一轮多角度评审；返回报告文本 */
	review?: () => Promise<{ ok: boolean; text: string }>;
	/** 指令来源；默认 process.stdin，测试里换成可读流就不用真开终端 */
	input?: NodeJS.ReadableStream;
}

/** 帮助文本 */
const HELP = [
	"可用命令：",
	"  /help          显示本帮助",
	"  /quit          退出，也可按 Ctrl+D",
	"  /clear         清空上下文，保留当前会话文件",
	"/model <id>    切换模型，例如 /model deepseek-v4-pro",
	"  /rename [名字] 给这个会话起个名字（不带参数只报当前名字，`-` 取消命名）",
	"/history       显示当前上下文里的消息条数",
	"/diff [轮次]   看某一轮改了什么（不带参数=最近一轮），看完再决定撤不撤",
	"/rewind [轮数] 回滚对文件的改动（不带参数=最近一轮）",
	"/plan          切换计划模式（不带参数=严格档，也可 /plan guide 或 /plan off）",
	"/review        对当前改动跑一轮多角度代码评审",
	"/style [名字]  切换输出风格（不带参数只报当前风格）",
	"/approval [档位] 切换审批档位（不带参数只报当前档位）",
	"/compact [on|off] 开关上下文压缩（不带参数只报当前状态）",
	"/search <词>   在历史会话里搜内容",
	"/approvals     看本会话「总是允许」过哪些操作（/approvals clear 清空）",
	"/todos         看待办清单与目标（变了会在每轮结束时自动打一遍）",
	"/jobs          看后台任务（/jobs log <id> 看输出，/jobs kill <id> 停掉）",
	"/subagents     看子代理进度（/subagents stop 全部停下）",
	"",
	"Ctrl+C 中断正在进行的回答；在提示符下再按一次则退出。",
].join("\n");

/** 启动交互式循环，返回时表示用户主动退出 */
export async function startRepl(options: ReplOptions): Promise<void> {
	const { agent, session, checkpoints, runTurn, commandsDir = "", review, jobs, subagents, todos, goals } = options;
	// 自定义命令是「一个 Markdown 文件一条」，启动时读一次；改了文件重开即可。
	const commands = listCustomCommands(commandsDir);
	const rl = createInterface({ input: options.input ?? process.stdin, output: process.stderr });
	// 记录已经写进会话文件的位置，避免把启动时载入的历史重复追加。
	let persisted = agent.messages.length;
	let running: AbortController | null = null;
	// 待办与目标的指纹：一轮跑完只在它们**变了**的时候才把那两行重打一遍
	let work = workFingerprint(todos, goals);
	const commandContext: CommandContext = {
		agent,
		rl,
		session,
		checkpoints,
		commands,
		commandsDir,
		review,
		jobs,
		subagents,
		todos,
		goals,
	};

	const onSigint = (): void => {
		if (running) {
			running.abort();
			return;
		}
		process.stderr.write("\n");
		rl.close();
	};
	process.on("SIGINT", onSigint);

	try {
		for (;;) {
			let line: string;
			try {
				line = await rl.question("limkenion> ");
			} catch {
				// readline 在 Ctrl+D 或 close 时会 reject，视为退出。
				break;
			}

			const input = line.trim();
			if (input === "") {
				continue;
			}
			let prompt = input;
			if (input.startsWith("/")) {
				const outcome = await handleCommand(input, commandContext);
				if (outcome === true) {
					break;
				}
				if (typeof outcome === "string") {
					// 自定义命令：把它展开的提示词当成这一轮的输入，走同一条路径（快照、中断都一致）。
					prompt = outcome;
				} else {
					continue;
				}
			}

			running = new AbortController();
			try {
				await (runTurn ? runTurn(prompt, running.signal) : agent.prompt(prompt, running.signal));
			} finally {
				running = null;
			}

			/*
			 * 待办与目标变了就打一遍（网页那边是输入框上方那两行 dock）。
			 *
			 * 只在**变了**的时候打：模型每一轮都可能重写同一份清单，每轮都刷一遍会把刚看的东西顶跑；
			 * 而清单本身是「现在做到哪了」，跑完一轮看不见它，用户就只能往上翻工具结果。
			 */
			const now = workFingerprint(todos, goals);
			if (now !== work) {
				work = now;
				const text = describeWork(todos, goals);
				if (text !== "") {
					process.stderr.write(`${text}\n`);
				}
			}

			for (const message of agent.messages.slice(persisted)) {
				session.append(message);
			}
			persisted = agent.messages.length;
		}
	} finally {
		process.off("SIGINT", onSigint);
		persisted = appendRemaining(agent, session, persisted);
		rl.close();
	}
}

/**
 * 审批档位的人话（与网页顶栏那颗 chip 悬停时的说明同一个意思）。
 *
 * 「一个词决定行为的地方，必须就地给出后果说明」——只报 `ask` 两个字，用户不知道它到底管什么。
 */
const APPROVAL_GUIDE: Record<ApprovalMode, string> = {
	auto: "常规放行，只有疑似危险命令与越界写入会先问一句",
	ask: "每次读写前都确认（跑什么命令都问）",
	readonly: "只放行只读操作：read / grep / glob 与只读命令，其余一律拒绝",
};

/**
 * 切换计划模式后的回执：说清楚现在受什么约束，比一句「已切换」有用。
 */
function describePlanMode(mode: PlanMode): string {
	if (mode === "strict") {
		return "已进入计划模式（严格）：只放行 read / grep / glob，方案经 exit_plan_mode 批准后才动手";
	}
	if (mode === "guide") {
		return "已进入计划模式（引导）：工具不设限，但要求先出方案交给评审（/plan off 直接退出）";
	}
	return "已退出计划模式：可以改文件了";
}

/**
 * 一条斜杠命令要用到的东西，打成一个包。
 *
 * 从前是八个位置参数，加一样能力就要动全部调用点，而读的人分不清第 6 个是什么——
 * 与 `createRunRuntime` 用配置对象是同一个理由。
 */
interface CommandContext {
	agent: Agent;
	rl: { close: () => void };
	session: Session;
	checkpoints: CheckpointStore | undefined;
	commands: CustomCommand[];
	commandsDir: string;
	review: (() => Promise<{ ok: boolean; text: string }>) | undefined;
	jobs: JobRegistry | undefined;
	subagents: SubagentProgressTable | undefined;
	todos: TodoList | undefined;
	goals: GoalList | undefined;
}

/**
 * 处理一条斜杠命令。
 *
 * 返回 true 表示退出；返回字符串表示「把这段提示词当成一条用户指令跑一轮」；
 * 返回 false 表示已经处理完（或未知命令）。
 */
async function handleCommand(input: string, context: CommandContext): Promise<boolean | string> {
	const { agent, rl, session, checkpoints, commands, commandsDir, review, jobs, subagents, todos, goals } = context;
	const [name = "", ...rest] = input.slice(1).split(/\s+/);
	const argument = rest.join(" ").trim();
	/** 带子命令的命令用它拆：`/jobs log abc` → `["log", "abc"]` */
	const parts = argument === "" ? [] : argument.split(/\s+/);
	const sub = parts[0] ?? "";
	const subArgument = parts.slice(1).join(" ").trim();

	switch (name) {
		case "help":
			process.stderr.write(`${HELP}${describeCustomCommands(commands, commandsDir)}\n`);
			return false;
		case "quit":
		case "exit":
			rl.close();
			return true;
		case "clear":
			agent.reset();
			// 同时记进会话文件：只在内存里清，`--continue` 重开这个会话时旧对话会整段回来。
			session.markCleared();
			process.stderr.write("已清空上下文（会话文件仍保留，重开这个会话也不会带回旧对话）\n");
			return false;
		case "model":
			if (argument === "") {
				process.stderr.write(`当前模型：${agent.model}\n`);
			} else {
				agent.setModel(argument);
				process.stderr.write(`已切换模型：${argument}\n`);
			}
			return false;
		case "history":
			process.stderr.write(`当前上下文共 ${agent.messages.length - 1} 条消息\n`);
			return false;
		case "plan": {
			// 不带参数就是开关：关着就进严格档，开着（无论哪档）就退出。
			const requested = argument === "" ? (agent.planning ? "off" : "strict") : argument;
			const mode = parsePlanMode(requested);
			if (mode === undefined) {
				process.stderr.write(`未知的计划模式档位「${requested}」，可用：${PLAN_MODES.join(" / ")}\n`);
				return false;
			}
			agent.setPlanMode(mode);
			process.stderr.write(`${describePlanMode(mode)}\n`);
			return false;
		}
		case "search": {
			if (argument === "") {
				process.stderr.write("用法：/search <关键词>\n");
				return false;
			}
			const hits = searchSessions(getSessionsDir(), argument, { limit: REPL_SEARCH_LIMIT });
			if (hits.length === 0) {
				process.stderr.write(`没有找到「${argument}」\n`);
				return false;
			}
			// 结果是这次命令的产出，走 stdout；回看某个会话用 limkenion search。
			process.stdout.write(`${hits.map(formatHit).join("\n")}\n`);
			return false;
		}
		case "approvals": {
			// 记下的规则只在内存里，所以要能看到、能撤回——一个看不见的白名单等于没有白名单。
			if (argument === "clear") {
				const count = agent.approvals.size;
				agent.approvals.clear();
				process.stderr.write(`已忘掉 ${count} 条放行规则，这些操作会重新逐次确认\n`);
				return false;
			}
			const rules = agent.approvals.list();
			if (rules.length === 0) {
				process.stderr.write("本会话还没有「总是允许」的规则（确认提示里答 a 可以记下一条）\n");
				return false;
			}
			const lines = rules.map((rule) => `  ${rule.tool}：${describeApprovalPrefix(rule.tool, rule.prefix)}`);
			process.stderr.write(`本会话已放行（${rules.length} 条，/approvals clear 清空）：\n${lines.join("\n")}\n`);
			return false;
		}
		case "approval": {
			/*
			 * 审批档位从前只能启动时用 `--approval` 定：干活干到一半想「接下来每一步都让我看一眼」，
			 * 只能退出重开（网页那边顶栏一直有一颗 chip 可切）。这里补上同一个开关。
			 *
			 * 切换立刻生效：每次工具调用前都会重新读这个值，不必重建 Agent。
			 */
			if (argument === "") {
				process.stderr.write(`当前审批档位：${agent.approvalMode}（${APPROVAL_GUIDE[agent.approvalMode]}）\n`);
				return false;
			}
			if (!(APPROVAL_MODES as readonly string[]).includes(argument)) {
				process.stderr.write(
					`未知的审批档位「${argument}」，可用：${APPROVAL_MODES.map((mode) => `${mode}（${APPROVAL_GUIDE[mode]}）`).join(" / ")}\n`,
				);
				return false;
			}
			const mode = parseApprovalMode(argument);
			agent.setApprovalMode(mode);
			process.stderr.write(`已切换审批档位：${mode}（${APPROVAL_GUIDE[mode]}）\n`);
			return false;
		}
		case "compact": {
			// 压缩开关同理：从前只有 `--no-compact`，排查「压缩是不是丢了我要的东西」要重启。
			if (argument === "") {
				process.stderr.write(
					`上下文压缩：${agent.compactionEnabled ? "开" : "关"}（/compact on 打开，/compact off 关掉）\n`,
				);
				return false;
			}
			if (argument !== "on" && argument !== "off") {
				process.stderr.write(`用法：/compact on|off（不带参数只报当前状态）\n`);
				return false;
			}
			agent.setCompaction(argument === "on");
			process.stderr.write(
				argument === "on"
					? "已打开上下文压缩：超过阈值时先裁剪旧工具输出，再摘要\n"
					: "已关掉上下文压缩：上下文只会一直变长，直到撞上窗口上限（排查压缩丢内容时才这样用）\n",
			);
			return false;
		}
		case "style": {
			// 不带参数只报当前风格，不动它——问「现在是什么」比误切一次更常见。
			if (argument === "") {
				process.stderr.write(`当前输出风格：${agent.style}（${STYLE_GUIDE[agent.style]}）\n`);
				return false;
			}
			const style = parseOutputStyle(argument);
			if (style === undefined) {
				process.stderr.write(
					`未知的输出风格「${argument}」，可用：${OUTPUT_STYLES.map((name) => `${name}（${STYLE_GUIDE[name]}）`).join(" / ")}\n`,
				);
				return false;
			}
			agent.setStyle(style);
			process.stderr.write(`已切换输出风格：${style}（${STYLE_GUIDE[style]}）\n`);
			return false;
		}
		case "rename": {
			// 给当前这个会话起个名字：会话行的 `▾` 菜单在网页上有，终端这边原来只能靠首条消息认。
			// `-` 表示取消命名（名字要能取消，否则起错了没法回到「用首条消息当标题」）。
			if (argument === "") {
				const title = session.header.title ?? "";
				process.stderr.write(
					title === ""
						? "这个会话还没有名字（列表里显示首条消息）：/rename <名字>\n"
						: `这个会话的名字：${title}（/rename - 取消命名）\n`,
				);
				return false;
			}
			const title = argument === "-" ? "" : argument;
			session.setTitle(title);
			process.stderr.write(title === "" ? "已取消命名\n" : `已命名为：${title}\n`);
			return false;
		}
		case "jobs": {
			// 后台任务是**真进程**：看不见就只能等它自己结束，所以列出来、能看日志、能停。
			if (!jobs) {
				process.stderr.write("当前模式没有后台任务入口\n");
				return false;
			}
			if (sub === "log") {
				const tail = subArgument === "" ? null : jobs.readTail(subArgument);
				if (tail === null) {
					process.stderr.write(`没有这个后台任务：${subArgument}（/jobs 看列表）\n`);
					return false;
				}
				// 日志是这次命令要看的正文，走 stdout。
				process.stdout.write(`${tail.text}\n`);
				if (tail.truncated) {
					process.stderr.write(`（只看得到最后一段，完整输出在任务输出文件里）\n`);
				}
				return false;
			}
			if (sub === "kill") {
				const killed = subArgument !== "" && jobs.kill(subArgument);
				process.stderr.write(killed ? `已停止 ${subArgument}\n` : `没有正在跑的 ${subArgument}（/jobs 看列表）\n`);
				return false;
			}
			process.stderr.write(`${renderJobs(jobs.list())}\n`);
			if (jobs.list().length > 0) {
				process.stderr.write("（/jobs log <id> 看输出，/jobs kill <id> 停掉）\n");
			}
			return false;
		}
		case "subagents": {
			// 子代理是独立的模型循环：只看得到「在跑」还不够，得能停——它们会一直烧 token。
			if (!subagents) {
				process.stderr.write("当前模式没有子代理入口\n");
				return false;
			}
			if (sub === "stop") {
				subagents.stopAll();
				process.stderr.write("已请求停止正在跑的子代理（跑完当前这一步就停）\n");
				return false;
			}
			process.stderr.write(`${renderSubagentProgress(subagents.list())}\n`);
			if (subagents.runningCount() > 0) {
				process.stderr.write("（/subagents stop 全部停下来）\n");
			}
			return false;
		}
		case "todos": {
			// 待办与目标本来只在工具结果里一闪而过，而它们恰恰是「现在做到哪了」。
			const text = describeWork(todos, goals);
			process.stderr.write(text === "" ? "现在没有待办，也没有设目标\n" : `${text}\n`);
			return false;
		}
		case "review": {
			if (!review) {
				process.stderr.write("当前模式没有评审入口\n");
				return false;
			}
			process.stderr.write("正在评审当前改动（几个评审者并行跑）…\n");
			const outcome = await review();
			// 报告是这次命令的结果，走 stdout；失败原因也打出来，免得像是什么都没发生。
			process.stdout.write(`${outcome.text}\n`);
			return false;
		}
		case "diff": {
			/*
			 * 先看再撤：`/rewind` 是「闭着眼睛撤」，而撤之前该看得见要撤掉什么。
			 * 网页那边是「历史」面板里逐轮的 diff + 每段头上的回滚按钮，这里给出同一份差异
			 * （`diffTurn` / `renderTurnDiff`，与历史面板同一份算法），只是排成文本。
			 */
			const snapshots = checkpoints?.list() ?? [];
			if (snapshots.length === 0) {
				process.stderr.write("还没有可看的轮次（这一轮改动会在跑完后才记下快照）\n");
				return false;
			}
			const wanted = argument === "" ? (snapshots.at(-1)?.seq ?? 0) : Number(argument);
			if (!Number.isInteger(wanted) || wanted < 1) {
				process.stderr.write(`用法：/diff [轮次]（不带参数看最近一轮；现在有第 ${seqList(snapshots)} 轮）\n`);
				return false;
			}
			const snapshot = snapshots.find((item) => item.seq === wanted);
			if (snapshot === undefined) {
				process.stderr.write(`第 ${wanted} 轮没有快照（现在有第 ${seqList(snapshots)} 轮）\n`);
				return false;
			}
			// 差异是这次命令要看的正文，走 stdout；/rewind 的提示走 stderr。
			const { files, omitted } = diffTurn(snapshot, session.header.cwd);
			process.stdout.write(`${renderTurnDiff(snapshot.seq, snapshot.at, files, omitted)}\n`);
			// 回滚只能从最近一轮往回撤，所以提示里给的是「从最近撤到这一轮需要撤几轮」，
			// 而不是一句没用的「/rewind」——第 1 轮的改动在第 3 轮时要撤 3 次。
			const behind = (snapshots.at(-1)?.seq ?? snapshot.seq) - snapshot.seq + 1;
			process.stderr.write(`（撤掉这一轮及其之后共 ${behind} 轮：/rewind${behind > 1 ? ` ${behind}` : ""}）\n`);
			return false;
		}
		case "rewind": {
			// 带轮数与 `limkenion rewind <n>` 是同一套语义：从最近一轮往回撤 n 轮。
			const times = argument === "" ? 1 : Number(argument);
			if (!Number.isInteger(times) || times < 1) {
				process.stderr.write("用法：/rewind [轮数]（不带参数撤最近一轮）\n");
				return false;
			}
			let rounds = 0;
			let restored = 0;
			let removed = 0;
			let skipped: string[] = [];
			for (let i = 0; i < times; i++) {
				const result = checkpoints?.rewind() ?? null;
				if (!result) {
					break;
				}
				rounds += 1;
				restored += result.restored.length;
				removed += result.removed.length;
				skipped = result.skipped;
			}
			if (rounds === 0) {
				process.stderr.write("没有可回滚的轮次\n");
				return false;
			}
			// 回滚属于状态信息，按输出约定走 stderr。
			process.stderr.write(`已回滚 ${rounds} 轮的改动：改回 ${restored} 个文件`);
			if (removed > 0) {
				process.stderr.write(`，删除 ${removed} 个新建文件`);
			}
			if (skipped.length > 0) {
				process.stderr.write(`；${skipped.length} 个文件无法回滚：${skipped.join(", ")}`);
			}
			process.stderr.write("\n");
			return false;
		}
		default: {
			const custom = findCustomCommand(commands, name);
			if (custom) {
				return buildCommandPrompt(custom, argument);
			}
			process.stderr.write(`未知命令 /${name}，输入 /help 查看可用命令（自定义命令放在 ${commandsDir}）\n`);
			return false;
		}
	}
}

/** 退出前把尚未落盘的消息补写进会话文件 */
function appendRemaining(agent: Agent, session: Session, persisted: number): number {
	for (const message of agent.messages.slice(persisted)) {
		session.append(message);
	}
	return agent.messages.length;
}

/**
 * 待办与目标的人话；两样都没有时返回空串（调用方自己决定说什么）。
 *
 * 渲染复用内核那两份（`renderTodos` / `renderGoal`）：与工具结果里给模型看的、网页 dock 上显示的
 * 是同一套说法，免得同一件事在三个地方三种讲法。
 */
function describeWork(todos: TodoList | undefined, goals: GoalList | undefined): string {
	const parts: string[] = [];
	const goal = goals?.current ?? null;
	if (goal !== null) {
		parts.push(renderGoal(goal));
	}
	const items = todos?.list() ?? [];
	if (items.length > 0) {
		parts.push(renderTodos(items));
	}
	return parts.join("\n");
}

/** 待办与目标的指纹：一轮跑完只在**变了**的时候才重打一遍，免得每轮都刷屏 */
function workFingerprint(todos: TodoList | undefined, goals: GoalList | undefined): string {
	return JSON.stringify({ todos: todos?.list() ?? [], goal: goals?.current ?? null });
}

/** 快照轮次的列表，用在「现在有第几轮」这类提示里 */
function seqList(snapshots: readonly { seq: number }[]): string {
	return snapshots.map((snapshot) => snapshot.seq).join("、");
}
