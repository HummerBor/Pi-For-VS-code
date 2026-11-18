/**
 * 状态行 / 页脚 / 横幅（2026-11-26 第 6 刀子刀 6c-1，从 webview/main.ts 整块拆出）：
 * 状态行文案与 Working 秒表（setStatus / startBootTick / stopBootTick / renderBusyUi / setBusy /
 * setCompacting）+ 模式标签（renderStatus）+ 顶部横幅（renderBanner）+ 本轮变更文件条
 * （renderChanges）+ 页脚真相帧（applyState / fmtSession）。
 *
 * 为什么是 initStatusBar(deps) 而不是模块级单例：这一整块随 .session-view 克隆，**每页签一套**
 * DOM 与定时器（Working 秒表 busyTimer 与启动秒表 bootTickTimer 都是本页签自己的钟）。入口在
 * makeSessionView 里调一次，元素经 deps.q 查自己的视图（R18：不许 document.getElementById
 * —— 这些 ID 在每个 .session-view 内重复）。
 *
 * ★ 红线一（数据来源不许改）：页脚百分比/花费只吃宿主 ctxDetail 真值帧（ctxPop 的
 *   refreshUsage / applyDetail 仍由 main.ts 的 handleMsg 原样转调）；状态行的排队计数只吃宿主
 *   uiState / queue 帧；Working 秒表由 busy 帧 + 子 agent 存活信号驱动。三条都是「宿主说真话，
 *   壳只搬」，别在本模块里自己算第二份。
 * ★ 红线二（4s pendingPrompt 兜底与压缩优先级）：4s 兜底在 src/core/piCore.ts，不在这；
 *   本模块只负责渲染侧的优先级 —— renderBusyUi 里 compacting 压过 Working、bootPending 期不许
 *   清状态行（B 刀），两个守卫都是事故注释的落点，别「优化」掉。
 * ★ 红线三（状态单份）：busyStart / lastElapsed / roundFrozen / busyTimer / bootTickTimer /
 *   bootTickStart 由本模块独占（原先就是 main.ts 闭包里的同名局部量）；而 queueN / compacting /
 *   modeText / bootPending 的**写口还在 main.ts 的 handleMsg**（6c-1 不许碰 handleMsg），所以那四个
 *   只经 deps 的 getXxx() / setXxxFlag() 读写 —— 同一份内存，两边都不存副本（照 6a 的
 *   getTabsList / setFollowingEnd 先例）。
 *
 * 逐字核对（搬走的三块与 HEAD 归一化后零差异）与逐条差异理由见 reports/REPORT-t45.md。
 */
import type { BannerPayload, ChangesFileInfo } from "../../src/core/protocol";
import { getActiveTabId, type ViewState } from "../core/state";
import { getTabsList } from "./tabs";

export interface StatusBarDeps {
  /** 本视图所属页签 id（原 makeSessionView 的 id 形参）：applyState 判「页头只刷活动页签」、
   *  renderBusyUi 查本页签的子 agent 是否仍在跑 */
  viewId: string;
  /** 查本视图内的元素（ID 在各视图内重复，必须 scope 到视图；原来 makeSessionView 里的 q()） */
  q: (sel: string) => HTMLElement;
  /** 本视图的共享状态（createViewState）：状态行要读写 S.busy，**不许另存一份**（state.ts 头注释） */
  state: ViewState;
  /** i18n 文案表（main.ts 的 L） */
  lang: Record<string, any>;
  /** 图标集查询（main.ts 的 ico：模型 chip 的 cpu 图标） */
  ico: (name: string, size?: number) => string;
  /** HTML 转义（模型名是拼 innerHTML 进 .chip-label 的） */
  esc: (s: any) => string;
  /** 视图级上行（原 vpost：显式带本视图 tabId）；变更条的「清单」按钮走这条 */
  post: (m: any) => void;
  /** 页面级上行（原 vscode.postMessage：打标桥在 main.ts）；横幅的压缩/关闭与变更条关闭走这条 */
  postPage: (m: any) => void;
  /** 页头会话标题元素（页面级、初始化晚于视图构建 → getter）；applyState 只在活动页签写它 */
  getSessionEl: () => HTMLElement;
  /** 子 agent 浮窗：renderBusyUi 判「主回合结束但后台子 agent 仍在跑 → 秒表继续累」。
   *  页面级单例，初始化早于任何视图构建（视图只在消息路由时才建），故直接给引用 */
  subDock: { runsOf: (tid: string) => any; anyLive: (runs: any) => boolean };
  /** 变更页（变更条的「查看」主入口）；视图内单例，建在本模块装配点之前 */
  changesPage: { open: () => void };
  /** 上下文用量弹层 + 页脚圆环（applyState 每次刷页脚占比与花费）；同上，建在装配点之前 */
  ctxPop: { refreshUsage: (stats: any) => void };
  /** 收尾在途消息（setBusy(false) 时调；在途气泡/parts 表归 features/liveStream.ts 独占） */
  finalizeLive: () => void;
  liveReset: () => void;
  /** 状态行排队计数（写口在 main.ts handleMsg 的 uiState / queue 两支）。注意秒表每拍都要
   *  重新读现值 —— 不是渲染时快照，排队数变了要跟着动 */
  getQueueN: () => number;
  /** 压缩窗口开合（写口一：main.ts handleMsg；写口二：本模块的 setCompacting） */
  getCompacting: () => boolean;
  setCompactingFlag: (v: boolean) => void;
  /** 启动占位帧标记（写口一：main.ts uiState 分支必须先落；写口二：本模块 applyState） */
  getBooting: () => boolean;
  setBootingFlag: (v: boolean) => void;
  /** 模式文案（写口在 main.ts handleMsg；renderStatus 只读一次现值） */
  getModeText: () => string;
}

