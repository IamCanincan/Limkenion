#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_REPO = "IamCanincan/Limkenion";
const DEFAULT_BASE_PATH = "packages/cli";
const DEFAULT_CHANGELOG = "packages/cli/CHANGELOG.md";
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

function printUsage() {
	console.log(`用法：node scripts/release-notes.mjs extract [选项]

从 cli 包的变更日志中提取发布说明，并把其中的相对链接改写成指向发布标签的绝对链接。

选项：
  --version <x.y.z>    要提取的版本
  --tag <vX.Y.Z>       用于仓库链接的发布标签（默认为 v<version>）
  --changelog <路径>   变更日志路径（默认：${DEFAULT_CHANGELOG}）
  --out <路径>         输出文件（默认：stdout）
  --repo <owner/repo>  生成链接使用的 GitHub 仓库（默认：${DEFAULT_REPO}）
  --base-path <路径>   变更日志相对链接的基准路径（默认：${DEFAULT_BASE_PATH}）
`);
}

function parseOptions(args) {
	const options = {
		basePath: DEFAULT_BASE_PATH,
		changelog: DEFAULT_CHANGELOG,
		out: undefined,
		repo: DEFAULT_REPO,
		tag: undefined,
		version: undefined,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}

		const optionNames = new Set(["--base-path", "--changelog", "--out", "--repo", "--tag", "--version"]);
		if (!optionNames.has(arg)) {
			throw new Error(`未知选项：${arg}`);
		}

		const value = args[++i];
		if (!value) {
			throw new Error(`${arg} 需要一个值`);
		}

		if (arg === "--base-path") options.basePath = value;
		if (arg === "--changelog") options.changelog = value;
		if (arg === "--out") options.out = value;
		if (arg === "--repo") options.repo = value;
		if (arg === "--tag") options.tag = value;
		if (arg === "--version") options.version = value;
	}

	return options;
}

function normalizeTag(tagOrVersion) {
	if (!tagOrVersion) {
		return undefined;
	}
	return tagOrVersion.startsWith("v") ? tagOrVersion : `v${tagOrVersion}`;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractChangelogSection(changelog, version) {
	const headingRe = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");
	const heading = headingRe.exec(changelog);

	if (!heading) {
		return "";
	}

	const sectionStart = heading.index + heading[0].length;
	const rest = changelog.slice(sectionStart);
	const nextHeading = rest.search(/^## \[/m);
	const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
	return section.trim();
}

function splitLocalTarget(target) {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value) {
	return value.replaceAll("\\", "/");
}

function normalizeBasePath(basePath) {
	const normalized = path.posix.normalize(normalizePathPart(basePath)).replace(/\/+$/, "");
	return normalized === "." ? "" : normalized;
}

function resolveRepositoryPath(targetPath, basePath) {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(normalizeBasePath(basePath), normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath, repositoryPath) {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeLinkTarget(target, options) {
	let canonicalTarget = target;
	const repoUrl = `https://github.com/${options.repo}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${options.tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart, options.basePath);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${options.repo}/${route}/${options.tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

function normalizeReleaseNoteLinks(markdown, options) {
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (match, prefix, target, suffix) => {
		return `${prefix}${normalizeLinkTarget(target, options)}${suffix}`;
	});
}

function extractReleaseNotes(options) {
	const version = options.version ?? (options.tag ? normalizeTag(options.tag).slice(1) : undefined);
	if (!version) {
		throw new Error("extract 需要 --version 或 --tag");
	}

	if (!existsSync(options.changelog)) {
		throw new Error(`变更日志不存在：${options.changelog}`);
	}

	const tag = normalizeTag(options.tag ?? version);
	const changelog = readFileSync(options.changelog, "utf8");
	const section = extractChangelogSection(changelog, version);
	const rawNotes = section ? `${section}\n` : `发布 ${version}\n`;
	const markdown = normalizeReleaseNoteLinks(rawNotes, { basePath: options.basePath, repo: options.repo, tag });

	if (options.out) {
		writeFileSync(options.out, markdown);
		return;
	}

	process.stdout.write(markdown);
}

try {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "--help") {
		printUsage();
		process.exit(command ? 0 : 1);
	}

	if (command !== "extract") {
		throw new Error(`未知命令：${command}`);
	}

	extractReleaseNotes(parseOptions(args));
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
