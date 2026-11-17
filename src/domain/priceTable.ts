/**
 * 分时段价目表（2026-11-17 用户拍板「方案 A」：壳按时段价估算，让钱跟账单对得上）。
 *
 * 为什么要自己算钱了（此前口径是「pi 算的，壳只搬」）：
 *   pi 的 models 目录里每个模型只有**一套价**，而 DeepSeek 这类厂商按时段计价
 *   （官方表：高峰 输入¥2 / 缓存命中¥0.04 / 输出¥8；空闲 输入¥1 / 缓存命中¥0.02 / 输出¥4）。
 *   pi 目录里的价正好是**高峰价**，于是用户在空闲时段干活时，弹层/页脚显示的钱比账单贵一倍。
 *   实测对账（2026-11-16/17，本机台账 vs 平台账单，调用次数与 token 逐字节一致）：
 *     今天 08:52–08:58（61 次 / 13,207,373 tok）  空闲价 ¥0.601  ↔ 平台 ¥0.60
 *     昨天 18 时（293 次）                        空闲价 ¥4.65   ↔ 平台 ¥4.53
 *     昨天 19 时（69 次）                         空闲价 ¥0.62   ↔ 平台 ¥0.62
 *     昨天 09/10/11/14/15/16/17 时（390 次）      高峰价 ¥4.90   ↔ 平台残差 ¥4.91
 *   由此反解出厂商时段：**高峰 = 工作日 09:00–18:00，其余一律空闲**（可配，见下表）。
 *
 * 边界（刻意保留）：
 *   - 估算**不替代** pi 的台账：弹层里两个数都摆出来（pi 记账 = 对账锚点，时段估算 = 账单口径），
 *     页脚跟估算走（用户要的就是"看着对"）。
 *   - 表里查不到的模型不猜价：只统计 token，界面上标「无价目，未计」。
 *   - 桶按整点对齐（usage 按 model+小时聚合）：时段边界不在整点时，该小时按起始时刻判定。
 *     厂商的边界都是整点，够用；要精确到分钟得逐条重算，不值得。
 *
 * 零 import（webview 共享编译 / node 裸跑用例直接相对导入），纯函数无副作用。
 */

