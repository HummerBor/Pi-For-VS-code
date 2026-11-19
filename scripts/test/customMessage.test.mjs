/**
 * 回归：面板渲染 `role:"custom"` 消息（工单43，2026-11-19）。
 *
 * 事故：`harness/memory` 压缩后注入的指针（`customType:"memory-pointer"`，display:true）进
 * LLM 上下文——模型看得见、用户看不见。`messageList.renderAll` 只认 user/assistant/toolResult/
 * bashExecution/compactionSummary，`custom` 落到 else 没有任何分支，静默穿落。
 *
 * 本用例打的是**真实**渲染路径（features/messageList.ts 的 renderAll + 宿主侧挑选口径
 * domain/customMessage.ts），不重写一份逻辑：
 *   ① 喂一条 role:"custom" / customType:"memory-pointer" / display:true → 断言产出含该文本
 *      且带 custom 样式类（.custom-note / .custom-note-tag / .custom-note-body）；
 *   ② 喂一条 display:false（同名文本）→ 断言**不渲染**；
 *   ③ 喂一条 subagent 专属通道类型（display:true）→ 不渲染（专属通道已画过，别双份）；
 *   ④ 宿主侧 filterCustomMessagesForWebview 保序剔除，非 custom 角色一条不动。
 *
 * 为什么能真跑：messageList 是「建 DOM + 塞文本」的老实代码，给一组假元素就够
 * （同 scripts/test/statusBar.test.mjs 的口径）。Node ≥23.6 原生跑 TS，零依赖；
 * 无扩展名相对 import 靠下面的 resolve 钩子补 .ts（vite 口径，Node ESM 不猜扩展名）。
 *
 * 运行：npm run test:customnote
 */
import assert from "node:assert";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── 无扩展名相对 import → 补 .ts（vite 口径）──
module.registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && !/\.[cm]?[jt]s$/.test(spec)) {
      const cand = new URL(spec + ".ts", ctx.parentURL);
      if (fs.existsSync(fileURLToPath(cand))) return { url: cand.href, format: "module-typescript", shortCircuit: true };
    }
    return next(spec);
  },
});

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

