#!/usr/bin/env node

/**
 * 组装可分发的发布包。
 *
 * 产物：
 *   release/limkenion-<版本>/              解压即用的目录，直接运行 limkenion.cmd 即可
 *   release/limkenion-<版本>.zip           Windows 友好的压缩包
 *   release/limkenion-<版本>.tar.gz
 *   release/limkenion-<版本>.tgz  npm 兼容包，可用 npm install -g <URL> 全局安装
 *
 * 前三个是「解压即用」，不需要 npm；最后一个是给想走 npm 的人用的——发布只发生在 GitHub
 * （附件 URL），不需要 npm registry 账号，细节见 buildNpmTarball。
 *
 * 为什么不做单文件可执行：本项目运行时零外部依赖，三个包的 dist 加起来不到 500KB。
 * Node SEA / Bun 编译出来的单文件有 80MB 以上，还要额外处理前端静态资源的读取方式，
 * 收益不抵成本。这里只要求使用者已安装 Node >= 22。
 *
 * 用法：
 *   node scripts/build-release.mjs                # 先构建再打包
 *   node scripts/build-release.mjs --skip-build   # 直接用现有 dist
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./npm-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 命令行包所在目录：npm tarball 以它为主体，其余包作为内联依赖 */
const CLI_DIRECTORY = "packages/cli";

/** 要打进发布包的包，顺序即依赖顺序 */
const PACKAGES = [
	{ directory: "packages/ai", name: "limkenion-ai" },
	{ directory: "packages/core", name: "limkenion-core" },
	{ directory: "packages/cli", name: "limkenion" },
];

/** 发布包里的入口文件相对路径 */
const ENTRY = "node_modules/limkenion/dist/cli.js";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
	if (arg !== "--skip-build") {
		console.error(`未知参数：${arg}`);
		process.exit(1);
	}
}

/** 运行一条命令，失败即终止。不使用 shell，参数交给 Node 处理，避免拼接引号的问题。 */
function run(command, commandArgs, options = {}) {
	const result = spawnSync(command, commandArgs, {
		cwd: options.cwd ?? repoRoot,
		stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`命令失败：${command} ${commandArgs.join(" ")}`);
	}
	return result.stdout ?? "";
}

/** 递归统计目录大小 */
function directorySize(directory) {
	let total = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			total += directorySize(full);
		} else if (entry.isFile()) {
			total += statSync(full).size;
		}
	}
	return total;
}