/** 一类 token 的单价：元 / 百万 token */
export interface PriceBand {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface ModelPrice {
  name?: string;
  /** 只有这两档；缺 offpeak 时按 peak 计价（单一价的模型也放得下） */
  peak: PriceBand;
  offpeak?: PriceBand;
}

export interface PriceTable {
  /** 峰谷时刻按哪个时区判定（默认 +480 = 北京时间） */
  utcOffsetMinutes: number;
  peak: {
    /** JS 的 getDay 口径：0=周日 … 6=周六 */
    weekdays: number[];
    /** "HH:MM" */
    from: string;
    to: string;
  };
  models: Record<string, ModelPrice>;
}

/** 用量桶：一个模型在一个整点内的四类 token（piClient 从 session entries 里聚合） */
export interface UsageBucket {
  model: string;
  /** 该小时的起点（epoch ms，已对齐整点） */
  hourStart: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface BandCost {
  cny: number;
  buckets: number;
}

export interface EstimateResult {
  /** 时段估算总额（元） */
  cny: number;
  peak: BandCost;
  offpeak: BandCost;
  /** 表里没有价目、因而没算钱的模型 id */
  unpriced: string[];
  /** 「此刻」落在哪一档（界面上一句话说明） */
  currentBand: "peak" | "offpeak";
}

/** 官方价目（2026-11-17 用户提供的 DeepSeek 价格表截图，元 / 百万 token） */
export function defaultPriceTable(): PriceTable {
  return {
    utcOffsetMinutes: 480,
    peak: { weekdays: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" },
    models: {
      "deepseek-flash": {
        name: "DeepSeek V4.1 Flash",
        peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
        offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
      },
      "deepseek-v4-pro": {
        name: "DeepSeek V4 Pro",
        peak: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
        offpeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
      },
    },
  };
}

/** 首次打开价目表时写进磁盘的模板（用户/agent 照着改就行，字段与上面一一对应） */
export const PRICE_TABLE_TEMPLATE = `${JSON.stringify(
  {
    version: 1,
    note: "分时段价目表：单价单位是「元 / 百万 token」。高峰 = weekdays 里的日子 from-to 之间，其余时间一律按 offpeak。换模型只需加一条；表里没有的模型不会被估价（界面标「无价目」）。",
    utcOffsetMinutes: 480,
    peak: { weekdays: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" },
    models: {
      "deepseek-flash": {
        name: "DeepSeek V4.1 Flash",
        peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
        offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
      },
      "deepseek-v4-pro": {
        name: "DeepSeek V4 Pro",
        peak: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
        offpeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
      },
    },
  },
  null,
  2,
)}\n`;

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function minutesOf(hhmm: string, fallback: number): number {
  const m = HHMM.exec(String(hhmm ?? "").trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

function bandOf(v: any, fallback: PriceBand): PriceBand {
  if (!v || typeof v !== "object") return fallback;
  const num = (x: unknown, d: number): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : d);
  return {
    input: num(v.input, fallback.input),
    cacheRead: num(v.cacheRead, fallback.cacheRead),
    cacheWrite: num(v.cacheWrite, fallback.cacheWrite),
    output: num(v.output, fallback.output),
  };
}

/**
 * 解析价目表文件。任何一处坏掉都**逐项回落内置值**，绝不抛：
 * 价目表是用户/agent 手写的东西，一个多余逗号不该把弹层打空。
 */
export function parsePriceTable(raw: string | null | undefined): PriceTable {
  const base = defaultPriceTable();
  if (!raw || !String(raw).trim()) return base;
  let obj: any;
  try {
    obj = JSON.parse(String(raw));
  } catch {
    return base;
  }
  if (!obj || typeof obj !== "object") return base;
  const tz = Number(obj.utcOffsetMinutes);
  const weekdays = Array.isArray(obj?.peak?.weekdays)
    ? obj.peak.weekdays.map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6)
    : base.peak.weekdays;
  const models: Record<string, ModelPrice> = { ...base.models };
  const src = obj.models;
  if (src && typeof src === "object") {
    for (const id of Object.keys(src)) {
      const m = src[id];
      if (!m || typeof m !== "object") continue;
      const peak = bandOf(m.peak, base.models[id]?.peak ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
      const offpeak = m.offpeak ? bandOf(m.offpeak, peak) : base.models[id]?.offpeak;
      models[id] = { name: typeof m.name === "string" ? m.name : base.models[id]?.name, peak, ...(offpeak ? { offpeak } : {}) };
    }
  }
  return {
    utcOffsetMinutes: Number.isFinite(tz) && Math.abs(tz) <= 840 ? tz : base.utcOffsetMinutes,
    peak: {
      weekdays: weekdays.length ? weekdays : base.peak.weekdays,
      from: HHMM.test(String(obj?.peak?.from ?? "")) ? String(obj.peak.from) : base.peak.from,
      to: HHMM.test(String(obj?.peak?.to ?? "")) ? String(obj.peak.to) : base.peak.to,
    },
    models,
  };
}

/** 把 epoch ms 换算成「表里那个时区」的本地时刻（getDay/getHours 依赖它） */
function localParts(tsMs: number, table: PriceTable): { day: number; minutes: number } {
  const d = new Date(tsMs + table.utcOffsetMinutes * 60000); // 用 UTC 取值 = 目标时区的本地值
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** 该时刻是否落在高峰档（工作日 && from ≤ t < to；from > to 表示跨零点的高峰区间） */
export function isPeak(tsMs: number, table: PriceTable): boolean {
  const { day, minutes: m } = localParts(tsMs, table);
  if (!table.peak.weekdays.includes(day)) return false;
  const from = minutesOf(table.peak.from, 540);
  const to = minutesOf(table.peak.to, 1080);
  return from <= to ? m >= from && m < to : m >= from || m < to;
}

function bandFor(model: string, peak: boolean, table: PriceTable): PriceBand | null {
  const mp = table.models[model];
  if (!mp) return null;
  if (peak) return mp.peak;
  return mp.offpeak ?? mp.peak;
}

function costOf(b: PriceBand, u: UsageBucket): number {
  return (
    ((u.input || 0) * b.input + (u.cacheRead || 0) * b.cacheRead + (u.cacheWrite || 0) * b.cacheWrite + (u.output || 0) * b.output) /
    1e6
  );
}

/**
 * 按桶估算（元）。`now` 只用来判断「此刻是高峰还是空闲」，给界面标一句话用。
 * 表里查不到的模型进 unpriced，一分钱都不猜（宁缺勿造是本仓一贯口径）。
 */
export function estimateCost(buckets: readonly UsageBucket[], table: PriceTable, now: number): EstimateResult {
  const out: EstimateResult = {
    cny: 0,
    peak: { cny: 0, buckets: 0 },
    offpeak: { cny: 0, buckets: 0 },
    unpriced: [],
    currentBand: isPeak(now, table) ? "peak" : "offpeak",
  };
  for (const u of buckets ?? []) {
    const model = String(u?.model ?? "");
    if (!model) continue;
    const peak = isPeak(Number(u.hourStart) || 0, table);
    const band = bandFor(model, peak, table);
    if (!band) {
      if (!out.unpriced.includes(model)) out.unpriced.push(model);
      continue;
    }
    const c = costOf(band, u);
    out.cny += c;
    const slot = peak ? out.peak : out.offpeak;
    slot.cny += c;
    slot.buckets += 1;
  }
  return out;
}
