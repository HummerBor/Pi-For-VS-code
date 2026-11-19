/**
 * slim-subagent-frames 迁移脚本用例（工单36，2026-11-19）。
 *
 * 为什么要有：这个脚本对**真实会话文件**做破坏性改写。2026-11-18 的旧版实测把一份 299MB 会话的
 * 上下文从 566 条洗成 21 条（parentId 父链被剪断，pi 从 leaf 往根走不回去）。这种错只有在
 * 「会话还能不能被 pi 读回来」这一层才看得见——所以本用例的裁判是 pi 自带的 SessionManager，
 * 不是脚本自己的算术。样本是现造的（$TEMP 下临时目录），跑完就删，**不碰 ~/.pi/agent/sessions**。
 *
 * 判据：
 *   ① --apply 前后 SessionManager 读出的上下文条数 / 内容哈希 / thinkingLevel / model 完全一致
 *   ② 从 leaf 可达节点 = 保留节点数（祖先链必须接全）
 *   ③ 每个 handle 只剩最后一帧（不是第一帧），stream 帧删净
 *   ④ 不该删的行（消息 / toolResult / 别的 custom entry / label）一条不动、内容不变
 *   ⑤ .bak 生成且与原文件逐字节一致；.bak 存在时二次 apply 拒跑（退出码 ≠0）
 *   ⑥ 断电模拟（写 tmp 途中 SIGKILL）：原文件不被破坏、不留半成品覆盖
 *   ⑦ compaction.firstKeptEntryId 指向被删帧时重映射，压缩点之后的上下文一条不丢
 *   ⑧ frames.jsonl 只留最后一行，且逐字节一致
 *   ⑨ 无帧样本 apply 后逐字节不变（不制造无意义改写）
 *   ⑩ 入口守卫（工单40）：--apply 打到真实会话根必须二次确认 --force-real；干跑与显式非 sessions
 *      路径不受影响。真实根一律用临时 HOME（USERPROFILE）顶替，**从不碰真实 ~/.pi/agent/sessions**。
 *
 * 跑法：node scripts/test/slimFrames.test.mjs（不进构建链，不需要 npm script）
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "migrate", "slim-subagent-frames.mjs");
const TS = "2026-11-18T10:00:00.000Z";
const PAD = "A".repeat(40 * 1024); // 每帧夹 40KB「base64 截图」，模拟真实帧体积
const MODEL = { provider: "anthropic", model: "claude-sonnet-4-5" };

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const read = (f) => fs.readFileSync(f, "utf8");
const linesOf = (f) => read(f).split("\n").filter((l) => l.length > 0);
const parseAll = (f) => linesOf(f).map((l) => JSON.parse(l));
const isFrame = (o) => o.type === "custom" && o.customType === "subagent-async";
const isStream = (o) => o.type === "custom" && o.customType === "subagent-async-stream";

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

/** 用 pi 自己的加载器量会话（裁判口径） */
async function measure(file) {
  const pi = await import("@earendil-works/pi-coding-agent");
  const sm = pi.SessionManager.open(file);
  const proj = sm.buildSessionProjection();
  return {
    n: proj.messages.length,
    messages: proj.messages,
    hash: sha(JSON.stringify(proj.messages)),
    thinkingLevel: proj.thinkingLevel,
    model: proj.model,
    reachable: sm.getBranch().length,
    entries: sm.getEntryCount(),
  };
}