/** 把字节数格式化成人类可读文本 */
function formatSize(bytes) {
	return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

if (!args.has("--skip-build")) {
	console.log("构建三个包…");
	// 先清掉三个包的 dist 再构建：tsc 只增不删，源文件被删掉之后旧产物会一直留在 dist 里，
	// 然后被打进 tgz（删掉 pricing.ts 那次，安装产物里就还躺着一个 pricing.js）。
	for (const pkg of PACKAGES) {
		rmSync(join(repoRoot, pkg.directory, "dist"), { recursive: true, force: true });
	}
	// 显式给 cwd：本脚本可能从任意目录被调用，而 npm 必须在仓库根跑。
	runNpm(["run", "build"], { cwd: repoRoot });
}

const version = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8")).version;
const releaseRoot = join(repoRoot, "release");
const staging = join(releaseRoot, `limkenion-${version}`);

// 每次全新组装，避免上一版删掉的文件留在包里。
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

for (const pkg of PACKAGES) {
	const source = join(repoRoot, pkg.directory);
	if (!existsSync(join(source, "dist"))) {
		throw new Error(`${pkg.directory} 缺少 dist，请先运行 npm run build`);
	}
	const target = join(staging, "node_modules", ...pkg.name.split("/"));
	mkdirSync(target, { recursive: true });
	// 只要 package.json、dist 与 LICENSE：源码、测试、脚本都不进发布包。
	cpSync(join(source, "package.json"), join(target, "package.json"));
	cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
	// MIT 要求副本附带版权声明，LICENSE 必须随包走。
	cpSync(join(source, "LICENSE"), join(target, "LICENSE"));
	console.log(`  已打包 ${pkg.name}`);
}

// --- 启动器 ---
// 都用自身所在目录定位入口，因此发布包可以解压到任意路径（包括含中文的路径）。

writeFileSync(
	join(staging, "limkenion.cmd"),
	[
		"@echo off",
		"setlocal",
		`set "ENTRY=%~dp0${ENTRY.replaceAll("/", "\\")}"`,
		'node "%ENTRY%" %*',
		"exit /b %ERRORLEVEL%",
		"",
	].join("\r\n"),
	"utf8",
);

// Windows PowerShell 5.1 在没有 BOM 时按 ANSI 代码页读 .ps1，中文注释和字符串会乱码
// 直接导致语法错误，所以 PowerShell 脚本必须带 BOM 写。
function writePowerShellScript(path, lines) {
	writeFileSync(path, `\uFEFF${lines.join("\n")}`, "utf8");
}

writePowerShellScript(join(staging, "limkenion.ps1"), [
	"# Limkenion 启动器。用 $PSScriptRoot 定位入口，不依赖当前工作目录。",
	`$entry = Join-Path $PSScriptRoot "${ENTRY}"`,
	"if (-not (Test-Path -LiteralPath $entry)) {",
	'	throw "找不到入口：$entry。请确认发布包已完整解压。"',
	"}",
	"& node $entry @args",
	"exit $LASTEXITCODE",
	"",
]);

writeFileSync(
	join(staging, "limkenion"),
	[
		"#!/usr/bin/env sh",
		"# Limkenion 启动器。用脚本自身位置定位入口，不依赖当前工作目录。",
		"set -e",
		'here=$(cd "$(dirname "$0")" && pwd)',
		`exec node "$here/${ENTRY}" "$@"`,
		"",
	].join("\n"),
	"utf8",
);

writeFileSync(
	join(staging, "README.md"),
	[
		"# Limkenion 发布包",
		"",
		`版本 ${version}。解压后即可使用，不需要 npm install。`,
		"",
		"## 前提",
		"",
		"- Node.js >= 22.19（`node --version` 检查）",
		"- DeepSeek API Key",
		"",
		"## 安装",
		"",
		"把整个目录放到任意位置（路径含中文也可以），然后设置 API Key：",
		"",
		"```powershell",
		'[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-你的密钥", "User")',
		"# 之后重开终端生效",
		"```",
		"",
		"## 使用",
		"",
		"**工作目录就是你启动时所在的目录**，工具的相对路径以它为基准，所以先 cd 到要改的项目。",
		"",
		"```powershell",
		"cd D:\\你的项目",
		"D:\\解压位置\\limkenion.cmd                     # 交互模式",
		'D:\\解压位置\\limkenion.cmd "给这个仓库补一个 LICENSE"',
		'D:\\解压位置\\limkenion.cmd -p "解释 src/config.ts"',
		"D:\\解压位置\\limkenion.cmd web                 # 浏览器界面 http://127.0.0.1:4887",
		"```",
		"",
		"PowerShell 下也可以用 `limkenion.ps1`，Linux/macOS 下 `./limkenion`（可能需要 `chmod +x limkenion`）。",
		"",
		"想直接敲 `limkenion`，把解压目录加进 PATH 即可。",
		"",
		"## 命令行选项",
		"",
		"| 选项 | 作用 |",
		"|------|------|",
		"| `-p, --print <文本>` | 一次性执行并输出结果 |",
		"| `-m, --model <id>` | 指定模型，默认 `deepseek-flash` |",
		"| `-c, --continue` | 继续当前目录下最近的会话 |",
		"| `--api-key <key>` | 指定 API Key |",
		"| `--base-url <url>` | 指定接口地址 |",
		"| `--max-turns <n>` | 单次指令最多几轮工具调用，默认 25 |",
		"| `-v, --verbose` | 显示思维链与完整工具输出 |",
		"| `-h` / `-V` | 帮助 / 版本号 |",
		"",
		"REPL 内命令：`/help`、`/quit`、`/clear`、`/model <id>`、`/history`。",
		"",
		"## 浏览器界面",
		"",
		"```powershell",
		"limkenion.cmd web                      # http://127.0.0.1:4887 并打开浏览器",
		"limkenion.cmd web --no-open            # 只起服务，不打开浏览器",
		"limkenion.cmd web --port 0             # 换空闲端口",
		"limkenion.cmd web --host 0.0.0.0       # 局域网可访问，无认证，仅限可信网络",
		"```",
		"",
		"SSH 会话下不会自动打开浏览器，只打印地址——浏览器不在本机，端口转发交给",
		"SSH 客户端或编辑器。",
		"",
		"界面：左侧会话列表（新建/切换/删除），中间流式对话与工具卡片，右侧文件只读预览，",
		"左下切换模型与主题。工具卡片入参里带 `path` 时会出现「预览文件」按钮。",
		"不同会话可以同时生成。",
		"",
		"## 会话存放位置",
		"",
		"```",
		"~/.limkenion/agent/sessions/--<编码后的工作目录>--/<时间戳>.jsonl",
		"```",
		"",
		"命令行与浏览器界面共用同一份存储。用 `LIMKENION_CODING_AGENT_SESSION_DIR` 可以改位置。",
		"",
		"## 安全说明",
		"",
		"本工具没有沙箱与权限系统：四个系统工具以当前用户权限直接操作文件与执行命令。",
		"浏览器界面默认只绑定回环地址，也没有认证与 TLS。需要隔离请用容器或虚拟机。",
		"",
		"## 许可证",
		"",
		"MIT。完整许可证见包内 各依赖包内的 LICENSE。",
		"",
	].join("\n"),
	"utf8",
);

// --- npm 兼容包 ---

/** 一个包要带进 tarball 的文件；不存在的直接跳过 */
const PACKAGE_FILES = ["package.json", "LICENSE", "README.md", "CHANGELOG.md"];

/** 把一个包的元数据与 dist 复制到目标目录 */
function copyPackageFiles(source, target) {
	mkdirSync(target, { recursive: true });
	for (const name of PACKAGE_FILES) {
		const from = join(source, name);
		if (existsSync(from)) {
			cpSync(from, join(target, name));
		}
	}
	cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
}

/**
 * 组装一个自包含的 npm 兼容 tarball。
 *
 * 用途：发布只发生在 GitHub，使用者拿 Release 附件的 URL 直接 `npm install -g <URL>`，
 * 不需要 npm registry 账号，也不必手动解压和配 PATH。
 *
 * 为什么要把两个依赖内联：它们互为依赖，而 registry 上没有这三个包，npm 装到
 * limkenion 时会去找 limkenion-core 却找不到。package.json 里的
 * bundleDependencies 告诉 npm「这两个已随包附带，别去 registry 拉」，但它的前提是依赖
 * 物理存在于包内的 node_modules 下——工作区把依赖提升到了根 node_modules，包目录里没有，
 * 所以这里手动摆一份（实测这样装出来的 tarball 可以完全离线安装）。
 */
function buildNpmTarball(version) {
	const staging = mkdtempSync(join(tmpdir(), "limkenion-npm-"));
	try {
		const root = join(staging, "package");
		copyPackageFiles(join(repoRoot, CLI_DIRECTORY), root);
		for (const pkg of PACKAGES.filter((candidate) => candidate.directory !== CLI_DIRECTORY)) {
			copyPackageFiles(join(repoRoot, pkg.directory), join(root, "node_modules", ...pkg.name.split("/")));
		}

		const target = join(releaseRoot, `limkenion-${version}.tgz`);
		run("tar", ["-czf", target, "-C", staging, "package"]);
		return target;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

// --- 压缩 ---
console.log("生成压缩包…");
const artifacts = [staging];
const base = `limkenion-${version}`;

// Windows 自带的 tar 是 bsdtar，支持用 -a 按扩展名决定格式，因此不必依赖 zip 命令。
const zip = `${base}.zip`;
const zipResult = spawnSync("tar", ["-a", "-c", "-f", zip, base], { cwd: releaseRoot, stdio: "ignore" });
if (zipResult.status === 0) {
	artifacts.push(join(releaseRoot, zip));
} else {
	console.warn("  跳过 zip：当前 tar 不支持 -a（非 bsdtar）");
}

const tarball = `${base}.tar.gz`;
run("tar", ["-czf", tarball, base], { cwd: releaseRoot, capture: true });
artifacts.push(join(releaseRoot, tarball));

artifacts.push(buildNpmTarball(version));

console.log("\n完成：");
for (const artifact of artifacts) {
	const isDirectory = statSync(artifact).isDirectory();
	const size = isDirectory ? directorySize(artifact) : statSync(artifact).size;
	console.log(`  ${artifact.replace(`${repoRoot}\\`, "").replace(`${repoRoot}/`, "")}  ${formatSize(size)}`);
}
console.log("\n解压即用：解开 limkenion-<版本>.zip，运行 limkenion.cmd（或 ./limkenion）。");
console.log(`全局安装：npm install -g <Release 附件 limkenion-${version}.tgz 的下载地址>`);
