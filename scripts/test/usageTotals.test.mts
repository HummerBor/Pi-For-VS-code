/**
 * usageTotals 用例（2026-11-05，用户三轮纠偏后的口径：pi 算的，壳只搬）。
 *
 * 打的是「壳不许自己算钱」这条红线：
 * ① token/合计原样透传 pi 的值（不重算、不归一）；
 * ② 分项金额 = pi 逐条 usage.cost 的累加值，**故意让分项和 ≠ 总额时也保持原样**
 *    （一旦归一，就变成壳在造 pi 的数——这正是用户上一次否掉的做法）；
 * ③ 货币换算只乘汇率：cny 乘 fx、usd 恒 1，非法汇率兜底 1；
 * ④ 缺省语义：pi 没算出钱 → priced=false（界面只显 token）；分项全零 → splitKnown=false。
 *
 * 运行：npm run test:usage（Node ≥23.6 原生跑 TS，零依赖，不进 tsc 门禁）
 */
import assert from "node:assert";
import { buildUsage, deriveUnitPrices } from "../../src/domain/usageTotals.ts";

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n++;
  console.log("  ✓ " + name);
}

const TOK = { input: 182400, output: 24800, cacheRead: 1288000, cacheWrite: 96400, total: 1591600 };
const SPLIT = { input: 0.5472, output: 0.372, cacheRead: 0.1288, cacheWrite: 0.2892 };
const TOTAL = 0.5; // 与分项和刻意不等：模拟 pi 只给得出总额的情形（实付/档位价）

console.log("usageTotals:");

ok("token 原样透传（不重算）", () => {
  const u = buildUsage({ tokens: TOK, costTotal: TOTAL, costSplit: SPLIT, currency: "usd", fx: 1 });
  assert.deepStrictEqual([u.input, u.output, u.cacheRead, u.cacheWrite, u.tokens], [182400, 24800, 1288000, 96400, 1591600]);
});

ok("合计 = pi 的 cost（不归一、不与分项和调和）", () => {
  const u = buildUsage({ tokens: TOK, costTotal: TOTAL, costSplit: SPLIT, currency: "usd", fx: 1 });
  assert.strictEqual(u.cost, TOTAL);
});

ok("分项金额 = pi 逐条累加值（和 ≠ 总额也照原样）", () => {
  const u = buildUsage({ tokens: TOK, costTotal: TOTAL, costSplit: SPLIT, currency: "usd", fx: 1 });
  assert.strictEqual(u.costInput, SPLIT.input);
  assert.strictEqual(u.costOutput, SPLIT.output);
  assert.strictEqual(u.costCacheRead, SPLIT.cacheRead);
  assert.strictEqual(u.costCacheWrite, SPLIT.cacheWrite);
  assert.strictEqual(u.splitKnown, true);
});

ok("元：所有金额乘汇率（只换单位，不改数）", () => {
  const u = buildUsage({ tokens: TOK, costTotal: TOTAL, costSplit: SPLIT, currency: "cny", fx: 7.2 });
  assert.strictEqual(u.currency, "cny");
  assert.strictEqual(u.fx, 7.2);
  assert.strictEqual(u.cost, TOTAL * 7.2);
  assert.strictEqual(u.costCacheRead, SPLIT.cacheRead * 7.2);
});

ok("美元：汇率恒 1（配置里有汇率也不影响）", () => {
  const u = buildUsage({ tokens: TOK, costTotal: TOTAL, costSplit: SPLIT, currency: "usd", fx: 7.2 });
  assert.strictEqual(u.fx, 1);
  assert.strictEqual(u.cost, TOTAL);
});

ok("非法汇率兜底 1（0/NaN 不产生 ¥0 假账）", () => {
  for (const bad of [0, -3, NaN, Infinity]) {
    const u = buildUsage({ tokens: TOK, costTotal: TOTAL, costSplit: SPLIT, currency: "cny", fx: bad });
    assert.strictEqual(u.fx, 1, "坏汇率应兜底 1");
    assert.strictEqual(u.cost, TOTAL);
  }
});

ok("pi 没算出钱 → priced=false（界面只显 token）", () => {
  const u = buildUsage({ tokens: TOK, costTotal: 0, costSplit: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, currency: "cny", fx: 7.2 });
  assert.strictEqual(u.priced, false);
  assert.strictEqual(u.splitKnown, false);
  assert.strictEqual(u.tokens, 1591600);
});

