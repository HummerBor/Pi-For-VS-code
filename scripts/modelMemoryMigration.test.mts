// 迁移用例（零依赖）：PiCore.migrateLegacyModelMemory 私有方法经 out/piCore.js 直测，
// 桩掉 caps（getPersist/setPersist 内存表 + getCwd）。覆盖：旧键迁移/新键已存在不覆盖/无旧键只打标记。
import { strict as assert } from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// @ts-ignore 编译产物
const { PiCore } = require("../out/piCore.js");

const WS = "d:\\work\\docs\\pi test\\pi-vscode";
function makeCore(store) {
  const caps = {
    getPersist: (k, d) => (k in store ? store[k] : d),
    setPersist: (k, v) => { if (v === undefined) delete store[k]; else store[k] = v; },
    getCwd: () => WS,
  };
  const ui = {};
  const post = () => {};
  const core = new PiCore(caps, ui, post, "test");
  core.tabKey = "t1";
  return core;
}
const MODEL = { provider: "openrouter", id: "@preset/5-3falsh" };

// 用例1：旧扁平键 → 种进当前工作区（t1 + 影子 "_"），旧键删净，标记落
{
  const store = {
    "piChat.lastModel.t1": MODEL,
    "piChat.lastThinking.t1": "high",
  };
  const core = makeCore(store);
  core.migrateLegacyModelMemory();
  const map = store["piChat.lastModelByWs2"];
  assert.equal(map[WS]["t1"].id, "@preset/5-3falsh", "t1 应种入旧模型");
  assert.equal(map[WS]["_"].id, "@preset/5-3falsh", "影子 _ 应种入旧模型");
  assert.equal(store["piChat.lastThinkingByWs2"][WS]["t1"], "high", "思考等级应种入");
  assert.ok(store["piChat.modelMigratedV2"] === true, "迁移标记应落");
  assert.ok(!("piChat.lastModel.t1" in store) && !("piChat.lastModel" in store), "旧键应删净");
  assert.ok(!("piChat.lastThinking.t1" in store), "旧思考键应删净");
  console.log("用例1 旧键完整迁移 + 删净 ✅");
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
  assert.equal(map[WS]["_"].id, "deepseek/deepseek-v4.1-flash", "影子缺失时用新键值补（旧值不抢）");
  assert.ok(!("piChat.lastModel.t1" in store), "旧键仍应删净");
  console.log("用例2 新键优先、旧键删净 ✅");
}
// 用例3：无旧键 → 只打标记，不新增页签条目（影子 "_" 从当前页签兑底属合理语义，与 rememberModel 写入口径一致）
{
  const store = { "piChat.lastModelByWs2": { [WS]: { t1: MODEL } } };
  const core = makeCore(store);
  core.migrateLegacyModelMemory();
  assert.ok(store["piChat.modelMigratedV2"] === true);
  const map = store["piChat.lastModelByWs2"][WS];
  assert.equal(map["t1"].id, "@preset/5-3falsh", "已有条目不应被动");
  assert.equal(map["_"].id, "@preset/5-3falsh", "影子缺失时从当前页签兑底");
  console.log("用例3 无旧键只打标记 + 影子兑底 ✅");
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
// 用例5：多页签旧键各归各位（t2 的记忆进 t2，不串）
{
  const store = {
    "piChat.lastModel.t1": MODEL,
    "piChat.lastModel.t2": { provider: "p2", id: "m2" },
  };
  const core = makeCore(store);
  core.migrateLegacyModelMemory();
  const map = store["piChat.lastModelByWs2"][WS];
  assert.equal(map["t2"].id, "m2", "t2 旧记忆应归 t2");
  assert.equal(map["t1"].id, "@preset/5-3falsh");
  console.log("用例5 多页签各归各位 ✅");
}
console.log("迁移用例全过 ✅");
