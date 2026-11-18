/**
 * 子 agent 失联判定用例（工单 t35：失联判定从「30 分钟无帧」改 pid 存活）。
 *
 * 运行：node scripts/test/subagentLiveness.test.mjs（**先 npm run compile**，用例读 out/ 产物）
 *
 * 打两头（一个信号的发送方 + 接收方）：
 *  ① 宿主读台账时探活：status==="running" 的行带 procAlive（process.kill(pid,0) 结论）——
 *     pid 已死 → false；pid 活着 → true；老台账没 pid → 不给结论（不许把「不知道」当「死了」）；
 *     非 running 行一律不带（pid 可能已被系统回收再分配，探活结果没语义）。
 *  ② 展示层降级：livenessStatus("running", false) → "failed"（立即落终态，不等 SUB_STALE_MS）；
 *     其余组合维持原状态。
 *
 * 为什么不用「造一个活进程」验 true：活进程要管生命周期（平台差异 + 泄漏风险），
 * 用本用例自己的 pid 就够——它是活着的，且不依赖任何外部进程。
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLedgerRows } from "../../out/core/subagentLedger.js";
import { livenessStatus } from "../../out/domain/subagentSnapshot.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sa-live-"));
const runs = path.join(tmp, "sessions", "subagents", "runs");
fs.mkdirSync(runs, { recursive: true });

/** 拿一个「确定已经退出」的 pid：起一个空 node 子进程，等它同步退完再读 pid */
const deadPid = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" }).pid;
assert.ok(typeof deadPid === "number" && deadPid > 0, "前提：能拿到一个已退出的子进程 pid");

const rec = (handle, status, extra = {}) => ({
  handle,
  agent: "worker",
  task: "探活用例",
  status,
  startedAt: 1,
  ...extra,
});
fs.writeFileSync(path.join(runs, "sa-dead.json"), JSON.stringify(rec("sa-dead", "running", { pid: deadPid, ownerPid: process.pid })));
fs.writeFileSync(path.join(runs, "sa-alive.json"), JSON.stringify(rec("sa-alive", "running", { pid: process.pid, ownerPid: process.pid })));
fs.writeFileSync(path.join(runs, "sa-nopid.json"), JSON.stringify(rec("sa-nopid", "running")));
fs.writeFileSync(path.join(runs, "sa-done.json"), JSON.stringify(rec("sa-done", "completed", { pid: deadPid, endedAt: 2 })));

const rows = readLedgerRows(tmp);
const byHandle = (h) => rows.find((r) => r.handle === h);

// ① 宿主探活
assert.strictEqual(byHandle("sa-dead").procAlive, false, "① pid 已死的 running 行 → procAlive:false");
assert.strictEqual(byHandle("sa-alive").procAlive, true, "① pid 活着的 running 行 → procAlive:true");
assert.strictEqual(byHandle("sa-nopid").procAlive, undefined, "① 老台账没 pid → 不给结论（不许当死）");
assert.ok(!("procAlive" in byHandle("sa-done")), "① 非 running 行不带 procAlive");

// ② 展示层降级：死的 running 立即终态
assert.strictEqual(livenessStatus("running", false), "failed", "② 进程已死 → 立即按失败落终态");
assert.strictEqual(livenessStatus("running", true), "running", "② 进程活着 → 维持处理中");
assert.strictEqual(livenessStatus("running", undefined), "running", "② 没结论 → 维持处理中（时间兜底）");
assert.strictEqual(livenessStatus("done", false), "done", "② 已完成行不被探活改写");
assert.strictEqual(livenessStatus("failed", true), "failed", "② 已失败行不被探活改写");
assert.strictEqual(livenessStatus("running", "false"), "running", "② 只认布尔 false（防御脏载荷）");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("subagentLiveness: 10/10 通过 ✅");
