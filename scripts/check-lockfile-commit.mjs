#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const allowValue = process.env.LIMKENION_ALLOW_LOCKFILE_CHANGE;
const allowed = allowValue === "1" || allowValue === "true" || allowValue === "yes";

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readJsonFromGit(ref) {
	try {
		return JSON.parse(git(["show", ref]));
	} catch {
		return undefined;
	}
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) return lockPath || "<root>";
	const parts = lockPath.slice(index + marker.length).split("/");
	return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function packageLabel(lockPath, entry) {
	const name = entry?.name ?? packageNameFromLockPath(lockPath);
	return entry?.version ? `${name}@${entry.version}` : name;
}

function getLockfilePackageChanges() {
	const before = readJsonFromGit("HEAD:package-lock.json");
	const after = readJsonFromGit(":package-lock.json");
	if (!before?.packages || !after?.packages) return undefined;

	const changes = [];
	const paths = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
	for (const lockPath of [...paths].sort()) {
		const oldEntry = before.packages[lockPath];
		const newEntry = after.packages[lockPath];
		if (JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) {
			changes.push({ lockPath, oldEntry, newEntry });
		}
	}
	return changes;
}

function isWorkspacePackagePath(lockPath) {
	return lockPath.startsWith("packages/");
}

function hasOnlyWorkspacePackageChanges(changes) {
	return changes.length > 0 && changes.every((change) => isWorkspacePackagePath(change.lockPath));
}

function summarizeLockfileChange(changes) {
	const nodeModuleChanges = changes.filter((change) => change.lockPath.includes("node_modules/"));
	const summary = [];
	for (const { lockPath, oldEntry, newEntry } of nodeModuleChanges) {
		if (!oldEntry && newEntry) {
			summary.push(`新增 ${packageLabel(lockPath, newEntry)}`);
		} else if (oldEntry && !newEntry) {
			summary.push(`移除 ${packageLabel(lockPath, oldEntry)}`);
		} else if (oldEntry?.version !== newEntry?.version) {
			summary.push(
				`变更 ${packageNameFromLockPath(lockPath)} ${oldEntry?.version ?? "<none>"} -> ${newEntry?.version ?? "<none>"}`,
			);
		} else {
			summary.push(`变更 ${packageLabel(lockPath, newEntry)}`);
		}
	}
	return summary;
}

const stagedFiles = git(["diff", "--cached", "--name-only"])
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);

if (!stagedFiles.includes("package-lock.json")) {
	process.exit(0);
}

if (allowed) {
	console.error("package-lock.json 已入栈；已设置 LIMKENION_ALLOW_LOCKFILE_CHANGE，允许提交。");
	process.exit(0);
}

const changes = getLockfilePackageChanges();
if (changes && hasOnlyWorkspacePackageChanges(changes)) {
	console.error("package-lock.json 只更新了工作区包的元数据；允许提交。");
	process.exit(0);
}

console.error("package-lock.json 已入栈。");
console.error("");
console.error("提交前请审查锁文件改动：");
console.error("  - 确认每个新增/更新的包都是有意为之");
console.error("  - 确认解析依赖时 npm 的发布年龄限制已生效");
console.error("  - 检查依赖树中新增的生命周期脚本");
console.error("  - 若发布依赖有变化，重新生成/检查 cli 包的 shrinkwrap");

const summary = changes ? summarizeLockfileChange(changes) : [];
if (summary.length > 0) {
	console.error("");
	console.error("检测到包版本变化：");
	for (const change of summary.slice(0, 40)) {
		console.error(`  - ${change}`);
	}
	if (summary.length > 40) {
		console.error(`  ... 另有 ${summary.length - 40} 条`);
	}
}

console.error("");
console.error("如果这次锁文件改动是有意为之，请用以下命令提交：");
console.error("  LIMKENION_ALLOW_LOCKFILE_CHANGE=1 git commit ...");
process.exit(1);
