/**
 * 记忆接力一期：压缩前 digest 抽取（纯函数，零 pi 依赖，可被 node 直接 import 单测）。
 *
 * 为什么要有它：pi 的压缩摘要（7 段固定模板：Goal / Constraints / Progress / Key Decisions /
 * Next Steps / Critical Context）会丢掉「被否决的方案 / 踩过的坑 / 边界禁令」——那类信息
 * 不可再生（只在对话里出现过一次），一旦压掉就得重新踩坑。docs/decisions.md §十七 实测：
 * jsonl 永完整，丢的只是上下文视图。
 *
 * 一期只做**探针**：压缩前把「按不可再生性排序」的要点算成 digest，落一条 custom 帧
 * （pi.appendEntry，不进 LLM 上下文），用来在真机上观察抽取质量；**不接管摘要**
 * （不 return {compaction}，二期单再议）。
 *
 * 抽取规则（派单书 §二.6；下面 ①→④ 是**展示/抽取**顺序，超预算时的裁剪优先级
 * 另算一套，见 TRIM_PRIORITY）：
 *   ① 用户原话：全文；>300 字取「首 200 + 末 100」加省略号
 *   ② 用户裁决句：user 消息 <80 字且上一条是 assistant（短回复 = 拍板/纠偏）
 *   ③ 每轮结论：assistant 纯文本块的最后一段（忽略 toolCall / thinking），单条截 200 字
 *   ④ 否决清单：assistant 纯文本里含「不采用 / 放弃 / 否决 / 因为不行 / 改成」的句子，
 *      单条截 150 字，最多 10 条
 * 不抽：toolResult 正文（可再生、且体量最大）、含「我将要 / 接下来 / 下一步我」的计划句
 * （过期即废）、文件清单（pi 的 preparation.fileOps 本来就有，重复抽只挤预算）。
 *
 * 总量硬上限 DIGEST_TOKEN_BUDGET = 4000 token（按 字符数/3 粗估，与派单书同口径）；
 * 超了按 **TRIM_PRIORITY**（可再生性由易到难）逐节逐条砍：conclusions → user → decisions → rejections。
 * 注意裁剪顺序**不是**展示顺序（SECTION_ORDER）的倒序：倒序会把否决清单当垃圾先丢掉（工单39）。
 */

/** 压缩事件里真正喂给本模块的形状（pi 的 CompactionPreparation.messagesToSummarize 子集） */
export interface DigestInputMessage {
	role?: string;
	content?: unknown;
}

export type DigestSectionKey = "user" | "decisions" | "conclusions" | "rejections";

export interface DigestSection {
	/** 稳定的节标识：消费方（测试/观测脚本）按 key 断言，不按标题文字 */
	key: DigestSectionKey;
	title: string;
	items: string[];
}

/** 按节计的裁剪条数；`total` 是旧口径的单数字（保留，观测量/断言都还认它） */
export type DigestDropped = { total: number } & Record<DigestSectionKey, number>;

export interface DigestStats {
	total: number;
	user: number;
	assistant: number;
	toolResult: number;
	/** 因总预算不足被砍掉的条目数。升级为按节计数（工单39）：真机上要能一眼看出
	 *  「这次把否决清单砍没了」还是「只削了点结论」，一个总数看不出砍在了哪。
	 * `total` 保留总数口径（>0 = 这次压缩的信息量大到超兜了）。 */
	dropped: DigestDropped;
}

export interface Digest {
	version: 1;
	/** **固定四节、固定顺序**（user → decisions → conclusions → rejections），空节也保留 */
	sections: DigestSection[];
	/** sections 渲染成 markdown（观测用：真机看这一坨就知道抽取质量） */
	text: string;
	/** 字符数/3 粗估（派单书口径；不引 tokenizer，钩子内零依赖） */
	estTokens: number;
	stats: DigestStats;
}

export const DIGEST_VERSION = 1;
export const DIGEST_TOKEN_BUDGET = 4000;

/** 用户原话：>300 字 → 首 200 + 末 100（尾比中段更可能藏着「但是/除非」这类约束） */
const USER_FULL_MAX = 300;
const USER_HEAD = 200;
const USER_TAIL = 100;
/** 用户裁决句上限（短回复才算裁决） */
const VERDICT_MAX = 80;
/** 每轮结论单条上限 */
const CONCLUSION_MAX = 200;
/** 否决清单：单条上限 + 总条数上限（再多也挤不进 4k 预算，还会淹掉结论） */
const REJECT_MAX = 150;
const REJECT_LIMIT = 10;

