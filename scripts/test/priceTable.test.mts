/**
 * 分时段价目表用例（2026-11-17 方案 A：壳按时段价估算，让钱跟账单对得上）。
 *
 * 锁的是四件容易写错的事：
 * ① 时段边界：高峰 = 工作日 09:00–18:00，其余一律空闲（含周末、含 18:00 整点那一刻）；
 * ② 内置价目 = DeepSeek 官方表（用户 2026-11-17 截图）：高峰 2/0.04/8，空闲 1/0.02/4；
 * ③ 文件坏掉（JSON 语法错/字段乱写）逐项回落内置，绝不抛——价目表是手写文件；
 * ④ **与真实账单对账**：把 2026-11-17 08:52–08:58 那 61 次调用的真实小时桶喂进去，
 *    必须得出 ¥0.601（平台实收 ¥0.60）；同样的桶按高峰价是 ¥1.202（pi 台账口径 ¥1.298）。
 *    这条用例是这次改动的存在理由，别删。
 *
 * 运行：npm run test:price（Node ≥23.6 原生跑 TS，零依赖，不进 tsc 门禁）
 */
import assert from "node:assert";
import {
  defaultPriceTable,
  estimateCost,
  isPeak,
  parsePriceTable,
  PRICE_TABLE_TEMPLATE,
  type UsageBucket,
} from "../../src/domain/priceTable.ts";

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n++;
  console.log("  ✓ " + name);
}

/** 北京时间 2026-11-17（周二）某时刻的 epoch ms */
function bj(y: number, mo: number, d: number, hh: number, mm = 0): number {
  return Date.UTC(y, mo - 1, d, hh, mm) - 8 * 3600000;
}

const T = defaultPriceTable();
/** 周一 ~ 周五 */
const MON = bj(2026, 11, 16, 12);
const TUE = bj(2026, 11, 17, 12);
const SAT = bj(2026, 11, 21, 12);

console.log("priceTable:");

ok("高潮时段边界：工作日 09:00–18:00 是高峰，其余（含周六）都是空闲", () => {
  assert.strictEqual(isPeak(bj(2026, 11, 17, 8, 59), T), false, "08:59 空闲");
  assert.strictEqual(isPeak(bj(2026, 11, 17, 9, 0), T), true, "09:00 整点算高峰");
  assert.strictEqual(isPeak(bj(2026, 11, 17, 17, 59), T), true, "17:59 还是高峰");
  assert.strictEqual(isPeak(bj(2026, 11, 17, 18, 0), T), false, "18:00 整点转空闲");
  assert.strictEqual(isPeak(bj(2026, 11, 17, 23, 30), T), false, "深夜空闲");
  assert.strictEqual(isPeak(MON, T), true, "周三是高峰");
  assert.strictEqual(isPeak(SAT, T), false, "周六全天空闲");
});

ok("时段按表里的 utcOffsetMinutes 判定，不跟宿主时区跑", () => {
  const tokyo = parsePriceTable(JSON.stringify({ ...T, utcOffsetMinutes: 540 })); // +09:00
  // 北京 09:30 = 东京 10:30：东京口径的高峰从北京 08:00 就开始了
  assert.strictEqual(isPeak(bj(2026, 11, 17, 8, 30), T), false);
  assert.strictEqual(isPeak(bj(2026, 11, 17, 8, 30), tokyo), true);
});

ok("内置价目 = 官方表（高峰 2/0.04/8，空闲 1/0.02/4）", () => {
  const f = T.models["deepseek-flash"];
  assert.deepStrictEqual(f.peak, { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 });
  assert.deepStrictEqual(f.offpeak, { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 });
});

ok("对账：2026-11-17 08:52–08:58 那 61 次调用（真实桶）→ 空闲价 ¥0.601 / 高峰价 ¥1.202", () => {
  // 真实数据：cr=13.0M, unc=0.21M, out=32K（13,207,373 tokens 与平台逐字节一致）
  const bucket: UsageBucket = {
    model: "deepseek-flash",
    hourStart: bj(2026, 11, 17, 8),
    input: 213000,
    cacheRead: 13000000,
    cacheWrite: 0,
    output: 32000,
  };
  const off = estimateCost([bucket], T, bj(2026, 11, 17, 9, 5));
  assert.ok(Math.abs(off.cny - 0.601) < 0.005, "空闲价 ≈ ¥0.601（平台实收 ¥0.60）: " + off.cny.toFixed(4));
  assert.strictEqual(off.peak.cny, 0);
  assert.strictEqual(off.currentBand, "peak", "此刻 09:05 是高峰（界面那句『当前时段』的判据）");
  // 同一个桶挪到 10:00 就是高峰价
  const peak = estimateCost([{ ...bucket, hourStart: bj(2026, 11, 17, 10) }], T, bj(2026, 11, 17, 10, 5));
  assert.ok(Math.abs(peak.cny - 1.202) < 0.005, "高峰价 ≈ ¥1.202: " + peak.cny.toFixed(4));
});

