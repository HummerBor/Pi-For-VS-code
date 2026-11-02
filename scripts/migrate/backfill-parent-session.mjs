/**
 * 一次性迁移：给 v7 之前派出的子 agent 台账回填 parentSession
 *
 * 背景（2026-11-02）：harness v7 起在台账记 parentSession（派单方会话文件），左侧列表
 * 才能把子会话挂到对应主会话下。之前的老记录没这个字段 → 全落到「未归属子会话」组，
 * 用户看到「浮窗有 6 条、左侧只挂 1 条」。
 *
 * 判据：子会话 startedAt 落在哪个主会话的活动窗口内 [会话 header 时间, 文件 mtime]；
 * 多个主会话窗口重叠时取**开始时间最晚**的那个（即当时正在用的会话）。
 * 不读全文——主会话动辄几 MB，只读头部 4KB 取 header.timestamp，末尾用文件 mtime 近似。
 *
 * 幂等：已有 parentSession 的记录不动。只改台账 JSON，不碰任何会话文件。
 * 用法：node scripts/migrate/backfill-parent-session.mjs [--dry]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DRY = process.argv.includes("--dry");
const agentDir = path.join(os.homedir(), ".pi", "agent");
const sessionsRoot = path.join(agentDir, "sessions");
const subsRoot = path.join(sessionsRoot, "subagents");
const runsDir = path.join(subsRoot, "runs");

if (!fs.existsSync(runsDir)) {
  console.log("没有台账目录，跳过：", runsDir);
  process.exit(0);
}

/** 主会话（sessions/--slug--/*.jsonl）的活动窗口。子会话目录（subagents/）不算主会话。 */
function mainSessions() {
  const out = [];
  for (const dir of fs.readdirSync(sessionsRoot)) {
    const full = path.join(sessionsRoot, dir);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory() || dir === "subagents") continue;
    let files;
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(full, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      // 读头部 4KB 取 session header 的 timestamp（不读全文）
      let start = 0;
      try {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const head = buf.subarray(0, n).toString("utf8");
        const firstLine = head.split("\n")[0];
        const rec = JSON.parse(firstLine);
        if (rec.type === "session" && typeof rec.timestamp === "string") {
          start = Date.parse(rec.timestamp) || 0;
        }
      } catch {
        start = 0;
      }
      if (!start) start = mtime; // header 读不到就退化成 mtime
      out.push({ file, start, end: mtime });
    }
  }
  return out;
}

const mains = mainSessions();
console.log(`主会话 ${mains.length} 个，台账目录 ${runsDir}`);

let patched = 0;
let skipped = 0;
let orphan = 0;
for (const f of fs.readdirSync(runsDir)) {
  if (!f.endsWith(".json")) continue;
  const p = path.join(runsDir, f);
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    continue;
  }
  if (!rec || typeof rec.handle !== "string") continue;
  if (typeof rec.parentSession === "string" && rec.parentSession) {
    skipped++;
    continue; // 已有归属，不动
  }
  const startedAt = typeof rec.startedAt === "number" ? rec.startedAt : 0;
  if (!startedAt) {
    orphan++;
    continue;
  }
  // 覆盖该时刻的主会话里，开始时间最晚的那个（= 当时正在用的会话）
  const hits = mains.filter((m) => startedAt >= m.start && startedAt <= m.end);
  hits.sort((a, b) => b.start - a.start);
  const hit = hits[0];
  if (!hit) {
    orphan++;
    console.log(`  [无匹配] ${rec.handle}  startedAt=${new Date(startedAt).toISOString()}`);
    continue;
  }
  rec.parentSession = hit.file;
  if (!DRY) fs.writeFileSync(p, JSON.stringify(rec, null, 2), "utf8");
  patched++;
  console.log(
    `  ${rec.handle} → ${path.basename(path.dirname(hit.file))}/${path.basename(hit.file).slice(0, 20)}… (${hits.length} 个候选)`,
  );
}

console.log(
  `\n回填 ${patched} 条${DRY ? "（dry-run，未写盘）" : ""}，跳过已有归属 ${skipped} 条，无法归属 ${orphan} 条`,
);
