#!/usr/bin/env node

/**
 * 校验每个公开包的 LICENSE 与仓库根的完全一致。
 *
 * MIT 要求「副本必须附带版权声明」，所以每个包目录下都要有一份 LICENSE —— npm 打包时会
 * 自动收录包根目录下的 LICENSE，不需要写进 files。副本一旦与根文件不一致，发出去的包带的
 * 就是过期声明，因此这里逐字节比对（忽略行尾差异，.gitattributes 会按平台转换 CRLF）。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (text) => text.replaceAll("\r\n", "\n");

const rootLicense = normalize(readFileSync(join(repoRoot, "LICENSE"), "utf-8"));
const problems = [];

for (const pkg of getPublicWorkspacePackages()) {
	const path = join(repoRoot, pkg.directory, "LICENSE");
	if (!existsSync(path)) {
		problems.push(`${pkg.directory}/LICENSE 不存在，发出的包不会带版权声明`);
		continue;
	}
	if (normalize(readFileSync(path, "utf-8")) !== rootLicense) {
		problems.push(`${pkg.directory}/LICENSE 与根 LICENSE 不一致`);
	}
}

if (problems.length > 0) {
	console.error("LICENSE 校验失败：");
	for (const problem of problems) {
		console.error(`  ${problem}`);
	}
	console.error("\n修复：把根 LICENSE 复制到对应包目录。");
	process.exit(1);
}

console.log(`LICENSE 已随每个公开包分发（${getPublicWorkspacePackages().length} 个）。`);
