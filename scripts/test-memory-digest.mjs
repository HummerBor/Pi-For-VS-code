// 记忆接力一期单测（工单34 / dispatch-t34 §四.2）：用**真实会话 jsonl** 喂 digest 纯函数。
//
// 为什么不用手搓全合成样本：合成样本只能证明「代码按我写的规则跑」，证明不了
// 「pi 真喂进来的是这个形状」。所以主样本从 ~/.pi/agent/sessions/** 捞真实 jsonl，
// 按 session 文件的 message 帧还原出 CompactionPreparation.messagesToSummarize 的形状
// （role + content blocks）；合成样本只用来覆盖真实样本不一定命中/触发得够狠的分支
// （四节都有货、>300 字用户消息、计划句该被丢、预算裁剪、畸形输入）。
//
// 跑法：node scripts/test-memory-digest.mjs（harness/** 不进 tsc，靠本文件的 import 兜底类型/语法）
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIGEST_TOKEN_BUDGET, buildDigest, estimateTokens } from "../harness/memory/digest.ts";

let total = 0;
let passed = 0;
function check(name, fn) {
	total++;
	try {
		fn();
		passed++;
	} catch (e) {
		console.error(`✗ ${name}: ${e?.message ?? e}`);
		throw e;
	}
}

const KEYS = ["user", "decisions", "conclusions", "rejections"];

/** 从真实 jsonl 还原 messagesToSummarize 形状（只取 message 帧；compaction/custom 帧不是消息） */
function parseSessionMessages(file) {
	const out = [];
	const lines = fs.readFileSync(file, "utf8").split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // 半行/坏行不参与（jsonl 只按 \n 分帧）
		}
		if (entry?.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		if (typeof role !== "string") continue;
		out.push({ role, content });
	}
	return out;
}

/** 在 sessions/** 里挑一个「够真实」的样本：≤3MB（大文件解析慢）、≥10 条消息、
 *  含 assistant 文本与 toolResult——三个条件放一起才能同时覆盖「结论」与「不抽 toolResult」。 */
function findRealSample() {
	const root = path.join(os.homedir(), ".pi", "agent", "sessions");
	if (!fs.existsSync(root)) return null;
	let files = [];
	try {
		files = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".jsonl"));
	} catch {
		return null;
	}
	const candidates = files
		.map((d) => path.join(d.parentPath ?? d.path, d.name))
		.filter((f) => {
			try {
				return fs.statSync(f).size <= 3 * 1024 * 1024;
			} catch {
				return false;
			}
		})
		.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
	for (const file of candidates.slice(0, 60)) {
		let messages;
		try {
			messages = parseSessionMessages(file);
		} catch {
			continue;
		}
		const assistants = messages.filter((m) => m.role === "assistant").length;
		const toolResults = messages.filter((m) => m.role === "toolResult").length;
		if (messages.length >= 10 && assistants >= 2 && toolResults >= 1) return { file, messages };
	}
	return null;
}

const real = findRealSample();

// ── 真实样本：结构 / 预算 / toolResult 不外泄 ──────────────────────────────
if (!real) {
	console.log("[skip] 本机没有可用真实会话样本（~/.pi/agent/sessions 为空或都太小），只跑合成样本");
} else {
	const digest = buildDigest(real.messages);
	console.log(`样本: ${real.file}\n  消息 ${real.messages.length} 条（user ${digest.stats.user} / assistant ${digest.stats.assistant} / toolResult ${digest.stats.toolResult}）`);

	check("真实样本·四节齐全且顺序稳定", () => {
		assert.deepStrictEqual(digest.sections.map((s) => s.key), KEYS, "节顺序必须固定为 user→decisions→conclusions→rejections");
		for (const s of digest.sections) assert.ok(Array.isArray(s.items), `${s.key} 的 items 必须是数组`);
		assert.ok(digest.sections[0].items.length > 0, "真实会话至少有用户原话");
		assert.ok(digest.sections[2].items.length > 0, "真实会话至少有每轮结论");
	});

	check("真实样本·估算 token ≤ 4000 且与 text 自洽", () => {
		assert.ok(digest.estTokens <= DIGEST_TOKEN_BUDGET, `estTokens=${digest.estTokens} 超预算`);
		assert.strictEqual(digest.estTokens, estimateTokens(digest.text), "estTokens 必须等于对 text 的估算");
	});

	check("真实样本·toolResult 正文不外泄", () => {
		assert.ok(digest.stats.toolResult > 0, "样本应含 toolResult，否则这条断言没有意义");
		let sampled = 0;
		for (const m of real.messages) {
			if (m.role !== "toolResult") continue;
			const text = typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? m.content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n")
					: "";
			const flat = text.replace(/\s+/g, " ").trim();
			if (flat.length < 80) continue;
			// 取中段 40 字当指纹：toolResult 正文若进了 digest，任意一段中段文本都会出现
			const probe = flat.slice(Math.floor(flat.length / 2), Math.floor(flat.length / 2) + 40);
			assert.ok(!digest.text.includes(probe), `toolResult 正文泄漏进 digest: ${probe}`);
			if (++sampled >= 5) break;
		}
		assert.ok(sampled > 0, "样本里应有 ≥80 字的 toolResult 正文，否则指纹断言没跑");
	});
}

