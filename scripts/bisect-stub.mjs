/**
 * stub 二分定位（调试辅助）：某条会话消息的文本里藏着让 stub 语法挂掉的序列。
 * 逐条累加 message 构造 stub payload，vm.Script 编译，找到第一条编译失败的消息。
 * 复用 preview-html.mjs 的 loadSessionFile + escJ + stub 模板拼装逻辑。
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import { createRequire } from "module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require2 = createRequire(import.meta.url);
const { buildPreview } = await import("file://" + join(root, "scripts", "preview-html.mjs").replace(/\\/g, "/"));

// 直接从 preview-html.mjs 拿内部函数不行（未导出 loadSessionFile），这里复制解析逻辑：
// —— 若后续 preview-html.mjs 改动，需同步（调试辅助脚本，可随时删）
const sessionPath = process.argv[2];
if (!sessionPath) { console.error("用法：node scripts/bisect-stub.mjs <会话jsonl>"); process.exit(1); }

const escJ = (s) => s.replace(/<\/script/gi, "<\\/script");
const i18n = require2(join(root, "out", "i18n.js"));

function loadAll(path) {
  const messages = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "message" && j.message) messages.push(j.message);
  }
  return messages;
}

function stubFor(msgs) {
  const uistate = { type: "uiState", tabId: "t1", messages: msgs, live: null, queued: [], banner: null, modeText: "Auto", busy: false, compacting: false, model: { name: "m", id: "m", provider: "p" }, thinkingLevel: "high", stats: { contextPercent: 0, cost: 0 }, sessionFile: "", sessionName: "x" };
  return "window.acquireVsCodeApi=function(){return{postMessage:function(m){window.dispatchEvent(new MessageEvent('message',{data:" + escJ(JSON.stringify(uistate)) + "}))},getState:function(){return{}},setState:function(){}}};";
}

const all = loadAll(sessionPath);
console.log("总消息数:", all.length);
let lo = 0, hi = all.length, bad = -1;
// 先确认全量真的挂
try { new vm.Script(stubFor(all)); console.log("全量编译 OK —— 问题不在消息数据"); process.exit(0); } catch { console.log("全量编译挂，开始二分"); }
while (lo <= hi) {
  const mid = (lo + hi) >> 1;
  try { new vm.Script(stubFor(all.slice(0, mid))); lo = mid + 1; }
  catch { bad = mid; hi = mid - 1; }
}
if (bad < 0) { console.log("没复现"); process.exit(0); }
console.log("第一条挂掉的前缀长度:", bad, "→ 消息 index", bad - 1);
const m = all[bad - 1];
console.log("role:", m.role, "stopReason:", m.stopReason);
const s = JSON.stringify(m);
console.log("消息 JSON 长度:", s.length);
// 在该消息里找可疑 / 序列
const idx = s.search(/[\u2028\u2029]/);
console.log("U+2028/2029 位置:", idx, idx >= 0 ? JSON.stringify(s.slice(Math.max(0, idx - 60), idx + 20)) : "");
