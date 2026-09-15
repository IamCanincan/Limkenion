/**
 * 工具契约。
 *
 * 工具是一个对象字面量，经 `defineTool()`
 * 补上默认实现，于是「安全姿态」在整份代码里只有一处定义，不必每个工具各写一遍。
 *
 * 默认值一律 **fail-closed**：
 * - 不声明 `isReadOnly` 的工具按**会写**处理；
 * - 不声明 `isConcurrencySafe` 的工具按**不可并发**处理；
 * - `isReadOnly` / `isConcurrencySafe` 抛异常时按最保守的答案算（会写、不可并发）。
 *
 * 从前这两件事不在工具上：
 * - 只读性住在审批层的一张名字表里（`READ_ONLY_TOOLS`）。按**名字**判断永远看不出「这一次的
 *   入参是不是只读」，于是 `bash` 在只读档下一律被拒——哪怕它跑的是 `ls`；
 * - 「能不能并发」根本没有地方可写，所以一整轮里的多个 `read` 也只能排队。
 *
 * 契约里另外几件事也归工具自己说：**这次要碰哪个路径**（越界判定的输入，从前由审批层
 * 按工具名硬编码）、**折叠视图的一行摘要**（从前由网页前端按工具名猜字段）、
 * **这次交付了哪几件东西**、**这次是不是把某个文件整份换掉**（界面据此铺交付物卡片、补前后对比）、
 * **参数值校验**（从前散落在各工具的 execute 开头）。
 */

import type { PresentFile } from "../present.ts";

/** 一次工具执行的结果 */
export interface ToolOutcome {
	/** 回传给模型的正文 */
	content: string;
	/** 是否失败。失败也必须回传，否则模型会重复同一个调用 */
	isError: boolean;
}

/** 参数值校验的结论 */
export type ToolValidation = { ok: true } | { ok: false; message: string };

/**
 * 单条结果回灌给模型的默认**字节**上限；超过就落盘，上下文里只留开头与路径。
 *
 * 用字节而不是字符：中文一个字三个字节，按字符算会让一段中文输出晚落盘两倍有余，
 * 而上下文真正吃紧的是字节数（token 大致与字节成正比）。
 */
export const DEFAULT_MAX_RESULT_BYTES = 12_000;

/**
 * 工具的声明。
 *
 * 除了 `name` / `description` / `parameters` / `execute` 之外全部可省，省略时取
 * `TOOL_DEFAULTS` 里那个保守的答案。
 */
