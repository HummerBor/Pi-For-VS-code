/**
 * 子 agent 浮窗历史重放用例（「关标签重开 → 浮窗没了」事故回归，2026-11-03）。
 *
 * 运行：npm run test:replay（node 裸跑，import 编译产物 out/core/piCore.js → **先 npm run compile**）
 *
 * 断言口径（为什么这么写）：
 * - 只断**可观测契约**——`replaySubagentHistory` 经 `post()` 发出的 `subagentUpdate` /
 *   `subagentLedger`；**不断私有字段**（标记字段是白盒：改成 Set、改名、换位置都会让用例
 *   假性失败/假性通过，且证明不了「以后还能重放」）。
 * - fixture 在临时目录自造（会话 jsonl / 台账 runs/*.json / frames.jsonl），不读用户真实会话
 *   ——否则用例挂在「本机最大那个会话文件」上，换机器就废，慢且不可复现。
 *
 * 事故现场（0.1.109 日志铁证，tab=p283）：
 * ```
 * stat-FAIL ENOENT file=...\2026-11-03T08-38-32-477Z_....jsonl   ← pi 刚建、没写盘的幽灵会话文件
 *               cur =...\2026-11-03T02-48-58-475Z_....jsonl      ← 真文件（= claimedFile）
 * ```
 * 关标签重开（freshTab 链）时 pi 先建新会话文件（只登记路径、不落盘），`switchSession` 之后
 * `getState().sessionFile` 仍报那个幽灵；两个路径长度都是 144 字符，所以日志里看不出来。
 * 重放只认 `lastSessionFile` → 永远 stat 不到 → 浮窗整块空。重启 VSC 走恢复链
 * （`getSessionForWs` → `switchSession(旧文件)`）拿到的就是真文件，所以那条链一直是好的——
 * 「重启有、重开没」的差别全在这一句。
 *
 * 五条口径：
 * ① boot 早于落盘（ENOENT）→ 不投快照，但**不烧机会**：状态回填真文件后同一 core 能补上
 * ② 同上但文件已存在却是 0 字节（同路径长大）→ 下一拍能补上
 * ③ 幽灵 lastSessionFile + 认领真文件（p283 现场）→ 用认领的那个重放
 * ④ 同一文件重复调用不重复投（防切页签反复重放）
 * ⑤ 只认派单回执：`subagent_list` 回执里的同形状 details 不许凭空造行
 * ⑥ 并发重入（postUiState 连发）：只扫一遍
 * ⑦ 会话文件**根本不存在**、但台账 parentSession 命中（且大小写不同）→ 仍从 frames.jsonl 重放
 *    （债2 验收：索引主源换成 harness 自己的台账，不再赌 pi 报的会话文件路径）
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-replay-"));
// 诊断日志重定向到临时目录（DBG_LOG_PATH 支持 env 覆盖）——用例不许污染用户的
// ~/.pi/agent/pi-chat-debug.log，否则真排障时全是测试噪音
process.env.PI_CHAT_DEBUG_LOG = path.join(tmp, "dbg.log");
const { PiCore } = await import("../../out/core/piCore.js");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, `用例失败: ${name}`);
  passed++;
}
function eq(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, `用例失败: ${name}`);
  passed++;
}

/* ── fixture：台账 + 帧 + 会话文件（形状对齐 harness 写的运行期文件） ────────── */
const agentDir = path.join(tmp, "agent");
const runsDir = path.join(agentDir, "sessions", "subagents", "runs");
fs.mkdirSync(runsDir, { recursive: true });

/** 单任务 details（与 harness asyncDetails 同形状：mode/results[]，任务带 agent/task/handle） */
function details(handle, agent) {
  return {
    mode: "single",
    results: [
      {
        agent,
        task: "fixture task",
        handle,
        status: "completed",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "done " + handle }] }],
      },
    ],
  };
}

const runDir7 = path.join(tmp, "run-sa-7");
fs.mkdirSync(runDir7, { recursive: true });
fs.writeFileSync(
  path.join(runDir7, "frames.jsonl"),
  JSON.stringify({ handle: "sa-7", status: "completed", startedAt: 1000, endedAt: 2000, detail: details("sa-7", "工程师") }) + "\n",
);