// ── 合成样本：每条规则各有正例/反例 ──────────────────────────────────
const longUser = `【长用户消息开头】${"甲".repeat(190)}${"乙".repeat(150)}【结尾约束：不许动 webview】`;
check("长用户消息取首 200 + 末 100", () => {
	const d = buildDigest([{ role: "user", content: longUser }]);
	const item = d.sections[0].items[0];
	assert.ok(item.startsWith("【长用户消息开头】"), "必须保留开头");
	assert.ok(item.endsWith("【结尾约束：不许动 webview】"), "必须保留结尾（尾部常是追加约束）");
	assert.ok(item.includes("…"), "必须带省略号");
	assert.ok(Array.from(item).length <= 301, `首 200 + … + 末 100 应 ≤301 字，实际 ${Array.from(item).length}`);
});

check("短用户回复紧跟 assistant → 单独成「用户裁决句」", () => {
	const d = buildDigest([
		{ role: "assistant", content: [{ type: "text", text: "我准备用方案 A。" }] },
		{ role: "user", content: "不行，改成 B" },
		{ role: "user", content: "这条不是裁决：前面还是用户消息，不是 assistant" },
	]);
	assert.deepStrictEqual(d.sections[1].items, ["不行，改成 B"]);
});

check("每轮结论取纯文本块最后一段、忽略 thinking/toolCall、单条 ≤200", () => {
	const d = buildDigest([
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "思考内容不许出现" },
				{ type: "text", text: "中间段落也不该被抽" },
				{ type: "toolCall", name: "bash", arguments: { command: "echo hi" } },
				{ type: "text", text: `最终结论：${"结".repeat(260)}` },
			],
		},
	]);
	const items = d.sections[2].items;
	assert.strictEqual(items.length, 1, "一条 assistant 消息只出一条结论");
	assert.ok(items[0].startsWith("最终结论："), "必须是最后一段");
	assert.ok(!d.text.includes("思考内容不许出现"), "thinking 不许外泄");
	assert.ok(!d.text.includes("中间段落也不该被抽"), "非最后一段不许被抽");
	assert.ok(Array.from(items[0]).length <= 201, `结论应 ≤200 字 + 省略号，实际 ${Array.from(items[0]).length}`);
});

check("计划句不进结论节（「接下来」类）", () => {
	const d = buildDigest([
		{ role: "assistant", content: [{ type: "text", text: "接下来我将要跑 compile 验证。" }] },
		{ role: "assistant", content: [{ type: "text", text: "下一步我先读 DIRECTOR.md。" }] },
	]);
	assert.deepStrictEqual(d.sections[2].items, [], "计划句过期即废，不许占预算");
});

check("否决清单：命中五个信号词、单条 ≤150、最多 10 条", () => {
	const sentences = [];
	for (let i = 0; i < 15; i++) sentences.push(`方案${i}不采用，因为不行${"否".repeat(200)}`);
	const d = buildDigest([{ role: "assistant", content: [{ type: "text", text: sentences.join("。") }] }]);
	assert.ok(d.sections[3].items.length > 0, "否决句必须被抽");
	assert.ok(d.sections[3].items.length <= 10, "最多 10 条");
	for (const it of d.sections[3].items) assert.ok(Array.from(it).length <= 151, "单条 ≤150 字 + 省略号");
	for (const word of ["不采用", "放弃", "否决", "因为不行", "改成"]) {
		const one = buildDigest([{ role: "assistant", content: [{ type: "text", text: `这件事${word}了` }] }]);
		assert.ok(one.sections[3].items.length === 1, `信号词「${word}」应命中否决清单`);
	}
});

check("toolResult 正文与自定义角色一律不抽（合成指纹）", () => {
	const MARK = "TOOLRESULT_SENTINEL_9f3a";
	const d = buildDigest([
		{ role: "user", content: "看下日志" },
		{ role: "toolResult", content: [{ type: "text", text: `${MARK} 一大堆工具输出` }] },
		{ role: "custom", content: `${MARK} custom 帧也不抽` },
	]);
	assert.ok(!d.text.includes(MARK), "toolResult/custom 正文不许进 digest");
});

