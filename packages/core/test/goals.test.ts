import { describe, expect, it } from "vitest";
import { createGoalTools, GoalList, MAX_GOAL_CONTENT, parseGoal, renderGoal } from "../src/goals.ts";

/** 取出两个工具，免得每处都按名字找 */
const tools = () => {
	const list = new GoalList();
	const [write, read] = createGoalTools(list);
	return { list, write, read };
};

describe("会话目标", () => {
	it("解析：空目标与超长目标都拒绝，状态不认识时按未运行", () => {
		expect(parseGoal(null)).toEqual({ error: "缺少 goal 字段" });
		expect(parseGoal({ content: "   " })).toEqual({ error: "目标不能为空：一句话说清这一轮要达成什么" });
		expect(parseGoal({ content: "x".repeat(MAX_GOAL_CONTENT + 1) })).toHaveProperty("error");
		// 前后空白要剪掉；状态缺省与不认识的值都落到未运行
		expect(parseGoal({ content: "  把审批卡补上  " })).toEqual({ content: "把审批卡补上", status: "idle" });
		expect(parseGoal({ content: "把审批卡补上", status: "whatever" })).toEqual({
			content: "把审批卡补上",
			status: "idle",
		});
	});

	it("渲染：没有目标时也给一句说明，有目标时状态说人话", () => {
		expect(renderGoal(null)).toContain("还没有设目标");
		expect(renderGoal({ content: "把审批卡补上", status: "active" })).toBe("目标（进行中）：把审批卡补上");
		expect(renderGoal({ content: "等使用者拍板", status: "blocked" })).toContain("受阻");
	});

	it("goal_write 整表替换，goal_read 读回同一份", async () => {
		const { write, read } = tools();
		const written = await write.execute({ content: "把目标 dock 做出来", status: "active" }, {} as never);
		expect(written.isError).toBe(false);
		expect(written.content).toContain("目标（进行中）：把目标 dock 做出来");

		// 再写一次是整表替换，不是追加
		await write.execute({ content: "改成先做交付物卡", status: "paused" }, {} as never);
		const back = await read.execute({}, {} as never);
		expect(back.content).toContain("改成先做交付物卡");
		expect(back.content).not.toContain("把目标 dock 做出来");
	});

	it("拒绝时不改动已有目标", async () => {
		const { list, write } = tools();
		await write.execute({ content: "先做目标", status: "active" }, {} as never);
		const rejected = await write.execute({ content: "" }, {} as never);
		expect(rejected.isError).toBe(true);
		expect(list.current?.content).toBe("先做目标");
	});

	it("清掉之后回到「还没有设目标」", async () => {
		const { list, read } = tools();
		await createGoalTools(list)[0].execute({ content: "临时目标" }, {} as never);
		expect(list.current?.content).toBe("临时目标");
		list.clear();
		expect(list.current).toBeNull();
		expect((await read.execute({}, {} as never)).content).toContain("还没有设目标");
	});
});
