// 环境差对照探针（2026-09-23）：为什么 createAgentSessionServices 终端/裸进程 0.2s、
// 扩展宿主 0.2~10s 抖动。同一进程内模拟三种环境：
//   A 闲（基线）          = 终端 pi / 裸进程
//   B 事件洪水（同进程）  = 扩展宿主正在流式（token delta 风暴：每事件 stringify+append+序列化）
//   C async_hooks 挂钩    = 有扩展/遥测开了 Promise 追踪（每个 async 初始化征税）
// 若 B 或 C 把耗时推到秒级 → 扩展宿主抖动的机制就是它。
// 用法：node scripts/probe-env-contention.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const { loadPiSdk } = require("../out/piSdk.js");
const sdk = await loadPiSdk();
const cwd = "d:/work/docs/pi test/pi-vscode";

async function timeServices(tag) {
  const t = Date.now();
  await sdk.createAgentSessionServices({ cwd });
  console.log(tag, Date.now() - t + "ms");
}

// A 基线（跑两遍取热值）
await timeServices("A1 闲:");
await timeServices("A2 闲:");

// B 事件洪水：模拟流式 token delta 处理链（msgBrief 级 stringify + 拼接 + 定时器高频）
let floodOn = true;
let acc = 0;
const flood = setInterval(() => {
  // 每 tick 处理 ~200 个事件的等价开销：字符串化 + 搜索 + 累积
  for (let i = 0; i < 200; i++) {
    const s = JSON.stringify({ t: "message_update", i, text: "token-delta-" + i, ci: acc });
    acc += s.length;
    if (s.indexOf("never") >= 0) acc++;
  }
}, 1);
await timeServices("B  洪水:");
clearInterval(flood);
floodOn = false;

// C async_hooks 空钩（只要 enable，每个 Promise/async 初始化都过钩）
const ah = require("node:async_hooks");
let inits = 0;
const hook = ah.createHook({ init() { inits++; } });
hook.enable();
await timeServices("C  hooks:");
hook.disable();
console.log("(hook init 次数:", inits + ")");
