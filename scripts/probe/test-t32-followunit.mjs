// 工单32 独立验收补充探针（TEST-t32 §二）——只测不修，测试方自写。
// 覆盖：① switchSession force 短路绕过（编译产物读码 + prototype.call 运行时双证）
//       ② followTick active 判定三分支（registry / delta+quiet / 双假）+ 变小/静默变体
//       ③ piCore.onExternalState 解锁时序（delta>0 不发解锁）+ onExternalRelease 重入锁
//       ④ 门禁 throw 文案在编译产物里的落点（3 处）；markOwnWrite 1.5s 本地窗口 rebase
//       ⑤ _resetExternalWritingForTest 不清 holderNames（现状断言，TEST-t32 问题清单用）
// 跑法：npm run compile 后 node scripts/probe/test-t32-followunit.mjs
import fs from "fs";
import os from "os";
import path from "path";
import { PiClient } from "../../out/pi/piClient.js";
import { PiCore } from "../../out/core/piCore.js";
import {
  setExternalWriting,
  setExternalWritingName,
  isExternalWriting,
  _resetExternalWritingForTest,
} from "../../out/core/externalWriting.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg); }
};

// ── ① switchSession force：编译产物 + 运行时 ──
console.log("① switchSession force 短路绕过");
const compiled = fs.readFileSync(new URL("../../out/pi/piClient.js", import.meta.url), "utf8");
ok(/force/.test(compiled) && /!\s*force\s*&&/.test(compiled), "编译产物含 !force 短路条件");
ok((compiled.match(/session is being written by an external process/g) || []).length === 4,
  "编译产物含 4 处外部活跃门禁 throw（setModel/setThinkingLevel/setSessionName/compact——第 4 处为返修P1 补的 compact 门禁）");

const mkFakeClient = (sessionFile) => {
  const calls = { switched: [], swaps: 0 };
  const fake = {
    ready: () => Promise.resolve(),
    session: { sessionFile, isStreaming: false, sessionName: null },
    runtime: { switchSession: async (p) => { calls.switched.push(p); return {}; } },
    afterSessionSwap: () => { calls.swaps++; },
  };
  return { fake, calls };
};
{
  const sameWin = "C:\\x\\a.jsonl";
  const { fake, calls } = mkFakeClient(sameWin);
  await PiClient.prototype.switchSession.call(fake, "c:/x/a.jsonl", false);
  ok(calls.switched.length === 0, "force=false 同文件（大小写/斜杠归一）→ 短路不重进");
  await PiClient.prototype.switchSession.call(fake, "c:/x/a.jsonl", true);
  ok(calls.switched.length === 1, "force=true 同文件 → 绕过短路，真实 switchSession（交棒重载路径）");
  await PiClient.prototype.switchSession.call(fake, "c:/x/b.jsonl", false);
  ok(calls.switched.length === 2, "force=false 异文件 → 照常切换（短路只挡同文件）");
}

