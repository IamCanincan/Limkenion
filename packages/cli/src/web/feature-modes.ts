/*
 * 计划模式、审批模式与输出风格：GET/POST /api/sessions/:id/modes
 *
 * 三种都是「会话的运行态」，改了立刻生效，因此这里只做三件事：校验取值、把值写进运行、把生效后的
 * 值回给调用方。判断逻辑（哪个工具要确认、严格档拦哪些工具、风格怎么写进提示词）在 core 里，
 * 本模块不重复实现，免得网页与命令行的规则慢慢走偏。
 */

import {
	APPROVAL_MODES,
	type ApprovalMode,
	OUTPUT_STYLES,
	type OutputStyle,
	PLAN_MODES,
	type PlanMode,
	STYLE_GUIDE,
} from "limkenion-core";
import type { FeatureRoute } from "./features.ts";
import { readJsonBody, sendJson } from "./http.ts";
import type { ModesResponse } from "./protocol.ts";

/** 匹配 `/api/sessions/<id>/modes`；id 的字符集与 server.ts 的会话路由保持一致 */
const MODES_PATH = /^\/api\/sessions\/([A-Za-z0-9-]+)\/modes$/;

/** 把字符串数组渲染成「a / b / c」，用于非法取值的错误提示 */
function listOf(values: readonly string[]): string {
	return values.join(" / ");
}

/**
 * 计划模式与审批模式的读写入口。
 *
 * 生成过程中一律拒绝（409）：模式值本身改起来是安全的，但「看着界面上写着 auto 却弹出了
 * 确认卡」这类不一致会让人怀疑开关没生效；拒绝并说明原因，比让人猜更省事。
 */
export const route: FeatureRoute = async (request, response, url, method, context) => {
	const match = MODES_PATH.exec(url.pathname);
	if (!match) {
		// 不是本模块的路径：交给后面的功能路由。
		return false;
	}
	const id = match[1] ?? "";
	// openById 会补建尚未打开的会话：刚建的会话也要能读模式，用户还没来得及发第一条指令。
	const run = context.registry.openById(id);
	if (!run) {
		sendJson(response, 404, { error: `会话不存在：${id}` });
		return true;
	}

	if (method === "GET") {
		const current: ModesResponse = {
			approval: run.approval,
			planMode: run.planMode,
			style: run.style,
			compaction: run.compaction,
		};
		sendJson(response, 200, current);
		return true;
	}

	if (method !== "POST") {
		sendJson(response, 405, { error: `不支持的方法 ${method}` });
		return true;
	}

	const body = await readJsonBody(request);
	// 四个字段都可选，但「一个都没给」不是合法请求：分不清是调用方写错了还是真想清空。
	const hasApproval = body.approval !== undefined;
	const hasPlanMode = body.planMode !== undefined;
	const hasStyle = body.style !== undefined;
	const hasCompaction = body.compaction !== undefined;
	if (!hasApproval && !hasPlanMode && !hasStyle && !hasCompaction) {
		sendJson(response, 400, { error: "至少要有 approval、planMode、style 或 compaction 字段" });
		return true;
	}
	// 校验放在改值之前：半个字段合法、半个非法时不能只生效一半。
	if (hasApproval && !(APPROVAL_MODES as readonly string[]).includes(String(body.approval))) {
		sendJson(response, 400, { error: `approval 只能是 ${listOf(APPROVAL_MODES)}` });
		return true;
	}
	if (hasPlanMode && !(PLAN_MODES as readonly string[]).includes(String(body.planMode))) {
		sendJson(response, 400, { error: `planMode 只能是 ${listOf(PLAN_MODES)}` });
		return true;
	}
	if (hasStyle && !(OUTPUT_STYLES as readonly string[]).includes(String(body.style))) {
		const options = OUTPUT_STYLES.map((name) => `${name}（${STYLE_GUIDE[name]}）`).join(" / ");
		sendJson(response, 400, { error: `style 只能是 ${options}` });
		return true;
	}
	// 压缩是布尔值：字符串 "false" 会被当成真，所以必须挑剔类型，不能只做真值判断。
	if (hasCompaction && typeof body.compaction !== "boolean") {
		sendJson(response, 400, { error: "compaction 只能是 true 或 false" });
		return true;
	}

	if (run.running) {
		sendJson(response, 409, { error: "该会话正在生成中，请先停止或等这一轮结束再切换模式" });
		return true;
	}

	if (hasApproval) {
		run.setApproval(body.approval as ApprovalMode);
	}
	if (hasPlanMode) {
		run.setPlanMode(body.planMode as PlanMode);
	}
	if (hasStyle) {
		run.setStyle(body.style as OutputStyle);
	}
	if (hasCompaction) {
		run.setCompaction(body.compaction === true);
	}

	// 回「生效后的值」而不是回显请求体：将来若有模式被规范化，调用方拿到的仍是事实。
	const applied: ModesResponse = {
		approval: run.approval,
		planMode: run.planMode,
		style: run.style,
		compaction: run.compaction,
	};
	sendJson(response, 200, applied);
	return true;
};
