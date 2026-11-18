// 会话文件瘦身：清掉历史遗留的 subagent 进度帧（2026-11-18，harness v20 帧瘦身的存量清理）。
//
// 为什么需要它：harness v20 之前，子 agent 的每一帧进度都把尾窗 20 条消息原样塞进
// pi.appendEntry("subagent-async")，而工具输出里夹着 base64 截图（单条 380–600KB）——
// 单帧中位 238KB、峰值 1.8MB，且这些 custom entry 在本宿主是真落盘的。实测：
//   世界项目 285.8MB 的会话，273MB（96%）是这些帧；另一份 713.4MB 里 688MB 是帧。
// 会话文件一胖，pi 载入 + 面板重放（全文读 + 逐行 parse）全部卡死，表现就是
// 「子智能体时间和状态都不更新」。
//
// 口径（只删可重算的派生帧，不动任何会话消息）：
//   - subagent-async      → 每个 handle 只留**最后一帧**（面板重放本来就只用最后一帧，
//                           piCore.replaySubagentHistoryInner 的 finals Map 逐 handle 覆盖）
//   - subagent-async-stream → 全删（delta 流只供直播消费，不带状态，重放不读）
//   - 其余行（消息/会话元数据/toolResult）逐字节原样保留
//
// 用法：
//   node scripts/migrate/slim-subagent-frames.mjs                 # 干跑：扫 >20MB 的会话，只报账
//   node scripts/migrate/slim-subagent-frames.mjs --apply         # 真改（写 <file>.bak 后原子替换）
//   node scripts/migrate/slim-subagent-frames.mjs <file> [more…]  # 指定文件
//   node scripts/migrate/slim-subagent-frames.mjs --min-mb 1      # 调扫描阈值
//
// ⚠️ 真改前先关掉对应会话所在窗口：pi 正在 append 的文件被原子替换，会让它的写指针落空。

import fs from "node:fs";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const minMbIdx = args.indexOf("--min-mb");
const minMb = minMbIdx >= 0 ? Number(args[minMbIdx + 1]) || 20 : 20;
const explicit = args.filter((a, i) => !a.startsWith("--") && !(minMbIdx >= 0 && i === minMbIdx + 1));

const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");

/** 收集目标：显式参数 > 按大小扫 sessions 根 */
function targets() {
  if (explicit.length) return explicit.map((p) => path.resolve(p));
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) {
        try {
          if (fs.statSync(full).size > minMb * 1e6) out.push(full);
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  };
  walk(sessionsRoot);
  return out;
}

/** 流式按行读（带绝对字节偏移）。单行可达 1.8MB，且本机最大会话 713MB——readFileSync 会撞
 *  Node 字符串上限（0x1fffffe8），必须流式。 */
async function* readLines(file) {
  const rs = createReadStream(file, { highWaterMark: 1 << 20 });
  let pending = Buffer.alloc(0);
  let pendingStart = 0;
  for await (const chunk of rs) {
    const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    let idx;
    while ((idx = buf.indexOf(0x0a, start)) >= 0) {
      yield { line: buf.subarray(start, idx).toString("utf8"), offset: pendingStart + start, bytes: idx - start + 1 };
      start = idx + 1;
    }
    pending = buf.subarray(start);
    pendingStart += start;
  }
  if (pending.length) yield { line: pending.toString("utf8"), offset: pendingStart, bytes: pending.length };
}

/** 帧行 → handle（不是本扩展的帧返回 null；崩坏半行也返回 null，保持原样不擅丢） */
function frameHandle(line) {
  if (!line.includes("subagent-async")) return null;
  try {
    const o = JSON.parse(line);
    if (o?.type !== "custom" || o?.customType !== "subagent-async") return null;
    return typeof o?.data?.handle === "string" ? o.data.handle : null;
  } catch {
    return null;
  }
}

