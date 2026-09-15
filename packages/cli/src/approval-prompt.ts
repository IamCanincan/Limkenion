/**
 * 终端上的工具审批。
 *
 * 主要在 `ask` 模式下被调用；`auto` 档下只有「疑似危险命令」与「写到工作目录之外」这两类判定
 * 会走这里（见 core 的 approval.ts：那些规则只把判定往严的方向抬）。非交互环境（管道、CI、
 * `-p` 一次性模式）**一律拒绝**：没有人能回答的时候，默认放行是最糟的选择。
 *
 * 提示写 stderr，与「正文走 stdout」的输出约定一致——`limkenion -p "..." > out.txt` 不会
 * 因此混进审批文字。
 */

import { createInterface } from "node:readline/promises";
import { type ApprovalRequest, describeApprovalPrefix, summarizeInline } from "limkenion-core";

/**
 * 问用户要不要放行这次工具调用。
 *
 * 给「本会话总是允许」留了第三个答案 `a`，但**只在审批层给出了可记前缀时才提供**：越界写入与
 * 疑似危险命令没有前缀，用户也就看不到这个选项——那两类本来就该每次单独判断。选项里会写清
 * 这条规则到底放行了什么（前缀的措辞由 core 统一给出），避免用户以为只是「这次也一样」。
 */
export async function askApproval(request: ApprovalRequest): Promise<{ approved: boolean; remember?: boolean }> {
	if (!process.stdin.isTTY) {
		process.stderr.write(`[审批] ${request.tool} 需要确认，但当前不是交互终端，已按拒绝处理\n`);
		return { approved: false };
	}

	const prefix = request.suggestedPrefix;
	process.stderr.write(`\n需要确认：${request.tool} ${summarizeInline(request.input)}\n原因：${request.reason}\n`);
	if (prefix !== undefined) {
		process.stderr.write(`总是允许：${describeApprovalPrefix(request.tool, prefix)}（本会话有效）\n`);
	}
	const question = prefix === undefined ? "允许执行？(y/N) " : "允许执行？(y/N/a=本会话总是允许) ";
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(question)).trim().toLowerCase();
		if (answer === "a" && prefix !== undefined) {
			return { approved: true, remember: true };
		}
		return { approved: answer === "y" || answer === "yes" };
	} catch {
		// Ctrl+C 之类的中断按拒绝处理，不要让异常冒到生成循环里。
		return { approved: false };
	} finally {
		rl.close();
	}
}
