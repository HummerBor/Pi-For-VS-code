// 工单十五刀2 机械变换：webview/main.ts 单标签全局态 → 每标签渲染记录 R.* 字段。
// 只做纯标识符替换 + 删除旧 var 声明；结构性新增（tab 机制/路由/恢复）由手工编辑另行进行。
import { readFileSync, writeFileSync } from "fs";

const f = "webview/main.ts";
let s = readFileSync(f, "utf8");

// 1) 删除旧 var 声明（字段迁入 newTabRender）
const decls = [
  "  var liveMsg = null; var liveDiv = null;\n",
  "  var toolEls = {};\n",
  "  var streaming = false;\n",
  "  var liveLast = null;\n", // 未使用，顺手清理（工单十五刀2 机械清扫）
  "  var queueN = 0;\n",
  "  var busyTimer = null; var busyStart = 0;\n",
  "  var queuedItems = [];\n",
  "  var liveMsg = null; var liveDiv = null; var pdet = null;\n",
  "  var liveParts = null;\n",
  "  var liveRTimer = null;\n",
];
for (const d of decls) {
  if (!s.includes(d)) { console.error("声明未找到: " + JSON.stringify(d)); process.exit(1); }
  s = s.split(d).join("");
}

// 2) 标识符替换（\b 词边界）
const tokens = [
  "toolEls", "queuedItems", "liveMsg", "liveDiv", "pdet", "liveParts", "liveRTimer",
  "streaming", "busyTimer", "busyStart", "queueN", "pendingImages", "pendingFiles",
];
for (const t of tokens) {
  const re = new RegExp("\\b" + t + "\\b", "g");
  const n = (s.match(re) || []).length;
  s = s.replace(re, "R." + t);
  console.log(t + ": " + n + " 处替换");
}

// 3) messages 元素引用 → R.root（容器自身的 addEventListener/比较保留）
const elRules = [
  [/messages\.appendChild\(/g, "R.root.appendChild("],
  [/messages\.innerHTML/g, "R.root.innerHTML"],
  [/messages\.scrollTop = messages\.scrollHeight/g, "R.root.scrollTop = R.root.scrollHeight"],
  [/messages\.lastElementChild/g, "R.root.lastElementChild"],
  [/messages\.querySelectorAll\(/g, "R.root.querySelectorAll("],
  [/messages\.querySelector\(/g, "R.root.querySelector("],
];
for (const [re, to] of elRules) {
  const n = (s.match(re) || []).length;
  s = s.replace(re, to);
  console.log(String(re) + ": " + n + " 处替换");
}

writeFileSync(f, s);
console.log("机械变换完成");
