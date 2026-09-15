#!/usr/bin/env node
/**
 * limkenion-mono 的发布脚本
 *
 * 用法：
 *   node scripts/release.mjs <major|minor|patch|x.y.z> [--npm] [--no-github]
 *
 * 步骤：
 * 1. 检查未提交的改动
 * 2.（只在 `--npm` 时）确认每个公开工作区包都已在 npm 注册
 * 3. 通过 npm run version:xxx 升级版本，或设置显式版本
 * 4. 更新 CHANGELOG.md 文件：[Unreleased] -> [version] - date
 * 5. 运行检查、构建与测试
 * 6. 提交并为发布打标签
 * 7. 为变更日志添加新的 [Unreleased] 段落
 * 8. 提交下一周期的变更日志更新
 * 9. 推送 main 和标签
 * 10. 发布 GitHub Release（附件 + 说明）——**只在显式要求时**：加 `--github` 才做，默认停在第 9 步。
 *
 * 为什么默认不碰 Release：发布与上传是使用者的决定（`AGENTS.md` 的「发布」一节写明了），
 * 自动建 Release、自动传源码归档都属于越权。
 *
 * 分发方式说明：本项目的主角是 GitHub Release 附件（自包含 tgz + 解压即用的 zip），
 * 所以 npm 注册检查默认**不做**——那条路只在确实要 `npm publish` 时才需要（见 scripts/publish.mjs）。
 * 测试在 Windows 上用 `npm test`，在 POSIX 上用 `test.sh`（它在隔离的 HOME 里再跑一遍，更能暴露
 * 「依赖了本机环境」的问题）。
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnNpm } from "./npm-command.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const cliArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const RELEASE_TARGET = cliArgs[0];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("用法：node scripts/release.mjs <major|minor|patch|x.y.z> [--npm] [--no-github]");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`命令执行失败：${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function assertPackagesAreRegisteredWithNpm() {
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	const unregisteredPackages = [];

	console.log("正在检查 npm 包注册情况...");
	for (const packageName of packageNames) {
		const result = spawnNpm(["view", packageName, "version", "--json"], { capture: true });

		if (result.status === 0 && result.stdout.trim()) {
			console.log(`  ${packageName}`);
			continue;
		}

		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			unregisteredPackages.push(packageName);
			continue;
		}

		throw new Error(output ? `查询 ${packageName} 的 npm 注册信息失败\n${output}` : `查询 ${packageName} 的 npm 注册信息失败`);
	}

	if (unregisteredPackages.length > 0) {
		throw new Error(`以下公开工作区包未在 npm 上注册：\n${unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n")}\n请在发布前先注册它们。`);
	}

	console.log("  所有公开工作区包均已在 npm 上注册\n");
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(
		getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]),
	);
	const lockPath = "package-lock.json";
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		console.log(`已移除 ${removed} 个过期的工作区包锁条目${removed === 1 ? "" : ""}。`);
	}
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	// 用 execFileSync 传参数数组，而不是拼一条带引号的命令：Windows 上 execSync 走 cmd.exe，
	// 单引号不是引号（`git add -- 'x'` 会把引号当文件名，报 pathspec did not match）。
	execFileSync("git", ["add", "--", ...paths], { cwd: process.cwd(), stdio: "inherit" });
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`正在升级版本（${target}）...`);
		run(`npm run version:${target}`);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`错误：显式版本 ${target} 必须大于当前版本 ${currentVersion}。`);
			process.exit(1);
		}

		console.log(`正在设置显式版本（${target}）...`);
		run(`npm version ${target} --workspaces --no-git-tag-version --no-workspaces-update && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`);
	}

	// npm version 可能在 sync-versions 更新包间版本范围前临时安装旧的工作区版本。
	// 删除这些过期的锁条目，刷新锁文件，再按最终依赖图重新安装。
	removeStaleWorkspaceLockEntries();
	run("npm install --package-lock-only --ignore-scripts");
	// 用 npm install 而不是 npm ci：锁文件只在生成它的那个平台上解析原生可选依赖，
	// npm ci 会在其它平台漏装（例如 vitest 4 的 rolldown 平台绑定，npm/cli#4828）。
	run("npm install --ignore-scripts");
	return getVersion();
}

function getChangelogs() {
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  跳过 ${changelog}：没有 [Unreleased] 段落`);
			continue;
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  已更新 ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// 插在**第一个 `## [` 之前**，而不是紧跟 `# Changelog`：抬头那几行说明（「从本版本开始记录。」）
		// 属于文件头，插在它前面会把说明挤到 [Unreleased] 底下去。
		const updated = content.replace(/\n(## \[)/, `\n${unreleasedSection}$1`);
		writeFileSync(changelog, updated);
		console.log(`  已为 ${changelog} 添加 [Unreleased]`);
	}
}

// 主流程
console.log("\n=== 发布脚本 ===\n");

// 1. 检查未提交的改动
console.log("正在检查未提交的改动...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("错误：检测到未提交的改动。请先提交或暂存。");
	console.error(status);
	process.exit(1);
}
console.log("  工作目录干净\n");

// 2. 只在要发 npm 时检查注册情况（GitHub Release 那条路不需要）
if (flags.has("--npm")) {
	assertPackagesAreRegisteredWithNpm();
} else {
	console.log("跳过 npm 注册检查（本项目按 GitHub Release 分发；要发 npm 就加 --npm）\n");
}

// 3. 升级或设置版本
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  新版本：${version}\n`);

// 4. 更新变更日志
console.log("正在更新 CHANGELOG.md 文件...");
updateChangelogsForRelease(version);
console.log();

// 5. 运行检查与测试
console.log("正在运行检查...");
run("npm run check");
console.log();

console.log("正在为测试构建包...");
run("npm run build");
console.log();

console.log("正在运行测试...");
// test.sh 是 bash 脚本（在隔离的 HOME 里再跑一遍，能暴露「偷偷依赖本机环境」的问题）；
// Windows 上没有 bash 就退回 npm test，CI 与 test.sh 覆盖的是同一批用例。
if (process.platform === "win32" && !existsSync("/usr/bin/env")) {
	run("npm test");
} else {
	run("./test.sh");
}
console.log();

// 7. 提交并打标签
console.log("正在提交并打标签...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 8. 添加新的 [Unreleased] 段落
console.log("正在为下一个周期添加 [Unreleased] 段落...");
addUnreleasedSection();
console.log();

// 9. 提交
console.log("正在提交变更日志更新...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 10. 推送
console.log("正在推送到远端...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

// 10. 发布 GitHub Release —— 只在显式给了 --github 时做。
// 默认停在上一步（main 与标签都推上去了）：建 Release、传源码归档是使用者的决定，见 AGENTS.md。
if (!flags.has("--github")) {
	console.log("已跳过 GitHub Release（默认不发；需要时加 --github，或事后 npm run release:github）。");
} else if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
	console.log("没有 GH_TOKEN / GITHUB_TOKEN，已跳过 GitHub Release。补发：npm run release:github");
} else {
	console.log("正在发布 GitHub Release...");
	run("npm run release:github");
	console.log();
}

console.log(`=== 已完成 v${version} ===`);
