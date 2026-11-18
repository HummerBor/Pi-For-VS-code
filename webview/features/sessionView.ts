/**
 * 视图工厂 + 消息分派（2026-11-26 第 6 刀子刀 6c-2，从 webview/main.ts 整块拆出）：
 * makeSessionView 的全部剩余骨架 —— 建视图 + 查元素（q）、各 per-view 模块装配
 * （changesPage / ctxPopover / composer / sticky / toolRows / liveStream / statusBar /
 * outline / messageList / renderQueue）、bindComposerOnce、bindViewEvents、handleMsg 整条
 * if/else 分派链、队列条（addQueuedDom / addQueued / renderNativeQueue / removeQueued /
 * rebuildQueuebar）、renderCodeChip、滚动跟随（scroll / followingEnd / suppressScroll）、
 * 输入历史回溯（histNav / histIdx / histDraft）、视图尾部返回对象与 dispose。
 *
 * 为什么是 initSessionView(deps) 返回 makeView：每个 .session-view 是**完全隔离**的一套
 * DOM/状态/定时器（三期整树搬迁，见下方 makeSessionView 头注释），装配点在 main.ts 原位
 * （initTabs 之前调一次，initTabs 的 makeView 就是它返回的工厂）。
 *
 * ★ 红线一（零重构）：handleMsg 的整条 if/else 链**原样搬**，不许拆成「按域 dispatch」。
 *   判序契约（routeMsg / tabs 提前截获）、4s pendingPrompt 兜底（src/core/piCore.ts）、
 *   compacting > busy 优先级（statusBar.ts）、ctxDetail 真值帧通道全部零改动。
 * ★ 红线二（R2/R3 命脉）：bindComposerOnce 正文零字差异（含 histIdx/histDraft 裸赋值）；
 *   尾部 try { bindViewEvents() } catch { reportWvError } finally { bindComposerOnce() }
 *   的顺序与语义一字不动 —— 那是「输入框永久锁死 + 零留痕」事故的止血。
 * ★ 红线三（状态归属，唯一持有者）：
 *   - 视图级（每页签一份）：histIdx/histDraft、queuedItems/nativeQueuePills、followingEnd/
 *     suppressScroll、built、composerBound、queueN/compacting/modeText/banner/changes/
 *     bootPending —— 全在 makeSessionView 闭包内，随视图走。
 *   - 页面级（跨页签一份）：sentHistory 由 main.ts 持有、经 deps.history 注入**数组引用**
 *     （本模块只读写同一份数组）；codeCtx / codeOn / slashCmds / workspaceFiles 随
 *     「写口所在代码」（handleMsg / bindViewEvents / renderCodeChip）一起搬进本模块的
 *     initSessionView 闭包 —— 页面级唯一一份，**不是视图副本**。这四份没有走 deps getter/
 *     setter，是因为那会要求改写 handleMsg 正文 4 行赋值，与红线一「逐字零差异」直接冲突；
 *     二者不可兼得时按派单红线优先级取逐字（详见 reports/REPORT-t46.md「状态归属」）。
 *   - 每视图模块内部状态（busy 秒表、在途气泡、工具行索引、渲染队列定时器…）归各自模块。
 *
 * ★ 红线四（R18 元素查询纪律）：本模块内视图元素一律经视图自己的 q()（ID 在每个
 *   .session-view 内重复）；页面级唯一元素（#session / #authpanel 等）留在 main.ts。
 *
 * 逐字核对（handleMsg / bindComposerOnce / bindViewEvents / 队列 / 回溯 / renderCodeChip /
 * scroll 与 HEAD 归一化后零差异）与 8 处换名的逐条理由见 reports/REPORT-t46.md。
 */
import type { HostToWebviewTagged, BannerPayload, ChangesFileInfo } from "../../src/core/protocol";
import { createViewState, getActiveTabId } from "../core/state";
import { initChangesPage } from "./changesPage";
import { initComposer } from "./composer";
import { initCtxPopover } from "./ctxPopover";
import { initLiveStream } from "./liveStream";
import { initMessageList } from "./messageList";
import { initOutline } from "./outline";
import { initRenderQueue } from "./renderQueue";
import { initStatusBar } from "./statusBar";
import { initSticky } from "./sticky";
import { initToolRows } from "./toolRows";

