/**
 * 会话运行的注册表。
 *
 * 从 `runs.ts` 拆出来的：那个文件同时住着「一次运行」（`Run`）与「所有运行」（这里），而两者的
 * 生命周期完全不同——`Run` 跟着一轮对话走，注册表跟着进程走。它们之间只有一处单向依赖（注册表造
 * `Run` 并持有它），拆开之后 `runs.ts` 只讲「一轮怎么跑」，这里只讲「有哪些会话、它们在哪个目录」。
 *
 * 它是**跨工作目录**的：会话文件按工作目录分桶存放，而网页侧栏把它们放在一起按目录分组显示，
 * 所以这里的每一次查找都可能在别的桶里命中。
 */

import { getSessionsDir } from "../config.ts";
import { listAllSessionFiles, Session } from "../session.ts";
import type { SessionSummary } from "./protocol.ts";
import { Run, type RunOptions } from "./runs.ts";

/** 排序键：拖过序的按 `order`，没拖过的按修改时间（两者同一个量级，见 `Session.setOrder`） */
function sortKey(summary: SessionSummary): number {
	return summary.order ?? summary.updatedAt;
}

/**
 * 给单个会话换工作目录的结果。
 *
 * 失败原因分两种而不是一句话：调用方要据此回不同的状态码（不存在 404 / 正在生成 409），
 * 界面也才能说清「换个会话试试」还是「先点停止」。
 */
export type SetSessionCwdResult =
	| { ok: true; cwd: string }
	| { ok: false; reason: "missing" | "running"; error: string };

/** 会话运行的集合：内存里那一份按会话文件索引，跨工作目录（会话本来就按目录分桶存放） */
export class RunRegistry {
	private readonly runs = new Map<string, Run>();
	private readonly options: RunOptions;

	constructor(options: RunOptions) {
		this.options = options;
	}

	/**
	 * 换「当前工作目录」。
	 *
	 * 只改注册表往后新建会话时的落点，**不动已有的运行**——这正是它与「重建注册表」的区别：
	 * 重建会把同一进程里别的会话连同正在生成的一轮一起掀翻，而这里只是让接下来的新会话落在新目录里。
	 * 给某个会话换目录时同步调一次（见 server.ts 的 switchCwd），于是「面板看哪个目录」与
	 * 「新会话落在哪个目录」跟着使用者刚选的那一个走，不需要各自再记一份。
	 */
	setDefaultCwd(cwd: string): void {
		this.options.cwd = cwd;
	}

	/**
	 * 取已有运行；不存在则从磁盘上的会话文件新建一个。
	 *
	 * 先在当前工作目录里找（网页上新建的会话就落在这一桶里，绝大多数情况一次命中）。找不到再按 id
	 * 跨目录找：`setSessionCwd` 换过目录的会话，文件仍留在原来那个工作目录下（不搬文件，免得已经
	 * 写下的历史在磁盘上换个位置），只有头里的 cwd 变了——照着 cwd 的桶去找它必然扑空，而 Run 要的
	 * cwd 恰恰来自头，所以认出它是谁就够了，不必先切全局 cwd。
	 */
	openById(id: string): Run | null {
		const existing = this.getById(id);
		if (existing) {
			return existing;
		}
		const here = Session.list(this.options.cwd).find((candidate) => candidate.header.id === id);
		const session = here ?? this.findSession(id);
		return session ? this.create(session) : null;
	}

	/**
	 * 按 id 找会话文件，**跨全部工作目录**。
	 *
	 * 列表、改名、归档、分叉都要能碰到别的的工作区：会话是按工作目录分目录存的，而网页侧栏现在
	 * 把它们放在一起按工作区分组显示。找不到就返回 null，调用方自己决定报 404 还是先切 cwd。
	 */
	findSession(id: string): Session | null {
		for (const file of listAllSessionFiles(getSessionsDir())) {
			const session = Session.open(file);
			if (session?.header.id === id) {
				return session;
			}
		}
		return null;
	}

