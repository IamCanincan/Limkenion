/**
 * 文档里钉住的版本号必须等于当前版本。
 *
 * README 的安装命令是「带版本号的 Release 附件 URL」——它能直接复制粘贴运行，代价是每次发版都会
 * 指向上一个版本，而这类漂移没人会主动去改（发 1.3.1 时 README 还写着 1.0.0）。所以交给门禁：
 * 出现 `releases/download/vX.Y.Z/limkenion-X.Y.Z.` 的地方，两处 X.Y.Z 都必须等于
 * `packages/cli/package.json` 的版本。
 *
 * 只查这一种「会被当成命令执行」的形态；CHANGELOG 里的历史版本号、以及散文里提到的旧版本号
 * （比如 AGENTS.md 拿 v1.0.0 当反面例子）都不受影响。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 会被当成安装命令执行的版本引用 */
export const ASSET_URL_PATTERN = /releases\/download\/v(\d+\.\d+\.\d+)\/limkenion-(\d+\.\d+\.\d+)\./g;

/** 要检查的文档：仓库根的说明文件 + 各包的 README。CHANGELOG 是历史记录，不查 */
function documents() {
	const files = ["README.md", "CONTRIBUTING.md", "AGENTS.md"];
	for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
		if (entry.isDirectory()) {
			files.push(join("packages", entry.name, "README.md"));
		}
	}
	return files;
}

/** 找出文本里所有附件 URL 引用的版本（去重，保留出现顺序） */
export function referencedVersions(text) {
	const found = [];
	for (const match of text.matchAll(ASSET_URL_PATTERN)) {
		const [, tagVersion, assetVersion] = match;
		found.push({ tagVersion, assetVersion });
	}
	return found;
}

const currentVersion = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf-8")).version;
const problems = [];
let scanned = 0;

for (const relative of documents()) {
	let text;
	try {
		text = readFileSync(join(repoRoot, relative), "utf-8");
	} catch {
		continue;
	}
	scanned += 1;
	for (const { tagVersion, assetVersion } of referencedVersions(text)) {
		if (tagVersion !== currentVersion || assetVersion !== currentVersion) {
			problems.push({ relative, tagVersion, assetVersion });
		}
	}
}

console.log(`文档版本检查：当前版本 ${currentVersion}，扫了 ${scanned} 个文档。`);

if (problems.length > 0) {
	console.error("\n以下安装命令指向的版本与当前版本不一致：");
	for (const problem of problems) {
		console.error(
			`  ${problem.relative}: 标签 v${problem.tagVersion} / 附件 ${problem.assetVersion} → 应为 ${currentVersion}`,
		);
	}
	console.error(`\n把它们改成 v${currentVersion} / limkenion-${currentVersion} 后再提交。`);
	process.exit(1);
}

console.log("文档里钉住的安装版本与当前版本一致。");
