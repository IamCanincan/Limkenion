import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobTools, JobRegistry, renderJobs } from "../src/jobs.ts";

/** 等到某条任务不在 running（或超时） */
async function waitDone(jobs: JobRegistry, id: string, timeoutMs = 15_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const job = jobs.list().find((item) => item.id === id);
		if (job !== undefined && job.status !== "running") {
			return job.status;
		}
		if (Date.now() > deadline) {
			throw new Error(`等 ${id} 结束超时（现在 ${job?.status ?? "不见了"}）`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

let outputDir = "";
beforeEach(async () => {
	outputDir = await mkdtemp(join(tmpdir(), "limkenion-jobs-test-"));
});
afterEach(async () => {
	await rm(outputDir, { recursive: true, force: true });
});

describe("后台任务", () => {
	it("起一条、跑完、输出落文件、退出码对得上", async () => {
		const jobs = new JobRegistry({ outputDir });
		const job = jobs.start("node -e \"console.log('后台输出')\"");
		expect(job.status).toBe("running");
		expect(job.id).toBe("job-1");
		expect(jobs.runningCount()).toBe(1);

		expect(await waitDone(jobs, job.id)).toBe("done");
		expect(jobs.list()[0]?.exitCode).toBe(0);
		expect(readFileSync(job.outputPath, "utf8")).toContain("后台输出");
		expect(jobs.runningCount()).toBe(0);
	});

	it("退出码非零记 failed，渲染里说人话", async () => {
		const jobs = new JobRegistry({ outputDir });
		const job = jobs.start('node -e "process.exit(3)"');
		expect(await waitDone(jobs, job.id)).toBe("failed");
		const text = renderJobs(jobs.list());
		expect(text).toContain("失败");
		expect(text).toContain("退出码 3");
	});

	it("job_kill 收得掉还在跑的（顺带收掉它起的子进程）", async () => {
		const jobs = new JobRegistry({ outputDir });
		// 起一个会活很久的进程：这里不依赖具体命令的行为，只要求 1 秒内还在跑
		const job = jobs.start('node -e "setInterval(() => {}, 1000)"');
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(jobs.runningCount()).toBe(1);
		expect(jobs.kill(job.id)).toBe(true);
		expect(await waitDone(jobs, job.id)).toBe("killed");
		// 再收一次没有意义
		expect(jobs.kill(job.id)).toBe(false);
	});

	it("并发上限：起满之后拒绝，收掉一条又可以起", async () => {
		const jobs = new JobRegistry({ outputDir, maxJobs: 2 });
		jobs.start('node -e "setInterval(() => {}, 1000)"');
		jobs.start('node -e "setInterval(() => {}, 1000)"');
		expect(() => jobs.start("echo x")).toThrow(/同时最多 2 条/);
		jobs.kill("job-1");
		await waitDone(jobs, "job-1");
		expect(jobs.start("echo ok").id).toBe("job-3");
		jobs.killAll();
	});

	it("空命令拒绝；没有任务时渲染给一句说明", () => {
		const jobs = new JobRegistry({ outputDir });
		expect(() => jobs.start("   ")).toThrow(/不能为空/);
		expect(renderJobs([])).toContain("没有后台任务");
	});

	it("readTail 只给尾巴：从一开始读不截断、从中间读丢掉半行", async () => {
		const jobs = new JobRegistry({ outputDir });
		const many = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
		// 不靠 shell 传 300 行（引号太脆）：起一条平凡任务建出输出文件，再把内容写进去
		const job = jobs.start('node -e "console.log(1)"');
		expect(await waitDone(jobs, job.id)).toBe("done");
		writeFileSync(job.outputPath, many, "utf8");
		const all = jobs.readTail(job.id, 1000);
		expect(all?.text.split("\n").length).toBe(300);
		expect(all?.truncated).toBe(false);
		// 只要最后 5 行，且说明是截断过的
		const tail = jobs.readTail(job.id, 5);
		expect(tail?.text).toBe(["line 296", "line 297", "line 298", "line 299", "line 300"].join("\n"));
		expect(tail?.truncated).toBe(true);
		// 不存在的任务给 null，不抛
		expect(jobs.readTail("job-999")).toBeNull();
	});

	it("三个工具：起一条 → 列出 → 收掉", async () => {
		const jobs = new JobRegistry({ outputDir });
		const [start, list, kill] = createJobTools(jobs);
		const started = await start.execute({ command: "node -e \"console.log('工具路径')\"" }, {} as never);
		expect(started.isError).toBe(false);
		expect(started.content).toContain("job-1");

		const listed = await list.execute({}, {} as never);
		expect(listed.content).toContain("job-1");
		await waitDone(jobs, "job-1");

		const killed = await kill.execute({ id: "job-1" }, {} as never);
		expect(killed.content).toContain("不在运行中");
		const bad = await start.execute({ command: "   " }, {} as never);
		expect(bad.isError).toBe(true);
	});
});
