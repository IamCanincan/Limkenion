/**
 * write 工具：新建或整体覆盖文件。
 *
 * 只做整文件写入，局部修改请用 edit。这样职责清晰：write 的语义是「这个文件的内容
 * 就是这些」，不会因为模型漏抄上下文而悄悄丢代码。
 *
 * 安全姿态全部来自契约的 fail-closed 默认值：没有声明 `isReadOnly`，所以它是「会写」；
 * 没有声明 `isConcurrencySafe`，所以它不与任何调用并排跑。并发调度不做按路径的互斥，
 * 两个写同一文件的调用并排跑必然有一个基于过期内容——默认值就是这条保证。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CheckpointStore } from "../checkpoints.ts";
import { defineTool } from "./contract.ts";
import type { ReadEvidence } from "./evidence.ts";
import { APPROVAL_PREVIEW_LINES, resolveUserPath } from "./path.ts";

/** write 工具的可配置项 */
export interface WriteToolOptions {
	/** 读取证据表：覆盖已存在的文件前要先读过 */
	evidence?: ReadEvidence;
	/** 逐轮快照：把改动前的内容记下来，供 /rewind 回滚 */
	checkpoints?: CheckpointStore;
	/** 工作目录 */
	cwd: string;
}

/** 创建 write 工具 */
export function createWriteTool(options: WriteToolOptions) {
	return defineTool({
		name: "write",
		description:
			"把内容写入文件，文件不存在则新建，存在则整体覆盖，父目录会自动创建。" +
			"修改已有文件的局部内容请改用 edit，不要用 write 重写整个文件。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "文件路径，相对路径以工作目录为基准" },
				content: { type: "string", description: "写入文件的完整内容" },
			},
			required: ["path", "content"],
		},
		// 整体覆盖是这一批工具里最不可逆的一件事：界面据此把这行画得显眼一点。
		isDestructive: () => true,
		// 摘要里带上行数：写入的体量是这一行最便宜的信号，而内容就在入参里，不必等工具结果。
		// 界面上那一行只显示 `summarize()`，所以「N 行」归工具自己说，前端不再认 `content` 这个字段名。
		summarize: (input) => {
			const path = typeof input.path === "string" ? input.path : "";
			if (typeof input.content !== "string") {
				return path;
			}
			const lines = `${input.content.split("\n").length} 行`;
			return path === "" ? lines : `${path}（${lines}）`;
		},
		/**
		 * 确认卡片的正文：把要写入的内容摊开给用户看（前若干行）。
		 *
		 * 从前这段按工具名住在网页前端（`render.js` 的 `describeApprovalInput` 读 `path` /
		 * `content`），于是「哪个字段最要紧」的知识服务端与浏览器各一份。现在归工具自己说。
		 */
		describeApproval: (input) => {
			const path = typeof input.path === "string" ? input.path : "";
			if (typeof input.content !== "string") {
				return path === "" ? "" : `将要写入：${path}`;
			}
			const lines = input.content.split("\n");
			const shown = lines.slice(0, APPROVAL_PREVIEW_LINES);
			const more = lines.length > shown.length ? `\n… 还有 ${lines.length - shown.length} 行` : "";
			return `将要写入：${path}\n（共 ${lines.length} 行，下面显示前 ${shown.length} 行）\n${shown.join("\n")}${more}`;
		},
		pathOf: (input) => (typeof input.path === "string" && input.path.trim() !== "" ? input.path.trim() : null),
		/**
		 * 整份替换：界面据此在确认卡片上补一节「前后对比」。
		 *
		 * 与 `describeApproval` 同一件事的两面——那边是「要写什么」，这边是「拿磁盘上那一份比一比」。
		 * 从前这一步由网页认 `write` 这个名字并读 `input.path` / `input.content`。
		 */
		fileReplacement: (input) => {
			const path = typeof input.path === "string" ? input.path.trim() : "";
			return path === "" || typeof input.content !== "string" ? null : { path, content: input.content };
		},
		validate: (input) => {
			if (typeof input.path !== "string" || input.path.trim() === "") {
				return { ok: false, message: "缺少必填参数 path" };
			}
			return typeof input.content === "string" ? { ok: true } : { ok: false, message: "缺少必填参数 content" };
		},
		async execute(input) {
			const rawPath = (input.path as string).trim();
			const content = input.content as string;
			const absolute = resolveUserPath(rawPath, options.cwd);
			// 新建文件不需要证据；覆盖已存在的内容必须先读过，避免整篇盖掉别人的改动。
			const existing = await readFile(absolute, "utf-8").catch(() => null);
			// 新建文件也记一条（内容是 null），回滚时据此把它删掉。
			options.checkpoints?.capture(absolute, existing);
			if (existing !== null) {
				const problem = options.evidence?.check(absolute, existing);
				if (problem) {
					return { content: problem, isError: true };
				}
			}
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, content, "utf-8");
			options.evidence?.record(absolute, content);
			const lines = content.split("\n").length;
			return { content: `已写入 ${rawPath}（${lines} 行）`, isError: false };
		},
	});
}
