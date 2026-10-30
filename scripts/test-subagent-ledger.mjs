// 子 agent 台账读取探针（scripts/test-*.mjs 回归套成员，node 裸跑）。
// readLedgerRows 四分支：①目录缺失返回 [] ②正常记录倒序 ③烂 JSON/非台账对象跳过
// ④未知 status 归 failed、缺字段照收。import 编译产物 out/core/subagentLedger.js。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLedgerRows } from "../out/core/subagentLedger.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sa-ledger-"));
const runs = path.join(tmp, "sessions", "subagents", "runs");

// ① 目录缺失 → []
assert.deepStrictEqual(readLedgerRows(path.join(tmp, "nope")), [], "① 目录缺失应返回 []");

fs.mkdirSync(runs, { recursive: true });
// ② 正常记录（reported/endedAt 带上）
fs.writeFileSync(
  path.join(runs, "sa-1.json"),
  JSON.stringify({ handle: "sa-1", agent: "worker", task: "任务A", status: "completed", startedAt: 2, endedAt: 3, reported: true }),
);
// ③ 烂 JSON + 非台账对象
fs.writeFileSync(path.join(runs, "sa-2.json"), "{broken");
fs.writeFileSync(path.join(runs, "sa-4.json"), JSON.stringify({ notALedger: true }));
// ④ 未知 status 归 failed、缺字段照收
fs.writeFileSync(
  path.join(runs, "sa-3.json"),
  JSON.stringify({ handle: "sa-3", agent: "worker", task: "任务B", status: "weird", startedAt: 1 }),
);

const rows = readLedgerRows(tmp);
assert.strictEqual(rows.length, 2, "③ 烂 JSON 与非台账对象应跳过");
assert.strictEqual(rows[0].handle, "sa-1", "② startedAt 倒序");
assert.strictEqual(rows[0].reported, true, "② reported 照收");
assert.strictEqual(rows[1].status, "failed", "④ 未知 status 归 failed");
assert.strictEqual(rows[1].endedAt, undefined, "④ 缺字段照收（undefined）");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-subagent-ledger: 4/4 通过");
