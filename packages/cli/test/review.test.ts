/**
 * 评审编排：diff 采集与多代理汇总。
 *
 * 全部用假 git 与假代理跑，不联网也不碰真实仓库：这里的价值在于验证「哪些失败会被容忍、
 * 哪些会让整轮作废」，以及报告与退出码的判定依据。
 */

import { describe, expect, it } from "vitest";
import { collectDiff, type GitResult, type GitRunner, type ReviewRuntime, runReview } from "../src/review.ts";

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,2 +1,3 @@",
	"+ const x = 1;",
].join("\n");

/** 按命令片段回答的假 git */
function fakeGit(answers: { diff?: GitResult; names?: GitResult; others?: GitResult }): GitRunner {
	return async (args) => {
		const line = args.join(" ");
		if (line.startsWith("diff --no-color")) {
			return answers.diff ?? { code: 0, stdout: DIFF, stderr: "" };
		}
		if (line.startsWith("diff --name-only")) {
			return answers.names ?? { code: 0, stdout: "src/a.ts\n", stderr: "" };
		}
		return answers.others ?? { code: 0, stdout: "", stderr: "" };
	};
}

describe("collectDiff", () => {
	it("默认看工作区相对 HEAD 的改动，并列出改动文件", async () => {
		const captured: string[] = [];
		const git: GitRunner = async (args) => {
			captured.push(args.join(" "));
			return fakeGit({})(args, "");
		};
		const result = await collectDiff({ cwd: "/repo", git });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.diff).toContain("const x = 1");
			expect(result.files).toEqual(["src/a.ts"]);
		}
		expect(captured[0]).toContain("HEAD");
	});

	it("给了 base 就用 base...HEAD", async () => {
		const captured: string[] = [];
		const git: GitRunner = async (args) => {
			captured.push(args.join(" "));
			return fakeGit({})(args, "");
		};
		await collectDiff({ cwd: "/repo", base: "main", git });
		expect(captured[0]).toContain("main...HEAD");
	});

	it("未跟踪的新文件单独列出来", async () => {
		const result = await collectDiff({
			cwd: "/repo",
			git: fakeGit({ others: { code: 0, stdout: "src/new.ts\n", stderr: "" } }),
		});
		expect(result.ok && result.untracked).toEqual(["src/new.ts"]);
	});

	it("不是 git 仓库时给出能看懂的原因", async () => {
		const result = await collectDiff({
			cwd: "/tmp",
			git: fakeGit({
				diff: { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent)" },
			}),
		});
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.error).toContain("不是 git 仓库");
	});

	it("改动为空时不报错，交给上层说「没得评」", async () => {
		const result = await collectDiff({
			cwd: "/repo",
			git: fakeGit({ diff: { code: 0, stdout: "\n", stderr: "" } }),
		});
		expect(result).toEqual({ ok: true, diff: "", files: [], untracked: [] });
	});
});

/** 造一个可观测的假运行时 */
function fakeRuntime(answer: (label: string) => string | Error): {
	runtime: ReviewRuntime;
	labels: string[];
	prompts: string[];
} {
	const labels: string[] = [];
	const prompts: string[] = [];
	const runtime: ReviewRuntime = {
		git: fakeGit({}),
		note: () => undefined,
		run: async ({ label, prompt }) => {
			labels.push(label);
			prompts.push(prompt);
			const result = answer(label);
			if (result instanceof Error) {
				throw result;
			}
			return result;
		},
	};
	return { runtime, labels, prompts };
}

describe("runReview", () => {
	it("三个角度各跑一遍，再由汇总者给出报告与结论", async () => {
		const { runtime, labels } = fakeRuntime((label) =>
			label === "synthesis" ? "## 评审结论\n没问题\nVERDICT: ok" : `## ${label}\n未发现问题`,
		);
		const outcome = await runReview(runtime, { cwd: "/repo" });
		expect(labels).toEqual(["correctness", "security", "tests", "synthesis"]);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.verdict).toBe("ok");
			expect(outcome.report).toContain("评审结论");
			expect(outcome.files).toEqual(["src/a.ts"]);
			expect(outcome.failed).toEqual([]);
		}
	});

	it("blocker 会让结论变成 block，供 CI 当门禁", async () => {
		const { runtime } = fakeRuntime((label) =>
			label === "synthesis" ? "- [blocker] src/a.ts:1 有问题\nVERDICT: block" : "找到一个",
		);
		const outcome = await runReview(runtime, { cwd: "/repo" });
		expect(outcome.ok && outcome.verdict).toBe("block");
	});

	it("可以只跑指定角度", async () => {
		const { runtime, labels } = fakeRuntime((label) => (label === "synthesis" ? "VERDICT: ok" : "没问题"));
		await runReview(runtime, { cwd: "/repo", focuses: ["security"] });
		expect(labels).toEqual(["security", "synthesis"]);
	});

	it("个别评审者失败仍然出报告，并在提示词里点出缺席者", async () => {
		const { runtime, prompts } = fakeRuntime((label) => {
			if (label === "security") {
				return new Error("限速");
			}
			return label === "synthesis" ? "报告正文\nVERDICT: ok" : "没问题";
		});
		const outcome = await runReview(runtime, { cwd: "/repo" });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.failed).toEqual(["security"]);
		}
		expect(prompts.at(-1)).toContain("限速");
	});

	it("全部评审者失败时不出报告", async () => {
		const { runtime } = fakeRuntime(() => new Error("网关 502"));
		const outcome = await runReview(runtime, { cwd: "/repo" });
		expect(outcome.ok).toBe(false);
		expect(outcome.ok ? "" : outcome.error).toContain("都没能给出结论");
	});

	it("评审者跑完却没写报告时按失败算，不让它冒充「没问题」", async () => {
		const { runtime, prompts } = fakeRuntime((label) => {
			if (label === "synthesis") {
				return "报告正文\nVERDICT: ok";
			}
			return label === "tests" ? "没问题" : "   ";
		});
		const outcome = await runReview(runtime, { cwd: "/repo" });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.failed).toEqual(["correctness", "security"]);
		}
		expect(prompts.at(-1)).toContain("没有给出报告");
	});

	it("评审者一个字都没写时同样算失败", async () => {
		const { runtime } = fakeRuntime(() => "");
		const outcome = await runReview(runtime, { cwd: "/repo" });
		expect(outcome.ok).toBe(false);
		expect(outcome.ok ? "" : outcome.error).toContain("都没能给出结论");
	});

	it("没有改动时不调用任何代理", async () => {
		const { runtime, labels } = fakeRuntime(() => "不该发生");
		const outcome = await runReview(
			{ ...runtime, git: fakeGit({ diff: { code: 0, stdout: "", stderr: "" } }) },
			{ cwd: "/repo" },
		);
		expect(outcome.ok).toBe(false);
		expect(labels).toEqual([]);
	});

	it("汇总结果没有 VERDICT 行时按 ok 处理", async () => {
		const { runtime } = fakeRuntime((label) => (label === "synthesis" ? "写了半天但没有结论行" : "没问题"));
		const outcome = await runReview(runtime, { cwd: "/repo" });
		expect(outcome.ok && outcome.verdict).toBe("ok");
	});
});
