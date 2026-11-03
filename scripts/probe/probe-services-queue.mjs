// services 排队 + 大会话 render 成本探针（2026-11-03）。
// 结论（本机）：串行 3 个 client 237ms / 并发 219ms（排队不是瓶颈）；
//   855 条消息的 render payload = 8.1MB JSON，stringify 27ms（也不是瓶颈）。
//   → 「打开大会话卡几秒」另有原因，看真机 [boot-svc] 打点。
// 用法：node scripts/probe/probe-services-queue.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createAgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const agentDir = path.join(os.homedir(), ".pi/agent");
const mr = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
const opts = { cwd, agentDir, modelRuntime: mr, resourceLoaderOptions: { extensionFactories: [() => {}] } };
const mk = () => createAgentSessionServices({ ...opts });
const t = () => Date.now();

await mk(); // 预热，冷编译不算排队成本
let a = t();
await mk();
await mk();
await mk();
console.log("① 串行 3 个 client:", t() - a, "ms");
a = t();
await Promise.all([mk(), mk(), mk()]);
console.log("① 并发 3 个 client:", t() - a, "ms");

const root = path.join(agentDir, "sessions/--D--work-docs-pi test-pi-vscode--");
const files = fs
  .readdirSync(root)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => path.join(root, f))
  .sort((x, y) => fs.statSync(y).size - fs.statSync(x).size)
  .slice(0, 2);
for (const file of files) {
  const msgs = [];
  for (const ln of fs.readFileSync(file, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try {
      const e = JSON.parse(ln);
      if (e && e.type === "message" && e.message) msgs.push(e.message);
    } catch {}
  }
  let best = Infinity;
  let size = 0;
  for (let i = 0; i < 3; i++) {
    const s = t();
    const json = JSON.stringify({ type: "render", tabId: "pX", messages: msgs });
    size = Buffer.byteLength(json);
    best = Math.min(best, t() - s);
  }
  console.log(`② render ${msgs.length} 条 → JSON ${(size / 1048576).toFixed(2)}MB，stringify 最快 ${best}ms`);
}
