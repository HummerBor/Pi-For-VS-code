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
//   - 其余行（消息/会话元数据/toolResult/别的 custom entry）逐字节原样保留
//
// ⚠️⚠️ 2026-11-19 返修（血账，动这个脚本之前先读完）：旧版**只删行、不重接 parentId**，
// 而 pi 的 SessionManager 是从 leaf 沿 `parentId` 往根走（buildSessionPath）才拿到上下文的——
// 删掉中间节点等于把祖先链剪断。299MB 样本实测：体积 299.92→20.69MB（-93.1%），但
// **上下文 566→21 条、thinkingLevel high→off、从 leaf 只 24/619 可达**——等于把会话历史洗掉。
//
// 实现要点（六条，缺一条都不许上真数据）：
//   1. parentId 上溯压缩：被删节点的子节点把 parentId 指向**最近存活祖先**。只改引用、不改体积，
//      566 条上下文完全复原。同一套口径顺带修另外两处「指向 entry id」的引用：
//        - compaction.firstKeptEntryId：沿旧 leaf 路径往后找第一个存活节点（否则压缩点之前的
//          上下文会被静默丢掉——这是清单外的第 7 条，实测会丢消息）；
//        - branch_summary.fromId：上溯到最近存活祖先。
//      另有 label.targetId / context_edit.targetId 同样指向 entry id，**故意不重映射**：它们指向的
//      帧本身不参与上下文，悬空前后行为完全一致；把书签/上下文改写硬挪到别的消息上才是数据损坏。
//   2. 原子替换：写 <file>.slim-tmp → fsync → 落 .bak（copy+fsync）→ rename 覆盖，不许原地写。
//      顺序讲究：先写 tmp、再落 .bak、最后 rename，任何时刻断电原文件都还在。
//   3. <file>.bak 存在即拒跑（退出码 1）：防重复 apply 二次剪枝。
//   4. --apply 后自检：用 pi 自带的 SessionManager 重新加载 .bak 与新文件，比对上下文条数、
//      内容哈希、thinkingLevel、model、从 leaf 可达节点数；不一致立刻从 .bak 原子回滚。
//   5. 终态守卫：写完重读产物，逐行哈希必须等于预期，且不许有残留 stream 帧、悬空 parentId、
//      行数对不上；frames.jsonl 单独守卫（产物必须逐字节等于最后一行）。
//   6. 帧类型一律 `JSON.parse` 后判 `customType`（旧版用 `line.includes("subagent-async-stream")`
//      判类型——任何 toolResult 正文里出现这串字的行都会被当帧删掉，是真实的数据丢失路径）。
//
// 入口守卫（工单40 补刀，2026-11-19）：脚本不给路径时**默认目标就是真实会话根**，所以
// `--apply` 一条命令就能改写本机全部会话（实测 4.1GB / 488 个）。上面的 .bak 守卫只挡得住第二次，
// 挡不住第一次。因此：`--apply` 且（未给路径 或 给了落在 sessionsRoot 下的路径）时，必须再带
// `--force-real`，否则**拒跑**（退出码 1，打印会改多少文件 + 建议先单文件试）。
// 干跑（不带 --apply）不受影响——那是它平时的用法；显式给非 sessions 路径的 --apply 也照旧放行。
//
// 用法：
//   node scripts/migrate/slim-subagent-frames.mjs                 # 干跑：扫 >20MB 的会话，只报账（可扫真实根）
//   node scripts/migrate/slim-subagent-frames.mjs <file> [more…]  # 干跑指定文件
//   node scripts/migrate/slim-subagent-frames.mjs --apply <file>  # 真改指定文件（非 sessions 目录直接放行）
//   node scripts/migrate/slim-subagent-frames.mjs --apply --force-real
//                                                                 # 真改整个真实会话根（⚠️ 危险动作二次确认）
//   node scripts/migrate/slim-subagent-frames.mjs --min-mb 1      # 调扫描阈值
//
// ⚠️ 真改前先关掉对应会话所在窗口：pi 正在 append 的文件被原子替换，会让它的写指针落空。

