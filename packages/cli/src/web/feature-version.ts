/*
 * 版本与自更新：`GET /api/version`（看）与 `POST /api/self/rollback`（安排装回上一版）。
 *
 * 网页的「设置」面板里有「版本与自更新」这张卡片。终端一直能 `limkenion self status` 看这些、
 * `limkenion self rollback` 装回上一版，网页原来两样都没有。
 *
 * **回滚是「安排」而不是「执行」**：安装进程要等这个服务退出才动手（Windows 上正在被加载的文件换不掉），
 * 所以接口只把作业挂上去并回一句「请停掉这个服务」，不去杀进程——服务一停页面就什么都看不见了，
 * 用户也不明白为什么。**更新**仍然只在终端里（要从源码跑门禁与打包，几分钟），卡片上写明。
 *
 * 数据与动作都来自 `commands/self.ts`：与 `self status` / `self rollback` 同一份，不会各走各的。
 */

import {
	describeSelfResult,
	readSelfStatus,
	runSelfUpdate,
	type SelfUpdateStep,
	scheduleSelfRollback,
} from "../commands/self.ts";
import { APP_NAME, VERSION } from "../config.ts";
import type { FeatureRoute } from "./features.ts";
import { sendJson } from "./http.ts";
import type { ErrorResponse } from "./protocol.ts";

/** 版本信息端点 */
const VERSION_PATH = "/api/version";

/** 回滚端点 */
const ROLLBACK_PATH = "/api/self/rollback";

/** 更新端点 */
const UPDATE_PATH = "/api/self/update";

/** 进度里最多留几行构建输出（再多界面也放不下） */
const UPDATE_TAIL_LINES = 12;

/**
 * 网页上「更新」的进度。
 *
 * 更新要在源码目录里跑门禁与打包（几分钟），所以它是**异步**的：POST 立刻返回、后台接着跑，
 * 卡片每两秒拉一次 `GET /api/version` 看进度。一次只允许跑一个。
 */
export interface SelfUpdateJob {
	status: "running" | "scheduled" | "failed";
	/** 正在跑的步骤（running 时有意义） */
	step: SelfUpdateStep | null;
	/** 构建输出的最后几行 */
	tail: string[];
	startedAt: string;
	/** 安排成功后填上 */
	version: string | null;
	tgz: string | null;
	/** 人话回执 */
	note: string;
}

/**
 * 当前这一次更新。
 *
 * 状态挂在**这台服务器**上（`FeatureContext.selfUpdate`），不是模块级全局：重启服务就没了，
 * 而那时候作业（若已挂上）已经写在 `versions/install-job.json` 里，不依赖这份内存状态。
 * 放成模块级会让同一个进程里的两台服务器（以及测试用例之间）互相看到对方的进度。
 */
type SelfUpdateHolder = { job: SelfUpdateJob | null };

/**
 * `GET /api/version` 的响应。
 *
 * 形状定义在本模块而不是 protocol.ts：协议那份共享文件由多个功能并行改动，本功能自带的字段
 * 先留在自己这里（与 feature-doctor.ts / feature-files.ts 同一套做法）。前端是手写 JS，靠字段名对齐。
 */
export interface VersionResponse {
	/** 命令行工具自身的版本 */
	version: string;
	/** 自更新状态；全是本机文件里的记录，没有就是 null */
	current: string | null;
	previous: string | null;
	/** 上次自更新的结果，已渲染成人话 */
	lastResult: string;
	/** 安装日志路径 */
	log: string;
	/** 各版本 tgz 的存放目录 */
	dir: string;
	/** 更新与回滚在哪儿跑（网页里跑不了，得说清） */
	howToUpdate: string;
	/** 可用的更新源码目录（`limkenion web --from <目录>`）；没给就是 null，网页上就不能更新 */
	selfSource: string | null;
	/** 这一次更新的进度；没跑过就是 null */
	updateJob: SelfUpdateJob | null;
}

/** `POST /api/self/rollback` 的响应 */
export interface SelfRollbackResponse {
	ok: boolean;
	/** 要装回去的那个 tgz */
	tgz: string;
	/** 安装日志 */
	log: string;
	/** 下一步要做什么（装回是异步的：安装进程等这个服务退出才动手） */
	note: string;
}

