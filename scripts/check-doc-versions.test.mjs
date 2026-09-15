// 文档版本检查的单元测试：只认「会被当成命令执行」的附件 URL，别的一概不管。
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { referencedVersions } from "./check-doc-versions.mjs";

test("从安装命令里抽出标签版本与附件版本", () => {
	const text = [
		"```bash",
		"npm install -g https://github.com/IamCanincan/Limkenion/releases/download/v1.3.1/limkenion-1.3.1.tgz",
		"npx --yes --package=https://github.com/IamCanincan/Limkenion/releases/download/v1.3.1/limkenion-1.3.1.tgz limkenion web",
		"```",
	].join("\n");

	assert.deepEqual(referencedVersions(text), [
		{ tagVersion: "1.3.1", assetVersion: "1.3.1" },
		{ tagVersion: "1.3.1", assetVersion: "1.3.1" },
	]);
});

test("散文里的旧版本号、CHANGELOG 式标题都不算", () => {
	const text = [
		"- **不要强推已经发布出去的 tag**。`v1.0.0` 曾被反复强推 + 重传附件。",
		"## [1.0.0] - 2026-09-11",
		"把地址里的 1.3.1 换成你要的版本",
	].join("\n");

	assert.deepEqual(referencedVersions(text), []);
});

test("标签与附件版本不一致时两条都抽出来（由调用方判定不合格）", () => {
	const text = "https://github.com/o/r/releases/download/v1.0.0/limkenion-1.3.1.tgz";
	assert.deepEqual(referencedVersions(text), [{ tagVersion: "1.0.0", assetVersion: "1.3.1" }]);
});
