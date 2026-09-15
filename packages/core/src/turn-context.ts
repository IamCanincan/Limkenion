/**
 * 一轮的上下文快照。
 *
 * 一次模型调用要用到的东西在这里**一次性定下来**：模型、工具表与它的接口描述、轮数上限、
 * 温度、工作目录。从前这些是主循环里现读的字段，或者在循环外只读一次——后者会出这样一个错：
 * 一轮跑到一半换了模型（网页上直接切下拉框），后半轮还在用旧模型，而界面显示、以及提示词里
 * 写的都已经是新的了。
 *
 * 每次调模型前重建一份，所以轮内改档位、换模型会在**下一次调用**生效，一轮之内不会半新半旧。
 *
 * 审批模式与计划模式刻意**不**进来：那两项按既有约定每次工具调用前现读（见 tool-pipeline.ts），
 * 网页与命令行都承诺「改了立刻生效」，而且 `exit_plan_mode` 被批准后，同一批里剩下的工具也要
 * 马上放行。
 */

import { type Model, resolveModel, type ToolSpec } from "limkenion-ai";
import type { SessionState } from "./session.ts";
import { type AgentTool, toToolSpec } from "./types.ts";

/** 一次模型调用的全部配置 */
export interface TurnContext {
	/** 本轮使用的模型 id */
	modelId: string;
	/** 解析后的模型信息（含上下文窗口） */
	model: Model;
	/** 本轮可调用的工具 */
	tools: AgentTool[];
	/** 与 tools 对应的接口描述，每轮只算一次 */
	toolSpecs: ToolSpec[];
	/** 本轮最多调用模型几次 */
	maxTurns: number;
	/** 采样温度 */
	temperature: number | undefined;
	/** 工作目录：审批判定与越界检查的基准 */
	cwd: string;
}

/** 按会话此刻的状态做一份快照 */
export function buildTurnContext(state: SessionState): TurnContext {
	return {
		modelId: state.modelId,
		model: resolveModel(state.modelId),
		tools: state.tools,
		toolSpecs: state.tools.map(toToolSpec),
		maxTurns: state.maxTurns,
		temperature: state.temperature,
		cwd: state.cwd,
	};
}
