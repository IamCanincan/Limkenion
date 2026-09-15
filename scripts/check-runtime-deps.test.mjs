import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-runtime-deps.mjs", import.meta.url));

async function check(t, manifest, source, extraFiles = {}) {
	const root = await mkdtemp(join(tmpdir(), "limkenion-runtime-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const files = {
		"packages/example/package.json": JSON.stringify({ name: "example", version: "1.0.0", ...manifest }),
		"packages/example/src/index.ts": source,
		...extraFiles,
	};
	for (const [path, contents] of Object.entries(files)) {
		const fullPath = join(root, path);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, contents);
	}
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #9132：工作区解析加上「安装全部发布包」会掩盖缺失的运行时依赖声明。
test("即使工作区包存在，也拒绝未声明的导入", async (t) => {
	const result = await check(t, {}, 'export * from "limkenion-unknown/subpath";', {
		"packages/unknown/package.json": JSON.stringify({ name: "limkenion-unknown", version: "1.0.0" }),
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /src[\\/]index\.ts:1: limkenion-unknown\/subpath 未在/);
});

test("接受运行时声明、内置模块、自引用导入、相对导入和被擦除的类型", async (t) => {
	const result = await check(t, {
		dependencies: { "@scope/runtime": "1.0.0" },
		optionalDependencies: { optional: "1.0.0" },
		peerDependencies: { peer: "1.0.0" },
	}, `
import "node:fs";
import "fs/promises";
import "./local.ts";
import "example/subpath";
import { value, type T } from "@scope/runtime/subpath";
import optional from "optional";
export * from "peer";
import type { Type } from "type-only";
import { type OtherType } from "inline-type-only";
export type { Type } from "export-type-only";
export { type OtherType } from "export-inline-type-only";
`);
	assert.equal(result.status, 0, result.stderr);
});

test("拒绝仅开发依赖、副作用导入、混合导出和字面量运行时加载", async (t) => {
	const result = await check(t, { devDependencies: { dev: "1.0.0" } }, `
import "dev";
import {} from "empty-import";
export {} from "empty-export";
export { type T, value } from "mixed-export";
const lazy = () => import("lazy/subpath");
const required = require("required");
const resolved = require.resolve("resolved/subpath");
`);
	assert.equal(result.status, 1);
	for (const name of ["dev", "empty-import", "empty-export", "mixed-export", "lazy/subpath", "required", "resolved/subpath"]) {
		assert.ok(result.stderr.includes(`${name} 未在`), result.stderr);
	}
});

test("允许导入 TypeScript include 范围之外的 JSON 资源", async (t) => {
	const result = await check(t, {}, 'import data from "./data.json";', {
		"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], compilerOptions: { resolveJsonModule: true } }),
		"packages/example/src/data.json": "{}",
	});
	assert.equal(result.status, 0, result.stderr);
});

test("允许发布构建所排除的源码中使用仅开发依赖", async (t) => {
	const result = await check(t, { devDependencies: { server: "1.0.0" } }, "", {
		"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/experimental"] }),
		"packages/example/src/experimental/server.ts": 'import "server";',
	});
	assert.equal(result.status, 0, result.stderr);
});

// #9132：实验性标志无法阻止通过公开入口进行模块解析。
for (const statement of ['export * from "./experimental/server";', 'import type { Options } from "./experimental/server";']) {
	test(`拒绝通过 ${statement} 可达的被排除代码`, async (t) => {
		const result = await check(t, { devDependencies: { server: "1.0.0" } }, statement, {
			"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/experimental"] }),
			"packages/example/src/experimental/server.ts": 'import "server"; export interface Options {}',
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /被排除在 .+ 的构建之外，却被其导入/);
		assert.match(result.stderr, /server 未在/);
	});
}

test("忽略测试、声明文件和 private 包", async (t) => {
	const result = await check(t, {}, "", {
		"packages/example/test/test.ts": 'import "test-only";',
		"packages/example/src/index.d.ts": 'import "declaration-only";',
		"packages/private/package.json": JSON.stringify({ name: "private", private: true }),
		"packages/private/src/index.ts": 'import "private-only";',
	});
	assert.equal(result.status, 0, result.stderr);
});
