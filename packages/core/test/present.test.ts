import { describe, expect, it } from "vitest";
import {
	createPresentTools,
	MAX_PRESENT_FILES,
	MAX_PRESENT_NOTE,
	PresentList,
	parsePresent,
	renderPresent,
} from "../src/present.ts";

const tools = () => {
	const list = new PresentList();
	const [present] = createPresentTools(list);
	return { list, present };
};

describe("交付物清单", () => {
	it("解析：路径必填、件数有上限、说明超长截断", () => {
		expect(parsePresent(null)).toEqual({ error: "缺少 files 字段" });
		expect(parsePresent({ files: [] })).toHaveProperty("error");
		expect(parsePresent({ files: [{ note: "没有路径" }] })).toHaveProperty("error");
		expect(
			parsePresent({ files: Array.from({ length: MAX_PRESENT_FILES + 1 }, (_, i) => ({ path: `f${i}` })) }),
		).toHaveProperty("error");
		const long = "x".repeat(MAX_PRESENT_NOTE + 20);
		const parsed = parsePresent({ files: [{ path: " report.md ", note: long }] });
		expect(parsed).toHaveProperty("files");
		if ("files" in parsed) {
			expect(parsed.files[0]?.path).toBe("report.md");
			expect(parsed.files[0]?.note.endsWith("…")).toBe(true);
		}
	});

	it("渲染：一件一行，说明跟在后面；空清单给一句说明", () => {
		expect(renderPresent([])).toContain("还没有列出交付物");
		const text = renderPresent([
			{ path: "a.md", note: "结论" },
			{ path: "b.png", note: "" },
		]);
		expect(text).toContain("这次交付 2 件");
		expect(text).toContain("1. a.md —— 结论");
		expect(text).toContain("2. b.png");
	});

	it("present 整表替换，不是追加", async () => {
		const { list, present } = tools();
		const first = await present.execute({ files: [{ path: "旧报告.md", note: "旧的" }] }, {} as never);
		expect(first.isError).toBe(false);
		await present.execute({ files: [{ path: "新报告.md", note: "新的" }] }, {} as never);
		expect(list.current.map((file) => file.path)).toEqual(["新报告.md"]);
	});

	it("拒绝时不改动已有清单", async () => {
		const { list, present } = tools();
		await present.execute({ files: [{ path: "报告.md", note: "" }] }, {} as never);
		const rejected = await present.execute({ files: [] }, {} as never);
		expect(rejected.isError).toBe(true);
		expect(list.current.map((file) => file.path)).toEqual(["报告.md"]);
	});

	it("清掉之后回到空清单", async () => {
		const { list, present } = tools();
		await present.execute({ files: [{ path: "a.md", note: "" }] }, {} as never);
		list.clear();
		expect(list.current).toEqual([]);
	});
});
