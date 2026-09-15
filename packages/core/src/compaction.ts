/**
 * 上下文压缩。
 *
 * 长时间跑必然撞上下文上限，处理顺序是有讲究的（参考 DeepSeek-Reasonix 的 snip/prune → compaction）：
 *
 * 1. **先裁剪（prune）**：很久以前、体积大的工具输出，直接换成一行占位说明。**不花任何 token**，
 *    也不改变对话骨架——模型仍能看到「查过什么、改过什么」，只是看不到当时的完整正文。
 * 2. **再摘要（compaction）**：裁剪之后如果还是超阈值，才花一次模型调用把前半段对话压成结构化摘要。
 *    先剪后压能省掉大量摘要成本，也少一次「摘要本身写歪」的机会。摘要之外，用户原话按预算原样保留，
 *    摘要写成「交接文档」——接手的是另一个模型，最怕它把已经做完的事又做一遍。
 * 3. **兜底救援（rescue）**：已经超窗被接口拒了，就丢掉最旧的几轮重发。只丢 assistant 与工具结果，
 *    绝不丢用户原话与系统提示词。
 *
 * 这里只放纯函数：估算 token、裁剪、判断是否需要压缩、拼摘要请求、套用摘要结果、判断报错是不是超窗。
 * 真正发起模型调用由 Agent 负责，因此这些规则可以脱离网络单独测。
 */

import type { Message, UserMessage } from "limkenion-ai";

/** 裁剪参数 */
export interface PruneOptions {
	/** 最近多少条消息保持原样（越靠后的上下文越重要） */
	keepRecentMessages?: number;
	/** 超过多少字节的工具输出才值得裁 */
	minBytes?: number;
}

/** 摘要压缩参数 */
export interface CompactionOptions {
	/** 触发压缩的上下文占用比例 */
	thresholdRatio?: number;
	/** 摘要后保留的最近消息条数 */
	keepRecentMessages?: number;
	/**
	 * 摘要之外，最多为用户原话保留多少 token。
	 *
	 * 摘要写得再好也是二手转述：任务目标、约束、「不要动某个文件」这类要求一旦被摘要吞掉，
	 * 后面几十轮都在按错的前提干活。所以用户自己说过的话不交给摘要处置，按预算原样留着。
	 */
	keepUserTokens?: number;
}

/** 裁剪统计 */
export interface PruneResult {
	/** 裁剪后的消息列表（新数组，不改原数组） */
	messages: Message[];
	/** 被裁掉正文的工具结果数 */
	pruned: number;
	/** 估算省下的 token */
	savedTokens: number;
}

/** 估算 token 数。
 *
 * 中文按 1 字 1 token、ASCII 按 4 字符 1 token 粗算——只用于「要不要压缩」的判断，
 * 不用于计费，所以宁可直接可解释，也不引入分词表。
 */
export function estimateTokens(text: string): number {
	let tokens = 0;
	let asciiRun = 0;
	for (const char of text) {
		if (char.charCodeAt(0) < 128) {
			asciiRun += 1;
			continue;
		}
		tokens += Math.ceil(asciiRun / 4) + 1;
		asciiRun = 0;
	}
	return tokens + Math.ceil(asciiRun / 4);
}

/** 估算整段消息的 token 数 */
export function estimateMessages(messages: Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role === "system" || message.role === "user") {
			total += estimateTokens(message.content);
			continue;
		}
		if (message.role === "assistant") {
			total += estimateTokens(message.content) + estimateTokens(message.reasoning ?? "");
			for (const call of message.toolCalls) {
				total += estimateTokens(call.arguments) + 8;
			}
			continue;
		}
		for (const result of message.results) {
			total += estimateTokens(result.content) + 8;
		}
	}
	return total;
}

/** 整段消息的字符数：与 token 一起用来算「真实 token / 字符」的比例 */
export function countChars(messages: Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role === "system" || message.role === "user") {
			total += message.content.length;
			continue;
		}
		if (message.role === "assistant") {
			total += message.content.length + (message.reasoning?.length ?? 0);
			for (const call of message.toolCalls) {
				total += call.arguments.length;
			}
			continue;
		}
		for (const result of message.results) {
			total += result.content.length;
		}
	}
	return total;
}