import fs from "node:fs";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const forceReal = args.includes("--force-real");
const minMbIdx = args.indexOf("--min-mb");
const minMb = minMbIdx >= 0 ? Number(args[minMbIdx + 1]) || 20 : 20;
const explicit = args.filter((a, i) => !a.startsWith("--") && !(minMbIdx >= 0 && i === minMbIdx + 1));

// 断电模拟钩子（仅测试注入，正常使用永远不设）：
//   SLIM_TEST_CRASH_AFTER_LINES=n → 写完第 n 条保留行立刻死（连 flush/fsync 都没走）
//   SLIM_TEST_CRASH_POINT=before-bak | before-rename → 卡在备份前 / 换名前死
// 都用 137(=128+9) 自杀死，避开真实报错的退出码 1。
const crashAfterLines = Number(process.env.SLIM_TEST_CRASH_AFTER_LINES || 0);
const crashPoint = process.env.SLIM_TEST_CRASH_POINT || "";

const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");

const KIND_KEEP = 0; // 会话消息 / 元数据 / 别的 custom entry：一条不动
const KIND_FRAME = 1; // subagent-async：每 handle 留最后一帧
const KIND_STREAM = 2; // subagent-async-stream：全删

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

/** 流式按行读。单行可达 1.8MB，本机最大会话 713MB——readFileSync 会撞 Node 字符串上限
 *  （0x1fffffe8），必须流式。bytes 含行尾换行（末行无换行时就是行本身长度）。 */
async function* readLines(file) {
  const rs = createReadStream(file, { highWaterMark: 1 << 20 });
  let pending = Buffer.alloc(0);
  for await (const chunk of rs) {
    const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    let idx;
    while ((idx = buf.indexOf(0x0a, start)) >= 0) {
      yield { line: buf.subarray(start, idx).toString("utf8"), bytes: idx - start + 1 };
      start = idx + 1;
    }
    pending = buf.subarray(start);
  }
  if (pending.length) yield { line: pending.toString("utf8"), bytes: pending.length };
}

/** 一行 → 最小元数据（不留正文：713MB 的文件只留这点东西在内存里）。
 *  空行 / 崩坏半行 → kind=KEEP 的空元数据，原样保留不擅丢。 */
function metaOf(line, bytes) {
  const m = { bytes, kind: KIND_KEEP, id: null, parentId: null, handle: null, firstKept: null, fromId: null };
  if (!line) return m;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return m;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return m;
  if (typeof o.id === "string") m.id = o.id;
  if (o.parentId === null || typeof o.parentId === "string") m.parentId = o.parentId ?? null;
  // 帧类型只认 JSON.parse 结果，不做字符串匹配（修法 6）
  if (o.type === "custom") {
    if (o.customType === "subagent-async") {
      m.kind = KIND_FRAME;
      if (typeof o.data?.handle === "string") m.handle = o.data.handle;
    } else if (o.customType === "subagent-async-stream") {
      m.kind = KIND_STREAM;
    }
  }
  if (o.type === "compaction" && typeof o.firstKeptEntryId === "string") m.firstKept = o.firstKeptEntryId;
  if (o.type === "branch_summary" && typeof o.fromId === "string") m.fromId = o.fromId;
  return m;
}

/** 原子写：tmp → fsync →（外部落完 .bak）→ rename。中途出错 abort 会清 tmp。 */
class AtomicWriter {
  constructor(dest) {
    this.dest = dest;
    this.tmp = `${dest}.slim-tmp`;
    this.fd = fs.openSync(this.tmp, "w");
    this.chunks = [];
    this.bytes = 0;
    this.closed = false;
  }
  write(text) {
    const buf = Buffer.from(text, "utf8");
    this.chunks.push(buf);
    this.bytes += buf.length;
    if (this.bytes >= 4 << 20) this.flush();
  }
  flush() {
    if (!this.bytes) return;
    const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    let off = 0;
    while (off < buf.length) off += fs.writeSync(this.fd, buf, off);
  }
  /** 写完 + fsync + close，返回 tmp 路径（rename 由调用方在 .bak 就绪后才做） */
  finish() {
    this.flush();
    fs.fsyncSync(this.fd); // 先落盘再 rename，否则断电可能留下空文件
    fs.closeSync(this.fd);
    this.closed = true;
    return this.tmp;
  }
  abort() {
    if (!this.closed) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* 已关就算了 */
      }
      this.closed = true;
    }
    try {
      fs.unlinkSync(this.tmp);
    } catch {
      /* 没有就算了 */
    }
  }
}