const ledger = (handle, agent, status, startedAt, sessionDir) => ({
  handle,
  agent,
  task: "fixture task",
  status,
  startedAt,
  ...(status === "completed" ? { endedAt: startedAt + 1000 } : {}),
  ...(sessionDir ? { sessionDir } : {}),
});
fs.writeFileSync(path.join(runsDir, "sa-7.json"), JSON.stringify(ledger("sa-7", "工程师", "completed", 1000, runDir7)));
fs.writeFileSync(path.join(runsDir, "sa-8.json"), JSON.stringify(ledger("sa-8", "审查", "completed", 3000)));
// sa-99 不在本会话 handle 集里：台账必须按 handle 集过滤，不许串会话
fs.writeFileSync(path.join(runsDir, "sa-99.json"), JSON.stringify(ledger("sa-99", "别的会话", "completed", 5000)));

// ⑦ 只用台账索引的运行：会话文件永远不会存在，帧照样齐全
const runDir77 = path.join(tmp, "run-sa-77");
fs.mkdirSync(runDir77, { recursive: true });
fs.writeFileSync(
  path.join(runDir77, "frames.jsonl"),
  JSON.stringify({ handle: "sa-77", status: "completed", startedAt: 7000, endedAt: 8000, detail: details("sa-77", "台账里的单") }) + "\n",
);
const ghostSession = path.join(tmp, "sess", "ghost-only-in-ledger.jsonl"); // 故意不创建
fs.writeFileSync(
  path.join(runsDir, "sa-77.json"),
  JSON.stringify({
    ...ledger("sa-77", "台账里的单", "completed", 7000, runDir77),
    // 大小写故意与真实路径不一致（真机事故：台账写 `--d--`、磁盘是 `--D--`，严格相等命中 0 条）
    parentSession: ghostSession.toUpperCase(),
  }),
);

const sessDir = path.join(tmp, "sess");
fs.mkdirSync(sessDir, { recursive: true });
const sessionFile = path.join(sessDir, "real-session.jsonl");
fs.writeFileSync(
  sessionFile,
  [
    // 无关行
    JSON.stringify({ type: "session", version: 3, id: "fixture" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    // 截断半条（进程崩尾部）：含 subagent-async 但 JSON 不完整 → 必须跳过而不是整链崩
    '{"type":"custom","customType":"subagent-async","data":{"handle":"sa-6',
    // 异步单的 entry 帧（SDK 宿主下 custom entry 不落盘，这条只保证两路都认）
    JSON.stringify({
      type: "custom",
      customType: "subagent-async",
      data: { handle: "sa-7", status: "completed", startedAt: 1000, endedAt: 2000, detail: details("sa-7", "工程师") },
    }),
    // 同步派的回执：toolResult.details 是全量正本
    JSON.stringify({
      type: "message",
      timestamp: "2026-11-03T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "call_sync_1",
        content: [{ type: "text", text: "已完成：sa-8" }],
        details: details("sa-8", "审查"),
      },
    }),
    // ⑤ 同形状但 toolName 不是 subagent：list 回执不许造行
    JSON.stringify({
      type: "message",
      timestamp: "2026-11-03T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolName: "subagent_list",
        toolCallId: "call_list_1",
        content: [{ type: "text", text: "sa-9 running" }],
        details: details("sa-9", "列表里捡到的"),
      },
    }),
  ].join("\n") + "\n",
);

/* ── 用例助手 ─────────────────────────────────────────────────────────────── */
const caps = { getAgentDir: () => agentDir };
function newCore(posts) {
  return new PiCore(caps, {}, (m) => posts.push(m), "test");
}
// 同句柄双路（frames.jsonl + entry 帧）会重复投**同一个 id**——设计如此（webview 按 id
// 覆盖写，幂等）；断言只看 id 集合，不给这条冗余路加锁，将来合并成一条也不会误报
const uniqIds = (posts) =>
  [...new Set(posts.filter((m) => m.type === "subagentUpdate").map((m) => String(m.id)))].sort();
const lastLedgerRows = (posts) => {
  const l = posts.filter((m) => m.type === "subagentLedger").pop();
  return l ? l.rows.length : -1;
};

