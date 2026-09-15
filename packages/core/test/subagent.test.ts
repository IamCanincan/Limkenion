/** 子代理并行执行：并发上限、顺序、失败隔离。 */

import { describe, expect, it } from "vitest";
import { runSubagents } from "../src/subagent.ts";

/** 造一个能观测并发峰值的执行器 */
function tracker(delays: Record<string, number> = {}) {
	let active = 0;
	let peak = 0;
	const started: string[] = [];
	const run = async (task: { label: string }): Promise<string> => {
		active += 1;
		peak = Math.max(peak, active);
		started.push(task.label);
		await new Promise((resolve) => setTimeout(resolve, delays[task.label] ?? 5));
		active -= 1;
		return `结论：${task.label}`;
	};
	return {
		run,
		get peak() {
			return peak;
		},
		get started() {
			return started;
		},
	};
}

describe("runSubagents", () => {
	it("按传入顺序返回，不按完成顺序", async () => {
		// 第一个最慢，如果按完成顺序返回就会被排到最后。
		const spy = tracker({ 慢: 30, 快: 1, 中: 10 });
		const results = await runSubagents(
			[
				{ label: "慢", prompt: "" },
				{ label: "快", prompt: "" },
				{ label: "中", prompt: "" },
			],
			spy.run,
			{ limit: 3 },
		);
		expect(results.map((item) => item.label)).toEqual(["慢", "快", "中"]);
		expect(results[0]?.text).toBe("结论：慢");
	});

	it("并发不超过上限", async () => {
		const spy = tracker();
		const tasks = Array.from({ length: 6 }, (_, index) => ({ label: `t${index}`, prompt: "" }));
		const results = await runSubagents(tasks, spy.run, { limit: 2 });
		expect(results).toHaveLength(6);
		expect(spy.peak).toBe(2);
	});

	it("单个任务失败只影响它自己", async () => {
		const results = await runSubagents(
			[
				{ label: "好的", prompt: "" },
				{ label: "坏的", prompt: "" },
				{ label: "也好", prompt: "" },
			],
			async (task) => {
				if (task.label === "坏的") {
					throw new Error("接口 500");
				}
				return "有结论";
			},
			{},
		);
		expect(results[0]).toEqual({ label: "好的", text: "有结论" });
		expect(results[1]).toEqual({ label: "坏的", text: "", error: "接口 500" });
		expect(results[2]?.text).toBe("有结论");
	});

	it("已经中断时不再真的执行", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = 0;
		const results = await runSubagents(
			[{ label: "a", prompt: "" }],
			async () => {
				called += 1;
				return "不该发生";
			},
			{ signal: controller.signal },
		);
		expect(called).toBe(0);
		expect(results[0]?.error).toBe("已中断");
	});

	it("空任务表直接返回空数组", async () => {
		expect(await runSubagents([], async () => "")).toEqual([]);
	});
});