/** 造样本：一条线性会话链，帧/stream 夹在消息之间（真实形态），尾部落一条 stream */
function buildSession(dir, { turns = 24 } = {}) {
  const lines = [];
  const ids = { messages: [], frames: [], streams: [], notes: [] };
  let leaf = null;
  let seq = 0;
  const nid = () => `e${String(++seq).padStart(3, "0")}`;
  const add = (type, extra = {}) => {
    const entry = { type, id: nid(), parentId: leaf, timestamp: TS, ...extra };
    lines.push(JSON.stringify(entry));
    leaf = entry.id;
    return entry;
  };
  const message = (role, text, extra = {}) => {
    const e = add("message", { message: { role, content: [{ type: "text", text }], timestamp: TS, ...extra } });
    ids.messages.push(e.id);
    return e;
  };

  lines.push(JSON.stringify({ type: "session", version: 3, id: "sess-t36", timestamp: TS, cwd: dir }));
  add("thinking_level_change", { thinkingLevel: "high" });
  add("model_change", { provider: MODEL.provider, modelId: MODEL.model });
  const first = message("user", "u0");
  add("label", { targetId: first.id, label: "起点" }); // label 引用早期 entry：必须原样保留

  for (let t = 0; t < turns; t++) {
    const h = `h${(t % 3) + 1}`;
    ids.frames.push(
      add("custom", {
        customType: "subagent-async",
        data: { handle: h, status: t < turns - 1 ? "running" : "done", seq: t, shot: PAD },
      }).id
    );
    ids.streams.push(add("custom", { customType: "subagent-async-stream", data: { handle: h, delta: "chunk", shot: PAD } }).id);
    message("assistant", `a${t}`, MODEL);
    // 正文里恰好带 "subagent-async-stream" 这串字的 toolResult：旧版 include() 判类型会把它当帧删掉
    if (t % 4 === 3) message("toolResult", `工具输出里就写着 subagent-async-stream 这串字 t=${t}`);
    if (t % 5 === 4) ids.notes.push(add("custom", { customType: "subagent-note", data: { note: `n${t}` } }).id);
  }
  // 尾巴：最后一帧 + 一条 stream → leaf 落在被删节点上（旧版最狠的剪断点）
  ids.frames.push(add("custom", { customType: "subagent-async", data: { handle: "h1", status: "done", seq: 999, shot: PAD } }).id);
  ids.streams.push(add("custom", { customType: "subagent-async-stream", data: { handle: "h1", delta: "tail", shot: PAD } }).id);

  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, ids, lines };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slim-frames-"));
console.log(`样本根目录（$TEMP，跑完删）：${root}`);

