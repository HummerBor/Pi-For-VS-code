/**
 * webview 前端脚本（聊天面板全部交互逻辑）。
 * 由 vite 构建：npm run build:webview → dist/webview/main.js，宿主 getHtml 注入 webview。
 * 历史说明：曾以字符串数组内联在 panel.ts 里，故主体保留 ES5 var 风格。
 * 类型门禁：strict:false 下 tsc 零报错（已摘除 @ts-nocheck，工单一验收项）。
 */
import { STRINGS, type Lang } from "../src/core/i18n";
import type { HostToWebviewTagged, SessionMessage, SlashCommand, WorkspaceFile, BannerPayload, ChangesFileInfo, TabsMsg, TabInfo } from "../src/core/protocol";
import { toolDetail } from "../src/domain/toolDetail";
import { isEditRetryable } from "../src/domain/errorClass"; // 余额/配额/鉴权类错误不给「修改后重试」入口
// 跨功能共享状态（活动页签 / 每视图 busy、变更页数据）与变更页整块逻辑：见 core/state.ts 头注释
import { createViewState, getActiveTabId, setActiveTabId } from "./core/state";
import { initChangesPage } from "./features/changesPage";
import { initCtxPopover } from "./features/ctxPopover"; // 上下文用量弹层 + 页脚圆环（原住本文件）
import { initSubagentDock } from "./features/subagentDock"; // 子 agent 浮窗（原住本文件，第 3 刀）
import { initComposer } from "./features/composer"; // 输入区（原住本文件，第 4 刀）
import { initMarkdown } from "./features/markdown"; // 渲染基座（原住本文件，第 5 刀 5a）
import { initLinkify } from "./features/linkify"; // 文件路径/符号可点（原住本文件，第 5 刀 5a）
import { initLiveStream } from "./features/liveStream"; // live 流式增量渲染（原住本文件，第 5 刀 5b）
import "./style.css";
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(state: unknown): void };

