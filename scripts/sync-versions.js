#!/usr/bin/env node

/**
 * 校验已发布包的版本锁步，并把各工作区包（含 private 包）的内部依赖版本同步到该版本。
 *
 * 只处理「依赖名本身是工作区包」的条目：registry 别名（npm:...）的键不是工作区包名，
 * 因此不会被改写，否则会把别名换成尚未发布的版本号。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const packageRoot = process.argv[2] ?? "packages";
const workspacePackages = findPackageDirectories(packageRoot).map((directory) => {
	const path = join(directory, "package.json");
	return { data: JSON.parse(readFileSync(path, "utf8")), path };
});
const publishedPackages = workspacePackages.filter((pkg) => pkg.data.private !== true);
const versionMap = new Map(workspacePackages.map((pkg) => [pkg.data.name, pkg.data.version]));

console.log("当前版本：");
for (const pkg of [...publishedPackages].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
	console.log(`  ${pkg.data.name}: ${pkg.data.version}`);
}

const versions = new Set(publishedPackages.map((pkg) => pkg.data.version));
if (versions.size > 1) {
	console.error("\n错误：并非所有非 private 包使用相同版本。");
	console.error("需要锁步版本。请执行以下之一：");
	console.error("  npm run version:patch");
	console.error("  npm run version:minor");
	console.error("  npm run version:major");
	process.exit(1);
}

console.log("\n所有非 private 包版本一致（锁步）。");

// 顺带把仓库根 package.json 的版本也对齐：`npm version --workspaces` 不会碰它，于是它长期停在
// 上一个版本（发 1.3.1 时根上还写着 1.0.0），lock 里那两条根条目也跟着漂。
// 找不到根清单就跳过（脚本可能被指向某个包目录树，那时没有「仓库根」这回事）。
const releaseVersion = [...versions][0];
const rootManifestPath = join(packageRoot, "..", "package.json");
if (existsSync(rootManifestPath)) {
	const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
	if (rootManifest.version !== releaseVersion) {
		console.log(`\n${rootManifest.name}（仓库根）: ${rootManifest.version} → ${releaseVersion}`);
		rootManifest.version = releaseVersion;
		writeFileSync(rootManifestPath, `${JSON.stringify(rootManifest, null, "\t")}\n`);
	} else {
		console.log(`\n${rootManifest.name}（仓库根）版本已对齐。`);
	}
}

let totalUpdates = 0;
const updatedPackages = new Set();
for (const pkg of workspacePackages) {
	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			// registry 别名（如 `npm:limkenion-ai@0.1.2`）不会链接到工作区，
			// 因此按锁步改写它们会指向尚未发布的版本。
			const version = versionMap.get(dependencyName);
			const newSpecifier = version ? `^${version}` : null;
			if (!newSpecifier || currentSpecifier === newSpecifier) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} → ${newSpecifier}${dependencyType === "devDependencies" ? "（devDependencies）" : ""}`,
			);
			dependencies[dependencyName] = newSpecifier;
			updatedPackages.add(pkg);
			totalUpdates++;
		}
	}
}

for (const pkg of updatedPackages) {
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

if (totalUpdates === 0) {
	console.log("\n所有包间依赖均已同步。");
} else {
	console.log(`\n已更新 ${totalUpdates} 个依赖版本。`);
}