/** 只认这三个端点；命中就整条请求归这里管（包括方法不对），因此总是返回 true */
export const route: FeatureRoute = (_request, response, url, method, context) => {
	if (url.pathname === VERSION_PATH) {
		// 版本是只读信息，没有请求体可读，因此没有 POST 的语义。
		if (method !== "GET") {
			sendJson(response, 405, { error: "版本信息只支持 GET /api/version" } satisfies ErrorResponse);
			return true;
		}

		const status = readSelfStatus();
		sendJson(response, 200, {
			version: VERSION,
			current: status.current,
			previous: status.previous,
			lastResult: describeSelfResult(status.result),
			log: status.log,
			dir: status.dir,
			// 安装是异步的：安排下去之后要停掉这个服务，安装进程才动得了手
			howToUpdate:
				`更新与回滚都是在后台把作业挂好、等你停掉这个服务之后才真正安装；装完重新启动服务即可。` +
				`更新要从源码跑门禁与打包，所以要先用 ${APP_NAME} web --from <源码目录> 启动（没给就只能用下面的回滚，或者去终端跑 ${APP_NAME} self update）。`,
			selfSource: context.selfSource ?? null,
			updateJob: context.selfUpdate.job,
		} satisfies VersionResponse);
		return true;
	}

	if (url.pathname === UPDATE_PATH) {
		if (method !== "POST") {
			sendJson(response, 405, { error: "更新只支持 POST /api/self/update" } satisfies ErrorResponse);
			return true;
		}
		/*
		 * 更新是**异步**的：门禁与打包要跑几分钟，不能把请求挂在那里（浏览器会超时、也看不到进度）。
		 * 所以这里起一个后台任务、立刻回 202，进度由卡片轮询 `GET /api/version` 拿。
		 */
		if (context.selfSource === undefined) {
			sendJson(response, 400, {
				error: `没有指定源码目录：用 ${APP_NAME} web --from <源码目录> 启动（更新要从源码跑门禁与打包），或在终端里跑 ${APP_NAME} self update`,
			} satisfies ErrorResponse);
			return true;
		}
		if (context.selfUpdate.job?.status === "running") {
			sendJson(response, 409, {
				// 真卡住了（比如构建挂住）时给一条出路：重启服务就能重试
				error: "已经在更新了，等它跑完（进度就在这张卡片上）；真卡住了就重启这个服务再试",
			} satisfies ErrorResponse);
			return true;
		}

		const holder: SelfUpdateHolder = context.selfUpdate;
		const source = context.selfSource;
		holder.job = {
			status: "running",
			step: "check",
			tail: [],
			startedAt: new Date().toISOString(),
			version: null,
			tgz: null,
			note: "正在跑门禁（biome + 类型检查 + 脚本自测），几分钟；这一步不过就不会动当前版本。",
		};
		void runSelfUpdate({
			source,
			// 测试注入：假执行器（不真跑 npm）与假「起安装进程」（不真装）
			deps: {
				...(context.selfRunner === undefined ? {} : { run: context.selfRunner }),
				...(context.spawnInstaller === undefined ? {} : { spawnInstaller: context.spawnInstaller }),
			},
			onStep: (step) => {
				if (holder.job !== null && holder.job.status === "running") {
					holder.job.step = step;
					holder.job.note = describeUpdateStep(step);
				}
			},
			onLine: (line) => {
				if (holder.job === null) {
					return;
				}
				holder.job.tail.push(line);
				if (holder.job.tail.length > UPDATE_TAIL_LINES) {
					holder.job.tail.splice(0, holder.job.tail.length - UPDATE_TAIL_LINES);
				}
			},
		})
			.then((outcome) => {
				if (holder.job === null) {
					return;
				}
				if (outcome.ok) {
					holder.job.status = "scheduled";
					holder.job.version = outcome.version;
					holder.job.tgz = outcome.tgz;
					holder.job.note = `已安排安装 ${outcome.version}。请停止这个服务（终端里 Ctrl+C，或关掉窗口），安装会在进程退出后自动完成；装好再重新启动。日志：${outcome.log}`;
					return;
				}
				holder.job.status = "failed";
				holder.job.note = outcome.reason;
			})
			// 构建那一步自己炸了（执行器抛错）也不能把服务带走：记成失败，卡片上看得见
			.catch((error: unknown) => {
				if (holder.job !== null) {
					holder.job.status = "failed";
					holder.job.note = `更新时出错了：${error instanceof Error ? error.message : String(error)}`;
				}
			});
		sendJson(response, 202, { job: holder.job } satisfies { job: SelfUpdateJob });
		return true;
	}

	if (url.pathname === ROLLBACK_PATH) {
		if (method !== "POST") {
			sendJson(response, 405, { error: "回滚只支持 POST /api/self/rollback" } satisfies ErrorResponse);
			return true;
		}
		/*
		 * 「安排」而不是「执行」：安装进程会等这个服务退出再 `npm install -g`，因为 Windows 上
		 * 正在被加载的文件换不掉。所以这里**主动去杀服务**是不对的——服务一停，页面上什么都看不见了，
		 * 用户也不明白为什么；正确的做法是把话说清楚，让用户自己停（与终端里 `self rollback` 一致）。
		 */
		const outcome = scheduleSelfRollback(
			// 测试注入「起安装进程」的替身；线上就是真的起分离进程（它等这个服务退出再装）
			context.spawnInstaller === undefined ? {} : { spawnInstaller: context.spawnInstaller },
		);
		if (!outcome.ok) {
			sendJson(response, 400, { error: outcome.reason } satisfies ErrorResponse);
			return true;
		}
		sendJson(response, 200, {
			ok: true,
			tgz: outcome.tgz,
			log: outcome.log,
			note: `已安排装回 ${outcome.tgz}。请停止这个服务（终端里 Ctrl+C，或关掉窗口），安装会在进程退出后自动完成；装好再重新启动。日志：${outcome.log}`,
		} satisfies SelfRollbackResponse);
		return true;
	}

	return false;
};

/** 更新各步骤的人话（卡片上那行进度） */
function describeUpdateStep(step: SelfUpdateStep): string {
	if (step === "check") {
		return "正在跑门禁（biome + 类型检查 + 脚本自测），几分钟；这一步不过就不会动当前版本。";
	}
	if (step === "package") {
		return "门禁过了，正在构建并打包（三个包），再等一会儿。";
	}
	return "已打好包，正在挂安装作业。";
}
