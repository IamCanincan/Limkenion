#!/usr/bin/env node

/**
 * 把某个版本发布到 GitHub Release：打包 + 源码归档 + 建/改 Release + 传五个附件。
 *
 * 用法：
 *   node scripts/publish-github-release.mjs              # 版本取自 packages/cli/package.json
 *   node scripts/publish-github-release.mjs --tag v1.0.0 # 指定 tag
 *   node scripts/publish-github-release.mjs --dry-run    # 只打包并打印要做的事，不碰网络
 *
 * 需要 `GH_TOKEN`（或 `GITHUB_TOKEN`）环境变量，权限为「对仓库内容的写权限 + 附件上传」。
 * 走代理的环境要给 Node 24 的 fetch 开 `NODE_USE_ENV_PROXY=1`，否则它不认 HTTPS_PROXY。
 *
 * 为什么单独一个脚本：`npm publish` 那条路要求包先注册到 npm，而本项目的分发方式就是
 * GitHub Release 附件（自包含的 tgz + 解压即用的 zip）。`scripts/release.mjs` 在最后调它。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./npm-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 解析参数 */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagArgIndex = args.indexOf("--tag");
const tagArg = tagArgIndex >= 0 ? args[tagArgIndex + 1] : undefined;

/** 版本号：默认取 CLI 包的版本（三个包锁步，取哪个都一样） */
function readVersion() {
	return JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf-8")).version;
}

/** 从 origin 解析出 owner/repo，避免把仓库写死在脚本里 */
function readRepo() {
	const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repoRoot, encoding: "utf-8" }).trim();
	const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
	if (!match) {
		throw new Error(`无法从 origin 解析出 GitHub 仓库：${url}`);
	}
	return { owner: match[1], repo: match[2] };
}

/** 取该版本的变更记录：复用仓库里已有的 release-notes.mjs（它会把相对链接改写成指向该 tag 的绝对链接） */
function buildChangelogNotes(version, tag) {
	const out = join(repoRoot, "release", `${tag}-changelog.md`);
	execFileSync(
		process.execPath,
		["scripts/release-notes.mjs", "extract", "--version", version, "--tag", tag, "--out", out],
		{ cwd: repoRoot, stdio: "inherit" },
	);
	return readFileSync(out, "utf-8").trim();
}

/**
 * 用模板 + 该版本的变更记录拼出 Release 说明。
 *
 * 模板只放「不随版本变的东西」（安装步骤、文档入口、致谢），能力清单一律不写——那种列表必然过期
 * （上一版模板里还写着「内置工具六个」），变更记录才是事实来源。
 */
function buildBody(version, repo) {
	const template = readFileSync(join(repoRoot, "scripts/release-notes-template.md"), "utf-8");
	const assetUrl = `https://github.com/${repo.owner}/${repo.repo}/releases/download/v${version}/limkenion-${version}.tgz`;
	const notes = buildChangelogNotes(version, `v${version}`);
	return `${template
		.replaceAll("{{version}}", version)
		.replaceAll("{{assetUrl}}", assetUrl)
		.replaceAll("{{repoUrl}}", `https://github.com/${repo.owner}/${repo.repo}`)
		.trimEnd()}\n\n<details>\n<summary>完整变更记录（packages/cli/CHANGELOG.md）</summary>\n\n${notes}\n\n</details>\n`;
}

/** GitHub API 的一层薄封装；返回解析后的 JSON（204 之类没有正文时返回 null） */
async function api(token, method, path, body, extraHeaders = {}) {
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "limkenion-release",
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...extraHeaders,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${method} ${path} → HTTP ${response.status}${text ? `：${text.slice(0, 400)}` : ""}`);
	}
	return text === "" ? null : JSON.parse(text);
}

/** 上传一个附件；先删同名附件，避免 422「already_exists」 */
async function uploadAsset(token, repo, releaseId, name, path) {
	const assets = (await api(token, "GET", `/repos/${repo.owner}/${repo.repo}/releases/${releaseId}/assets`)) ?? [];
	for (const asset of assets.filter((item) => item.name === name)) {
		await api(token, "DELETE", `/repos/${repo.owner}/${repo.repo}/releases/assets/${asset.id}`);
		console.log(`  删除旧 ${name}（${asset.size} 字节）`);
	}
	const bytes = readFileSync(path);
	const response = await fetch(
		`https://uploads.github.com/repos/${repo.owner}/${repo.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/octet-stream",
				"User-Agent": "limkenion-release",
			},
			body: bytes,
		},
	);
	if (!response.ok) {
		throw new Error(`上传 ${name} → HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
	}
	console.log(`  上传 ${name}（${bytes.length} 字节）→ HTTP ${response.status} uploaded`);
}

const version = tagArg === undefined ? readVersion() : tagArg.replace(/^v/, "");
const tag = `v${version}`;
if (tagArg !== undefined && tagArg !== tag) {
	console.error(`用法：--tag 要么写 v${version}，要么省略。`);
	process.exit(1);
}
if (version !== readVersion()) {
	console.error(`错误：--tag 的版本（${version}）与包版本（${readVersion()}）不一致。`);
	process.exit(1);
}

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token && !dryRun) {
	console.error("缺少 GH_TOKEN（或 GITHUB_TOKEN）。");
	process.exit(1);
}