export interface ToolDefinition {
	/** 工具名，与模型返回的 function.name 匹配 */
	name: string;
	/** 给模型看的说明，写清楚副作用与限制 */
	description: string;
	/** JSON Schema 形式的参数定义 */
	parameters: Record<string, unknown>;
	/**
	 * 这一次的入参下，调用会不会改动任何东西。
	 *
	 * 只读的调用在**只读档与计划模式（严格）**下放行，所以这个判断必须保守：拿不准就返回 false。
	 * 入参未经验证，实现要自己容忍缺字段。
	 *
	 * 静态只读的工具直接声明 `alwaysReadOnly: true`，不必再写这个。
	 */
	isReadOnly?: (input: Record<string, unknown>) => boolean;
	/**
	 * 这个工具**有没有可能**改动东西——和入参无关的静态属性。
	 *
	 * 默认 `false` 是 fail-closed：不声明的工具按「可能改动」处理。
	 *
	 * 为什么它和 `isReadOnly` 是两件事：`bash` 既能跑 `ls` 又能跑 `rm`，所以「这一次只读」是真的
	 * 而「这个工具只读」是假的。审批档位问的是后者——`ask` 档的语义是「动手之前让我看一眼」，
	 * 跑任何命令都该问，包括 `ls`；而 `read` 这类工具无论怎么调都不动手，任何档位都不必问。
	 * 顺序必须是这个：先看档位该不该拦，再看这次调用是不是只读——反过来会让本可只读放行的
	 * 调用被档位先拦下。
	 *
	 * 声明了它就不必再写 `isReadOnly`：所有入参都只读。
	 */
	alwaysReadOnly?: boolean;
	/**
	 * 这一次的入参下，能不能和别的「可并发」调用并排跑。
	 *
	 * 默认 false。会写文件的工具**不要**覆写成 true：并发调度不做任何按路径的互斥，
	 * 两个写同一文件的调用并排跑必然有一个的结果基于过期内容（见 orchestrate.ts）。
	 */
	isConcurrencySafe?: (input: Record<string, unknown>) => boolean;
	/** 这次调用是否造成**不可逆**的后果（删除、覆盖）。只影响界面提示，不参与判定 */
	isDestructive?: (input: Record<string, unknown>) => boolean;
	/** 单条结果的字节上限；设为 `Infinity` 表示永不落盘（只读工具靠自身截断时用） */
	maxResultBytes?: number;
	/** 参数值校验；先于权限判定跑，不通过就把 message 当结果回传，不进审批 */
	validate?: (input: Record<string, unknown>) => ToolValidation;
	/** 折叠视图里的一行摘要：工具最清楚哪个字段最要紧 */
	summarize?: (input: Record<string, unknown>) => string;
	/**
	 * 需要用户确认时，确认卡片正文该怎么写（可以多行）。
	 *
	 * 这个字段就是「给权限弹窗用的一句人话」，
	 * 与发给模型的 `prompt()` 是两回事。这里同理，与 `summarize` 也是两回事：`summarize` 是折叠行上
	 * 那一行（宽 60 字符就截断），而确认卡片要**摊开**给用户看这一次究竟要做什么——命令原文、
	 * 要写入的内容、改哪几处。
	 *
	 * 从前这件事由网页前端做（`render.js` 的 `describeApprovalInput` 按工具名读 `command` /
	 * `content` / `edits` 字段），于是「哪个字段最要紧」的知识在服务端与浏览器各有一份，加一个工具
	 * 就要改两处。现在归工具自己说。
	 *
	 * 不声明就退回 `summarize`；两者都为空时由调用方自己兜（网页那边是一行 JSON）。
	 */
	describeApproval?: (input: Record<string, unknown>) => string;
	/**
	 * 这次调用**交付了哪几件东西**（路径 + 一句话说明），界面据此在工具行下面铺交付物卡片。
	 *
	 * 与 `describeApproval` 同一个道理：从前网页前端认 `present` 这个名字并读 `input.files`，
	 * 于是「哪个字段是交付物清单」的知识在浏览器里也有一份。现在任何工具只要声明它，界面就照着画。
	 */
	deliverables?: (input: Record<string, unknown>) => PresentFile[];
	/**
	 * 这次调用把某个文件**整份替换**掉时，自陈「哪一个文件、换成什么」。
	 *
	 * 界面据此在确认卡片上补一节前后对比（拿磁盘上那一份比）。路径与正文分别是哪个字段，
	 * 只有工具自己知道——从前网页前端认 `write` 这个名字并读 `input.path` / `input.content`。
	 * 不是整份替换（改几处、追加、删除）就返回 null：那时对比的意义不一样，宁可不画。
	 */
	fileReplacement?: (input: Record<string, unknown>) => { path: string; content: string } | null;
	/**
	 * 这次调用要碰的路径；不碰文件系统就返回 null。
	 *
	 * 两个用途：**越界判定的输入**（判定链拿它比工作目录），以及界面上那一行的「预览文件」入口
	 * （`read` 读的就是这个文件，`write` / `edit` 要改的也是它）。两个用途要的是同一个答案，
	 * 所以只有这一个声明——从前它们是两处：判定链用 `toolPathOf` 的名字表，界面读 `input.path` 字段。
	 */
	pathOf?: (input: Record<string, unknown>) => string | null;
	/** 单次调用最多等多久；不设则不限时（工具自己最清楚该等多久） */
	timeoutMs?: number;
	/**
	 * 执行工具。
	 *
	 * `input` 已由调用方做过 JSON 解析，但字段内容只经过了 `validate`，工具仍要自己检查。
	 * `signal` 被触发时应尽快返回。
	 */
	execute(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

/** 补全默认值之后的工具；内核各处拿到的都是这个完全体 */
export interface AgentTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly alwaysReadOnly: boolean;
	readonly isReadOnly: (input: Record<string, unknown>) => boolean;
	readonly isConcurrencySafe: (input: Record<string, unknown>) => boolean;
	readonly isDestructive: (input: Record<string, unknown>) => boolean;
	readonly maxResultBytes: number;
	readonly validate: (input: Record<string, unknown>) => ToolValidation;
	readonly summarize: (input: Record<string, unknown>) => string;
	readonly describeApproval: (input: Record<string, unknown>) => string;
	readonly deliverables: (input: Record<string, unknown>) => PresentFile[];
	readonly fileReplacement: (input: Record<string, unknown>) => { path: string; content: string } | null;
	readonly pathOf: (input: Record<string, unknown>) => string | null;
	readonly timeoutMs: number | undefined;
	readonly execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutcome>;
}

/**
 * 保守的默认答案。
 *
 * 三个 `() => false` 是有意的：一个忘了声明只读性的工具会被当成会写（于是要过审批），
 * 而不是被当成只读（于是悄悄跳过审批）。判断函数抛异常时也回退到这里。
 */
const TOOL_DEFAULTS = {
	alwaysReadOnly: false,
	isReadOnly: () => false,
	isConcurrencySafe: () => false,
	isDestructive: () => false,
	maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
	validate: () => ({ ok: true }) as ToolValidation,
	summarize: () => "",
	deliverables: () => [] as PresentFile[],
	fileReplacement: () => null,
	pathOf: () => null,
} as const;

/**
 * 把一次自陈包装成安全的调用。
 *
 * 工具的判定函数直接读模型给的入参，可能有各种意外（字段类型不对、正则抛错）。任何异常都
 * 当作「不成立」：判错了只读性等于跳过审批，判错了并发等于两个写操作并排跑，两者都不能靠
 * 「大概不会出错」。
 */
function safely<T>(fallback: T, run: () => T): T {
	try {
		return run();
	} catch {
		return fallback;
	}
}

/** 用一个声明造出完全体的工具 */
export function defineTool(definition: ToolDefinition): AgentTool {
	// 静态只读蕴含「这次一定只读」，两处判断不会互相打架。
	const alwaysReadOnly = definition.alwaysReadOnly === true;
	const readOnly = alwaysReadOnly ? () => true : (definition.isReadOnly ?? TOOL_DEFAULTS.isReadOnly);
	const concurrent = definition.isConcurrencySafe ?? TOOL_DEFAULTS.isConcurrencySafe;
	const destructive = definition.isDestructive ?? TOOL_DEFAULTS.isDestructive;
	const validate = definition.validate ?? TOOL_DEFAULTS.validate;
	const summarize = definition.summarize ?? TOOL_DEFAULTS.summarize;
	// 没声明确认卡片正文的工具退回一行摘要：它至少说了「这次要做什么」，比一坨 JSON 强。
	const describeApproval = definition.describeApproval ?? ((input: Record<string, unknown>) => summarize(input));
	const deliverables = definition.deliverables ?? TOOL_DEFAULTS.deliverables;
	const fileReplacement = definition.fileReplacement ?? TOOL_DEFAULTS.fileReplacement;
	const pathOf = definition.pathOf ?? TOOL_DEFAULTS.pathOf;

	return {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		alwaysReadOnly,
		isReadOnly: (input) => safely(false, () => readOnly(input) === true),
		isConcurrencySafe: (input) => safely(false, () => concurrent(input) === true),
		isDestructive: (input) => safely(false, () => destructive(input) === true),
		maxResultBytes: definition.maxResultBytes ?? TOOL_DEFAULTS.maxResultBytes,
		validate: (input) => safely({ ok: true } as ToolValidation, () => validate(input)),
		summarize: (input) => safely("", () => summarize(input)),
		describeApproval: (input) => safely("", () => describeApproval(input)),
		deliverables: (input) => safely([] as PresentFile[], () => deliverables(input)),
		fileReplacement: (input) => safely(null, () => fileReplacement(input)),
		pathOf: (input) => safely(null, () => pathOf(input)),
		timeoutMs: definition.timeoutMs,
		execute: definition.execute,
	};
}
