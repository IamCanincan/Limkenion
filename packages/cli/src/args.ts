/**
 * 命令行参数解析。
 *
 * 用 Node 内置的 util.parseArgs，不引入 commander/yargs 之类的依赖。
 * 优先级一律是：命令行 > 环境变量 > 配置文件 > 内置默认值。
 */

import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	DEFAULT_MODEL_ID,
	DEFAULT_RETRIES,
	describeError,
	listModelIds,
	readBaseUrlOverride,
	readModelOverride,
} from "limkenion-ai";
import {
	type ApprovalMode,
	OUTPUT_STYLES,
	type OutputStyle,
	PLAN_MODES,
	type PlanMode,
	parseApprovalMode,
	parseOutputStyle,
	parsePlanMode,
	STYLE_GUIDE,
} from "limkenion-core";
import { commandUsageLines, padColumns } from "./commands/command.ts";
import { COMMANDS } from "./commands/registry.ts";
import { APP_NAME, configDirName, getAgentDir, getSessionDir, getSettingsPath, VERSION } from "./config.ts";
import { type ApiKeySource, getCredentialsPath, resolveApiKey } from "./credentials.ts";
import { getManagedSettingsPath, readSettings } from "./settings.ts";

/** 默认的单次指令工具调用轮数上限 */
const DEFAULT_MAX_TURNS = 25;

/** 解析结果 */
export interface Options {
	apiKey: string;
	/** 密钥来自哪里，用于报错与 auth status 展示 */
	apiKeySource: ApiKeySource;
	model: string;
	baseUrl: string | undefined;
	continueSession: boolean;
	maxTurns: number;
	/** 是否启用上下文压缩 */
	compaction: boolean;
	/** 计划模式档位：off / strict（工具层只读）/ guide（提示词引导） */
	plan: PlanMode;
	/** 输出风格 */
	style: OutputStyle;
	/** 审批模式 */
	approval: ApprovalMode;
	/** 请求重试次数 */
	retries: number;
	verbose: boolean;
	prompt: string | undefined;
}

/** 用法说明 */
function usage(): string {
	return [
		`${APP_NAME} ${VERSION} - 终端里的最小编程助手`,
		"",
		"用法：",
		`  ${APP_NAME}                     进入交互模式`,
		`  ${APP_NAME} "把 README 的错别字改掉"   执行一条指令后退出`,
		`  ${APP_NAME} -p "解释这个仓库"         同上，显式写法`,
		`  cat error.log | ${APP_NAME} -p "分析这个报错"   从标准输入读取指令`,
		// 子命令清单从注册表出，而每条命令的元信息又住在命令自己那里：从前这里抄了一遍
		// 命令与说明，忘了改不会报错，只会让帮助里静默少一行。
		...commandUsageLines(COMMANDS, APP_NAME),
		"",
		"选项：",
		// 表格化的两节（子命令、选项）一律按下表对齐，别手填空格：里面有 `<文本>` 这样的 CJK，
		// 手填时按码元数空格，终端里就歪两列。上面那几条是**例子**不是表格，留原样。
		...padColumns([
			["-p, --print <文本>", "一次性执行并输出结果"],
			["-m, --model <id>", `指定模型，默认 ${DEFAULT_MODEL_ID}`],
			["-c, --continue", "继续当前目录下最近的会话"],
			["    --api-key <key>", "指定 API Key，优先级高于环境变量与本地保存的密钥"],
			["    --base-url <url>", "指定接口地址，默认 https://api.deepseek.com"],
			["    --max-turns <n>", `单次指令最多几轮工具调用，默认 ${DEFAULT_MAX_TURNS}`],
			["    --retries <n>", `限速或 5xx 时的重试次数，默认 ${DEFAULT_RETRIES}，0 表示不重试`],
			["    --approval <mode>", "工具审批：auto 常规放行（疑似危险命令仍要确认）/ ask 读写前确认 / readonly 只读"],
			["    --no-compact", "关闭上下文压缩（默认开启：先裁剪旧工具输出，超阈值再摘要）"],
			["    --plan[=strict|guide]", "计划模式启动：严格档只读地出方案，引导档先出方案但工具不设限"],
			[
				"    --style <name>",
				`输出风格：${OUTPUT_STYLES.map((name) => `${name}（${STYLE_GUIDE[name]}）`).join(" / ")}`,
			],
			["-v, --verbose", "显示思维链与完整工具输出"],
			["-h, --help", "显示本帮助"],
			["-V, --version", "显示版本号"],
		]),
		"",
		"配置文件与凭据：",
		`  配置文件   项目 ${join(process.cwd(), configDirName, "config.json")}（只认安全子集）`,
		`             用户 ${getSettingsPath()}（全部键）`,
		`             managed ${getManagedSettingsPath()}（机器统一策略）`,
		"             逐键覆盖：项目 < 用户 < managed；命令行 > 环境变量 > 配置文件。",
		"             认 model、baseUrl、maxTurns、retries、approval、compaction、planMode、style、hooks、verbose。",
		`  凭据文件   ${getCredentialsPath()}`,
		"             由 auth login 写入，权限 0600。",
		"",
		"项目说明：",
		"  工作目录及其上级目录里的 AGENTS.md 会自动注入系统提示词：逐目录取第一个存在的候选，",
		"  顺序是 AGENTS.override.md、AGENTS.md、CONTEXT.md；override 只顶掉同目录的其他候选。",
		`  全局说明放在 ${join(getAgentDir(), "AGENTS.md")}。改完重新提问即可生效，不用重启。`,
		"",
		"环境变量：",
		"  DEEPSEEK_API_KEY       API Key，优先级低于命令行、高于本地保存的密钥",
		"  DEEPSEEK_BASE_URL      接口地址",
		"  LIMKENION_MODEL        默认模型",
		`  LIMKENION_CODING_AGENT_DIR      配置目录，默认 ${getAgentDir()}`,
		`  LIMKENION_CODING_AGENT_SESSION_DIR  会话目录，默认 ${getSessionDir(process.cwd())}`,
		"",
		`可用模型：${listModelIds().join("、")}（其它 id 也可直接使用）`,
	].join("\n");
}