/** 落 .bak 与回滚都用这条：copy → tmp → fsync → rename，目标文件不会出现「半截」状态 */
function atomicCopy(src, dest) {
  const tmp = `${dest}.slim-tmp`;
  fs.copyFileSync(src, tmp);
  const fd = fs.openSync(tmp, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
}

/**
 * 单文件：A 趟扫元数据 → 算保留集与引用修复 → B 趟算字节/哈希（apply 时同时写）。
 * 只删可重算的派生帧，会话消息/元数据/toolResult 逐字节保留。
 */
async function slimSession(file) {
  const before = fs.statSync(file).size;

  // ── A 趟：元数据 ──
  const metas = [];
  for await (const { line, bytes } of readLines(file)) metas.push(metaOf(line, bytes));
  const n = metas.length;

  // 保留集：stream 全删；frame 每个 handle 只留最后一行。没有 handle 的帧（历史脏数据）
  // 各算各的 → 全部保留，与旧版口径一致（宁留不丢）。
  const keep = new Array(n).fill(true);
  const lastFrame = new Map(); // handle → 最后一次出现的行号
  for (let i = 0; i < n; i++) {
    if (metas[i].kind === KIND_FRAME) lastFrame.set(metas[i].handle ?? `\u0000anon#${i}`, i);
  }
  const keptFrames = new Set(lastFrame.values());
  for (let i = 0; i < n; i++) {
    if (metas[i].kind === KIND_STREAM) keep[i] = false;
    else if (metas[i].kind === KIND_FRAME && !keptFrames.has(i)) keep[i] = false;
  }

  // id → 行号（重复 id 取后者，与 pi 的 byId.set 覆盖口径一致）
  const idIndex = new Map();
  for (let i = 0; i < n; i++) if (metas[i].id !== null) idIndex.set(metas[i].id, i);

  // 旧 leaf 路径（含被删节点）：pi 的 leaf = 文件里最后一条有 id 的 entry
  let leafIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (metas[i].id !== null) {
      leafIdx = i;
      break;
    }
  }
  const oldPath = [];
  {
    const seen = new Set();
    let i = leafIdx;
    while (i >= 0) {
      const m = metas[i];
      if (m.id === null || seen.has(m.id)) break;
      seen.add(m.id);
      oldPath.push(i);
      if (m.parentId === null) break;
      const p = idIndex.get(m.parentId);
      i = p === undefined ? -1 : p;
    }
    oldPath.reverse();
  }
  const oldPathPos = new Map();
  oldPath.forEach((idx, k) => oldPathPos.set(metas[idx].id, k));

  // 引用修复表：行号 → { 字段: 新值 }
  const fixes = new Map();
  const addFix = (i, field, value) => {
    const f = fixes.get(i) ?? {};
    f[field] = value;
    fixes.set(i, f);
  };

  /** 上溯到最近存活祖先（修法 1）。指向不存在的 id（历史坏链）或成环 → 不动，原样留着。 */
  const ancestorOf = (startId) => {
    const seen = new Set();
    let cur = startId;
    while (cur != null) {
      if (seen.has(cur)) return { changed: false };
      seen.add(cur);
      const idx = idIndex.get(cur);
      if (idx === undefined) return { changed: false };
      if (keep[idx]) return { changed: cur !== startId, id: cur };
      cur = metas[idx].parentId;
    }
    return { changed: true, id: null }; // 祖先被删干净 → 落到根
  };

  /** compaction 落点修复（清单外第 7 条）：目标被删时沿旧路径往后取第一个存活节点，
   *  保持「从此往后全收」的语义；不修的话压缩点之前的上下文会被静默丢掉。 */
  const keptAfterOnOldPath = (id) => {
    const pos = oldPathPos.get(id);
    if (pos === undefined) return { changed: false }; // 本就不在 leaf 路径上 → 语义本就不生效，不动
    for (let k = pos + 1; k < oldPath.length; k++) {
      const j = oldPath[k];
      if (keep[j]) return { changed: true, id: metas[j].id };
    }
    return { changed: false }; // 其后全被删：compaction 之后的节点照样会被收录，悬空无害
  };

  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const m = metas[i];
    if (m.parentId != null) {
      const r = ancestorOf(m.parentId);
      if (r.changed) addFix(i, "parentId", r.id);
    }
    if (m.fromId != null) {
      const r = ancestorOf(m.fromId);
      if (r.changed) addFix(i, "fromId", r.id);
    }
    if (m.firstKept != null) {
      const r = keptAfterOnOldPath(m.firstKept);
      if (r.changed) addFix(i, "firstKeptEntryId", r.id);
    }
  }

  // 测试钩子：跳过父链修复，复现 2026-11-18 那个「只删行不重接」的灾难，
  // 用来验「自检/守卫不过 → 自动回滚」这条治安网是真的会响。正常使用不设。
  if (process.env.SLIM_TEST_SKIP_REPARENT === "1") fixes.clear();

  // ── B 趟：算最终字节 / 哈希，apply 时同时写 tmp ──
  const w = apply ? new AtomicWriter(file) : null;
  const hash = crypto.createHash("sha256");
  let after = 0;
  let keptLines = 0;
  let patched = 0;
  let droppedFrames = 0;
  let droppedStreams = 0;
  let seen = 0;
  try {
    for await (const { line, bytes } of readLines(file)) {
      const idx = seen++;
      const m = metas[idx];
      if (!m) throw new Error(`行数与扫描结果不一致（扫描 ${n} 行，本趟多出第 ${idx + 1} 行）——迁移期间文件被改写过`);
      if (!keep[idx]) {
        if (m.kind === KIND_STREAM) droppedStreams += bytes;
        else droppedFrames += bytes;
        continue;
      }
      let text = line;
      const fix = fixes.get(idx);
      if (fix) {
        const o = JSON.parse(line);
        for (const [k, v] of Object.entries(fix)) o[k] = v;
        text = JSON.stringify(o);
        patched++;
      }
      const chunk = `${text}\n`;
      after += Buffer.byteLength(chunk);
      hash.update(chunk);
      keptLines++;
      if (w) {
        w.write(chunk);
        // 断电模拟：写到第 N 条保留行就硬死自己（此时只写了 tmp，.bak 没落、rename 没做、
        // 连 flush/fsync 都没走——process.exit 不走 finally，也不刷我们自己的写缓冲）
        if (crashAfterLines > 0 && keptLines >= crashAfterLines) process.exit(137);
      }
    }
    if (seen !== n) throw new Error(`行数不一致：扫描 ${n} 行，写入趟读到 ${seen} 行——迁移期间文件被改写过`);
    if (w) {
      const tmp = w.finish();
      if (crashPoint === "before-bak") process.exit(137);
      atomicCopy(file, `${file}.bak`); // 备份就位后才允许换名（修法 2）
      if (crashPoint === "before-rename") process.exit(137);
      fs.renameSync(tmp, file);
    }
  } catch (e) {
    w?.abort();
    throw e;
  }

  const expect = {
    lines: keptLines,
    hash: hash.digest("hex"),
    handles: lastFrame,
    reachable: oldPath.filter((idx) => keep[idx]).length,
  };

  if (apply) {
    try {
      await guardSession(file, expect);
      const beforePi = await measureWithPi(`${file}.bak`);
      const afterPi = await measureWithPi(file);
      assertSelfCheck(beforePi, afterPi, expect);
    } catch (e) {
      atomicCopy(`${file}.bak`, file); // 自动回滚（修法 4）
      e.message = `自检失败，已从 .bak 回滚：${e.message}`;
      e.fatal = true;
      throw e;
    }
  }

  return {
    before,
    after,
    keptLines,
    patched,
    droppedFrames,
    droppedStreams,
    reachable: expect.reachable,
    oldPathLen: oldPath.length,
    handles: lastFrame.size,
  };
}

