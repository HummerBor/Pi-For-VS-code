/**
 * 记忆接力一期（工单34）：压缩后指针注入 + 压缩前 digest 探针。
 *
 * 背景与证据（docs/decisions.md §十七，2026-11-19 总监取证，勿重查）：
 * - pi 的压缩**不改 jsonl**：SessionManager._persist 是 appendFileSync，只追加一条
 *   `{type:"compaction", summary, firstKeptEntryId, tokensBefore, details, usage}`；
 *   上下文变短发生在**读取时**（buildContextEntries 从 firstKeptEntryId 起取）——所以
 *   「压后模型不知道读哪些文件」不是记忆丢了，是**指针丢了**。
 * - 摘要由一次 LLM 调用产出，固定 7 段模板，会丢掉「被否决的方案 / 踩过的坑 / 边界禁令」。
 * - 两个钩子都是公开扩展事件（pi 0.1.54，bundle chunk-44DLKSKE.js 已核验）：
 *   `session_before_compact` 入参含 `preparation.messagesToSummarize`（即将被丢掉的那批消息）；
 *   `session_compact` 在 appendCompaction 之后、且被 await——此时注入指针必然落在压缩点之后。
 *
 * 一期两件事（边界：**不接管摘要**，不 return {compaction}，那是二期单）：
 *   ① session_compact → pi.sendMessage({customType:"memory-pointer"}, {triggerTurn:false})
 *      = 一条**进 LLM 上下文**的固定指针（appendCustomMessageEntry → jsonl 的 custom_message 帧，
 *        UI 可见、不启动新回合）。文案固定 ≤60 token，**不许拼动态内容**：
 *        动态拼「重读 X 的 §Y」要靠模型自己判断哪个 §Y，而它此刻正确缺的正是这个判断。
 *   ② session_before_compact → buildDigest() 后 pi.appendEntry("memory-digest", {...})
 *      = custom 帧（**不进上下文**、只落盘），供真机观察抽取质量——质量不过关就谈不上二期的接管。
 *
 * 硬约束（派单书 §三）：钩子内零网络、零 fs 写、零 exec；抽逻辑全在 digest.ts（纯函数）；
 * 本文件只做「读事件 → 调纯函数 → 走 pi 公开 API」。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildDigest } from "./digest.ts";

/** 固定指针（≤60 token，不许拼动态内容）。
 *  「按需重读」而不是「必须重读」：小任务不需要三份文档，硬塞会白烧上下文。 */
const MEMORY_POINTER =
	"上下文已压缩。动手前按需重读：AGENTS.md（铁律与边界）/ PROGRESS.md（当前状态与待办）/ docs/decisions.md（相关小节）。";

/** digest 帧的 customType（观测脚本/真机核对按它 grep jsonl） */
const DIGEST_ENTRY = "memory-digest";
const POINTER_MESSAGE = "memory-pointer";

export default function memoryHarness(pi: ExtensionAPI): void {
	// ① 压缩成功后注入指针。
	// 为什么不用 appendEntry：custom 帧不进上下文，模型永远读不到，等于没注入；
	// 为什么 triggerTurn:false：这里只在「用户刚压完、要接着干」的场景有用，
	// 补一轮新回合会打断用户正在输入的东西（流式中 pi 会把它入队到 turn_end 再落盘，安全）。
	pi.on("session_compact", async () => {
		try {
			pi.sendMessage(
				{
					customType: POINTER_MESSAGE,
					content: [{ type: "text", text: MEMORY_POINTER }],
					display: true, // 转录里显示出来：用户要能看见「这一轮为什么模型突然去翻文档」
				},
				{ triggerTurn: false },
			);
		} catch (e) {
			// 注入失败绝不冒泡到压缩链（压缩本身已经成功落盘了，别把成功的事故化）
			console.error("[memory-harness] 指针注入失败:", (e as Error)?.stack ?? e);
		}
	});

	// ② 压缩前算 digest，只落 custom 帧（探针）。
	// ⚠️ 打死不返回 {compaction}：返回它就等于接管摘要，一期没这个授权（二期单再议）。
	pi.on("session_before_compact", async (event) => {
		try {
			const prep = event?.preparation;
			const digest = buildDigest(prep?.messagesToSummarize);
			pi.appendEntry(DIGEST_ENTRY, {
				version: digest.version,
				// 触发源与「会不会重试」：真机上要能区分「用户手压」和「溢出恢复压的」
				reason: event?.reason,
				willRetry: event?.willRetry === true,
				tokensBefore: prep?.tokensBefore,
				firstKeptEntryId: prep?.firstKeptEntryId,
				previousSummaryKept: typeof prep?.previousSummary === "string" && prep.previousSummary.length > 0,
				estTokens: digest.estTokens,
				stats: digest.stats,
				sections: digest.sections,
				text: digest.text,
			});
		} catch (e) {
			// 探针失败绝不影响压缩：这一段是观测面，不是功能面
			console.error("[memory-harness] digest 落盘失败:", (e as Error)?.stack ?? e);
		}
		return undefined; // 显式「不接管」：pi 只在 handler 返回 {compaction} 时才用扩展摘要
	});
}
