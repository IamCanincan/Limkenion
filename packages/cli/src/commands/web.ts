/**
 * `limkenion web` 子命令：启动浏览器界面。
 *
 * 服务器一直运行到收到 SIGINT/SIGTERM，因此命令返回的 Promise 只在关闭之后 resolve。
 * 启动后会尝试打开系统默认浏览器；SSH 会话下不打开，只打印地址。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL_ID, DEFAULT_RETRIES, describeError, readBaseUrlOverride, readModelOverride } from "limkenion-ai";
import {
	type ApprovalMode,
	DEFAULT_MAX_TURNS,
	OUTPUT_STYLES,
	type OutputStyle,
	type PlanMode,
	parseApprovalMode,
	parseOutputStyle,
	parsePlanMode,
	STYLE_GUIDE,
} from "limkenion-core";
import { APP_NAME, getAgentDir } from "../config.ts";
import { resolveApiKey } from "../credentials.ts";
import { readSettings } from "../settings.ts";
import { DEFAULT_WEB_PORT, startWebServer } from "../web/server.ts";
import type { Command, CommandHost } from "./command.ts";
import { EXIT_USAGE } from "./common.ts";

/** web 子命令：元信息住在命令自己这里，注册表只负责收（元信息跟着命令自己走） */
export const webCommand: Command = {
	name: "web",
	synopsis: "web",
	summary: "启动浏览器界面",
	run: runWebCommand,
};

/** web 子命令的选项 */
interface WebCommandOptions {
	host: string;
	port: number;
	model: string;
	apiKey: string;
	baseUrl: string | undefined;
	/** 审批模式 */
	approval: ApprovalMode;
	/** 计划模式档位：网页打开时就是这个档，之后可以在界面上改 */
	plan: PlanMode;
	/** 输出风格：同上，打开时生效，之后可以在界面上改 */
	style: OutputStyle;
	/** 上下文压缩：false 时上下文不再自动压缩（侧栏里还能开关） */
	compaction: boolean;
	/** 单次指令最多几轮工具调用 */
	maxTurns: number;
	/** 请求失败的重试次数 */
	retries: number;
	/**
	 * 网页上那个「更新」按钮用的源码目录。
	 *
	 * 自更新要跑门禁与打包，得知道源码在哪；不给就只能在网页上回滚（更新去终端跑）。
	 * 从**启动参数**来而不是从请求体来：网页只能更新这台机器上已经指定的那个目录，
	 * 否则一个 POST 就能让服务在任意目录里跑构建脚本。
	 */
	selfSource: string | undefined;
	/** 是否尝试打开系统默认浏览器 */
	open: boolean;
	help: boolean;
}

/** web 子命令的用法说明 */
function webUsage(): string {
	return [
		`${APP_NAME} web - 启动浏览器界面`,
		"",
		"用法：",
		`  ${APP_NAME} web                     默认 http://127.0.0.1:${DEFAULT_WEB_PORT} 并打开浏览器`,
		`  ${APP_NAME} web --port 0            让系统分配空闲端口`,
		`  ${APP_NAME} web --no-open           只启动服务，不打开浏览器`,
		`  ${APP_NAME} web --host 0.0.0.0      对局域网开放，无认证，谨慎使用`,
		"",
		"选项：",
		`      --port <n>         监听端口，默认 ${DEFAULT_WEB_PORT}，0 表示由系统分配`,
		"      --host <addr>      监听地址，默认 127.0.0.1",
		"      --no-open          不打开浏览器",
		"  -m, --model <id>       新建会话使用的模型",
		"      --api-key <key>    指定 API Key，默认读 DEEPSEEK_API_KEY",
		"      --base-url <url>   指定接口地址",
		"      --approval <mode>  工具审批：auto 常规放行（疑似危险命令仍要确认）/ ask 读写前确认 / readonly 只读",
		"      --plan[=strict|guide]  计划模式启动：严格档只读地出方案，引导档先出方案但工具不设限",
		`      --style <name>     输出风格：${OUTPUT_STYLES.map((name) => `${name}（${STYLE_GUIDE[name]}）`).join(" / ")}`,
		"      --no-compact       关掉上下文自动压缩（排查压缩丢内容时用）",
		`      --max-turns <n>    单次指令最多几轮工具调用，默认 ${DEFAULT_MAX_TURNS}`,
		`      --retries <n>      限速或 5xx 时的重试次数，默认 ${DEFAULT_RETRIES}，0 表示不重试`,
		"      --from <目录>      源码目录：给网页上那个「更新」按钮用（更新要跑门禁与打包）",
		"  -h, --help             显示本帮助",
		"",
		"这些默认值也会从 config.json 里取（项目 < 用户 < managed），命令行优先；",
		"网页里还能随时改审批与计划档位。",
		"",
		"界面能力：会话列表与切换、流式对话与一行式工具行、模型切换、停止生成、",
		"文件只读预览（点击工具行里的“预览文件”）、主题切换。多个会话可同时生成。",
	].join("\n");
}