/**
 * 用量校准：一次真实请求的「发出字符数」与接口回报的 prompt token 数。
 *
 * 自己按字符猜 token，中文与代码混在一起时能差出两三成——猜保守了会提前压缩（丢上下文），
 * 猜乐观了会压得太晚（直接超窗）。接口每次都把真实 prompt token 数告诉我们，用它反推
 * 这个模型、这类内容的比例，再拿它去外推，比任何硬编码的换算都准。
 */
export interface UsageCalibration {
	/** 接口回报的 prompt token 数 */
	promptTokens: number;
	/** 那次请求发出的字符数 */
	chars: number;
}

/** 记录一次真实用量；拿不到有效数字时返回 null，调用方继续用字符估算 */
export function calibrate(promptTokens: number | undefined, chars: number): UsageCalibration | null {
	if (promptTokens === undefined || promptTokens <= 0 || chars <= 0) {
		return null;
	}
	return { promptTokens, chars };
}

/**
 * 估算当前上下文占用。
 *
 * 有校准时按「那次请求每字符多少 token」外推，并且不会低于已知的真实值——上下文只会变长，
 * 报出一个比真实用量更小的数会让我们压得太晚。
 */
export function estimateContextTokens(messages: Message[], calibration: UsageCalibration | null = null): number {
	const chars = countChars(messages);
	if (calibration !== null && calibration.chars > 0) {
		const perChar = calibration.promptTokens / calibration.chars;
		return Math.max(calibration.promptTokens, Math.round(chars * perChar));
	}
	return estimateMessages(messages);
}

/** 裁剪时保留开头几行：「这是什么」通常在最前面（imports、表头、目录结构） */
export const PRUNE_HEAD_LINES = 40;

/** 裁剪时保留结尾几行：「结果是什么」通常在最后（命令输出、测试结论、报错） */
export const PRUNE_TAIL_LINES = 12;

/**
 * 裁剪占位符：说清被裁掉了多少、完整内容在哪。
 *
 * `droppedLines` 给出时把行数也报出来——知道「中间还有 3000 行」和「中间还有 1 行」，
 * 模型决定要不要回头重读的语气完全不同。不给就退回原来那句「整条已被换掉」的说法。
 */
export function prunePlaceholder(bytes: number, droppedLines?: number): string {
	if (droppedLines === undefined) {
		return `[工具输出已裁剪：原 ${bytes} 字节，完整内容仍保存在会话文件中，需要时可重新读取]`;
	}
	return (
		`[工具输出已裁剪：中间 ${droppedLines} 行 / ${bytes} 字节未进上下文，头尾各留了一段；` +
		"完整内容仍保存在会话文件中，需要时可重新读取]"
	);
}

/**
 * 把一段过大的工具输出换成「头 N 行 + 说明 + 尾 M 行」（借自 Reasonix 的分层裁剪）。
 *
 * 只留一行说明时，模型连「这是什么」都看不到，只能整段重读——那等于白裁一遍。头看结构、
 * 尾看结论，中间那一大段才是真正可以不要的部分。行数太少（一整行超长 JSON）切不出有意义的
 * 头尾，就退回整条换成一行说明。
 */
function pruneContent(content: string): string {
	const lines = content.split("\n");
	if (lines.length <= PRUNE_HEAD_LINES + PRUNE_TAIL_LINES) {
		return prunePlaceholder(Buffer.byteLength(content, "utf-8"));
	}
	const head = lines.slice(0, PRUNE_HEAD_LINES);
	const tail = lines.slice(lines.length - PRUNE_TAIL_LINES);
	const dropped = lines.slice(PRUNE_HEAD_LINES, lines.length - PRUNE_TAIL_LINES);
	const placeholder = prunePlaceholder(Buffer.byteLength(dropped.join("\n"), "utf-8"), dropped.length);
	return [...head, placeholder, ...tail].join("\n");
}

/**
 * 裁剪旧工具输出。
 *
 * 只动 `tool` 消息：assistant 的正文与思维链保持原样，因为它们承载「做过什么决定」，
 * 而工具输出大多是一次性信息——需要时重新读一遍比一直占着上下文便宜。
 */
