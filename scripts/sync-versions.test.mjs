import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

test("同步内部依赖版本，但不动 registry 别名与已发布包的版本", async () => {
	const root = await mkdtemp(join(tmpdir(), "limkenion-sync-versions-"));
	try {
		await writeManifest(root, "packages/ai", {
			name: "limkenion-ai",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/cli", {
			name: "limkenion",
			version: "2.0.0",
		});
		// private 包也必须被同步，便于本地脚本与内部工具跟随发布版本。
		await writeManifest(root, "packages/private-tool", {
			name: "limkenion-private-tool",
			version: "9.9.9",
			private: true,
			dependencies: {
				"limkenion": "^1.0.0",
				// 键不是工作区包名，属于 registry 别名，必须保持原样。
				"@limkenion/ai": "npm:limkenion-ai@1.0.0",
			},
		});
		// 仓库根清单：它的版本由这个脚本一并对齐（`npm version --workspaces` 不碰根）。
		await writeFile(
			join(root, "package.json"),
			`${JSON.stringify({ name: "limkenion", private: true, version: "1.0.0" }, null, "\t")}\n`,
		);

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const tool = await readManifest(root, "packages/private-tool");
		assert.equal(tool.dependencies["limkenion"], "^2.0.0");
		assert.equal(tool.dependencies["@limkenion/ai"], "npm:limkenion-ai@1.0.0");

		// 已发布包的版本号不能被同步过程改写。
		const ai = await readManifest(root, "packages/ai");
		assert.equal(ai.version, "2.0.0");

		// 仓库根的版本会被对齐到锁步版本。
		const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		assert.equal(rootManifest.version, "2.0.0");

		// 已发布包版本不一致时必须失败，避免发出半锁步的版本。
		await writeManifest(root, "packages/ai", {
			name: "limkenion-ai",
			version: "3.0.0",
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("没有仓库根清单时跳过对齐而不是崩掉", async () => {
	const root = await mkdtemp(join(tmpdir(), "limkenion-sync-versions-bare-"));
	try {
		await writeManifest(root, "packages/ai", { name: "limkenion-ai", version: "2.0.0" });

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /所有非 private 包版本一致/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
