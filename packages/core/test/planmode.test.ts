/**
 * 计划模式的判定、开关与评审退出。
 *
 * 纯函数部分不需要模型：判定规则与提示词段落直接测。评审部分用桩回调把三条路径
 * （批准 / 退回 / 没有评审通道）都走一遍，再看 Agent 的状态有没有跟着变。
 */

import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { judgeToolUse } from "../src/permissions/chain.ts";
import { createExitPlanModeTool, EXIT_PLAN_MODE_TOOL, planSection } from "../src/plan.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createGlobTool, createGrepTool } from "../src/tools/search.ts";
import { createWriteTool } from "../src/tools/write.ts";
import type { AgentTool } from "../src/types.ts";

const cwd = process.platform === "win32" ? "D:\\work\\proj" : "/work/proj";
const read = createReadTool({ cwd });
const grep = createGrepTool({ cwd });
const glob = createGlobTool({ cwd });
const write = createWriteTool({ cwd });
const edit = createEditTool({ cwd });
const bash = createBashTool({ cwd });
const MUTATIONS: readonly (readonly [AgentTool, Record<string, unknown>])[] = [
	[write, { path: "a.ts", content: "x" }],
	// 空 edits 也走计划模式那条拒绝：「只拒绝」的判定（计划模式严格、只读档、空补丁）排在
	// 「只升档」的判定之前，而计划模式又排在空补丁之前，所以理由说的是计划模式。
	[edit, { path: "a.ts", edits: [] }],
	[bash, { command: "rm -rf x" }],
];

describe("严格档的工具判定", () => {
	it("只读工具照常放行", () => {
		for (const tool of [read, grep, glob]) {
			expect(judgeToolUse({ tool, input: { path: "a.ts" }, mode: "auto", planMode: "strict", cwd }).behavior).toBe(
				"allow",
			);
		}
	});

	it("改文件与执行命令一律拒绝，并提示用 exit_plan_mode 交方案", () => {
		for (const [tool, input] of MUTATIONS) {
			const verdict = judgeToolUse({ tool, input, mode: "auto", planMode: "strict", cwd });
			expect(verdict.behavior, tool.name).toBe("deny");
			expect(verdict.reason, tool.name).toEqual({ type: "plan" });
			expect(verdict.message, tool.name).toContain("计划模式");
			expect(verdict.message, tool.name).toContain(EXIT_PLAN_MODE_TOOL);
		}
	});

	it("严格档优先于审批模式：ask 下也是拒绝而不是询问", () => {
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts" }, mode: "ask", planMode: "strict", cwd }).behavior,
		).toBe("deny");
		// 越界信息仍然带出来，便于批准后继续判断
		expect(
			judgeToolUse({ tool: write, input: { path: "../x.ts" }, mode: "auto", planMode: "strict", cwd })
				.outsideWorkspace,
		).toBe(true);
	});
});

describe("引导档的工具判定", () => {
	it("不做拦截，按普通审批模式判定：引导靠提示词，约束交给审批与沙箱", () => {
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts" }, mode: "auto", planMode: "guide", cwd }).behavior,
		).toBe("allow");
		expect(judgeToolUse({ tool: write, input: { path: "a.ts" }, mode: "ask", planMode: "guide", cwd }).behavior).toBe(
			"ask",
		);
		expect(
			judgeToolUse({ tool: write, input: { path: "a.ts" }, mode: "readonly", planMode: "guide", cwd }).behavior,
		).toBe("deny");
	});

	it("关闭时行为不变", () => {
		expect(judgeToolUse({ tool: write, input: { path: "a.ts" }, mode: "auto", planMode: "off", cwd }).behavior).toBe(
			"allow",
		);
		expect(judgeToolUse({ tool: write, input: { path: "a.ts" }, mode: "ask", planMode: "off", cwd }).behavior).toBe(
			"ask",
		);
	});
});

describe("提示词段落", () => {
	it("按档位给出不同的约束说明，关闭时为空", () => {
		expect(planSection("off")).toBe("");
		expect(planSection("strict")).toContain("严格");
		expect(planSection("strict")).toContain(EXIT_PLAN_MODE_TOOL);
		expect(planSection("guide")).toContain("引导");
		expect(planSection("guide")).toContain(EXIT_PLAN_MODE_TOOL);
	});
});