/* ① boot 早于落盘（ENOENT）：不投，也不许把机会烧掉 */
{
  const posts = [];
  const core = newCore(posts);
  core.lastSessionFile = path.join(sessDir, "ghost-not-written-yet.jsonl"); // pi 只登记、没写盘
  await core.replaySubagentHistory();
  eq("① ENOENT：不投任何快照", uniqIds(posts), []);
  eq("① ENOENT：不推空台账", lastLedgerRows(posts), -1);

  core.lastSessionFile = sessionFile; // refreshState 把真文件回填进来
  await core.replaySubagentHistory();
  await new Promise((r) => setTimeout(r, 50));
  eq("① 回填真文件后同一 core 补投 sa-7/sa-8", uniqIds(posts), ["sa-7", "sa-8"]);
  eq("① 台账按 handle 集过滤（sa-99 不进）", lastLedgerRows(posts), 2);
  ok(
    "① 投的快照都是终态（重放 running 会造「永久处理中」假行）",
    posts.filter((m) => m.type === "subagentUpdate").every((m) => m.final === true),
  );
}

/* ② 文件已存在但 0 字节（同路径长大）：下一拍补上 */
{
  const posts = [];
  const core = newCore(posts);
  const growing = path.join(sessDir, "growing.jsonl");
  fs.writeFileSync(growing, "");
  core.lastSessionFile = growing;
  await core.replaySubagentHistory();
  eq("② 0 字节：不投任何快照", uniqIds(posts), []);

  fs.copyFileSync(sessionFile, growing); // pi 真正落盘
  await core.replaySubagentHistory();
  await new Promise((r) => setTimeout(r, 50));
  eq("② 同一路径落盘后重试能投", uniqIds(posts), ["sa-7", "sa-8"]);
}

/* ③ p283 现场：幽灵 lastSessionFile + 认领真文件 → 用认领的那个 */
{
  const posts = [];
  const core = newCore(posts);
  core.lastSessionFile = path.join(sessDir, "ghost-not-written-yet.jsonl");
  core.claimedFile = sessionFile; // 打开会话时认领的 = 真文件
  await core.replaySubagentHistory();
  await new Promise((r) => setTimeout(r, 50));
  eq("③ 幽灵 + 认领：用认领的真文件重放", uniqIds(posts), ["sa-7", "sa-8"]);

  /* ④ 同一文件重复调用不重复投（切页签 uiState 会反复触发） */
  const before = posts.length;
  await core.replaySubagentHistory();
  eq("④ 同文件重复调用不重复投", posts.length, before);
}

/* ⑤ 只认派单回执：list 回执同形状 details 不造行（sa-9 已含在上面精确相等断言里，
      这里单独钉一条，防止将来放宽过滤时静默回退） */
{
  const posts = [];
  const core = newCore(posts);
  core.lastSessionFile = sessionFile;
  await core.replaySubagentHistory();
  await new Promise((r) => setTimeout(r, 50));
  ok("⑤ subagent_list 回执不造行", !uniqIds(posts).includes("sa-9"));
  eq("⑤ 截断半条 JSON 不弄崩整链", uniqIds(posts), ["sa-7", "sa-8"]);
}

/* ⑥ 并发重入（postUiState 4ms 内连发两次）：只扫一遍，不许重复投
      —— 0.1.110 真机日志发现：标记改到「扫完才落」后丢了隐式重入保护，日志里 start 出现两条 */
{
  const posts = [];
  const core = newCore(posts);
  core.lastSessionFile = sessionFile;
  await Promise.all([core.replaySubagentHistory(), core.replaySubagentHistory()]);
  await new Promise((r) => setTimeout(r, 50));
  eq("⑥ 并发两次调用只扫一遍（id 集合不变）", uniqIds(posts), ["sa-7", "sa-8"]);
  eq(
    "⑥ 不投第二轮（sa-8 只该出现一次，sa-7 是 frames+entry 双路两次）",
    posts.filter((m) => m.type === "subagentUpdate").length,
    3,
  );
}

/* ⑦ 会话文件不存在（幽灵/未落盘），台账 parentSession 命中的运行照样重放 */
{
  const posts = [];
  const core = newCore(posts);
  ok("⑦ 前提：会话文件确实不存在", !fs.existsSync(ghostSession));
  core.lastSessionFile = ghostSession;
  await core.replaySubagentHistory();
  await new Promise((r) => setTimeout(r, 50));
  eq("⑦ 台账 parentSession 命中（大小写不同也算）→ 从 frames 重放", uniqIds(posts), ["sa-77"]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`subagentReplay 用例：${passed} 项全过 ✅`);
