/**
 * 状态行归属回归（t42，2026-11-19）。
 *
 * 事故：状态行的「本轮用时冻结值」活不过一帧。全收尾时 setBusy(false) 把 fmtDur() 的纯时长
 * （83s / 1m03s）写进 #status，紧随其后的 refreshState「state」帧走 applyState，里面用
 * `statusEl.textContent.indexOf('⏱') !== 0` 判「这行是不是临时状态」——冻结值不带 ⏱ 前缀 →
 * 被判成临时状态擦掉。修法：显式状态 statusKind（'' / temp / busy / frozen / compacting），
 * applyState 只清 temp，其余归属一律锁。
 *
 * 为什么这里能真跑 DOM 行为：webview 功能模块是「查元素 + 写文本」的老实代码，不需要真 DOM，
 * 给一组假元素（textContent / classList / style）就够。statusBar.ts 的 import 是
 * `../core/state`、`./tabs` 这种无扩展名相对路径（vite 口径），Node 直跑需要一层 resolve 钩子
 * 补 .ts —— 钩子是本文件唯一的脚手架，用例本身打的是真实 initStatusBar。
 *
 * 运行：npm run test:statusbar（Node ≥23.6 原生跑 TS，零依赖）
 */
import assert from "node:assert";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── 无扩展名相对 import → 补 .ts（vite 口径，Node ESM 不做扩展名猜测）──
module.registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && !/\.[cm]?[jt]s$/.test(spec)) {
      const cand = new URL(spec + ".ts", ctx.parentURL);
      if (fs.existsSync(fileURLToPath(cand))) return { url: cand.href, format: "module-typescript", shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

// ── 假元素 ──
function fakeEl() {
  const cls = new Set();
  return {
    textContent: "",
    title: "",
    innerHTML: "",
    style: {},
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
    },
    has: (c) => cls.has(c),
    appendChild() {},
    onclick: null,
  };
}

const els = new Map();
const q = (sel) => {
  if (!els.has(sel)) els.set(sel, fakeEl());
  return els.get(sel);
};

// ── 假依赖（只喂状态行用得到的那几个读写口）──
const L = {
  compacting: "压缩中…",
  queuedCount: " (+{n})",
  turnDuration: "本轮用时",
  thinkLabel: "思考 ",
  modelTitleCur: "当前模型 {v}",
  switchModel: "切模型",
  sessionLabel: "会话：",
  curSession: "当前会话：",
  clickSwitchSession: "点击切换会话",
  clickPickSession: "点击选择会话",
  startingSession: "新会话",
  startingPi: "正在启动 pi…",
};
let compactingFlag = false;
let bootingFlag = false;
const S = { busy: false };

const { initStatusBar } = await import(pathToFileURL(path.join(root, "webview/features/statusBar.ts")).href);

const bar = initStatusBar({
  viewId: "t42",
  q,
  state: S,
  lang: L,
  ico: () => "",
  esc: (s) => String(s),
  post: () => {},
  postPage: () => {},
  getSessionEl: () => q("#session"),
  subDock: { runsOf: () => [], anyLive: () => false },
  changesPage: { open: () => {} },
  ctxPop: { refreshUsage: () => {} },
  finalizeLive: () => {},
  liveReset: () => {},
  getQueueN: () => 0,
  getCompacting: () => compactingFlag,
  setCompactingFlag: (v) => { compactingFlag = v; },
  getBooting: () => bootingFlag,
  setBootingFlag: (v) => { bootingFlag = v; },
  getModeText: () => "",
});

const statusEl = q("#status");
// 真值 state 帧（booting 缺省 = 启动已结束）
const stateFrame = () => bar.applyState({ model: { id: "m", name: "m" }, thinkingLevel: "high", stats: {} });

console.log("状态行冻结值 vs state 帧：");
// 一轮跑满 83s 后全收尾 → 冻结值 = 1m23s（与走秒同基准 busyStart）
bar.setBusy(true, 83000);
bar.setBusy(false);
ok("全收尾上屏冻结用时（纯时长，无前缀）", statusEl.textContent === "1m23s", `实际 ${JSON.stringify(statusEl.textContent)}`);
ok("冻结态挂 .done（白字）", statusEl.has("done"));
for (let i = 0; i < 3; i++) stateFrame();
ok("连续 3 个 state 帧不清冻结值", statusEl.textContent === "1m23s", `实际 ${JSON.stringify(statusEl.textContent)}`);
ok("清完仍是冻结态（.done 未丢）", statusEl.has("done"));

console.log("\n新轮清零 + 临时状态可清：");
bar.setBusy(true);
ok("setBusy(true) 后状态行换成 Working（冻结值不再占位）", /Working…/.test(statusEl.textContent), `实际 ${JSON.stringify(statusEl.textContent)}`);
bar.setBusy(false);
ok("新轮收尾重新冻结（不是上一轮的 1m23s）", statusEl.textContent === "0s", `实际 ${JSON.stringify(statusEl.textContent)}`);
bar.setStatus("临时状态：正在读文件");
stateFrame();
ok("临时状态（temp 归属）仍被 state 帧清掉", statusEl.textContent === "", `实际 ${JSON.stringify(statusEl.textContent)}`);
bar.setStatus("另一个临时状态");
stateFrame();
stateFrame();
ok("连续 state 帧清临时状态不反复抖动", statusEl.textContent === "");

console.log("\n压缩标签（既有行为不许退）：");
compactingFlag = false;
bar.setBusy(false); // 归到空闲收尾态，再开压缩窗口（模拟手动压缩：空闲会话里的 RPC 调用）
bar.setCompacting(true);
ok("压缩中标出压缩标签", statusEl.textContent === "⏳ " + L.compacting, `实际 ${JSON.stringify(statusEl.textContent)}`);
stateFrame();
stateFrame();
ok("state 帧不清压缩标签", statusEl.textContent === "⏳ " + L.compacting, `实际 ${JSON.stringify(statusEl.textContent)}`);
bar.setBusy(false, 83000); // 压缩期间被 preflight 拒收 → busy:false 且带实测耗时
ok("busy:false 也不清压缩标签（renderBusyUi 压缩分支）", statusEl.textContent === "⏳ " + L.compacting, `实际 ${JSON.stringify(statusEl.textContent)}`);
stateFrame();
ok("压缩中连续刷新仍是压缩标签（不回退成冻结用时）", statusEl.textContent === "⏳ " + L.compacting, `实际 ${JSON.stringify(statusEl.textContent)}`);


console.log("\n冻结态 → 手动压缩 → 回冻结（工单42 残留 3b）：");
// 事故：.done 只在 busy 分支被摘，所以「本轮冻结态 → 用户手动点压缩」时元素同时挂
// .done + .busy，压缩提示被白字/加粗盖住，看着像「已完成」。修法：class 也归 writeStatus。
compactingFlag = false;
bootingFlag = false;
bar.setBusy(true, 83000);
bar.setBusy(false);
ok("前置：冻结态只挂 .done（无 .busy）", statusEl.has("done") && !statusEl.has("busy"));
bar.setCompacting(true);
ok("进入压缩：.done 被摘掉", !statusEl.has("done"));
ok("进入压缩：.busy 在（压缩沿用忙态视觉）", statusEl.has("busy"));
ok("进入压缩：文字是压缩提示", statusEl.textContent === "⏳ " + L.compacting, `实际 ${JSON.stringify(statusEl.textContent)}`);
compactingFlag = false;
bar.setBusy(false, 83000); // 压缩结束：宿主发 busy:false，renderBusyUi 回渲染冻结值
ok("压缩结束回冻结：.done 回来", statusEl.has("done"));
ok("压缩结束回冻结：busy 类被摘掉", !statusEl.has("busy"));
ok("压缩结束回冻结：文字回到本轮用时", statusEl.textContent === "1m23s", `实际 ${JSON.stringify(statusEl.textContent)}`);
bar.setStatus("临时状态：正在读文件");
ok("临时状态既不挂 .done 也不挂 .busy", !statusEl.has("done") && !statusEl.has("busy"));

bar.dispose();

// ── 源码口径守卫：不许留下文本嗅探（t42 的根因）──
const src = fs.readFileSync(path.join(root, "webview/features/statusBar.ts"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sniff = "indexOf('" + String.fromCharCode(0x23f1) + "')";
console.log("\n文本嗅探残留：");
ok("代码里不再用文本前缀判断状态行归属", code.indexOf(sniff) === -1);
ok("applyState 的清状态改判显式状态 statusKind", /statusKind === 'temp'/.test(code));
// 3b：class 归属收口到唯一写口 writeStatus —— 外面（含 applyState / renderBusyUi / setCompacting）
// 一句裸 classList.add/remove('done'|'busy') 都不许有，否则又会出现 .done + .busy 同挂
const wsAt = code.indexOf("function writeStatus");
const wsEnd = code.indexOf("function setStatus");
const outsideWs = code.slice(0, wsAt) + code.slice(wsEnd);
const wsBody = code.slice(wsAt, wsEnd);
console.log("\n状态行 class 归属：");
ok("writeStatus 抽到（守卫定位点有效）", wsAt > 0 && wsEnd > wsAt);
ok("writeStatus 之外零裸写 .done/.busy", !/classList\.(add|remove)\(['"](done|busy)['"]/.test(outsideWs));
ok("摘 class 在写口内（每次写入先全摘再按 kind 挂）", /classList\.remove\('done'\)/.test(wsBody) && /classList\.remove\('busy'\)/.test(wsBody));

console.log("\nstatusBar: " + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