	/**
	 * 给某一个会话换工作目录。
	 *
	 * 与「切全局 cwd」是两件事：全局那份一换，别的会话也得跟着换（注册表整体重建，正在跑的一轮被
	 * 打断），而这里只动一个会话——改它会话头里的 cwd，再丢掉内存里那一份 Run。下次打开这个会话时
	 * 会重新构造 Run，构造函数按会话头取 cwd（见 Run.cwd），于是自动落在新目录里。
	 *
	 * 正在生成的会话一律拒绝：cwd 在 Agent 构造时就散进了系统提示词、工具集与审批判定，中途换掉会
	 * 让同一轮的前后两步在不同的目录里执行——这比「先停下来」危险得多。
	 *
	 * 失败不用异常表达：这条路直接从 HTTP 路由调进来，「会话不存在」与「正在生成」要回不同的状态码
	 * 与文案，让调用方拿到结构化的结论比抛出去再翻译成一句 400 清楚。
	 */
	setSessionCwd(id: string, target: string): SetSessionCwdResult {
		const run = this.getById(id);
		if (run?.running) {
			return { ok: false, reason: "running", error: "会话正在生成，先停止再换工作目录" };
		}
		const session = run?.session ?? this.findSession(id);
		if (!session) {
			return { ok: false, reason: "missing", error: "会话不存在" };
		}
		session.setCwd(target);
		/*
		 * 丢掉内存里那一份运行，而不是就地改 Agent 的 cwd：没有一个「只改 cwd」的统一入口，重建才是
		 * 唯一不会改一半的路。已经在看这个会话的 SSE 连接会留在旧对象上（旧对象不再产生事件），
		 * 重连时自然拿到新构造的那一个。
		 */
		this.runs.delete(session.file);
		return { ok: true, cwd: target };
	}

	/**
	 * 当前生效的接口密钥。
	 *
	 * 每次调用都重新问一次启动时拿到的那个解析函数，而不是把值缓存下来：网页上刚保存的密钥要立刻
	 * 对评审生效。评审会另造一批一次性代理，而密钥、模型这些配置只存在于这里——不从这里取，
	 * 功能模块就只能自己再解析一遍凭据，那正是要避免的第二条路。
	 */
	resolveApiKey(): string {
		return this.options.resolveApiKey();
	}

	/**
	 * 当前生效的接口地址；没给就是官方地址（由 ai 层自己兜底）。
	 *
	 * 与密钥同一道理：评审要另造代理，而「密钥 + 地址 + 模型」是一整套配置，从三个地方各取一份
	 * 迟早会拼出不匹配的组合（例如新密钥配旧地址）。仍然只有这里在保管它们。
	 */
	resolveBaseUrl(): string | undefined {
		return this.options.baseUrl;
	}

	/** 新建一个会话文件并为其创建运行 */
	create(session: Session = Session.create(this.options.cwd)): Run {
		const run = new Run(session, this.options);
		this.runs.set(session.file, run);
		return run;
	}

	/** 按会话 id 取运行，不新建 */
	getById(id: string): Run | undefined {
		for (const run of this.runs.values()) {
			if (run.session.header.id === id) {
				return run;
			}
		}
		return undefined;
	}

