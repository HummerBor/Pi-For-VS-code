/**
 * webview 前端脚本（聊天面板全部交互逻辑）。
 * 由 vite 构建：npm run build:webview → dist/webview/main.js，宿主 getHtml 注入 webview。
 * 历史说明：曾以字符串数组内联在 panel.ts 里，故主体保留 ES5 var 风格。
 * 类型门禁：strict:false 下 tsc 零报错（已摘除 @ts-nocheck，工单一验收项）。
 */
import { STRINGS, type Lang } from "../src/core/i18n";
import type { HostToWebviewTagged, SlashCommand, WorkspaceFile, BannerPayload, ChangesFileInfo } from "../src/core/protocol";
// 跨功能共享状态（活动页签 / 每视图 busy、变更页数据）与变更页整块逻辑：见 core/state.ts 头注释
import { createViewState, getActiveTabId } from "./core/state";
import { initChangesPage } from "./features/changesPage";
import { initCtxPopover } from "./features/ctxPopover"; // 上下文用量弹层 + 页脚圆环（原住本文件）
import { initSubagentDock } from "./features/subagentDock"; // 子 agent 浮窗（原住本文件，第 3 刀）
import { initComposer } from "./features/composer"; // 输入区（原住本文件，第 4 刀）
import { initMarkdown } from "./features/markdown"; // 渲染基座（原住本文件，第 5 刀 5a）
import { initLinkify } from "./features/linkify"; // 文件路径/符号可点（原住本文件，第 5 刀 5a）
import { initLiveStream } from "./features/liveStream"; // live 流式增量渲染（原住本文件，第 5 刀 5b）
import { initToolRows } from "./features/toolRows"; // 工具调用行（原住本文件，第 5 刀 5c）
import { initSticky } from "./features/sticky"; // 最后一问钉住折叠（原住本文件，第 5 刀 5e）
import { initOutline } from "./features/outline"; // 右缘消息大纲轨道（原住本文件，第 5 刀 5g）
import { initMessageList } from "./features/messageList"; // 整树重绘 / 用户气泡 / toast（原住本文件，第 5 刀 5d）
import { initRenderQueue } from "./features/renderQueue"; // 渲染队列：重绘/续接排队 + 重绘窗口期流式事件排队（原住本文件，第 5 刀 5f）
import { initTabs, getTabTag, getTabsList } from "./features/tabs"; // 页签与路由：views 表/路由/页签切换/标签条/两个页面级监听（原住本文件，第 6 刀 6a）
import { initStatusBar } from "./features/statusBar"; // 状态行/页脚/横幅 + applyState/fmtSession（原住本文件，第 6 刀 6c-1）
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

  // ── 三期整树搬迁（交接 4 六步法）：每页签一个完全隔离的 SessionView 工厂闭包 ──
  // 自己的 DOM/状态/定时器/输入框；routeMsg 经 viewFor(tid).handleMsg 一行直达。换镜机制
  // （useTab/assignMirrors/saveMirrors/curTabId/bgMode）整体退役——镜像漂移（白 Working/
  // 串会话两类事故的根因）在结构上不可能再发生。函数体逐字符未动（scripts/migrate-phase3.mjs
  // 机械搬运），语义修改仅六处：①scroll bgMode→id 判定 ②applyState 同 ③上行改 vpost 显式带
  // 自己 tabId ④scheduleStream/scheduleRender 去换镜舞蹈 ⑤built 直写闭包 ⑥codeCtx 页面级
  // 数据 + renderCodeChipAll 循环各视图。重载实测重点见 BUILDER.md 交接 4。
  function makeSessionView(id: string) {
    // 本视图的共享状态（busy / 变更页数据）——每页签一份，绝不进应用级容器（见 state.ts 头注释）
    var S = createViewState(id);
    var view = document.createElement('div');
    view.className = 'session-view' + (id === getActiveTabId() ? '' : ' offview');
    view.innerHTML = protoHTML;
    sessionArea.appendChild(view);
    var root = view.querySelector('.msg-root') as HTMLElement;
    // 下区控件元素引用（原 72-77 行全局镜像组，三期改为建视图时一次性查询绑定）
    var q = function (sel: string) { return view.querySelector(sel) as HTMLElement; };
    var input = q('#input') as HTMLTextAreaElement; var stopBtn = q('#stop'); var sendBtn = q('#send');
    var modeBadge = q('#modebadge'); var codechipEl = q('#codechip');
    var modelEl = q('#model'); var thinkEl = q('#think');
    var attachEl = q('#attach'); var fileInput = q('#file') as HTMLInputElement;
    var plusmenuEl = q('#plusmenu'); var pmUpload = q('#pm-upload'); var pmAt = q('#pm-at');
    var queuebarEl = q('#queuebar');
    // 变更页（2026-11-05）：页级覆盖层，随视图克隆——各页签各看各的本轮改动。
    // 整块（元素查询 / 清单与 diff 渲染 / 拖拽）已搬到 features/changesPage.ts；这里只把闭包里的
    // 上行通道、i18n、建 DOM 工具传进去，数据（chgData/chgSel）住本视图的 state。
    var changesPage = initChangesPage({ state: S, q: q, post: vpost, lang: L, el: el });
    var compactbarEl = q('#compactbar'); // 压缩浮动条（仿改动条：完成后提示 + 点击定位折叠块）
    var outlineEl = q('#outline'); // 消息大纲轨道（每页签一棵，随视图克隆；逻辑见 features/outline.ts）
    // 上下文用量弹层 + 页脚用量圆环（2026-11-05）：随页签克隆，数据全由宿主 ctxDetail 一条
    // 消息给全。整块（元素引用 / 圆环与弹层渲染 / 阈值滑块 / 1s 心跳）已搬到
    // features/ctxPopover.ts；这里只把闭包里的上行通道、i18n、转义工具传进去。
    var ctxPop = initCtxPopover({ q: q, post: vpost, lang: L, esc: esc });
    // 视图内上行显式带自己的 tabId（不再借活动页签打标——换镜退役后归属唯一）
    function vpost(m: any) { if (m.tabId === undefined) m.tabId = id; vscodeApi.postMessage(m); }
  // ── 输入区（附件 / 联想菜单 / 发送链 / 键位 / 全角归一）：整块在 features/composer.ts ──
  // 这里只装配：元素查询、上行通道、i18n、建 DOM 工具注入进去。待发附件与联想菜单状态
  // 归模块独占（本文件不再持有 pendingImages/pendingFiles/sg*）；页面级 sentHistory /
  // slashCmds / workspaceFiles / codeCtx 一律注入引用或 getter，不复制（见模块头注释）。
  var composer = initComposer({
    q: q, post: vpost, lang: L, el: el, ico: ico, esc: esc, shorten: shorten,
    notice: notice,
    history: sentHistory,
    getCodeCtx: function () { return codeCtx; }, isCodeOn: function () { return codeOn; },
    resetHist: function () { histIdx = -1; histDraft = ''; },
    histNav: histNav,
    pages: { hasPage: function () { return changesPage.hasPage(); }, close: function () { changesPage.close(); } },
    getSlashCmds: function () { return slashCmds; }, getFiles: function () { return workspaceFiles; },
    resetNotice: function () { clearNotice(); }
  });
  // 别名：bindComposerOnce / bindViewEvents / histNav 的正文照旧按这些名字调（零字差异）
  var send = composer.send; var inputKeydown = composer.inputKeydown; var inputPaste = composer.inputPaste;
  var normalizeInputWidth = composer.normalizeInputWidth; var updateSuggest = composer.updateSuggest;
  var autoSize = composer.autoSize; var handleFiles = composer.handleFiles;
  var queuedItems = [];
  // ── 最后一问钉住折叠（粘性气泡）：整块在 features/sticky.ts ──
  // 本视图一套（「当前最后一问」引用 stickyQ 与每视图一个 IntersectionObserver 都在模块内独占，
  // 这里不再持有同名变量——stickyQ 全仓只允许声明一处，见 R7）。只注入消息区根与 i18n；
  // scroll 留本文件，它只经 pinCheck() 进钉住判定，绝不反向持有滚动状态（两个模块各存一份 =
  // 「钉错气泡 / 钉住态来回闪」）。追加二/三/四/五 四轮闪烁修正的判据与事故注释随逻辑进模块。
  var sticky = initSticky({ root: root, lang: L });
  // ── 工具行（工具名 + IN/OUT 行，同名连续成组）：整块在 features/toolRows.ts ──
  // 本视图一套（工具行索引 toolEls 与成组指针 lastToolGroup 都在模块内独占，这里不再持有同名
  // 变量）。只注入消息区根、建 DOM 工具、图标、linkify 基座、i18n 与滚动跟随。别名供其余调用点
  // （handleMsg 的 toolStart/toolEnd 分支、renderAll 的历史重放）按原符号名调，正文零改。
  var toolRows = initToolRows({
    root: root, el: el, ico: ico, linkify: linkify, lang: L, scroll: scroll
  });
  var toolStart = toolRows.toolStart; var toolEnd = toolRows.toolEnd;
  var resetToolRows = toolRows.resetToolRows;
  // ── live 流式（在途消息的增量渲染）：整块在 features/liveStream.ts ──
  // 本视图一套（在途气泡 / parts 表 / 流式定时器都在模块内独占，这里不再持有同名变量）。
  // 只注入消息区根、建 DOM 工具、markdown 基座、i18n 与滚动跟随——scroll 留本文件（R7：
  // 它只经 features/sticky.ts 的 pinCheck() 进钉住判定，两份滚动/钉住状态必然对不上）。别名供其余调用点
  // （handleMsg / renderAll / setBusy / dispose）按原符号名调，正文零改。
  var liveStream = initLiveStream({
    root: root, el: el, renderRich: renderRich, lang: L, scroll: scroll
  });
  var finalizeLive = liveStream.finalizeLive; var liveReset = liveStream.liveReset;
  var liveBlock = liveStream.liveBlock; var appendDelta = liveStream.appendDelta;
  var appendThink = liveStream.appendThink; var applyLiveSync = liveStream.applyLiveSync;
  // 状态缝（模块独占 liveMsg / pdet / liveDiv 的唯一读写口，见模块头注释红线一）
  var liveToolPart = liveStream.liveToolPart; var bindToolPart = liveStream.bindToolPart;
  var setPDet = liveStream.setPDet; var dropEmptyLive = liveStream.dropEmptyLive;
  var clearStreamTimer = liveStream.clearStreamTimer;
  // ── 状态行 / 页脚 / 横幅：整块在 features/statusBar.ts（第 6 刀子刀 6c-1）──
  // 本视图一套（Working 秒表的 busyStart/lastElapsed/roundFrozen/busyTimer 与启动秒表的
  // bootTickTimer/bootTickStart 都在模块内独占，本文件不再持有同名变量）。别名供 handleMsg
  // 的调用点按原符号名调（正文零改——handleMsg 整体搬迁是下一单 6c-2 的事）。
  // 下面四个量仍住本文件：**写口在 handleMsg**（本单不许碰），所以它们是唯一一份，模块经
  // deps 的 getter/setter 读写同一份内存，两边都不存副本（照 6a 的 getTabsList 先例）。
  var queueN = 0; // 状态行排队计数（uiState / queue 两支同页签对齐）
  var compacting = false;
  var modeText = 'Auto';
  var banner: BannerPayload | null = null; var changes: ChangesFileInfo[] | null = null;
  /** B 刀：本页签是否处在「启动占位帧」阶段（uiState.booting）——真值帧到达才置回 false。
   *  占位存在期间，任何空闲态渲染（setBusy(false)/切回页签 refreshBusy）都不许碰状态行，
   *  否则会三次擦掉「pi 后台启动中…」提示（见 applyState / renderBusyUi 两处守卫）。
   *  6c-1 后写入点仍是本文件的 uiState 分支 + 模块的 applyState：同一份内存，模块经
   *  deps.getBooting / setBootingFlag 走。 */
  var bootPending = false;
  var statusBar = initStatusBar({
    viewId: id, q: q, state: S, lang: L, ico: ico, esc: esc,
    post: vpost, postPage: function (m) { vscode.postMessage(m); },
    getSessionEl: function () { return sessionEl; }, // 页头是页面级，初始化晚于视图构建
    subDock: subDock, changesPage: changesPage, ctxPop: ctxPop,
    finalizeLive: finalizeLive, liveReset: liveReset,
    getQueueN: function () { return queueN; },
    getCompacting: function () { return compacting; },
    setCompactingFlag: function (v) { compacting = v; },
    getBooting: function () { return bootPending; },
    setBootingFlag: function (v) { bootPending = v; },
    getModeText: function () { return modeText; }
  });
  var setStatus = statusBar.setStatus; var startBootTick = statusBar.startBootTick;
  var stopBootTick = statusBar.stopBootTick; var renderStatus = statusBar.renderStatus;
  var renderBanner = statusBar.renderBanner; var renderChanges = statusBar.renderChanges;
  var setBusy = statusBar.setBusy; var setCompacting = statusBar.setCompacting;
  var renderBusyUi = statusBar.refreshBusy; var applyState = statusBar.applyState;
  // 变更页数据（chgData/chgSel）已移入本视图的 state（core/state.ts 的 ViewState），
  // 读写全在 features/changesPage.ts 里
    var built = false; // uiState/render 快照是否已建树（activateTab 按此决定要不要向宿主要快照）
  /** 输入区一次性绑定（v25，2026-11-19 用户实测「输入框点发送直接没反应」的止血）。
   *
   *  这几条原来写在 bindViewEvents 尾部：那个函数**前面任何一处抛错**，就永远执行不到这里
   *  ——而模板里 input 是 `disabled` 的（V 刀为消灭「画出来但没绑」的死窗口故意加的），
   *  于是输入框点不动、回车没反应、发送按钮点了没反应，而且**日志零留痕**（消息根本没离开
   *  webview）。0.1.20「全控件死」（bindViewEvents 漏调）是同族事故。
   *
   *  现在提到模块级 + 幂等标志：视图绑定那坨再怎么炸，发消息这条命脉必须活着。
   *  绑定前会先把元素查好（静态模板元素，模块加载时就在）。 */
  var composerBound = false;
  function bindComposerOnce() {
    if (composerBound) return;
    composerBound = true;
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', inputKeydown);
    input.addEventListener('paste', inputPaste);
    // 用户一编辑即退出回溯（程序化赋值不触发 input，不影响 histNav）
    // 全角归一（2026-11-03 用户报「输入法切到全角，输入框里英文变成 ｓ ｓ ｓ 大间距」）：
    // 组字中不动，上屏后立刻转半角，见 toHalfWidth 注释
    input.addEventListener('input', function (e) {
      histIdx = -1; histDraft = '';
      if (!(e as any).isComposing) normalizeInputWidth();
      updateSuggest(); autoSize();
    });
    // Chrome 里 compositionend 早于最终 input 落字，补一刀跟着归一（幂等，重复调用无副作用）
    input.addEventListener('compositionend', function () { setTimeout(normalizeInputWidth, 0); });
    input.disabled = false; // 按键已绑才放开输入框（模板里 disabled，消灭死窗口）
  }

  function bindViewEvents() {
    // 变更页的页内绑定（返回按钮 + 标题文案 + 左清单拖拽宽度）已随整块逻辑搬到
    // features/changesPage.ts 的 bind()——调用点保持在这（bindViewEvents 开头），
    // 绑定顺序/时机与拆分前一致
    changesPage.bind();
    attachEl.innerHTML = ico('image');
    pmUpload.innerHTML = ico('image', 13) + '<span>' + L.uploadFile + '</span><span style=' + String.fromCharCode(34) + 'opacity:.5;font-size:10px;margin-left:auto;' + String.fromCharCode(34) + '>' + L.dragShift + '</span>';
    pmAt.innerHTML = ico('at', 13) + '<span>' + L.referenceFile + '</span>';
    modelEl.innerHTML = ico('cpu') + ' —';
    // 页脚用量入口（圆圈结构 + 弹层 hover/✕/滑块绑定）已随整块逻辑搬到
    // features/ctxPopover.ts 的 bind()——调用点保持在原「页脚用量入口」这里。
    ctxPop.bind();
    stopBtn.innerHTML = ico('stop', 11);
    sendBtn.innerHTML = ico('up', 14);
    // ── ＋菜单：上传图片 / 引用文件 ──
    attachEl.addEventListener('click', function (e) {
      e.stopPropagation();
      plusmenuEl.style.display = plusmenuEl.style.display === 'block' ? 'none' : 'block';
    });
    pmUpload.addEventListener('click', function () { plusmenuEl.style.display = 'none'; fileInput.click(); });
    pmAt.addEventListener('click', function () {
      plusmenuEl.style.display = 'none';
      var v = input.value.replace(/[\s/@]+$/, ''); // 去掉尾部残留的斜杠/@/空格（斜杠菜单触发符、重复点击）
      input.value = (v ? v + ' ' : '') + '@'; // 已有文字补空格，@ 才能触发搜索（@ 要求行首或空格后）
      input.focus(); updateSuggest();
    });
    bindComposerOnce(); // 发送命脉单独绑（见函数注释）：bindViewEvents 前面炸了也照样能发
    stopBtn.addEventListener('click', function () { vpost({ type: 'abort' }); });
    fileInput.addEventListener('change', function () { handleFiles(fileInput.files || [], null); fileInput.value = ''; });
    modelEl.addEventListener('click', function () { vpost({ type: 'pickModel' }); });
    thinkEl.addEventListener('click', function () { vpost({ type: 'pickThinking' }); });
    modeBadge.addEventListener('click', function () { vpost({ type: 'pickMode' }); });
    codechipEl.addEventListener('click', function () { codeOn = !codeOn; renderCodeChipAll(); });
    renderCodeChip();
  }
    // ＋菜单文档级关闭监听：每视图一份各关各的（原全局监听读镜像，随换镜退役）
    document.addEventListener('click', function (e) { var tgt = e.target as Node; if (!plusmenuEl.contains(tgt) && tgt !== attachEl) plusmenuEl.style.display = 'none'; });
  function renderCodeChip() {
    if (!codeCtx) { codechipEl.style.display = 'none'; return; }
    codechipEl.style.display = 'inline-flex';
    codechipEl.innerHTML = ico('filecode', 12) + ' ' + esc(codeCtx.name) + (codeCtx.range ? ' <span class="cc-range">' + esc(codeCtx.range) + '</span>' : '');
    codechipEl.className = 'tb-btn' + (codeOn ? '' : ' off');
    codechipEl.title = (codeOn ? L.chipOff : L.chipOn) + '\n' + codeCtx.rel + ' (' + codeCtx.range + ')';
  }
  // ── 工单十七：滚动跟随（对齐 pi TUI ScrollView 的 follow 语义，chat-viewport.js:5 follow:"end"）──
  // 跟随 = 钉在内容底；用户滚离底部 → 跟随自动暂停；滚回最底 → 自动恢复
  // （pi-tui scroll-view.js:125-131 `followingEnd = followEnd && next === maxScrollTop` 的 DOM 映射）。
  // TUI 用 `next === maxScrollTop` 精确等值，DOM 里给 48px 容差：①DOM 内容增长不触发 scroll
  // 事件，程序化拉底后有像素/取整容差；②流式内容高频增长，精确等值会把跟随频繁误判为暂停
  var followingEnd = true;
  // 工单十九回归修复终版（替代两版被 revert 的 rAF 方案）：读写交错每帧两次强制布局
  // （layout thrashing）比不修还卡。终版思路：程序化滚动不判定，用户滚动才判定——
  // scroll() 拉底前压 suppressScroll 标志，本标志的 scroll 事件直接跳过（零布局读）；
  // 非程序化滚动（用户拖滚动条/滚轮/触摸）才读一次布局判 followingEnd。流式时 delta
  // 改 DOM + 拉底全程零读布局，钉底同步无延迟；在底时误判定结果恒 true 无害
  var suppressScroll = false;
  // 滚动监听已随每页签 root 建（makeRoot）；只有可见根会发 scroll 事件，写全局镜像即正确
  // 仅跟随时拉底：用户上滑读历史（followingEnd=false）后，流式 tick/notice 等所有调用点不再拽人
  function scroll() {
    if (!followingEnd) return;
    // 后台视图 display:none 无布局，scrollTop 写不进去——切回时由 activateTab 按跟随标志补拉底
    if (id !== getActiveTabId()) return;
    // 追加三：回复变长后补一次钉住判定（IO 只在 sentinel 越界瞬间回调，内容从短到长时不会再触发）
    sticky.pinCheck(); // R7：钉住判定只有这一条路（stickyQ 住 features/sticky.ts）
    suppressScroll = true;
    root.scrollTop = root.scrollHeight;
  }
  // ── 消息大纲轨道（右缘一列短横线 = 每条用户消息一个锚点）：整块在 features/outline.ts ──
  // 本视图一套（锚点表 olAnchors、rAF 合顿标志、olSuspend 挂起开关、ResizeObserver 都在模块内
  // 独占，本文件不再持有同名变量）。注入的全是外部引用/回调，不复制状态：
  //   ① root（RO 观察对象 + 滚动坐标系）与 outlineEl（#outline 随视图克隆）；
  //   ② q —— olScan 只读查队列条 pill（队列条状态归队列域，5f 未搬，不许复制进来）；
  //   ③ isActiveView —— 后台视图 display:none 无布局，不量不判。
  // 注意 root.scroll 上还有一条「跟随贴底」监听（本文件 makeRoot 尾部），用途不同，别与本模块的
  // scroll spy 合并或换顺序（scout F3）。
  var outline = initOutline({
    root: root, outlineEl: outlineEl, q: q, el: el,
    isActiveView: function () { return id === getActiveTabId(); }
  });

  function addQueuedDom(q) {
    var b = el('div', 'q-item');
    b.setAttribute('data-qid', q.qid);
    var qi = el('span', 'q-ico'); qi.innerHTML = ico('clock', 12); b.appendChild(qi);

    b.appendChild(el('span', 'q-text', (q.text || L.imgOrCode) + (q.fileCount ? ' +' + q.fileCount + L.qFilesUnit : '') + (q.imageCount ? ' +' + q.imageCount + L.qImgsUnit : '')));
    // 工单十六：取回按钮——文本回编辑框（用户在编辑框里删改），其余项按原类型重排队，
    // 与 pi TUI alt+up dequeue 同构，不在队列条上直接删。
    // 图标用垃圾桶：← 箭头被用户误读为「撤回」（2026-09-15 实测反馈），功能不变仍是取回，
    // hover tooltip 已写明真实语义，别把按钮行为改成直接删（破坏 pi 原生语义对齐）
    var rb = el('span', 'q-btn');
    rb.title = L.queuedRetrieveTitle;
    rb.innerHTML = ico('trash', 12);
    rb.addEventListener('click', function (ev) { ev.stopPropagation(); vpost({ type: 'queuedRetrieve', qid: q.qid }); });
    b.appendChild(rb);
    // 排队项固定在输入框上方的 queuebar，单行紧凑显示，不参与消息流
    queuebarEl.appendChild(b);
  }
  function addQueued(q) {
    queuedItems.push(q);
    addQueuedDom(q);
  }
  // ── pi 原生队列里的子 agent 回报 pill（工单26，2026-09-18）──
  // followUp 回报走 pi 原生队列，此前只有状态栏计数没有内容（“AI 自主感”信息差：
  // 用户只见“排队 3 条”和凭空多出的回合）。queue_update 事件自带 followUp 文本数组
  // （agent-session.d.ts:51 readonly string[]），命中回报前缀的渲染专用 pill。
  // 只渲染命中项：用户经面板排队的消息已有 this.queued pill，全渲染会双份。
  // 已知取舍：uiState 重建时清空缓存（uiState 不带 followUp 数组，无法跨页签对账），
  // 下一次 queue_update 重建——切页签后 pill 可能短暂消失，计数仍在
  var nativeQueuePills = [];
  function renderNativeQueue() {
    var qb = queuebarEl;
    var olds = qb.querySelectorAll('.q-item[data-native="1"]');
    for (var i = 0; i < olds.length; i++) olds[i].parentNode.removeChild(olds[i]);
    for (var j = 0; j < nativeQueuePills.length; j++) {
      var fm = nativeQueuePills[j];
      var nb = el('div', 'q-item q-native'); nb.setAttribute('data-native', '1');
      var ni = el('span', 'q-ico'); ni.innerHTML = ico('clock', 12); nb.appendChild(ni);
      nb.appendChild(el('span', 'q-text', '⮑ 子 agent ' + fm[2] + (fm[3] ? ' · ' + fm[3] : '') + ' · ' + L.subRetQueued));
      qb.appendChild(nb);
    }
  }
  function removeQueued(qid) {
    queuedItems = queuedItems.filter(function(x) { return x.qid !== qid; });
    var els = queuebarEl.querySelectorAll('[data-qid="' + qid + '"]');
    for (var i = 0; i < els.length; i++) els[i].parentNode.removeChild(els[i]);
  }
  // ── 消息渲染（用户气泡 / 整树重绘 / toast / 压缩块）：整块在 features/messageList.ts ──
  // 本视图一套（toast 存活记录 lastNotice、压缩计数基线 seenCompactions / compactBarShownAt
  // 都在模块内独占，本文件不再持有同名变量）。注入的全是外部引用/回调，不复制状态：
  //   ① 队列条属队列域（5f 未搬）→ rebuildQueuebar（先清再建幂等，事故注释见该函数）；
  //   ② 欢迎页三件是页面级启动快照 → welcomeHTML / duckInto / pickTip；
  //   ③ 大纲轨道（5g 已搬 features/outline.ts）→ outlineRebuild + setOlSuspend（逐条 addUser 时挂起防 O(N²)）；
  //   ④ 压缩条基线与 renderCompact 已随本刀进模块（上面两个状态就是它的全部事实源）。
  // linkify 总闸（R13）与 followingEnd 仍是本文件唯一持有者，写入经 accessor 成对交接；
  // stickyQ / stickyIO 不进来（R7），addUser 只经 sticky 三缝交接。
  var msgList = initMessageList({
    root: root, el: el, ico: ico, esc: esc, linkify: linkify, renderRich: renderRich, lang: L,
    scroll: scroll, post: vpost,
    adoptSticky: sticky.adoptSticky, updateStickyChip: sticky.updateStickyChip, observeSticky: sticky.observeSticky,
    toolStart: toolStart, toolEnd: toolEnd, resetToolRows: resetToolRows, liveReset: liveReset,
    outlineRebuild: outline.outlineRebuild, setOlSuspend: outline.setOlSuspend,
    setLinkifyEnabled: setLinkifyEnabled,
    setFollowingEnd: function (v: boolean) { followingEnd = v; },
    welcomeHTML: welcomeHTML, duckInto: duckInto, pickTip: pickTip,
    rebuildQueuebar: rebuildQueuebar, compactbarEl: compactbarEl
  });
  // 别名：handleMsg 的调用点按原符号名调（正文零改）
  var addUser = msgList.addUser; var renderAll = msgList.renderAll;
  // notice / clearNotice 用函数声明（提升）转调：composer 的 deps 在本函数更早处求值，
  // 那时 var 别名还没赋值（undefined）；函数声明不受这个顺序影响
  function notice(text) { msgList.notice(text); }
  function clearNotice() { msgList.clearNotice(); }
  /** 队列条幂等重建（R12 ①）：uiState 原子分支已重建过 queuebar，重绘再追加一遍 = 每条×2
   *（工单十八补刀3，用户实测切页签后翻倍——pi 没双入队，是显示层叠加）。先清再建，谁先谁后都不叠加；
   *  工单24 二期：queuebar 随页签视图走，后台渲进隐藏视图 */
  function rebuildQueuebar() {
    queuebarEl.innerHTML = '';
    for (var rq = 0; rq < queuedItems.length; rq++) addQueuedDom(queuedItems[rq]);
  }

  // 回溯状态（per 视图）：histIdx=-1 未在回溯中；histDraft 存首次回溯前的草稿，
  // 回到底部位（== sentHistory.length）时还原。sentHistory 是模块级全局一份
  var histIdx = -1; var histDraft = '';
  function histNav(dir) {
    if (!sentHistory.length) return false;
    if (histIdx === -1) {
      if (dir > 0) return false; // 未在回溯中：↓ 不接管（默认光标行为）
      histDraft = input.value; // 首次回溯：暂存当前草稿
      histIdx = sentHistory.length;
    }
    var ni = histIdx + dir;
    if (ni < 0) return true; // 已到最老一条：吞掉按键，不再跳行
    if (ni > sentHistory.length) return false; // 草稿位再 ↓：交还默认行为
    histIdx = ni;
    var s = ni === sentHistory.length ? histDraft : sentHistory[ni];
    input.value = s;
    input.setSelectionRange(s.length, s.length);
    autoSize();
    return true;
  }

  // ── 渲染队列（重绘/续接排队 + 重绘窗口期流式事件排队）：整块在 features/renderQueue.ts ──
  // 本视图一套（renderTimer / renderPending / liveSyncPending / pendingStream 都在模块内独占，
  // 本文件不再持有同名变量）。R10：renderTimer 只此一份——handleMsg 是否排队与 drainPendingStream
  // 经 routeMsg 回灌都走同一实例；routeMsg 留本文件（6a 才搬），作为 deps 回调注入。
  // renderAll 来自 features/messageList.ts（5d），applyLiveSync 来自 features/liveStream.ts（5b）。
  var renderQ = initRenderQueue({
    renderAll: renderAll, applyLiveSync: applyLiveSync,
    routeMsg: function (m) { routeMsg(m); }
  });
  function handleMsg(m: HostToWebviewTagged) {
    // 工单24：重绘在途（延后一拍）时流式事件先排队，等重绘落地再按原序补（见 pendingStream 注释）
    if (renderQ.queueDuringRender(m)) return;
    if (m.type === 'user') {
      addUser(m.text, m.imageCount, m.codeInfo, m.fileCount, m.images);
    }
    else if (m.type === 'newLive') { finalizeLive(); liveReset(); }
    // 探针实锤（probe-toolblocks.mjs）：pi 每输出一个 toolCall 就是一条独立 assistant 消息——
    // 同名合并靠 DOM 相邻判定（空壳 bubble 已移除、思考/正文 bubble 天然插队断连续），
    // newLive 本身不需要做任何事
    else if (m.type === 'delta') appendDelta(m.text, m.ci);
    else if (m.type === 'thinking') appendThink(m.text, m.ci);
    else if (m.type === 'toolStart') {
      finalizeLive();
      var olds = root.querySelectorAll('.prow'); for (var oi = 0; oi < olds.length; oi++) olds[oi].parentNode.removeChild(olds[oi]);
      // 空占位 bubble 一并移除（2026-09-20 用户实测两案同根因）：纯工具调用回合里 liveEnsure 会
      // 为每次 toolCallStart 建一个 assistant bubble（liveDiv），toolStart 时 prow 清了但空壳
      // bubble 留在 root——插在上一工具盒与下一工具行之间，既穿帮（截图空圆角色条）又破坏
      // 成组的 DOM 相邻判定（表现为「会话结束才合并」——settled 后 renderAll 重建成组）
      dropEmptyLive();
      liveReset(); toolStart(m.id, m.name, m.detail);
    }
    else if (m.type === 'toolCallStart') {
      var tp = liveBlock(m.ci, 'toolCall', m.name);
      tp._len = 0; tp.raw = '';
      bindToolPart(m.ci, tp); scroll();
    }
    else if (m.type === 'toolCallDelta') { var tb = liveToolPart(m.ci); if (tb) { tb._len += (m.chunk || '').length; tb.raw += m.chunk || ''; setPDet(L.genArgs.replace('{n}', tb._len)); if (tb.box && tb.box.style.display === 'block') tb.box.textContent = tb.raw.slice(-20000); } }
    else if (m.type === 'toolEnd') toolEnd(m.id, m.name, m.isError, m.text, m.detail);
    // subagentUpdate/subagentDetail 已在 window message 入口截获（页签过滤前），不进 handleMsg
    else if (m.type === 'uiState') {
      // 工单24：按 tabId 各归各的树（路由器已换镜），不再拒非活动快照——后台页签的树也要建/重建
      // （webview 重载后全量重建、压缩/换会话真相推送都走这里）。每页签一棵 DOM 后
      // 「慢到的旧页签快照覆盖新页签内容」这类竞态整类消失：快照只覆盖它自己的树
      built = true;
      // B 刀：标记必须赶在 setBusy 之前落——uiState 分支的顺序是 setBusy → applyState，
      // 而 setBusy(false) 内部会走 renderBusyUi 的空闲分支。若等 applyState 才置 bootPending，
      // 首帧（booting=true 的第一帧）就已经把「pi 后台启动中…」擦掉了，守卫形同虚设。
      bootPending = m.booting === true;
      // 状态栏排队计数随快照同页签对齐（原 queueN 是上个页签的 queue_update 残留值）
      queueN = (m.queued || []).length;
      banner = m.banner;
      modeText = m.modeText || '';
      renderQ.setRenderPending(m.messages); renderQ.setLiveSyncPending(m.live || null); renderQ.scheduleRender(); // 复用延后一拍：render→liveSync 同拍顺序不变
      compacting = m.compacting === true; // 先落 flag 再 setBusy：压缩真相决定状态栏写压缩标签还是 Working
      setBusy(m.busy, m.elapsedMs);
      renderStatus();
      renderBanner(m.banner);
      // queuebar 原子重建：先置数组再重建 DOM（不再走 addQueued——它 push 回数组，会翻倍）。
      // 工单24：queuebar 只属活动页签，后台页签快照只记账（切换时按账本重建）
      queuedItems = (m.queued || []).slice();
      queuebarEl.innerHTML = '';
      for (var uq = 0; uq < queuedItems.length; uq++) addQueuedDom(queuedItems[uq]);
      nativeQueuePills = []; renderNativeQueue(); // uiState 不带 followUp 数组，同上取舍
      applyState(m);
      ctxPop.scheduleQuery(); // 同上：弹层开着时跟真相走
    }
    else if (m.type === 'busy') { ctxPop.setBusy(!!m.value); setBusy(m.value, m.elapsedMs); }
    else if (m.type === 'render') { built = true; clearNotice(); /* render=会话上下文整体替换（切历史/新建/fork/导入），旧 toast 属上一段会话，随边界清掉（事故：切历史后旧「已恢复会话」残留叠加——lastNotice 只在 send() 清，renderAll 又把旧 toast 重挂进新会话）。跨重渲存续只为同会话 uiState 重渲服务，此处不清会每次切换叠一条 */ renderQ.setRenderPending(m.messages); renderQ.scheduleRender(); } // 延后一拍：让刚到的用户气泡先上屏，再慢慢重绘全页
    else if (m.type === 'liveSync') { renderQ.setLiveSyncPending(m.message); renderQ.scheduleRender(); } // 刀5b：续接重定基，排在 render 之后同一拍执行（顺序由 flushRender 保证）
    else if (m.type === 'queue') {
      queueN = (m.steering ? m.steering.length : 0) + (m.followUp ? m.followUp.length : 0); renderStatus();
      nativeQueuePills = [];
      if (m.followUp) for (var fi = 0; fi < m.followUp.length; fi++) {
        var fm2 = String(m.followUp[fi] || '').match(/^\[子 agent (\S+) (完成|失败|已终止)\] ([^:\n]*): ?/);
        if (fm2) nativeQueuePills.push(fm2);
      }
      renderNativeQueue();
    }
    else if (m.type === 'notice') notice(m.text);
    else if (m.type === 'fillInput') { followingEnd = true; histIdx = -1; histDraft = ''; input.value = m.text || ''; input.focus(); scroll(); } // 程序化填充同样退出回溯，防旧草稿盖掉回填内容 // 主动动作回底（工单十七要点 3）
    else if (m.type === 'status') {
      // N 刀：启动状态接秒表（实时走秒）；其余状态走普通通道并停秒表
      if (m.text === L.startingPi) startBootTick(m.text); else { stopBootTick(); setStatus(m.text); }
    }
    else if (m.type === 'compacting') setCompacting(m.value);
    else if (m.type === 'mode') { modeText = m.text || ''; renderStatus(); }
    else if (m.type === 'queuedAdd') addQueued(m);
    else if (m.type === 'queuedDelivered') { removeQueued(m.qid); if (m.show) addUser(m.text, m.imageCount, m.codeInfo); }
    else if (m.type === 'queuedClear') { queuedItems = []; queuebarEl.innerHTML = ''; }
    else if (m.type === 'queuedRemove') removeQueued(m.qid); // 工单十八补刀：乐观入队失败回滚单条
    else if (m.type === 'queuedRetrieved') {
      // 工单十六：取回文本合入编辑框——已有内容时换行追加，不覆盖正在输入的内容
      removeQueued(m.qid);
      histIdx = -1; histDraft = ''; // 程序化合入同 fillInput 口径：退出回溯
      input.value = input.value ? input.value + '\n\n' + (m.text || '') : (m.text || '');
      followingEnd = true; // 取回排队消息=主动动作回底（工单十七验收条，同 fillInput 口径）
      input.focus(); scroll();
    }
    else if (m.type === 'codeCtx') { codeCtx = m.ctx; renderCodeChipAll(); }
    // 待发附件归 features/composer.ts 独占：预检/去重/附件条重渲全在模块内（第 4 刀）
    else if (m.type === 'addImages') composer.addImages(m.images);
    else if (m.type === 'addFiles') composer.addFiles(m.files);
    else if (m.type === 'slashList') { slashCmds = m.commands || []; updateSuggest(); }
    else if (m.type === 'fileList') { workspaceFiles = m.files || []; updateSuggest(); }
    else if (m.type === 'state') { applyState(m); ctxPop.scheduleQuery(); }
    else if (m.type === 'ctxDetail') ctxPop.applyDetail(m);
    else if (m.type === 'banner') { banner = m.banner; renderBanner(m.banner); }
    else if (m.type === 'changesList') {
      changes = m.files; changesPage.reset(); renderChanges(m.files);
      // 变更页开着时清单变了（新 run / 页外还原）：静默重拉一次，别让页面停在旧数据上
      if (changesPage.hasPage()) vpost({ type: 'changesPageOpen' });
    }
    else if (m.type === 'changesPage') { changesPage.apply(m); }
    else if (m.type === 'theme') { document.body.setAttribute('data-theme', m.name || 'auto'); }
    else if (m.type === 'tabs') handleTabs(m);
  }
    // 滚动跟随监听随根走（工单十七）：用户滚动才判定（suppressScroll 跳过程序化拉底）
    root.addEventListener('scroll', function () {
      if (suppressScroll) { suppressScroll = false; return; }
      followingEnd = root.scrollHeight - root.scrollTop - root.clientHeight <= 48;
    }, { passive: true });
    // 点消息区 = 点到浮层外：收起上下文用量弹层（标准浮层行为；监听挂在 root 上，
    // 视图销毁即随 DOM 一起走，不往 document 上挂——那会按页签数累加并泄漏）
    root.addEventListener('click', function () { ctxPop.close(); });
    // 建视图即绑事件 + 注图标（原 makeView 职责，三期壳胶水——漏掉即全控件死，事故见 BUILDER.md 交接 5）。
    // 2026-11-19：包 try/catch/finally——binding 炸了也只损失控件，不许把输入框永久锁死，
    // 且错误必须落盘（webview 红字桥 → pi-chat-debug.log），下次不再「零留痕」。
    try {
      bindViewEvents();
    } catch (err: any) {
      reportWvError('bindViewEvents', String((err && err.message) || err), '', 0, err && err.stack);
    } finally {
      bindComposerOnce();
    }
    return {
      handleMsg: handleMsg, renderCodeChip: renderCodeChip, handleFiles: handleFiles,
      refreshBusy: renderBusyUi, // 白 Working 兑底：切回页签按本页签真相重渲状态行（激活时调）
      show: function (on: boolean) { view.classList.toggle('offview', !on); },
      isFollowing: function () { return followingEnd; },
      forceScrollToBottom: function () { suppressScroll = true; root.scrollTop = root.scrollHeight; },
      isBuilt: function () { return built; },
      /** 变更页开/合（Esc 与页内返回共用；数据刷新由宿主 changesPage 回来时重渲） */
      hasPage: changesPage.hasPage,
      closePage: changesPage.close,
      /** 上下文用量弹层：Esc / 点消息区收起（与变更页同级的浮层语义，弹层优先关） */
      closeCtxPop: ctxPop.close,
      isCtxPopOpen: ctxPop.isOpen,
      dispose: function () {
        outline.dispose(); // 断开大纲轨道的 ResizeObserver（不断开则被观察的 root 连整棵 DOM 留活）
        ctxPop.dispose();
        statusBar.dispose(); // 状态行两块秒表（busyTimer/bootTickTimer）归 features/statusBar.ts 独占
        clearStreamTimer();
        renderQ.dispose(); // 清在途的延时重绘（renderTimer 归 features/renderQueue.ts 独占）
        if (view.parentNode) view.parentNode.removeChild(view);
      }
    };
  }

  // ── 页签与路由（第 6 刀 6a）：views 表 / 消息路由 / 页签切换 / 标签条 / 宿主清单 / 两个
  // 页面级监听（document Esc 关页、window message 入口）整块在 features/tabs.ts ──
  // 唯一持有者是该模块（本文件不再持有 views / tabsList / tabId 任何一个）。别名供视图内调用点
  // （codechip 点击、codeCtx 分支、handleMsg 不可达的 tabs 分支、drop、subDock.refreshBusy、
  // renderQ 回灌）按原符号名调，正文零改（口径同 4/5 刀的别名）。
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
  var viewFor = tabs.viewFor; var renderCodeChipAll = tabs.renderCodeChipAll;
  var routeMsg = tabs.routeMsg; var handleTabs = tabs.handleTabs;
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
  var codeCtx = null; var codeOn = true;
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
  var slashCmds = null;
  var workspaceFiles = null;
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