/** 解析端口，非法值回退到默认；0 是合法值，表示由系统分配 */
function toPort(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_WEB_PORT;
}

/** 解析 --max-turns，非法值返回 null（交给调用方退回配置或内核默认） */
function toMaxTurns(raw: string | undefined): number | null {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 200 ? parsed : null;
}

/** 解析 --retries，非法值返回 null（0 是合法值，表示不重试） */
function toRetries(raw: string | undefined): number | null {
	if (raw === undefined) {
		return null;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
}

/** 校验监听地址，只允许回环与明确的对外绑定 */
function isSupportedHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "0.0.0.0";
}

/** 解析 web 子命令参数；语法错误时打印用法并返回 "error" */
function parseWebOptions(argv: string[], host: CommandHost): WebCommandOptions | "error" {
	try {
		const { values } = parseArgs({
			// 复用主命令那份规范化：`--plan` 可以不带档位（等于严格档），带档位时才吃掉下一段。
			// 写法归一化归宿主管（见 `CommandHost`）：这个命令只声明它要解析好的 argv。
			args: host.normalizePlanArgv(argv),
			allowPositionals: false,
			options: {
				port: { type: "string" },
				host: { type: "string" },
				"no-open": { type: "boolean" },
				model: { type: "string", short: "m" },
				"api-key": { type: "string" },
				"base-url": { type: "string" },
				approval: { type: "string" },
				// `--plan` 不带值时用严格档；带了非法值就当没给（与主命令一致，不因为一个笔误拒绝启动）。
				plan: { type: "string" },
				style: { type: "string" },
				// 关掉上下文压缩（排查「压缩是不是丢了我要的东西」时用），网页侧栏里还能再开关。
				"no-compact": { type: "boolean" },
				"max-turns": { type: "string" },
				retries: { type: "string" },
				// 网页上那个「更新」按钮要从源码构建，所以得告诉它源码在哪
				from: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
		const settings = readSettings();
		return {
			host: values.host?.trim() || "127.0.0.1",
			port: toPort(values.port),
			model: values.model?.trim() || readModelOverride() || settings.model || DEFAULT_MODEL_ID,
			apiKey: resolveApiKey(values["api-key"]).key,
			baseUrl: values["base-url"]?.trim() || readBaseUrlOverride() || settings.baseUrl,
			approval: parseApprovalMode(values.approval?.trim() ?? settings.approval, "auto"),
			plan: parsePlanMode(values.plan?.trim() ?? settings.planMode) ?? "off",
			style: parseOutputStyle(values.style?.trim()) ?? settings.style ?? "default",
			// 命令行给了 --no-compact 就以它为准；否则跟配置；配置没写就是开（与主命令同一套优先级）。
			compaction: values["no-compact"] === true ? false : (settings.compaction ?? true),
			maxTurns: toMaxTurns(values["max-turns"]) ?? settings.maxTurns ?? DEFAULT_MAX_TURNS,
			retries: toRetries(values.retries) ?? settings.retries ?? DEFAULT_RETRIES,
			selfSource: values.from?.trim() || undefined,
			open: values["no-open"] !== true,
			help: values.help === true,
		};
	} catch (error) {
		process.stderr.write(`参数错误：${describeError(error)}\n\n${webUsage()}\n`);
		return "error";
	}
}

/**
 * 是否在 SSH 会话里启动。
 *
 * 与 dsh 一致，只看 SSH_CONNECTION 与 SSH_TTY。这种情况下浏览器不在本机，
 * 自动打开没有意义——地址由 SSH 客户端或编辑器自己做端口转发，所以只打印地址。
 */
function launchedOverSsh(): boolean {
	return [process.env.SSH_CONNECTION, process.env.SSH_TTY].some((value) => value !== undefined && value !== "");
}

/** 各平台打开 URL 的命令 */
function browserCommand(url: string): { command: string; args: string[] } {
	if (process.platform === "win32") {
		// start 是 cmd 的内建命令。第一个空串是窗口标题——不给的话 start 会把带引号的
		// URL 当成标题，浏览器就打不开了。
		return { command: "cmd", args: ["/c", "start", "", url] };
	}
	if (process.platform === "darwin") {
		return { command: "open", args: [url] };
	}
	return { command: "xdg-open", args: [url] };
}

/**
 * 打开系统默认浏览器。
 *
 * detached + unref 让浏览器与服务器彻底脱钩：服务器 Ctrl+C 退出时不会拖着浏览器，
 * 也不会因为浏览器还开着而卡住进程退出。失败只提示，不影响服务本身。
 */
function openBrowser(url: string): void {
	const { command, args } = browserCommand(url);
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		// spawn 失败是以 error 事件异步抛出的；不接住会变成未捕获异常，把服务器带崩。
		child.on("error", (error: unknown) => {
			const reason = describeError(error);
			process.stderr.write(`无法打开浏览器（${reason}），请手动访问上面的地址。\n`);
		});
		child.unref();
	} catch (error) {
		const reason = describeError(error);
		process.stderr.write(`无法打开浏览器（${reason}），请手动访问上面的地址。\n`);
	}
}

/** 打印启动信息与必要的警告 */
function reportStartup(options: WebCommandOptions, cwd: string, url: string): void {
	process.stderr.write(`Limkenion Web UI: ${url}\n`);
	process.stderr.write(
		`工作目录：${cwd === "" ? "未选择（在网页上点「新建会话」时会先让你选一个）" : cwd}\n模型：${options.model}\n审批：${options.approval}\n`,
	);
	if (options.apiKey === "") {
		process.stderr.write(
			`提示：没有密钥时可以先启动，在网页侧栏的「接口密钥」里填，也可以在命令行运行 ${APP_NAME} auth login。\n`,
		);
	}
	// 说清网页上能不能「更新」：给了 --from 才提供，否则只有回滚
	process.stderr.write(
		options.selfSource === undefined
			? `自更新：网页上只提供回滚（更新要从源码构建，加 --from <源码目录> 后也能在网页上点）\n`
			: `自更新源码目录：${options.selfSource}\n`,
	);
	if (options.host === "0.0.0.0") {
		process.stderr.write("警告：已对非回环地址开放。该服务没有认证与 TLS，只应部署在可信网络。\n");
	}
	process.stderr.write("按 Ctrl+C 停止。\n");
}

/** 按需把地址交给系统浏览器 */
function handOffToBrowser(options: WebCommandOptions, url: string): void {
	if (!options.open) {
		return;
	}
	if (launchedOverSsh()) {
		process.stderr.write("检测到 SSH 会话，不自动打开浏览器；请在本地做端口转发后访问上面的地址。\n");
		return;
	}
	process.stderr.write(`正在打开默认浏览器；加 --no-open 可关闭。\n`);
	openBrowser(url);
}

/** 运行 web 子命令，返回进程退出码 */
export async function runWebCommand(argv: string[], host: CommandHost): Promise<number> {
	const options = parseWebOptions(argv, host);
	if (options === "error") {
		return EXIT_USAGE;
	}
	if (options.help) {
		process.stdout.write(`${webUsage()}\n`);
		return 0;
	}
	if (!isSupportedHost(options.host)) {
		process.stderr.write(`不支持的 --host：${options.host}。只支持 127.0.0.1、::1、localhost 或 0.0.0.0。\n`);
		return EXIT_USAGE;
	}

	/*
	 * 工作目录**默认是空的**：由使用者在网页里自己选（点「新建会话」会先摆出目录选择器，
	 * 也可以在某一行会话的 ▾ 菜单里换）。
	 *
	 * 以前这里传 `process.cwd()`，于是「从哪儿敲的命令」就悄悄决定了 agent 在哪儿动手——
	 * 从终端或快捷方式启动时，那个目录往往不是用户想要的。空目录不做兜底：服务端在没选目录时
	 * 只放行「选目录」那几条端点，其余一律 409 说清楚，而不是退化到启动目录上去干活。
	 */
	const cwd = "";
	const handle = await startWebServer({
		cwd,
		// 只把 --api-key 透传下去；没给的话每次生成前会重新解析（环境变量 > 本地凭据文件），
		// 因此在网页上填的密钥可以立刻生效。
		apiKeyFlag: options.apiKey,
		baseUrl: options.baseUrl,
		// 网页确认卡片只在 ask 模式下才会出现。
		approval: options.approval,
		// 计划模式、输出风格、轮数上限、重试次数与命令行同一套默认值：配置里改了就按配置来，
		// 前两者在网页上还能随时改。
		planMode: options.plan,
		style: options.style,
		compaction: options.compaction,
		maxTurns: options.maxTurns,
		retries: options.retries,
		modelId: options.model,
		// 与命令行模式一致：全局 AGENTS.md 放在配置目录里。
		globalConfigDir: getAgentDir(),
		// 网页版与命令行版共用同一个落盘目录，方便对照。
		spillDir: join(getAgentDir(), "spill"),
		host: options.host,
		port: options.port,
		// 给了 --from 才在网页上提供「更新」；不给就只有回滚（更新要去终端跑）
		selfSource: options.selfSource,
	}).catch((error: unknown) => {
		process.stderr.write(`启动失败：${describeError(error)}\n`);
		return null;
	});
	if (handle === null) {
		return 1;
	}

	reportStartup(options, cwd, handle.url);
	handOffToBrowser(options, handle.url);

	return new Promise<number>((resolvePromise) => {
		let closing = false;
		const shutdown = (): void => {
			if (closing) {
				return;
			}
			closing = true;
			process.stderr.write("\n正在停止…\n");
			void handle.close().then(() => resolvePromise(0));
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
}
