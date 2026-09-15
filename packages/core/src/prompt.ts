/**
 * 系统提示词：按段落注册表组装。
 *
 * 提示词不是一坨
 * 拼起来的字符串，而是一串**有名字的段落**，每段自己声明它会不会变。这样两件事才有地方可写：
 *
 * 1. **分界线**：`static` 段一律排在 `dynamic` 段之前（见 `resolvePromptSections`）。服务端按前缀
 *    命中上下文缓存，前面动一个字节、后面全部作废——日期、档位、AGENTS.md 都会变，把它们固定在
 *    尾部，日常改动就只作废尾部。从前这条规矩只活在数组的排列顺序里，改顺序时没人会想到它。
 * 2. **不重复工具描述**（这一条是实打实的省 token）：CC 的工具描述**只发一次**，作为接口请求的
 *    `tools[]` 字段；它另有一段散文讲「怎么用工具」。本仓库从前在提示词里把每个工具的 description
 *    又抄了一遍（`- bash：执行命令`），而 `toToolSpec()` 同时把它放进了 `tools[]`——同一个工具的
 *    描述每次请求发两遍。现在提示词里只列名字，描述由 `tools[]` 承担。
 *
 * 内容本身刻意保持短小：提示词越长越容易被模型忽略，具体工具用法由每个工具的 description 承担，
 * 项目约定由 AGENTS.md 承担。
 */

import type { InstructionFile } from "./instructions.ts";
import { isGitRepo } from "./instructions.ts";
import { type PlanMode, planSection } from "./plan.ts";
import { type OutputStyle, styleSection } from "./style.ts";
import type { AgentTool } from "./types.ts";

/** 组装系统提示词所需的信息 */
export interface SystemPromptOptions {
	/** 工作目录 */
	cwd: string;
	/** 可调用的工具 */
	tools: AgentTool[];
	/** 从仓库里发现的说明文件，按全局在前、项目在后排列 */
	instructions?: InstructionFile[];
	/** 计划模式档位；非 `off` 时注入对应的引导段落 */
	plan?: PlanMode;
	/** 输出风格；`default` 时不加任何内容 */
	style?: OutputStyle;
	/** 覆盖「今天」的日期，仅用于测试 */
	today?: string;
}

/** 组装时每一段能读到的东西 */
export interface PromptContext {
	cwd: string;
	tools: AgentTool[];
	instructions: InstructionFile[];
	plan: PlanMode;
	style: OutputStyle;
	today: string;
}

/** 提示词的一段 */
export interface PromptSection {
	/** 段落名；只用于测试与排查，不写进正文 */
	name: string;
	/**
	 * 这一段会不会随**会话之外**的东西变（时间、档位、说明文件内容）。
	 *
	 * 决定它排在分界线之前还是之后，见文件头第 1 条。拿不准就写 `dynamic`：排到后面只是少省一点
	 * 缓存，排到前面会让后面所有段落跟着一起作废。
	 */
	kind: "static" | "dynamic";
	/** 产出正文；返回空串表示这一段这次不出现 */
	compute(context: PromptContext): string;
}

