/*
 * 「版本与自更新」卡片：设置面板里的最后一张。
 *
 * 终端一直能 `limkenion self status`（当前装的是哪一版、上一版能不能回滚、上次更新成没成），
 * 网页这边原来一片空白。这张卡把那几项如实摆出来，数据来自 `GET /api/version`。
 *
 * **更新与回滚都是「安排」**：点一下会把安装作业挂到分离进程上，那个进程等这个服务退出才动手
 * ——Windows 上正被加载的文件换不掉。所以回执说的是「请停掉这个服务」，不是「已完成」。
 * 区别在代价：更新要在源码目录里跑门禁与打包（几分钟，进度靠轮询这个端点拿），回滚是现成的 tgz。
 *
 * 卡片外壳复用 modes.js 设置面板那套类名（`lmk-modes-card` 等）：这张卡就长在那个面板里，
 * 与旁边两张用同一套尺寸与层级才对得齐；本模块自己的行内布局用自己的前缀 `lkv-`，样式自己注入。
 */

import { api } from "./api.js";
import { icon } from "./icons.js";

/** 注入样式：类名带自己的前缀，颜色只用既有 MD3 角色变量 */
function injectStyle() {
	if (document.getElementById("lkv-version-style") !== null) {
		return;
	}
	const style = document.createElement("style");
	style.id = "lkv-version-style";
	style.textContent = `
/* 卡片里的「名 值」两列：名字一列固定，值一列可省略（路径很长） */
.lkv-version-row { display: flex; align-items: baseline; gap: var(--space-2); font-size: var(--text-xs); line-height: 1.7; }
.lkv-version-key { flex: 0 0 auto; color: var(--muted); }
.lkv-version-value { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text); }
/* 值缺失时说清「没有」，而不是留一片空白 */
.lkv-version-value[data-missing="1"] { color: var(--muted); }
`;
	document.head.append(style);
}

/** 一行「名字 + 值」；值给空字符串时显示 `empty` */
function row(key, value, empty = "（无）") {
	const line = document.createElement("div");
	line.className = "lkv-version-row";
	const name = document.createElement("span");
	name.className = "lkv-version-key";
	name.textContent = key;
	const text = document.createElement("span");
	text.className = "lkv-version-value";
	const shown = value === "" ? empty : value;
	text.textContent = shown;
	// 路径会被省略号截住：全量放 title 里，鼠标停一下能看到
	text.title = shown;
	if (value === "") {
		text.dataset.missing = "1";
	}
	line.append(name, text);
	return line;
}

