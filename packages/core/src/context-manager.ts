/**
 * 上下文管理：模型「看到」的东西都归这里。
 *
 * 分两半：
 *
 * 1. **世界状态**（说明文件 + 系统提示词 + 档位段落）。每轮开始前重算一次：编辑 AGENTS.md 之后
 *    接着问就生效，不必重启。说明文件**变了**时还会补一条告知
 *    ——模型看到的永远是「此刻的系统提示词」，它无从知道自己先前读到的规矩
 *    已经被换掉，很容易照着旧规矩继续做；改开头又会整段作废服务端的前缀缓存，所以这条告知只发
 *    一次、只说「以新的为准」。
 * 2. **历史**（裁剪、摘要、救援、用量校准）。跑得越久上下文越长，处理顺序是有讲究的：先做不花钱
 *    的裁剪，再考虑花一次模型调用的摘要，最后才是超窗之后丢最旧几轮的救援。具体规则都是纯函数，
 *    在 `compaction.ts` 里；这里只负责「什么时候用哪一条」。
 *
 * 从前这两件事连同主循环一起挤在 `agent.ts` 里，压缩失败、说明文件变化、校准过期这些只影响
 * 「下一轮发什么」的逻辑，和「这一轮怎么跑」混在一处，谁也说不清哪段属于哪段。
 */

import { DEFAULT_RETRIES, resolveModel, streamChat } from "limkenion-ai";
import {
	applySummary,
	buildSummaryRequest,
	calibrate,
	foldableTokens,
	MIN_FOLD_TOKENS,
	needsCompaction,
	pruneToolOutputs,
	summaryBudget,
} from "./compaction.ts";
import { discoverInstructions, type InstructionFile } from "./instructions.ts";
import type { PlanMode } from "./plan.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { SessionState } from "./session.ts";
import type { OutputStyle } from "./style.ts";

/**
 * 说明文件变化时的告知语。
 *
 * 措辞上要说清三件事：什么变了、以什么为准、之前读到的作废。少了第三句，模型会拿新旧两套规矩
 * 各取所需；多了（比如把新规则正文再抄一遍）就等于又往上下文里塞一份可能过期的副本。
 */
function buildInstructionNotice(files: InstructionFile[]): string {
	const lines = [
		"[项目说明已更新]",
		files.length === 0
			? "此前注入的项目说明文件已被移除，之前那些指令全部作废，不要再按它们做事。"
			: "AGENTS.md 一类说明文件的内容刚刚变了。以下文件的**新内容**已经写进系统提示词，以它为准：",
		...files.map((file) => `- ${file.path}`),
		"之前读到的说明一律作废，不要按旧规则继续；已经做完的事不用重做。",
	];
	return lines.join("\n");
}

/**
 * 重新发现说明文件并刷新系统消息。
 *
 * 每轮开始前跑一次。提示词没变化时不改动消息，以免白白作废服务端的前缀缓存。
 * 说明文件变了才补一条告知（见文件头）。
 */
export function refreshWorldState(state: SessionState): void {
	const instructions =
		state.instructionsOverride ?? discoverInstructions({ cwd: state.cwd, globalConfigDir: state.globalConfigDir });
	const content =
		state.systemPromptOverride ??
		buildSystemPrompt({
			cwd: state.cwd,
			tools: state.tools,
			instructions,
			plan: state.planMode,
			style: state.style,
		});
	// 指纹只取「说明文件」，不取整个提示词：计划模式与输出风格的变化也会改写系统消息，
	// 但那些是用户当场要求的，不需要再发一条「说明文件变了」。
	const signature = instructions.map((file) => `${file.path}\u0000${file.content}`).join("\u0001");
	const first = state.instructionsSignature === null;
	const changed = !first && signature !== state.instructionsSignature;
	state.instructionsSignature = signature;

	const system = state.messages[0];
	if (system && system.role === "system") {
		if (system.content !== content) {
			system.content = content;
		}
	} else {
		state.messages.unshift({ role: "system", content });
	}

	if (changed) {
		state.messages.push({ role: "user", content: buildInstructionNotice(instructions) });
	}
}

/**
 * 切换计划模式。
 *
 * 严格档下工具层只放行只读操作，其余一律拒绝并提示先交方案；引导档只改提示词。
 * 提示词段落跟着档位走，所以这里要重算一次系统消息，切换立刻生效。
 */
export function applyPlanMode(state: SessionState, mode: PlanMode): void {
	if (state.planMode === mode) {
		return;
	}
	state.planMode = mode;
	refreshWorldState(state);
}

/**
 * 切换输出风格。
 *
 * 风格只写在系统提示词里，所以重算一次系统消息就生效；工具、审批与计划模式一概不动。
 */
