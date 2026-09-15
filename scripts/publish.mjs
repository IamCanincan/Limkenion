#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runNpm, spawnNpm } from "./npm-command.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const packages = getPublicWorkspacePackages();

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

/**
 * 来源证明（provenance）要 CI 提供的 OIDC 令牌，本地发布拿不到，带上它只会失败。
 * 因此只在 GitHub Actions 里加：本地发出去的包没有来源证明，CI 发出去的有。
 */
const PROVENANCE_ARGS = process.env.GITHUB_ACTIONS === "true" ? ["--provenance"] : [];

if (unknownArgs.length > 0) {
	console.error(`用法：node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist 不存在。发布前请先运行 npm run build。`);
	}
}

function validatePack(directory) {
	const result = runNpm(["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} 个文件，打包后 ${packed.size} 字节，解包后 ${packed.unpackedSize} 字节`);
}

/** 查询某个版本是否已经发布；查询本身的失败（而不是 404）会直接抛出 */
function isPublished(name, version) {
	const result = spawnNpm(["view", `${name}@${version}`, "version", "--json"], { capture: true });

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `查询 ${name}@${version} 失败\n${output}` : `查询 ${name}@${version} 失败`);
}

const packageVersions = new Map(packages.map((pkg) => [pkg.name, pkg.version]));

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`待发布的包版本未锁步：${versions.join(", ")}`);
}

console.log(`开始发布 limkenion 包，版本 ${versions[0]}${dryRun ? "（试运行）" : ""}\n`);

const packageStates = packages.map((pkg) => ({
	...pkg,
	published: false,
	version: packageVersions.get(pkg.name),
}));

for (const pkg of packageStates) {
	assertBuildOutputExists(pkg.directory);
	pkg.published = isPublished(pkg.name, pkg.version);

	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} 已发布；仅校验包内容。`);
	} else {
		console.log(`${pkg.name}@${pkg.version} 尚未发布；发布前校验包内容。`);
	}
	validatePack(pkg.directory);
	console.log();
}

if (dryRun) {
	process.exit(0);
}

console.log("所有包校验通过；开始发布。\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`跳过 ${pkg.name}@${pkg.version}：已发布\n`);
		continue;
	}

	runNpm(["publish", "--access", "public", ...PROVENANCE_ARGS, "--ignore-scripts"], { cwd: pkg.directory });
	console.log();
}