	/**
	 * 磁盘上的全部会话摘要，含运行状态。
	 *
	 * **跨全部工作目录**：会话是按工作目录分目录存的，而侧栏把它们放在一起按工作区分组显示
	 * （选到别组的会话时，server 会先把 cwd 切过去再打开）。
	 *
	 * **排序在这里一次做定**：键取 `order ?? updatedAt`（两者同一个量级，见 `Session.setOrder`），
	 * 越大越靠前。于是「拖过序的按使用者排的，没拖过的按最近使用」是一条规则；新会话还没被排过，
	 * 它的修改时间最新，自然落在最上面。界面照单渲染，自己不再排一遍（两边各排一次迟早会不一致）。
	 */
	summaries(): SessionSummary[] {
		const known = new Set<string>();
		const summaries: SessionSummary[] = [];
		for (const file of listAllSessionFiles(getSessionsDir())) {
			const session = Session.open(file);
			if (!session) {
				continue;
			}
			known.add(session.file);
			const { messageCount, preview, title, order } = session.describe();
			summaries.push({
				id: session.header.id,
				file: session.file,
				createdAt: session.header.createdAt,
				cwd: session.header.cwd,
				updatedAt: session.updatedAt(),
				messageCount,
				preview,
				title,
				order,
				running: this.runs.get(session.file)?.running ?? false,
				waiting: this.runs.get(session.file)?.waiting ?? false,
			});
		}
		// 刚创建但还没写入消息的会话也要出现在列表里。
		for (const run of this.runs.values()) {
			if (known.has(run.session.file)) {
				continue;
			}
			summaries.push({
				id: run.session.header.id,
				file: run.session.file,
				createdAt: run.session.header.createdAt,
				cwd: run.session.header.cwd,
				updatedAt: run.session.updatedAt(),
				messageCount: 0,
				preview: "",
				title: run.session.header.title ?? "",
				order: run.session.header.order ?? null,
				running: run.running,
				waiting: run.waiting,
			});
		}
		return summaries.sort((left, right) => sortKey(right) - sortKey(left) || right.updatedAt - left.updatedAt);
	}

	/**
	 * 按使用者拖出来的次序重排：`ids` 自上而下，写进每个会话文件头的 `order`。
	 *
	 * 键取「当时的时间戳往下递减」：既保证这一次的次序，又让它与 `updatedAt` 同一个量级——
	 * 之后新建的会话（修改时间更晚、没有 order）仍然落在最上面。
	 *
	 * **正在生成的会话跳过不写**：重写文件头是「读整个文件 → 改第一行 → 写回」，与正在追加的消息
	 * 撞上会丢掉那一轮（改名、切目录同样先拦这个）。跳过的个数如实回给界面。
	 */
	reorderByIds(ids: string[]): { ordered: number; skipped: number } {
		const byId = new Map(this.summaries().map((summary) => [summary.id, summary]));
		const base = Date.now();
		let ordered = 0;
		let skipped = 0;
		for (const id of ids) {
			const summary = byId.get(id);
			if (!summary) {
				continue;
			}
			if (summary.running) {
				skipped += 1;
				continue;
			}
			const session = this.getById(id)?.session ?? this.findSession(id);
			if (!session) {
				continue;
			}
			session.setOrder(base - ordered);
			ordered += 1;
		}
		return { ordered, skipped };
	}

	/**
	 * 删除会话。正在生成的会话不允许删除，否则写盘会打到一个已删除的文件上。
	 */
	removeById(id: string): "removed" | "running" | "missing" {
		const run = this.getById(id);
		if (run?.running) {
			return "running";
		}
		const session = run?.session ?? this.findSession(id);
		if (!session) {
			return "missing";
		}
		session.remove();
		// 会话没了，它起的后台任务与子代理记录也一起收
		run?.cleanup();
		this.runs.delete(session.file);
		return "removed";
	}

	/** 停止所有正在生成的运行，用于服务端关闭 */
	abortAll(): void {
		for (const run of this.runs.values()) {
			run.cleanup();
		}
		this.abort(this.runs.values());
	}

	/**
	 * 停止所有正在生成的运行并等它们收尾。
	 *
	 * 收尾包括把这一轮用完的工具进程收干净。直接删工作目录会撞上 `EBUSY`（Windows 上进程还占着
	 * 目录），所以调用方应当在删目录或关临时仓库之前等这一次。
	 */
	async abortAllAndWait(): Promise<void> {
		const pending = this.abort(this.runs.values());
		await Promise.allSettled(pending);
	}

	/** 逐个中止；返回每一条的收尾 promise（不中止的给一个已完成的值） */
	private abort(runs: Iterable<Run>): Promise<void>[] {
		const pending: Promise<void>[] = [];
		for (const run of runs) {
			pending.push(run.abortRun());
		}
		return pending;
	}
}
