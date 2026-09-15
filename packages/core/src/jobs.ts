/**
 * 后台任务。
 *
 * 与 `bash` 的分工：**bash 是「等它跑完再回话」**（有超时、输出直接进对话）；**后台任务是「先跑着，我接着
 * 干别的」**（构建、整包测试、本地服务）。所以它单独一个模块、自己做收尾，三条设计：
 *
 * 1. **进程按进程组起**（`DETACH_FOR_KILL`：POSIX 下 `detached`、Windows 下交给 `taskkill /T`），
 *    这样 `job_kill` 收得掉整棵树，不会留下一个还在写盘的孙进程；
 * 2. **输出落文件**而不是攒在内存里——一条 `npm run build` 几十 MB，攒住等于把内存交给使用者；
 *    文件超过上限就**终止进程并在记录里写明截断**（与 bash 的 `MAX_OUTPUT_BYTES` 同一个态度）；
 * 3. **只允许同时跑几条**（默认 4）：后台任务的用处是「并行几件事」，不是「开一堆把机器压死」。
 *
 * 状态说人话放在渲染里（running / done / failed / killed → 运行中 / 已完成 / 失败 / 已停止）。
 */

import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETACH_FOR_KILL, decodeProcessOutput, killProcessTree } from "./process.ts";
import { defineTool } from "./tools/contract.ts";
import type { AgentTool } from "./types.ts";

/** 任务状态 */
export type JobStatus = "running" | "done" | "failed" | "killed";

const STATUS_LABELS: Record<JobStatus, string> = {
	running: "运行中",
	done: "已完成",
	failed: "失败",
	killed: "已停止",
};

/** 同时在跑的上限 */
export const MAX_JOBS = 4;

/** 单条输出文件的上限（超过就终止并记截断） */
export const MAX_JOB_BYTES = 20 * 1024 * 1024;

/** 读尾巴时最多从文件末尾读多少字节（够几百行，又不至于把 20MB 全读进内存） */
export const TAIL_READ_BYTES = 256 * 1024;

/** 日志查看器默认给多少行 */
export const DEFAULT_TAIL_LINES = 200;

/** 一次最多给多少行（再多就不该在浮层里看了） */
export const MAX_TAIL_LINES = 1000;

/** 一条后台任务 */
export interface JobRecord {
	id: string;
	command: string;
	cwd: string;
	/** 起始时刻（毫秒） */
	startedAt: number;
	status: JobStatus;
	/** 退出码；还在跑或被杀时为 null */
	exitCode: number | null;
	/** 输出文件绝对路径 */
	outputPath: string;
	/** 已写入的字节数 */
	bytes: number;
	/** 是否因为超过上限被截断 */
	truncated: boolean;
}

/** 渲染成人话；没有任务时给一句说明 */
export function renderJobs(jobs: JobRecord[]): string {
	if (jobs.length === 0) {
		return "没有后台任务。";
	}
	return jobs
		.map((job) => {
			const seconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
			const code = job.exitCode === null ? "" : `，退出码 ${job.exitCode}`;
			const cut = job.truncated ? "，输出已截断" : "";
			return `[${job.id}] ${STATUS_LABELS[job.status]}（${seconds} 秒${code}${cut}）：${job.command}\n    输出：${job.outputPath}`;
		})
		.join("\n");
}

/**
 * 后台任务注册表。
 *
 * 进程句柄不放进 `JobRecord`（那要能交给界面看的纯数据），单独一张私有表存着，`kill` 才拿得到。
 */
export class JobRegistry {
	private readonly records = new Map<string, JobRecord>();
	private readonly children = new Map<string, ReturnType<typeof spawn>>();
	private readonly outputDir: string;
	private readonly defaultCwd: string;
	private readonly maxJobs: number;
	private readonly maxBytes: number;
	private counter = 0;