export function applyStyle(state: SessionState, style: OutputStyle): void {
	if (state.style === style) {
		return;
	}
	state.style = style;
	refreshWorldState(state);
}

/**
 * 记录一次真实请求的用量。
 *
 * 自己按字符猜 token，中文与代码混在一起时能差出两三成；接口每次都回报真实的 prompt token 数，
 * 用它反推比例再外推，比任何硬编码的换算都准。拿不到有效数字时不动原来那份。
 */
export function recordUsage(state: SessionState, promptTokens: number | undefined, sentChars: number): void {
	const calibrated = calibrate(promptTokens, sentChars);
	if (calibrated !== null) {
		state.calibration = calibrated;
	}
}

/**
 * 丢掉用量校准。
 *
 * 清空历史或换模型之后，上一份校准说的已经是另一批内容、另一个模型的换算关系，继续用会把估算
 * 抬得虚高（`estimateContextTokens` 不会报出比真实值更小的数），于是空历史也会被判成「该压缩了」。
 */
export function forgetCalibration(state: SessionState): void {
	state.calibration = null;
}

/**
 * 压缩上下文：先无成本裁剪，超阈值再摘要。
 *
 * 摘要是一次额外的模型调用（不带工具），所以要两步才发：整段上下文超了阈值只是「该压了」，
 * 还要看**被折叠的那一段**够不够大——系统提示词（AGENTS.md 可能有几万 token）不参与折叠，
 * 折叠区只有几百 token 时，摘要花掉的比省下的还多（借自 Reasonix 的 foldEconomics）。
 *
 * 摘要失败不影响这一轮：宁可上下文长一点，也不能因为压缩失败让用户的指令跑不起来。
 *
 * `midTurn` 表示这不是轮与轮之间、而是一轮跑动中触发的（一次提问里跑了几十个工具）：
 * 只影响给用户看的说法，处理方式完全一样。
 */
export async function compressContext(state: SessionState, signal: AbortSignal, midTurn = false): Promise<void> {
	if (!state.compaction) {
		return;
	}
	const pruned = pruneToolOutputs(state.messages);
	let summarized = false;
	if (pruned.pruned > 0) {
		state.messages.splice(0, state.messages.length, ...pruned.messages);
	}

	const model = resolveModel(state.modelId);
	const overThreshold = needsCompaction(
		state.messages,
		model.contextWindow,
		{ thresholdRatio: state.compactionThreshold },
		state.calibration,
	);
	if (overThreshold) {
		const fold = foldableTokens(state.messages);
		if (fold >= MIN_FOLD_TOKENS) {
			const budget = summaryBudget(fold);
			const summary = await summarize(state, signal, budget).catch(() => "");
			if (summary !== "") {
				state.messages.splice(0, state.messages.length, ...applySummary(state.messages, summary));
				summarized = true;
			}
		}
	}

	if (pruned.pruned > 0 || summarized) {
		state.emit({
			type: "compaction",
			pruned: pruned.pruned,
			savedTokens: pruned.savedTokens,
			summarized,
			...(midTurn ? { midTurn: true } : {}),
		});
	}
}

/**
 * 让模型把前半段对话压成结构化摘要，返回摘要正文。
 *
 * 请求就是「当前历史原样 + 一条指令」，前缀与刚才那次主请求逐字相同——这是有意的：服务端按前缀
 * 命中上下文缓存，摘要这次调用因此便宜得多（DeepSeek 的缓存命中价约为未命中的十分之一）。
 * 换掉前缀（比如把指令插到中间）会让这次压缩贵上好几倍。
 *
 * 输出按 `maxTokens` 封顶。真被截断时在正文里写明，接手的人才知道这段摘要是半截的。
 */
async function summarize(state: SessionState, signal: AbortSignal, maxTokens: number): Promise<string> {
	const model = resolveModel(state.modelId);
	const parts: string[] = [];
	let truncated = false;
	for await (const event of streamChat({
		model,
		messages: [...state.messages, buildSummaryRequest(maxTokens)],
		tools: [],
		maxTokens,
		apiKey: state.apiKey,
		baseUrl: state.baseUrl,
		signal,
		fetchImpl: state.fetchImpl,
		retry: { retries: state.retries ?? DEFAULT_RETRIES },
	})) {
		if (event.type === "text") {
			parts.push(event.delta);
		}
		if (event.type === "done" && event.reason === "length") {
			truncated = true;
		}
		if (event.type === "error") {
			throw new Error(event.message);
		}
	}
	const text = parts.join("").trim();
	if (text === "") {
		return "";
	}
	// 撞上输出上限说明这段摘要是半截的：写明白，接手的人才知道该回原文翻。
	return truncated
		? `${text}\n\n[这段摘要写到输出上限就停了，上面缺了后半部分；需要细节时回到原文或会话文件里查]`
		: text;
}