/** 终态守卫（修法 5）：重读产物。逐行哈希必须等于预期（保证「该删的删净、不该删的一条没动」），
 *  并查结构：无悬空 parentId、无残留 stream 帧、每个 handle 恰好一帧。 */
async function guardSession(file, expect) {
  const hash = crypto.createHash("sha256");
  const ids = new Set();
  const parents = [];
  const handleCounts = new Map();
  let lines = 0;
  let streams = 0;
  for await (const { line } of readLines(file)) {
    lines++;
    hash.update(`${line}\n`);
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    if (typeof o.id === "string") ids.add(o.id);
    if (o.parentId != null) parents.push(o.parentId);
    if (o.type === "custom" && o.customType === "subagent-async-stream") streams++;
    if (o.type === "custom" && o.customType === "subagent-async") {
      const key = typeof o.data?.handle === "string" ? o.data.handle : "\u0000anon";
      handleCounts.set(key, (handleCounts.get(key) ?? 0) + 1);
    }
  }
  if (lines !== expect.lines) throw new Error(`终态守卫：产物 ${lines} 行，预期 ${expect.lines} 行`);
  const got = hash.digest("hex");
  if (got !== expect.hash) throw new Error(`终态守卫：产物哈希 ${got.slice(0, 12)} ≠ 预期 ${expect.hash.slice(0, 12)}（内容与计划不一致）`);
  if (streams !== 0) throw new Error(`终态守卫：残留 ${streams} 条 subagent-async-stream 帧`);
  const dangling = parents.filter((p) => !ids.has(p));
  if (dangling.length) throw new Error(`终态守卫：${dangling.length} 个 parentId 悬空（如 ${dangling[0]}）——祖先链被剪断`);
  for (const h of expect.handles.keys()) {
    if (h.startsWith("\u0000anon")) continue;
    const c = handleCounts.get(h) ?? 0;
    if (c !== 1) throw new Error(`终态守卫：handle ${h} 的帧应为 1 条，实际 ${c} 条`);
  }
}

