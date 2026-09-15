import { describe, expect, it } from "vitest";
import { createSubagentTools, SubagentProgressTable } from "../src/subagent.ts";

/** 手动控制什么时候回 */
function makeRunner() {
	const pending: { label: string; resolve: (text: string) => void; signal: AbortSignal }[] = [];
	return {
		pending,
		run: (task: { label: string }, signal: AbortSignal) =>
			new Promise<string>((resolve) => {
				pending.push({ label: task.label, resolve, signal });
			}),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("子代理工具", () => {
	it("起一条 → 列表里在跑 → 结论能读回来", async () => {
		const { run, pending } = makeRunner();
		const table = new SubagentProgressTable();
		// 按名字取工具，不按下标：加一个工具就会把位置解构错开（真踩过）
		const tools = createSubagentTools({ run, table });
		const byName = (name: string) => {
			const found = tools.find((tool) => tool.name === name);
			if (found === undefined) {
				throw new Error(`没有 ${name}`);
			}
			return found;
		};
		const start = byName("subagent_start");
		const list = byName("subagent_list");
		const read = byName("subagent_read");
		const stop = byName("subagent_stop");

		const started = await start.execute({ task: "把 utils 里的老接口列出来", label: "老接口" }, {} as never);
		expect(started.isError).toBe(false);
		expect(started.content).toContain("老接口");
		expect(pending[0]?.label).toBe("老接口");

		expect((await list.execute({}, {} as never)).content).toContain("运行中");
		expect((await read.execute({ label: "老接口" }, {} as never)).content).toContain("还在跑");

		// 还在跑：subagent_stop 收得掉，取消信号真的发出去了
		expect((await stop.execute({ label: "老接口" }, {} as never)).content).toContain("已停止");
		expect(pending[0]?.signal.aborted).toBe(true);
		await settle();
		expect((await read.execute({ label: "老接口" }, {} as never)).content).toContain("已中断");
		// 已经结束的收不掉：返回一句说明而不是报错
		expect((await stop.execute({ label: "老接口" }, {} as never)).content).toContain("不在运行中");
	});

	it("同一标签不许重复；空任务拒绝；读不存在的给错误", async () => {
		const { run } = makeRunner();
		const table = new SubagentProgressTable();
		const pair = createSubagentTools({ run, table });
		const start = pair[0] as (typeof pair)[number];
		const read = pair.find((tool) => tool.name === "subagent_read") as (typeof pair)[number];
		await start.execute({ task: "第一件", label: "A" }, {} as never);
		const dup = await start.execute({ task: "第二件", label: "A" }, {} as never);
		expect(dup.isError).toBe(true);
		expect(dup.content).toContain("已经用过");
		// 空任务的拒绝搬到了契约的 `validate` 上（先于审批与执行跑，见 tool-pipeline.ts）：
		// 参数本身就不成立的调用不该弹确认卡片。所以断言打在自陈的校验上，而不是 execute 上。
		expect(start.validate({ task: "   " })).toEqual({ ok: false, message: expect.stringContaining("任务不能为空") });
		expect(start.validate({ task: "有内容" }).ok).toBe(true);
		expect((await read.execute({ label: "没有这个" }, {} as never)).isError).toBe(true);
	});
});
