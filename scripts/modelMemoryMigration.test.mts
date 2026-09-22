// 模型/思考记忆用例（零依赖，C 刀重建——原文件随 P0 回滚删除，队列 C 行「记忆/迁移用例
// 同步重建」落此）。PiCore 私有方法经 out/piCore.js 直测（TS private 是编译期约束，运行时
// 可访问——原迁移用例同款姿势），桩 caps（getPersist/setPersist 内存表 + getCwd）。
// C 刀口径（2026-09-22 拍板 1）：记忆只认本页签，无记忆绝不动手——影子 "_" 是页签间
// 串扰源（t57 选 Free Models Router 经影子污染 t55，会话自带 MiMo 被覆写、上下文被重算
// 124% 触发压缩建议），读写两端都除名。迁移用例（B 刀）随后落此文件。
// 运行：npm run test:migration（先 npm run compile 产出 out/）
import { strict as assert } from "assert";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// @ts-ignore 编译产物
const { PiCore } = require("../out/piCore.js");

const WS = "d:\\work\\docs\\pi test\\pi-vscode";
const WSKEY = WS.replace(/\\+$/, "").toLowerCase();
const MODEL_A = { provider: "xiaomi", id: "MiMo-V2.6-Pro" };
const MODEL_B = { provider: "openrouter", id: "Free Models Router" };

function makeStore() {
  return {};
}
function makeCore(store: Record<string, unknown>, tabKey: string, cwd = WS) {
  const caps = {
    getPersist: (k: string, d: unknown) => (k in store ? store[k] : d),
    setPersist: (k: string, v: unknown) => {
      if (v === undefined) delete store[k];
      else store[k] = v;
    },
    getCwd: () => cwd,
  };
  const core = new PiCore(caps, {}, () => {}, "test");
  core.tabKey = tabKey;
  return core;
}

// 用例1：remember 只写本页签——影子 "_" 停写 + 遗留影子顺手清（写端除名）
{
  const store = makeStore();
  const core = makeCore(store, "t55");
  core.rememberModel(MODEL_A);
  core.rememberThinking("high");
  const map = store["piChat.lastModelByWs2"][WSKEY];
  assert.deepEqual(map["t55"], MODEL_A, "应写入本页签");
  assert.ok(!("_" in map), "影子 _ 不应存在（停写 + 清遗留）");
  const tmap = store["piChat.lastThinkingByWs2"][WSKEY];
  assert.equal(tmap["t55"], "high", "思考等级应写入本页签");
  assert.ok(!("_" in tmap), "思考影子 _ 不应存在");
  console.log("用例1 记忆只写本页签、影子停写并清遗留 ✅");
}
// 用例2：读端不兜底影子——无本页签记忆返回 undefined，即使 "_" 有值（t55 实锤回归）
{
  const store: Record<string, unknown> = {
    "piChat.lastModelByWs2": { [WSKEY]: { _: MODEL_B } },
    "piChat.lastThinkingByWs2": { [WSKEY]: { _: "high" } },
  };
  const core = makeCore(store, "t55");
  assert.equal(core.lastModelFor(), undefined, "影子值不得兜底（无记忆不动手）");
  assert.equal(core.lastThinkingFor(), undefined, "思考影子同款");
  console.log("用例2 影子兜底已除名（无记忆不动手）✅");
}
// 用例3：本页签记忆正常读写（正向）
{
  const store = makeStore();
  makeCore(store, "t55").rememberModel(MODEL_A);
  makeCore(store, "t55").rememberThinking("medium");
  const again = makeCore(store, "t55");
  assert.deepEqual(again.lastModelFor(), MODEL_A, "本页签模型记忆应还原");
  assert.equal(again.lastThinkingFor(), "medium", "本页签思考记忆应还原");
  console.log("用例3 本页签记忆读写正常 ✅");
}
// 用例4：页签间互不串——t55 的记忆不被 t57 读到/覆写
{
  const store = makeStore();
  makeCore(store, "t55").rememberModel(MODEL_A);
  const other = makeCore(store, "t57");
  assert.equal(other.lastModelFor(), undefined, "t57 不得读到 t55 的记忆");
  other.rememberModel(MODEL_B);
  assert.deepEqual(makeCore(store, "t55").lastModelFor(), MODEL_A, "t55 记忆不被 t57 覆写");
  console.log("用例4 页签间零串扰 ✅");
}
// 用例5：跨工作区不串（二维键工作区维度，同 tabKey 也不撞）
{
  const store = makeStore();
  makeCore(store, "t55").rememberModel(MODEL_A);
  const foreign = makeCore(store, "t55", "d:\\other\\project");
  assert.equal(foreign.lastModelFor(), undefined, "跨工作区不得串");
  console.log("用例5 跨工作区零串扰 ✅");
}
console.log("modelMemory（C 刀口径）用例全过 ✅");
