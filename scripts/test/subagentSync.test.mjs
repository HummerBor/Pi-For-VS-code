// 内置 subagent 扩展同步探针（scripts/test-*.mjs 回归套成员）。
// 测 ensureSubagentHarness 的同步核心 syncSubagentHarness 三分支：
//   ① 首装：目标缺失 → 全量拷入（含 harness.json 版本戳）
//   ② 版本门：target version >= bundled → 不覆盖（本地修改存活）
//   ③ 版本落后 → 覆盖升级
// node 裸跑，直接 import 编译产物 out/pi/ensureSubagentHarness.js。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncSubagentHarness } from "../out/pi/ensureSubagentHarness.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sa-sync-"));
const agentDir = path.join(tmp, "agent");
const dst = path.join(agentDir, "extensions", "subagent");

// ① 首装
syncSubagentHarness(agentDir);
assert.ok(fs.existsSync(path.join(dst, "index.ts")), "① 首装应拷入 index.ts");
assert.ok(fs.existsSync(path.join(dst, "agents.ts")), "① 首装应拷入 agents.ts");
assert.ok(fs.existsSync(path.join(dst, "runsLedger.ts")), "① 首装应拷入 runsLedger.ts");
assert.ok(fs.existsSync(path.join(dst, "harness.json")), "① 首装应拷入 harness.json");

// ② 版本门：同版本不覆盖（本地修改存活）
const marker = "\n// local-tweak-probe\n";
fs.appendFileSync(path.join(dst, "index.ts"), marker);
syncSubagentHarness(agentDir);
assert.ok(
  fs.readFileSync(path.join(dst, "index.ts"), "utf8").includes("local-tweak-probe"),
  "② 同版本不应覆盖本地修改",
);

// ③ 版本落后 → 覆盖升级
fs.writeFileSync(path.join(dst, "harness.json"), JSON.stringify({ version: 0 }));
syncSubagentHarness(agentDir);
assert.ok(
  !fs.readFileSync(path.join(dst, "index.ts"), "utf8").includes("local-tweak-probe"),
  "③ 版本落后应被 bundled 覆盖",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-subagent-sync: 3/3 通过");