// ── ② followTick active 三分支 ──
console.log("② followTick active 判定三分支");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t32-followunit-"));
const file = path.join(dir, "s.jsonl");
const line = (id, text) =>
  JSON.stringify({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
fs.writeFileSync(file, line("m0", "base"));

const mkTick = (opts = {}) => {
  const emitted = [];
  const c = {
    followFile: file,
    followOffset: opts.offset ?? fs.statSync(file).size,
    followDelta: opts.delta ?? [],
    followActive: opts.active ?? false,
    followLastOwnWriteAt: 0,
    followArmed: opts.armed !== false, // 默认武装（用例测的是机制内部）；armed:false 专测闸门
    session: { isStreaming: !!opts.streaming, sessionName: opts.name ?? null },
    events: { emit: (ev, arg) => emitted.push([ev, arg]) },
  };
  for (const m of ["readFollowGrowth", "emitFollowState", "followTick", "markOwnWrite", "filterLocalDupes"]) {
    c[m] = PiClient.prototype[m];
  }
  return { c, emitted };
};
_resetExternalWritingForTest();

// 分支 ⓪：武装制闸门——未武装且无信号/请求 → 完全不动（原功能隔离）
{
  const { c, emitted } = mkTick({ armed: false });
  c.followTick();
  ok(c.followArmed === false && emitted.length === 0, "⓪: 未武装+无信号 → 什么都不做（老路径零开销）");
}

// 分支 A：registry 命中（delta=0 也锁）
{
  setExternalWriting(file, true);
  const { c, emitted } = mkTick({ active: false });
  c.followTick();
  ok(c.followActive === true, "A: registry 命中 → active=true（delta=0 精确信号照锁）");
  ok(emitted.some(([e, v]) => e === "externalState" && v === true), "A: 发出 externalState(true)");
  ok(!emitted.some(([e]) => e === "externalRelease"), "A: 活跃期不发交棒请求");
  setExternalWriting(file, false);
}
// 分支 B：delta 非空 + mtime 静默窗内（无 registry）
{
  fs.appendFileSync(file, line("m1", "external-1"));
  const firstLineLen = Buffer.byteLength(fs.readFileSync(file, "utf8").split("\n")[0] + "\n", "utf8");
  const { c, emitted } = mkTick({ active: false, offset: firstLineLen }); // offset 落在首行尾 → m1 是增长
  c.followTick();
  ok(emitted.some(([e, v]) => e === "externalAppend" && v.length === 1), "B: 增量读出 1 条并发 externalAppend");
  ok(c.followActive === true, "B: delta>0 且 mtime 新鲜 → active=true（mtime 启发式）");
  ok(!emitted.some(([e]) => e === "externalRelease"), "B: 活跃期不发交棒请求");
}
// 分支 B′：delta>0 但 mtime 超静默窗 → 解锁 + 请求交棒
{
  const st = fs.statSync(file);
  fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const { c, emitted } = mkTick({ active: true, delta: [{ role: "assistant", content: [] }] });
  c.followOffset = st.size;
  c.followTick();
  ok(c.followActive === false, "B′: delta>0 但 mtime 超 10s 静默窗 → active=false");
  ok(emitted.some(([e, v]) => e === "externalState" && v === false), "B′: 发出 externalState(false)（piCore 侧推迟到交棒后）");
  ok(emitted.some(([e]) => e === "externalRelease"), "B′: 静默 + delta>0 + 本地空闲 → 请求交棒重载");
  fs.utimesSync(file, st.atime, st.mtime);
}
// 分支 B″：delta>0 + 静默但本地 streaming → 不请求交棒（防与本地 run 交错）
{
  const st = fs.statSync(file);
  fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const { c, emitted } = mkTick({ active: true, delta: [{ role: "assistant", content: [] }], streaming: true });
  c.followOffset = st.size;
  c.followTick();
  ok(!emitted.some(([e]) => e === "externalRelease"), "B″: 本地 streaming 期间不发交棒");
  fs.utimesSync(file, st.atime, st.mtime);
}
// 分支 C：双假（无 registry、delta 空）→ 不锁不发
{
  const { c, emitted } = mkTick({ active: false });
  c.followTick();
  ok(c.followActive === false, "C: 双假 → active=false");
  ok(emitted.length === 0, "C: 状态未变化 → 零事件（无噪声 externalState）");
}
// 变体 D：文件变小（外部重写）+ delta>0 → 交棒重载
{
  const { c, emitted } = mkTick({ active: true, delta: [{ role: "assistant", content: [] }] });
  c.followOffset = fs.statSync(file).size + 100;
  c.followTick();
  ok(emitted.some(([e]) => e === "externalRelease"), "D: 文件变小且有 delta → externalRelease（重写对齐）");
}
// 变体 E：markOwnWrite 1.5s 窗口 → 增长归本地（跳过不发 externalAppend）
{
  const { c, emitted } = mkTick({ active: false });
  c.markOwnWrite();
  fs.appendFileSync(file, line("m2", "own-write"));
  c.followTick();
  ok(!emitted.some(([e]) => e === "externalAppend"), "E: markOwnWrite 窗口内增长 → 归本地跳过（防双份渲染）");
  ok(c.followOffset === fs.statSync(file).size, "E: offset rebase 到文件尾");
}

// ── ③ piCore.onExternalState / onExternalRelease 解锁时序 ──
console.log("③ externalState 解锁时序（piCore 侧）");
{
  const posts = [];
  const core = {
    client: { followDeltaLength: () => 2 },
    post: (m) => posts.push(m),
    dbg: () => {},
    extReleasing: true, // 上一轮交棒失败锁——状态变化应复位
    extNoticeAt: 0, // notice 冷却起点（0 = 首条必发）
    L: { extRunningNotice: "n", extReleaseFail: "f" },
  };
  PiCore.prototype.onExternalState.call(core, false);
  ok(core.extReleasing === false, "③-1: 解锁信号到达 → extReleasing 复位（失败锁换新周期）");
  ok(!posts.some((m) => m.type === "externalState"), "③-1: delta>0 时不发解锁消息（先交棒重载再解锁，防打在过期 leaf 上）");

  posts.length = 0;
  core.client = { followDeltaLength: () => 0 };
  PiCore.prototype.onExternalState.call(core, false);
  ok(posts.some((m) => m.type === "externalState" && m.locked === false), "③-2: delta=0 → 即时发解锁");

  posts.length = 0;
  PiCore.prototype.onExternalState.call(core, true);
  ok(posts.some((m) => m.type === "externalState" && m.locked === true), "③-3: 活跃 → 发锁真相");
  ok(posts.some((m) => m.type === "notice"), "③-3: 活跃 → notice 提示");

  // 重入锁：extReleasing=true 时 onExternalRelease 直接返回（防 500ms 重试风暴）
  let getStateCalled = 0;
  const core2 = {
    extReleasing: true,
    client: { followDeltaLength: () => 5, getState: async () => { getStateCalled++; } },
    post: () => {}, dbg: () => {}, L: {},
  };
  await PiCore.prototype.onExternalRelease.call(core2);
  ok(getStateCalled === 0, "③-4: extReleasing=true → 交棒重入直接返回（幂等锁生效）");
}

// ── ⑤ 测试钩子现状断言 ──
console.log("⑤ _resetExternalWritingForTest 覆盖面（修后断言：返修P3-2 已补 holderNames 清理）");
{
  _resetExternalWritingForTest();
  setExternalWritingName("probe-zombie", true);
  _resetExternalWritingForTest();
  const stillHit = isExternalWriting(null, "probe-zombie");
  ok(stillHit === false, "⑤: reset 钩子连 holderNames 一起清（跨用例零残留）");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
