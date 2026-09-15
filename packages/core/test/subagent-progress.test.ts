import { expect, it } from "vitest";
import { runSubagents, type SubagentEvent, SubagentProgressTable } from "../src/subagent.ts";

it("onEvent 报出每条子任务的开始与结束（给界面看进度用）", async () => {
	const events: SubagentEvent[] = [];
	const tasks = [
		{ label: "找缺陷", prompt: "看有没有 bug" },
		{ label: "看安全", prompt: "看有没有越权" },
	];
	const results = await runSubagents(
		tasks,
		async (task) => (task.label === "看安全" ? Promise.reject(new Error("挂了")) : "没问题"),
		{
			limit: 2,
			onEvent: (event) => events.push(event),
		},
	);
	expect(results.map((item) => item.label)).toEqual(["找缺陷", "看安全"]);
	expect(results[1]?.error).toContain("挂了");
	// 两条都报过 start；结束的那条按成败报 done / failed
	expect(events.filter((e) => e.phase === "start").length).toBe(2);
	expect(events.some((e) => e.label === "找缺陷" && e.phase === "done")).toBe(true);
	expect(events.some((e) => e.label === "看安全" && e.phase === "failed")).toBe(true);
});

it("整批已中断时按 aborted 报，不跑 run", async () => {
	const controller = new AbortController();
	controller.abort();
	const events: SubagentEvent[] = [];
	let called = 0;
	await runSubagents(
		[{ label: "A", prompt: "x" }],
		async () => {
			called += 1;
			return "不该跑到";
		},
		{
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		},
	);
	expect(called).toBe(0);
	expect(events).toEqual([{ label: "A", phase: "aborted" }]);
});

it("SubagentProgressTable 跟着 onEvent 走：跑完/挂了都记下来，重复终态不覆盖", async () => {
	const table = new SubagentProgressTable();
	const tasks = [
		{ label: "找缺陷", prompt: "x" },
		{ label: "看安全", prompt: "y" },
	];
	const results = await runSubagents(
		tasks,
		async (task) => {
			if (task.label === "看安全") {
				throw new Error("超时");
			}
			return "干净";
		},
		{
			limit: 2,
			onEvent: table.onEvent,
		},
	);
	for (const item of results) {
		if (item.error !== undefined) {
			table.noteResult(item.label, item.text, item.error);
		}
	}
	const rows = table.list();
	expect(rows.map((row) => [row.label, row.status])).toEqual([
		["找缺陷", "done"],
		["看安全", "failed"],
	]);
	expect(rows.every((row) => row.endedAt !== null)).toBe(true);
	expect(table.runningCount()).toBe(0);
	expect(rows[1]?.error).toContain("超时");
	// 迟到的 done 不该把 failed 改回 done
	table.onEvent({ label: "看安全", phase: "done" });
	expect(table.list()[1]?.status).toBe("failed");
	table.clear();
	expect(table.list()).toEqual([]);
});