/** 解析 --retries，非法值回退到默认（0 表示不重试） */
function toRetries(raw: string | number | undefined): number {
	const value = typeof raw === "number" ? raw : Number.parseInt(raw ?? "", 10);
	return Number.isFinite(value) && value >= 0 && value <= 10 ? value : DEFAULT_RETRIES;
}

/** 解析 max-turns，非法值回退到默认 */
function toTurns(raw: string | undefined): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TURNS;
}

/**
 * `--plan` 允许带可选档位。
 *
 * `node:util` 的 parseArgs 不支持「可选值」，而 `limkenion --plan "做点什么"` 里的下一段
 * 是提示词不是档位，所以只在下一位恰好是档位名时才吃掉它。
 */
export function normalizePlanArgv(argv: string[]): string[] {
	const modes = new Set<string>(PLAN_MODES);
	const out: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg !== "--plan") {
			out.push(arg);
			continue;
		}
		const next = argv[index + 1];
		if (next !== undefined && modes.has(next)) {
			out.push(`--plan=${next}`);
			index += 1;
			continue;
		}
		// 不带档位就是严格档：沿用「没批准之前不许动」的原意。
		out.push("--plan=strict");
	}
	return out;
}

/** 解析命令行参数；语法错误时打印用法并返回 null */
function tryParseArgs(argv: string[]) {
	try {
		return parseArgs({
			args: normalizePlanArgv(argv),
			allowPositionals: true,
			options: {
				print: { type: "string", short: "p" },
				model: { type: "string", short: "m" },
				continue: { type: "boolean", short: "c" },
				"api-key": { type: "string" },
				"base-url": { type: "string" },
				"max-turns": { type: "string" },
				retries: { type: "string" },
				approval: { type: "string" },
				"no-compact": { type: "boolean" },
				plan: { type: "string" },
				style: { type: "string" },
				verbose: { type: "boolean", short: "v" },
				help: { type: "boolean", short: "h" },
				version: { type: "boolean", short: "V" },
			},
		});
	} catch (error) {
		process.stderr.write(`参数错误：${describeError(error)}\n\n${usage()}\n`);
		return null;
	}
}

/**
 * 解析命令行参数。
 *
 * 三种结果要分清楚：拿到 `Options` 就执行；`-h`/`-V` 打印完返回 `null`（正常退出）；
 * 参数写错返回 `"usage-error"`，调用方据此退出 2——早先这两种都返回 `null`，于是把
 * 参数写错当成命令成功，脚本里会误判。
 */
export function parseOptions(argv: string[]): Options | null | "usage-error" {
	const parsed = tryParseArgs(argv);
	if (parsed === null) {
		// 参数写错与「打印了帮助」是两回事：前者要让脚本知道命令没跑成。
		return "usage-error";
	}

	const values = parsed.values;
	if (values.help) {
		process.stdout.write(`${usage()}\n`);
		return null;
	}
	if (values.version) {
		process.stdout.write(`${VERSION}\n`);
		return null;
	}

	const positional = parsed.positionals.join(" ").trim();
	const prompt = values.print ?? (positional === "" ? undefined : positional);

	const settings = readSettings();
	const credential = resolveApiKey(values["api-key"]);

	return {
		apiKey: credential.key,
		apiKeySource: credential.source,
		model: values.model?.trim() || readModelOverride() || settings.model || DEFAULT_MODEL_ID,
		baseUrl: values["base-url"]?.trim() || readBaseUrlOverride() || settings.baseUrl,
		continueSession: values.continue === true,
		maxTurns: values["max-turns"]?.trim() ? toTurns(values["max-turns"]) : (settings.maxTurns ?? toTurns(undefined)),
		approval: parseApprovalMode(values.approval?.trim() ?? settings.approval, "auto"),
		compaction: values["no-compact"] === true ? false : (settings.compaction ?? true),
		plan: parsePlanMode(values.plan?.trim()) ?? settings.planMode ?? "off",
		style: parseOutputStyle(values.style?.trim()) ?? settings.style ?? "default",
		retries: toRetries(values.retries?.trim() ?? settings.retries),
		verbose: values.verbose === true || (values.verbose === undefined && settings.verbose === true),
		prompt,
	};
}

/** 从标准输入读取全部内容，用于管道场景 */
export async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk as Uint8Array));
	}
	return Buffer.concat(chunks).toString("utf-8").trim();
}