// ── 假元素（够 messageList 用：className / textContent / innerHTML / appendChild / setAttribute）──
function esc0(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fakeNode(tag) {
  const node = {
    tagName: String(tag || "div"),
    className: "",
    title: "",
    style: {},
    attrs: {},
    children: [],
    parentNode: null,
    _text: "",
    _html: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return node.attrs[k]; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  Object.defineProperty(node, "textContent", {
    get() { return node._text; },
    set(v) { node._text = String(v == null ? "" : v); node.children.length = 0; },
  });
  Object.defineProperty(node, "innerHTML", {
    get() { return node._html; },
    set(v) { node._html = String(v == null ? "" : v); node.children.length = 0; },
  });
  return node;
}
function htmlOf(n) {
  const tag = String(n.tagName).toLowerCase();
  const cls = n.className ? ' class="' + esc0(n.className) + '"' : "";
  const attrs = Object.keys(n.attrs || {})
    .map((k) => " " + k + '="' + esc0(n.attrs[k]) + '"')
    .join("");
  let inner = "";
  if (n.children && n.children.length) inner = n.children.map(htmlOf).join("");
  else if (n._html) inner = n._html;
  else inner = esc0(n._text);
  return "<" + tag + cls + attrs + ">" + inner + "</" + tag + ">";
}

globalThis.document = { createElement: (t) => fakeNode(t) };

const { initMessageList } = await import(pathToFileURL(path.join(root, "webview/features/messageList.ts")).href);
const { isRenderableCustomMessage, filterCustomMessagesForWebview, customMessageText } = await import(
  pathToFileURL(path.join(root, "src/domain/customMessage.ts")).href
);

// ── ① 挑选口径（宿主侧与 webview 共用这一份）──
console.log("口径 customMessage.ts");
const pointer = {
  role: "custom",
  customType: "memory-pointer",
  display: true,
  content: [{ type: "text", text: "上下文已压缩。动手前按需重读：AGENTS.md" }],
  timestamp: 1732000000000,
};
ok("display:true + 有文本 → 可渲染", isRenderableCustomMessage(pointer) === true);
ok("display:false → 不渲染", isRenderableCustomMessage({ ...pointer, display: false }) === false);
ok("display 缺省 → 不渲染（对齐 pi TUI 的真值判定）", isRenderableCustomMessage({ ...pointer, display: undefined }) === false);
ok("subagent 专属通道 → 不渲染", isRenderableCustomMessage({ ...pointer, customType: "subagent-async" }) === false);
ok("无文本 → 不渲染", isRenderableCustomMessage({ ...pointer, content: [] }) === false);
ok("非 custom 角色 → 一句话不管", isRenderableCustomMessage({ role: "user", content: "x" }) === false);
ok("content 数组拼文本", customMessageText(pointer.content) === pointer.content[0].text);
const mixed = [{ role: "user", content: "hi" }, pointer, { ...pointer, display: false }, { role: "assistant", content: [] }];
const filtered = filterCustomMessagesForWebview(mixed);
ok("宿主过滤：只剔不可渲染的 custom，其余原样保序", filtered.length === 3 && filtered[0] === mixed[0] && filtered[1] === pointer && filtered[2] === mixed[3]);

// ── 假 DOM 装配真实的 initMessageList ──
function makeDeps() {
  const rootEl = fakeNode("div");
  const deps = {
    root: rootEl,
    el: (tag, cls, text) => { const n = fakeNode(tag); n.className = cls || ""; if (text !== undefined) n.textContent = text; return n; },
    ico: () => "",
    esc: esc0,
    getRoot: () => "D:/work/proj",
    linkify: () => {},
    renderRich: (parent, text) => { parent.textContent = String(text || ""); },
    lang: {},
    scroll: () => {},
    post: () => {},
    adoptSticky: () => {}, updateStickyChip: () => {}, observeSticky: () => {},
    toolStart: () => {}, toolEnd: () => {}, resetToolRows: () => {},
    liveReset: () => {},
    outlineRebuild: () => {}, setOlSuspend: () => {},
    setLinkifyEnabled: () => {}, setFollowingEnd: () => {},
    welcomeHTML: "", duckInto: () => {}, pickTip: () => {},
    rebuildQueuebar: () => {},
    compactbarEl: fakeNode("div"),
  };
  return { rootEl, deps };
}

console.log("渲染路径 renderAll（webview/features/messageList.ts）");
{
  const { rootEl, deps } = makeDeps();
  const ml = initMessageList(deps);
  ml.renderAll([pointer]);
  const html = htmlOf(rootEl);
  ok("渲染出提示条：带 .custom-note 类", /class="custom-note"/.test(html), html);
  ok("渲染出角标 .custom-note-tag 且内容 = customType", /class="custom-note-tag"[^>]*>memory-pointer</.test(html), html);
  ok("正文进 .custom-note-body 且含注入文本", /class="custom-note-body"[^>]*>上下文已压缩/.test(html), html);
  ok("角标带 data-custom-type（可定位/可分辨来源）", /data-custom-type="memory-pointer"/.test(html), html);
  ok("不是用户/助手气泡", !/bubble/.test(html), html);
}
{
  const { rootEl, deps } = makeDeps();
  const ml = initMessageList(deps);
  ml.renderAll([{ ...pointer, display: false }]);
  const html = htmlOf(rootEl);
  ok("display:false 一条都不画", !/custom-note/.test(html) && !/上下文已压缩/.test(html), html);
}
{
  const { rootEl, deps } = makeDeps();
  const ml = initMessageList(deps);
  ml.renderAll([{ ...pointer, customType: "subagent-async" }]);
  const html = htmlOf(rootEl);
  ok("subagent 专属通道不进消息流", !/custom-note/.test(html), html);
}
{
  // 位置保持：前面一条 user 内容（用极简 user 形状走 addUser 太重，改用 custom + custom 两条
  // 验证「按列表顺序 flush 成两条独立的条」——顺序即真实时间位置）
  const { rootEl, deps } = makeDeps();
  const ml = initMessageList(deps);
  const second = { ...pointer, customType: "other-ext", content: "第二条注入" };
  ml.renderAll([pointer, second]);
  const notes = rootEl.children.filter((c) => String(c.className).indexOf("custom-note") === 0);
  ok("多条按消息顺序各成一条", notes.length === 2 && /memory-pointer/.test(notes[0].children[0].textContent) && /other-ext/.test(notes[1].children[0].textContent));
}
{
  // 正文转义：注入内容里的尖括号不得变成标签（走 esc）
  const { rootEl, deps } = makeDeps();
  const ml = initMessageList(deps);
  ml.renderAll([{ ...pointer, content: "<img src=x onerror=alert(1)>" }]);
  const html = htmlOf(rootEl);
  ok("正文走 esc 转义（不吐标签）", html.indexOf("&lt;img src=x onerror=alert(1)&gt;") >= 0 && html.indexOf("<img") < 0, html);
}
{
  // 实时路径：宿主 customNote 帧 → features/sessionView.ts 调 addCustomNote
  const { rootEl, deps } = makeDeps();
  const ml = initMessageList(deps);
  ml.addCustomNote("memory-pointer", "实时注入的一条", 1732000000000);
  const html = htmlOf(rootEl);
  ok("addCustomNote 产出同款提示条", /class="custom-note"/.test(html) && /实时注入的一条/.test(html), html);
}

console.log("\n通过 " + pass + " / 失败 " + fail);
if (fail) { console.error("customMessage 回归失败"); process.exitCode = 1; }
else console.log("customMessage 回归 OK（role:\"custom\" 渲染 + display:false 不渲染）");
