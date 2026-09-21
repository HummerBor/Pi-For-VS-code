/**
 * 预览页生成（浏览器实时调试 webview）：buildPreview() 写出 dist/webview/preview.html
 *
 * 调用方：vite.config.mts 的 closeBundle（每次构建/watch 重编后自动重新生成，防 emptyOutDir 清掉预览页）
 * 手动跑：node scripts/preview-html.mjs（模板/i18n 变更后用）
 *
 * 原理：模板 + dist 产物外链 main.css/main.js（不内联，watch 重编后浏览器刷新即见新产物）
 * + stub 掉 acquireVsCodeApi（webviewReady 一到就派发模拟 tabs/uiState，消息流/大纲轨道真实渲染）。
 * 出站消息全打 console（[webview→] 前缀）。预览页自带模拟会话：用户消息/思考块/工具行/工具结果。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);

/** 上次灌入的会话路径状态文件：vite closeBundle 重生成预览页时读它自动重灌，
 *  否则 watch 每次重编都把预览页冲回 mock（实测事故 2026-09-21，用户选方案 2）。
 *  点文件不进 git（.gitignore 已加）；--mock 清除；文件被删/不存在则兑底 mock */
const SESSION_STATE = join(root, "scripts", ".preview-session.txt");

function readLastSession() {
  try {
    const p = readFileSync(SESSION_STATE, "utf8").trim();
    if (p && existsSync(p)) return p;
  } catch { /* 无状态文件 → mock */ }
  return undefined;
}

// JSON 内嵌进 <script> 前的 </script 转义：真实会话文本里可能出现该序列（webview 开发会话
// 尤其常见），不转义会提前闭合脚本标签——同宿主 webview-html.ts 的转义契约
const escJ = (s) => s.replace(/<\/script/gi, "<\\/script");

/** 会话 jsonl → webview 渲染用的 SessionMessage[]（pi 落盘每行 type:"message"，.message 即渲染结构）
 *  附带会话名 / 最近的模型与思考等级（来自 session_info / model_change / thinking_level_change）。
 *  toolResult 文本截 4000 字：renderAll 展示也只取 1000 字，不截的话十 MB 级会话会把
 *  preview.html 撑到几十 MB（真实事故风险：本会话源文件 14MB）。图片块同理：
 *  base64 单张几百 KB，webview 开发会话几十张截图能把页面掉到十 MB+——只保留最近
 *  KEEP_IMGS 张，其余换占位文本（气泡里仍看得出「这里有过图」）
 *  */
const KEEP_IMGS = 3;
function loadSessionFile(path) {
  const messages = [];
  let name = "";
  let model = null;
  let thinkingLevel = null;
  const lines = readFileSync(path, "utf8").split("\n");
  // 先数一遍图片总数，第二遍只留最后 KEEP_IMGS 张的 base64
  let imgTotal = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== "message" || !j.message || !Array.isArray(j.message.content)) continue;
    for (const c of j.message.content) if (c && (c.type === "image" || c.data)) imgTotal++;
  }
  let imgSeen = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "session_info" && j.name) name = j.name;
    if (j.type === "model_change") model = { name: j.modelId, id: j.modelId, provider: j.provider };
    if (j.type === "thinking_level_change") thinkingLevel = j.thinkingLevel;
    if (j.type !== "message" || !j.message) continue;
    const m = j.message;
    if (Array.isArray(m.content)) {
      m.content = m.content.map((c) => {
        if (!c) return c;
        if (c.type === "image" || c.data) {
          imgSeen++;
          if (imgSeen <= imgTotal - KEEP_IMGS) return { type: "text", text: "🖼️（图片省略，全量在 jsonl）" };
          return c;
        }
        if (c.type === "text" && String(c.text || "").length > 4000 && m.role === "toolResult") {
          return Object.assign({}, c, { text: String(c.text).slice(0, 4000) + "\n…（预览页截断，全量在 jsonl）" });
        }
        return c;
      });
    }
    messages.push(m);
  }
  return { messages, name, model, thinkingLevel };
}

