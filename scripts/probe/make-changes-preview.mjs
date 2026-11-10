/**
 * 变更页渲染探针（2026-11-05）：生成 dist/webview/preview-chgpage.html，
 * 用真实 dist/webview/main.js + main.css 渲染「变更页」，供无头浏览器截图核对
 * （浏览器里没法手点扩展面板，这套 stub 就是面板页的唯一可视化回归路径）。
 *
 * 运行：node scripts/probe/make-changes-preview.mjs（先 npm run compile）
 * 截图：chrome --headless=new --screenshot=out.png --window-size=1200,820 file:///.../preview-chgpage.html
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(root, "dist", "webview");
const require = createRequire(import.meta.url);
const pkg = require(join(root, "package.json"));

const template = readFileSync(join(root, "webview", "index.html"), "utf8");
// 预览不需要 CSP（file:// 下会拦外链脚本）
const escJ = (s) => s.replace(/<\/script/gi, "<\\/script");

const TABS = { type: "tabs", tabs: [{ id: "t1", title: "预览" }], activeTabId: "t1" };
const UISTATE = {
  type: "uiState",
  tabId: "t1",
  messages: [],
  live: null,
  queued: [],
  banner: null,
  modeText: "Auto",
  busy: false,
  compacting: false,
  model: { name: "GLM 5.3 Flash", id: "glm-5.3-flash", provider: "zai" },
  thinkingLevel: "high",
  stats: { contextPercent: 12, cost: 0.02 },
  sessionFile: "x.jsonl",
  sessionName: "变更页预览",
};
const CHANGES_LIST = {
  type: "changesList",
  tabId: "t1",
  files: [
    { path: "/w/index.wxss", source: "tool" },
    { path: "/w/index.js", source: "tool" },
    { path: "/w/data.js", source: "git" },
  ],
};
const DIFF_WXSS = [
  "@@ -1,6 +1,9 @@",
  " page {",
  "   background: #080d18;",
  "   width: 100%;",
  "-  height: 100%;",
  "+  min-height: 100vh;",
  "+  height: 100vh;",
  "   overflow: hidden;",
  " }",
  "@@ -9,5 +12,6 @@",
  " .page {",
  "-  min-height: 100vh;",
  "-  padding: 48rpx 32rpx 64rpx;",
  "+  position: relative;",
  "+  padding: 14rpx 14rpx calc(14rpx + env(safe-area-inset-bottom));",
  "   background: #080d18;",
  "   color: #eef2ff;",
  " }",
].join("\n");
const DIFF_JS = [
  "@@ -40,4 +40,7 @@ export function build() {",
  "   const list = load();",
  "-  return list.map(toCard);",
  "+  return list",
  "+    .filter(Boolean)",
  "+    .map(toCard).sort((a, b) => a.stage.localeCompare(b.stage)).slice(0, 120);",
  " }",
].join("\n");
const PAGE = {
  type: "changesPage",
  tabId: "t1",
  totalAdds: 1012,
  totalDels: 326,
  files: [
    { path: "/w/index.wxss", rel: "index.wxss", adds: 1004, dels: 97, diff: DIFF_WXSS, canDiff: true, canRevert: true },
    { path: "/w/index.js", rel: "src/index.js", adds: 6, dels: 1, diff: DIFF_JS, canDiff: true, canRevert: false },
    { path: "/w/data.js", rel: "data.js", adds: 2, dels: 228, diff: "", note: "二进制文件，不支持文本对比", canDiff: false, canRevert: false },
  ],
};

const stub = `
window.__wvLog = [];
window.acquireVsCodeApi = function () {
  var fired = false;
  return {
    postMessage: function (m) {
      window.__wvLog.push(m);
      if (m && m.type === 'webviewReady' && !fired) {
        fired = true;
        setTimeout(function () {
          window.dispatchEvent(new MessageEvent('message', { data: ${escJ(JSON.stringify(TABS))} }));
          window.dispatchEvent(new MessageEvent('message', { data: ${escJ(JSON.stringify(UISTATE))} }));
          setTimeout(function () {
            window.dispatchEvent(new MessageEvent('message', { data: ${escJ(JSON.stringify(CHANGES_LIST))} }));
            var bar = document.querySelector('.session-view:not(.offview) #changesbar');
            var btn = bar && bar.querySelector('.b-act');
            if (btn) btn.click();
            else console.error('changesbar 按钮没找到');
            window.dispatchEvent(new MessageEvent('message', { data: ${escJ(JSON.stringify(PAGE))} }));
            // #note / #js：额外点一下别的文件，验证选中切换与 note/多文件路径
            var pick = location.hash.indexOf('note') >= 0 ? 2 : location.hash.indexOf('js') >= 0 ? 1 : -1;
            if (location.hash.indexOf('scroll') >= 0) setTimeout(function () {
              var panes = document.querySelectorAll('.session-view:not(.offview) .chg-pane');
              if (panes[1]) panes[1].scrollLeft = 300;
              // 联动核对：右格应被同步到同位置
              setTimeout(function () {
                document.title = 'n=' + panes.length + ' L=' + (panes[0] ? panes[0].scrollLeft + '/' + panes[0].scrollWidth + '/' + panes[0].clientWidth : 'x') + ' R=' + (panes[1] ? panes[1].scrollLeft + '/' + panes[1].scrollWidth + '/' + panes[1].clientWidth : 'x');
              }, 120);
            }, 900);
            if (location.hash.indexOf('split') >= 0) setTimeout(function () {
              var sp = document.querySelector('.session-view:not(.offview) .chg-split');
              var files = document.querySelector('.session-view:not(.offview) .chg-files');
              if (!sp) return;
              function mev(type, x) { sp.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true })); }
              mev('mousedown', 240);
              document.dispatchEvent(new MouseEvent('mousemove', { clientX: 430, bubbles: true }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              document.title = 'files=' + (files ? files.style.width : 'x');
            }, 900);
            if (pick >= 0) setTimeout(function () {
              var rows = document.querySelectorAll('.session-view:not(.offview) .chg-f');
              if (rows[pick]) rows[pick].click();
            }, 150);
          }, 200);
        }, 60);
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
  duckUri: "",
  version: pkg.version,
  headAssets: '<link rel="stylesheet" href="./main.css">',
  js: stub,
  bgLayer: "",
};
let html = template.replace(/\{\{(?:(\w+):)?([\w.]+)\}\}/g, (_, ns, key) => String(vars[key] ?? ""));
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "");
const bi = html.lastIndexOf("</body>");
html = html.slice(0, bi) + '<script src="./main.js"></script>\n</body>' + html.slice(bi);
const out = join(dist, "preview-chgpage.html");
writeFileSync(out, html);
console.log(out);