export function pruneToolOutputs(messages: Message[], options: PruneOptions = {}): PruneResult {
	const keepRecent = Math.max(options.keepRecentMessages ?? 8, 1);
	const minBytes = options.minBytes ?? 4096;
	const cutoff = Math.max(messages.length - keepRecent, 0);

	let pruned = 0;
	let savedTokens = 0;
	const next: Message[] = messages.map((message, index) => {
		if (index >= cutoff || message.role !== "tool") {
			return message;
		}
		let changed = false;
		const results = message.results.map((result) => {
			const bytes = Buffer.byteLength(result.content, "utf-8");
			if (bytes <= minBytes) {
				return result;
			}
			const replaced = pruneContent(result.content);
			changed = true;
			pruned += 1;
			savedTokens += estimateTokens(result.content) - estimateTokens(replaced);
			return { ...result, content: replaced };
		});
		return changed ? { ...message, results } : message;
	});

	return { messages: pruned > 0 ? next : messages, pruned, savedTokens };
}

/** 是否需要摘要压缩 */
export function needsCompaction(
	messages: Message[],
	contextWindow: number,
	options: CompactionOptions = {},
	calibration: UsageCalibration | null = null,
): boolean {
	if (contextWindow <= 0) {
		return false;
	}
	const ratio = options.thresholdRatio ?? 0.75;
	return estimateContextTokens(messages, calibration) >= contextWindow * ratio;
}

/** 摘要之外为用户原话保留的 token 预算 */
export const DEFAULT_KEEP_USER_TOKENS = 20_000;

/** 摘要里超过预算的那条原话被截断时的标记 */
const TRUNCATED_SUFFIX = "…（已按预算截断）";

/**
 * 按 token 预算截断一段文本。
 *
 * 先按「这段文本自身的字符/token 比」折算该留多少字符，再截——比逐字试算快，也比固定字数准。
 * 代理对不能被劈成半个字符，否则发出去就是乱码。
 */
export function truncateToTokenBudget(text: string, budget: number): string {
	const tokens = estimateTokens(text);
	if (budget <= 0) {
		return TRUNCATED_SUFFIX;
	}
	if (tokens <= budget) {
		return text;
	}
	const keep = Math.max(Math.floor((text.length * budget) / tokens) - TRUNCATED_SUFFIX.length, 1);
	let sliced = text.slice(0, keep);
	const last = sliced.charCodeAt(sliced.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		sliced = sliced.slice(0, -1);
	}
	return `${sliced}${TRUNCATED_SUFFIX}`;
}

/**
 * 从最新往回保留用户原话，直到用满预算。
 *
 * 顺序：从新到旧累计，第一条放不下的就停下，
 * 并把「一条都没放下」时的那条按剩余额度截断——用户最新说的那句不能整条丢。
 */
function keepUserMessages(users: Message[], budget: number): Message[] {
	if (budget <= 0 || users.length === 0) {
		return [];
	}
	const kept: Message[] = [];
	let remaining = budget;
	for (let index = users.length - 1; index >= 0; index -= 1) {
		const message = users[index];
		if (!message || message.role !== "user") {
			continue;
		}
		const tokens = estimateTokens(message.content);
		if (tokens <= remaining) {
			kept.unshift(message);
			remaining -= tokens;
			continue;
		}
		if (kept.length === 0 && remaining > 0) {
			kept.unshift({ ...message, content: truncateToTokenBudget(message.content, remaining) });
		}
		break;
	}
	return kept;
}

/**
 * 摘要请求：写成一份「交接文档」，而不是一段存档。
 *
 * 交接触发的压缩和「总结一下刚才聊了什么」是两件事：接手的是另一个模型，它有工具、有磁盘上
 * 的真实状态，最怕的是把已经做完的事又做一遍。所以措辞上明确要求写清未完成的事项与下一步，
 * 并说明已完成的只写结论。
 *
 * `maxTokens` 给出时把额度也写进去：接口的上限是硬截断，而这份文档里最要紧的「未完成的事项与
 * 下一步」恰好排在最后，所以要说清「写不下时先保哪一段」，不能只靠截断。
 */
export function buildSummaryRequest(maxTokens?: number): UserMessage {
	const lines = [
		"上面的对话会被换成你写的内容，由另一个模型接着往下做。请写成一份交接文档，用中文，不要客套，只写事实：",
		"1. 用户的目标、要求与约束（保留他的原话要点，不要改写）；2. 已经完成的事与结论；",
		"3. 改过或创建的文件（含路径）；4. 关键决定与原因；5. 踩过的坑与已经排除掉的路；",
		"6. 未完成的事项与下一步。",
		"已经做完的事只写结论，不要写成待办；不要复述无关的工具输出，不要编造没发生过的内容。",
	];
	if (maxTokens !== undefined) {
		lines.push(
			`整篇控制在 ${maxTokens} token 以内。篇幅不够时先保第 6 条（未完成的事项与下一步），` +
				"其余各条压缩着写，但不要因为篇幅把下一步丢掉。",
		);
	}
	return { role: "user", content: lines.join("\n") };
}