/**
 * 单文件：A 趟算账 + 定位每 handle 最后一帧的偏移；apply 时再走 B 趟写新文件。
 * 只删可重算的派生帧，会话消息/元数据/toolResult 逐字节保留。
 * 返回 { before, after, keptLines, droppedFrames, droppedStreams }
 */
async function slim(file) {
  const before = fs.statSync(file).size;
  const isFrames = path.basename(file) === "frames.jsonl";

  let total = 0;
  let lines = 0;
  let frameBytes = 0;
  let frameLines = 0;
  let streamBytes = 0;
  let streamLines = 0;
  let lastFrameLine = null;
  const lastFrameAt = new Map(); // handle → 最后一次出现的行偏移

  for await (const { line, offset, bytes } of readLines(file)) {
    total += bytes;
    lines++;
    if (isFrames) {
      lastFrameLine = line;
      continue;
    }
    if (line.includes("subagent-async-stream")) {
      streamBytes += bytes;
      streamLines++;
      continue;
    }
    const h = frameHandle(line);
    if (h) {
      frameBytes += bytes;
      frameLines++;
      lastFrameAt.set(h, offset);
    }
  }

  // 帧文件：一行一帧，重放只读最后一行
  if (isFrames) {
    if (lastFrameLine === null) return { before, after: before, keptLines: 0, droppedFrames: 0, droppedStreams: 0 };
    const after = Buffer.byteLength(lastFrameLine) + 1;
    if (apply) {
      fs.renameSync(file, `${file}.bak`);
      fs.writeFileSync(file, `${lastFrameLine}\n`, "utf8");
    }
    return { before, after, keptLines: 1, droppedFrames: total - after, droppedStreams: 0 };
  }

  // 会话文件：保留帧 = 每个 handle 最后一次出现的那一行
  let keptFrameBytes = 0;
  const keptFrameLines = lastFrameAt.size;
  for await (const { line, offset, bytes } of readLines(file)) {
    const h = frameHandle(line);
    if (h && lastFrameAt.get(h) === offset) keptFrameBytes += bytes;
  }
  const after = total - streamBytes - frameBytes + keptFrameBytes;

  if (apply) {
    fs.renameSync(file, `${file}.bak`);
    const out = fs.createWriteStream(file);
    for await (const { line, offset } of readLines(`${file}.bak`)) {
      if (line.includes("subagent-async-stream")) continue;
      const h = frameHandle(line);
      if (h && lastFrameAt.get(h) !== offset) continue;
      if (!out.write(`${line}\n`)) await new Promise((res) => out.once("drain", res));
    }
    await new Promise((res, rej) => {
      out.once("error", rej);
      out.end(res);
    });
  }

  return {
    before,
    after,
    keptLines: lines - streamLines - frameLines + keptFrameLines, // 保留行数（展示用）
    droppedFrames: frameBytes - keptFrameBytes,
    droppedStreams: streamBytes,
  };
}

const list = targets();
if (!list.length) {
  console.log(`没有找到 >${minMb}MB 的会话/帧文件（${sessionsRoot}）`);
  process.exit(0);
}

let saved = 0;
for (const file of list) {
  try {
    const r = await slim(file);
    const pct = r.before ? (100 * (r.before - r.after)) / r.before : 0;
    console.log(
      `${apply ? "[改]" : "[干跑]"} ${file}\n` +
        `        ${(r.before / 1e6).toFixed(1)}MB → ${(r.after / 1e6).toFixed(2)}MB（省 ${pct.toFixed(0)}%）` +
        ` 行 ${r.keptLines}，丢旧帧 ${(r.droppedFrames / 1e6).toFixed(1)}MB / delta 流 ${(r.droppedStreams / 1e6).toFixed(1)}MB`
    );
    saved += r.before - r.after;
  } catch (e) {
    console.error(`[跳过] ${file}: ${e?.message ?? e}`);
  }
}
console.log(`\n合计可省 ${(saved / 1e6).toFixed(1)}MB${apply ? "（已写 .bak 备份，确认无误后可自行删除）" : "（干跑，未改任何文件；加 --apply 才真改）"}`);
