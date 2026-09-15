/**
 * 库层的兼容性契约。
 *
 * 这个仓库会自己改自己，所以「哪些东西不能悄悄动」必须写成会失败的测试，而不是写在文档里。
 * 这里钉两类：**已发布的导出**与**追加式文件格式的容忍度**（旧版本写的文件、将来版本写的文件，
 * 都要读得回来）。
 *
 * 导出面用**静态引用**逐个列出——这样删掉一个导出会直接变成编译错误，比运行时断言更早拦住人。
 * 加东西不需要改这里；真要删或改名，先走一轮弃用（保留旧名并标注），再动这张表。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as core from "../src/index.ts";

const surface = {
	// 主循环与工具
	Agent: core.Agent,
	createSystemTools: core.createSystemTools,
	toToolSpec: core.toToolSpec,
	// 审批与计划
	judgeToolUse: core.judgeToolUse,
	parseApprovalMode: core.parseApprovalMode,
	parsePlanMode: core.parsePlanMode,
	planSection: core.planSection,
	createExitPlanModeTool: core.createExitPlanModeTool,
	EXIT_PLAN_MODE_TOOL: core.EXIT_PLAN_MODE_TOOL,
	// 输出风格
	parseOutputStyle: core.parseOutputStyle,
	styleSection: core.styleSection,
	OUTPUT_STYLES: core.OUTPUT_STYLES,
	// 评审与并发
	REVIEW_FOCUSES: core.REVIEW_FOCUSES,
	buildReviewPrompt: core.buildReviewPrompt,
	buildSynthesisPrompt: core.buildSynthesisPrompt,
	parseReviewVerdict: core.parseReviewVerdict,
	runSubagents: core.runSubagents,
	// 文本与 JSON
	sliceByBytes: core.sliceByBytes,
	firstLine: core.firstLine,
	summarizeInline: core.summarizeInline,
	looksBinary: core.looksBinary,
	flattenWhitespace: core.flattenWhitespace,
	parseJsonObject: core.parseJsonObject,
	parseJsonLines: core.parseJsonLines,
	readJsonObject: core.readJsonObject,
	// 会话状态
	CheckpointStore: core.CheckpointStore,
	CHECKPOINT_SUFFIX: core.CHECKPOINT_SUFFIX,
	isCheckpointFile: core.isCheckpointFile,
	TodoList: core.TodoList,
	parseTodos: core.parseTodos,
	renderTodos: core.renderTodos,
	// 上下文管理
	estimateTokens: core.estimateTokens,
	estimateMessages: core.estimateMessages,
	needsCompaction: core.needsCompaction,
	pruneToolOutputs: core.pruneToolOutputs,
	calibrate: core.calibrate,
	estimateContextTokens: core.estimateContextTokens,
	// 提示词
	buildSystemPrompt: core.buildSystemPrompt,
};

describe("公共导出面", () => {
	it("承诺保留的名字一个都不能少", () => {
		const missing = Object.entries(surface)
			.filter(([, value]) => value === undefined || value === null)
			.map(([name]) => name);
		expect(missing).toEqual([]);
	});
});

describe("快照文件的追加式兼容", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("多出未知字段、末尾半行，都要能读回已写入的那几轮", () => {
		const dir = mkdtempSync(join(tmpdir(), "limkenion-compat-"));
		dirs.push(dir);
		const sessionFile = join(dir, "s.jsonl");
		writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "x", cwd: dir })}\n`, "utf-8");

		const store = new core.CheckpointStore(sessionFile);
		store.begin();
		store.capture(join(dir, "a.txt"), "旧内容");
		store.commit();

		// 模拟「新版本写的文件」：多一个本版本不认识的字段；再加一行被截断的半行。
		const original = core.readJsonObject(store.file);
		expect(original).not.toBeNull();
		writeFileSync(
			store.file,
			`${JSON.stringify({ ...original, futureField: { nested: true } })}\n{"seq":2,"at":"2026-01-01T00:00:00.000Z","fil`,
			"utf-8",
		);

		const reopened = new core.CheckpointStore(sessionFile);
		const snapshots = reopened.list();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.seq).toBe(1);
		expect(reopened.depth()).toBe(1);
	});
});