check("超预算按 TRIM_PRIORITY 裁剪（结论先削光，否决清单与裁决句一条不少）", () => {
	const big = [];
	const rejections = [];
	for (let i = 0; i < 400; i++) {
		big.push({ role: "user", content: `第${i}条用户长消息：${"丙".repeat(700)}` });
		big.push({ role: "assistant", content: [{ type: "text", text: `第${i}轮结论：${"丁".repeat(180)}` }] });
	}
	// 否决句 + 裁决句各埋一批：它们是本次裁剪**不该动**的信息
	for (let i = 0; i < 12; i++) rejections.push(`方案${i}不采用，因为实测踩坑${"戊".repeat(100)}`);
	big.push({ role: "assistant", content: [{ type: "text", text: rejections.join("。") }] });
	big.push({ role: "user", content: "用 B" }); // 紧跟 assistant = 裁决句

	const d = buildDigest(big);
	assert.ok(d.estTokens <= DIGEST_TOKEN_BUDGET, `裁剪后 estTokens=${d.estTokens} 仍超预算`);
	assert.ok(d.stats.dropped.total > 0, "这种输入必须触发裁剪（stats.dropped.total > 0）");
	assert.deepStrictEqual(d.sections.map((s) => s.key), KEYS, "裁剪不许把节点删掉");

	// ① 第一刀落在 conclusions（可再生的那节先削），且结论被削光后 user 才动
	assert.ok(d.stats.dropped.conclusions > 0, "被砍的第一批必须来自 conclusions");
	assert.deepStrictEqual(d.sections[2].items, [], "结论应被削光（它是最可再生的一节）");
	assert.ok(d.stats.dropped.user > 0, "结论削光还不够时，才轮到 user");

	// ② 否决清单与裁决句一条不少（最不可再生的信息）
	assert.strictEqual(d.stats.dropped.rejections, 0, "rejections 一条都不许砍");
	assert.strictEqual(d.stats.dropped.decisions, 0, "decisions 一条都不许砍");
	assert.strictEqual(d.sections[3].items.length, 10, `否决清单应保持满 10 条，实际 ${d.sections[3].items.length}`);
	assert.deepStrictEqual(d.sections[1].items, ["用 B"], "用户裁决句必须保住");
	assert.strictEqual(
		d.stats.dropped.total,
		d.stats.dropped.user + d.stats.dropped.decisions + d.stats.dropped.conclusions + d.stats.dropped.rejections,
		"total 必须等于按节计数之和",
	);
});

check("刚好超预算时只削 conclusions，user 一条不动（裁剪粒度按节）", () => {
	// 用户消息按 301 字截断 ≈ 101 token 一条；先把「无结论」的底子顶到 ~3700 token，
	// 再甩一批结论把总预算顶破——只有结论需要被削，用户原话一条不该少。
	const msgs = [];
	for (let i = 0; i < 37; i++) msgs.push({ role: "user", content: `第${i}条：${"己".repeat(700)}` });
	for (let i = 0; i < 8; i++) msgs.push({ role: "assistant", content: [{ type: "text", text: `第${i}轮结论：${"庚".repeat(150)}` }] });
	const d = buildDigest(msgs);
	assert.ok(d.stats.dropped.total > 0, "样本必须真的超预算（否则这条断言没意义）");
	assert.ok(d.stats.dropped.conclusions > 0, "先砍 conclusions");
	assert.strictEqual(d.stats.dropped.user, 0, "conclusions 够削时不许动 user");
	assert.strictEqual(d.sections[0].items.length, 37, "用户原话必须一条不少");
});

check("0 条 / 畸形输入不抛，返回空结构", () => {
	for (const input of [undefined, null, [], "not-an-array", [{}, { role: "user" }, { role: "user", content: [] }]]) {
		const d = buildDigest(input);
		assert.deepStrictEqual(d.sections.map((s) => s.key), KEYS, "空输入也要四节齐全");
		for (const s of d.sections) assert.deepStrictEqual(s.items, [], "空输入各节必须为空");
		assert.strictEqual(d.estTokens, estimateTokens(d.text));
		assert.strictEqual(d.stats.dropped.total, 0);
		for (const k of KEYS) assert.strictEqual(d.stats.dropped[k], 0, `空输入的 dropped.${k} 必须为 0`);
	}
});

console.log(`test-memory-digest: ${passed}/${total} 通过${real ? `（真实样本 ${real.messages.length} 条消息，estTokens ${buildDigest(real.messages).estTokens}）` : "（无真实样本）"}`);