// 语言跟随宿主写入的 <html lang="zh|en">
const L = STRINGS[((document.documentElement.lang || "zh") === "en" ? "en" : "zh") as Lang];
(function(){

  var vscodeApi = acquireVsCodeApi();
  // ── 工单十五：tabId 收发桥（协议见 src/protocol.ts TabTag）──
  // webview→宿主的消息统一带活动标签的 tabId（tabNew/tabSwitch/tabClose 自带目标标）；
  // tabId 跟随活动标签变化（activateTab 更新），宿主 tabs 回包是最终事实源
  var tabId: string | null = null;
  var vscode = {
    postMessage: function (m: any) { if (tabId !== null && m.tabId === undefined) m.tabId = tabId; vscodeApi.postMessage(m); },
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
    var statusEl = q('#status'); var modeBadge = q('#modebadge'); var codechipEl = q('#codechip');
    var modelEl = q('#model'); var thinkEl = q('#think');
    var attachEl = q('#attach'); var fileInput = q('#file') as HTMLInputElement;
    var plusmenuEl = q('#plusmenu'); var pmUpload = q('#pm-upload'); var pmAt = q('#pm-at');
    var bannerEl = q('#banner'); var changesBarEl = q('#changesbar'); var queuebarEl = q('#queuebar');
    // 变更页（2026-11-05）：页级覆盖层，随视图克隆——各页签各看各的本轮改动。
    // 整块（元素查询 / 清单与 diff 渲染 / 拖拽）已搬到 features/changesPage.ts；这里只把闭包里的
    // 上行通道、i18n、建 DOM 工具传进去，数据（chgData/chgSel）住本视图的 state。
    var changesPage = initChangesPage({ state: S, q: q, post: vpost, lang: L, el: el });
    var compactbarEl = q('#compactbar'); // 压缩浮动条（仿改动条：完成后提示 + 点击定位折叠块）
    var outlineEl = q('#outline'); // 消息大纲轨道（每页签一棵，随视图克隆；逻辑见 olSpy 区）
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
    resetNotice: function () { lastNotice = ''; }
  });
  // 别名：bindComposerOnce / bindViewEvents / histNav 的正文照旧按这些名字调（零字差异）
  var send = composer.send; var inputKeydown = composer.inputKeydown; var inputPaste = composer.inputPaste;
  var normalizeInputWidth = composer.normalizeInputWidth; var updateSuggest = composer.updateSuggest;
  var autoSize = composer.autoSize; var handleFiles = composer.handleFiles;
  var toolEls = {}; var queuedItems = [];
  // 工单28：最后一问 sticky 悬浮——只标最后一条 user bubble 的引用（新 user 到 → 旧摘除、新挂上；
  // renderAll 历史重绘走同一个 addUser，循环末尾自然只剩最后一条带 class）
  var stickyQ: HTMLElement | null = null;
  // 钉住态检测（工单28 追加二，用户直令 2026-09-20）：原位不折叠、钉住才折——用
  // IntersectionObserver 观察 bubble 前的 0 高 sentinel：sentinel 滚出视口顶 = bubble 到顶（钉住）。
  // 每视图一个 IO 实例；内容高超 3 行才折（line-clamp 自带 …），右下角「展开/收起」chip
  // 走 attr(data-st)。零滚动监听器，IO 是浏览器原生高效回调。
  //
  // 追加三（闪烁修正，用户实测 2026-09-21：下滑或流式输出时气泡高频「折叠↔展开」，整页闪烁）：
  // 根因是钉住态自激振荡——line-clamp 把 bubble 的流内高度从 _fullH 砍到 3 行，内容总高随之
  // 缩短；若缩短后最大滚动量掉到 sentinel 偏移以下，浏览器把 scrollTop 往上一钳，sentinel 又
  // 露头 → IO 摘钉 → 展开（总高回涨）→ scroll() 又拉到底 → 再钉……每轮重排整页 = 闪烁。
  // 判据（stickyWants）：只有「bubble 下方内容 ≥ 一个视口高」才允许钉住折叠——此时折叠省下的
  // 高度（最多一个 bubble 高）不足以把 sentinel 从视口上方拽回来，钉住态自洽、不再翻转。
  // 内容还短的回合干脆不钉（短答时原样滚动，比钉一个溢出屏幕的大气泡更合适）。
  var stickyIO: any = null;
  function updateStickyChip(b: any) {
    if (!b._fullH) return; // 未量到内容高（rAF 前）
    var pinned = b.classList.contains('pinned');
    var open = b.classList.contains('sticky-open');
    if (pinned && b._fullH > 78) b.setAttribute('data-st', open ? L.stickyCollapse : L.stickyExpand); // 3 行 ≈ 13px×1.55×3+padding14 ≈ 74.5，取 78
    else b.removeAttribute('data-st');
  }
  function stickyWants(b: any, sent: any) {
    var rootRect = root.getBoundingClientRect();
    var sentRect = sent.getBoundingClientRect();
    if (sentRect.top >= rootRect.top) return false; // sentinel 仍在视口内 → 不钉
    var flowTop = sentRect.top - rootRect.top + root.scrollTop; // sentinel 在滚动内容坐标系里的偏移
    // 量当前实际流内高，不用 _fullH（2026-10-27 追加四同批修正）：钉住折叠后 scrollHeight 里
    // 只剩折后 3 行高，若再拿全高 _fullH 去减会把 below 少算 (_fullH-折后高) 一大截，判据失准。
    // offsetHeight 在原位态=全高、钉住态=折后高，两种状态都对；_fullH 只留给 chip 的超行阈值
    var below = root.scrollHeight - (flowTop + b.offsetHeight);
    return below >= root.clientHeight; // 折叠后 sentinel 仍在视口上方（见追加三注释）
  }
  // 钉住 = sticky-q（position:sticky）+ pinned（line-clamp + chip）同进同退，避免出现
  // 「钉住但不折」把大气泡糊在视口顶的状态；短内容直接不钉，保持正常滚动
  function applySticky(b: any) {
    // 守卫基线取本次调用开始时的布局——必须在类切换**之前**取：钉住瞬间的自身折叠也算
    // 收缩量，否则「钉住→折叠→钳位回顶」一次就把守卫骗开，追加三的振荡原样回归
    var st0 = root.scrollTop; var sh0 = root.scrollHeight;
    var want = stickyWants(b, b._sent);
    // 追加四（闪烁修正二，用户实测 2026-10-27：单条超长消息占满视口，气泡高频「折叠↔展开」
    // 整体闪）：钉住态的第二条自激回路——钉住折叠后**下方内容收缩**（工具完成即收盒 ~320px、
    // prow 占位清理、同名成组隐藏），scrollHeight 被压到 scrollTop+clientHeight 以下，浏览器
    // 把 scrollTop 向上一钳 → sentinel 被动「越界回顶」→ IO 判越界 → 摘钉展开（全高回涨）→
    // scroll() 拉底 → below 过阈再钉 → 折叠……工具每完成一个循环一轮 = 气泡不停缩放闪烁。
    // 追加三的 below≥视口判据只护住「钉住瞬间折叠」方向，管不着这条「钉后下方收缩」方向。
    //
    // 追加五（振荡修正三，用户实测 2026-10-30：往下滚时钉住气泡仍高频「展开↔折叠」）：
    // 追加四的「距底 ≤48」判据时序敏感——钳位的 scroll 事件与流式增长跨帧交错，IO 回调读到
    // 的是「钳位后又长了一截、跟随还没拉底」的瞬间距底值（>48）→ 守卫失效 → 摘钉展开 →
    // 再钉 → 再钳，每条流式消息/每个工具收盒循环一轮。改判「scrollTop 回落能否被 scrollHeight
    // 收缩解释」：钳位回落量 ≤ 收缩量（+48 容差）→ 假事件忽略；真用户回翻必然超出收缩量，
    // 照常摘钉回原位看全文。恒等式：回落−收缩 ≈ 用户主动上翻量（钳位≈收缩、跟随拉底≈增长
    // 两两相消），只看布局因果，不受回调/滚动事件帧间时序影响。距离判据被收缩判据覆盖废止
    //（钳位必伴随收缩，反之不成立——无收缩的回落只可能是用户滚的）。
    if (!want && b.classList.contains('pinned')) {
      var dScroll = b._pinSt - st0; // 正值 = 视口上移（钳位或用户上翻）
      var dShrink = b._pinSh - sh0; // 正值 = 内容变矮（收盒/占位清理/成组隐藏/自身折叠）
      if (dScroll > 0 && dScroll <= dShrink + 48) return; // 回落可被收缩解释 → 钳位假事件，忽略
    }
    b._pinSt = st0; b._pinSh = sh0; // 基线前移（被忽略的路径不前移，继续与钉住时刻比）
    b.classList.toggle('sticky-q', want);
    b.classList.toggle('pinned', want);
    updateStickyChip(b);
  }
  function observeSticky(sent: any, b: any) {
    if (!stickyIO) stickyIO = new IntersectionObserver(function (es: any) {
      for (var i = 0; i < es.length; i++) {
        var tgt = (es[i].target as any)._stickyBubble;
        if (!tgt) continue;
        applySticky(tgt);
      }
    }, { root: root, threshold: 0 });
    sent._stickyBubble = b; b._sent = sent;
    stickyIO.observe(sent);
  }
  // 同名连续合并（0.1.29 方案，用户拍板回归）：记最近完成的工具 {name, ref, count}，同名且
  // DOM 相邻（row→box→row→box 首尾相接）就并进上一行挂 ×N；中间隔思考/正文（bubble 插队）
  // 即不是「连续」各自成行；重绘后旧引用 nextElementSibling 为 null 兑底不误合。
  // 跨消息断组根因已由空壳 bubble 移除 + newLive 不干预解决（探针：pi 每 toolCall 一条独立消息）
  // 同名连续成组（0.1.37 重工，2026-09-22 用户实测截图）：并行工具批次 pi 全部先发 start
  // 再按**完成序**发 end（agent-loop executeToolCallsParallel 实锤）——end 序 ≠ DOM 行序，
  // 旧实现「end 到达序 + DOM 相邻判定」在乱序完成时全散（截图：4 连 read 全单、9 连 read
  // 只头两个并上，end 序恰好前两个同序）。修法：成组判定移到 toolStart（此刻行序=事件序，
  // 相邻判定天然成立）；toolEnd 按行反查组，把内容并进组头盒后**隐藏**自身行/盒——不 remove，
  // 尾链（tailRow/tailBox 的 nextElementSibling）永不断，后续 start 的相邻判定永远成立；
  // 组头 = 首条 start 的行（与 settled renderAll 重放的组头一致，两种路径观感同构）
  var lastToolGroup: { name: string; anchor: any; count: number; hasErr: boolean; tailRow: HTMLElement; tailBox: HTMLElement } | null = null;
  // ── live 流式（在途消息的增量渲染）：整块在 features/liveStream.ts ──
  // 本视图一套（在途气泡 / parts 表 / 流式定时器都在模块内独占，这里不再持有同名变量）。
  // 只注入消息区根、建 DOM 工具、markdown 基座、i18n 与滚动跟随——scroll 留本文件（R7：
  // 它要调 applySticky(stickyQ)，两份滚动/钉住状态必然对不上）。别名供其余调用点
  // （handleMsg / renderAll / setBusy / flushRender / dispose）按原符号名调，正文零改。
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
  var busyTimer: any = null; var busyStart = 0; var queueN = 0; // 「主回合在跑」住 S.busy（原局部 streaming）
  var compacting = false;
  var lastElapsed: number | null = null;
  var roundFrozen = ''; // 本轮总用时冻结文本（全收尾才写；新轮清零——一轮一只累计秒表）
  var modeText = 'Auto';
  var banner: BannerPayload | null = null; var changes: ChangesFileInfo[] | null = null;
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
    if (stickyQ && (stickyQ as any)._sent && !stickyQ.classList.contains('pinned')) applySticky(stickyQ);
    suppressScroll = true;
    root.scrollTop = root.scrollHeight;
  }
  // ── 消息大纲轨道（用户直令 2026-09-21，对齐 DeepSeek/Codex web）：右缘一列短横线 =
  // 每条用户消息一个锚点；hover 错峰展开文字列表、点击平滑跳转+闪烁、滚动时当前条平滑跟随。
  // 纯视图内 DOM 零协议新增；锚点即 .bubble.user（addUser 单点打标，历史重绘同路径）。
  // 当前条判定口径：视口上 1/3 线以上最近一条（与阅读位置一致，拉到底时最后一条必中）
  var olAnchors: { b: HTMLElement; row: HTMLElement }[] = [];
  var olSpyQueued = false; // rAF 合顿滚动事件，一帧一次布局读
  var olSuspend = false; // renderAll 逐条 addUser 时挂起（每条全量重建 = O(N²)，重绘完一次建好）
  function outlineRebuild() {
    if (olSuspend) return;
    olAnchors = [];
    outlineEl.innerHTML = '';
    var items = olScan();
    for (var i = 0; i < items.length; i++) {
      var it = items[i] as any;
      var b = it.b as HTMLElement;
      var row = el('div', 'ol-row' + (it.queued ? ' ol-queued' : ''));
      var txt = it.queued ? ('⏳ ' + (it._t || '')) : olText(b);
      row.appendChild(el('span', 'ol-label', txt));
      row.appendChild(el('span', 'ol-dash'));
      (function (bb: HTMLElement, rr: HTMLElement) {
        rr.addEventListener('click', function () {
          bb.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // 回流强制重启动画：连点同一条也能重新闪（排队 pill 在消息流外，无闪烁也不报错）
          bb.classList.remove('ol-jump'); void bb.offsetWidth; bb.classList.add('ol-jump');
          // 闪完必须摘类：class 留在气泡上时，切页签的 display:none↔可见会让 olflash 从头重放
          // （display:none 取消动画，恢复渲染时 animation 重新求值），表现为切回页签旧选中消息又闪。
          // 不用 animationend——动画被 display:none 取消时它不触发，类就永远留着继续犯病；
          // 定时器兜底且清旧的，防止连点时旧定时器把新一次闪烁提前摘掉。
          var jt: any = (bb as any)._olJumpT; if (jt) clearTimeout(jt);
          (bb as any)._olJumpT = setTimeout(function () { bb.classList.remove('ol-jump'); }, 1100);
        });
      })(b, row);
      outlineEl.appendChild(row);
      olAnchors.push({ b: b, row: row });
    }
    outlineEl.style.display = olAnchors.length ? 'flex' : 'none';
    outlineResize(); // 重建时同步量一次摆位——RO 初次回调只发一次，若当时视图还没布局（0×0）
    // 就永远停在 height:0（实测事故：恢复会话后轨道不可见），这里自愈兑底
    olSpy(); // 重建即校准当前条（重绘/新增后位置全变）
  }
  function outlineResize() {
    if (id !== getActiveTabId()) return; // 后台视图无布局，切回时 RO 会再调
    // 盒子以消息区中线为轴垂直居中（CSS translateY(-50%) 配合），高度自动、最高消息区的 1/3（超出内部滚动）
    outlineEl.style.top = Math.round(root.offsetTop + root.clientHeight / 2) + 'px';
    outlineEl.style.maxHeight = Math.floor(root.clientHeight / 3) + 'px';
  }
  function olText(b: HTMLElement) {
    var t = (b as any)._olText || b.textContent || '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  // 排队中的用户消息（queuebar pill）也进轨道：发出即有锚点（此前只数已入列的 .bubble.user，
  // 刚发出的几秒里轨道少一根像坏了，实测反馈）；交付后 renderAll 重绘，锚点自动换成正式气泡
  function olScan() {
    var out: { b: HTMLElement; row: HTMLElement; queued: boolean }[] = [];
    var pills = queuebarEl.querySelectorAll('.q-item[data-qid]');
    for (var p = 0; p < pills.length; p++) {
      var qt = pills[p].querySelector('.q-text');
      out.push({ b: pills[p] as HTMLElement, row: null as any, queued: true, _t: qt ? qt.textContent || '' : '' } as any);
    }
    var bs = root.querySelectorAll('.bubble.user');
    for (var i = 0; i < bs.length; i++) out.push({ b: bs[i] as HTMLElement, row: null as any, queued: false } as any);
    return out;
  }
  function olSpy() {
    if (id !== getActiveTabId()) return; // 后台视图无布局，切回时 RO 会再调
    if (olSpyQueued) return;
    olSpyQueued = true;
    requestAnimationFrame(function () {
      olSpyQueued = false;
      if (!olAnchors.length) return; // 空会话无锚点，不算当前条
      var line = root.scrollTop + root.offsetTop + root.clientHeight / 2; // 视口中线（点击跳转 block:center 后点中条必在中线上）
      var cur = -1;
      for (var i = 0; i < olAnchors.length; i++) {
        if ((olAnchors[i].b as any).offsetTop <= line) cur = i; else break;
      }
      for (var j = 0; j < olAnchors.length; j++) {
        olAnchors[j].row.classList.toggle('cur', j === cur);
        // 错峰步长=离选中条的距离：展开/淡入从 cur 向两侧辐射（用户直令 2026-09-21，不再从上往下流）。
        // 注意只错峰不位移：曾试过 rAF 钉住 cur（补偿 transform），cur 在列尾时整个轨道块被带离
        // 垂直居中上飞（用户实测駁回 2026-09-21）——轨道块居中优先，别再加位移补偿
        olAnchors[j].row.style.setProperty('--d', String(Math.abs(j - cur)));
      }
    });
  }
  root.addEventListener('scroll', olSpy, { passive: true });
  // 轨道贴 .msg-root 可视区摆位：横幅/输入区高度变化、窗体缩放、切页签都触发 RO 重摆
  var olRO = new ResizeObserver(function () {
    outlineResize();
    olSpy();
  });
  olRO.observe(root);
  function setStatus(t) { if (t) { statusEl.classList.remove('busy'); statusEl.textContent = t; } else if (!S.busy) { statusEl.textContent = ''; } }
  // N 刀（2026-09-23 用户点名「没感觉秒开，往这里加个计时器」）：启动秒表——
  // 「正在启动 pi… Ns」实时走秒。旁路 setStatus 直写（同 ⏱/busy 帧先例）；
  // 自守卫：状态行被任何人接管（busy 类/别的文案）即自杀停摆，杜绝「白 Working」
  // 同款串写残留（2026-09-20 事故教训）。宿主侧 boot phase=… 分段计时与本表互为印证。
  var bootTickTimer: any = 0;
  var bootTickStart = 0;
  /** B 刀：本页签是否处在「启动占位帧」阶段（uiState.booting）——真值帧到达才置回 false。
   *  占位存在期间，任何空闲态渲染（setBusy(false)/切回页签 refreshBusy）都不许碰状态行，
   *  否则会三次擦掉「pi 后台启动中…」提示（见 applyState / renderBusyUi 两处守卫）。 */
  var bootPending = false;
  function startBootTick(base) {
    stopBootTick();
    bootTickStart = Date.now();
    statusEl.textContent = base;
    bootTickTimer = setInterval(function () {
      var cur = statusEl.textContent || '';
      if (statusEl.classList.contains('busy') || cur.indexOf(base) !== 0) { stopBootTick(); return; }
      statusEl.textContent = base + ' ' + fmtDur(Date.now() - bootTickStart);
    }, 1000);
  }
  function stopBootTick() { if (bootTickTimer) { clearInterval(bootTickTimer); bootTickTimer = 0; } }
  function renderStatus() { modeBadge.textContent = modeText; }

  /** 面板顶部横幅（工单六）：文案宿主已组装好，这里只负责渲染；
   *  关闭/一键压缩都上报宿主，横幅状态机在 piCore（webview 重建不丢状态） */
  function renderBanner(b: BannerPayload | null) {
    // 工单24 二期：横幅随页签视图走，后台直接渲进隐藏视图（切回即现，无需账本重渲）
    if (!b) { bannerEl.style.display = 'none'; bannerEl.innerHTML = ''; return; }
    bannerEl.innerHTML = '';
    var txt = document.createElement('span'); txt.className = 'b-txt'; txt.textContent = b.text;
    bannerEl.appendChild(txt);
    if (b.actionLabel) {
      var act = document.createElement('button'); act.className = 'b-act'; act.textContent = b.actionLabel;
      act.onclick = function () { vscode.postMessage({ type: 'compactSession' }); };
      bannerEl.appendChild(act);
    }
    var x = document.createElement('span'); x.className = 'b-close'; x.textContent = '✕'; x.title = L.bannerDismiss;
    x.onclick = function () { vscode.postMessage({ type: 'bannerClose' }); };
    bannerEl.appendChild(x);
    bannerEl.style.display = 'flex';
  }

  /** 工单七：本轮变更文件条。宿主已算好清单，这里只渲染；
   *  查看/关闭都上报宿主（showChanges 出 QuickPick，dismiss 宿主收口不重发） */
  function renderChanges(files: ChangesFileInfo[]) {
    if (!files || !files.length) { changesBarEl.style.display = 'none'; changesBarEl.innerHTML = ''; return; }
    changesBarEl.innerHTML = '';
    var txt = document.createElement('span'); txt.className = 'b-txt';
    txt.textContent = L.changesCount.replace('{n}', String(files.length));
    changesBarEl.appendChild(txt);
    // 主入口 = 变更页（2026-11-05 用户拍板：截图那种左清单+右并排 diff）
    var act = document.createElement('button'); act.className = 'b-act'; act.textContent = L.changesView;
    act.onclick = function () { changesPage.open(); };
    changesBarEl.appendChild(act);
    // 次入口 = 原 QuickPick 清单（带「还原」与「在 VS Code 对比」——变更页未接管的能力住这里）
    var list = document.createElement('button'); list.className = 'b-act b-act2'; list.textContent = L.chgList;
    list.onclick = function () { vpost({ type: 'showChanges' }); };
    changesBarEl.appendChild(list);
    var x = document.createElement('span'); x.className = 'b-close'; x.textContent = '✕'; x.title = L.bannerDismiss;
    x.onclick = function () { vscode.postMessage({ type: 'changesDismiss' }); };
    changesBarEl.appendChild(x);
    changesBarEl.style.display = 'flex';
  }
  // 毫秒 → 紧凑时长（42s / 1m23s / 1h2m）；供 Working 实时计数与本轮耗时显示共用
  function fmtDur(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return m + 'm' + (s ? s + 's' : '');
    var h = Math.floor(m / 60); m = m % 60;
    return h + 'h' + (m ? m + 'm' : '');
  }
  /** 状态栏 DOM 重渲：直接渲本页签真相（三期后无镜像；ticker 闭包只写自己捕获的元素，
   *  白 Working 事故注释随 renderBusyUi 函数体保留） */
  function renderBusyUi() {
    stopBtn.style.display = S.busy ? 'inline-flex' : 'none';
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    // 一轮一只累计秒表（2026-10-23 用户拍板「主会话还有子 agent 在跑就还是 Working…」+
    // 「直到人机一轮跑完，子 agent 时间也算累计」）：主回合 settled 但后台子 agent 仍在跑
    // = 主会话还在干活，同一只表从 busyStart 起继续累；全收尾才落白字总用时。
    // 事故教训：原先 settled 就换 ⏱、chip 再走自己一只表——「⏱ 8s ⚙ builder 7m30s」两只钟
    // 数值打架，用户三连问「这是啥/上一轮的？/你看了会不会懵逼」
    var subLiveNow = function () { var r = subDock.runsOf(id); return !!r && subDock.anyLive(r); };
    if (S.busy || subLiveNow()) {
      if (!busyStart) busyStart = Date.now(); // 重放/恢复的孤儿子 agent：从发现起算，不报 1970
      roundFrozen = ''; // 本轮进行中，冻结值作废
      statusEl.classList.remove('done');
      statusEl.classList.add('busy');
      var frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      var fi = 0;
      var myStart = busyStart; // 捕获局部：原换镜时代防漂移读；今闭包常量，保留语义
      statusEl.textContent = (compacting ? '⏳ ' + L.compacting : frames[0] + ' Working… 0s');
      var myTimer: any = setInterval(function () {
        fi = (fi + 1) % frames.length;
        // 白 Working 事故（2026-09-20 用户实测）：本 ticker 只写文本不动 class——镜像漂移时
        // 会把 Working 写进**别的页签**的状态行（无 .busy 类=白字，且那个页签不 busy
        // 便永远没人清它 → 会话结束后白 Working 永久残留走秒）。三期后镜像不存在，
        // ticker 直接读自己视图的 S.busy/statusEl——串写在结构上不可能；
        // 自愈保留：主回合已结束而 timer 未被正常清时自杀停摆。
        // clearInterval 只清自己的 myTimer（不碰 busyTimer，它可能是后一轮的）
        // 自愈条件同主判据：主回合和子 agent 全收尾才算停；停摆即渲冻结值
        // （subagentUpdate 入口的 refreshBusy 也会接力，两条路都收敛到同一冻结值）
        if (!S.busy && !subLiveNow()) {
          clearInterval(myTimer);
          if (busyTimer === myTimer) busyTimer = null;
          renderBusyUi();
          return;
        }
        // 实时计数从乐观置位起算（比真实 agent 时间多 1~2s）；结束后以宿主实测耗时为准
        statusEl.textContent = (compacting ? '⏳ ' + L.compacting : frames[fi] + ' Working… ' + fmtDur(Date.now() - myStart) + (queueN > 0 ? L.queuedCount.replace('{n}', queueN) : ''));
      }, 120);
      busyTimer = myTimer;
    } else {
      statusEl.classList.remove('busy');
      // B 刀：占位期不清状态行（否则 setBusy(false) 会把「pi 后台启动中… Ns」刷掉，
      // 与 applyState 的守卫成对——漏一道就还是 6 秒零反馈）
      if (!bootPending) statusEl.textContent = '';
      if (compacting) {
        // 压缩中（如压缩期间发消息被 preflight 拒收 → busy:false）：保住压缩标签不清空
        statusEl.classList.add('busy');
        statusEl.textContent = '⏳ ' + L.compacting;
      } else {
        // 全收尾：本轮总用时白字冻结（「完成的话就显示 83s 白色字体就行」）——与走秒同基准
        // （busyStart 起算，含子 agent 全程），数字不跳变；下一轮 setBusy(true) 清零重来。
        // busyStart 缺失（纯历史恢复）回退宿主实测耗时，不空窗；切走再切回由 roundFrozen 恢复现场
        if (!roundFrozen && busyStart) roundFrozen = fmtDur(Date.now() - busyStart);
        if (!roundFrozen && lastElapsed != null) roundFrozen = fmtDur(lastElapsed);
        if (roundFrozen) {
          statusEl.classList.add('done');
          statusEl.textContent = roundFrozen;
          statusEl.title = L.turnDuration;
        }
      }
    }
  }
  function setBusy(v, elapsedMs) {
    S.busy = v;
    if (v) {
      // 计时起点对齐宿主真相：对账/纠回时 elapsedMs 是真实已过时长，回拨起点。
      // 否则每次 busy:true 都会把 Working 计时清小（实测 3s/1m4s 与实际不符的根源）
      busyStart = elapsedMs != null ? Date.now() - elapsedMs : Date.now();
      lastElapsed = null;
      roundFrozen = ''; // 新一轮开始，上一轮的冻结用时清零（「开始之后还带着 12m04s」事故）
    } else if (elapsedMs != null) {
      // 本轮实测耗时入记录（切走再切回来能恢复 ⏱ 现场）
      lastElapsed = elapsedMs;
    }
    if (!v) { finalizeLive(); liveReset(); }
    renderBusyUi(); // 状态行随页签视图走，后台渲进隐藏视图（busyTimer 随换镜走）
  }
  /** 压缩窗口开合（宿主 CompactingMsg）：true 直接接管状态栏——手动压缩是空闲会话里的
   *  RPC 调用，全程无 agent 事件，没有这条压缩期间零反馈。false 时不主动清：streaming 时
   *  busyTimer 会按新 flag 重写 Working，空闲时由后续 status/settled 流程收尾 */
  function setCompacting(v) {
    compacting = v;
    if (v) {
      statusEl.classList.add('busy'); // 复用高亮+脉动，同「忙」视觉
      statusEl.textContent = '⏳ ' + L.compacting;
    }
  }

  /** 历史消息 content 数组里的原图项（工单31）：pi 落盘 ImageContent {type:"image",data,mimeType}，
   *  textOf 只拼 text，原图靠本函数另抽——重绘路径与当场回显两路同用 */
  function imgsOf(content) {
    var out = [];
    if (Array.isArray(content)) {
      for (var i = 0; i < content.length; i++) {
        var c = content[i];
        if (c && c.type === 'image' && c.data) out.push({ data: c.data, mimeType: c.mimeType || 'image/png' });
      }
    }
    return out;
  }
  function addUser(text: string, imageCount?: number, codeInfo?: string, fileCount?: number, images?: any[]) {
    // 子 agent 异步回报特殊标记渲染（2026-09-18 用户拍板升级：不隐藏，改独立卡片——
    // 防止被当成用户自己说的话；前版“直接不展示”作废）。前缀契约在 subagent 扩展的
    // sendUserMessage 处（"[子 agent sa-N 完成|失败|已终止] agent名: 输出"），改格式三处同步
    // （harness 发送方 / piCore message_start 正则 / 本文件 addUser + queue 两处）。
    // 2026-11-13 补「已终止」：用户 kill 的单也会回传，否则主 agent 以为它还在跑。
    var sm2 = (text || '').match(/^\[子 agent (\S+) (完成|失败|已终止)\] ([^:\n]*): ?/);
    if (sm2) {
      var card = el('div', 'subret' + (sm2[2] === '完成' ? '' : ' fail'));
      var sh = el('div', 'subret-head', '⮑ 子 agent ' + sm2[2] + (sm2[3] ? ' · ' + sm2[3] : ''));
      sh.appendChild(el('span', 'subret-h', ' · ' + sm2[1])); // 句柄弱化：可读可抄，不抢眼
      card.appendChild(sh);
      var sb = el('div', 'subret-body');
      renderRich(sb, text.slice(sm2[0].length) || text); // 正文 markdown 渲染（回报常带表格）
      card.appendChild(sb);
      root.appendChild(card); followingEnd = true; scroll();
      return;
    }
    var w = root.querySelector('#welcome'); if (w) w.remove(); var b = el('div', 'bubble user');
    (b as any)._olText = text || ''; // 大纲轨道条目文案（空文本=代码上下文泡，olText 里有兑底）
    // 工单28 追加（用户直令 2026-09-20）：迁移时旧 bubble 连 sticky-open/pinned 状态一起摘、
    // 旧 sentinel 一并 unobserve；新 bubble 从未折叠原位态起步（钉住后才折，超 3 行才出 chip）
    if (stickyQ) {
      stickyQ.classList.remove('sticky-q'); stickyQ.classList.remove('sticky-open'); stickyQ.classList.remove('pinned');
      if (stickyIO && (stickyQ as any)._sent) stickyIO.unobserve((stickyQ as any)._sent);
    }
    stickyQ = b; // sticky-q 由 applySticky 在「可钉」时加（追加三：短内容不钉，避免振荡）
    b.addEventListener('click', function () { b.classList.toggle('sticky-open'); updateStickyChip(b as any); }); if (text) { b.textContent = text; } else { b.innerHTML = ico('filecode', 12) + ' ' + L.codeCtxBubble; }
    // 工单31：原图缩略图（data URI，CSP img-src data: 已放行）——限高等比在 CSS；点击 → openImage
    // 交宿主写临时文件走 VS Code 内置预览器开原图（自带缩放），不造 lightbox；stopPropagation
    // 防 sticky 气泡 toggle（点击缩略图不能触发展开/折叠）
    if (images && images.length) {
      var th = el('div', 'thumbs');
      for (var ti = 0; ti < images.length; ti++) {
        (function (img0) {
          var im = document.createElement('img');
          im.className = 'thumb';
          im.src = 'data:' + (img0.mimeType || 'image/png') + ';base64,' + img0.data;
          im.addEventListener('click', function (ev) { ev.stopPropagation(); vpost({ type: 'openImage', data: img0.data, mimeType: img0.mimeType || 'image/png' }); });
          // 工单31：img 异步加载，加载完成前量出的 _fullH 不含图高 → 钉住折叠判定失准；
          // 加载完成后重测（工单28 口径「原位量一次完整内容高」以 img.onload 为准修正）
          im.onload = function () { requestAnimationFrame(function () { (b as any)._fullH = (b as any).scrollHeight; updateStickyChip(b as any); }); };
          th.appendChild(im);
        })(images[ti]);
      }
      b.appendChild(th);
    }
    if (codeInfo) { var n1 = el('div', 'notice'); n1.innerHTML = ico('filecode', 12) + ' ' + L.attachedCode + esc(codeInfo); b.appendChild(n1); } if (fileCount) { var n3 = el('div', 'notice'); n3.innerHTML = ico('filecode', 12) + ' ' + fileCount + L.filesUnit; b.appendChild(n3); } if (imageCount && !(images && images.length)) { var n2 = el('div', 'notice'); n2.innerHTML = ico('image', 12) + ' ' + imageCount + L.imagesUnit; b.appendChild(n2); } var sent = el('div', 'sticky-sent'); root.appendChild(sent); root.appendChild(b); followingEnd = true; scroll();
    // 原位态量一次完整内容高（未 clamp，后续钉住判定用它，不再反复读布局）；
    // sentinel 在 bubble 前，IO 观察它判定钉住（工单28 追加二）
    observeSticky(sent, b);
    requestAnimationFrame(function () { (b as any)._fullH = b.scrollHeight; updateStickyChip(b as any); });
    outlineRebuild(); // 新用户消息 → 大纲轨道补一行（历史重绘走 renderAll 出口，不在此重复）
  }  // 主动发消息=回底意图（工单十七要点 3）
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
  function toolStart(id: string, name: string, detail?: string, collapsed?: boolean) {
    var t = el('div', 'tool run');
    t.appendChild(el('span', 't-dot'));
    t.appendChild(el('span', 't-name', name));
    if (detail) { var d = el('span', 't-detail', detail); d.title = detail; t.appendChild(d); linkify(d); }
    var arr = el('span', 't-arrow'); arr.innerHTML = ico('chev', 12); t.appendChild(arr);
    var box = el('div', 'tool-box');
    if (detail) {
      var inRow = el('div', 'tb-row');
      inRow.appendChild(el('span', 'tb-tag', 'IN'));
      inRow.appendChild(el('span', 'tb-val', detail));
      box.appendChild(inRow);
    }
    linkify(box);
    box.style.display = collapsed ? 'none' : 'block';
    if (!collapsed) t.classList.add('open');
    t.addEventListener('click', function () {
      var ref = toolEls[id];
      if (!ref || !box.textContent) return;
      var open = ref.box.style.display === 'none';
      // 工单29扩权：展开时若有全量 OUT（>1000 字被截的），换全量进滚动容器（一次性换，之后只收/展）
      if (open && ref.full != null && ref.outVal) { ref.outVal.textContent = ref.full; ref.outVal.classList.add('tb-full'); ref.full = null; }
      ref.box.style.display = open ? 'block' : 'none';
      if (open) t.classList.add('open'); else t.classList.remove('open');
    });
    toolEls[id] = { row: t, box: box, full: null, outVal: null, grp: null as any };
    root.appendChild(t);
    root.appendChild(box);
    // 成组判定在 start（此刻行序=事件序）：能接上当前组尾就挂进组；同名但中间隔了思考/正文
    // （nextElementSibling 断）则开新组。组员的角色在 toolEnd 才分流：组头自己收尾 or 并入组头
    var lt = lastToolGroup;
    if (lt && lt.name === name && lt.tailRow.nextElementSibling === lt.tailBox && lt.tailBox.nextElementSibling === t) {
      toolEls[id].grp = lt;
      lt.tailRow = t; lt.tailBox = box;
    } else {
      // 组头的 grp 也指到自己：组头收尾时要靠它查 count/hasErr 补挂徽标
      toolEls[id].grp = { name: name, anchor: toolEls[id], count: 1, hasErr: false, tailRow: t, tailBox: box };
      lastToolGroup = toolEls[id].grp;
    }
    scroll();
  }
  function toolEnd(id, name, isError, text, detail) {
    var ref = toolEls[id];
    if (!ref) {
      // start 缺失兑底（历史数据不完整等）：建行后按 toolStart 同判挂组/开新组，
      // 否则该行游离在组外，后续同名行也没法接上
      var b2 = el('div', 'tool-box'); b2.style.display = 'none';
      ref = { row: el('div', 'tool'), box: b2, full: null, outVal: null, grp: null as any };
      toolEls[id] = ref;
      root.appendChild(ref.row);
      root.appendChild(ref.box);
      var lt0 = lastToolGroup;
      if (lt0 && lt0.name === name && lt0.tailRow.nextElementSibling === lt0.tailBox && lt0.tailBox.nextElementSibling === ref.row) {
        ref.grp = lt0;
        lt0.tailRow = ref.row; lt0.tailBox = ref.box;
      } else {
        ref.grp = { name: name, anchor: ref, count: 1, hasErr: false, tailRow: ref.row, tailBox: ref.box };
        lastToolGroup = ref.grp;
      }
    }
    var grp = ref.grp;
    var t = ref.row;
    t.className = 'tool ' + (isError ? 'err' : 'ok');
    t.innerHTML = '';
    t.appendChild(el('span', 't-dot'));
    t.appendChild(el('span', 't-name', name));
    if (detail) { var d2 = el('span', 't-detail', detail); d2.title = detail; t.appendChild(d2); linkify(d2); }
    var arr2 = el('span', 't-arrow'); arr2.innerHTML = ico('chev', 12); t.appendChild(arr2);
    ref.box.innerHTML = '';
    if (detail) {
      var r1 = el('div', 'tb-row');
      r1.appendChild(el('span', 'tb-tag', 'IN'));
      r1.appendChild(el('span', 'tb-val', detail));
      ref.box.appendChild(r1);
    }
    linkify(ref.box);
    var full = text != null ? String(text) : '';
    if (full) {
      var r2 = el('div', 'tb-row');
      r2.appendChild(el('span', 'tb-tag', 'OUT'));
      var ov = el('span', 'tb-val', full.slice(0, 1000)); // 预览只存 1000 字；全量不进 DOM
      r2.appendChild(ov);
      ref.box.appendChild(r2);
      ref.outVal = ov;
      if (full.length > 1000) {
        // 工单29扩权省内存口径：全量只持引用不复制（字符串本就在事件流里），首次点开才写
        // DOM、换完即弃；settled 后 renderAll 整树重绘时引用与全量 DOM 全部释放——内存
        // 是暂态的，上限 = 一个回合的工具数
        ref.full = full;
        t.title = L.toolTruncated + '\n' + full.slice(0, 400);
      } else {
        t.title = full.slice(0, 400);
      }
    }
    // 完成即收一个（用户直令 2026-09-20）：不等 settled 统一收；原 wasOpen「保持展开」逻辑作废
    ref.box.style.display = 'none';
    t.classList.remove('open');
    if (grp && grp.anchor !== ref) {
      // 组员收尾（end 可乱序到）：内容并进组头盒，自身行/盒隐藏**不 remove**——尾链保持，
      // 乱序期间后续 end/start 的相邻判定都成立。合并 = moveChild 节点搬移零复制，
      // 被合并方全量引用先展开进隐藏盒再释放（同工单29口径）
      if (ref.full != null && ref.outVal) { ref.outVal.textContent = ref.full; ref.outVal.classList.add('tb-full'); ref.full = null; }
      while (ref.box.firstChild) grp.anchor.box.appendChild(ref.box.firstChild);
      ref.row.style.display = 'none';
      ref.box.style.display = 'none';
      delete toolEls[id];
      grp.count++;
      if (isError) grp.hasErr = true;
      var cnt = grp.anchor.row.querySelector('.t-count');
      if (cnt) cnt.textContent = ' ×' + grp.count;
      else { var nm = grp.anchor.row.querySelector('.t-name'); if (nm) nm.appendChild(el('span', 't-count', ' ×' + grp.count)); }
      if (isError) grp.anchor.row.className = 'tool err';
    } else {
      // 组头收尾：×N 徽标重挂（若组员先收尾已挂过，innerHTML 重建会把它抹掉）；
      // 任一组员报错过则整组红（hasErr），组头自身的 err/ok 被重建覆盖不能作为唯一依据
      if (grp && grp.count > 1) {
        var nm2 = t.querySelector('.t-name'); if (nm2) nm2.appendChild(el('span', 't-count', ' ×' + grp.count));
      }
      if (grp && grp.hasErr) t.className = 'tool err';
    }
    scroll();
  }
  // toast 跨重渲存续（用户实测「切页签回来压缩提示没了」2026-09-20）：notice 是一次性 DOM，
  // 本页签 core 后续任何 uiState 重渲都会冲掉它。持久事实源是折叠块（jsonl compaction 条目，
  // 恢复时从数据重建，在最顶部）；本层只是让瞬时 toast 也活过重渲——按存档重挂，发新消息即清
  var lastNotice = '';
  var seenCompactions = -1; // 折叠块计数基线：-1=未立基线（首渲不跳顶），增大=新压缩
  var compactBarShownAt = -1; // 已弹过条的压缩计数（防同轮重渲重弹；dismiss 后置 = seenCompactions）
  function notice(text) {
    if (/扩展已加载/.test(text)) return;
    // 同文 toast 不叠挂（插话→点暂停→点取回事故实测）：retrieveTaken 被流式思考块隔开后不再命中
    // 下方「root 末尾同文」判定，幽灵 pill 每点一次取回就叠一条同文提示。lastNotice 在 send/render
    // 清零 = toast 周期边界，跨回合的同文提示照常再出；已知取舍：同周期内同文只显示首条
    //（pill/队列条自身的增删即是后续反馈）
    if (lastNotice === text) return;
    var last = root.lastElementChild; if (last && last.classList && last.classList.contains('notice') && last.textContent === text) return; var n = el('div', 'notice', text); linkify(n); root.appendChild(n); lastNotice = text; scroll();
  }
  function textOf(content) {
    if (typeof content === 'string') return content;
    var out = '';
    if (Array.isArray(content)) {
      for (var i = 0; i < content.length; i++) {
        var c = content[i];
        if (c && c.type === 'text' && c.text) out += c.text;
      }
    }
    return out;
  }
  function makeThink(text) {
    var d = document.createElement('details');
    d.className = 'think';
    var s = document.createElement('summary'); s.textContent = L.thinkingProcess;
    var body = el('div', 'think-body', text);
    d.appendChild(s); d.appendChild(body);
    return d;
  }
  // 工单二十一：压缩边界折叠块（对齐 pi TUI CompactionSummaryMessageComponent）。
  // compactionSummary 是 pi 恢复会话时把压缩点前历史折叠成的 {role, summary, tokensBefore,
  // timestamp} 消息，webview 曾静默穿落——用户视角「以前发的消息没了」。这里复刻 makeThink 的
  // details/summary 原生折叠交互（样式走 .think/.think-body 现有 token），默认收起、点击展开摘要正文；
  // 收起态文案含 tokensBefore（原多少 tokens）声明边界，克服单（工单六）横幅只管「当下」的局限
  function makeCompaction(m) {
    var d = document.createElement('details');
    d.className = 'think compaction'; // 追加可寻址类：压缩完成后的定位高亮用（与 thinking 块区分）
    var s = document.createElement('summary');
    s.textContent = L.compactionSummary.replace('{n}', (m.tokensBefore != null ? Number(m.tokensBefore).toLocaleString() : 0));
    d.appendChild(s);
    var body = el('div', 'think-body', '');
    renderRich(body, String(m.summary || ''));
    d.appendChild(body);
    return d;
  }
  function renderAll(list) {
    olSuspend = true; // 重绘期逐条 addUser 不重建轨道（O(N²)），结尾一次建好
    root.innerHTML = '';
    liveReset();
    toolEls = {};
    lastToolGroup = null; // 重绘后 DOM 全换，旧引用作废（相邻判定本身也兕底，这里显式清）
    if (!list || !list.length) {
      if (welcomeHTML) { root.innerHTML = welcomeHTML; duckInto(root); pickTip(root.querySelector('#welcome')); }
      olSuspend = false;
      outlineRebuild(); // 空会话无锚点，轨道自动隐藏
      return;
    }
    linkifyEnabled = false; // 老消息不 linkify，循环到最近 15 条时再打开
    var results = {};
    var resultList = [];
    for (var k = 0; k < list.length; k++) {
      var rr = list[k];
      if (rr.role === 'toolResult') {
        var entry = { text: textOf(rr.content), isError: !!rr.isError, used: false, details: rr.details };
        results[rr.toolCallId || ''] = entry;
        resultList.push(entry);
      }
    }
    function historyDetail(args: unknown) {
      // 已并入共享实现（DIRECTOR 工单三）：与宿主流式工具行同一摘要逻辑，字段并集 + 首字符串兑底
      return toolDetail(args);
    }
    // 工具组壳（历史重绘与 live 同构，用户直令 2026-09-20）：头行 工具 ×N + 收起态内容区；
    // 点击头行开合，组内每行工具可再点开各自 IN/OUT（复用 toolStart/toolEnd 全套交互）。
    // 同名合并的跨消息配合（探针实锤：pi 每 toolCall 一条独立 assistant 消息）：
    // 历史渲染逐工具 toolStart/toolEnd，同名连续靠 toolStart 时的组判定 + toolEnd 的组员并入
    // （0.1.37 起成组判定在 start，见 toolStart 头注释）；跨消息时前工具的 box 与下一工具的
    // row 天然相邻（中间无 bubble 就不断）
    for (var i = 0; i < list.length; i++) {
      if (i >= list.length - 15) linkifyEnabled = true;
      var m = list[i];
      if (m.role === 'user') {
        var ut = textOf(m.content); var ui = null; var ufiles = 0;
        var ccm = ut.match(/^--- 代码上下文: (.+?) \((.+?)\) ---\n/);
        if (ccm) {
          ui = ccm[1] + ' ' + ccm[2];
          var eIdx = ut.indexOf('\n--- 代码上下文结束 ---\n');
          if (eIdx > 0) { ut = ut.slice(eIdx + '\n--- 代码上下文结束 ---\n'.length); if (ut.charAt(0) === '\n') ut = ut.slice(1); }
          else { var ci2 = ut.lastIndexOf('\n```\n\n'); ut = ci2 > ccm[0].length ? ut.slice(ci2 + 6) : ut.slice(ccm[0].length); } // 老格式兑底
        }
        var am2;
        while ((am2 = ut.match(/^--- 附件: ([^\n]*) ---\n/))) {
          var term2 = '\n--- 附件结束: ' + am2[1] + ' ---\n';
          var ei2 = ut.indexOf(term2);
          if (ei2 < 0) { var fb = ut.match(/^--- 附件: [^\n]* ---\n```\n[\s\S]*?\n```\n\n/); if (!fb) break; ut = ut.slice(fb[0].length); if (ut.charAt(0) === '\n') ut = ut.slice(1); continue; }
          ufiles++;
          ut = ut.slice(ei2 + term2.length);
          if (ut.charAt(0) === '\n') ut = ut.slice(1);
        }
        var uimgs = imgsOf(m.content); // 工单31：content 里的 image 项直画缩略图（原数图死引用已删——pi 落盘 user 消息无 attachments 字段，重开丢数字的根因）
        addUser(ut, uimgs.length, ui, ufiles, uimgs);
      }
      else if (m.role === 'assistant') {
        var b = el('div', 'bubble assistant');
        var flushB = function () { if (b.childNodes.length) { root.appendChild(b); b = el('div', 'bubble assistant'); } };
        if (Array.isArray(m.content)) {
          for (var j = 0; j < m.content.length; j++) {
            var c = m.content[j];
            if (c && c.type === 'thinking' && c.thinking) b.appendChild(makeThink(c.thinking));
            else if (c && c.type === 'text' && c.text) { var td = document.createElement('div'); renderRich(td, c.text); b.appendChild(td); }
            else if (c && c.type === 'toolCall') {
              flushB();
              // 每个工具一行（toolStart/toolEnd 全套交互，收起态）；同名连续靠 toolStart 的
              // 组判定成组、toolEnd 并入组头（跨消息也能接上，中间 bubble 天然断开）。
              // 历史 OUT 截 1000 不持全量引用（老会话内存零增长，全量在 jsonl 里）
              var hid = c.id || ('h' + i + '_' + j);
              var det = historyDetail(c.arguments);
              toolStart(hid, c.name, det, true);
              var res = (c.id && results[c.id]) || null;
              if (!res) { for (var rp = 0; rp < resultList.length; rp++) { if (!resultList[rp].used) { res = resultList[rp]; break; } } }
              if (res) { res.used = true; toolEnd(hid, c.name, res.isError, res.text != null ? String(res.text).slice(0, 1000) : res.text, det); }
              // 子 agent 历史重绘不建浮窗/卡片（用户拍板：消息流只留工具行，浮窗只属 LIVE）——
              // 否则恢复会话时旧 run 的 final 快照会凭空弹出浮窗；历史看工具行 OUT 文本即可
            }
          }
        } else { renderRich(b, textOf(m.content)); }
        flushB();
        if (m.stopReason === 'error' && m.errorMessage) {
          var eb = el('div', 'bubble assistant errmsg');
          eb.textContent = '✘ ' + String(m.errorMessage).slice(0, 300);
          eb.appendChild(document.createElement('br'));
          // 入口分流（2026-10-23 用户拍板，402 实测事故）：余额/配额/鉴权类错误改消息也没用，
          // 挂「修改后重试」只会引导用户白撞一次请求——换指引文案；判定口径在 errorClass.ts
          if (isEditRetryable(String(m.errorMessage))) {
            var rb = el('span', 'errmsg-retry', L.retryEdit);
            rb.addEventListener('click', function () { vpost({ type: 'retryFromLast' }); });
            eb.appendChild(rb);
          } else {
            eb.appendChild(el('span', 'errmsg-hint', L.errNoRetryHint));
          }
          root.appendChild(eb);
        }
      }
      else if (m.role === 'bashExecution') { root.appendChild(el('div', 'tool ok', '! ' + m.command)); }
      else if (m.role === 'compactionSummary') { root.appendChild(makeCompaction(m)); }
    }
    // 工单十八补刀3（用户实测：切页签后 queuebar 每条×2，状态栏计数是对的——pi 没双入队，
    // 是显示层叠加）：uiState 原子分支已重建过 queuebar，本循环（远古的“重绘后恢复排队条”
    // 职责）再追加一遍 = 翻倍。修法：先清再建，幂等——本循环与 uiState 分支谁先谁后都不叠加。
    // 工单24 二期：queuebar 随页签视图走，后台渲进隐藏视图
    queuebarEl.innerHTML = '';
    for (var rq = 0; rq < queuedItems.length; rq++) addQueuedDom(queuedItems[rq]);
    // 重挂存活的 toast（renderAll 开头清了 root；空列表 welcome 早退分支不挂——新会话无历史 toast）
    if (lastNotice) { var ln = el('div', 'notice', lastNotice); linkify(ln); root.appendChild(ln); }
    scroll();
    olSuspend = false;
    outlineRebuild(); // 整树重绘完 → 重建轨道（bubble 全新 DOM，旧锚点全作废）
    // 压缩完成 → 浮动条（2026-09-20 用户拍板：自动跳顶难受，仿「查看改动」条浮动提示）。
    // 折叠块在消息区最顶（压缩点前历史已被替换，它前面没有消息），平时不可见——
    // 条常驻提示本轮有压缩，「查看压缩」定位到块（点击触发的高亮不搢流）。
    // 首渲只立基线（恢复旧会话不弹条）；count 增大才弹（同轮重渲不重复弹）
    var cc = 0;
    if (list) for (var cm = 0; cm < list.length; cm++) if (list[cm].role === 'compactionSummary') cc++;
    if (seenCompactions < 0) { seenCompactions = cc; compactBarShownAt = cc; } // 首渲立基线：恢复旧会话不弹条
    else if (cc > seenCompactions) { seenCompactions = cc; renderCompact(); } // 新压缩 → 弹条
  }
  /** 压缩浮动条：文案 + 查看压缩（定位折叠块）+ 关闭；纯视图内 DOM，零协议新增 */
  function renderCompact() {
    var cbEl = root.querySelector('details.compaction');
    if (!cbEl) return;
    compactBarShownAt = seenCompactions;
    compactbarEl.innerHTML = '';
    var txt = document.createElement('span'); txt.className = 'b-txt'; txt.textContent = L.compactBarText;
    compactbarEl.appendChild(txt);
    var act = document.createElement('button'); act.className = 'b-act'; act.textContent = L.compactBarView;
    act.onclick = function () {
      cbEl.scrollIntoView({ block: 'center' });
      cbEl.classList.add('compaction-flash');
      setTimeout(function () { cbEl.classList.remove('compaction-flash'); }, 2000);
    };
    compactbarEl.appendChild(act);
    var x = document.createElement('span'); x.className = 'b-close'; x.textContent = '✕'; x.title = L.bannerDismiss;
    x.onclick = function () { compactbarEl.style.display = 'none'; compactbarEl.innerHTML = ''; compactBarShownAt = seenCompactions; };
    compactbarEl.appendChild(x);
    compactbarEl.style.display = 'flex';
  }
  function fmtSession(file, name) {
    if (name) return name;
    var s = String(file || '');
    var mm = s.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
    // J 刀：文件名时间戳是 UTC（尾缀 Z），必须转本地——裸读差一个时区（用户实测 20:00 建
    // 的会话显示 12:00）。与宿主 fmtSessionTitle 同款口径（此处只是 tabs 未到时的兑底）
    if (mm) {
      var dd = new Date(mm[1] + '-' + mm[2] + '-' + mm[3] + 'T' + mm[4] + ':' + mm[5] + ':00Z');
      var p2 = function (n) { return (n < 10 ? '0' + n : '' + n); };
      return p2(dd.getMonth() + 1) + '-' + p2(dd.getDate()) + ' ' + p2(dd.getHours()) + ':' + p2(dd.getMinutes());
    }
    var base = s.split(/[\\/]/).pop();
    // 双空 = pi 启动窗口占位，显「启动中」（E 刀拍板 3：占位冒充终值会误导「会话会丢」）。
    // 「临时(未保存)」已随 ephemeral 判死退役（审计红线：一切会话都落盘，2026-09-22）
    return base || L.startingSession;
  }
  function applyState(m) {
    // 工单24 二期：页脚（模型/思考/用量）随页签视图走，后台直接渲进隐藏视图；
    // 页头会话标题是页面级（只显示活动页签），后台跳过
    // ⏱ 本轮耗时刚由 setBusy(false, elapsedMs) 写入，不能被这里的临时状态清理冲掉
    //（settle 时序：busy:false → ⏱ 上屏 → refreshState 的 state 消息紧随其后到达）
    // 压缩中不清：压缩标签是持续状态，applyState 的高频刷新（refreshState）不冲掉它
    // B 刀（2026-11-04 用户报「提示消失后是灰状态、等一会模型才有」）：占位帧（booting）
    // 不是终值——页脚来自模型记忆/快路径缓存，模型名和标题还得等 pi init 完。这种帧不许
    // 收秒表、不许清状态行，否则 boot 空窗（真机日志实测 6.4s，mr-create 单项 5.3s）里
    // 用户只看到全空页脚 + 「⚡ Auto」，零反馈。收表权只给真值帧（booting 缺省/false）。
    // （uiState 分支已在 setBusy 之前置过同一标记，这里是 'state' 消息的入口；赋值幂等）
    bootPending = m.booting === true;
    if (!bootPending) {
      stopBootTick(); // N 刀：首帧真值状态到达 = 启动结束，秒表收表（文本由下方清理）
      if (!compacting && statusEl.textContent.indexOf('⏱') !== 0) setStatus(''); // pi 已就绪，清掉「正在启动 pi…」之类的临时状态
    }
    // 模型名包进 .chip-label，底栏限宽时省略号截断，全名靠 title（下一行）
    modelEl.innerHTML = ico('cpu') + ' <span class="chip-label">' + esc(m.model ? (m.model.name || m.model.id) : '—') + '</span>';
    modelEl.title = m.model ? L.modelTitleCur.replace('{v}', (m.model.provider || '') + '/' + (m.model.id || '')) : L.switchModel;
    thinkEl.textContent = L.thinkLabel + (m.thinkingLevel !== null && m.thinkingLevel !== undefined ? m.thinkingLevel : '—');
    if (id === getActiveTabId()) {
    // J 刀：页头优先用宿主 tabs 标题（唯一事实源：空会话「新会话」/时区本地化都在宿主
    // fmtSessionTitle 收口），fmtSession 只作 tabs 未到时的兑底
    var hostTitle = '';
    for (var hTi = 0; hTi < tabsList.length; hTi++) if (tabsList[hTi].id === getActiveTabId()) { hostTitle = tabsList[hTi].title; break; }
    var sessName = hostTitle || fmtSession(m.sessionFile, m.sessionName);
    sessionEl.textContent = L.sessionLabel + sessName;
    sessionEl.title = m.sessionFile ? (L.curSession + m.sessionFile + '\n' + L.clickSwitchSession) : L.clickPickSession;
    }

    // 页脚用量：圆圈百分比（2026-11-05 用户指定）——圆环画占比，右侧文字只留成本；
    // 圆环颜色随占比升档（<70 蓝 / <90 橙 / ≥90 红），与阈值预警同色语言
    ctxPop.refreshUsage(m.stats);
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

  /** 重绘/续接排队（刀5b）：render 与 liveSync 同拍顺序执行（快照重绘 → 在途消息重定基），
   *  防止 renderAll 的 liveReset 抹掉先到的重定基状态 */
  var renderPending: SessionMessage[] | null = null;
  var liveSyncPending: SessionMessage | null = null;
  var renderTimer: number | null = null;
  function scheduleRender() {
    // 三期④：换镜舞蹈退役（原「先换回发起页签再重绘」——闭包天然绑定，无需换）
    if (!renderTimer) renderTimer = setTimeout(function () {
      renderTimer = null;
      flushRender();
    }, 0);
  }
  function flushRender() {
    renderTimer = null;
    if (renderPending) {
      var list = renderPending; renderPending = null;
      renderAll(list);
    }
    if (liveSyncPending) { var msg2 = liveSyncPending; liveSyncPending = null; applyLiveSync(msg2); }
    drainPendingStream();
  }
  function handleMsg(m: HostToWebviewTagged) {
    // 工单24：重绘在途（延后一拍）时流式事件先排队，等重绘落地再按原序补（见 pendingStream 注释）
    if (renderTimer !== null && deferDuringRender(m.type)) { pendingStream.push(m); return; }
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
      renderPending = m.messages; liveSyncPending = m.live || null; scheduleRender(); // 复用延后一拍：render→liveSync 同拍顺序不变
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
    else if (m.type === 'render') { built = true; lastNotice = ''; /* render=会话上下文整体替换（切历史/新建/fork/导入），旧 toast 属上一段会话，随边界清掉（事故：切历史后旧「已恢复会话」残留叠加——lastNotice 只在 send() 清，renderAll 又把旧 toast 重挂进新会话）。跨重渲存续只为同会话 uiState 重渲服务，此处不清会每次切换叠一条 */ renderPending = m.messages; scheduleRender(); } // 延后一拍：让刚到的用户气泡先上屏，再慢慢重绘全页
    else if (m.type === 'liveSync') { liveSyncPending = m.message; scheduleRender(); } // 刀5b：续接重定基，排在 render 之后同一拍执行（顺序由 flushRender 保证）
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
        ctxPop.dispose();
        if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
        clearStreamTimer();
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        if (view.parentNode) view.parentNode.removeChild(view);
      }
    };
  }

  var views: Record<string, ReturnType<typeof makeSessionView>> = {};
  // 变更页 Esc 关页（焦点不在输入框时的兑底：点了清单/diff 后焦点不在 composer）
  document.addEventListener('keydown', function (e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.isComposing || getActiveTabId() === null) return;
    var v = views[getActiveTabId()];
    // Esc 先关浮层（上下文用量弹层），没有浮层才关整页
    if (v && v.isCtxPopOpen()) { v.closeCtxPop(); return; }
    if (v && v.hasPage()) v.closePage();
  });
  function viewFor(tid: string) { return views[tid] || (views[tid] = makeSessionView(tid)); }
  /** codeCtx 是页面级数据：变更时循环各视图重渲 chip（三期⑥） */
  function renderCodeChipAll() { for (var vid in views) views[vid].renderCodeChip(); }
  /** 消息路由（三期）：后台只挡焦点类，其余各归各的视图——串写结构上不可能 */
  function routeMsg(m: HostToWebviewTagged) {
    var tid = m.tabId !== undefined ? m.tabId : getActiveTabId();
    if (tid === null || tid === undefined) return;
    if (getActiveTabId() === null) { setActiveTabId(tid); tabId = tid; }
    if (tid !== getActiveTabId() && m.type === 'fillInput') return; // 后台页签只挡焦点类（回填+focus）
    viewFor(tid).handleMsg(m);
  }
  // 活动页签 id 已抽到 core/state.ts（getActiveTabId/setActiveTabId）：document 级监听与
  // 路由都跨视图读写它，单一读写口在那边
  var tabsList: TabInfo[] = [];
  var tabbarEl = document.getElementById('tabbar') as HTMLElement;
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
  // 别名：全文件其余调用点（renderRich 在 5a，notice/toolStart/toolEnd/renderAll/subagentDock 都未搬）原样不动
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
  // 就被冲掉（快照基线不含它们）。实证教训：宿主侧靠 sleep 等重绘不可靠（长会话重绘能把
  // 20ms 顶穿），顺序保证必须落在消费端。重绘进行中（renderTimer 非空）到达的流式事件
  // 先攒着，flushRender 里 render+liveSync 之后按原序放行——顺序仍是「快照先画、事件后补」
  var pendingStream: HostToWebviewTagged[] = [];
  function deferDuringRender(t: string): boolean {
    // 粘性回显刀（2026-09-23 交接 §八.1，用户令「能改就改了」）：'user' 移出延后名单。
    // 病灶：启动渲染窗口期（renderTimer 非空）发的消息，回显被排进 pendingStream，压到重绘
    // 落地才画——用户体感「气泡 1s 才出」。顺序风险原是「renderAll 的 liveReset 抹先到事件」，
    // 但 addUser 追加 bubble 与 liveReset（只清 live 区）互不触碰，立即画上无序可破；
    // 且历史重绘以 pi session.messages 为唯一真相，回显 bubble 被权威 render 覆盖是设计而非事故。
    return t === 'delta' || t === 'thinking' || t === 'newLive' || t === 'toolCallStart' ||
      t === 'toolCallDelta' || t === 'toolStart' || t === 'toolEnd' ||
      t === 'queuedAdd' || t === 'queuedDelivered' || t === 'queuedRemove' || t === 'queuedClear';
  }
  function drainPendingStream() {
    if (!pendingStream.length) return;
    var q = pendingStream; pendingStream = [];
    for (var i = 0; i < q.length; i++) routeMsg(q[i]);
  }
  /** 页签切换（刀5）：本地只换芯片高亮，内容现场由宿主 postUiState 重拉（pi 会话=唯一真相，
   *  webview 零影子状态——切回页签丢失现场在架构上不可能，因为根本不存在本地副本） */
  /** 页签切换（工单24 架构归位二期）：整个下区视图换可见性 O(1)。每个控件的实时状态都已在
   *  各自视图里活渲染（后台也一样），这里没有任何重渲——只有页头会话标题（页面级）和
   *  代码上下文 chip（页面级数据）需要补一下；跟随标志为真则补拉底（后台滚不动，见 scroll） */
  function activateTab(tid: string) {
    if (getActiveTabId() === tid) { renderTabs(); return; }
    setActiveTabId(tid); tabId = tid;
    var v = viewFor(tid); // 三期：闭包原始值不走对象属性，必须方法访问器
    for (var vid in views) views[vid].show(vid === tid); // 换可见性 O(1)，零重渲零重拉
    // 页头会话标题是页面级，切页签时从宿主清单对齐（会话名即标签题）
    for (var ti = 0; ti < tabsList.length; ti++) {
      if (tabsList[ti].id === tid) { sessionEl.textContent = L.sessionLabel + tabsList[ti].title; break; }
    }
    v.renderCodeChip(); // codeCtx 是页面级数据，新视图的 chip 可能还是原型态
    // 残留清扫（白 Working 事故兑底）：按本页签真相重渲状态行，不残留历史漂移写口
    v.refreshBusy();
    // 后台视图期间内容在长而滚不动（display:none 无布局），跟随标志为真则切回后补拉底
    if (v.isFollowing()) v.forceScrollToBottom();
    subDock.applyTab(tid); // 子 agent 浮窗/图标随页签切换（该页签的快照缓存恢复或收起）
    renderTabs();
    // 未建树的页签向宿主要一次快照（webview 重载后未轮到的后台页签/重启恢复页签）；
    // 已建树的不重拉——切页签零快照窗口，竞态整类消失
    if (!v.isBuilt()) vscode.postMessage({ type: 'tabSwitch', tabId: tid, needState: true });
  }

  /** 标签条渲染：宿主 tabs 消息是唯一事实源（id/title/busy/unread）；≤1 会话默认隐藏（用户定调） */
  function renderTabs() {
    tabbarEl.innerHTML = '';
    if (tabsList.length <= 1) { tabbarEl.classList.remove('has-tabs'); return; }
    tabbarEl.classList.add('has-tabs');
    for (var i = 0; i < tabsList.length; i++) {
      (function (t: TabInfo) {
        var chip = el('span', 'tab-chip' + (t.id === getActiveTabId() ? ' active' : '') + (t.busy ? ' busy' : '') + (t.unread && t.id !== getActiveTabId() ? ' unread' : ''));
        chip.title = t.title;
        chip.appendChild(el('span', 'tab-dot'));
        chip.appendChild(el('span', 'tab-title', shorten(t.title, 14)));
        var x = el('span', 'tab-x', '\u00d7');
        x.title = L.tabCloseTitle;
        if (t.busy) x.className = 'tab-x always'; // busy 中关标签宿主会弹确认，× 常显提醒
        x.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'tabClose', tabId: t.id }); });
        chip.appendChild(x);
        chip.addEventListener('click', function () {
          if (t.id === getActiveTabId()) return;
          activateTab(t.id); // 本地先切（零延迟），宿主 postUiState 拉真相回填
          vscode.postMessage({ type: 'tabSwitch', tabId: t.id });
        });
        tabbarEl.appendChild(chip);
      })(tabsList[i]);
    }
    // ＋入口变迁：2026-09-14 曾按用户拍板收敛到头部（当时吐槽点：与标签条＋撞脸）；
    // 2026-09-20 用户拍板恢复——页签末尾要 add 按钮开新标签会话，头部＋保留，双入口并存
    var add = el('span', 'tab-add');
    add.innerHTML = ico('plus', 12);
    add.title = L.tabNewTitle;
    add.addEventListener('click', function () { vscode.postMessage({ type: 'tabNew' }); });
    tabbarEl.appendChild(add);
  }

  /** 宿主标签清单（唯一事实源）：未读点由宿主记账（后台跑完置位，切回时清） */
  function handleTabs(m: TabsMsg) {
    tabsList = m.tabs || [];
    // J 刀：页头随宿主标题刷新（宿主是标题唯一事实源）；无标题不覆盖，applyState 仍兑底
    for (var tTi = 0; tTi < tabsList.length; tTi++) {
      if (tabsList[tTi].id === getActiveTabId() && tabsList[tTi].title) {
        sessionEl.textContent = L.sessionLabel + tabsList[tTi].title;
        break;
      }
    }
    if (getActiveTabId() === null || m.activeTabId !== getActiveTabId()) {
      // 宿主驱动换页签（新建/关标签转移/重启重建）：同款 O(1) 换根+账本重渲；
      // 换的是非活动标签时 activateTab 内部直接返回
      activateTab(m.activeTabId);
    }
    renderTabs();
    // 三期：已关闭页签的视图随手 dispose（清三 timer + 摘 DOM；宿主清单是事实源）
    for (var id in views) {
      var alive = false;
      for (var ti = 0; ti < tabsList.length; ti++) { if (tabsList[ti].id === id) { alive = true; break; } }
      if (!alive) { views[id].dispose(); delete views[id]; }
    }
  }
  window.addEventListener('message', function (ev: MessageEvent) {
    var m = ev.data as HostToWebviewTagged;
    // 凭证配置页（2026-11-05）：页面级覆盖层，与页签无关，先于 tabId 过滤截获
    if (m.type === 'authPanelOpen') { showAuthPanel(); return; }
    if (m.type === 'authState') { renderAuthProviders(((m as any).providers || []) as any[]); return; }
    // 标签清单先于 tabId 过滤处理（宿主是事实源）
    if (m.type === 'tabs') { handleTabs(m); return; }
    // 子 agent 快照在页签过滤前截获：后台页签的流虽不渲染但必须缓存，
    // 否则切回时该页签的浮窗/图标状态丢失；活动页签则实时渲染
    if (m.type === 'subagentUpdate') { subDock.handleUpdate(m); return; }
    // 台账行（段 3 刀 2）：全局推送无页签归属——覆盖缓存并重绘当前浮窗
    if (m.type === 'subagentLedger') { subDock.setLedger((m as any).rows || []); return; }
    // 鸭子换图是页面级（图源与页签无关），不过路由
    if (m.type === 'duck') { applyDuck(m.uri); return; }
    // 刀3 编辑器面板：tabKey 存进 webview state 快照（VS Code 序列化面板时捕获，
    // 重启后 serializer 传回宿主 → 面板按原 tabKey 恢复原会话）。纯存储不渲染
    if (m.type === 'panelInfo') {
      vscodeApi.setState({ tabKey: (m as any).tabKey });
      // 2026-10-20 拍板（图1 红框退役）：中间编辑区页头整行隐藏——会话标题/历史/新建/
      // 菜单（含 logo）全部移交左侧会话列表（列表点击=打开&切换、＋=新增、齿轮=菜单）。
      // panelInfo 只发给编辑器实例（panel.ts webviewReady），副栏页头原样保留；
      // subind（子 agent 收合开关）是页头唯一活控件，updateSubInd 露出 subind-live 行保功能
      document.body.classList.add('editor-panel');
      return;
    }
    // tabId 路由（工单24 架构归位）：非活动页签的消息照收——写进该页签自己的隐藏树
    // （现场累加，切回即现，不再依赖切回重拉）；页面控件类后台只记账不渲染（bgMode 守卫）
    routeMsg(m);
  });
  // 启动握手：通知宿主 webview 已就绪，宿主拉会话历史重绘（防止设置 HTML 后立刻 postMessage 被丢的竞态）
  vscode.postMessage({ type: 'webviewReady' });

  // 心跳探活 + 断连红条已退役（2026-11-02 用户拍板，别再捡回来）：
  // 它本是为「幽灵面板」（宿主重启后 webview 保活、provider 实例丢失）做可见化，但判定是
  // 「距上次 pong 的绝对时长 > 12s」且发完 ping 立刻判定——分不清「对面死了」和「我自己刚醒」。
  // 实测被 webview 自己的卡顿刷成假阳性：日志里 webview 侧 ping 时间戳连跳 19.4s（定时器漏 6 拍），
  // 宿主全程正常回话。用户看到的是「插件炸了」的红条 + 怀疑，代价远大于收益。
  // 幽灵面板的处置回到:关标签重开（会话已落盘，不丢）；这是平台边界，无自愈 API。
})();