const repo = readRepo();

/**
 * 发布前置检查：安装包与源码归档必须来自同一份代码。
 *
 * tgz/zip 是**从工作区**构建的，而 `-source.*` 是 `git archive <tag>` 出来的。工作区比 tag 新
 * （或脏）时，发出去的就是「装的包和源码对不上」的版本——同一版本号两种内容，正是要避免的事。
 */
function assertReleaseReady(tag) {
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" }).trim();
	if (status !== "") {
		throw new Error(
			`工作区有未提交的改动，先提交（或 stash）再发布：\n${status
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n")}`,
		);
	}
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();
	let tagged;
	try {
		tagged = execFileSync("git", ["rev-list", "-n", "1", tag], { cwd: repoRoot, encoding: "utf-8" }).trim();
	} catch {
		throw new Error(`本地没有标签 ${tag}：先跑 node scripts/release.mjs <版本>，它会升版本、打标签并推上去。`);
	}
	if (head !== tagged) {
		throw new Error(
			`HEAD（${head.slice(0, 8)}）不是标签 ${tag} 指向的提交（${tagged.slice(0, 8)}）：` +
				"要么把这份代码归到新版本号下，要么切回标签指的那份再发布。",
		);
	}
	const remote = execFileSync("git", ["ls-remote", "--tags", "origin", tag], { cwd: repoRoot, encoding: "utf-8" });
	if (remote.trim() === "") {
		throw new Error(`远端没有标签 ${tag}：GitHub 会拿默认分支的 HEAD 现造一个，等于把版本指向错的代码。先 git push origin ${tag}。`);
	}
	console.log(`前置检查通过：工作区干净，HEAD 就是 ${tag}，且标签已在远端。`);
}

assertReleaseReady(tag);
console.log(`准备发布 ${tag} 到 ${repo.owner}/${repo.repo}`);

// 1. 打包（内部会先清 dist 再构建，所以删过的源文件不会留在包里）
console.log("打包…");
if (!dryRun) {
	// 走 scripts/npm-command.mjs 那条路：`shell: true` 配参数数组会触发 DEP0190（Node 明确警告的写法）
	runNpm(["run", "release:package"], { cwd: repoRoot });
}

// 2. 源码归档：从 tag 导出，只含 tracked 文件
const sourceArchives = [
	[`release/limkenion-${version}-source.tar.gz`, "tar.gz"],
	[`release/limkenion-${version}-source.zip`, "zip"],
];
for (const [path, format] of sourceArchives) {
	const full = join(repoRoot, path);
	if (dryRun) {
		console.log(`  （dry-run）会生成 ${path}`);
		continue;
	}
	execFileSync("git", ["archive", `--format=${format}`, `--prefix=limkenion-${version}/`, tag, "-o", full], {
		cwd: repoRoot,
	});
	console.log(`  生成 ${path}（${statSync(full).size} 字节）`);
}

const assets = [
	`limkenion-${version}.tgz`,
	`limkenion-${version}.zip`,
	`limkenion-${version}.tar.gz`,
	`limkenion-${version}-source.tar.gz`,
	`limkenion-${version}-source.zip`,
];
if (!dryRun) {
	const missing = assets.filter((name) => !existsSync(join(repoRoot, "release", name)));
	if (missing.length > 0) {
		console.error(`缺少产物：${missing.join("、")}`);
		process.exit(1);
	}
}

const body = buildBody(version, repo);
if (dryRun) {
	console.log(`\n（dry-run）Release 说明 ${body.length} 字节，前 300 字：\n${body.slice(0, 300)}…`);
	console.log(`（dry-run）会传这些附件：${assets.join("、")}`);
	process.exit(0);
}

// 3. 建或改 Release
const existing = await api(token, "GET", `/repos/${repo.owner}/${repo.repo}/releases/tags/${tag}`).catch(() => null);
const release = existing
	? await api(token, "PATCH", `/repos/${repo.owner}/${repo.repo}/releases/${existing.id}`, {
			name: `Limkenion ${tag}`,
			body,
		})
	: await api(token, "POST", `/repos/${repo.owner}/${repo.repo}/releases`, {
			tag_name: tag,
			name: `Limkenion ${tag}`,
			body,
			draft: false,
			prerelease: false,
		});
console.log(existing ? `Release ${tag} 已存在（id=${release.id}），更新说明` : `Release ${tag} 已创建（id=${release.id}）`);

// 4. 传附件
for (const name of assets) {
	await uploadAsset(token, repo, release.id, name, join(repoRoot, "release", name));
}

console.log("\n最终附件：");
for (const name of assets) {
	console.log(`  ${name}  ${statSync(join(repoRoot, "release", name)).size} 字节`);
}
writeFileSync(join(repoRoot, "release", `${tag}-notes.md`), body, "utf-8");
console.log(`\nRelease 地址：https://github.com/${repo.owner}/${repo.repo}/releases/tag/${tag}`);
