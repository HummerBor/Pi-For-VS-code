/**
 * 会话列表 webview 脚本（刀6 B：原生 TreeView 改写成 webview，与聊天共用 tokens）。
 * 由 vite 第二入口构建：dist/webview/sessions.js，宿主 getSessionsHtml 注入。
 * 交互对齐原生树的既有能力（B 刀选型代价项）：搜索过滤、↑↓+Enter 键盘导航、
 * 悬停删除、点击打开。风格沿 main.ts 的 ES5 var（同仓一致，类型门禁同款 strict:false）。
 */
import { STRINGS, type Lang } from "../src/core/i18n";
import "./sessions.css";
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const L = STRINGS[((document.documentElement.lang || "zh") === "en" ? "en" : "zh") as Lang];

(function () {
  const vscode = acquireVsCodeApi();
  const qEl = document.getElementById("q") as HTMLInputElement;
  const listEl = document.getElementById("list")!;
  const emptyEl = document.getElementById("empty")!;
  (document.getElementById("new") as HTMLElement).innerHTML = ico("plus");
  (document.getElementById("refresh") as HTMLElement).innerHTML =ico("refresh");

  /** 全量条目（宿主 svItems 唯一事实源）；sel = 选中下标（键盘导航），渲染即过滤 */
  let items: { file: string; label: string; time: string }[] = [];
  let sel = -1;

  function ico(name: string): string {
    // 与聊天面板同款 feather 风格线性图标（currentColor 描边，随主题文字色）
    const p: Record<string, string> = {
      plus: '<path d="M12 5v14M5 12h14"/>',
      refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
      trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
    };
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p[name] || ""}</svg>`;
  }

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** 过滤（搜索框内容对 label+file 子串，大小写不敏感）；渲染用全量 items 的下标，sel 不串位 */
  function filtered(): { file: string; label: string; time: string; idx: number }[] {
    const q = qEl.value.trim().toLowerCase();
    const out: { file: string; label: string; time: string; idx: number }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!q || it.label.toLowerCase().indexOf(q) >= 0 || it.file.toLowerCase().indexOf(q) >= 0) {
        out.push({ file: it.file, label: it.label, time: it.time, idx: i });
      }
    }
    return out;
  }

  function render() {
    const list = filtered();
    listEl.innerHTML = list
      .map(
        (it) =>
          `<div class="row${it.idx === sel ? " sel" : ""}" data-idx="${it.idx}" data-file="${esc(it.file)}">` +
          `<span class="r-label">${esc(it.label)}</span>` +
          `<span class="r-time">${esc(it.time)}</span>` +
          `<span class="r-del" title="${esc(L.svDelete)}">${ico("trash")}</span>` +
          `</div>`
      )
      .join("");
    emptyEl.style.display = list.length ? "none" : "block";
    const cur = listEl.querySelector(".row.sel") as HTMLElement | null;
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  // 点击行 = 打开；点删除钮 = 删除（stopPropagation 防穿到打开）
  listEl.addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).closest(".r-del") as HTMLElement | null;
    const row = (e.target as HTMLElement).closest(".row") as HTMLElement | null;
    if (!row) return;
    const file = row.getAttribute("data-file") || "";
    if (del) { vscode.postMessage({ type: "svDelete", file }); return; }
    sel = parseInt(row.getAttribute("data-idx") || "-1", 10);
    render();
    vscode.postMessage({ type: "svOpen", file });
  });

  // 键盘导航：↑↓ 移动选中（带过滤态换算）、Enter 打开、Esc 清选
  qEl.addEventListener("keydown", (e) => {
    const list = filtered();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!list.length) return;
      let pos = list.findIndex((x) => x.idx === sel);
      pos = e.key === "ArrowDown" ? Math.min(pos + 1, list.length - 1) : Math.max(pos - 1, 0);
      if (pos < 0) pos = 0;
      sel = list[pos].idx;
      render();
    } else if (e.key === "Enter") {
      if (sel >= 0 && sel < items.length) vscode.postMessage({ type: "svOpen", file: items[sel].file });
    } else if (e.key === "Escape") {
      sel = -1;
      render();
    }
  });
  qEl.addEventListener("input", () => render());

  (document.getElementById("new") as HTMLElement).addEventListener("click", () => vscode.postMessage({ type: "svNew" }));
  (document.getElementById("refresh") as HTMLElement).addEventListener("click", () => vscode.postMessage({ type: "svRefresh" }));

  // 宿主→webview：svItems 唯一事实源（全量重发，本地零影子状态——与聊天 tabs 同纪律）；
  // svTheme = 主题广播（body[data-theme] 就地换，与聊天面板同款 token）
  window.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data as { type: string; items?: { file: string; label: string; time: string }[]; name?: string };
    if (m.type === "svItems") {
      items = m.items || [];
      if (sel >= items.length) sel = -1;
      render();
    } else if (m.type === "svTheme") {
      document.body.setAttribute("data-theme", m.name || "auto");
    }
  });

  // 启动握手：通知宿主发条目（防 HTML 后 postMessage 竞态，同聊天 webviewReady 口径）
  vscode.postMessage({ type: "svReady" });
})();