/** 取本地日期，格式 YYYY-MM-DD */
function localToday(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/** 环境信息：日期在这里，所以整段算 dynamic */
function environmentSection(context: PromptContext): string {
	return [
		"环境信息：",
		`- 工作目录：${context.cwd}`,
		`- 是否 git 仓库：${isGitRepo(context.cwd) ? "是" : "否"}`,
		`- 平台：${process.platform} ${process.arch}`,
		// 模型不知道今天是几号，缺了它会把「最近」「当前版本」这类判断做错。
		`- 今天：${context.today}`,
	].join("\n");
}

/** 仓库自带说明文件的注入；没有文件时整段不出现 */
function instructionsSection(context: PromptContext): string {
	if (context.instructions.length === 0) {
		return "";
	}
	return [
		"以下是本仓库自带的说明文件。它们描述的是这个项目的具体约定，优先级高于上面的默认工作方式：",
		"",
		context.instructions.map((file) => `来自 ${file.path}：\n${file.content.trim()}`).join("\n\n"),
	].join("\n");
}

/**
 * 段落注册表。
 *
 * 这里的顺序就是正文顺序，但**读的人不必自己保证 static 在前**——`resolvePromptSections` 会分组，
 * 并有测试盯着这条不变量。想在中间插一段，直接插就行，位置只决定它在同一组内的先后。
 */
export const PROMPT_SECTIONS: readonly PromptSection[] = [
	{
		name: "identity",
		kind: "static",
		compute: () => "你是 Limkenion，一个在用户终端里工作的编程助手。",
	},
	{
		// 只列名字：描述在接口的 tools 字段里，见文件头第 2 条。
		name: "tools",
		kind: "static",
		compute: (context) =>
			context.tools.length === 0
				? ""
				: `可用工具（名字、参数与用法见接口的 tools 字段）：${context.tools.map((tool) => tool.name).join("、")}`,
	},
	{
		name: "working-style",
		kind: "static",
		compute: () =>
			[
				"工作方式：",
				"1. 先读代码再改代码。不要凭猜测修改文件。",
				"2. 找文件用 glob，搜内容用 grep，需要跑命令或做这两者之外的事才用 bash，不要凭空假设执行结果。",
				"3. 一次可以调用多个工具，相互独立的调用请放在同一轮。",
				"4. 修改文件优先使用 edit，只有新建文件或整体重写才用 write。",
				"5. 回答使用中文，简洁直接，不要复述工具输出。",
				"6. 任务完成后给出简短结论，说明改了什么、验证了什么。",
				"7. 任务超过三步就用 todo_write 写出清单，之后每完成一步更新一次，不要等做完才一次性标记。",
				"8. 开始一件需要多步的事之前，用 goal_write 写一句这一轮要达成什么；卡住或暂停时把状态一起更新。",
				"9. 交付时用 present 列出这次要给人看的东西（路径 + 一句话说明），只列真正值得看的。",
				"10. 要跑一会儿的命令（构建、整包测试、本地服务）用 job_start 起后台任务，别拿 bash 干等；跑完用 job_list 看状态、read 看输出。",
				"11. 一件「过程很长、结论很短」的事（把一批文件看完再总结、大范围核对）用 subagent_start 交给子代理，它有独立的上下文；结论用 subagent_read 取。",
			].join("\n"),
	},
	{
		// 计划模式的引导段落：它是**当前状态**，不是通用规矩，所以归 dynamic。
		name: "plan",
		kind: "dynamic",
		compute: (context) => planSection(context.plan),
	},
	{
		// 风格是「怎么讲」，而 AGENTS.md 讲的是「这个项目怎么做」，所以风格排在说明文件之前。
		name: "style",
		kind: "dynamic",
		compute: (context) => styleSection(context.style),
	},
	{
		// 日期与平台一起算，所以整段 dynamic。
		name: "environment",
		kind: "dynamic",
		compute: environmentSection,
	},
	{
		// 说明文件**固定排在最末**：它讲的是「这个项目怎么做」，是所有段落里最贴近当前任务的一段，
		// 让模型最后读到。它在 dynamic 组内的位置就是这条约定，别往上挪。
		name: "instructions",
		kind: "dynamic",
		compute: instructionsSection,
	},
];

/**
 * 把段落拼成正文：**static 段全部在前，dynamic 段全部在后**，各组内保持注册顺序。
 *
 * 这就是文件头说的那条分界线。空段（这次不适用的）直接不出现，不留空行。
 *
 * 注意这条规则只**重排分组**、不在组内排序：`instructions` 保持在 dynamic 组的最末，
 * 是注册表里的位置决定的（见那边的注释），分组不会把它挪到别处。
 */
export function resolvePromptSections(
	context: PromptContext,
	sections: readonly PromptSection[] = PROMPT_SECTIONS,
): string {
	const collect = (kind: PromptSection["kind"]): string[] =>
		sections
			.filter((section) => section.kind === kind)
			.map((section) => section.compute(context))
			.filter((text) => text !== "");
	return [...collect("static"), ...collect("dynamic")].join("\n\n");
}

/**
 * 组装系统提示词。
 *
 * 保持这个入口不变：调用方（`context-manager.ts`）只需要一份正文，不该关心段落是怎么分的。
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
	return resolvePromptSections({
		cwd: options.cwd,
		tools: options.tools,
		instructions: options.instructions ?? [],
		plan: options.plan ?? "off",
		style: options.style ?? "default",
		today: options.today ?? localToday(),
	});
}