export interface StatusBarApi {
  setStatus: (t?: string) => void;
  startBootTick: (base: string) => void;
  stopBootTick: () => void;
  renderStatus: () => void;
  renderBanner: (b: BannerPayload | null) => void;
  renderChanges: (files: ChangesFileInfo[]) => void;
  setBusy: (v: boolean, elapsedMs?: number) => void;
  setCompacting: (v: boolean) => void;
  /** main.ts 视图对象的 refreshBusy（白 Working 兑底：激活页签时按本页签真相重渲状态行） */
  refreshBusy: () => void;
  applyState: (m: any) => void;
  /** 视图销毁：停本模块自己的两块秒表（R19 谁创建谁清） */
  dispose: () => void;
}

export function initStatusBar(deps: StatusBarDeps): StatusBarApi {
  var id = deps.viewId;
  var q = deps.q;
  var S = deps.state;
  var L = deps.lang;
  var ico = deps.ico;
  var esc = deps.esc;
  var vpost = deps.post; // 原 main.ts 同名（视图级上行，显式带 tabId）
  var postPage = deps.postPage;
  var getSessionEl = deps.getSessionEl;
  var subDock = deps.subDock;
  var changesPage = deps.changesPage;
  var ctxPop = deps.ctxPop;
  var finalizeLive = deps.finalizeLive;
  var liveReset = deps.liveReset;
  var getQueueN = deps.getQueueN;
  var getCompacting = deps.getCompacting;
  var setCompactingFlag = deps.setCompactingFlag;
  var getBooting = deps.getBooting;
  var setBootingFlag = deps.setBootingFlag;
  var getModeText = deps.getModeText;
  // 本域元素（原 makeSessionView 顶部「下区控件元素引用」组里属于状态行/页脚/横幅的那几个；
  // #model / #think / #modebadge / #stop 的事件绑定仍在 main.ts 的 bindViewEvents，两处各查一次同一个节点）
  var statusEl = q('#status'); var modeBadge = q('#modebadge');
  var modelEl = q('#model'); var thinkEl = q('#think');
  var bannerEl = q('#banner'); var changesBarEl = q('#changesbar');
  var stopBtn = q('#stop');
  // 本模块独占的状态（原先就是 main.ts 闭包里的同名局部量，随块搬入；main.ts 不再留副本）
  var busyTimer: any = null; var busyStart = 0; // 「主回合在跑」住 S.busy（原局部 streaming）
  var lastElapsed: number | null = null;
  var roundFrozen = ''; // 本轮总用时冻结文本（全收尾才写；新轮清零——一轮一只累计秒表）
  function setStatus(t) { if (t) { statusEl.classList.remove('busy'); statusEl.textContent = t; } else if (!S.busy) { statusEl.textContent = ''; } }
  // N 刀（2026-09-23 用户点名「没感觉秒开，往这里加个计时器」）：启动秒表——
  // 「正在启动 pi… Ns」实时走秒。旁路 setStatus 直写（同 ⏱/busy 帧先例）；
  // 自守卫：状态行被任何人接管（busy 类/别的文案）即自杀停摆，杜绝「白 Working」
  // 同款串写残留（2026-09-20 事故教训）。宿主侧 boot phase=… 分段计时与本表互为印证。
  var bootTickTimer: any = 0;
  var bootTickStart = 0;
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
  function renderStatus() { modeBadge.textContent = getModeText(); }

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
      act.onclick = function () { postPage({ type: 'compactSession' }); };
      bannerEl.appendChild(act);
    }
    var x = document.createElement('span'); x.className = 'b-close'; x.textContent = '✕'; x.title = L.bannerDismiss;
    x.onclick = function () { postPage({ type: 'bannerClose' }); };
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
    x.onclick = function () { postPage({ type: 'changesDismiss' }); };
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
      statusEl.textContent = (getCompacting() ? '⏳ ' + L.compacting : frames[0] + ' Working… 0s');
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
        statusEl.textContent = (getCompacting() ? '⏳ ' + L.compacting : frames[fi] + ' Working… ' + fmtDur(Date.now() - myStart) + (getQueueN() > 0 ? L.queuedCount.replace('{n}', getQueueN()) : ''));
      }, 120);
      busyTimer = myTimer;
    } else {
      statusEl.classList.remove('busy');
      // B 刀：占位期不清状态行（否则 setBusy(false) 会把「pi 后台启动中… Ns」刷掉，
      // 与 applyState 的守卫成对——漏一道就还是 6 秒零反馈）
      if (!getBooting()) statusEl.textContent = '';
      if (getCompacting()) {
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
    setCompactingFlag(v);
    if (v) {
      statusEl.classList.add('busy'); // 复用高亮+脉动，同「忙」视觉
      statusEl.textContent = '⏳ ' + L.compacting;
    }
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
    setBootingFlag(m.booting === true);
    if (!getBooting()) {
      stopBootTick(); // N 刀：首帧真值状态到达 = 启动结束，秒表收表（文本由下方清理）
      if (!getCompacting() && statusEl.textContent.indexOf('⏱') !== 0) setStatus(''); // pi 已就绪，清掉「正在启动 pi…」之类的临时状态
    }
    // 模型名包进 .chip-label，底栏限宽时省略号截断，全名靠 title（下一行）
    modelEl.innerHTML = ico('cpu') + ' <span class="chip-label">' + esc(m.model ? (m.model.name || m.model.id) : '—') + '</span>';
    modelEl.title = m.model ? L.modelTitleCur.replace('{v}', (m.model.provider || '') + '/' + (m.model.id || '')) : L.switchModel;
    thinkEl.textContent = L.thinkLabel + (m.thinkingLevel !== null && m.thinkingLevel !== undefined ? m.thinkingLevel : '—');
    if (id === getActiveTabId()) {
    // J 刀：页头优先用宿主 tabs 标题（唯一事实源：空会话「新会话」/时区本地化都在宿主
    // fmtSessionTitle 收口），fmtSession 只作 tabs 未到时的兑底
    var hostTitle = '';
    var tl = getTabsList();
    for (var hTi = 0; hTi < tl.length; hTi++) if (tl[hTi].id === getActiveTabId()) { hostTitle = tl[hTi].title; break; }
    var sessName = hostTitle || fmtSession(m.sessionFile, m.sessionName);
    getSessionEl().textContent = L.sessionLabel + sessName;
    getSessionEl().title = m.sessionFile ? (L.curSession + m.sessionFile + '\n' + L.clickSwitchSession) : L.clickPickSession;
    }

    // 页脚用量：圆圈百分比（2026-11-05 用户指定）——圆环画占比，右侧文字只留成本；
    // 圆环颜色随占比升档（<70 蓝 / <90 橙 / ≥90 红），与阈值预警同色语言
    ctxPop.refreshUsage(m.stats);
  }

  return {
    setStatus: setStatus, startBootTick: startBootTick, stopBootTick: stopBootTick,
    renderStatus: renderStatus, renderBanner: renderBanner, renderChanges: renderChanges,
    setBusy: setBusy, setCompacting: setCompacting,
    refreshBusy: renderBusyUi, applyState: applyState,
    // 两处秒表归属本模块（R19 谁创建谁清；main.ts 的 dispose 只转调这一行）
    dispose: function () { if (busyTimer) { clearInterval(busyTimer); busyTimer = null; } stopBootTick(); }
  };
}