/** 交接摘要的前缀：说清这是交接而不是模型自己说过的话 */
export const HANDOFF_PREFIX = [
	"[此前对话的交接摘要]",
	"另一个模型已经开始处理这个任务，下面是它留下的交接摘要，它的工具运行状态（改过的文件、跑过的命令）仍然有效，",
	"不要重复已经完成的工作，直接从「未完成的事项」继续。摘要之后是你还没看到的用户原话与最近的对话。",
].join("\n");

/**
 * 把摘要套回消息列表。
 *
 * 保留系统提示词、摘要、用户原话（按预算）与最近若干条消息。摘要以 user 消息承载并带明确前缀——
 * 不伪装成模型自己说过的话，也不动 system 提示词（它每轮都会重新生成）。
 *
 * 中间那段被换掉的消息里，**用户原话单独捞出来按预算保留**：摘要是转述，原话是事实。
 */
export function applySummary(messages: Message[], summary: string, options: CompactionOptions = {}): Message[] {
	const keepRecent = Math.max(options.keepRecentMessages ?? 6, 1);
	const keepUserTokens = Math.max(options.keepUserTokens ?? DEFAULT_KEEP_USER_TOKENS, 0);
	const head = messages.slice(0, 1);
	let tail = messages.slice(-keepRecent);
	// 尾巴不能以工具结果开头：那会变成「没有对应调用的结果」，接口会拒。
	while (tail.length > 0 && tail[0]?.role === "tool") {
		tail = tail.slice(1);
	}
	// 原话只从「被摘要替换掉的那一段」里捞，否则会和尾巴里的重复。
	const older = messages.slice(1, Math.max(messages.length - tail.length, 1));
	const users = older.filter((message) => message.role === "user");
	const summaryMessage: Message = {
		role: "user",
		content: `${HANDOFF_PREFIX}\n${summary.trim()}`,
	};
	return [...head, summaryMessage, ...keepUserMessages(users, keepUserTokens), ...tail];
}

/** 折叠区小于这个体量就别摘要了（借自 Reasonix 的 foldEconomics）：花出去的可能比省下的多 */
export const MIN_FOLD_TOKENS = 400;

/** 摘要至少留这么多输出空间；再小写不下一份交接文档 */
export const MIN_SUMMARY_TOKENS = 512;

/** 摘要的输出上限：它只是一份交接文档，不该再写出一整轮对话的量 */
export const MAX_SUMMARY_TOKENS = 4096;

/**
 * 要被摘要换掉的那一段有多少 token。
 *
 * 「要不要压缩」看的是整段上下文，但「值不值得摘要」看的是**被换掉的那一段**：系统提示词
 * （AGENTS.md 可能有几万 token）不参与折叠，最近的几轮与用户原话也会原样留下。折叠区只有几百
 * token 的时候，摘要那次调用（还得把整个历史再发一遍）比省下的还贵——那种时候压缩是赔钱的。
 *
 * 切法与 `applySummary` 保持一致，否则「算出来值得摘要」和「实际折叠了多少」会对不上。
 */
export function foldableTokens(messages: Message[], options: CompactionOptions = {}): number {
	const keepRecent = Math.max(options.keepRecentMessages ?? 6, 1);
	const keepUserTokens = Math.max(options.keepUserTokens ?? DEFAULT_KEEP_USER_TOKENS, 0);
	let tail = messages.slice(-keepRecent);
	while (tail.length > 0 && tail[0]?.role === "tool") {
		tail = tail.slice(1);
	}
	const older = messages.slice(1, Math.max(messages.length - tail.length, 1));
	const users = older.filter((message) => message.role === "user");
	return Math.max(estimateMessages(older) - estimateMessages(keepUserMessages(users, keepUserTokens)), 0);
}

/**
 * 一次摘要最多写多少 token。
 *
 * 按折叠区的八分之一给，再夹在上下限之间：小折叠区别写出比原文还长的摘要，大折叠区也要有个头，
 * 否则一次摘要的输出能顶掉半轮对话的钱。额度还要写进摘要请求里——不告诉模型，它就会写到被硬截断，
 * 而被截掉的正好是排在最末尾的「未完成的事项与下一步」。
 */
