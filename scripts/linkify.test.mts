/**
 * FILE_RE / linkify 口径用例（2026-09-23「这些都点不开」截断事故的可复验凭证）。
 *
 * 背景：FILE_RE 第三支扩展名互斥分支短项前置（js 先于 json、裸 c 先于 cpp/create）
 * 且扩展名后无尾边界——`models-store.json` 被链到「models-store.js」、`ModelRuntime.create`
 * 被链到「ModelRuntime.c」、`package.json` 被链到「package.js」。假路径点开必「找不到文件」，
 * 即用户截图实测的「这些都点不开」。本文件抽 webview/main.ts 的真实渲染/linkify 代码
 * 在最小 DOM 垫片里跑，钉死「不截断、不产假链」口径。
 *
 * 运行：npm run test:linkify（Node 直跑，零依赖，不进 tsc 编译门禁）
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, "webview", "main.ts"), "utf8");
const lines = src.split("\n");

// ── 按标记抽取 main.ts 真代码（行号漂移时靠函数名重定位）────────────────────
function grab(startMark: string, endMark: string, inclusive = true): string {
  const s = lines.findIndex((l) => l.includes(startMark));
  let e = -1;
  for (let i = s + 1; i < lines.length; i++) { if (lines[i].includes(endMark)) { e = i; break; } }
  if (s < 0 || e < 0) throw new Error("grab failed: " + startMark);
  return lines.slice(s, inclusive ? e + 1 : e).join("\n");
}
let code = [
  grab("function renderInline(elm, text)", "function renderRich(parent, text)", false),
  grab("function renderRich(parent, text)", "function makeSessionView(id: string)", false),
  grab("var FILE_RE =", "}, true);"),
].join("\n");
// TS 断言/注解剥壳（垫片是纯 JS eval）——定向替换，不用宽泛正则，防误伤三元表达式
code = code.replace("root: HTMLElement | null", "root").replace(/ as [A-Za-z]+/g, "").replace(/(\w)!\./g, "$1.").replace(/(\w)!\)/g, "$1)");
// linkify 段尾的 click handler 依赖 sessionArea/vscode，截掉（与口径无关）
code = code.slice(0, code.indexOf("  sessionArea.addEventListener"));

// ── 最小 DOM 垫片 ─────────────────────────────────────────────────────────
class ClassList { constructor(el) { this.el = el; } contains(c) { return this.el.className.split(/\s+/).indexOf(c) >= 0; } }
class Node {
  constructor() { this.childNodes = []; this.parentNode = null; }
  appendChild(ch) {
    if (ch instanceof Frag) { for (const c of [...ch.childNodes]) this.appendChild(c); return ch; }
    if (ch.parentNode) ch.parentNode.removeChild(ch);
    ch.parentNode = this; this.childNodes.push(ch); return ch;
  }
  removeChild(ch) { const i = this.childNodes.indexOf(ch); if (i >= 0) this.childNodes.splice(i, 1); ch.parentNode = null; return ch; }
  replaceChild(neu, old) {
    const i = this.childNodes.indexOf(old); if (i < 0) throw new Error("replaceChild: not a child");
    const ins = neu instanceof Frag ? [...neu.childNodes] : [neu];
    if (neu instanceof Frag) neu.childNodes = [];
    for (const c of ins) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; }
    this.childNodes.splice(i, 1, ...ins); old.parentNode = null; return old;
  }
}
class Frag extends Node {}
class El extends Node {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.className = ""; this.attrs = {}; this.style = {}; this.classList = new ClassList(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  set textContent(v) { this.childNodes = []; if (v !== "" && v != null) this.appendChild(new Text(String(v))); }
  get textContent() { return this.childNodes.map((c) => (c instanceof Text ? c.nodeValue : c.textContent)).join(""); }
}
class Text extends Node {
  constructor(t) { super(); this.nodeName = "#text"; this.nodeValue = t; }
  get textContent() { return this.nodeValue; }
}
function walkTexts(node, out) {
  for (const c of node.childNodes) { if (c instanceof Text) out.push(c); else walkTexts(c, out); }
  return out;
}
const document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => new Text(t),
  createDocumentFragment: () => new Frag(),
  createTreeWalker(r) {
    const all = walkTexts(r, []); let i = -1;
    return { nextNode() { if (i + 1 >= all.length) return null; i += 1; return true; }, get currentNode() { return all[i]; }, set currentNode(v) { all[i] = v; } };
  },
};
const NodeFilter = { SHOW_TEXT: 4 };
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== "") e.textContent = text; return e; }

const fn = new Function("document", "NodeFilter", "el", code + "\nreturn { renderRich, FILE_RE };");
const api = fn(document, NodeFilter, el);

/** 渲染一段 markdown，返回全部 .fp 链接的 data-p（即点击后宿主实际收到的路径） */
function links(text: string): string[] {
  const d = document.createElement("el");
  api.renderRich(d, text);
  const out = [];
  (function walk(n) {
    if (n instanceof Text) return;
    if (n.className && n.className.split(" ").indexOf("fp") >= 0) out.push(n.attrs["data-p"]);
    for (const c of n.childNodes) walk(c);
  })(d);
  return out;
}

let passed = 0;
function check(name: string, actual: string[], expected: string[]): void {
  assert.deepStrictEqual(actual, expected, `用例失败: ${name}`);
  passed++;
}

/* 第 1 组：扩展名不被短项截断（本次事故主口径） */
check("行内 code 文件名 json 不截断", links("• `models-store.json` 387KB（可用性缓存）"), ["models-store.json"]);
check("加粗文件名 json 不截断", links("• **models-store.json** 387KB"), ["models-store.json"]);
check("package.json 不截断", links("见 package.json 就在根目录"), ["package.json"]);
check("app.tsx 不截断", links("改 app.tsx 一行"), ["app.tsx"]);
check("foo.jsx 不截断", links("改 foo.jsx 一行"), ["foo.jsx"]);
check("util.mjs 不截断", links("跑 util.mjs"), ["util.mjs"]);
check("foo.cpp 不截断", links("编译 foo.cpp"), ["foo.cpp"]);
check("foo.hpp 不截断", links("include foo.hpp"), ["foo.hpp"]);
check("foo.conf 不截断", links("读 foo.conf"), ["foo.conf"]);

/* 第 2 组：原有正确行为不回退 */
check("路径:行号 保持", links("读 src/piCore.ts:898 的头注释"), ["src/piCore.ts:898"]);
check("盘符绝对路径 保持", links("开 d:/work/a.ts"), ["d:/work/a.ts"]);
check("URL 里的路径不当链接", links("见 https://example.com/a.json"), []);
check("二进制不链接", links("装 dist/build.vsix"), []);

/* 第 3 组：符号引用可点（刀3）——`ModelRuntime.create` 曾被截断假链到 ModelRuntime.c，
 * 现口径：行内 code 里的整段符号 → .fp 指向全名，点击由宿主在 pi 包里搜源码；
 * 敌文里的裸符号不点（Node.js/版本号防误伤）。 */
check("code 内符号引用可点且指向全名", links("残值全在 `ModelRuntime.create` 附近"), ["ModelRuntime.create"]);
check("code 内多级符号", links("看 `PiCore.onWebviewMessage` 和 `piCore.ts:898`"), ["PiCore.onWebviewMessage", "piCore.ts:898"]);
check("敌文里的裸符号不点", links("残值全在 ModelRuntime.create 附近"), []);
check("code 内文件名优先于符号（models-store.json 不是符号）", links("`models-store.json`"), ["models-store.json"]);

console.log(`linkify 口径用例 ${passed} 项全部通过`);