/** 用 pi 自带的 SessionManager 量指标（自检用）——上下文到底能不能读出来，它才是最终裁判。 */
async function measureWithPi(file) {
  const pi = await import("@earendil-works/pi-coding-agent");
  const current = pi.CURRENT_SESSION_VERSION ?? 3;
  let version = 1;
  try {
    version = JSON.parse(firstLine(file))?.version ?? 1;
  } catch {
    /* 读不出头就当老版本，走拷贝 */
  }
  // 老版本会话一 open 就会被 pi 自己原地重写（migrateToCurrentVersion → _rewriteFile，非原子写），
  // 绝不能在真文件上发生——拷到临时目录再量。
  let probe = file;
  let tmpDir = null;
  if (version < current) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slim-check-"));
    probe = path.join(tmpDir, "session.jsonl");
    fs.copyFileSync(file, probe);
  }
  try {
    const sm = pi.SessionManager.open(probe);
    const proj = sm.buildSessionProjection();
    return {
      messages: proj.messages.length,
      hash: crypto.createHash("sha256").update(JSON.stringify(proj.messages)).digest("hex"),
      thinkingLevel: proj.thinkingLevel,
      model: proj.model,
      reachable: sm.getBranch().length,
      entries: sm.getEntryCount(),
    };
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function firstLine(file) {
  const buf = Buffer.alloc(4096);
  const fd = fs.openSync(file, "r");
  try {
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    const s = buf.subarray(0, got).toString("utf8");
    const nl = s.indexOf("\n");
    return nl >= 0 ? s.slice(0, nl) : s;
  } finally {
    fs.closeSync(fd);
  }
}

/** 自检判据（修法 4）：上下文条数 / 内容哈希 / thinkingLevel / model / 可达节点数，一个字都不能差。 */
function assertSelfCheck(beforePi, afterPi, expect) {
  if (afterPi.messages !== beforePi.messages) throw new Error(`上下文条数 ${beforePi.messages} → ${afterPi.messages}`);
  if (afterPi.hash !== beforePi.hash) throw new Error(`上下文内容哈希变了（${beforePi.hash.slice(0, 12)} → ${afterPi.hash.slice(0, 12)}）`);
  if (afterPi.thinkingLevel !== beforePi.thinkingLevel) throw new Error(`thinkingLevel ${beforePi.thinkingLevel} → ${afterPi.thinkingLevel}`);
  if (JSON.stringify(afterPi.model) !== JSON.stringify(beforePi.model))
    throw new Error(`model ${JSON.stringify(beforePi.model)} → ${JSON.stringify(afterPi.model)}`);
  if (afterPi.reachable !== expect.reachable) throw new Error(`从 leaf 可达 ${afterPi.reachable} 条，预期 ${expect.reachable} 条——祖先链没接全`);
}

/** frames.jsonl：一行一帧，面板重放只读最后一行 → 留最后一行，其余全删（共步原子替换 + 终态守卫）。 */
async function slimFrames(file) {
  const before = fs.statSync(file).size;
  let lastLine = null;
  let lines = 0;
  for await (const { line } of readLines(file)) {
    lastLine = line;
    lines++;
  }
  if (lastLine === null) return { before, after: before, lines: 0, note: "空文件，未动" };
  const chunk = `${lastLine}\n`;
  const after = Buffer.byteLength(chunk);
  if (apply) {
    const w = new AtomicWriter(file);
    try {
      w.write(chunk);
      const tmp = w.finish();
      atomicCopy(file, `${file}.bak`);
      fs.renameSync(tmp, file);
    } catch (e) {
      w.abort();
      throw e;
    }
    // 终态守卫：产物必须逐字节等于「输入的最后一行」
    const got = fs.readFileSync(file, "utf8");
    if (got !== chunk) {
      atomicCopy(`${file}.bak`, file);
      const e = new Error(`自检失败，已从 .bak 回滚：frames.jsonl 终态守卫不一致（产物 ${got.length}B ≠ 预期 ${chunk.length}B）`);
      e.fatal = true;
      throw e;
    }
  }
  return { before, after, lines, note: `${lines} 行帧 → 留最后 1 行（终态守卫已验）` };
}

const list = targets();
if (!list.length) {
  console.log(`没有找到 >${minMb}MB 的会话/帧文件（${sessionsRoot}）`);
  process.exit(0);
}

// 入口守卫（工单40）：--apply 打到真实会话根（未给路径 = 默认扫根；或显式给了根下文件）时必须
// 二次确认 --force-real。干跑不拦（平时就是用来看统计的），非 sessions 路径的 --apply 也不拦。
if (apply && !forceReal) {
  const rel = (p) => path.relative(sessionsRoot, p);
  const insideRoot = (p) => {
    const r = rel(p);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  const hits = explicit.length ? list.filter(insideRoot) : list;
  if (hits.length) {
    const totalBytes = hits.reduce((s, f) => {
      try {
        return s + fs.statSync(f).size;
      } catch {
        return s;
      }
    }, 0);
    const why = explicit.length ? "目标落在真实会话根下" : "没给路径，默认目标就是真实会话根";
    console.error("[拒绝执行] 这是对真实会话目录的破坏性改写，需要二次确认：");
    console.error(`  ${why}：${sessionsRoot}`);
    console.error(`  本次会改写 ${hits.length} 个文件，合计 ${(totalBytes / 1e6).toFixed(1)}MB（逐个原子替换 + 落 .bak，自检不过会回滚）`);
    for (const f of hits.slice(0, 5)) console.error(`    - ${f}`);
    if (hits.length > 5) console.error(`    …另 ${hits.length - 5} 个`);
    console.error("确认要动真实会话，再加 --force-real 重跑：");
    console.error(`  node ${path.basename(process.argv[1] ?? "slim-subagent-frames.mjs")} --apply --force-real`);
    console.error("更稳的姿势：先单文件小范围试 `--apply <某个会话 .jsonl>`，确认无误再扩到整个根。");
    process.exit(1);
  }
}

// 修法 3：.bak 存在即拒跑。先整体体检：一个不合格就一个文件都不动。
if (apply) {
  const blocked = list.filter((f) => fs.existsSync(`${f}.bak`));
  if (blocked.length) {
    console.error("[拒绝执行] 下面这些文件已有 .bak，说明之前 apply 过（或上次中途失败）：");
    for (const f of blocked) console.error(`  - ${f}.bak`);
    console.error("确认原文件无误后手工删掉 .bak 再来：重复 apply 会二次剪枝，一律拒跑。");
    process.exit(1);
  }
  // 上次中断留下的 tmp 直接清掉（原文件没被改过才可能留下它）
  for (const f of list) {
    try {
      fs.unlinkSync(`${f}.slim-tmp`);
    } catch {
      /* 没有就算了 */
    }
  }
}

let saved = 0;
let failed = 0;

// 进度提示（攒包1，2026-11-19）：不给路径时默认目标就是真实会话根（本机 4.1GB / 488 个文件），
// 逐个流式扫完才出结果，中途几十秒没有任何输出，用户会以为卡死。所以每处理完一批就往 **stderr**
// 打一行（stdout 留给结果，不能破坏可解析性）。纯观测：不参与任何判定，干跑与 --apply 都打。
const humanSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)}GB` : `${(b / 1e6).toFixed(1)}MB`);
let doneFiles = 0;
let doneBytes = 0;
let lastTickBytes = 0;
function scanTick(bytes) {
  doneFiles++;
  doneBytes += bytes;
  // 第一条立刻报总数（用户最想知道「一共多少」），之后每 50 个文件或 200MB 一条，收尾再报一条
  if (doneFiles === 1 || doneFiles % 50 === 0 || doneBytes - lastTickBytes >= 200e6 || doneFiles === list.length) {
    lastTickBytes = doneBytes;
    console.error(`[扫描] 已处理 ${doneFiles}/${list.length} 个文件 ${humanSize(doneBytes)}`);
  }
}

for (const file of list) {
  const isFrames = path.basename(file) === "frames.jsonl";
  try {
    const r = await (isFrames ? slimFrames(file) : slimSession(file));
    scanTick(r.before);
    const pct = r.before ? (100 * (r.before - r.after)) / r.before : 0;
    const detail = isFrames
      ? `       ${r.note ?? ""}`
      : `       行 ${r.keptLines}（改引用 ${r.patched} 行），丢旧帧 ${(r.droppedFrames / 1e6).toFixed(1)}MB / delta 流 ${(r.droppedStreams / 1e6).toFixed(1)}MB` +
        `，leaf 可达 ${r.reachable}/${r.oldPathLen} 条，帧 handle ${r.handles} 个`;
    console.log(
      `${apply ? "[改]" : "[干跑]"} ${file}\n` +
        `       ${(r.before / 1e6).toFixed(1)}MB → ${(r.after / 1e6).toFixed(2)}MB（省 ${pct.toFixed(0)}%）\n` +
        detail
    );
    if (apply && !isFrames) console.log("       自检通过：上下文条数 / 内容哈希 / thinkingLevel / model / 可达数均与 .bak 一致");
    saved += r.before - r.after;
  } catch (e) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* 量不到就按 0 计，进度只是观测 */
    }
    scanTick(size);
    console.error(`[失败] ${file}: ${e?.message ?? e}`);
    if (e?.fatal) {
      failed++;
      console.error("自检/守卫不过，后续文件一律不动——先查清原因，不要放着继续洗。");
      break;
    }
  }
}
console.log(`\n合计可省 ${(saved / 1e6).toFixed(1)}MB${apply ? "（已写 .bak 备份，确认无误后可自行删除）" : "（干跑，未改任何文件；加 --apply 才真改）"}`);
if (failed) process.exit(1);
