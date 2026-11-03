// 刀B 事实基线：转录页每来一条消息重绘整页，到底重绘多少、多少字节（2026-11-03）。
// 桩宿主直接驱动 out/vscode/transcriptTab.js（与 d:/tmp/test-tab.cjs 同款姿势）：
// 数 render 次数 / 累计 payload 字节 / 单次耗时，判断「长转录页可见重排」值不值得改。
// 用法：NODE_PATH=d:/tmp/stub/node_modules node scripts/probe/probe-transcript-render.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const post = [];
let readyCb = null;
const panel = {
  webview: {
    set html(v) {
      this._html = v;
    },
    get html() {
      return this._html;
    },
    postMessage: (m) => {
      post.push(m);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (cb) => {
      readyCb = cb;
      return { dispose() {} };
    },
  },
  reveal() {},
  onDidDispose() {
    return { dispose() {} };
  },
  dispose() {},
};
const vscode = createRequire(import.meta.url)("vscode");
vscode.window.createWebviewPanel = () => panel;
vscode.ViewColumn = { Beside: 2 };

const tab = createRequire(import.meta.url)("../../out/vscode/transcriptTab.js");

// 找一个真实的子会话文件（取消息最多的一单）
const root = path.join(os.homedir(), ".pi/agent/sessions/subagents");
const dirs = [];
const walk = (p, depth) => {
  if (depth > 3) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) walk(f, depth + 1);
    else if (e.name.endsWith(".jsonl") && e.name !== "frames.jsonl") dirs.push(f);
  }
};
walk(root, 0);
// 按「消息条数」挑最大的子会话（体积大可能只是单条工具输出大）
const loadMsgs = (f) => {
  const out = [];
  for (const ln of fs.readFileSync(f, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try {
      const e = JSON.parse(ln);
      if (e?.type === "message" && e.message) out.push(e.message);
    } catch {}
  }
  return out;
};
const file = dirs.map((f) => ({ f, n: loadMsgs(f).length })).sort((a, b) => b.n - a.n)[0].f;
const msgs = [];
for (const ln of fs.readFileSync(file, "utf8").split("\n")) {
  if (!ln.trim()) continue;
  try {
    const e = JSON.parse(ln);
    if (e?.type === "message" && e.message) msgs.push(e.message);
  } catch {}
}
const handle = path.basename(path.dirname(file));

tab.openTranscriptTab({
  file,
  title: "探针 · " + handle,
  theme: "midnight",
  duckUri: "",
  floorColor: "#0b1220",
  bgImage: "",
  bgOpacity: 0.35,
  lang: "zh",
});
readyCb({ type: "webviewReady" });

const renders = () => post.filter((m) => m.type === "render");
const bytes = (m) => Buffer.byteLength(JSON.stringify(m));

const base = renders().length;
const baseMsgs = renders().at(-1)?.messages.length ?? 0;
console.log(`子会话 ${handle}：${msgs.length} 条消息（打开时已渲染 ${baseMsgs} 条）`);

// 模拟 live：8 条消息逐条到达（harness 消息级帧 = 每条消息一次 pushTranscript）
let totalBytes = 0;
let t0 = Date.now();
const liveN = Math.min(30, msgs.length);
for (let i = 0; i < liveN; i++) {
  tab.pushTranscript(handle, [msgs[i]]);
  const r = renders().at(-1);
  totalBytes += bytes(r);
}
const ms = Date.now() - t0;
const newRenders = renders().length - base;
console.log(`live 追加 ${liveN} 条消息 → 整页 render ${newRenders} 次（每次带全量消息），累计 payload ${(totalBytes / 1048576).toFixed(2)}MB`);
console.log(`${newRenders} 次重绘总耗时 ${ms}ms（每次约 ${(ms / Math.max(1, newRenders)).toFixed(1)}ms，含 JSON.stringify）`);
const perRender = renders().at(-1)?.messages.length ?? 0;
console.log(`可见节点数 ${perRender} 条消息 → 每次重绘都要重建这 ${perRender} 条`);