export function summaryBudget(foldTokens: number): number {
	return Math.min(Math.max(Math.floor(foldTokens / 8), MIN_SUMMARY_TOKENS), MAX_SUMMARY_TOKENS);
}

/**
 * 把一次压缩写成一行给人看的说明。
 *
 * 措辞放在内核里：命令行与网页都播这个事件，两边各写一套迟早会出现「同一个事件两种说法」。
 */
export function describeCompaction(event: {
	pruned: number;
	savedTokens: number;
	summarized: boolean;
	rescued?: boolean;
	/** 一轮跑动中触发的压缩（而不是轮与轮之间） */
	midTurn?: boolean;
}): string {
	if (event.rescued === true) {
		return `上下文超窗，丢掉最旧的 ${event.pruned} 条消息后重发（用户原话与系统提示词都保留着）`;
	}
	const parts: string[] = [];
	if (event.pruned > 0) {
		parts.push(`裁剪 ${event.pruned} 段旧工具输出，省约 ${event.savedTokens} token`);
	}
	if (event.summarized) {
		parts.push("已生成上下文交接摘要");
	}
	const what = parts.length > 0 ? parts.join("，") : "无需处理";
	// 轮内压缩要说清：网页上它会出现在一轮的中途，不点明的话看着像别的东西触发的。
	return event.midTurn === true ? `上下文压缩（一轮之内自动触发）：${what}` : `上下文压缩：${what}`;
}

/** 接口回报「上下文过长」时的常见说法（各家网关措辞不一，所以按特征匹配） */
const OVERFLOW_PATTERNS = [
	/context[_ -]?length/i,
	/context[_ -]?window/i,
	/maximum context/i,
	/too many tokens/i,
	/exceed[^\n]{0,32}context/i,
	/reduce[^\n]{0,32}(length|tokens)/i,
	/token[s]?[^\n]{0,16}(limit|exceed)/i,
	/上下文[^\n]{0,10}(超|过|上限)/,
	/(超出|超过)[^\n]{0,10}(上下文|token|长度)/,
];

/**
 * 这条报错是不是「上下文超窗」。
 *
 * 值得单独认出来，是因为它有救：删掉最旧的几轮就能重发。别的原因（密钥错、参数错）删历史没用，
 * 只会白丢上下文。
 */
export function looksContextOverflow(message: string): boolean {
	return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/** 依次丢掉最旧的整轮，直到估算用量降到目标以下 */
export interface OverflowRescue {
	/** 救援后的消息列表（新数组） */
	messages: Message[];
	/** 丢掉的条目数 */
	dropped: number;
}

/**
 * 丢掉最旧的一轮。
 *
 * 只丢 assistant 与工具结果，**永远不丢用户原话与系统提示词**：前者是任务本身，后者是行为准则。
 * assistant 带工具调用时，紧随其后的工具结果必须一起丢，否则会留下「结果对不上调用」的历史，
 * 接口会直接拒掉整个请求。
 */
export function dropOldestTurn(messages: Message[]): OverflowRescue {
	for (let index = messages.length > 1 ? 1 : 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message || message.role === "user" || message.role === "system") {
			continue;
		}
		const next = messages.slice();
		next.splice(index, 1);
		let dropped = 1;
		if (message.role === "assistant" && message.toolCalls.length > 0) {
			while (index < next.length && next[index]?.role === "tool") {
				next.splice(index, 1);
				dropped += 1;
			}
		}
		return { messages: next, dropped };
	}
	return { messages, dropped: 0 };
}

/**
 * 超窗救援：反复丢掉最旧的轮次，直到估算用量回落到目标以下。
 *
 * 这里刻意**不用校准值**判断：校准值带着「上一次真实 prompt token 数」这个下限，一旦目标低于它，
 * 判断就永远不成立，会一路把历史丢空。救援是紧急刹车，宁可保守也不要把上下文铲平。
 */
export function rescueOverflow(
	messages: Message[],
	contextWindow: number,
	options: { targetRatio?: number; maxDrops?: number } = {},
): OverflowRescue {
	const target = contextWindow * (options.targetRatio ?? 0.6);
	const maxDrops = Math.max(options.maxDrops ?? 64, 1);
	let current = messages;
	let dropped = 0;
	while (dropped < maxDrops && contextWindow > 0 && estimateMessages(current) > target) {
		const step = dropOldestTurn(current);
		if (step.dropped === 0) {
			break;
		}
		current = step.messages;
		dropped += step.dropped;
	}
	return { messages: current, dropped };
}