ok("多模型/多时段混算：主模型按时段，模型各归各的价", () => {
  const buckets: UsageBucket[] = [
    { model: "deepseek-flash", hourStart: bj(2026, 11, 17, 8), input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 },
    { model: "deepseek-flash", hourStart: bj(2026, 11, 17, 10), input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 },
    { model: "deepseek-v4-pro", hourStart: bj(2026, 11, 17, 10), input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 },
  ];
  const r = estimateCost(buckets, T, bj(2026, 11, 17, 10, 30));
  assert.strictEqual(r.offpeak.cny, 1, "空闲档 1M 输入 = ¥1");
  assert.strictEqual(r.peak.cny, 2 + 9, "高峰档 flash ¥2 + pro ¥9");
  assert.strictEqual(r.peak.buckets, 2);
});

ok("表里没有的模型不猜价：只进 unpriced，一分钱不算", () => {
  const r = estimateCost(
    [{ model: "mimo-v2.6-flash", hourStart: bj(2026, 11, 17, 10), input: 5e6, cacheRead: 5e6, cacheWrite: 0, output: 1e6 }],
    T,
    bj(2026, 11, 17, 10, 30),
  );
  assert.strictEqual(r.cny, 0);
  assert.deepStrictEqual(r.unpriced, ["mimo-v2.6-flash"]);
});

ok("坏文件逐项回落内置，绝不抛（手写文件的容错底线）", () => {
  assert.deepStrictEqual(parsePriceTable("{ 坏 JSON"), T);
  assert.deepStrictEqual(parsePriceTable(""), T);
  assert.deepStrictEqual(parsePriceTable(null), T);
  // 只有部分字段坏：好的一项要留下来，坏的那项回落
  const p = parsePriceTable(
    JSON.stringify({
      utcOffsetMinutes: "evil",
      peak: { weekdays: [0], from: "25:99", to: "18:00" },
      models: { "deepseek-flash": { peak: { input: 3 } } },
    }),
  );
  assert.strictEqual(p.utcOffsetMinutes, 480, "时区坏了回落 +08:00");
  assert.deepStrictEqual(p.peak.weekdays, [0], "合法 weekdays 要留下");
  assert.strictEqual(p.peak.from, "09:00", "非法时刻回落");
  assert.strictEqual(p.models["deepseek-flash"].peak.input, 3, "新价覆盖");
  assert.strictEqual(p.models["deepseek-flash"].peak.output, 8, "没写的分量沿用内置");
  assert.ok(p.models["deepseek-v4-pro"], "没提到的模型继续用内置");
});

ok("只给一套价的模型（无 offpeak）：两档都按 peak 计，不吃空值", () => {
  const t = parsePriceTable(JSON.stringify({ models: { foo: { peak: { input: 4, cacheRead: 1, cacheWrite: 0, output: 8 } } } }));
  const r = estimateCost([{ model: "foo", hourStart: bj(2026, 11, 17, 3), input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }], t, bj(2026, 11, 17, 3));
  assert.strictEqual(r.cny, 4, "空闲时刻也按 peak 的 ¥4");
});

ok("模板能被自己解析回来（⚙ 菜单建出来的文件必须是合法表）", () => {
  const t = parsePriceTable(PRICE_TABLE_TEMPLATE);
  assert.deepStrictEqual(t.models["deepseek-flash"].peak, defaultPriceTable().models["deepseek-flash"].peak);
  assert.strictEqual(t.peak.from, "09:00");
});

ok("跨零点的高峰区间（夜里贵、白天便宜）也能表达", () => {
  const t = parsePriceTable(JSON.stringify({ peak: { weekdays: [1, 2, 3, 4, 5], from: "22:00", to: "06:00" } }));
  assert.strictEqual(isPeak(bj(2026, 11, 17, 23, 0), t), true);
  assert.strictEqual(isPeak(bj(2026, 11, 17, 5, 0), t), true);
  assert.strictEqual(isPeak(bj(2026, 11, 17, 12, 0), t), false);
});

ok("空桶/脏桶不产生幻觉账", () => {
  const r = estimateCost([], T, TUE);
  assert.strictEqual(r.cny, 0);
  const dirty = estimateCost([{ model: "", hourStart: 0, input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }], T, TUE);
  assert.strictEqual(dirty.cny, 0, "没模型的桶不算钱");
});

console.log("priceTable: " + n + " passed");
