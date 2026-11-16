/**
 * 会话用量/花费（2026-11-05 用户三轮纠偏后的最终口径：**pi 算的，壳只搬**）。
 *
 * 用户的判据很简单：「你算的跟 pi 自己算的不一样，能复用就复用」。所以：
 *   合计金额  = pi 的 `getSessionStats().cost`（= 页脚那个 $，遍历**全部 session entries**
 *               的 usage.cost.total 累加，压缩/分支摘要/工具消息都算在内）
 *   四类 token = pi 的 `getSessionStats().tokens`
 *   分项金额  = pi 逐条 usage.cost.{input,output,cacheRead,cacheWrite} 的累加
 *               **同一次 entries 遍历、同一份 pi 结果**，壳不做任何定价/归一/缩放
 * 之前两版为什么错（记在这里防复蹈）：
 *   ① 从 `getMessages()` 累加 → 压缩后旧消息被摘要替代、usage 条目不在 messages 里，账直接少一截；
 *   ② 按模型价目表重算 + 归一 → 那是壳自己算钱，与 pi 的数不可避免地分叉。
 *
 * 货币：pi 的价目表是 USD，用户在国内用 DeepSeek（账单是元）。展示层提供 cny，按**用户可改的
 * 汇率**（设置 piChat.usdCnyRate，默认 7.2）折算，界面上标「≈」——换算写在明面上，不藏在代码里。
 * 本文件只做「单位换算 + 缺省兜底」，不参与金额计算。
 * 纯函数零 import（webview 共享编译 / node 裸跑用例两处都要能用）。
 */

export interface UsageSummary {
  /** 四类 token（pi 原值） */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  /** 分项金额（pi 逐条成本累加，已按货币换算） */
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  /** 合计金额（pi 的 cost，已按货币换算） */
  cost: number;
  currency: "usd" | "cny";
  /** 实际使用的汇率（usd 时恒 1） */
  fx: number;
  /** false = pi 没算出钱（无价目/免费模型/还没花钱），界面只显 token */
  priced: boolean;
  /** false = pi 的逐条成本分项全零（只拿得到总额），界面隐藏分项金额 */
  splitKnown: boolean;
  /** 缓存命中率 = cacheRead / (cacheRead + cacheWrite + input)，null = 一次输入都没有（新会话）。
   *  这是**唯一能一眼看出「缓存省了多少」的数**：DeepSeek 命中价差 50 倍，命中率 95% 和 50%
   *  的账单能差一个数量级。分母把 cacheWrite 算进「未命中」侧——写缓存本来就按未命中计费。 */
  cacheHitRate: number | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function buildUsage(input: {
  /** pi 的 stats.tokens */
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  /** pi 的 stats.cost（USD） */
  costTotal: number;
  /** pi 逐条 usage.cost 分项累加（USD） */
  costSplit: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
  currency: "usd" | "cny";
  /** 1 USD = ? CNY */
  fx: number;
}): UsageSummary {
  const t = input.tokens ?? {};
  const rate = input.currency === "cny" ? (num(input.fx) > 0 ? num(input.fx) : 1) : 1;
  const cs = input.costSplit ?? {};
  const splitSum = num(cs.input) + num(cs.output) + num(cs.cacheRead) + num(cs.cacheWrite);
  const total = num(input.costTotal);
  // 缓存命中率的分母 = 全部 prompt token（命中 + 未命中 + 写入）；都为 0 时给 null 而不是 0，
  // 让界面显示「—」——新会话显示 0% 会被误读成「缓存完全没生效」
  const promptTokens = num(t.cacheRead) + num(t.cacheWrite) + num(t.input);
  return {
    input: num(t.input),
    output: num(t.output),
    cacheRead: num(t.cacheRead),
    cacheWrite: num(t.cacheWrite),
    tokens: num(t.total) || num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite),
    costInput: num(cs.input) * rate,
    costOutput: num(cs.output) * rate,
    costCacheRead: num(cs.cacheRead) * rate,
    costCacheWrite: num(cs.cacheWrite) * rate,
    cost: total * rate,
    currency: input.currency,
    fx: rate,
    priced: total > 0,
    splitKnown: splitSum > 0,
    cacheHitRate: promptTokens > 0 ? num(t.cacheRead) / promptTokens : null,
  };
}