ok("只有总额没有分项 → splitKnown=false（隐藏分项金额）", () => {
  const u = buildUsage({ tokens: TOK, costTotal: TOTAL, costSplit: null, currency: "cny", fx: 7.2 });
  assert.strictEqual(u.priced, true);
  assert.strictEqual(u.splitKnown, false);
  assert.strictEqual(u.costInput, 0);
});

ok("脏数据不污染：NaN/缺字段按 0", () => {
  const u = buildUsage({
    tokens: { input: NaN as unknown as number, cacheRead: 10 },
    costTotal: NaN as unknown as number,
    costSplit: { input: "x" as unknown as number },
    currency: "cny",
    fx: 7.2,
  });
  assert.deepStrictEqual([u.input, u.output, u.cacheRead, u.cacheWrite, u.tokens], [0, 0, 10, 0, 10]);
  assert.strictEqual(u.cost, 0);
  assert.strictEqual(u.priced, false);
});

// 缓存命中率（2026-11-05 用户要）：命中 /（命中 + 写入 + 未命中）。写入算未命中侧——
// 写缓存本来就按未命中计费，把它算成命中会让命中率虚高、与账单走势相反。
ok("缓存命中率 = cacheRead / (cacheRead + cacheWrite + input)", () => {
  const u = buildUsage({ tokens: TOK, costTotal: TOTAL, costSplit: SPLIT, currency: "usd", fx: 1 });
  const want = 1288000 / (1288000 + 96400 + 182400);
  assert.strictEqual(u.cacheHitRate, want);
  assert.ok(Math.abs(u.cacheHitRate! - 0.8219) < 0.001, "约 82.2%（1288000/1566800）");
});

ok("缓存命中率：没有任何输入时为 null（界面显示「—」，不是 0%）", () => {
  const u = buildUsage({
    tokens: { input: 0, output: 120, cacheRead: 0, cacheWrite: 0, total: 120 },
    costTotal: 0,
    costSplit: null,
    currency: "cny",
    fx: 7.2,
  });
  assert.strictEqual(u.cacheHitRate, null);
});

ok("缓存命中率：全命中也算 100%、全未命中算 0%（不除零、不 NaN）", () => {
  const allHit = buildUsage({
    tokens: { input: 0, output: 1, cacheRead: 5000, cacheWrite: 0, total: 5001 },
    costTotal: 0,
    costSplit: null,
    currency: "usd",
    fx: 1,
  });
  assert.strictEqual(allHit.cacheHitRate, 1);
  const allMiss = buildUsage({
    tokens: { input: 5000, output: 1, cacheRead: 0, cacheWrite: 0, total: 5001 },
    costTotal: 0,
    costSplit: null,
    currency: "usd",
    fx: 1,
  });
  assert.strictEqual(allMiss.cacheHitRate, 0);
});

ok("反推单价：用本会话用量算出 USD/百万 token（标签与金额同源）", () => {
  // 2026-11-16 事故真实取值：deepseek-flash 一次会话累计
  const p = deriveUnitPrices(
    { input: 251000, output: 49000, cacheRead: 4131000, cacheWrite: 0 },
    { input: 0.07517, output: 0.05877, cacheRead: 0.02479, cacheWrite: 0 },
  )!;
  assert.ok(p, "有分项金额就必须算得出来");
  assert.ok(Math.abs(p.input - 0.2995) < 0.002, "输入≈0.3 USD/M（deepseek-flash 目录价）");
  assert.ok(Math.abs(p.cacheRead - 0.006) < 0.0005, "缓存命中≈0.006 USD/M");
  assert.ok(Math.abs(p.output - 1.1994) < 0.005, "输出≈1.2 USD/M");
  assert.strictEqual(p.cacheWrite, 0, "没有缓存写入 token 时分量为 0，不除零、不 NaN");
});

ok("反推单价：无分项金额/全零时返回 null（调用方退回目录价或隐藏）", () => {
  assert.strictEqual(deriveUnitPrices({ input: 100 }, null), null);
  assert.strictEqual(
    deriveUnitPrices({ input: 100 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    null,
  );
});

console.log("usageTotals: " + n + " passed");
