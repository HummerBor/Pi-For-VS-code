/**
 * webview 前端脚本（聊天面板全部交互逻辑）。
 * 由 vite 构建：npm run build:webview → dist/webview/main.js，宿主 getHtml 注入 webview。
 * 历史说明：曾以字符串数组内联在 panel.ts 里，故主体保留 ES5 var 风格。
 * 类型门禁：strict:false 下 tsc 零报错（已摘除 @ts-nocheck，工单一验收项）。
 */
import { STRINGS, type Lang } from "../src/core/i18n";
import type { SlashCommand, WorkspaceFile } from "../src/core/protocol";
// 跨功能共享状态（活动页签 / 每视图 busy、变更页数据）与变更页整块逻辑：见 core/state.ts 头注释
import { getActiveTabId } from "./core/state";
import { initSubagentDock } from "./features/subagentDock"; // 子 agent 浮窗（原住本文件，第 3 刀）
import { initMarkdown } from "./features/markdown"; // 渲染基座（原住本文件，第 5 刀 5a）
import { initLinkify } from "./features/linkify"; // 文件路径/符号可点（原住本文件，第 5 刀 5a）
import { initTabs, getTabTag, getTabsList } from "./features/tabs"; // 页签与路由：views 表/路由/页签切换/标签条/两个页面级监听（原住本文件，第 6 刀 6a）
import { initSessionView } from "./features/sessionView"; // 视图工厂 + handleMsg 整条分派链 + 各 per-view 模块装配（原住本文件，第 6 刀 6c-2）
import "./style.css";
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(state: unknown): void };

