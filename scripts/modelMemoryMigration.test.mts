// 迁移用例（零依赖）：PiCore.migrateLegacyModelMemory 私有方法经 out/piCore.js 直测，
// 桩掉 caps（getPersist/setPersist 内存表 + getCwd）。影子 "_" 已去除（用户拍板 2026-09-22：
// 同工作区页签间也不串），断言按新语义：每页签只种自己的旧键，全局旧键不种只删。
import { strict as assert } from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// @ts-ignore 编译产物
const { PiCore } = require("../out/piCore.js");

const WS = "d:\\work\\docs\\pi test\\pi-vscode";
function makeCore(store, tabKey = "t1") {
  const caps = {
    getPersist: (k, d) => (k in store ? store[k] : d),
    setPersist: (k, v) => { if (v === undefined) delete store[k]; else store[k] = v; },
    getCwd: () => WS,
  };
  const core = new PiCore(caps, {}, () => {}, "test");
  core.tabKey = tabKey;
  return core;
}
const MODEL = { provider: "openrouter", id: "@preset/5-3falsh" };

// 用例1：旧扁平键 → 种进当前工作区（各归各位），旧键删净，标记落，无影子 "_"
{
  const store = { "piChat.lastModel.t1": MODEL, "piChat.lastThinking.t1": "high" };
  const core = makeCore(store);
  core.migrateLegacyModelMemory();
  const map = store["piChat.lastModelByWs2"];
  assert.equal(map[WS]["t1"].id, "@preset/5-3falsh", "t1 应种入旧模型");
  assert.ok(!("_" in map[WS]), "不应再种影子 _");
  assert.equal(store["piChat.lastThinkingByWs2"][WS]["t1"], "high", "思考等级应种入");
  assert.ok(store["piChat.modelMigratedV2"] === true, "迁移标记应落");
  assert.ok(!("piChat.lastModel.t1" in store) && !("piChat.lastModel" in store), "旧键应删净");
  console.log("用例1 旧键完整迁移 + 删净 + 无影子 ✅");
}
// 用例2：新键已有值 → 不覆盖（用户重选过），旧键仍删净
{
  const NEWER = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" };
  const store = {
    "piChat.lastModel.t1": MODEL,
    "piChat.lastModelByWs2": { [WS]: { t1: NEWER } },
  };
  const core = makeCore(store);
  core.migrateLegacyModelMemory();
  const map = store["piChat.lastModelByWs2"];
  assert.equal(map[WS]["t1"].id, "deepseek/deepseek-v4.1-flash", "新键已存在不应被旧值覆盖");
  assert.ok(!("piChat.lastModel.t1" in store), "旧键仍应删净");
  console.log("用例2 新键优先、旧键删净 ✅");
}
// 用例3：无旧键 → 只打标记，不动新键（含全局旧键不种）
{
  const store = { "piChat.lastModelByWs2": { [WS]: { t1: MODEL } }, "piChat.lastModel": MODEL };
  const core = makeCore(store);
  core.migrateLegacyModelMemory();
  assert.ok(store["piChat.modelMigratedV2"] === true);
  const map = store["piChat.lastModelByWs2"][WS];
  assert.equal(Object.keys(map).length, 1, "全局旧键不应种入（无页签维度，语义已随影子去除）");
  assert.ok(!("piChat.lastModel" in store), "全局旧键应删净");
  console.log("用例3 无旧键只打标记 + 全局键不种只删 ✅");
}
// 用例4：幂等 —— 第二次调用不再动任何东西
{
  const store = { "piChat.lastModel.t1": MODEL };
  const core = makeCore(store);
  core.migrateLegacyModelMemory();
  const snapshot1 = JSON.stringify(store);
  core.migrateLegacyModelMemory();
  assert.equal(JSON.stringify(store), snapshot1, "二次迁移应零变化");
  console.log("用例4 幂等 ✅");
}
// 用例5：高位页签号（用户实测 t38-t40，旧实现只扫 t1..t20 漏迁）各归各位
{
  const store = {
    "piChat.lastModel.t39": MODEL,
    "piChat.lastModel.t40": { provider: "openrouter", id: "openrouter/free" },
  };
  const core = makeCore(store, "t39");
  core.migrateLegacyModelMemory();
  const map = store["piChat.lastModelByWs2"][WS];
  assert.equal(map["t39"].id, "@preset/5-3falsh", "t39 旧记忆应归 t39");
  assert.equal(map["t40"].id, "openrouter/free", "t40 旧记忆应归 t40");
  console.log("用例5 高位页签号（t38-t40）各归各位 ✅");
}
// 用例6：全局旧键不再兜底 —— 只有全局键、无页签旧键时，页签记忆为空（pi 默认兑底）
{
  const store = { "piChat.lastModel": MODEL, "piChat.lastThinking": "high" };
  const core = makeCore(store, "t39");
  core.migrateLegacyModelMemory();
  const map = store["piChat.lastModelByWs2"]?.[WS] ?? {};
  assert.ok(!map["t39"], "全局键不应种到页签");
  assert.ok(!("piChat.lastModel" in store), "全局键应删净");
  console.log("用例6 全局键不兜底 ✅");
}
console.log("迁移用例全过 ✅");
