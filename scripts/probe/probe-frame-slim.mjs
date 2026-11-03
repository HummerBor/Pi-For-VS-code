// 刀A 事实基线：父会话里 subagent-async 帧到底多大、只发增量能省多少（2026-11-03）。
// 口径：每条 custom entry 的 data.detail.results[i].messages 是全量；增量方案=只带上一条之后
// 新增的 messages（+ 起始下标 + 总数），收尾帧才带全量（保证 detail 完整可下钻）。
// 用法：node scripts/probe/probe-frame-slim.mjs [会话文件]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sessDir = path.join(os.homedir(), ".pi/agent/sessions/--D--work-docs-pi test-pi-vscode--");
const file =
  process.argv[2] ??
  path
    .join(sessDir, fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")).sort((a, b) => fs.statSync(path.join(sessDir, b)).size - fs.statSync(path.join(sessDir, a)).size)[0]);

const byHandle = new Map(); // handle → { frames: n, fullBytes, deltaBytes, msgs }
let unknown = 0;
for (const ln of fs.readFileSync(file, "utf8").split("\n")) {
  if (!ln.includes("subagent-async")) continue;
  let e;
  try { e = JSON.parse(ln); } catch { continue; }
  if (e?.type !== "custom" || e.customType !== "subagent-async") continue;
  const d = e.data;
  if (!d || typeof d.handle !== "string") { unknown++; continue; }
  const results = d?.detail?.results;
  if (!Array.isArray(results)) { unknown++; continue; }

  const fullBytes = Buffer.byteLength(JSON.stringify(d));
  // 增量估算：把 messages 换成「本条新增的尾部 + 起始下标」
  let prev = byHandle.get(d.handle);
  let deltaBytes = 0;
  for (const r of results) {
    const msgs = Array.isArray(r.messages) ? r.messages : [];
    const from = prev ? (prev.msgs ?? 0) : 0;
    const tail = msgs.slice(Math.max(0, Math.min(from, msgs.length)));
    const slim = { ...r, messages: tail, messagesFrom: from, messagesTotal: msgs.length };
    deltaBytes += Buffer.byteLength(JSON.stringify(slim));
  }
  const rec = prev ?? { frames: 0, fullBytes: 0, deltaBytes: 0, msgs: 0 };
  rec.frames++;
  rec.fullBytes += fullBytes;
  rec.deltaBytes += deltaBytes;
  rec.msgs = results.reduce((s, r) => s + (Array.isArray(r.messages) ? r.messages.length : 0), 0);
  byHandle.set(d.handle, rec);
}

let tf = 0, td = 0, n = 0;
console.log("会话:", path.basename(file));
console.log("handle  帧数   全量KB   增量KB  省");
for (const [h, r] of [...byHandle].sort((a, b) => b[1].fullBytes - a[1].fullBytes)) {
  n += r.frames; tf += r.fullBytes; td += r.deltaBytes;
  console.log(
    h.padEnd(7), String(r.frames).padStart(4), String((r.fullBytes / 1024).toFixed(1)).padStart(8),
    String((r.deltaBytes / 1024).toFixed(1)).padStart(8),
    (100 - (r.deltaBytes / Math.max(1, r.fullBytes)) * 100).toFixed(0).padStart(4) + "%",
  );
}
console.log(`合计 ${n} 帧：全量 ${(tf / 1048576).toFixed(2)}MB → 增量 ${(td / 1048576).toFixed(2)}MB（省 ${(100 - (td / Math.max(1, tf)) * 100).toFixed(0)}%）；无法解析 ${unknown} 条`);
