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
 * 货币（2026-11-16 用户拍板）：**页脚恒为美元、弹层恒为人民币估算**。两处不再跟随
 * 设置里的币种开关（piChat.costCurrency 已退役）：页脚跟 pi 原生 TUI 状态行的 $ 对齐
 * （同一个数、同一个符号，省得用户两边对账），弹层里按用户可改的汇率（piChat.usdCnyRate，
 * 默认 7.2）折成人民币并标注「估算」——那不是账单，账单要看服务商控制台。
 * 本文件只做「单位换算 + 缺省兜底」，不参与金额计算。
 * 纯函数零 import（webview 共享编译 / node 裸跑用例两处都要能用）。
 */

/** 单价（USD / 百万 token）。四个分量分开算，因为它们的价差可达 50 倍（缓存命中 vs 未命中）。 */
export interface UnitPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 由**本会话实际用量**反推成交单价，而不是去读「当前模型」的目录价。
 *
 * 为什么必须反推（2026-11-16 事故）：弹层的「pi 价目」行原先取 `session.model.cost`（当前模型），
 * 而「用量与花费」的金额是**每条 usage 记录按它当时的价目算好后累加**的。两者一旦不同源就会
 * 自相矛盾——用户实测那一屏标签写 MiMo ¥1.01/M，金额却只有按 deepseek ¥2.16/M 才算得出
 * （会话 19:00:31 以默认模型 MiMo 起、19:00:34 切 deepseek，价目缓存的刷新事件赶在宿主接线
 * 之前，停在了旧模型）。反推之后标签与金额永远是同一套数，也不再依赖 model_select 的时序。
 *
 * 返回 null = 没有分项金额（免费模型/无价目），调用方据此退回目录价或隐藏这一行。
 */
export function deriveUnitPrices(
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  costSplit: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null,
): UnitPrices | null {
  if (!costSplit) return null;
  const sum = num(costSplit.input) + num(costSplit.output) + num(costSplit.cacheRead) + num(costSplit.cacheWrite);
  if (sum <= 0) return null;
  const perM = (cost: unknown, tok: unknown): number => {
    const t = num(tok);
    return t > 0 ? (num(cost) / t) * 1e6 : 0;
  };
  return {
    input: perM(costSplit.input, tokens.input),
    output: perM(costSplit.output, tokens.output),
    cacheRead: perM(costSplit.cacheRead, tokens.cacheRead),
    cacheWrite: perM(costSplit.cacheWrite, tokens.cacheWrite),
  };
}

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