try {
  // ─────────── 主样本：完整 apply 一轮 ───────────
  const a = fs.mkdtempSync(path.join(root, "a-"));
  const sample = buildSession(a);
  const beforeRaw = read(sample.file);
  const beforeBytes = Buffer.byteLength(beforeRaw);
  const beforeA = await measure(sample.file);
  console.log(`改前：${(beforeBytes / 1e6).toFixed(2)}MB，行 ${linesOf(sample.file).length}，上下文 ${beforeA.n} 条，thinkingLevel ${beforeA.thinkingLevel}，可达 ${beforeA.reachable}/${beforeA.entries}`);

  // 干跑：一个字节都不许动
  const dry = run([sample.file]);
  assert.equal(dry.status, 0, `干跑应退出 0，实际 ${dry.status}：${dry.stderr}`);
  assert.equal(read(sample.file), beforeRaw, "① 干跑不许改文件");
  assert.equal(fs.existsSync(`${sample.file}.bak`), false, "① 干跑不许落 .bak");
  assert.match(dry.stdout, /干跑/, "① 干跑应标明是干跑");
  console.log(`干跑：退出 ${dry.status}，文件字节未变，无 .bak`);

  // 真改
  const ap = run(["--apply", sample.file]);
  assert.equal(ap.status, 0, `apply 应退出 0，实际 ${ap.status}\n${ap.stderr}`);
  const afterRaw = read(sample.file);
  const afterBytes = Buffer.byteLength(afterRaw);
  const afterA = await measure(sample.file);
  console.log(ap.stdout.trim());
  console.log(`改后：${(afterBytes / 1e6).toFixed(2)}MB，行 ${linesOf(sample.file).length}，上下文 ${afterA.n} 条，thinkingLevel ${afterA.thinkingLevel}，可达 ${afterA.reachable}/${afterA.entries}`);

  // ① 上下文条数 / 内容哈希 / thinkingLevel / model 一个都不能变（旧版这里 566→21）
  assert.equal(afterA.n, beforeA.n, "① 上下文条数必须完全相等");
  assert.equal(afterA.hash, beforeA.hash, "① 上下文内容哈希必须完全相等");
  assert.equal(afterA.thinkingLevel, "high", "① thinkingLevel 不许退化");
  assert.equal(afterA.thinkingLevel, beforeA.thinkingLevel, "① thinkingLevel 必须相等");
  assert.deepEqual(afterA.model, beforeA.model, "① model 必须相等");
  assert.equal(afterA.n, sample.ids.messages.length, "① 上下文条数应等于消息 entry 数（无压缩）");
  console.log(`① 复原：上下文 ${beforeA.n} → ${afterA.n} 条，哈希一致，thinkingLevel ${afterA.thinkingLevel}，model ${JSON.stringify(afterA.model)}`);

  // ② 祖先链接全：可达节点 = 产物里的 entry 数（删掉的帧本就不该再占节点，数少才是对的）
  const newEntries = parseAll(sample.file).filter((o) => o.type !== "session");
  const newIds = new Set(newEntries.map((o) => o.id));
  assert.equal(afterA.reachable, afterA.entries, "② 从 leaf 可达 = 全部 entry 数（没有断链）");
  assert.equal(afterA.reachable, newEntries.length, "② 可达节点数应等于产物 entry 数");
  assert.equal(
    beforeA.entries - afterA.entries,
    sample.ids.streams.length + (sample.ids.frames.length - 3),
    "② 只该少掉被删的帧：stream 全删 + 每 handle 再多删 1 帧"
  );
  const dangling = newEntries.filter((o) => o.parentId != null && !newIds.has(o.parentId));
  assert.equal(dangling.length, 0, `② 不许有悬空 parentId（有 ${dangling.length} 个）`);
  console.log(`② 祖先链：可达 ${afterA.reachable} 条 = entry ${afterA.entries} 条，悬空 parentId 0 个`);

  // ③ 帧去留：每 handle 一帧且是最后一帧；stream 删净
  const newFrames = newEntries.filter(isFrame);
  const perHandle = new Map();
  for (const f of newFrames) perHandle.set(f.data.handle, (perHandle.get(f.data.handle) ?? 0) + 1);
  assert.deepEqual([...perHandle.entries()].sort(), [["h1", 1], ["h2", 1], ["h3", 1]], "③ 每个 handle 恰好一帧");
  assert.equal(newFrames.find((f) => f.data.handle === "h1").data.seq, 999, "③ 留下的是最后一帧（seq 999），不是第一帧");
  assert.equal(newEntries.filter(isStream).length, 0, "③ stream 帧必须删净");
  console.log(`③ 帧：handle ${[...perHandle.keys()].sort().join("/")} 各 1 帧，h1 留 seq=999（最后一帧），stream 残留 0`);

  // ④ 不该删的一条不动：非帧行的对象与原文件逐条深相等（只有父链引用可能被改写）
  const beforeObjs = parseAll(`${sample.file}.bak`).filter((o) => o.type !== "session" && !isFrame(o) && !isStream(o));
  const afterObjs = newEntries.filter((o) => !isFrame(o) && !isStream(o));
  assert.equal(afterObjs.length, beforeObjs.length, "④ 非帧行数必须相等");
  for (let i = 0; i < beforeObjs.length; i++) {
    const b = { ...beforeObjs[i] };
    const x = { ...afterObjs[i] };
    if (b.parentId !== x.parentId) {
      // 只允许「上溯压缩」这一种改写，且新父必须本来是它的祖先
      assert.ok(newIds.has(x.parentId), `④ 改写后的 parentId ${x.parentId} 必须存在`);
    }
    delete b.parentId;
    delete x.parentId;
    assert.deepEqual(x, b, `④ 非帧行 ${beforeObjs[i].id} 的内容被改了`);
  }
  const literalLine = newEntries.find((o) => o.type === "message" && o.message.role === "toolResult");
  assert.ok(literalLine, "④ 正文带 subagent-async-stream 的 toolResult 必须还在（旧版会误删）");
  assert.match(literalLine.message.content[0].text, /subagent-async-stream/, "④ 该 toolResult 内容未被改");
  assert.equal(newEntries.filter((o) => o.customType === "subagent-note").length, sample.ids.notes.length, "④ 别的 custom entry 一条不少");
  assert.equal(newEntries.filter((o) => o.type === "label").length, 1, "④ label entry 还在");
  console.log(`④ 不该删的：${afterObjs.length} 条非帧行内容全同，带 subagent-async-stream 的 toolResult 在，note ${sample.ids.notes.length} 条在，label 1 条在`);

  // 体积
  const pct = (100 * (beforeBytes - afterBytes)) / beforeBytes;
  assert.ok(pct > 70, `体积应显著下降，实际只省 ${pct.toFixed(1)}%`);
  console.log(`　 体积：${(beforeBytes / 1e6).toFixed(2)}MB → ${(afterBytes / 1e6).toFixed(2)}MB（-${pct.toFixed(1)}%）`);

  // ⑤ .bak 逐字节等于改前；二次 apply 拒跑
  assert.ok(fs.existsSync(`${sample.file}.bak`), "⑤ 必须落 .bak");
  assert.equal(sha(read(`${sample.file}.bak`)), sha(beforeRaw), "⑤ .bak 必须与改前逐字节一致");
  const again = run(["--apply", sample.file]);
  assert.notEqual(again.status, 0, "⑤ .bak 存在时二次 apply 必须拒跑（退出码 ≠0）");
  assert.match(again.stderr, /拒绝执行/, "⑤ 拒跑要有明确提示");
  assert.equal(read(sample.file), afterRaw, "⑤ 拒跑时文件不许再动");
  console.log(`⑤ .bak 逐字节一致（${(beforeBytes / 1e6).toFixed(2)}MB）；二次 apply 退出码 ${again.status}，文件未动`);

  // ─────────── ⑥ 断电模拟：写 tmp 途中硬死（不 flush/不 fsync/不 rename） ───────────
  const c = fs.mkdtempSync(path.join(root, "c-"));
  const crashSample = buildSession(c, { turns: 6 });
  const crashRaw = read(crashSample.file);
  const crash = run(["--apply", crashSample.file], { SLIM_TEST_CRASH_AFTER_LINES: "3" });
  assert.equal(crash.status, 137, `⑥ 应在写 tmp 途中硬死（实际 status=${crash.status} signal=${crash.signal} stderr=${crash.stderr}）`);
  assert.equal(read(crashSample.file), crashRaw, "⑥ 断电后原文件必须一字节不差");
  assert.equal(fs.existsSync(`${crashSample.file}.bak`), false, "⑥ tmp 阶段断电不许落 .bak（否则二次 apply 会被自己挡住）");
  assert.equal(fs.existsSync(`${crashSample.file}.slim-tmp`), true, "⑥ 断电只该留下 tmp 残留");
  assert.ok(fs.statSync(`${crashSample.file}.slim-tmp`).size < Buffer.byteLength(crashRaw), "⑥ tmp 残留不可能是完整产物（fsync/rename 都没走）");
  console.log(
    `⑥ 断电模拟：进程退出 ${crash.status}，原文件 ${(Buffer.byteLength(crashRaw) / 1e6).toFixed(2)}MB 字节未变，` +
      `无 .bak，仅留 ${fs.statSync(`${crashSample.file}.slim-tmp`).size}B 的 .slim-tmp（未 fsync、未 rename）`
  );
  // 断电后重跑必须能正常收工（tmp 自动清掉）
  const rerun = run(["--apply", crashSample.file]);
  assert.equal(rerun.status, 0, `⑥ 断电后重跑应成功：${rerun.stderr}`);
  assert.equal(fs.existsSync(`${crashSample.file}.slim-tmp`), false, "⑥ 重跑后 tmp 必须被清掉");
  const crashBefore = await measure(`${crashSample.file}.bak`);
  const crashAfter = await measure(crashSample.file);
  assert.equal(crashAfter.n, crashBefore.n, "⑥ 重跑后上下文条数一致");
  console.log(`⑥ 断电后重跑：退出 0，上下文 ${crashBefore.n} → ${crashAfter.n} 条，tmp 已清`);

  // ⑥b 断电：tmp 写好并 fsync 了，但备份还没落 → 原文件不许动、不许有 .bak
  const c2 = fs.mkdtempSync(path.join(root, "c2-"));
  const bSample = buildSession(c2, { turns: 6 });
  const bRaw = read(bSample.file);
  const bRun = run(["--apply", bSample.file], { SLIM_TEST_CRASH_POINT: "before-bak" });
  assert.equal(bRun.status, 137, `⑥b 应在备份前硬死（实际 ${bRun.status}）`);
  assert.equal(read(bSample.file), bRaw, "⑥b 原文件必须一字节不差");
  assert.equal(fs.existsSync(`${bSample.file}.bak`), false, "⑥b 备份前断电不许落 .bak");
  const bTmpSize = fs.statSync(`${bSample.file}.slim-tmp`).size;
  assert.ok(bTmpSize > 0 && bTmpSize < Buffer.byteLength(bRaw), "⑥b 残留应是完整产物（已 fsync），但没 rename 就永远不算数");
  const bRerun = run(["--apply", bSample.file]);
  assert.equal(bRerun.status, 0, `⑥b 重跑应成功：${bRerun.stderr}`);
  const bBefore = await measure(`${bSample.file}.bak`);
  const bAfter = await measure(bSample.file);
  assert.equal(bAfter.n, bBefore.n, "⑥b 重跑后上下文条数一致");
  console.log(`⑥b 备份前断电：退出 ${bRun.status}，原文件未动、无 .bak，残留完整 tmp ${bTmpSize}B（未 rename）；重跑退出 0，上下文 ${bBefore.n} → ${bAfter.n} 条`);

  // ⑥c 断电：备份已落、rename 还没做 → 原文件仍不许动；重跑会被 .bak 拒跑（安全但需人处理）
  const c3 = fs.mkdtempSync(path.join(root, "c3-"));
  const dSample = buildSession(c3, { turns: 6 });
  const dRaw = read(dSample.file);
  const dRun = run(["--apply", dSample.file], { SLIM_TEST_CRASH_POINT: "before-rename" });
  assert.equal(dRun.status, 137, `⑥c 应在换名前硬死（实际 ${dRun.status}）`);
  assert.equal(read(dSample.file), dRaw, "⑥c 原文件必须一字节不差");
  assert.equal(read(`${dSample.file}.bak`), dRaw, "⑥c .bak 与改前逐字节一致");
  const dBlocked = run(["--apply", dSample.file]);
  assert.equal(dBlocked.status, 1, "⑥c 有 .bak 时重跑必须拒跑");
  assert.equal(read(dSample.file), dRaw, "⑥c 拒跑时原文件不许动");
  fs.unlinkSync(`${dSample.file}.bak`); // 人工确认后删 .bak
  const dRerun = run(["--apply", dSample.file]);
  assert.equal(dRerun.status, 0, `⑥c 删 .bak 后重跑应成功：${dRerun.stderr}`);
  assert.equal((await measure(dSample.file)).n, (await measure(`${dSample.file}.bak`)).n, "⑥c 恢复后上下文条数一致");
  console.log(`⑥c 换名前断电：退出 ${dRun.status}，原文件未动、.bak 已落；重跑被拒（退出 ${dBlocked.status}），删 .bak 后重跑退出 0`);

  // ─────────── ⑥d 治安网：故意不重接父链（复现旧 bug）→ 必须自检不过 + 自动回滚 ───────────
  const g = fs.mkdtempSync(path.join(root, "g-"));
  const gSample = buildSession(g, { turns: 8 });
  const gRaw = read(gSample.file);
  const gRun = run(["--apply", gSample.file], { SLIM_TEST_SKIP_REPARENT: "1" });
  assert.equal(gRun.status, 1, `⑥d 只删行不重接必须被挡住（实际退出 ${gRun.status}，stdout=${gRun.stdout}）`);
  assert.match(gRun.stderr, /自检失败.*回滚/, "⑥d 必须报「自检失败，已回滚」");
  assert.equal(read(gSample.file), gRaw, "⑥d 回滚后必须与改前逐字节一致");
  console.log(`⑥d 治安网：故意跳过父链修复 → 退出 ${gRun.status}，${gRun.stderr.trim().split("\n").at(-2) ?? gRun.stderr.trim()}；原文件逐字节回到改前`);

  // ─────────── ⑦ compaction.firstKeptEntryId 指向被删帧 ───────────
  const d = fs.mkdtempSync(path.join(root, "d-"));
  const compLines = [];
  let leaf = null;
  let n = 0;
  const cid = () => `c${++n}`;
  const push = (type, extra = {}) => {
    const e = { type, id: cid(), parentId: leaf, timestamp: TS, ...extra };
    compLines.push(JSON.stringify(e));
    leaf = e.id;
    return e;
  };
  compLines.push(JSON.stringify({ type: "session", version: 3, id: "sess-comp", timestamp: TS, cwd: d }));
  push("thinking_level_change", { thinkingLevel: "high" });
  push("message", { message: { role: "user", content: [{ type: "text", text: "u-summarized" }], timestamp: TS } });
  push("custom", { customType: "subagent-async-stream", data: { handle: "hx", delta: "boundary", shot: PAD } }); // 压缩落点正好是它
  const keptMsg = push("message", { message: { role: "assistant", content: [{ type: "text", text: "a-kept" }], timestamp: TS, ...MODEL } });
  push("message", { message: { role: "user", content: [{ type: "text", text: "u-after" }], timestamp: TS } });
  push("compaction", { summary: "前面都被压缩了", firstKeptEntryId: "c3", tokensBefore: 1234 });
  const compFile = path.join(d, "session.jsonl");
  fs.writeFileSync(compFile, compLines.join("\n") + "\n");
  const compBefore = await measure(compFile);
  const compRun = run(["--apply", compFile]);
  assert.equal(compRun.status, 0, `⑦ apply 应退出 0：${compRun.stderr}`);
  const compAfter = await measure(compFile);
  assert.equal(compAfter.n, compBefore.n, "⑦ compaction 会话上下文条数必须相等");
  assert.ok(compAfter.n >= 3, `⑦ 压缩点之后的上下文不许丢（现在只剩 ${compAfter.n} 条，说明 firstKeptEntryId 悬空）`);
  assert.equal(compAfter.hash, compBefore.hash, "⑦ compaction 会话上下文内容必须相等");
  const compEntry = parseAll(compFile).find((o) => o.type === "compaction");
  assert.equal(compEntry.firstKeptEntryId, keptMsg.id, "⑦ firstKeptEntryId 应重映射到其后第一个存活节点");
  console.log(`⑦ compaction：上下文 ${compBefore.n} → ${compAfter.n} 条（哈希一致），firstKeptEntryId c3(被删 stream) → ${compEntry.firstKeptEntryId}(${keptMsg.id})`);

  // ─────────── ⑧ frames.jsonl：只留最后一行 ───────────
  const e = fs.mkdtempSync(path.join(root, "e-"));
  const framesFile = path.join(e, "frames.jsonl");
  const frameLines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ type: "custom", customType: "subagent-async", id: `f${i}`, parentId: i ? `f${i - 1}` : null, timestamp: TS, data: { handle: "h1", seq: i, shot: PAD } })
  );
  fs.writeFileSync(framesFile, `${frameLines.join("\n")}\n`);
  const framesBytes = fs.statSync(framesFile).size;
  const fr = run(["--apply", framesFile]);
  assert.equal(fr.status, 0, `⑧ frames.jsonl apply 应退出 0：${fr.stderr}`);
  assert.equal(read(framesFile), `${frameLines.at(-1)}\n`, "⑧ 产物必须逐字节等于最后一行");
  assert.equal(read(`${framesFile}.bak`), `${frameLines.join("\n")}\n`, "⑧ .bak 必须是原始 5 行");
  const fr2 = run(["--apply", framesFile]);
  assert.notEqual(fr2.status, 0, "⑧ frames.jsonl 二次 apply 也必须拒跑");
  console.log(`⑧ frames.jsonl：${(framesBytes / 1e6).toFixed(2)}MB/5 行 → 1 行（逐字节等于最后一行），二次 apply 退出码 ${fr2.status}`);

  // ─────────── ⑨ 无帧样本：apply 后逐字节不变 ───────────
  const f = fs.mkdtempSync(path.join(root, "f-"));
  const plainFile = path.join(f, "session.jsonl");
  const plain = [
    JSON.stringify({ type: "session", version: 3, id: "sess-plain", timestamp: TS, cwd: f }),
    JSON.stringify({ type: "message", id: "p1", parentId: null, timestamp: TS, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: TS } }),
    JSON.stringify({ type: "message", id: "p2", parentId: "p1", timestamp: TS, message: { role: "assistant", content: [{ type: "text", text: "yo" }], timestamp: TS, ...MODEL } }),
  ];
  fs.writeFileSync(plainFile, `${plain.join("\n")}\n`);
  const pl = run(["--apply", plainFile]);
  assert.equal(pl.status, 0, `⑨ 无帧样本 apply 应退出 0：${pl.stderr}`);
  assert.equal(read(plainFile), `${plain.join("\n")}\n`, "⑨ 无帧样本必须逐字节不变");
  console.log("⑨ 无帧样本：apply 后逐字节不变（没帧就不改内容）");

  // ─────────── ⑩ 入口守卫（工单40）：真实会话根的 --apply 必须二次确认 ───────────
  // sessionsRoot = $HOME/.pi/agent/sessions（Windows 取 USERPROFILE，POSIX 取 HOME）。
  // 测试一律用临时 HOME 顶替它，**绝不向真实 ~/.pi/agent/sessions 写任何东西**。
  const fakeHome = fs.mkdtempSync(path.join(root, "home-"));
  const fakeRoot = path.join(fakeHome, ".pi", "agent", "sessions", "proj-guard");
  fs.mkdirSync(fakeRoot, { recursive: true });
  const fakeSample = buildSession(fakeRoot);
  const fakeRaw = read(fakeSample.file);
  const fakeEnv = { HOME: fakeHome, USERPROFILE: fakeHome }; // 两个都设：POSIX 走 HOME，Windows 走 USERPROFILE

  // ⑩-1 --apply 不给路径 = 默认扫真实根 → 拒跑，退出码 1，打印会改多少文件
  const guardDefault = run(["--apply", "--min-mb", "1"], fakeEnv);
  assert.equal(guardDefault.status, 1, `⑩ 未给路径的 --apply 必须拒跑（实际 ${guardDefault.status}）：${guardDefault.stderr}`);
  assert.match(guardDefault.stderr, /拒绝执行/, "⑩ 拒跑要有明确提示");
  assert.match(guardDefault.stderr, /--force-real/, "⑩ 提示里要写清开关名");
  assert.match(guardDefault.stderr, /改写 1 个文件/, "⑩ 提示里要报会改多少个文件");
  assert.equal(read(fakeSample.file), fakeRaw, "⑩ 拒跑时文件不许动");
  assert.equal(fs.existsSync(`${fakeSample.file}.bak`), false, "⑩ 拒跑时不许落 .bak");
  assert.equal(fs.existsSync(`${fakeSample.file}.slim-tmp`), false, "⑩ 拒跑时不许留 tmp");
  console.log(`⑩-1 无路径 --apply：退出 ${guardDefault.status}；${guardDefault.stderr.trim().split("\n")[2]?.trim()}`);

  // ⑩-2 显式给了 sessionsRoot 下的文件（等价于动真实根）→ 同样要 --force-real
  const guardExplicit = run(["--apply", fakeSample.file], fakeEnv);
  assert.equal(guardExplicit.status, 1, `⑩ 显式指向 sessions 根的 --apply 也要拒跑（实际 ${guardExplicit.status}）`);
  assert.match(guardExplicit.stderr, /目标落在真实会话根下/, "⑩ 提示要区分「显式指向根下」");
  assert.equal(read(fakeSample.file), fakeRaw, "⑩ 拒跑时文件不许动");
  console.log(`⑩-2 显式指向 sessions 根：退出 ${guardExplicit.status}（同样拒跑）`);

  // ⑩-3 干跑不带参数 → 仍可扫真实根统计（真实 HOME，但阈值调到没文件命中，避免真读 4GB）
  const dryReal = run(["--min-mb", "100000"]);
  assert.equal(dryReal.status, 0, `⑩ 干跑真实根必须放行（实际 ${dryReal.status}）：${dryReal.stderr}`);
  assert.ok(
    dryReal.stdout.includes(path.join(os.homedir(), ".pi", "agent", "sessions")),
    `⑩ 干跑应仍默认指向真实会话根：${dryReal.stdout.trim()}`
  );
  // 干跑带真样本（临时 HOME 下的假根）→ 打印统计、一个字节不写
  const dryFake = run(["--min-mb", "1"], fakeEnv);
  assert.equal(dryFake.status, 0, `⑩ 干跑假根应退出 0：${dryFake.stderr}`);
  assert.match(dryFake.stdout, /干跑/, "⑩ 干跑应标明是干跑");
  assert.equal(read(fakeSample.file), fakeRaw, "⑩ 干跑不写盘");
  assert.equal(fs.existsSync(`${fakeSample.file}.bak`), false, "⑩ 干跑不许落 .bak");
  assert.equal(fs.existsSync(`${fakeSample.file}.slim-tmp`), false, "⑩ 干跑不许留 tmp");
  console.log(`⑩-3 干跑：真实根径 ${path.join(os.homedir(), ".pi", "agent", "sessions")} 放行（退出 ${dryReal.status}），假根统计后字节未变`);

  // ⑩-4 --force-real 放行：进入执行流程并真改——**只在临时 HOME 顶替的假根上跑**
  const forced = run(["--apply", "--force-real", "--min-mb", "1"], fakeEnv);
  assert.equal(forced.status, 0, `⑩ --force-real 应放行：${forced.stderr}`);
  assert.ok(forced.stdout.includes(fakeSample.file), "⑩ 改的必须是假根里的样本（不能被真实根替代）");
  const forcedAfter = read(fakeSample.file);
  assert.ok(Buffer.byteLength(forcedAfter) < Buffer.byteLength(fakeRaw), "⑩ 放行后应真瘦身");
  assert.equal(read(`${fakeSample.file}.bak`), fakeRaw, "⑩ .bak 必须是改前原文");
  assert.equal((await measure(fakeSample.file)).n, (await measure(`${fakeSample.file}.bak`)).n, "⑩ 放行后上下文条数一致");
  console.log(`⑩-4 --force-real：退出 ${forced.status}，假根样本 ${(Buffer.byteLength(fakeRaw) / 1e6).toFixed(2)}MB → ${(Buffer.byteLength(forcedAfter) / 1e6).toFixed(2)}MB，.bak 逐字节一致`);

  // ⑩-5 显式给非 sessions 路径（$TEMP 下）→ --apply 直接放行，不被无关的 --force-real 卡住
  const plainDir2 = fs.mkdtempSync(path.join(root, "plain-"));
  const plainSample = buildSession(plainDir2);
  const plainRaw = read(plainSample.file);
  const plainRun = run(["--apply", plainSample.file], fakeEnv);
  assert.equal(plainRun.status, 0, `⑩ 非 sessions 路径的 --apply 应直接放行：${plainRun.stderr}`);
  assert.ok(Buffer.byteLength(read(plainSample.file)) < Buffer.byteLength(plainRaw), "⑩ 放行的样本应真瘦身");
  console.log(`⑩-5 显式路径 --apply：退出 ${plainRun.status}（非 sessions 目录，无需 --force-real）`);

  console.log("\n全部通过（①②③④⑤⑥⑦⑧⑨⑩）");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`样本已删：${root}`);
}
