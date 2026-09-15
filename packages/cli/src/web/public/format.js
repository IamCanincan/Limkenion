/*
 * 纯文本处理：Markdown 渲染与各种格式化。
 *
 * 这里的所有函数都不碰 DOM，也不读全局状态，可以单独测试与复用。
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** 转义 HTML，模型输出属于不可信内容，必须先转义再套格式 */
function escapeHtml(text) {
	return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** 行内格式：先转义，再处理代码、加粗、链接 */
function renderInline(text) {
	return escapeHtml(text)
		.replace(/`([^`\n]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
		.replace(
			/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
			'<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
		);
}

/**
 * 极简 Markdown 渲染。
 *
 * 只支持实际会出现的几种结构：围栏代码块、标题、无序/有序列表、段落，加上行内格式。
 * 不追求完整语法覆盖——真正的目标是让代码块和列表可读，同时保证不执行任何 HTML。
 */
export function renderMarkdown(source) {
	const codes = [];
	// 先把代码块抠出来，避免其中的 # * ` 被后续规则改写。
	const text = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
		codes.push({ lang: String(lang).trim(), code: String(code) });
		return `\u0000${codes.length - 1}\u0000`;
	});

	const out = [];
	let listTag = null;
	const closeList = () => {
		if (listTag) {
			out.push(`</${listTag}>`);
			listTag = null;
		}
	};

	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\s+$/, "");
		const placeholder = /^\u0000(\d+)\u0000$/.exec(line.trim());
		if (placeholder) {
			closeList();
			const item = codes[Number(placeholder[1])];
			const label = item.lang ? `<span class="code-lang">${escapeHtml(item.lang)}</span>` : "<span></span>";
			// 代码块头行固定放「语言 + 复制按钮」，复制按钮的点击由 app.js 统一代理。
			out.push(
				`<div class="code-block"><div class="code-head">${label}<button class="code-copy" type="button">复制</button></div><pre><code>${escapeHtml(item.code)}</code></pre></div>`,
			);
			continue;
		}
		if (line.trim() === "") {
			closeList();
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			closeList();
			const level = heading[1].length;
			out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			continue;
		}
		const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
		const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (bullet || ordered) {
			const tag = bullet ? "ul" : "ol";
			if (listTag !== tag) {
				closeList();
				out.push(`<${tag}>`);
				listTag = tag;
			}
			out.push(`<li>${renderInline((bullet ?? ordered)[1])}</li>`);
			continue;
		}
		closeList();
		out.push(`<p>${renderInline(line)}</p>`);
	}
	closeList();
	return out.join("");
}

/**
 * 把长路径压成「盘符\…\末段」，让窄栏里也能看见目录名。
 *
 * 侧栏只有两百多像素，直接截尾会把最有信息量的目录名切掉；用 CSS 的 direction: rtl 做左截断
 * 又会让分隔符跑到错误的位置（反斜杠会被重排），所以在这里算好。
 */
export function shortenPath(path, keep = 1) {
	const trimmed = path.replace(/[/\\]+$/, "");
	const separator = trimmed.includes("\\") ? "\\" : "/";
	const parts = trimmed.split(/[/\\]+/).filter((part) => part !== "");
	if (parts.length <= keep + 1) {
		return path;
	}
	const tail = parts.slice(-keep).join(separator);
	// Windows 的盘符与 POSIX 的根都保留，相对路径没有什么前缀可省。
	const drive = /^[A-Za-z]:/.test(parts[0]);
	if (drive) {
		return `${parts[0]}${separator}…${separator}${tail}`;
	}
	if (trimmed.startsWith(separator)) {
		return `${separator}…${separator}${tail}`;
	}
	return `…${separator}${tail}`;
}

/** 毫秒数转可读文本 */
export function formatDuration(ms) {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * token 数转可读文本。
 *
 * 上下文动辄上百万 token，一串数字看不出量级，统一压成 K / M。
 */
export function formatTokens(count) {
	if (!Number.isFinite(count) || count < 0) {
		return "0";
	}
	if (count < 1000) {
		return String(count);
	}
	if (count < 1_000_000) {
		return `${(count / 1000).toFixed(count < 100_000 ? 1 : 0)}K`;
	}
	return `${(count / 1_000_000).toFixed(2)}M`;
}

/**
 * 一轮的用量转成状态栏文案：输入输出 token、上下文占用、耗时。
 *
 * `usage.promptTokens` 是**本轮累计**（一轮里跑了 5 次模型就是 5 份之和），拿它比上下文窗口会算出
 * 好几倍；占用比例要用服务端另给的 `contextTokens`（最后一次请求实际发出去多少）。两者都缺时
 * 这一块就不显示，而不是编一个 0 出来。
 */
export function formatUsage(usage, contextWindow, elapsedMs, contextTokens) {
	if (!usage) {
		return "";
	}
	const parts = [`↑${formatTokens(usage.promptTokens)} ↓${formatTokens(usage.completionTokens)}`];
	if (typeof contextTokens === "number" && contextTokens > 0 && contextWindow > 0) {
		parts.push(`上下文 ${((contextTokens / contextWindow) * 100).toFixed(1)}%`);
	}
	if (typeof elapsedMs === "number" && elapsedMs > 0) {
		parts.push(formatDuration(elapsedMs));
	}
	return parts.join(" · ");
}

/**
 * 取路径的最后一段，用来当工作区的显示名。
 *
 * Windows 盘符根（`D:\`）与 POSIX 根（`/`）都没有「最后一段」，这时退回整条路径：
 * 显示名可以是空的，分组的 `title` 里还有完整路径，但空标题会让人以为列表坏了。
 */
export function baseName(path) {
	const text = typeof path === "string" ? path : "";
	const parts = text.split(/[/\\]+/).filter((part) => part !== "");
	return parts.length === 0 ? text : parts[parts.length - 1];
}

/**
 * 时间戳转相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，再久就给绝对日期。
 *
 * 为什么以「天」为界而不是「周」：侧栏一行只有两百多像素，相对时间要一眼能排出先后，
 * 「9 天前」还算看得懂，再往上就不如直接给日期。未来时间（机器时钟偏差、会话文件被复制过）
 * 一律按「刚刚」处理，不能显示成「-3 分钟前」。
 */
export function formatRelativeTime(ms, now = Date.now()) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
		return "";
	}
	const diff = now - ms;
	if (diff < 60_000) {
		return "刚刚";
	}
	if (diff < 3_600_000) {
		return `${Math.floor(diff / 60_000)} 分钟前`;
	}
	if (diff < 86_400_000) {
		return `${Math.floor(diff / 3_600_000)} 小时前`;
	}
	if (diff < 7 * 86_400_000) {
		return `${Math.floor(diff / 86_400_000)} 天前`;
	}
	return new Date(ms).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** ISO 时间转本地短格式 */
export function formatTime(iso) {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

/** 把工具入参压成一行摘要 */
export function summarizeInput(input) {
	let text;
	try {
		text = JSON.stringify(input);
	} catch {
		text = String(input);
	}
	if (!text) {
		return "";
	}
	return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