/** 计划句标记（派单书原文三条）：这类句子压掉不可惜，抽出来反而误导下一轮 */
const PLAN_MARKERS = ["我将要", "接下来", "下一步我"];

/** 否决信号词（派单书原文五个）：命中即认为这句话记录了「已经排除的选项」 */
const REJECT_MARKERS = ["不采用", "放弃", "否决", "因为不行", "改成"];

const SECTION_TITLES: Record<DigestSectionKey, string> = {
	user: "用户原话",
	decisions: "用户裁决句",
	conclusions: "每轮结论",
	rejections: "否决清单",
};

/** 展示顺序（固定，不许跟着裁剪策略动）：user → decisions → conclusions → rejections */
const SECTION_ORDER: DigestSectionKey[] = ["user", "decisions", "conclusions", "rejections"];

/** 超预算裁剪顺序 = 按「可再生性」由易到难，**与展示顺序解耦**（工单39）：
 *  1 conclusions 每轮结论：大部分能从代码 / git log / 归档重建，先削它最不心疼
 *  2 user 用户原话：已有「首 200 + 末 100」截断兜底，且问题大意能靠结论反推
 *  3 decisions 用户裁决句：不可再生（「行 / 不改 / 用 B」只在对话里出现过一次），尽量保
 *  4 rejections 否决清单：**最不可再生**——「试过 X 不行、因为 Y」只存在于历史对话，
 *    代码和 git log 里都查不到，丢了就得重新踩坑；宁可把别的砍光也不动它。
 * 反例（工单34 实测）：旧实现按展示顺序从尾部砍，最后一节恰好是 rejections，
 * 61.5MB 会话超预算时否决清单剩 0 条、user 却留了 81 条 —— 最贵的信息先被扔掉。 */
export const TRIM_PRIORITY: DigestSectionKey[] = ["conclusions", "user", "decisions", "rejections"];

/** 字符数/3 粗估（Array.from 以码点计，避免代理对把长度算成两倍） */
export function estimateTokens(text: string): number {
	return Math.ceil(Array.from(text).length / 3);
}

function chars(s: string): string[] {
	return Array.from(s);
}

/** 取文本块（content 可能是 string，也可能是 [{type:"text"|"thinking"|"toolCall"...}]）。
 *  只认 text：thinking 是过程、toolCall 是手段，两者都不是结论。 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const part = raw as { type?: unknown; text?: unknown };
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

function cutTail(text: string, max: number): string {
	const arr = chars(text);
	return arr.length > max ? `${arr.slice(0, max).join("")}…` : text;
}

/** 用户原话：短的留全文，长的留「首 + 末」——中间往往是复述，尾部常是追加约束 */
function cutHeadTail(text: string): string {
	const arr = chars(text);
	if (arr.length <= USER_FULL_MAX) return text;
	return `${arr.slice(0, USER_HEAD).join("")}…${arr.slice(-USER_TAIL).join("")}`;
}

/** 最后一段非空段落（「段」按空行/换行切；单条 assistant 文本常是「结论\n\n接下来我…」） */
function lastParagraph(text: string): string {
	const paras = text
		.split(/\n+/)
		.map((p) => p.trim())
		.filter(Boolean);
	return paras.length ? paras[paras.length - 1] : "";
}