export function buildPreview(sessionPath) {
  // 未显式传路径时读状态文件（vite closeBundle 无参调用走这条）：上次灌过真实会话就自动重灌
  sessionPath = sessionPath || readLastSession();
  const dist = join(root, "dist", "webview");
  const template = readFileSync(join(dist, "index.html"), "utf8");
  const i18n = require(join(root, "out", "i18n.js")); // tsc 产物（全量 compile 先行），CJS require
  const L = i18n.STRINGS.zh;
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "?";

  // 模拟会话：覆盖全部可渲染消息类型，样式/交互调试用——
  // 用户普通消息 / 用户带代码上下文标记（出 codechip）/ 用户带附件计数 /
  // assistant 思考块 / 富文本（列表·表格·引用·行内code·代码块）/ 工具行（**注意：历史重绘
  // 认 type:"toolCall"，旧版 mock 写成 "toolUse" 导致工具行没渲染过，实测事故 2026-09-21）/
  // 工具结果（成功/失败红点）/ bashExecution / compactionSummary / 错误气泡（retry）
  const MESSAGES = [
    { role: "user", content: [{ type: "text", text: "看看这个项目怎么跑起来" }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "先看现状：轨道、列宽、玻璃三块。列宽是居中窄列，间距要收 8px。" },
      { type: "text", text: "看完了，结构如下：\n\n- `src/` 宿主侧，入口 extension.ts\n- `webview/` 前端源码，vite 构建\n- `dist/` 产物目录\n\n**启动方式**：F5 调试，或 `npm run watch:webview` 后浏览器开预览页。\n\n| 目录 | 职责 |\n|---|---|\n| panel.ts | VS Code adapter |\n| piCore.ts | 核心控制器 |\n\n> 提示：改 webview 样式不用重启调试。" },
    ] },
    { role: "user", content: [{ type: "text", text: "--- 代码上下文: webview/style.css (L311) ---\n.ol-row.cur .ol-dash,\n--- 代码上下文结束 ---\n\n这个高亮色不对" }] },
    { role: "assistant", content: [
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "webview/style.css" } },
    ] },
    { role: "toolResult", toolCallId: "t1", isError: false, content: [{ type: "text", text: ".outline { position: absolute; right: 12px; ... }\n.ol-row { display: flex; ... }" }] },
    { role: "assistant", content: [
      { type: "toolCall", id: "t2", name: "edit", arguments: { path: "webview/style.css", oldText: "background: var(--vscode-focusBorder, #0078d4);", newText: "background: #fff;" } },
    ] },
    { role: "toolResult", toolCallId: "t2", isError: false, content: [{ type: "text", text: "OK" }] },
    { role: "assistant", content: [{ type: "text", text: "改成纯白了，刷新看效果。" }] },
    { role: "user", content: [{ type: "text", text: "帮我跑一下编译" }] },
    { role: "bashExecution", command: "npm run compile" },
    { role: "assistant", content: [
      { type: "toolCall", id: "t3", name: "bash", arguments: { command: "npm run compile" } },
    ] },
    { role: "toolResult", toolCallId: "t3", isError: true, content: [{ type: "text", text: "webview/main.ts(1263): error TS2339: Property 'x' does not exist on type 'HostToWebviewTagged'." }] },
    { role: "assistant", content: [{ type: "text", text: "编译报了一个类型错：`HostToWebviewTagged` 上没有 `x` 属性，我补到 protocol.ts 里。" }] },
    { role: "compactionSummary", tokensBefore: 84213, summary: "会话前半段：讨论了浏览器预览页的调试方式、preview.html 的 stub 注入事故与修复，以及大纲轨道高亮色从 focusBorder 蓝改为纯白的三处改动。" },
    { role: "user", content: [{ type: "text", text: "把轨道的蓝色改成滚白色", attachments: [1, 2] }] },
    { role: "assistant", content: [
      { type: "text", text: "改了三处（都在轨道交互链上）：" },
    ], stopReason: "error", errorMessage: "API stream error: model overloaded (503), retry 3/3 failed" },
  ];

  const MOCK_TABS = { type: "tabs", tabs: [{ id: "t1", title: "浏览器预览" }], activeTabId: "t1" };

  // 会话文件灌入：node scripts/preview-html.mjs <会话jsonl路径>（会记住路径，watch 重编后
  // 自动重灌）；--mock 清除记忆回 mock；不传参数且有记忆则重灌上次会话
  let uiMessages = MESSAGES;
  let uiSessionName = "浏览器预览";
  let uiModel = { name: "GLM 5.3 Flash", id: "glm-5.3-flash", provider: "openrouter" };
  let uiThinking = "high";
  let uiStats = { contextPercent: 82, cost: 0.92 };
  let uiQueued = [
    { qid: "q1", text: "把报错堆栈贴一下" },
    { qid: "q2", text: "顺便把版本号 bump 了", imageCount: 1 },
  ];
  let uiBanner = { kind: "contextWarning", text: "上下文占用 82%，建议压缩会话", actionLabel: "压缩" };
  if (sessionPath) {
    const s = loadSessionFile(sessionPath);
    uiMessages = s.messages;
    uiSessionName = s.name;
    if (s.model) uiModel = s.model;
    if (s.thinkingLevel) uiThinking = s.thinkingLevel;
    uiStats = { contextPercent: 0, cost: 0 };
    uiQueued = [];
    uiBanner = null;
  }

  const MOCK_UISTATE = {
    type: "uiState", tabId: "t1",
    messages: uiMessages, live: null,
    queued: uiQueued,
    banner: uiBanner,
    modeText: "Auto", busy: false, compacting: false,
    model: uiModel,
    thinkingLevel: uiThinking,
    stats: uiStats,
    sessionFile: sessionPath || "", sessionName: uiSessionName,
  };

  // stub 必须先于 main.js 求值（webview 启动即 acquire）。webviewReady 一到就派发模拟宿主消息。
  // 注意：stub 是裸 JS——模板 {{js}} 占位符本身已在 <script nonce> 内（同宿主 webview-html.ts 的
  // 注入方式），再包一层 <script> 会在 stub 自己的 </script> 处被解析器提前截断，stub 首行的
  // <script> 字面量成了语法错误，acquireVsCodeApi 没定义 → main.js 启动即挂、整页只剩静态模板
  // （实测事故 2026-09-21，复现为浏览器预览空白空态）
  const stub = `
window.__wvLog = [];
window.acquireVsCodeApi = function () {
  var fired = false;
  return {
    postMessage: function (m) {
      window.__wvLog.push(m);
      console.log('%c[webview→]', 'color:#4ec96e;font-weight:bold', m);
      if (m && m.type === 'webviewReady' && !fired) {
        fired = true;
        setTimeout(function () {
          window.dispatchEvent(new MessageEvent('message', { data: ${escJ(JSON.stringify(MOCK_TABS))} }));
          window.dispatchEvent(new MessageEvent('message', { data: ${escJ(JSON.stringify(MOCK_UISTATE))} }));
        }, 80);
      }
    },
    getState: function () { return {}; },
    setState: function () {},
  };
};`;

  const nonce = Math.random().toString(36).slice(2);
  const vars = {
    lang: "zh",
    theme: "midnight",
    nonce,
    duckUri: "", // 浏览器里没有 vscode 资源协议，吉祥物留空（img 空态可接受）
    version,
    // 外链而非内联：vite watch 重编后刷新浏览器即见新样式，预览页不用重新生成
    headAssets: '<link rel="stylesheet" href="./main.css"><style>html { background: #1f1f1f !important; }</style>',
    js: stub, // 裸 JS：{{js}} 在 <script nonce> 内；外链 main.js 由下方挂到 </body> 前
    bgLayer: "", // 预览页不注入背景图层（与宿主缺省一致）
  };

  // 外链 main.js 不进 nonce script（<script src> 不能嵌在 script 元素内）：预览页已摘 CSP，
  // 直接挂到 </body> 前，无 nonce 需求
  let html = template.replace(
    /\{\{(?:(\w+):)?([\w.]+)\}\}/g,
    (_, ns, key) => (ns === "t" ? String(L[key] ?? "") : (vars[key] ?? "")),
  );
  // file:// 下 meta CSP 会拦外链脚本（script-src 'nonce-…'）：预览页不需要 CSP，直接摘掉
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "");
  // 外链 main.js 挂在最后一个 </body> 前：不能用 replace("</body>")——会话数据里可能内嵌
  // 模板原文（含 </body>），第一个命中点在 payload 字符串内部，外链标签连着未转义的
  // </script> 一起被注进 JSON 字符串 → stub 语法崩（实测事故 2026-09-21，灌真实会话才触发）
  const bi = html.lastIndexOf("</body>");
  html = html.slice(0, bi) + '<script src="./main.js"></script>\n</body>' + html.slice(bi);

  writeFileSync(join(dist, "preview.html"), html);
  return join(dist, "preview.html");
}

// 手动跑：node scripts/preview-html.mjs（需要先有 dist 产物；vite closeBundle 会自动生成，一般不用手跑）
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath("file://" + process.argv[1].replace(/\\/g, "/"))) {
  const arg = process.argv[2];
  if (arg === "--mock") {
    try { unlinkSync(SESSION_STATE); } catch { /* 本来就没记忆 */ }
    buildPreview();
    console.log("✓ 已生成 mock 版预览页（已清除会话记忆）");
  } else {
    if (arg) writeFileSync(SESSION_STATE, arg);
    const out = buildPreview(arg);
    const used = arg || readLastSession();
    console.log("✓ 已生成 " + out + (used ? "（灌入会话: " + used + "）" : "（mock）"));
  }
  console.log("  浏览器打开该文件；改 webview/ 源码后 `npx vite build --watch` 自动重编，浏览器 Ctrl+R 刷新。");
  console.log("  灌真实会话：node scripts/preview-html.mjs <会话jsonl路径>（记住路径，watch 重编后自动重灌）；--mock 回 mock");
}