describe("exit_plan_mode 工具", () => {
	const longPlan =
		"目标是给配置加一层校验：改 packages/core/src/config.ts 与它的测试，风险是默认值变化，用 npm run check 验证。";
	function tool(overrides: Partial<Parameters<typeof createExitPlanModeTool>[0]> = {}) {
		return createExitPlanModeTool({
			isPlanning: () => true,
			review: async () => ({ approved: true }),
			onApproved: () => undefined,
			...overrides,
		});
	}

	it("批准后离开计划模式，并返回正常结果", async () => {
		let left = false;
		const outcome = await tool({
			onApproved: () => {
				left = true;
			},
		}).execute({ plan: longPlan }, new AbortController().signal);
		expect(outcome.isError).toBe(false);
		expect(outcome.content).toContain("批准");
		expect(left).toBe(true);
	});

	it("退回算失败调用，把反馈原样交给模型", async () => {
		const outcome = await tool({
			review: async () => ({ approved: false, feedback: "先说明为什么不改测试" }),
		}).execute({ plan: longPlan }, new AbortController().signal);
		expect(outcome.isError).toBe(true);
		expect(outcome.content).toContain("先说明为什么不改测试");
	});

	it("不在计划模式、方案太短、没有评审通道都给出可读的失败", async () => {
		const outside = await tool({ isPlanning: () => false }).execute({ plan: longPlan }, new AbortController().signal);
		expect(outside.content).toContain("不在计划模式");

		const short = await tool().execute({ plan: "改一下" }, new AbortController().signal);
		expect(short.isError).toBe(true);
		expect(short.content).toContain("太短");

		const bare = createExitPlanModeTool({ isPlanning: () => true, onApproved: () => undefined });
		const outcome = await bare.execute({ plan: longPlan }, new AbortController().signal);
		expect(outcome.content).toContain("没有方案评审入口");
	});
});

describe("Agent 的开关与工具挂载", () => {
	it("默认关闭，可随时切换档位", () => {
		const agent = new Agent({ apiKey: "sk-test", cwd, tools: [] });
		expect(agent.planning).toBe(false);
		expect(agent.plan).toBe("off");
		agent.setPlanMode("strict");
		expect(agent.planning).toBe(true);
		expect(agent.plan).toBe("strict");
		agent.setPlanMode("off");
		expect(agent.planning).toBe(false);
	});

	it("构造时可以直接以某个档位启动，并把引导段落写进系统提示词", () => {
		const agent = new Agent({ apiKey: "sk-test", cwd, tools: [], planMode: "guide" });
		expect(agent.planning).toBe(true);
		expect(agent.messages[0]?.role === "system" ? agent.messages[0].content : "").toContain("计划模式（引导）");
	});

	it("切档会重算系统提示词", () => {
		const agent = new Agent({ apiKey: "sk-test", cwd, tools: [] });
		const before = agent.messages[0]?.role === "system" ? agent.messages[0].content : "";
		agent.setPlanMode("strict");
		const after = agent.messages[0]?.role === "system" ? agent.messages[0].content : "";
		expect(before).not.toContain("计划模式");
		expect(after).toContain("计划模式（严格）");
	});

	it("有评审入口才挂 exit_plan_mode", () => {
		const withReview = new Agent({
			apiKey: "sk-test",
			cwd,
			tools: [],
			onPlanReview: async () => ({ approved: true }),
		});
		expect(withReview.messages[0]?.role === "system" ? withReview.messages[0].content : "").toContain(
			EXIT_PLAN_MODE_TOOL,
		);

		const without = new Agent({ apiKey: "sk-test", cwd, tools: [] });
		expect(without.messages[0]?.role === "system" ? without.messages[0].content : "").not.toContain(
			EXIT_PLAN_MODE_TOOL,
		);
	});

	it("批准之后 Agent 自己离开计划模式", async () => {
		const agent = new Agent({
			apiKey: "sk-test",
			cwd,
			tools: [],
			planMode: "strict",
			onPlanReview: async () => ({ approved: true }),
		});
		const exit = agent.listTools().find((tool) => tool.name === EXIT_PLAN_MODE_TOOL) as AgentTool | undefined;
		expect(exit).toBeDefined();
		const outcome = await exit?.execute(
			{ plan: "目标：给配置加校验；要改 config.ts 与测试；风险：默认值变化；验证：跑 npm run check。" },
			new AbortController().signal,
		);
		expect(outcome?.isError).toBe(false);
		expect(agent.planning).toBe(false);
	});
});
