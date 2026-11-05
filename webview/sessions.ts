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
  (document.getElementById("new") as HTMLElement).innerHTML = ico("plus", 16);
  (document.getElementById("refresh") as HTMLElement).innerHTML = ico("refresh", 16);
  (document.getElementById("gear") as HTMLElement).innerHTML = ico("gear", 16);

  /** 全量条目（宿主 svItems 唯一事实源）；sel = 选中下标（键盘导航），渲染即过滤。
   *  item.subs = 属于本主会话的子会话（2026-11-02 用户拍板「主会话加收放按钮，展开是
   *  对应的子智能体」）——不再全堆在底部一个全局组（那样跟右侧浮窗重复）*/
  let items: { file: string; label: string; time: string; subs?: { file: string; label: string; time: string }[] }[] = [];
  /** 未归属的子会话（无台账 parentSession 的老单）：单独一组堆底部，至少不让它们消失 */
  let subs: { file: string; label: string; time: string }[] = [];
  /** 展开状态：主会话按 file 记，未归属组用 "__orphans__" */
  let expanded: Record<string, boolean> = {};
  let subsOpen = false;
  let sel = -1;

  /** feather 风格线性图标（currentColor 描边，随主题文字色）。网格约定：viewBox 固定 24，
   *  所有路径必须画在 24 网格上——事故：gear 直接抄 main.ts ICON_PATHS.gear（那是 16 网格，
   *  配 viewBox 16 用），塞进 24 画布后既缩成 16/24 又整体偏左上，大小位置一起错（2026-10-20）。*/
  function ico(name: string, size?: number): string {
    const s = size || 14;
    const p: Record<string, string> = {
      plus: '<path d="M12 5v14M5 12h14"/>',
      refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
      trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
      // 与聊天页头 ✳ 同一个齿轮（main.ts ICON_PATHS.gear 同形，按 ×1.5 从 16 网格换算到 24）——菜单入口移列，图标不换脸
      gear: '<circle cx="12" cy="12" r="3.15"/><path d="M12 2.25v3.3M12 18.45v3.3M2.25 12h3.3M18.45 12h3.3M5.25 5.25l2.4 2.4M16.35 16.35l2.4 2.4M18.75 5.25l-2.4 2.4M7.65 16.35l-2.4 2.4"/>',
    };
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p[name] || ""}</svg>`;
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
    const q = qEl.value.trim().toLowerCase();
    const matchSub = function (s: { label: string; file: string }): boolean {
      return !q || s.label.toLowerCase().indexOf(q) >= 0 || s.file.toLowerCase().indexOf(q) >= 0;
    };
    var rowsHtml = '';
    for (var ri2 = 0; ri2 < list.length; ri2++) {
      var it = list[ri2];
      var item = items[it.idx];
      var kids = (item && item.subs) ? item.subs.filter(matchSub) : [];
      // 搜索命中子行时自动展开（不然搜不到实感）；否则尊重手动的展开态
      var open = q ? kids.length > 0 : !!expanded[it.file];
      rowsHtml +=
        `<div class="row${it.idx === sel ? ' sel' : ''}" data-idx="${it.idx}" data-file="${esc(it.file)}">` +
        `<span class="r-caret${kids.length ? '' : ' empty'}">${kids.length ? (open ? '▾' : '▸') : ''}</span>` +
        `<span class="r-label">${esc(it.label)}</span>` +
        `<span class="r-time">${esc(it.time)}</span>` +
        `<span class="r-del" title="${esc(L.svDelete)}">${ico('trash')}</span>` +
        `</div>`;
      if (open) {
        for (var ki = 0; ki < kids.length; ki++) {
          rowsHtml +=
            `<div class="row sub" data-file="${esc(kids[ki].file)}">` +
            `<span class="r-label">${esc(kids[ki].label)}</span>` +
            `<span class="r-time">${esc(kids[ki].time)}</span>` +
            `</div>`;
        }
      }
    }
    // 未归属组（老同步单）：无 parentSession 可挂，堆底部一个折叠组
    const subsShown = subs.filter(matchSub);
    const openAll = q ? subsShown.length > 0 : subsOpen;
    const groupHtml = subs.length
      ? `<div class="group-head" data-group="sub">` +
        `<span class="g-caret">${openAll ? '▾' : '▸'}</span>` +
        `<span class="g-label">${esc(L.svSubOrphans)} (${subsShown.length})</span></div>` +
        (openAll
          ? subsShown
              .map(
                (s) =>
                  `<div class="row sub" data-file="${esc(s.file)}">` +
                  `<span class="r-label">${esc(s.label)}</span>` +
                  `<span class="r-time">${esc(s.time)}</span>` +
                  `</div>`
              )
              .join('')
          : '')
      : '';
    listEl.innerHTML = rowsHtml + groupHtml;
    const isEmpty = !list.length && !subsShown.length;
    emptyEl.style.display = isEmpty ? 'block' : 'none';
    if (isEmpty) {
      // 搜索态 ≠ 真没会话：过滤没命中只报一句，不催用户新建（否则搜错字就冒出大按钮）
      const filtering = qEl.value.trim() !== '';
      const big = document.getElementById('empty-new');
      const plain = document.getElementById('empty-plain');
      if (big) big.style.display = filtering ? 'none' : 'flex';
      if (plain) plain.style.display = filtering ? 'block' : 'none';
    }
    const cur = listEl.querySelector('.row.sel') as HTMLElement | null;
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // 点击行 = 打开；点删除钮 = 删除（stopPropagation 防穿到打开）
  listEl.addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).closest(".r-del") as HTMLElement | null;
    const head = (e.target as HTMLElement).closest(".group-head") as HTMLElement | null;
    const caret = (e.target as HTMLElement).closest(".r-caret") as HTMLElement | null;
    if (head) { subsOpen = !subsOpen; render(); return; } // 未归属组开合
    const row = (e.target as HTMLElement).closest(".row") as HTMLElement | null;
    if (!row) return;
    const file = row.getAttribute("data-file") || "";
    // 展开箭头：只切展开态，不打开会话（stopPropagation 语义靠这里提前 return）
    if (caret && !caret.classList.contains("empty")) {
      expanded[file] = !expanded[file];
      render();
      return;
    }
    if (del) { vscode.postMessage({ type: "svDelete", file }); return; }
    if (row.classList.contains("sub")) {
      // 子会话行：直接开会话页签（与浮窗行同链路：openOrFocusSession → 另开页签）
      const hit = subs.find((s) => s.file === file) ||
        (items.map(function (m) { return m.subs || []; }).reduce(function (a, b) { return a.concat(b); }, []) as any[]).find(function (s) { return s.file === file; });
      vscode.postMessage({ type: "svOpen", file, label: hit ? hit.label : undefined });
      return;
    }
    const ridx = parseInt(row.getAttribute("data-idx") || "-1", 10);
    sel = ridx;
    render();
    // label 随行带上：宿主侧「已恢复会话: xxx」提示用人话标题，不落 jsonl 文件名
    vscode.postMessage({ type: "svOpen", file, label: items[ridx] ? items[ridx].label : undefined });
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
      if (sel >= 0 && sel < items.length) vscode.postMessage({ type: "svOpen", file: items[sel].file, label: items[sel].label });
    } else if (e.key === "Escape") {
      sel = -1;
      render();
    }
  });
  qEl.addEventListener("input", () => render());

  (document.getElementById("new") as HTMLElement).addEventListener("click", () => vscode.postMessage({ type: "svNew" }));
  // 空态大按钮/大符号：整块可点，直接开新会话（新用户第一眼就该看到这个）
  (document.getElementById("empty-new") as HTMLElement).addEventListener("click", () => vscode.postMessage({ type: "svNew" }));
  (document.getElementById("refresh") as HTMLElement).addEventListener("click", () => vscode.postMessage({ type: "svRefresh" }));
  // ⚡ 菜单（宿主路由到最近激活的编辑器标签，副栏兑底——见 panel.moreFromList）
  (document.getElementById("gear") as HTMLElement).addEventListener("click", () => vscode.postMessage({ type: "svMore" }));

  // 宿主→webview：svItems 唯一事实源（全量重发，本地零影子状态——与聊天 tabs 同纪律）；
  // svTheme = 主题广播（body[data-theme] 就地换，与聊天面板同款 token）
  window.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data as { type: string; items?: { file: string; label: string; time: string; subs?: { file: string; label: string; time: string }[] }[]; subs?: { file: string; label: string; time: string }[]; name?: string };
    if (m.type === "svItems") {
      items = m.items || [];
      subs = m.subs || [];
      if (sel >= items.length) sel = -1;
      render();
    } else if (m.type === "svTheme") {
      document.body.setAttribute("data-theme", m.name || "auto");
    }
  });

  // 启动握手：通知宿主发条目（防 HTML 后 postMessage 竞态，同聊天 webviewReady 口径）
  vscode.postMessage({ type: "svReady" });
})();