/** 只取文件名：tgz 的绝对路径很长，卡片上认得出是哪一版就够 */
function baseName(path) {
	return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 建这张卡片；由 modes.js 的设置面板挂进去（和「接口密钥」那张一样）。
 */
export function buildVersionCard() {
	injectStyle();
	const root = document.createElement("div");
	root.className = "lmk-modes-card";

	const head = document.createElement("div");
	head.className = "lmk-modes-card-head";
	const title = document.createElement("span");
	title.className = "lmk-modes-card-title";
	title.textContent = "版本与自更新";
	const note = document.createElement("span");
	note.className = "lmk-modes-card-note";
	note.textContent = "本机记录";
	head.append(title, note);

	const body = document.createElement("div");
	const desc = document.createElement("div");
	desc.className = "lmk-modes-desc";

	const render = (data) => {
		body.replaceChildren(
			row("当前版本", data.version === "" ? "" : `limkenion ${data.version}`),
			row(
				"上一版（可回滚）",
				data.previous === null || data.previous === undefined ? "" : baseName(data.previous),
				"还没有可回滚的版本",
			),
			row("上次自更新", data.lastResult ?? ""),
			row("安装日志", data.log ?? ""),
		);
		// 有回滚点才给按钮：没有上一版时它按下去只会失败，那不如不给
		rollback.hidden = data.previous === null || data.previous === undefined;
		rollback.dataset.tgz = data.previous ?? "";

		/*
		 * 更新要跑门禁与打包（几分钟），所以进度是**轮询**出来的：服务端把这次更新记在内存里，
		 * 卡片每两秒拉一次这个端点，把「跑到哪一步」和构建输出的最后几行摆出来。
		 * 没给 --from（`selfSource` 为 null）时不给按钮，并说清为什么。
		 */
		const job = data.updateJob ?? null;
		const canUpdate = typeof data.selfSource === "string" && data.selfSource !== "";
		update.hidden = !canUpdate;
		if (!canUpdate) {
			desc.textContent = data.howToUpdate ?? "";
			return;
		}
		if (job === null) {
			update.disabled = false;
			updateLabel.textContent = "更新到源码当前状态";
			desc.textContent = `源码目录：${data.selfSource}。点「更新」会先跑门禁、再打包，然后挂上安装作业；这几分钟里服务照常能用。`;
			return;
		}
		if (job.status === "running") {
			update.disabled = true;
			updateLabel.textContent = "更新中…";
			const tail = Array.isArray(job.tail) && job.tail.length > 0 ? `\n最近输出：${job.tail.at(-1)}` : "";
			desc.textContent = `${job.note ?? "正在更新…"}${tail}`;
			// 跑着的时候自己接着轮询
			schedulePoll();
			return;
		}
		update.disabled = job.status === "scheduled";
		updateLabel.textContent = job.status === "scheduled" ? "已安排" : "重试更新";
		desc.textContent = job.note ?? "";
	};

	const failed = document.createElement("div");
	failed.className = "lmk-modes-actions";
	const retry = document.createElement("button");
	retry.type = "button";
	retry.className = "lmk-modes-option";
	retry.append(icon("refresh", 14));
	const retryLabel = document.createElement("span");
	retryLabel.textContent = "重试";
	retry.append(retryLabel);
	retry.hidden = true;

	/*
	 * 「回滚到上一版」：这是一次**安排**，不是立刻装完。
	 *
	 * 服务端把安装作业挂到分离进程上，那个进程等这个服务退出才开始 `npm install -g`（Windows 上正在被
	 * 加载的文件换不掉）。所以回执写的是「请停掉这个服务」，而不是「已完成」——说成已完成，用户会以为
	 * 重启一下就好了，实际什么都没装。
	 */
	const rollback = document.createElement("button");
	rollback.type = "button";
	rollback.className = "lmk-modes-option";
	rollback.append(icon("refresh", 14));
	const rollbackLabel = document.createElement("span");
	rollbackLabel.textContent = "回滚到上一版";
	rollback.append(rollbackLabel);
	rollback.hidden = true;
	rollback.addEventListener("click", async () => {
		const tgz = rollback.dataset.tgz ?? "";
		if (!window.confirm(`装回 ${baseName(tgz)}？\n\n服务端会先挂上安装作业；你停掉这个服务之后它才真正安装。`)) {
			return;
		}
		rollback.disabled = true;
		try {
			const outcome = await api("/api/self/rollback", { method: "POST" });
			desc.textContent = outcome.note;
			rollbackLabel.textContent = "已安排";
		} catch (error) {
			desc.textContent = `回滚没安排上：${error.message}`;
			rollback.disabled = false;
		}
	});

	/*
	 * 「更新到源码当前状态」：跑门禁 + 打包（几分钟）后才挂安装作业。
	 *
	 * 这几分钟里服务照常能用，所以请求是异步的（服务端把进度记在内存里），卡片轮询着显示进度。
	 * 与回滚一样，装是在**服务退出之后**才发生——回执说清这一点。
	 */
	const update = document.createElement("button");
	update.type = "button";
	update.className = "lmk-modes-option";
	update.append(icon("refresh", 14));
	const updateLabel = document.createElement("span");
	updateLabel.textContent = "更新到源码当前状态";
	update.append(updateLabel);
	update.hidden = true;
	update.addEventListener("click", async () => {
		if (
			!window.confirm(
				"从源码跑门禁与打包（几分钟），然后挂上安装作业？\n\n这几分钟里服务照常能用；打包完成后要停掉这个服务才真正安装。",
			)
		) {
			return;
		}
		update.disabled = true;
		updateLabel.textContent = "更新中…";
		desc.textContent = "正在跑门禁（biome + 类型检查 + 脚本自测），几分钟；这一步不过就不会动当前版本。";
		try {
			await api("/api/self/update", { method: "POST" });
		} catch (error) {
			desc.textContent = `更新没跑起来：${error.message}`;
			update.disabled = false;
			updateLabel.textContent = "重试更新";
			return;
		}
		schedulePoll();
	});

	const load = async () => {
		try {
			const data = await api("/api/version");
			render(data);
			retry.hidden = true;
		} catch (error) {
			// 读不到就说清读不到：版本信息不该静默空着，让人以为卡还没做好
			body.replaceChildren(row("当前版本", ""));
			desc.textContent = `读不到版本信息：${error.message}`;
			retry.hidden = false;
			rollback.hidden = true;
			update.hidden = true;
		}
	};
	retry.addEventListener("click", () => void load());

	/*
	 * 轮询：更新在服务端跑着，界面只能问。只排一个定时器（重复 render 不会叠加），
	 * 而且只在卡片还在文档里时才继续——面板切走之后没必要一直问。
	 */
	let pollTimer = null;
	const schedulePoll = () => {
		if (pollTimer !== null) {
			return;
		}
		pollTimer = setTimeout(() => {
			pollTimer = null;
			if (!root.isConnected) {
				return;
			}
			void load();
		}, 2000);
	};

	failed.append(update, rollback, retry);
	root.append(head, body, failed, desc);
	void load();
	return root;
}