	constructor(options: { cwd?: string; outputDir?: string; maxJobs?: number; maxBytes?: number } = {}) {
		this.defaultCwd = options.cwd ?? process.cwd();
		this.outputDir = options.outputDir ?? join(tmpdir(), "limkenion-jobs");
		this.maxJobs = options.maxJobs ?? MAX_JOBS;
		this.maxBytes = options.maxBytes ?? MAX_JOB_BYTES;
		try {
			mkdirSync(this.outputDir, { recursive: true });
		} catch {
			// 建不出来就让 start() 在写文件那一步报错，这里不拦
		}
	}

	/** 当前所有任务（先跑的在前面） */
	list(): JobRecord[] {
		return [...this.records.values()].map((job) => ({ ...job }));
	}

	/** 在跑的任务数 */
	runningCount(): number {
		return [...this.records.values()].filter((job) => job.status === "running").length;
	}

	/**
	 * 读某条任务的输出**尾巴**（界面那颗日志查看器用）。
	 *
	 * 只从文件末尾读 `TAIL_READ_BYTES` 字节：一条构建的输出可以到 20MB，为了看最后 200 行把整份读进内存
	 * 不值得。读到的是**字节**，交给 `decodeProcessOutput` 解（Windows 上 cmd 内建命令按控制台代码页写字，
	 * 按 UTF-8 硬解会是替换字符）。返回 null 表示这条任务没有输出文件。
	 */
	readTail(id: string, maxLines = DEFAULT_TAIL_LINES): { text: string; bytes: number; truncated: boolean } | null {
		const job = this.records.get(id);
		if (job === undefined) {
			return null;
		}
		let size = 0;
		try {
			size = statSync(job.outputPath).size;
		} catch {
			return null;
		}
		const start = Math.max(0, size - TAIL_READ_BYTES);
		let buffer = Buffer.alloc(0);
		try {
			const fd = openSync(job.outputPath, "r");
			try {
				buffer = Buffer.alloc(Math.min(size - start, TAIL_READ_BYTES));
				readSync(fd, buffer, 0, buffer.length, start);
			} finally {
				closeSync(fd);
			}
		} catch {
			return null;
		}
		// 从中间切开时第一行通常是半行：丢掉它（除非正好从文件开头读）
		const lines = decodeProcessOutput(buffer).split(/\r?\n/);
		if (start > 0 && lines.length > 0) {
			lines.shift();
		}
		const want = Math.max(1, Math.min(maxLines, MAX_TAIL_LINES));
		const truncated = start > 0 || lines.length > want;
		return { text: lines.slice(-want).join("\n"), bytes: size, truncated };
	}