function splitSentences(text: string): string[] {
	return text
		.split(/[。；;!?！？\n]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function isPlanSentence(sentence: string): boolean {
	return PLAN_MARKERS.some((m) => sentence.includes(m));
}

function pushUnique(list: string[], seen: Set<string>, item: string): void {
	if (!item || seen.has(item)) return;
	seen.add(item);
	list.push(item);
}

/** 抽 digest。入参容错：undefined / 非数组 / 元素畸形一律当空，**永不抛**（钩子内不许炸）。 */
export function buildDigest(messages: DigestInputMessage[] | undefined | null): Digest {
	const list = Array.isArray(messages) ? messages : [];
	const buckets: Record<DigestSectionKey, string[]> = {
		user: [],
		decisions: [],
		conclusions: [],
		rejections: [],
	};
	const seen: Record<DigestSectionKey, Set<string>> = {
		user: new Set(),
		decisions: new Set(),
		conclusions: new Set(),
		rejections: new Set(),
	};
	const stats: DigestStats = {
		total: list.length,
		user: 0,
		assistant: 0,
		toolResult: 0,
		dropped: { total: 0, user: 0, decisions: 0, conclusions: 0, rejections: 0 },
	};

	for (let i = 0; i < list.length; i++) {
		const msg = list[i];
		if (!msg || typeof msg !== "object") continue;
		const role = typeof msg.role === "string" ? msg.role : "";
		// 取文本延后到「真要抽的角色」再算：toolResult 正文常是几十~几百 KB，
		// 先 join 一遍再丢掉 = 压缩钩子里白烧的时间和内存（钩子是同步阻塞的）

		if (role === "user") {
			stats.user++;
			const text = textOf(msg.content).trim();
			if (!text) continue; // 纯图片/纯附件消息：没有可抽的文字
			pushUnique(buckets.user, seen.user, cutHeadTail(text));
			// 裁决句：短 + 上一条是 assistant = 用户在对上一条结论拍板（「行」「不改」「用 B」）
			const prev = i > 0 ? list[i - 1] : undefined;
			const prevRole = prev && typeof prev === "object" ? prev.role : undefined;
			if (prevRole === "assistant" && chars(text).length < VERDICT_MAX) {
				pushUnique(buckets.decisions, seen.decisions, text);
			}
			continue;
		}

		if (role === "assistant") {
			stats.assistant++;
			const text = textOf(msg.content).trim();
			if (!text) continue; // 纯 toolCall 回合：没有结论可抽
			const para = lastParagraph(text);
			// 计划句不抽（过期即废）：只对结论行生效——否决清单里的「改成 X」是事实记录，
			// 不能因为句子里带「接下来」就丢掉（那是一期最值钱的一类信息）
			if (para && !isPlanSentence(para)) {
				pushUnique(buckets.conclusions, seen.conclusions, cutTail(para, CONCLUSION_MAX));
			}
			for (const sentence of splitSentences(text)) {
				if (buckets.rejections.length >= REJECT_LIMIT) break;
				if (!REJECT_MARKERS.some((m) => sentence.includes(m))) continue;
				if (isPlanSentence(sentence)) continue;
				pushUnique(buckets.rejections, seen.rejections, cutTail(sentence, REJECT_MAX));
			}
			continue;
		}

		if (role === "toolResult") {
			stats.toolResult++;
			continue;
		}
		// 其他角色（custom / compactionSummary / branchSummary…）不抽：不是人的原话也不是结论
	}

	const sections: DigestSection[] = SECTION_ORDER.map((key) => ({
		key,
		title: SECTION_TITLES[key],
		items: buckets[key],
	}));

	stats.dropped = enforceBudget(sections); // 裁剪后才渲染：text/estTokens 必须是裁剪后的真值
	const text = renderSections(sections);
	return { version: DIGEST_VERSION, sections, text, estTokens: estimateTokens(text), stats };
}

function renderSections(sections: DigestSection[]): string {
	return sections
		.map((s) => {
			const body = s.items.map((item) => `- ${item}`).join("\n");
			return body ? `## ${s.title}\n${body}` : `## ${s.title}`;
		})
		.join("\n\n");
}

/** 超预算就按 TRIM_PRIORITY 逐节砍（节内仍从尾部逐条 pop，那是抽取代数的先后，不改语义）：
 *  先把 conclusions 削光，再动 user，然后 decisions，最后才轮到 rejections。
 *  返回按节计的裁剪条数（写进 stats.dropped）：真机上既要知道砍了多少、更要知道砍在哪。
 *  注：每 pop 一条重算一次 token，复杂度 O(n²)；与旧实现同口径，条目数量级（≤ 数百条）可接受。 */
function enforceBudget(sections: DigestSection[]): DigestDropped {
	const dropped: DigestDropped = { total: 0, user: 0, decisions: 0, conclusions: 0, rejections: 0 };
	const byKey = new Map(sections.map((s) => [s.key, s] as const));
	const overBudget = () => estimateTokens(renderSections(sections)) > DIGEST_TOKEN_BUDGET;
	for (const key of TRIM_PRIORITY) {
		if (!overBudget()) break; // 已经削够了：后面的节（decisions / rejections）一条不动
		const section = byKey.get(key);
		if (!section) continue; // 防御：sections 由本模块构造，四节恒定齐全
		while (section.items.length > 0 && overBudget()) {
			section.items.pop();
			dropped[key]++;
			dropped.total++;
		}
	}
	return dropped; // 全砍光还超预算 = 只剩节标题，不可能发生；防御性退出
}