// 语言跟随宿主写入的 <html lang="zh|en">
const L = STRINGS[((document.documentElement.lang || "zh") === "en" ? "en" : "zh") as Lang];
(function(){

  var vscodeApi = acquireVsCodeApi();
  // ── 工单十五：tabId 收发桥（协议见 src/protocol.ts TabTag）──
  // webview→宿主的消息统一带活动标签的 tabId（tabNew/tabSwitch/tabClose 自带目标标）；
  // tabId 的写口（activateTab / routeMsg）随 6a 进了 features/tabs.ts，本文件只经 getTabTag()
  // 读它打标；宿主 tabs 回包是最终事实源
  var vscode = {
    postMessage: function (m: any) { var tid = getTabTag(); if (tid !== null && m.tabId === undefined) m.tabId = tid; vscodeApi.postMessage(m); },
    getState: function () { return vscodeApi.getState(); },
    setState: function (s: unknown) { vscodeApi.setState(s); }
  };
  // ── webview 红字自动落盘（2026-10-19）：VS Code 的 webview 控制台要走命令面板
  // 「Developer: Open Webview Developer Tools」，不是 F12——用户不该为查 bug 开调试器。
  // 未捕获异常/未处理 rejection 直接回传宿主 → pi-chat-debug.log，排查者自己看。
  // 本监听自身必须零抛错（抛了会递归进 error 监听）：try 包死 + 同类去重（循环里炸会刷屏）
  var wvErrSeen: Record<string, boolean> = {};
  function reportWvError(kind: string, message: string, file?: string, line?: number, stack?: string) {
    try {
      var key = kind + '|' + String(message || '');
      if (wvErrSeen[key]) return; // 同类只报首条
      wvErrSeen[key] = true;
      vscodeApi.postMessage({
        type: 'wvError', kind: kind, message: String(message || '').slice(0, 500),
        file: String(file || ''), line: line || 0, stack: String(stack || '').slice(0, 2000)
      });
    } catch (e) { /* 链路坏了就没办法，绝不抛 */ }
  }
  window.addEventListener('error', function (e: ErrorEvent) {
    reportWvError('error', e.message, e.filename, e.lineno, e.error && (e.error as any).stack);
  });
  window.addEventListener('unhandledrejection', function (e: PromiseRejectionEvent) {
    var r: any = e.reason;
    reportWvError('unhandledrejection', r && r.message ? r.message : String(r), '', 0, r && r.stack);
  });
  // ── 输入历史（↑↓ 回溯）：输入框自身功能，刻意不挂 pi 链路。模块级一份 = 所有会话/页签
  // 通用；内存态不落盘，webview 重建即失（用户口径：本次 VSC 启动期间生效）。发送即入账
  //（含排队插话——插队走同一个 send()）；只记文字，附件/图片/代码上下文不随行复现 ──
  var sentHistory: string[] = [];

  // ── 视图工厂 / 消息分派（第 6 刀 6c-2）：每页签一个完全隔离的 SessionView ──
  // 整块（建视图 + 查元素 + 各 per-view 模块装配 + bindComposerOnce/bindViewEvents +
  // handleMsg 整条 if/else 分派链 + 队列条/回溯/chip/滚动跟随 + 视图 dispose）在
  // features/sessionView.ts。本文件只剩装配：页面级依赖一律经 deps 注入；「初始化晚于本装配点」
  // 的（原型快照 sessionArea/protoHTML、渲染基座 linkify/renderRich、页头 sessionEl、子 agent
  // 浮窗、欢迎页快照、tabs 产出的 routeMsg/handleTabs/renderCodeChipAll）走 getter / 转发器
  // ——与 6a 的 initTabs 同口径。装配位置刻意留在原处：initTabs 的 makeView 就是这里返回的工厂。
  var sessionView = initSessionView({
    lang: L, el: el, ico: ico, esc: esc, shorten: shorten,
    vscodeApi: vscodeApi, vscode: vscode,
    history: sentHistory, // ★ 页面级：注入数组引用，唯一持有者仍是本文件（跨页签一份）
    reportWvError: reportWvError,
    getLinkifyEnabled: getLinkifyEnabled, setLinkifyEnabled: setLinkifyEnabled,
    getLinkify: function () { return linkify; },
    getRenderRich: function () { return renderRich; },
    getProtoHTML: function () { return protoHTML; },
    getSessionArea: function () { return sessionArea; },
    getWelcomeHTML: function () { return welcomeHTML; }, duckInto: duckInto, pickTip: pickTip,
    getSessionEl: function () { return sessionEl; },
    getSubDock: function () { return subDock; },
    // tabs 产出的三件：initTabs 需要 makeView（本装配在它之前）→ 转发到调用时现取
    routeMsg: function (m) { tabs.routeMsg(m); },
    handleTabs: function (m) { tabs.handleTabs(m); },
    renderCodeChipAll: function () { tabs.renderCodeChipAll(); }
  });
  var makeSessionView = sessionView.makeView;

  // ── 页签与路由（第 6 刀 6a）：views 表 / 消息路由 / 页签切换 / 标签条 / 宿主清单 / 两个
  // 页面级监听（document Esc 关页、window message 入口）整块在 features/tabs.ts ──
  // 唯一持有者是该模块（本文件不再持有 views / tabsList / tabId 任何一个）。viewFor 别名供
  // 页面级调用点（drop、subDock.refreshBusy）用；视图内的 routeMsg / handleTabs /
  // renderCodeChipAll（codechip 点击、codeCtx 分支、不可达的 tabs 分支、renderQ 回灌）随
  // 6c-2 搬进 features/sessionView.ts，经上面的转发器注入，正文零改（口径同 4/5 刀的别名）。
  // 装配位置刻意留在原 Esc 监听处：document keydown 的注册顺序 = 本页签 Esc → 凭证页 Esc
  // （后者在下方立即执行的 IIFE 里绑），交换就等于改「Esc 先关谁」的语义。
  // 活动页签 id 本身住 core/state.ts（getActiveTabId/setActiveTabId）：document 级监听与
  // 路由都跨视图读写它，单一读写口在那边。
  var tabs = initTabs({
    makeView: makeSessionView, lang: L,
    post: function (m) { vscode.postMessage(m); },
    el: el, ico: ico, shorten: shorten,
    // 以下各项初始化晚于本装配点（页面元素/子 agent 浮窗都在本文件中段）：一律转调，调用时现取
    getSessionEl: function () { return sessionEl; },
    applySubTab: function (tid) { subDock.applyTab(tid); },
    subagentUpdate: function (m) { subDock.handleUpdate(m); },
    subagentLedger: function (rows) { subDock.setLedger(rows); },
    // 函数声明（已提升）：直接给引用
    showAuthPanel: showAuthPanel, renderAuthProviders: renderAuthProviders, applyDuck: applyDuck,
    setWebviewState: function (s) { vscodeApi.setState(s); }
  });
  var viewFor = tabs.viewFor;
  // 下区原型：启动时按页签克隆（元素 ID 在各视图内重复，查询一律 scope 到视图）
  var sessionArea = document.getElementById('session-area') as HTMLElement;
  var protoView = sessionArea.querySelector('.session-view') as HTMLElement;
  var protoHTML = protoView.outerHTML;
  sessionArea.innerHTML = '';
  // ── 统一 SVG 图标集（16 网格描边风，currentColor 跟随主题）──
  var ICON_PATHS = {
    clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8V8l2.4 1.6"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    term: '<path d="M3 5.5l3 2.5-3 2.5"/><path d="M8.5 10.5H13"/>',
    gear: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.5 3.5l1.6 1.6M10.9 10.9l1.6 1.6M12.5 3.5l-1.6 1.6M5.1 10.9l-1.6 1.6"/>',
    theme: '<circle cx="8" cy="8" r="6.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4Z" fill="currentColor" stroke="none"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.3" r="1.1"/><path d="M2.5 11.5L6 8.5l2.3 1.9 2.7-2.6 2.6 2.4"/>',
    file: '<path d="M4 1.8h5.2L12.5 5v9.2H4Z"/><path d="M9 1.8V5h3.5"/>',
    filecode: '<path d="M4 1.8h5.2L12.5 5v9.2H4Z"/><path d="M9 1.8V5h3.5"/><path d="M6.2 8L5 9.2l1.2 1.2M9.8 8L11 9.2 9.8 10.4"/>',
    cpu: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/><path d="M8 1.8v2.7M8 11.5v2.7M1.8 8h2.7M11.5 8h2.7"/>',
    up: '<path d="M8 13V3.5M4.2 7.3L8 3.5l3.8 3.8"/>',
    stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/>',
    x: '<path d="M4 4l8 8M12 4L4 12"/>',
    trash: '<path d="M2.5 4.5h11"/><path d="M6.5 2.5h3"/><path d="M4.5 4.5l.7 9h5.6l.7-9"/><path d="M6.7 7.5v3.5M9.3 7.5v3.5"/>',
    chev: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    check: '<path d="M3.2 8.6l3 3L12.8 4.4"/>',
    at: '<circle cx="8" cy="8" r="2.2"/><path d="M10.2 8v.8a2 2 0 0 0 4 0V8a6.2 6.2 0 1 0-2.4 4.9"/>',
    // codicon loading 同款：断弧圆环，旋转动效在 CSS（.ico-spin）
    loading: '<circle cx="8" cy="8" r="5.5" stroke-dasharray="26 9"/>'
  };
  function ico(name: string, size?: number) {
    var s = size || 14;
    return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  // SVG 图标专用：el() 是 textContent 安全写入，塞 ico() 的标记会显示成源码（0.0.124 事故）
  function elIco(cls: string, svg: string) { var n = el('span', cls); n.innerHTML = svg; return n; }
  // 超长名字中段省略（保头保尾）：CSS ellipsis 只能截尾，长文件名会把 chip 撑满一整行、
  // 还把 × 挤出可视区（overflow:hidden 裁掉）导致删不掉——JS 先截短才是根治；全名看 title
  function shorten(s: string, max: number) {
    if (!s || s.length <= max) return s;
    var head = Math.ceil((max - 1) * 0.6);
    var tail = Math.floor((max - 1) * 0.4);
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }
  // ── 文件路径可点击：识别文本里的路径 → .fp span → openPath 给宿主打开 ──
  // 整块（FILE_RE / cleanPath / linkify / linkifySymbol / .fp 点击委托）在 features/linkify.ts；
  // 渲染基座（renderInline / renderPlain / renderTable / renderRich）在 features/markdown.ts。
  // ★ R8 全局总闸：linkifyEnabled 全仓只有下面这一份——renderAll 先关它让老消息不扫正则
  //   （大会话卡顿的唯一止血），再边循环边对最近 15 条打开；linkify.ts 只经 deps 的
  //   getLinkifyEnabled / setLinkifyEnabled 读写。两边各留一份必然对不上，卡顿会原样回归。
  var linkifyEnabled = true; // renderAll 批量重绘时关掉老消息的 linkify，只留最近几条（全量扫正则是大会话卡顿的主因）
  function getLinkifyEnabled() { return linkifyEnabled; }
  function setLinkifyEnabled(v: boolean) { linkifyEnabled = v; }
  var linkifyMod = initLinkify({
    getLinkifyEnabled: getLinkifyEnabled, setLinkifyEnabled: setLinkifyEnabled,
    sessionArea: sessionArea, post: function (m) { vscode.postMessage(m); }
  });
  // 别名：全文件其余调用点（renderRich 在 5a，notice/renderAll 在 5d 的 features/messageList.ts，
  // toolStart/toolEnd 在 5c，subagentDock 已搬）原样不动
  var linkify = linkifyMod.linkify;
  // markdown 的 renderRich 收尾要调 linkify，故装配排在它之后（模块内无状态，装配顺序即依赖顺序）
  var markdown = initMarkdown({ el: el, linkify: linkify });
  var renderRich = markdown.renderRich;

  // ── 头部/工具条图标注入（统一 SVG）── 头部是页面级（不随页签克隆）
  var sessionEl = document.getElementById('session') as HTMLElement;
  var moreEl = document.getElementById('more') as HTMLElement;
  var subindEl = document.getElementById('subind') as HTMLElement;
  var newChatEl = document.getElementById('newchat') as HTMLElement;
  var historyEl = document.getElementById('history') as HTMLElement;
  historyEl.innerHTML = ico('clock');
  newChatEl.innerHTML = ico('plus');
  moreEl.innerHTML = ico('gear');
  subindEl.innerHTML = ico('cpu', 15); // 芯片图标 = 子 agent 锚点

  // ── 历史会话：点 ⏱ 直接打开原生会话菜单（QuickPick）──
  historyEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickSession' }); });
  // ── 欢迎页：从原型取快照 + 随机小贴士（新建会话时重新出现，每次换一条）──
  var welcomeEl = protoView.querySelector('#welcome');
  var welcomeHTML = welcomeEl ? welcomeEl.outerHTML : '';
  // 欢迎页/头部鸭子图（DuckMsg）：宿主换图不再整页重载（事故注释见 protocol.ts DuckMsg）。
  // welcomeHTML 是启动时的快照、img src 已烧死在里头，注入后必须用当前图覆盖一次
  var duckUriNow = '';
  function applyDuck(uri: string) {
    if (!uri) return;
    duckUriNow = uri;
    var lg = document.getElementById('logo') as HTMLImageElement | null;
    if (lg) lg.src = uri;
    var ws = document.querySelectorAll('.w-duck');
    for (var i = 0; i < ws.length; i++) (ws[i] as HTMLImageElement).src = uri;
  }
  function duckInto(root: HTMLElement) {
    if (!duckUriNow) return;
    var w = root.querySelector('.w-duck') as HTMLImageElement | null;
    if (w) w.src = duckUriNow;
  }
  var TIPS = L.tips;
  function pickTip(el) { if (el) { var t = el.querySelector('.w-tip'); if (t) t.textContent = '💡 ' + TIPS[Math.floor(Math.random() * TIPS.length)]; } }
  pickTip(welcomeEl);
  function el(tag: string, cls: string, text?: string) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== '') e.textContent = text;
    return e;
  }

  // ── 凭证配置页（2026-11-05）───────────────────────────────────────────────
  // 背景：新用户首屏只看到「先 /login 或 API key 配置」一行纯文字，真正入口在齿轮菜单的
  // QuickPick 链里（选服务商 → 粘 key），关掉就得重找。这里给一个常驻页：一处看全部
  // 服务商、填/存/删一步到位，订阅登录同页可点。
  // 职责：webview 只渲染与收集输入，读写 ~/.pi/agent/auth.json 全在宿主（piSetup）；
  // 密钥不留在 webview 状态里（提交即清空输入框，列表只显示「已配置」）。
  // 无凭证时弹窗常驻（2026-11-05 用户口径）：没配 key 面板本来就没别的可干，
  // 关掉只会让用户找不到入口——所以锁住它（无 ✕、Esc/遮罩无效），配好才自动关
  var authLocked = false;
  function applyAuthLock() {
    var x = document.getElementById('ap-close');
    if (x) x.style.display = authLocked ? 'none' : '';
    var h = document.getElementById('ap-lockhint');
    if (h) h.style.display = authLocked ? '' : 'none';
  }
  function closeAuthPanel(force?: boolean) {
    if (authLocked && !force) return;
    var apEl = document.getElementById('authpanel');
    if (apEl) apEl.style.display = 'none';
  }
  function renderAuthProviders(list: any[]) {
    var sel = document.getElementById('ap-provider') as HTMLSelectElement | null;
    var rows = document.getElementById('ap-rows');
    if (!rows) return;
    // 下拉：所有服务商（已配置的标个勾，方便换 key）；列表：只列已配置的
    if (sel) {
      var cur = sel.value;
      sel.innerHTML = '';
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var o = document.createElement('option');
        o.value = p.id;
        o.textContent = (p.kind ? '✔ ' : '') + (p.label || p.id);
        sel.appendChild(o);
      }
      if (cur) sel.value = cur;
    }
    rows.innerHTML = '';
    var any = false;
    for (var j = 0; j < list.length; j++) {
      var q = list[j];
      if (!q.kind) continue;
      any = true;
      (function (p: any) {
        var row = el('div', 'ap-item');
        var name = el('div', 'ap-name', p.label || p.id);
        name.appendChild(el('span', 'ap-id', p.id));
        var state = el('span', 'ap-badge', p.kind === 'oauth' ? L.authOauth : L.authKey);
        var del = el('button', 'ap-btn ap-del', L.authDeleteBtn);
        del.onclick = function () { vscode.postMessage({ type: 'authDelete', provider: p.id }); };
        row.appendChild(name);
        row.appendChild(state);
        row.appendChild(del);
        rows.appendChild(row);
      })(q);
    }
    if (!any) rows.appendChild(el('div', 'ap-empty', L.authEmpty));
    var wasLocked = authLocked;
    authLocked = !any;
    applyAuthLock();
    // 刚配好凭证（锁定 → 解锁）：用户来这一页就是为配置，配完自动收起回到对话
    if (wasLocked && !authLocked) closeAuthPanel(true);
  }
  /** 打开配置页：先展示旧数据（无闪屏），再向宿主要 auth.json 真值 */
  function showAuthPanel() {
    var apEl = document.getElementById('authpanel');
    if (!apEl) return;
    apEl.style.display = 'flex';
    vscode.postMessage({ type: 'authOpen' });
  }
  (function () {
    var apEl = document.getElementById('authpanel');
    if (!apEl) return;
    var close = document.getElementById('ap-close');
    if (close) close.onclick = function () { closeAuthPanel(); };
    // Esc 关闭（弹窗该有的基本手感）；无凭证时锁住（closeAuthPanel 内部判定）
    document.addEventListener('keydown', function (e: KeyboardEvent) {
      if (e.key === 'Escape' && apEl.style.display !== 'none') closeAuthPanel();
    });
    // 背景点击关闭（点在卡片外才算，卡片内点击不关）
    apEl.addEventListener('click', function (e: Event) {
      if (e.target === apEl) closeAuthPanel();
    });
    var login = document.getElementById('ap-login');
    if (login) login.onclick = function () { vscode.postMessage({ type: 'authLogin' }); };
    // API key 表单：选服务商 → 粘 key → 保存（提交即清空输入框，明文不留在页面）
    var saveBtn = document.getElementById('ap-save');
    if (saveBtn) saveBtn.onclick = function () {
      var sel = document.getElementById('ap-provider') as HTMLSelectElement | null;
      var keyEl = document.getElementById('ap-key') as HTMLInputElement | null;
      if (!sel || !keyEl) return;
      var v = keyEl.value.trim();
      if (!v) { keyEl.focus(); return; }
      vscode.postMessage({ type: 'authSave', provider: sel.value, key: v });
      keyEl.value = '';
    };
  })();
  // ── 子 agent 监控：浮窗 ──
  // 2026-11-21 第 3 刀：浮窗渲染（概览行/秒表/失败原因行/台账并入同一张表/跨页签 liveSeen
  // 去重）整块搬进 features/subagentDock.ts（initSubagentDock(deps) + 返回入口，与
  // changesPage / ctxPopover 同款）。本文件只留实例与转调，DOM/协议/阈值一个都没动。
  var subDock = initSubagentDock({
    lang: L,
    el: el,
    elIco: elIco,
    ico: ico,
    linkify: linkify,
    post: function (m) { vscode.postMessage(m); },
    getActiveTabId: getActiveTabId,
    sessionArea: sessionArea,
    subindEl: subindEl,
    refreshBusy: function (tid) { viewFor(tid).refreshBusy(); }
  });
  // 下区控件监听已随视图绑定（bindViewEvents）；这里只绑页面级头部控件
  sessionEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickSession' }); });
  moreEl.addEventListener('click', function () { vscode.postMessage({ type: 'more' }); });
  // 语言/主题头部按钮已移除：功能保留（pickLang/pickTheme），入口收进 ⚙ 设置菜单
  // 子 agent 浮窗：头部 spinner / 状态行 chip 开合（绑定体在 features/subagentDock.ts）
  subDock.bind();
  // 复制兑底（2026-10-23 用户「选中的没办法复制」）：Ctrl+C / 右键复制把选区显式写剪贴板，
  // 不靠浏览器默认路径；再缓存「最后一次非空选区」——流式重绘（root 重建）会在点菜单之前
  // 把选区冲掉，拿缓存兑底，复制命中的是你圈的那段而不是空选区
  var lastSelText = '';
  document.addEventListener('selectionchange', function () {
    var s = String(window.getSelection() || '');
    if (s) lastSelText = s;
  });
  document.addEventListener('copy', function (e: ClipboardEvent) {
    var sel = String(window.getSelection() || '') || lastSelText;
    if (!sel || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', sel);
    e.preventDefault();
  });
  // 头部 ＋ → 开新标签会话（工单十五入口收敛，用户拍板 2026-09-14）：多标签时代
  // 「新会话」只有一种语义=开新标签（新持久会话，不中断谁，无 busy 确认）；
  // 原中断式 newSession 只剩 ⚡菜单/slash 命令（当前标签内操作）
  newChatEl.addEventListener('click', function () { vscode.postMessage({ type: 'tabNew' }); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  // 三期：drop 落到活动视图。守卫不能只看 files——资源管理器拖入可能 files 为空、只有
  // text/uri-list（只认 files 时拖入被 preventDefault 白吞，输入框毫无反应，2026-10 用户实测）
  window.addEventListener('drop', function (e) { e.preventDefault(); var dt = e.dataTransfer; if (dt && getActiveTabId() !== null && ((dt.files && dt.files.length) || dt.getData('text/uri-list') || dt.getData('resourceurls'))) viewFor(getActiveTabId()).handleFiles(dt.files || [], dt); });
  // 重绘窗口期到达的流式事件排队与按原序重放（pendingStream / deferDuringRender /
  // drainPendingStream）随 5f 进 features/renderQueue.ts，各视图一个实例（renderQ）。
  // 启动握手：通知宿主 webview 已就绪，宿主拉会话历史重绘（防止设置 HTML 后立刻 postMessage 被丢的竞态）
  vscode.postMessage({ type: 'webviewReady' });

  // 心跳探活 + 断连红条已退役（2026-11-02 用户拍板，别再捡回来）：
  // 它本是为「幽灵面板」（宿主重启后 webview 保活、provider 实例丢失）做可见化，但判定是
  // 「距上次 pong 的绝对时长 > 12s」且发完 ping 立刻判定——分不清「对面死了」和「我自己刚醒」。
  // 实测被 webview 自己的卡顿刷成假阳性：日志里 webview 侧 ping 时间戳连跳 19.4s（定时器漏 6 拍），
  // 宿主全程正常回话。用户看到的是「插件炸了」的红条 + 怀疑，代价远大于收益。
  // 幽灵面板的处置回到:关标签重开（会话已落盘，不丢）；这是平台边界，无自愈 API。
})();