	/** 起一条；命令为空、超过并发上限、或起不来时抛错（调用方把 message 交给模型） */
	start(command: string, cwd?: string): JobRecord {
		const trimmed = command.trim();
		if (trimmed === "") {
			throw new Error("命令不能为空");
		}
		if (this.runningCount() >= this.maxJobs) {
			throw new Error(`同时最多 ${this.maxJobs} 条后台任务：先等一条结束，或者用 job_kill 收掉一条`);
		}
		this.counter += 1;
		const id = `job-${this.counter}`;
		const outputPath = join(this.outputDir, `${id}.log`);
		const record: JobRecord = {
			id,
			command: trimmed,
			cwd: cwd ?? this.defaultCwd,
			startedAt: Date.now(),
			status: "running",
			exitCode: null,
			outputPath,
			bytes: 0,
			truncated: false,
		};

		// 输出按**字节**落盘（不做编码转换）：读的人再按系统代码页解，写的人不猜
		const stream = createWriteStream(outputPath);
		const child = spawn(trimmed, {
			cwd: record.cwd,
			shell: true,
			detached: DETACH_FOR_KILL,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.records.set(id, record);
		this.children.set(id, child);

		const collect = (chunk: Buffer): void => {
			record.bytes += chunk.length;
			stream.write(chunk);
			if (record.bytes > this.maxBytes && !record.truncated) {
				record.truncated = true;
				// 与 bash 一个态度：超上限不是背景静默，而是当场终止并说明
				killProcessTree(child);
			}
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);

		child.on("error", (error: Error) => {
			record.status = "failed";
			record.exitCode = null;
			stream.write(`\n[进程起不来] ${error.message}\n`);
			stream.end();
		});
		child.on("exit", (code, signal) => {
			if (record.status === "running") {
				// 被我们 killProcessTree 收掉的（截断或 job_kill）走 killed，其余按退出码判
				record.status = signal !== null && code === null ? "killed" : code === 0 ? "done" : "failed";
				record.exitCode = code ?? null;
			}
			stream.end();
			this.children.delete(id);
		});
		return { ...record };
	}

	/** 收掉一条；返回是否真的发了信号（已经在跑的才算） */
	kill(id: string): boolean {
		const child = this.children.get(id);
		const record = this.records.get(id);
		if (child === undefined || record === undefined || record.status !== "running") {
			return false;
		}
		record.status = "killed";
		record.exitCode = null;
		killProcessTree(child);
		return true;
	}

	/** 收掉全部（进程退出前用；换会话、关服务时调用） */
	killAll(): void {
		for (const id of [...this.children.keys()]) {
			this.kill(id);
		}
	}
}

/** 创建后台任务工具：起一条 / 列出 / 收掉一条 */
export function createJobTools(jobs: JobRegistry): AgentTool[] {
	return [
		// 起后台任务 = 跑任意命令：既不算只读，也不与任何调用并发。计划模式（严格）与只读档下
		// 它都会被判定链拦下——这一点从前是缺失的，模型用 job_start 就能绕过计划模式。
		defineTool({
			name: "job_start",
			description:
				"起一条后台任务（构建、整包测试、本地服务这类「要跑一会儿」的命令），立刻返回，不占着这一轮。" +
				`输出写到文件里，用 job_list 看状态、job_kill 收掉。同时最多 ${MAX_JOBS} 条。`,
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "要跑的命令（交给系统 shell）" },
					cwd: { type: "string", description: "在哪个目录跑；不填按当前工作目录" },
				},
				required: ["command"],
			},
			summarize: (input) => (typeof input.command === "string" ? input.command : ""),
			validate: (input) =>
				typeof input.command === "string" && input.command.trim() !== ""
					? { ok: true }
					: { ok: false, message: "缺少必填参数 command" },
			async execute(input) {
				const command = typeof input.command === "string" ? input.command : "";
				const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
				try {
					const job = jobs.start(command, cwd);
					return { content: `已起：${renderJobs([job])}`, isError: false };
				} catch (error) {
					return { content: error instanceof Error ? error.message : String(error), isError: true };
				}
			},
		}),
		defineTool({
			name: "job_list",
			description: "列出后台任务（状态、耗时、退出码、输出文件路径）。输出文件要用 read 去看。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			alwaysReadOnly: true,
			isConcurrencySafe: () => true,
			async execute() {
				return { content: renderJobs(jobs.list()), isError: false };
			},
		}),
		// 收掉一条只是停掉自己起的东西，不改工作区：任何档位都放行，否则只读档下会攒一堆收不掉的进程。
		defineTool({
			name: "job_kill",
			description: "收掉一条后台任务（连同它起的子进程一起收）。任务已经结束时返回一句说明。",
			parameters: {
				type: "object",
				properties: { id: { type: "string", description: "job_start / job_list 给的 id" } },
				required: ["id"],
			},
			alwaysReadOnly: true,
			isConcurrencySafe: () => true,
			summarize: (input) => (typeof input.id === "string" ? input.id : ""),
			validate: (input) =>
				typeof input.id === "string" && input.id !== "" ? { ok: true } : { ok: false, message: "缺少必填参数 id" },
			async execute(input) {
				const id = typeof input.id === "string" ? input.id : "";
				const killed = jobs.kill(id);
				return killed
					? { content: `已停止 ${id}`, isError: false }
					: { content: `${id} 不在运行中（可能已经结束，用 job_list 看）`, isError: false };
			},
		}),
	];
}