export interface SessionViewDeps {
  /** i18n 文案表（main.ts 的 L） */
  lang: Record<string, any>;
  /** 建 DOM 工具（main.ts 的 el：textContent 安全写入） */
  el: (tag: string, cls: string, text?: string) => HTMLElement;
  /** 图标集查询（main.ts 的 ico：名字 → svg 串） */
  ico: (name: string, size?: number) => string;
  /** HTML 转义（main.ts 的 esc） */
  esc: (s: any) => string;
  /** 超长名字中段省略（main.ts 的 shorten） */
  shorten: (s: string, max: number) => string;
  /** acquireVsCodeApi 原始句柄：vpost 直接用它（视图级上行自己带 tabId，不走打标桥） */
  vscodeApi: { postMessage(msg: unknown): void };
  /** 页面级上行对象（读活动页签打标）：状态行的 postPage 走这条 */
  vscode: { postMessage(m: any): void };
  /** ★ 页面级输入历史（跨页签一份，注入数组引用，绝不复制；写口在 composer.send） */
  history: string[];
  /** webview 红字自动落盘（main.ts 的 reportWvError：bindViewEvents 炸了必须留痕） */
  reportWvError: (kind: string, message: string, file?: string, line?: number, stack?: string) => void;
  /** ★ R8 linkify 总闸（唯一持有者仍是 main.ts；renderAll 批量重绘先关再边循环边开） */
  getLinkifyEnabled: () => boolean;
  setLinkifyEnabled: (v: boolean) => void;
  /** 渲染基座（main.ts 的 linkify / renderRich）：initLinkify / initMarkdown 晚于本模块装配 → getter */
  getLinkify: () => any;
  getRenderRich: () => any;
  /** 下区原型快照（main.ts 启动时从模板 .session-view 取 outerHTML；晚于本装配点 → getter） */
  getProtoHTML: () => string;
  /** 视图容器 #session-area（同上 → getter） */
  getSessionArea: () => HTMLElement;
  /** 欢迎页启动快照 + 两件页面级工具（文本在 messageList 用，函数直接给引用） */
  getWelcomeHTML: () => string;
  duckInto: (root: HTMLElement) => void;
  pickTip: (el: HTMLElement) => void;
  /** 页头会话标题元素（页面级、初始化晚于视图构建 → getter） */
  getSessionEl: () => HTMLElement;
  /** 子 agent 浮窗（页面级单例，初始化晚于视图构建 → getter） */
  getSubDock: () => any;
  /** tabs 产出的路由三件：initTabs 需要 makeView（本装配在它之前）→ main.ts 侧转发到调用时 */
  renderCodeChipAll: () => void;
  routeMsg: (m: HostToWebviewTagged) => void;
  handleTabs: (m: any) => void;
}

export interface SessionViewApi {
  /** 建（或取）一个页签的视图：tabs.ts 的 makeView 就是它 */
  makeView: (id: string) => any;
}

export function initSessionView(deps: SessionViewDeps): SessionViewApi {
  // ── 注入别名：一律与 HEAD 里的符号同名（搬入正文因此零改名）──
  var L = deps.lang;
  var el = deps.el;
  var ico = deps.ico;
  var esc = deps.esc;
  var shorten = deps.shorten;
  var vscodeApi = deps.vscodeApi;
  var vscode = deps.vscode;
  var sentHistory = deps.history;
  var reportWvError = deps.reportWvError;
  var getLinkifyEnabled = deps.getLinkifyEnabled;
  var setLinkifyEnabled = deps.setLinkifyEnabled;
  var getLinkify = deps.getLinkify;
  var getRenderRich = deps.getRenderRich;
  var getProtoHTML = deps.getProtoHTML;
  var getSessionArea = deps.getSessionArea;
  var getWelcomeHTML = deps.getWelcomeHTML;
  var duckInto = deps.duckInto;
  var pickTip = deps.pickTip;
  var getSessionEl = deps.getSessionEl;
  var getSubDock = deps.getSubDock;
  var renderCodeChipAll = deps.renderCodeChipAll;
  var routeMsg = deps.routeMsg;
  var handleTabs = deps.handleTabs;
  // ── 页面级数据（跨页签一份，唯一持有者 = 本模块；写口全在下面的 makeSessionView 正文里）──
  // 为什么不放 main.ts 走 getter/setter：见文件头红线三（改了 handleMsg 正文就破坏「逐字零差异」）。
  // codeCtx/codeOn：代码上下文 chip 的页面级数据（三期⑥：数据页面级 + chip 每视图一份）
  var codeCtx = null; var codeOn = true;
  // slashCmds / workspaceFiles：宿主 slashList / fileList 回包缓存（页面级，composer 只读）
  var slashCmds = null;
  var workspaceFiles = null;

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
    view.innerHTML = getProtoHTML();
    getSessionArea().appendChild(view);
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
    root: root, el: el, ico: ico, linkify: getLinkify(), lang: L, scroll: scroll
  });
  var toolStart = toolRows.toolStart; var toolEnd = toolRows.toolEnd;
  var resetToolRows = toolRows.resetToolRows;
  // ── live 流式（在途消息的增量渲染）：整块在 features/liveStream.ts ──
  // 本视图一套（在途气泡 / parts 表 / 流式定时器都在模块内独占，这里不再持有同名变量）。
  // 只注入消息区根、建 DOM 工具、markdown 基座、i18n 与滚动跟随——scroll 留本文件（R7：
  // 它只经 features/sticky.ts 的 pinCheck() 进钉住判定，两份滚动/钉住状态必然对不上）。别名供其余调用点
  // （handleMsg / renderAll / setBusy / dispose）按原符号名调，正文零改。
  var liveStream = initLiveStream({
    root: root, el: el, renderRich: getRenderRich(), lang: L, scroll: scroll
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
    getSessionEl: getSessionEl, // 页头是页面级，初始化晚于视图构建
    subDock: getSubDock(), changesPage: changesPage, ctxPop: ctxPop,
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
    root: root, el: el, ico: ico, esc: esc, linkify: getLinkify(), renderRich: getRenderRich(), lang: L,
    scroll: scroll, post: vpost,
    adoptSticky: sticky.adoptSticky, updateStickyChip: sticky.updateStickyChip, observeSticky: sticky.observeSticky,
    toolStart: toolStart, toolEnd: toolEnd, resetToolRows: resetToolRows, liveReset: liveReset,
    outlineRebuild: outline.outlineRebuild, setOlSuspend: outline.setOlSuspend,
    setLinkifyEnabled: setLinkifyEnabled,
    setFollowingEnd: function (v: boolean) { followingEnd = v; },
    welcomeHTML: getWelcomeHTML(), duckInto: duckInto, pickTip: pickTip,
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

  return { makeView: makeSessionView };
}
