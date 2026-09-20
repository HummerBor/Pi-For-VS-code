/**
 * webview 前端脚本（聊天面板全部交互逻辑）。
 * 由 vite 构建：npm run build:webview → dist/webview/main.js，宿主 getHtml 注入 webview。
 * 历史说明：曾以字符串数组内联在 panel.ts 里，故主体保留 ES5 var 风格。
 * 类型门禁：strict:false 下 tsc 零报错（已摘除 @ts-nocheck，工单一验收项）。
 */
import { STRINGS, type Lang } from "../src/i18n";
import type { HostToWebviewTagged, SessionMessage, SlashCommand, WorkspaceFile, BannerPayload, ChangesFileInfo, TabsMsg, TabInfo } from "../src/protocol";
import { toolDetail } from "../src/toolDetail";
import type { SubagentSnapshot } from "../src/subagentSnapshot"; // 快照构建在宿主（subagentSnapshot.ts），webview 只消费
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

  // ── 三期整树搬迁（交接 4 六步法）：每页签一个完全隔离的 SessionView 工厂闭包 ──
  // 自己的 DOM/状态/定时器/输入框；routeMsg 经 viewFor(tid).handleMsg 一行直达。换镜机制
  // （useTab/assignMirrors/saveMirrors/curTabId/bgMode）整体退役——镜像漂移（白 Working/
  // 串会话两类事故的根因）在结构上不可能再发生。函数体逐字符未动（scripts/migrate-phase3.mjs
  // 机械搬运），语义修改仅六处：①scroll bgMode→id 判定 ②applyState 同 ③上行改 vpost 显式带
  // 自己 tabId ④scheduleStream/scheduleRender 去换镜舞蹈 ⑤built 直写闭包 ⑥codeCtx 页面级
  // 数据 + renderCodeChipAll 循环各视图。重载实测重点见 BUILDER.md 交接 4。
  // 轻量 Markdown：代码块 / 标题 / 列表 / 行内 code / 粗体
  function renderInline(elm, text) {
    var re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) elm.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0];
      if (tok.charAt(0) === '`') { var c = document.createElement('code'); c.textContent = tok.slice(1, -1); elm.appendChild(c); }
      else { var b = document.createElement('b'); b.textContent = tok.slice(2, -2); elm.appendChild(b); }
      last = m.index + tok.length;
    }
    if (last < text.length) elm.appendChild(document.createTextNode(text.slice(last)));
  }
  function renderPlain(parent, text) {
    var lines = String(text).split('\n');
    var div = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.trim() === '') { div = null; continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        var tbl = [line];
        while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) tbl.push(lines[++i]);
        renderTable(parent, tbl);
        div = null; continue;
      }
      if (/^#{1,6}\s/.test(line)) {
        var h = el('div', 'md-h'); renderInline(h, line.replace(/^#{1,6}\s*/, '')); parent.appendChild(h); div = null; continue;
      }
      var lm = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (lm) {
        var li = el('div', 'md-li'); li.style.paddingLeft = (12 + lm[1].length * 10) + 'px';
        li.appendChild(document.createTextNode((lm[2] === '-' || lm[2] === '*' ? '•' : lm[2]) + ' '));
        renderInline(li, lm[3]); parent.appendChild(li); div = null; continue;
      }
      if (/^>\s?/.test(line)) {
        var qt = el('div', 'md-quote'); renderInline(qt, line.replace(/^>\s?/, '')); parent.appendChild(qt); div = null; continue;
      }
      if (!div) { div = el('div', 'md-p'); parent.appendChild(div); }
      renderInline(div, line);
      div.appendChild(document.createTextNode('\n'));
    }
  }
  function renderTable(parent, rows) {
    function cells(r) { return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|'); }
    var t = document.createElement('table'); t.className = 'md-table';
    for (var ri = 0; ri < rows.length; ri++) {
      var cs = cells(rows[ri]);
      if (ri === 1 && cs.every(function (c) { return /^\s*:?-+:?\s*$/.test(c); })) continue; // 表头分隔行
      var tr = document.createElement('tr');
      for (var cj = 0; cj < cs.length; cj++) {
        var td = document.createElement(ri === 0 ? 'th' : 'td');
        renderInline(td, cs[cj].trim()); tr.appendChild(td);
      }
      t.appendChild(tr);
    }
    parent.appendChild(t);
  }
  function renderRich(parent, text) {
    // 逐行扫描：围栏必须行首才算代码块，行内 ``` 不影响（之前任意位置都算，行内反引号会把大段内容吞进代码框）
    var lines = String(text).split('\n');
    var buf = []; var code = []; var inCode = false;
    function flushPlain() { if (buf.length) { renderPlain(parent, buf.join('\n')); buf = []; } }
    function flushCode() { if (code.length) { parent.appendChild(el('pre', 'code', code.join('\n'))); code = []; } }
    for (var i = 0; i < lines.length; i++) {
      if (/^```/.test(lines[i])) {
        if (!inCode) { flushPlain(); inCode = true; }
        else { flushCode(); inCode = false; }
        continue;
      }
      if (inCode) code.push(lines[i]); else buf.push(lines[i]);
    }
    if (code.length) parent.appendChild(el('pre', 'code', code.join('\n')));
    flushPlain();
    linkify(parent);
  }
  function makeSessionView(id: string) {
    var view = document.createElement('div');
    view.className = 'session-view' + (id === activeTabId ? '' : ' offview');
    view.innerHTML = protoHTML;
    sessionArea.appendChild(view);
    var root = view.querySelector('.msg-root') as HTMLElement;
    // 下区控件元素引用（原 72-77 行全局镜像组，三期改为建视图时一次性查询绑定）
    var q = function (sel: string) { return view.querySelector(sel) as HTMLElement; };
    var input = q('#input') as HTMLTextAreaElement; var stopBtn = q('#stop'); var sendBtn = q('#send');
    var statusEl = q('#status'); var modeBadge = q('#modebadge'); var codechipEl = q('#codechip');
    var modelEl = q('#model'); var thinkEl = q('#think'); var usageEl = q('#usage');
    var attachbarEl = q('#attachbar'); var attachEl = q('#attach'); var fileInput = q('#file') as HTMLInputElement;
    var suggestEl = q('#suggest'); var plusmenuEl = q('#plusmenu'); var pmUpload = q('#pm-upload'); var pmAt = q('#pm-at');
    var bannerEl = q('#banner'); var changesBarEl = q('#changesbar'); var queuebarEl = q('#queuebar');
    var compactbarEl = q('#compactbar'); // 压缩浮动条（仿改动条：完成后提示 + 点击定位折叠块）
    // 视图内上行显式带自己的 tabId（不再借活动页签打标——换镜退役后归属唯一）
    function vpost(m: any) { if (m.tabId === undefined) m.tabId = id; vscodeApi.postMessage(m); }
  var toolEls = {}; var queuedItems = [];
  // 工单28：最后一问 sticky 悬浮——只标最后一条 user bubble 的引用（新 user 到 → 旧摘除、新挂上；
  // renderAll 历史重绘走同一个 addUser，循环末尾自然只剩最后一条带 class）
  var stickyQ: HTMLElement | null = null;
  // 工单29扩权（用户直令 2026-09-20）：连续同名工具折叠成组——记最近完成的工具组
  // {name, ref(存活行), count}。合并条件靠 DOM 相邻判定（row→box→row→box 首尾相接），
  // 中间插了文本/思考块即不是「连续」，重绘后旧引用的 nextElementSibling 为 null 也不会误合
  var lastToolGroup: { name: string; ref: any; count: number } | null = null;
  var liveMsg = null; var liveDiv: HTMLElement | null = null; var pdet: HTMLElement | null = null; var liveParts: any = null; var liveRTimer: number | null = null;
  var streaming = false; var busyTimer: any = null; var busyStart = 0; var queueN = 0;
  var compacting = false;
  var lastElapsed: number | null = null;
  var modeText = 'Auto';
  var pendingImages: any[] = []; var pendingFiles: any[] = [];
  var banner: BannerPayload | null = null; var changes: ChangesFileInfo[] | null = null;
    var built = false; // uiState/render 快照是否已建树（activateTab 按此决定要不要向宿主要快照）
  function bindViewEvents() {
    attachEl.innerHTML = ico('image');
    pmUpload.innerHTML = ico('image', 13) + '<span>' + L.uploadFile + '</span><span style=' + String.fromCharCode(34) + 'opacity:.5;font-size:10px;margin-left:auto;' + String.fromCharCode(34) + '>' + L.dragShift + '</span>';
    pmAt.innerHTML = ico('at', 13) + '<span>' + L.referenceFile + '</span>';
    modelEl.innerHTML = ico('cpu') + ' —';
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
    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', function () { vpost({ type: 'abort' }); });
    fileInput.addEventListener('change', function () { handleFiles(fileInput.files || [], null); fileInput.value = ''; });
    modelEl.addEventListener('click', function () { vpost({ type: 'pickModel' }); });
    thinkEl.addEventListener('click', function () { vpost({ type: 'pickThinking' }); });
    modeBadge.addEventListener('click', function () { vpost({ type: 'pickMode' }); });
    codechipEl.addEventListener('click', function () { codeOn = !codeOn; renderCodeChipAll(); });
    input.addEventListener('input', function () { updateSuggest(); autoSize(); });
    input.addEventListener('keydown', inputKeydown);
    input.addEventListener('paste', inputPaste);
    renderCodeChip();
  }
    // ＋菜单文档级关闭监听：每视图一份各关各的（原全局监听读镜像，随换镜退役）
    document.addEventListener('click', function (e) { var tgt = e.target as Node; if (!plusmenuEl.contains(tgt) && tgt !== attachEl) plusmenuEl.style.display = 'none'; });
  var sgList = []; var sgSel = 0; var sgKind = null;
  // '/' 菜单打开状态：仅在打开瞬间向宿主要一次新列表。updateSuggest 在 slashList
  // 到达时会再次执行，若每次都发 getSlash 就是乒乓死循环（列表不停重渲染把选中项
  // 冲回第一行，方向键永远选不中——2026-09-18 实测）；hideSuggest 时复位，下次打开再拉新
  var slashMenuOn = false;
  // 附件无感去重（重复拖入/粘贴直接跳过，不提示不报错）。图片按 base64 内容判重——
  // 同名不同图不误伤、同图不同名也能拦住；文件按归一化绝对路径判重（Windows 大小写/
  // 分隔符不敏感）。字节通道文件（OS 拖入拿不到路径）宿主每次落盘都生成新临时名
  // pi-attach-<时间戳>，路径判重对它永远失效（同一文件拖三次进来三份的事故）——
  // 这类一次性临时条目改信原始文件名判重；真路径条目只比路径，同名不同目录不误伤
  function normPath(p) { return String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }
  function isTmpAttach(pathStr) { var b = String(pathStr).split(/[\\/]/).pop() || ''; return b.indexOf('pi-attach-') === 0; }
  function hasImg(data) { for (var i = 0; i < pendingImages.length; i++) { if (pendingImages[i].data === data) return true; } return false; }
  function hasFile(pathStr, name) {
    if (!pathStr && !name) return false;
    var k = pathStr ? normPath(pathStr) : '';
    for (var i = 0; i < pendingFiles.length; i++) {
      var e = pendingFiles[i];
      if (k && e.path && normPath(e.path) === k) return true;
      // 一方是字节通道临时文件时路径无意义，退回按原始文件名判重
      if (name && e.name === name && ((!e.path && !pathStr) || isTmpAttach(e.path) || isTmpAttach(pathStr))) return true;
    }
    return false;
  }
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
    if (id !== activeTabId) return;
    suppressScroll = true;
    root.scrollTop = root.scrollHeight;
  }
  function setStatus(t) { if (t) { statusEl.classList.remove('busy'); statusEl.textContent = t; } else if (!streaming) { statusEl.textContent = ''; } }
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
    var act = document.createElement('button'); act.className = 'b-act'; act.textContent = L.changesView;
    act.onclick = function () { vscode.postMessage({ type: 'showChanges' }); };
    changesBarEl.appendChild(act);
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
    stopBtn.style.display = streaming ? 'inline-flex' : 'none';
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    if (streaming) {
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
        // ticker 直接读自己视图闭包的 streaming/statusEl——串写在结构上不可能；
        // 自愈保留：streaming 已结束而 timer 未被正常清时自杀停摆。
        // clearInterval 只清自己的 myTimer（不碰 busyTimer，它可能是后一轮的）
        if (!streaming) {
          clearInterval(myTimer);
          if (busyTimer === myTimer) busyTimer = null;
          return;
        }
        // 实时计数从乐观置位起算（比真实 agent 时间多 1~2s）；结束后以宿主实测耗时为准
        statusEl.textContent = (compacting ? '⏳ ' + L.compacting : frames[fi] + ' Working… ' + fmtDur(Date.now() - myStart) + (queueN > 0 ? L.queuedCount.replace('{n}', queueN) : ''));
      }, 120);
      busyTimer = myTimer;
    } else {
      statusEl.classList.remove('busy');
      statusEl.textContent = '';
      if (compacting) {
        // 压缩中（如压缩期间发消息被 preflight 拒收 → busy:false）：保住压缩标签不清空
        statusEl.classList.add('busy');
        statusEl.textContent = '⏳ ' + L.compacting;
      } else
      // 本轮实测耗时（宿主 agent_start→settled，中断也算一轮）：留在状态栏直到下次状态变化；
      // 同时入记录，切走再切回来能恢复 ⏱ 现场
      if (lastElapsed != null) {
        statusEl.textContent = '⏱ ' + fmtDur(lastElapsed);
        statusEl.title = L.turnDuration;
      }
    }
  }
  function setBusy(v, elapsedMs) {
    streaming = v;
    if (v) {
      // 计时起点对齐宿主真相：对账/纠回时 elapsedMs 是真实已过时长，回拨起点。
      // 否则每次 busy:true 都会把 Working 计时清小（实测 3s/1m4s 与实际不符的根源）
      busyStart = elapsedMs != null ? Date.now() - elapsedMs : Date.now();
      lastElapsed = null;
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

  function addUser(text: string, imageCount?: number, codeInfo?: string, fileCount?: number) {
    // 子 agent 异步回报特殊标记渲染（2026-09-18 用户拍板升级：不隐藏，改独立卡片——
    // 防止被当成用户自己说的话；前版“直接不展示”作废）。前缀契约在 subagent 扩展的
    // sendUserMessage 处（"[子 agent sa-N 完成|失败] agent名: 输出"），改格式两处同步。
    var sm2 = (text || '').match(/^\[子 agent (\S+) (完成|失败)\] ([^:\n]*): ?/);
    if (sm2) {
      var card = el('div', 'subret' + (sm2[2] === '失败' ? ' fail' : ''));
      var sh = el('div', 'subret-head', '⮑ 子 agent ' + sm2[1] + ' · ' + sm2[2] + (sm2[3] ? ' · ' + sm2[3] : ''));
      card.appendChild(sh);
      var sb = el('div', 'subret-body');
      renderRich(sb, text.slice(sm2[0].length) || text); // 正文 markdown 渲染（回报常带表格）
      card.appendChild(sb);
      root.appendChild(card); followingEnd = true; scroll();
      return;
    }
    var w = root.querySelector('#welcome'); if (w) w.remove(); var b = el('div', 'bubble user');
    // 工单28 追加（用户直令 2026-09-20）：sticky 默认限两行（面积太大），点击展开/再点折叠；
    // 迁移时旧 bubble 连 sticky-open 状态一起摘，新 bubble 永远从折叠态起步
    if (stickyQ) { stickyQ.classList.remove('sticky-q'); stickyQ.classList.remove('sticky-open'); }
    stickyQ = b; b.classList.add('sticky-q');
    b.addEventListener('click', function () { b.classList.toggle('sticky-open'); }); if (text) { b.textContent = text; } else { b.innerHTML = ico('filecode', 12) + ' ' + L.codeCtxBubble; } if (codeInfo) { var n1 = el('div', 'notice'); n1.innerHTML = ico('filecode', 12) + ' ' + L.attachedCode + esc(codeInfo); b.appendChild(n1); } if (fileCount) { var n3 = el('div', 'notice'); n3.innerHTML = ico('filecode', 12) + ' ' + fileCount + L.filesUnit; b.appendChild(n3); } if (imageCount) { var n2 = el('div', 'notice'); n2.innerHTML = ico('image', 12) + ' ' + imageCount + L.imagesUnit; b.appendChild(n2); } root.appendChild(b); followingEnd = true; scroll(); }  // 主动发消息=回底意图（工单十七要点 3）
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
      nb.appendChild(el('span', 'q-text', '⮑ 子 agent ' + fm[1] + ' · ' + fm[2] + (fm[3] ? ' · ' + fm[3] : '') + ' · ' + L.subRetQueued));
      qb.appendChild(nb);
    }
  }
  function removeQueued(qid) {
    queuedItems = queuedItems.filter(function(x) { return x.qid !== qid; });
    var els = queuebarEl.querySelectorAll('[data-qid="' + qid + '"]');
    for (var i = 0; i < els.length; i++) els[i].parentNode.removeChild(els[i]);
  }
  // 增量渲染（照 pi TUI 的思路：只往已有节点追加，不整气泡重绘；文本块结束时才做一次 markdown 渲染，settled 再全量纠偏）
  function liveEnsure() {
    if (!liveDiv) { liveDiv = el('div', 'bubble assistant'); root.appendChild(liveDiv); }
    if (!liveMsg) liveMsg = { content: [] };
    if (!liveParts) liveParts = {};
  }
  function liveBlock(ci: number, kind: string, name?: string) {
    liveEnsure();
    while (liveMsg.content.length <= ci) liveMsg.content.push(null);
    var p = liveParts[ci];
    if (p && p.kind !== kind) { finalizeLive(); p = null; }
    if (!p) {
      var wrap = document.createElement('div'); var body;
      if (kind === 'thinking') {
        var d = document.createElement('details'); d.className = 'think'; d.open = true;
        var sm = document.createElement('summary'); sm.textContent = L.thinkingProcess;
        body = el('div', 'think-body', ''); d.appendChild(sm); d.appendChild(body); wrap.appendChild(d);
      } else if (kind === 'toolCall') {
        var tl = el('div', 'tool run'); tl.appendChild(el('span', 't-dot')); tl.appendChild(el('span', 't-name', name || 'tool'));
        body = el('span', 't-detail', L.genArgs.replace('{n}', 0)); tl.appendChild(body); wrap.appendChild(tl); pdet = body;
        wrap.className = 'prow'; // 占位行标记：工具真正开跑时按 class 全局清除
        var abox = el('pre', 'code'); abox.style.display = 'none'; wrap.appendChild(abox);
        tl.addEventListener('click', function () { abox.style.display = abox.style.display === 'none' ? 'block' : 'none'; });
      } else {
        body = el('div', 'md-p', ''); wrap.appendChild(body);
      }
      liveDiv.appendChild(wrap);
      p = { kind: kind, wrap: wrap, body: body, buf: '', doneLen: 0, tail: null, tailCode: false };
      if (kind === 'toolCall') { p.raw = ''; p.box = abox; }
      liveParts[ci] = p;
    }
    return p;
  }
  function finalizeLive() {
    if (!liveParts) return;
    for (var k in liveParts) {
      var p = liveParts[k];
      if (p && p.kind === 'text' && !p.done) {
        p.done = true;
        appendFinal(p, p.buf.slice(p.doneLen));
        p.doneLen = p.buf.length;
      }
    }
  }
  function liveReset() { liveMsg = null; liveDiv = null; pdet = null; liveParts = null; }
  // 流式 markdown：已完成的行一次性定型不再动，只有当前行/未闭合代码块作为小尾巴更新
  // （整块重渲染有顿挫感；行级增量才是 CC 那种连贯流式）
  function appendFinal(p, chunk) {
    if (!chunk) return;
    if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail);
    p.tail = null;
    var d = document.createElement('div'); renderRich(d, chunk); p.body.appendChild(d);
  }
  function setMdTail(p, text) {
    if (!text) { if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail); p.tail = null; return; }
    if (!p.tail || p.tailCode) {
      if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail);
      p.tail = el('div', 'md-p', ''); p.body.appendChild(p.tail); p.tailCode = false;
    }
    // 含完整表格行时用 markdown 渲染（表格组退回尾巴区，见 streamTick 防劈叉注释）；
    // 纯未完行仍走 textContent——半截 **bold 不闪样式，流式抖动最小
    if (/^\s*\|.*\|\s*$/m.test(text)) { p.tail.innerHTML = ''; renderRich(p.tail, text); }
    else p.tail.textContent = text;
  }
  function streamTick(p) {
    var rest = p.buf.slice(p.doneLen);
    if (p.tailCode) {
      var ci = rest.search(/^```/m);
      if (ci === -1) { if (p.tail) p.tail.textContent = rest; return; }
      var le = rest.indexOf('\n', ci);
      if (le === -1) { if (p.tail) p.tail.textContent = rest; return; }
      appendFinal(p, rest.slice(0, le + 1));
      p.tailCode = false; p.doneLen += le + 1;
      rest = p.buf.slice(p.doneLen);
    }
    var nl = rest.lastIndexOf('\n');
    if (nl === -1) { setMdTail(p, rest); return; }
    var complete = rest.slice(0, nl + 1);
    var fences = complete.match(/^```/gm);
    if (fences && fences.length % 2 === 1) {
      var idx = complete.lastIndexOf('\n```');
      var lineEnd = idx === -1 ? complete.indexOf('\n') : complete.indexOf('\n', idx + 1);
      var openEnd = lineEnd + 1;
      appendFinal(p, complete.slice(0, openEnd));
      p.doneLen += openEnd;
      p.tailCode = true;
      p.tail = document.createElement('pre'); p.tail.className = 'code';
      p.body.appendChild(p.tail);
      p.tail.textContent = p.buf.slice(p.doneLen);
      return;
    }
    // 表格防劈叉（2026-09-18）：行级定型会把一张表劈成多个单行表——表头行先定型成
    // 单行表，分隔行 | --- | 后到时落在 ri===1 之外被当普通行渲染成「--- --- ---」，
    // 之后每个数据行各成一张独立表，直到 settled 全量纠偏才愈合。判据：本次定型段
    // 末尾的完整行是表格行（|...|），说明表格可能还在长，把所在表格组整体退回尾巴
    // 区富文本渲染，等非表格行到货再定型（renderPlain 按连续 | 行分组，那时 ri===1
    // 分隔行守卫才有效）
    var ls = complete.slice(0, -1).split('\n');
    var ts = ls.length;
    while (ts > 0 && /^\s*\|.*\|\s*$/.test(ls[ts - 1])) ts--;
    if (ts < ls.length) {
      var cut = ts === 0 ? 0 : ls.slice(0, ts).join('\n').length + 1;
      appendFinal(p, complete.slice(0, cut));
      p.doneLen += cut;
      setMdTail(p, p.buf.slice(p.doneLen));
      return;
    }
    appendFinal(p, complete);
    p.doneLen += complete.length;
    setMdTail(p, rest.slice(nl + 1));
  }
  function scheduleStream() {
    // 三期④：换镜舞蹈退役——timer 与回调都住自己视图闭包，触发时元素/状态天然就是自己的
    if (!liveRTimer) liveRTimer = setTimeout(function () {
      liveRTimer = null;
      if (liveParts) for (var k in liveParts) { var p = liveParts[k]; if (p && p.kind === 'text' && !p.done && p.buf.length > p.doneLen) streamTick(p); }
      scroll();
    }, 100);
  }
  function appendDelta(t, ci) {
    var p = liveBlock(ci, 'text');
    p.buf += t;
    streamTick(p); scroll();
  }
  function appendThink(t, ci) {
    var p = liveBlock(ci, 'thinking');
    p.buf += t; p.body.appendChild(document.createTextNode(t));
    // 工单29扩权：think-body 限高后流式自动滚底（新思考内容始终可见，外层 root 滚动跟随不受影响）
    p.body.scrollTop = p.body.scrollHeight;
    scroll();
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
    toolEls[id] = { row: t, box: box, full: null, outVal: null };
    root.appendChild(t);
    root.appendChild(box);
    scroll();
  }
  function toolEnd(id, name, isError, text, detail) {
    var ref = toolEls[id];
    if (!ref) {
      var b2 = el('div', 'tool-box'); b2.style.display = 'none';
      ref = { row: el('div', 'tool'), box: b2 };
      toolEls[id] = ref;
      root.appendChild(ref.row);
      root.appendChild(ref.box);
    }
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
    // 连续同名折叠成组（bash ×N 不设上限，用户拍板）：DOM 相邻（row→box→row→box 首尾相接）
    // 才算连续，中间隔文本/思考块不合；重绘后旧引用 nextElementSibling 为 null 也不会误合。
    // 合并 = 节点搬移零复制（moveChild），被合并方的全量引用先展开进隐藏盒再释放
    var lt = lastToolGroup;
    if (lt && lt.name === name && lt.ref.row.nextElementSibling === lt.ref.box && lt.ref.box.nextElementSibling === t && t.nextElementSibling === ref.box) {
      if (ref.full != null && ref.outVal) { ref.outVal.textContent = ref.full; ref.outVal.classList.add('tb-full'); ref.full = null; }
      while (ref.box.firstChild) lt.ref.box.appendChild(ref.box.firstChild);
      root.removeChild(t);
      root.removeChild(ref.box);
      delete toolEls[id];
      lt.count++;
      if (isError) lt.ref.row.className = 'tool err';
      var cnt = lt.ref.row.querySelector('.t-count');
      if (cnt) cnt.textContent = ' ×' + lt.count;
      else { var nm = lt.ref.row.querySelector('.t-name'); if (nm) nm.appendChild(el('span', 't-count', ' ×' + lt.count)); }
    } else {
      lastToolGroup = { name: name, ref: ref, count: 1 };
    }
    scroll();
  }
  // toast 跨重渲存续（用户实测「切页签回来压缩提示没了」2026-09-20）：notice 是一次性 DOM，
  // 本页签 core 后续任何 uiState 重渲都会冲掉它。持久事实源是折叠块（jsonl compaction 条目，
  // 恢复时从数据重建，在最顶部）；本层只是让瞬时 toast 也活过重渲——按存档重挂，发新消息即清
  var lastNotice = '';
  var seenCompactions = -1; // 折叠块计数基线：-1=未立基线（首渲不跳顶），增大=新压缩
  var compactBarShownAt = -1; // 已弹过条的压缩计数（防同轮重渲重弹；dismiss 后置 = seenCompactions）
  function notice(text) { if (/扩展已加载/.test(text)) return; var last = root.lastElementChild; if (last && last.classList && last.classList.contains('notice') && last.textContent === text) return; var n = el('div', 'notice', text); linkify(n); root.appendChild(n); lastNotice = text; scroll(); }
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
    root.innerHTML = '';
    liveReset();
    toolEls = {};
    lastToolGroup = null; // 重绘后 DOM 全换，旧组引用作废（相邻判定本身也兕底，这里显式清）
    if (!list || !list.length) {
      if (welcomeHTML) { root.innerHTML = welcomeHTML; pickTip(root.querySelector('#welcome')); }
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
    function toolGroupRun(name, run, mi) {
      var allOk = true;
      var lines = [];
      for (var gi = 0; gi < run.length; gi++) {
        var g = run[gi];
        var gd = historyDetail(g.arguments);
        var gr = (g.id && results[g.id]) || null;
        if (gr) { gr.used = true; }
        else { for (var gp = 0; gp < resultList.length; gp++) { if (!resultList[gp].used) { gr = resultList[gp]; resultList[gp].used = true; break; } } }
        if (gr && gr.isError) allOk = false;
        var out1 = gr && gr.text ? String(gr.text).replace(/\s+/g, ' ').slice(0, 80) : '';
        lines.push({ d: gd, out: out1, err: gr ? gr.isError : false });
      }
      var t = el('div', 'tool ' + (allOk ? 'ok' : 'err'));
      t.appendChild(el('span', 't-dot'));
      t.appendChild(el('span', 't-name', name));
      var det0 = lines[0] && lines[0].d ? '  ' + lines[0].d : '';
      var dsum = el('span', 't-detail', '\u00d7' + run.length + det0);
      dsum.title = lines.map(function(l) { return (l.d || L.noArgs) + (l.out ? '  → ' + l.out : ''); }).join('\n');
      t.appendChild(dsum); linkify(dsum);
      var arrA = el('span', 't-arrow'); arrA.innerHTML = ico('chev', 12); t.appendChild(arrA);

      var box = el('div', 'tool-box');
      for (var li = 0; li < lines.length; li++) {
        var row = el('div', 'tb-row');
        var tag = el('span', 'tb-tag'); tag.innerHTML = ico(lines[li].err ? 'x' : 'check', 11);

        tag.style.color = lines[li].err ? '#f66' : '#4ec96e';
        row.appendChild(tag);
        row.appendChild(el('span', 'tb-val', (lines[li].d || L.noArgs) + (lines[li].out ? ('  → ' + lines[li].out) : '')));
        box.appendChild(row);
      }
      box.style.display = 'none';
      t.addEventListener('click', function () {
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
        t.classList.toggle('open');
      });
      root.appendChild(t);
      root.appendChild(box);
    }
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
        addUser(ut, m.attachments ? m.attachments.length : 0, ui, ufiles);
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
              var run = [c];
              while (j + 1 < m.content.length && m.content[j+1] && m.content[j+1].type === 'toolCall' && m.content[j+1].name === c.name) { run.push(m.content[++j]); }
              if (run.length === 1) {
                var hid = c.id || ('h' + i + '_' + j);
                var det = historyDetail(c.arguments);
                toolStart(hid, c.name, det, true);
                var res = (c.id && results[c.id]) || null;
                if (!res) { for (var rp = 0; rp < resultList.length; rp++) { if (!resultList[rp].used) { res = resultList[rp]; break; } } }
                if (res) { res.used = true; toolEnd(hid, c.name, res.isError, res.text, det); }
                // 子 agent 历史重绘不建浮窗/卡片（用户拍板：消息流只留工具行，浮窗只属 LIVE）——
                // 否则恢复会话时旧 run 的 final 快照会凭空弹出浮窗；历史看工具行 OUT 文本即可
              } else {
                toolGroupRun(c.name, run, i);
              }
            }
          }
        } else { renderRich(b, textOf(m.content)); }
        flushB();
        if (m.stopReason === 'error' && m.errorMessage) {
          var eb = el('div', 'bubble assistant errmsg');
          eb.textContent = '✘ ' + String(m.errorMessage).slice(0, 300);
          var rb = el('span', 'errmsg-retry', L.retryEdit);
          rb.addEventListener('click', function () { vpost({ type: 'retryFromLast' }); });
          eb.appendChild(document.createElement('br'));
          eb.appendChild(rb);
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
    if (mm) return mm[2] + '-' + mm[3] + ' ' + mm[4] + ':' + mm[5];
    return s.split(/[\\/]/).pop() || L.ephemeralSession;
  }
  function applyState(m) {
    // 工单24 二期：页脚（模型/思考/用量）随页签视图走，后台直接渲进隐藏视图；
    // 页头会话标题是页面级（只显示活动页签），后台跳过
    // ⏱ 本轮耗时刚由 setBusy(false, elapsedMs) 写入，不能被这里的临时状态清理冲掉
    //（settle 时序：busy:false → ⏱ 上屏 → refreshState 的 state 消息紧随其后到达）
    // 压缩中不清：压缩标签是持续状态，applyState 的高频刷新（refreshState）不冲掉它
    if (!compacting && statusEl.textContent.indexOf('⏱') !== 0) setStatus(''); // pi 已就绪，清掉「正在启动 pi…」之类的临时状态
    // 模型名包进 .chip-label，底栏限宽时省略号截断，全名靠 title（下一行）
    modelEl.innerHTML = ico('cpu') + ' <span class="chip-label">' + esc(m.model ? (m.model.name || m.model.id) : '—') + '</span>';
    modelEl.title = m.model ? L.modelTitleCur.replace('{v}', (m.model.provider || '') + '/' + (m.model.id || '')) : L.switchModel;
    thinkEl.textContent = L.thinkLabel + (m.thinkingLevel !== null && m.thinkingLevel !== undefined ? m.thinkingLevel : '—');
    if (id === activeTabId) {
    var sessName = fmtSession(m.sessionFile, m.sessionName);
    sessionEl.textContent = L.sessionLabel + sessName;
    sessionEl.title = m.sessionFile ? (L.curSession + m.sessionFile + '\n' + L.clickSwitchSession) : L.clickPickSession;
    }

    if (m.stats) {
      var parts = [];
      if (m.stats.contextPercent !== null && m.stats.contextPercent !== undefined) parts.push(L.ctx + (Math.round(m.stats.contextPercent * 10) / 10) + '%');
      if (m.stats.cost) parts.push('$' + Number(m.stats.cost).toFixed(2));
      usageEl.textContent = parts.join(' · ');
      usageEl.title = parts.join(' · ');
    } else { usageEl.textContent = ''; }
  }

  function handleFiles(files, dt) {
    var textDone = false;
    var fileCount = 0;
    // VS Code 资源管理器拖入：File 对象无 MIME 无 path，但 dataTransfer 带资源 URI
    var uris = null;
    if (dt) {
      var raw = dt.getData('resourceurls') || dt.getData('text/uri-list') || '';
      var list = String(raw || '').split(/\s+/).filter(function (u) { return /^file:/i.test(u); });
      if (list.length) uris = list;
    }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      // 图片判定：f.type 不可靠——从 VS Code 资源管理器拖入的 File 没有 MIME（type 为空），
      // 只看 type 会把图片误判成普通文件；用扩展名兑底
      var isImg = f.type.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '');
      if (!isImg) {
        // 数量不设限（用户裁决 2026-09-11「不限制」；路径模式只传字符串，个数不影响开销）
        // 路径模式：只传路径，不读内容，不限大小。三级兑底：
        // ① Electron 暴露的 f.path（部分版本 OS 拖入可用）
        var p = (f as any).path;
        if (p) {
          (function(file, filePath) {
            if (hasFile(filePath, file.name)) return; // 重复拖入同一文件：无感跳过
            pendingFiles.push({ name: file.name || 'file', path: filePath });
            renderAttach();
          })(f, p);
          continue;
        }
        // ② 资源 URI（VS Code 资源管理器拖入）→ 宿主转 fsPath 后回发 addFiles
        if (uris && uris.length) {
          vpost({ type: 'attachUri', uris: uris });
          uris = null; // 一拖多文件只发一次，URI 已覆盖整个 drop
          continue;
        }
        // ③ 字节通道：OS 拖入拿不到任何路径 → 读 base64 交宿主落临时文件（20MB 上限防 webview 卡死）
        if (f.size > 20 * 1024 * 1024) { notice(L.attachTooBig + (f.name || '')); continue; }
        (function(file) {
          var r = new FileReader();
          r.onload = function() {
            var data = String(r.result || '').split(',')[1] || '';
            if (!data) { notice('ⓐ ' + L.dragNoPath); return; }
            vpost({ type: 'attachFile', name: file.name || 'file', data: data });
          };
          r.readAsDataURL(file);
        })(f);
        continue;
      }
      // 图片数量同样不设限（同上裁决）
      (function(file) {
        var r = new FileReader();
        r.onload = function() {
          let url = String(r.result);
          var data = url.split(',')[1] || '';
          if (!data) return;
          var probe = new Image();
          probe.onerror = function() { notice('ⓐ ' + L.imgReadFail + (file.name || '') + L.imgReadFailSuf.replace('{v}', file.type || L.unknown)); };
          if (!file.type) { url = 'data:image/png;base64,' + data; }
          probe.onload = function() {
            // 尺寸过小的图片模型端会报 400（图片输入格式/解析错误），直接拦下
            if (probe.naturalWidth < 16 || probe.naturalHeight < 16) { notice('ⓐ ' + L.imgTooSmall.replace('{w}', probe.naturalWidth).replace('{h}', probe.naturalHeight)); return; }
            if (hasImg(data)) return; // 重复图片：无感跳过
            pendingImages.push({ data: data, mimeType: file.type || 'image/png', name: file.name || 'image.png', w: probe.naturalWidth, h: probe.naturalHeight });
            renderAttach();
          };
          probe.src = url;
        };
        r.readAsDataURL(file);
      })(f);
    }
  }
  function renderAttach() {
    attachbarEl.innerHTML = '';
    for (var i = 0; i < pendingImages.length; i++) {
      (function(idx) {
        var p = pendingImages[idx];
        var chip = el('span', 'chip-img');
        var img = document.createElement('img');
        img.src = 'data:' + p.mimeType + ';base64,' + p.data;
        var name = p.name + (p.w ? ' ' + p.w + '\u00d7' + p.h : '');
        chip.title = name;
        chip.appendChild(img);
        // JS 截短（保头保尾）+ .chip-label 兑底 ellipsis；全名看 title
        chip.appendChild(el('span', 'chip-label', shorten(name, 22)));
        var x = el('span', 'chip-x', '\u00d7');
        x.addEventListener('click', function() { pendingImages.splice(idx, 1); renderAttach(); });
        chip.appendChild(x);
        attachbarEl.appendChild(chip);
      })(i);
    }
    for (var j = 0; j < pendingFiles.length; j++) {
      (function(idx) {
        var p = pendingFiles[idx];
        var chip = el('span', 'chip-file');
        // JS 截短文件名；路径提示也走 .chip-label（可收缩），别把 × 挤出可视区
        chip.innerHTML = ico('filecode', 12) + ' <span class="chip-label">' + esc(shorten(p.name, 18)) + '</span>';
        if (p.path) {
          chip.title = p.path;
          var base = p.path.split(/[\\/]/).pop() || p.path;
          var pathHint = el('span', 'chip-label hint', ' · ' + esc(shorten(base, 16)));
          chip.appendChild(pathHint);
        }
        var x = el('span', 'chip-x', '\u00d7');
        x.addEventListener('click', function() { pendingFiles.splice(idx, 1); renderAttach(); });
        chip.appendChild(x);
        attachbarEl.appendChild(chip);
      })(j);
    }
    attachbarEl.style.display = (pendingImages.length + pendingFiles.length) ? 'flex' : 'none';
  }
  function hideSuggest() { suggestEl.style.display = 'none'; slashMenuOn = false; }
  function updateSuggest() {
    var t = input.value;
    var m = t.match(/(^|\s)([\/@])([^\s]*)$/);
    if (!m) { hideSuggest(); return; }
    var trigger = m[2], q = m[3];
    if (trigger === '/') {
      sgKind = 'slash';
      // 每次打开菜单都向宿主要新列表（缓存先渲染，新列表到了再刷新）：包变更自动检测
      // 挂在宿主的 getSlash 处理里，若只在 slashCmds===null 时请求，getSlash 一辈子只发
      // 一次，新装/卸载的技能永远进不了菜单（2026-09-18 实测：卸载后 probe 仍显示）
      if (!slashMenuOn) { slashMenuOn = true; vpost({ type: 'getSlash' }); }
      if (slashCmds === null) { hideSuggest(); return; }
      var ql = q.toLowerCase();
      var list = slashCmds.filter(function(c) { return ((c.label || c.name || '') + ' ' + (c.description || '')).toLowerCase().indexOf(ql) !== -1; });
      var rows = []; var lastGroup = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].group && list[i].group !== lastGroup) { lastGroup = list[i].group; rows.push({ header: true, label: list[i].group }); }
        rows.push({ label: list[i].label || ('/' + (list[i].name || '')), detail: list[i].description || '', item: list[i] });
      }
      renderSuggest(rows.slice(0, 80));
    } else {
      sgKind = 'files';
      if (workspaceFiles === null) { vpost({ type: 'getFiles' }); hideSuggest(); return; }
      var ql2 = q.toLowerCase();
      var fl = workspaceFiles.filter(function(f) { return f.rel.toLowerCase().indexOf(ql2) !== -1; });
      renderSuggest(fl.slice(0, 50).map(function(f) { return { label: f.rel, detail: f.dir, item: f }; }));
    }
  }
  function renderSuggest(rows) {
    if (!rows.length) { hideSuggest(); return; }
    sgList = rows;
    sgSel = 0; while (sgSel < rows.length && rows[sgSel].header) sgSel++;
    if (sgSel >= rows.length) { hideSuggest(); return; }
    suggestEl.innerHTML = '';
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].header) { suggestEl.appendChild(el('div', 'sg-header', rows[i].label)); continue; }
      (function(idx) {
        var d = el('div', 'sg-item');
        d.appendChild(el('span', 'sg-label', rows[idx].label));
        if (rows[idx].detail) d.appendChild(el('span', 'sg-detail', rows[idx].detail));
        d.addEventListener('mousedown', function(e) { e.preventDefault(); applySuggest(rows[idx].item); });
        d.addEventListener('mouseenter', function() { sgSel = idx; paintSuggest(); });
        suggestEl.appendChild(d);
      })(i);
    }
    suggestEl.style.display = 'block';
    paintSuggest();
  }
  function nextSel(dir) {
    var n = sgSel;
    for (var step = 0; step < sgList.length; step++) {
      n += dir; if (n < 0) n = sgList.length - 1; if (n >= sgList.length) n = 0;
      if (!sgList[n].header) break;
    }
    sgSel = n;
  }
  function paintSuggest() {
    var items = suggestEl.children;
    for (var i = 0; i < items.length; i++) { if (!sgList[i] || !sgList[i].header) items[i].className = 'sg-item' + (i === sgSel ? ' active' : ''); }
    if (items[sgSel]) items[sgSel].scrollIntoView({ block: 'nearest' });
  }
  function applySuggest(item) {
    if (!item || item.header) return; // 防止选中分组标题出现 /undefined
    if (item.builtin === 'mentionFile') { var v = input.value.replace(/[\s/@]+$/, ''); input.value = (v ? v + ' ' : '') + '@'; hideSuggest(); input.focus(); updateSuggest(); return; }
    if (item.builtin) { input.value = input.value.replace(/(^|\s)[\/@][^\s]*$/, '$1'); hideSuggest(); vpost({ type: item.builtin }); return; }
    var t = input.value;
    var m = t.match(/(^|\s)([\/@])([^\s]*)$/);
    var label = sgKind === 'slash' ? ('/' + item.name) : (m && m[2] === '@' ? '@' : '') + item.rel;
    if (m) t = t.slice(0, t.length - m[0].length) + m[1] + label + ' ';
    input.value = t;
    hideSuggest();
    input.focus();
  }
  function send() {
    var t = input.value.trim();
    if (!t && !pendingImages.length && !pendingFiles.length) return;
    var imgs = pendingImages.map(function(p) { return { data: p.data, mimeType: p.mimeType }; });
    var fs2 = pendingFiles.map(function(p) { return { name: p.name, text: p.text || undefined, path: p.path || undefined }; });
    var attachCode = codeCtx && codeOn;
    input.value = '';
    autoSize();
    pendingImages = []; pendingFiles = []; renderAttach();
    lastNotice = ''; // 新回合开始：瞬时反馈（含压缩完成）不再跨回合存活，与 pi TUI 状态行语义一致
    vpost({ type: 'prompt', text: t || (imgs.length ? L.seeImage : (fs2.length ? L.seeFiles : (attachCode ? L.seeCode : ''))), images: imgs, files: fs2, attachCode: !!attachCode });
  }
  // 自适应高度：随内容增长，到 220px 上限后改为内部滚动（消息区不会被挤没）
  function autoSize() {
    input.style.height = 'auto';
    var over = input.scrollHeight > 220;
    input.style.overflowY = over ? 'auto' : 'hidden';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }
  function inputKeydown(e: KeyboardEvent) {
    var sgOpen = suggestEl.style.display === 'block';
    if (sgOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); nextSel(1); paintSuggest(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); nextSel(-1); paintSuggest(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); var r0 = sgList[sgSel]; if (r0) applySuggest(r0.item); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && !sgOpen && !e.isComposing) { vpost({ type: 'abort' }); }
    // isComposing 守门：中文输入法取消候选词也是 Esc，不拦的话打字打到一半就把运行中的任务中断了
    // （2026-09-18 事故：用户没点停止却见“已中断当前任务”）
  }
  function filesFromClipboard(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) out.push(f); }
    }
    return out;
  }
  function inputPaste(e: ClipboardEvent) {
    var files = filesFromClipboard((e.clipboardData || {}).items || []);
    if (files.length) { e.preventDefault(); handleFiles(files, null); }
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
    if (renderPending) { var list = renderPending; renderPending = null; renderAll(list); }
    if (liveSyncPending) { var msg2 = liveSyncPending; liveSyncPending = null; applyLiveSync(msg2); }
    drainPendingStream();
  }
  function applyLiveSync(msg: SessionMessage) {
    finalizeLive(); liveReset();
    liveMsg = { content: [] };
    var parts = ((msg && msg.content) || []) as any[];
    for (var li = 0; li < parts.length; li++) {
      var pc = parts[li];
      if (pc && pc.type === 'thinking') {
        var tp2 = liveBlock(li, 'thinking');
        tp2.buf = pc.thinking || ''; tp2.doneLen = tp2.buf.length;
        tp2.body.textContent = tp2.buf;
      } else if (pc && pc.type === 'text') {
        var xp2 = liveBlock(li, 'text');
        xp2.buf = pc.text || ''; xp2.doneLen = xp2.buf.length;
        appendFinal(xp2, xp2.buf);
      } else if (pc && pc.type === 'toolCall') {
        var cp2 = liveBlock(li, 'toolCall', pc.name);
        cp2.raw = JSON.stringify(pc.arguments ?? null) || '';
        cp2._len = cp2.raw.length;
        cp2.box.textContent = cp2.raw.slice(-20000);
      }
    }
    scroll();
  }
  function handleMsg(m: HostToWebviewTagged) {
    // 工单24：重绘在途（延后一拍）时流式事件先排队，等重绘落地再按原序补（见 pendingStream 注释）
    if (renderTimer !== null && deferDuringRender(m.type)) { pendingStream.push(m); return; }
    if (m.type === 'user') addUser(m.text, m.imageCount, m.codeInfo, m.fileCount);
    else if (m.type === 'newLive') { finalizeLive(); liveReset(); }
    else if (m.type === 'delta') appendDelta(m.text, m.ci);
    else if (m.type === 'thinking') appendThink(m.text, m.ci);
    else if (m.type === 'toolStart') {
      finalizeLive();
      var olds = root.querySelectorAll('.prow'); for (var oi = 0; oi < olds.length; oi++) olds[oi].parentNode.removeChild(olds[oi]);
      // 空占位 bubble 一并移除（2026-09-20 用户实测两案同根因）：纯工具调用回合里 liveEnsure 会
      // 为每次 toolCallStart 建一个 assistant bubble（liveDiv），toolStart 时 prow 清了但空壳
      // bubble 留在 root——插在上一工具盒与下一工具行之间，既穿帮（截图空圆角色条）又破坏
      // 成组的 DOM 相邻判定（表现为「会话结束才合并」——settled 后 renderAll 重建成组）
      if (liveDiv && !liveDiv.textContent && !liveDiv.querySelector('img')) liveDiv.parentNode.removeChild(liveDiv);
      liveReset(); toolStart(m.id, m.name, m.detail);
    }
    else if (m.type === 'toolCallStart') {
      var tp = liveBlock(m.ci, 'toolCall', m.name);
      tp._len = 0; tp.raw = '';
      liveMsg.content[m.ci] = tp; scroll();
    }
    else if (m.type === 'toolCallDelta') { var tb = liveMsg && liveMsg.content[m.ci]; if (tb) { tb._len += (m.chunk || '').length; tb.raw += m.chunk || ''; if (pdet) pdet.textContent = L.genArgs.replace('{n}', tb._len); if (tb.box && tb.box.style.display === 'block') tb.box.textContent = tb.raw.slice(-20000); } }
    else if (m.type === 'toolEnd') toolEnd(m.id, m.name, m.isError, m.text, m.detail);
    // subagentUpdate/subagentDetail 已在 window message 入口截获（页签过滤前），不进 handleMsg
    else if (m.type === 'uiState') {
      // 工单24：按 tabId 各归各的树（路由器已换镜），不再拒非活动快照——后台页签的树也要建/重建
      // （webview 重载后全量重建、压缩/换会话真相推送都走这里）。每页签一棵 DOM 后
      // 「慢到的旧页签快照覆盖新页签内容」这类竞态整类消失：快照只覆盖它自己的树
      built = true;
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
    }
    else if (m.type === 'busy') setBusy(m.value, m.elapsedMs);
    else if (m.type === 'render') { built = true; renderPending = m.messages; scheduleRender(); } // 延后一拍：让刚到的用户气泡先上屏，再慢慢重绘全页
    else if (m.type === 'liveSync') { liveSyncPending = m.message; scheduleRender(); } // 刀5b：续接重定基，排在 render 之后同一拍执行（顺序由 flushRender 保证）
    else if (m.type === 'queue') {
      queueN = (m.steering ? m.steering.length : 0) + (m.followUp ? m.followUp.length : 0); renderStatus();
      nativeQueuePills = [];
      if (m.followUp) for (var fi = 0; fi < m.followUp.length; fi++) {
        var fm2 = String(m.followUp[fi] || '').match(/^\[子 agent (\S+) (完成|失败)\] ([^:\n]*): ?/);
        if (fm2) nativeQueuePills.push(fm2);
      }
      renderNativeQueue();
    }
    else if (m.type === 'notice') notice(m.text);
    else if (m.type === 'fillInput') { followingEnd = true; input.value = m.text || ''; input.focus(); scroll(); } // 主动动作回底（工单十七要点 3）
    else if (m.type === 'status') setStatus(m.text);
    else if (m.type === 'compacting') setCompacting(m.value);
    else if (m.type === 'mode') { modeText = m.text || ''; renderStatus(); }
    else if (m.type === 'queuedAdd') addQueued(m);
    else if (m.type === 'queuedDelivered') { removeQueued(m.qid); if (m.show) addUser(m.text, m.imageCount, m.codeInfo); }
    else if (m.type === 'queuedClear') { queuedItems = []; queuebarEl.innerHTML = ''; }
    else if (m.type === 'queuedRemove') removeQueued(m.qid); // 工单十八补刀：乐观入队失败回滚单条
    else if (m.type === 'queuedRetrieved') {
      // 工单十六：取回文本合入编辑框——已有内容时换行追加，不覆盖正在输入的内容
      removeQueued(m.qid);
      input.value = input.value ? input.value + '\n\n' + (m.text || '') : (m.text || '');
      followingEnd = true; // 取回排队消息=主动动作回底（工单十七验收条，同 fillInput 口径）
      input.focus(); scroll();
    }
    else if (m.type === 'codeCtx') { codeCtx = m.ctx; renderCodeChipAll(); }
    else if (m.type === 'addImages') { (function() {
      var list = m.images || []; var k = 0;
      function nextAdi() {
        if (k >= list.length || pendingImages.length >= 4) { renderAttach(); return; }
        var p = list[k++]; if (!p.mimeType) p.mimeType = 'image/png';
        var probe = new Image();
        probe.onload = function() {
          if (probe.naturalWidth < 16 || probe.naturalHeight < 16) { notice('ⓐ ' + L.imgTooSmall2.replace('{w}', probe.naturalWidth).replace('{h}', probe.naturalHeight).replace('{v}', p.name || '')); nextAdi(); return; }
          p.w = probe.naturalWidth; p.h = probe.naturalHeight;
          if (!hasImg(p.data)) pendingImages.push(p); // 宿主转发同样去重（复制图片等入口）
          nextAdi();
        };
        probe.onerror = function() { notice('ⓐ ' + L.imgReadFail + (p.name || '')); nextAdi(); };
        probe.src = 'data:' + p.mimeType + ';base64,' + p.data;
      }
      nextAdi();
    })(); }
    else if (m.type === 'addFiles') { pendingFiles = pendingFiles.concat((m.files || []).filter(function (f) { return !hasFile(f.path, f.name); })); renderAttach(); }
    else if (m.type === 'slashList') { slashCmds = m.commands || []; updateSuggest(); }
    else if (m.type === 'fileList') { workspaceFiles = m.files || []; updateSuggest(); }
    else if (m.type === 'state') applyState(m);
    else if (m.type === 'banner') { banner = m.banner; renderBanner(m.banner); }
    else if (m.type === 'changesList') { changes = m.files; renderChanges(m.files); }
    else if (m.type === 'theme') { document.body.setAttribute('data-theme', m.name || 'auto'); }
    else if (m.type === 'tabs') handleTabs(m);
  }
    // 滚动跟随监听随根走（工单十七）：用户滚动才判定（suppressScroll 跳过程序化拉底）
    root.addEventListener('scroll', function () {
      if (suppressScroll) { suppressScroll = false; return; }
      followingEnd = root.scrollHeight - root.scrollTop - root.clientHeight <= 48;
    }, { passive: true });
    bindViewEvents(); // 建视图即绑事件 + 注图标（原 makeView 职责，三期壳胶水——漏掉即全控件死，事故见 BUILDER.md 交接 5）
    return {
      handleMsg: handleMsg, renderCodeChip: renderCodeChip, handleFiles: handleFiles,
      refreshBusy: renderBusyUi, // 白 Working 兑底：切回页签按本页签真相重渲状态行（激活时调）
      show: function (on: boolean) { view.classList.toggle('offview', !on); },
      isFollowing: function () { return followingEnd; },
      forceScrollToBottom: function () { suppressScroll = true; root.scrollTop = root.scrollHeight; },
      isBuilt: function () { return built; },
      dispose: function () {
        if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
        if (liveRTimer) { clearTimeout(liveRTimer); liveRTimer = null; }
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        if (view.parentNode) view.parentNode.removeChild(view);
      }
    };
  }

  var views: Record<string, ReturnType<typeof makeSessionView>> = {};
  function viewFor(tid: string) { return views[tid] || (views[tid] = makeSessionView(tid)); }
  /** codeCtx 是页面级数据：变更时循环各视图重渲 chip（三期⑥） */
  function renderCodeChipAll() { for (var vid in views) views[vid].renderCodeChip(); }
  /** 消息路由（三期）：后台只挡焦点类，其余各归各的视图——串写结构上不可能 */
  function routeMsg(m: HostToWebviewTagged) {
    var tid = m.tabId !== undefined ? m.tabId : activeTabId;
    if (tid === null || tid === undefined) return;
    if (activeTabId === null) { activeTabId = tid; tabId = tid; }
    if (tid !== activeTabId && m.type === 'fillInput') return; // 后台页签只挡焦点类（回填+focus）
    viewFor(tid).handleMsg(m);
  }
  var activeTabId: string | null = null;
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
  var FILE_RE = /([A-Za-z]:[\/][\w.\- \u4e00-\u9fff\/]*[\w.\-\u4e00-\u9fff]\.[A-Za-z0-9]{1,8}(?:\:\d{1,5})?|[\w.\-]+(?:[\/][\w.\- \u4e00-\u9fff]+)+\.[A-Za-z0-9]{1,8}(?:\:\d{1,5})?|[\w\u4e00-\u9fff][\w\-]*\.(?:ts|tsx|js|jsx|mjs|json|md|txt|html?|css|scss|less|py|java|c|cpp|h|hpp|go|rs|rb|php|sh|bat|ps1|ya?ml|toml|xml|svg|vue|sql|ini|conf|log|png|jpe?g|gif|webp|bmp|ico|avif|pdf)(?::\d{1,5})?)/g; // 第三支：光文件名（常见扩展名白名单）也可点，存在性由宿主 openFilePath 校验
  function cleanPath(p) {
    p = p.replace(/[.,;:!?)}\]⟩】»]+$/, '');
    var parts = p.split(' ');
    while (parts.length > 1 && parts[parts.length - 1].indexOf('/') === -1 && parts[parts.length - 1].indexOf('\\') === -1) parts.pop();
    return parts.join(' ');
  }
  var linkifyEnabled = true; // renderAll 批量重绘时关掉老消息的 linkify，只留最近几条（全量扫正则是大会话卡顿的主因）
  function linkify(root: HTMLElement | null) {
    if (!root || !linkifyEnabled) return;
    var nodes = [];
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) { var n = w.currentNode as HTMLElement; var par = n.parentNode as HTMLElement; if (par.nodeName !== 'PRE' && par.classList && !par.classList.contains('fp')) nodes.push(n); }
    for (var i = 0; i < nodes.length; i++) {
      var n2 = nodes[i]; var txt = n2.nodeValue; if (!txt) continue;
      FILE_RE.lastIndex = 0; if (!FILE_RE.test(txt)) continue;
      FILE_RE.lastIndex = 0;
      var frag = document.createDocumentFragment(); var last = 0, m2;
      while ((m2 = FILE_RE.exec(txt)) !== null) {
        if (m2.index > 0 && txt.charAt(m2.index - 1) === '/') { continue; } // URL 的一部分，不当作路径
        if (m2[0].indexOf('://') !== -1) { continue; } // URL 协议头（如 https://）被盘符分支误认，跳过
        if (/\.(?:vsix|zip|exe|dll|jar|7z|tar|gz|rar|bin|iso|pyc|woff2?|ttf|eot)$/i.test(m2[0])) { continue; } // 二进制文件不做成链接，点了也是报错页
        var p = cleanPath(m2[0]);
        if (m2.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m2.index)));
        if (p) { var sp = document.createElement('span'); sp.className = 'fp'; sp.textContent = p; sp.setAttribute('data-p', p); frag.appendChild(sp); }
        else frag.appendChild(document.createTextNode(m2[0]));
        last = m2.index + m2[0].length;
      }
      if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
      n2.parentNode!.replaceChild(frag, n2);
    }
  }
  // 点击 .fp → openPath 给宿主打开（捕获阶段，防止触发工具行折叠）
  // 点击 .fp → openPath 给宿主打开（捕获阶段，防止触发工具行折叠）；
  // 工单24 二期：委托到 #session-area（消息流在各页签视图内，都是它的子孙）
  sessionArea.addEventListener('click', function (e) {
    var t = e.target as HTMLElement | null;
    while (t && t !== sessionArea) {
      if (t.classList && t.classList.contains('fp')) {
        e.stopPropagation(); vscode.postMessage({ type: 'openPath', path: t.getAttribute('data-p') });
        return;
      }
      t = t.parentNode as HTMLElement | null;
    }
  }, true);

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
  // ── 子 agent 监控：浮窗（codex 风格）——概览列表 + 点击下钻（工单 A，对齐 Codex 交互）──
  // 概览 = 已开启/完成 分组行（每任务一行：状态图标/名称/处理中/相对时间），点击行下钻
  // 完整活动流 + markdown 产出（subagentDetailRequest → 宿主留存的全量 details）。
  // 数据模型：每页签 runs（id → {snap, final, startAt, endAt}），id 是 toolCallId 或异步句柄
  // sa-n；一个 parallel 运行拆多行（每任务一行，Codex 同款）
  var SM_ICONS: Record<string, string> = { running: ico('loading', 12), done: ico('check', 12), failed: ico('x', 12) };
  // 浮窗：单例。收起（subCollapsed）= 整块隐藏、头部 spinner 亮（运行中），codex 模型；
  // 拖过一次（dockDragged）后位置归用户，未拖则每次刷新回默认右上角（防漂移事故）
  var subdock: HTMLElement | null = null;
  var subCollapsed = false;
  var dockDragged = false;
  function dockSetCollapsed(c: boolean) {
    subCollapsed = c;
    if (activeTabId !== null) subCollapsedByTab[activeTabId] = c; // 收起偏好按页签记忆，切回不串台
    if (subdock) subdock.classList.toggle('hidden', c);
    updateSubInd();
  }
  /** 头部 loading 图标：浮窗的锚点——首次有子 agent 后常驻（用户拍板：图标不消失）；
   *  运行中旋转，全部停止停转但不隐藏，点它展开/收起浮窗 */
  var subRunning = false;
  function updateSubInd() {
    // 图标跟页签走：只有活动页签有子 agent 数据时才显示（缓存判空，全局单例不串台）
    var show = !!subdock && activeTabId !== null && !!subRunsOf(activeTabId) && Object.keys(subRunsOf(activeTabId)!).length > 0;
    subindEl.style.display = show ? 'inline-flex' : 'none';
    subindEl.classList.toggle('spin', subRunning);
    subindEl.title = subCollapsed ? L.smReopen : L.smCollapse;
  }
  function dockResetPos(d: HTMLElement) {
    if (dockDragged) return;
    d.style.top = '48px'; d.style.right = '12px'; d.style.left = 'auto'; d.style.bottom = 'auto';
  }
  function dockEnsure(): HTMLElement {
    if (subdock) return subdock;
    var d = el('div', 'subdock hidden'); // 先隐后显：首帧从图标处缩放切出，不闪现
    dockResetPos(d);
    var head = el('div', 'sd-head');
    var body = el('div', 'sd-body');
    d.appendChild(head); d.appendChild(body);
    // 拖动：按住头部移动（fixed 定位，offsetLeft/Top 即视口坐标）；位移超阈值才算拖，
    // 否则 mouseup 视为点击 → 收起面板（拖动与点击分离，误晃不吞点击）
    var dragMoved = false;
    head.addEventListener('mousedown', function (e: MouseEvent) {
      if ((e.target as HTMLElement).classList.contains('sd-btn')) return;
      dragMoved = false;
      var sx = e.clientX, sy = e.clientY, ol = d.offsetLeft, ot = d.offsetTop;
      var mv = function (ev: MouseEvent) {
        if (!dragMoved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) <= 3) return;
        dragMoved = true;
        dockDragged = true;
        d.style.left = Math.max(4, ol + ev.clientX - sx) + 'px';
        d.style.top = Math.max(4, ot + ev.clientY - sy) + 'px';
        d.style.right = 'auto'; d.style.bottom = 'auto';
      };
      var up = function () { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      e.preventDefault();
    });
    head.addEventListener('click', function (e) {
      var tg = e.target as HTMLElement;
      if (tg && tg.closest && tg.closest('.sd-btn')) return; // 按钮自处理，别把点击吞成收起
      if (!dragMoved) dockSetCollapsed(true);
    });
    document.body.appendChild(d);
    subdock = d;
    return d;
  }
  /** ── 概览 + 下钻渲染（工单 A，Codex 同款交互）──────────────────── */
  interface SubRunRec { snap: SubagentSnapshot; final: boolean; startAt?: number; endAt?: number }
  var subRunsByTab: Record<string, Record<string, SubRunRec>> = {};
  var subDetailCache: Record<string, SubagentSnapshot> = {}; // runId → Full 快照（下钻用，宿主留存的全量）
  var subDetailView: string | null = null; // "runId:taskIndex"；null=概览

  function subRunsOf(tab: string | null): Record<string, SubRunRec> | null {
    if (tab === null) return null;
    return subRunsByTab[tab] || null;
  }
  function anySubRunning(runs: Record<string, SubRunRec>): boolean {
    for (var k in runs) {
      var tasks = runs[k].snap.tasks;
      for (var i = 0; i < tasks.length; i++) if (tasks[i].status === 'running') return true;
    }
    return false;
  }
  function fmtElapsed(ms: number): string {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + (s % 60 < 10 ? '0' : '') + (s % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h' + (m % 60 < 10 ? '0' : '') + (m % 60) + 'm';
  }
  function fmtRel(ts: number): string {
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return L.smJustNow;
    var m = Math.floor(s / 60);
    if (m < 60) return L.smMinAgo.replace('{n}', String(m));
    var h = Math.floor(m / 60);
    if (h < 24) return L.smHourAgo.replace('{n}', String(h));
    return L.smDayAgo.replace('{n}', String(Math.floor(h / 24)));
  }
  /** 录入/更新一条运行记录（页签维度；id 同 subagentUpdate.id） */
  function updateSubRun(tab: string | null, id: string, snap: SubagentSnapshot, final: boolean, startAt?: number, endAt?: number) {
    if (tab === null || !id) return;
    var runs = subRunsByTab[tab] || (subRunsByTab[tab] = {});
    var rec = runs[id] || (runs[id] = { snap: snap, final: final });
    rec.snap = snap; rec.final = final;
    if (startAt !== undefined) rec.startAt = startAt;
    if (endAt !== undefined) rec.endAt = endAt;
  }
  function openSubDetail(runId: string, ti: number) {
    subDetailView = runId + ':' + ti;
    if (!subDetailCache[runId]) vscode.postMessage({ type: 'subagentDetailRequest', id: runId });
    renderSubDock();
  }
  function renderSubDock() {
    var d = dockEnsure();
    if (!subCollapsed) dockResetPos(d); // 用户没主动拖过就回默认位，防历史漂移
    if (subCollapsed) d.classList.add('hidden');
    else requestAnimationFrame(function () { d.classList.remove('hidden'); }); // 触发从图标处缩放切出
    var runs = subRunsOf(activeTabId);
    if (!runs) { updateSubInd(); return; }
    subRunning = anySubRunning(runs);
    var head = d.firstElementChild as HTMLElement;
    var body = d.lastElementChild as HTMLElement;
    head.innerHTML = '';
    if (subDetailView) {
      // 下钻模式：返回并进标题行（2026-09-18 用户反馈：单独一行浪费且突兀）；
      // 标题显示当前任务 agent 名（Codex 同款），Full 缓存未到时回退通用标题
      var dparts = subDetailView.split(':');
      var dfull = subDetailCache[dparts[0]];
      var dtask = dfull && dfull.tasks[Number(dparts[1]) || 0];
      var backB = el('span', 'sd-btn sm-back-head', '‹ ' + L.smBack);
      backB.addEventListener('mousedown', function (e) { e.stopPropagation(); }); // 拖拽/收起路径全断
      backB.addEventListener('click', function (e) { e.stopPropagation(); subDetailView = null; renderSubDock(); });
      head.appendChild(backB);
      head.appendChild(el('span', 'sm-title', dtask ? dtask.agent : L.smTitle));
    } else {
      head.appendChild(elIco('sm-ico' + (subRunning ? ' spin' : ''), ico(subRunning ? 'loading' : 'cpu', 13)));
      head.appendChild(el('span', 'sm-title', L.smTitle));
    }
    var minB = el('span', 'sd-btn', '—'); minB.title = L.smCollapse;
    minB.addEventListener('click', function (e) { e.stopPropagation(); dockSetCollapsed(true); });
    head.appendChild(minB);
    body.innerHTML = '';
    if (subDetailView) { body.classList.add('sm-detail'); renderSubDetail(body); } // sm-detail：css 放开 pre-wrap
    else { body.classList.remove('sm-detail'); renderSubOverview(body, runs); }
    linkify(body);
    updateSubInd();
  }
  function renderSubOverview(body: HTMLElement, runs: Record<string, SubRunRec>) {
    // 展平：每任务一行（parallel 拆多行，Codex 同款）；运行中在上、收尾在下
    var runningRows: any[] = []; var doneRows: any[] = [];
    for (var runId in runs) {
      var rec = runs[runId];
      for (var ti = 0; ti < rec.snap.tasks.length; ti++) {
        var t = rec.snap.tasks[ti];
        (t.status === 'running' ? runningRows : doneRows).push({ runId: runId, ti: ti, t: t, rec: rec });
      }
    }
    if (runningRows.length === 0 && doneRows.length === 0) {
      body.appendChild(el('div', 'sm-empty', L.smNoRuns));
      return;
    }
    var groups = [runningRows, doneRows];
    var titles = [L.smRunningGroup + ' · ' + runningRows.length, L.smDoneGroup + ' · ' + doneRows.length];
    for (var g = 0; g < 2; g++) {
      if (!groups[g].length) continue;
      body.appendChild(el('div', 'sm-group-title', titles[g]));
      for (var ri = 0; ri < groups[g].length; ri++) {
        var r = groups[g][ri];
        body.appendChild(renderSubRow(r));
      }
    }
  }
  function renderSubRow(row: any): HTMLElement {
    var t = row.t;
    var rowEl = el('div', 'sm-row ' + t.status);
    rowEl.appendChild(elIco('sm-ico' + (t.status === 'running' ? ' spin' : ''), SM_ICONS[t.status] || '·'));
    var main = el('div', 'sm-row-main');
    main.appendChild(el('div', 'sm-name', t.agent + (t.step ? ' #' + t.step : '')));
    // 第二行：状态 · 任务摘要（Codex 同款可区分度——全是 worker 时靠任务认行；摘要截 48 字）
    var stTxt = t.status === 'running' ? L.smProcessing : t.status === 'failed' ? L.smFailedSt : '';
    var taskSnip = (t.task || '').slice(0, 48);
    main.appendChild(el('div', 'sm-status' + (t.status === 'failed' ? ' fail' : ''), stTxt ? stTxt + ' · ' + taskSnip : taskSnip));
    rowEl.appendChild(main);
    // 右侧时间：运行中=已用时长（秒表每秒重绘概览），收尾=相对时间（Codex 同款）
    var time = t.status === 'running'
      ? (row.rec.startAt ? fmtElapsed(Date.now() - row.rec.startAt) : '')
      : (row.rec.endAt ? fmtRel(row.rec.endAt) : '');
    if (time) rowEl.appendChild(el('span', 'sm-time', time));
    rowEl.addEventListener('click', function () { openSubDetail(row.runId, row.ti); });
    return rowEl;
  }
  function renderSubDetail(body: HTMLElement) {
    var parts = (subDetailView || '').split(':');
    var runId = parts[0]; var ti = Number(parts[1]) || 0;
    var full = subDetailCache[runId];
    if (!full) {
      body.appendChild(el('div', 'sm-empty', L.smLoading));
      vscode.postMessage({ type: 'subagentDetailRequest', id: runId }); // 缓存被逐出/丢失时重取
      return;
    }
    var t = full.tasks[ti];
    if (!t) { body.appendChild(el('div', 'sm-empty', L.smNoRuns)); return; }
    var hd = el('div', 'sm-task ' + t.status);
    var line1 = el('div', 'sm-line');
    line1.appendChild(elIco('sm-ico' + (t.status === 'running' ? ' spin' : ''), SM_ICONS[t.status] || '·'));
    line1.appendChild(el('span', 'sm-agent', t.agent + (t.step ? ' #' + t.step : '')));
    if (t.usage) line1.appendChild(el('span', 'sm-usage', t.usage));
    hd.appendChild(line1);
    if (t.task) { var tk = el('div', 'sm-task-desc', t.task); tk.title = t.task; hd.appendChild(tk); }
    body.appendChild(hd);
    // 完整活动流（Full 快照，上限 400 条）
    for (var ai = 0; ai < t.items.length; ai++) {
      var isOut = t.items[ai].lastIndexOf('⮑ ', 0) === 0; // 工具输出行（FULL 口径 ⮑ 前缀）
      var act = el('div', 'sm-act' + (isOut ? ' out' : ''), t.items[ai]); act.title = t.items[ai];
      body.appendChild(act);
    }
    if (t.activityCount > t.items.length)
      body.appendChild(el('div', 'sm-more', L.smMore.replace('{n}', String(t.activityCount - t.items.length))));
    // 最终产出 markdown 全文渲染
    if (t.output) {
      var out = el('div', 'sm-out-md');
      renderRich(out, t.output);
      body.appendChild(out);
    }
  }
  // 秒表：运行中有概览时每秒重绘（用时列跳动）；下钻视图不重绘（丢滚动位置），
  // 用时在下钻头部静态展示。收起（hidden）时不绘
  setInterval(function () {
    if (!subdock || subdock.classList.contains('hidden') || subDetailView) return;
    var runs = subRunsOf(activeTabId);
    if (runs && anySubRunning(runs)) renderSubDock();
  }, 1000);
  // 下区控件监听已随视图绑定（bindViewEvents）；这里只绑页面级头部控件
  sessionEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickSession' }); });
  moreEl.addEventListener('click', function () { vscode.postMessage({ type: 'more' }); });
  // 语言/主题头部按钮已移除：功能保留（pickLang/pickTheme），入口收进 ⚙ 设置菜单
  // 子 agent 监控浮窗收起（头部 spinner 顶班）时，点 spinner 重新展开
  subindEl.addEventListener('click', function () { dockSetCollapsed(!subCollapsed); }); // toggle（09-18 用户反馈）
  // 头部 ＋ → 开新标签会话（工单十五入口收敛，用户拍板 2026-09-14）：多标签时代
  // 「新会话」只有一种语义=开新标签（新持久会话，不中断谁，无 busy 确认）；
  // 原中断式 newSession 只剩 ⚡菜单/slash 命令（当前标签内操作）
  newChatEl.addEventListener('click', function () { vscode.postMessage({ type: 'tabNew' }); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); var dt = e.dataTransfer; if (dt && dt.files && dt.files.length && activeTabId !== null) viewFor(activeTabId).handleFiles(dt.files, dt); }); // 三期：drop 落到活动视图
  // 就被冲掉（快照基线不含它们）。实证教训：宿主侧靠 sleep 等重绘不可靠（长会话重绘能把
  // 20ms 顶穿），顺序保证必须落在消费端。重绘进行中（renderTimer 非空）到达的流式事件
  // 先攒着，flushRender 里 render+liveSync 之后按原序放行——顺序仍是「快照先画、事件后补」
  var pendingStream: HostToWebviewTagged[] = [];
  function deferDuringRender(t: string): boolean {
    return t === 'delta' || t === 'thinking' || t === 'newLive' || t === 'toolCallStart' ||
      t === 'toolCallDelta' || t === 'toolStart' || t === 'toolEnd' || t === 'user' ||
      t === 'queuedAdd' || t === 'queuedDelivered' || t === 'queuedRemove' || t === 'queuedClear';
  }
  function drainPendingStream() {
    if (!pendingStream.length) return;
    var q = pendingStream; pendingStream = [];
    for (var i = 0; i < q.length; i++) routeMsg(q[i]);
  }
  /** 页签切换（刀5）：本地只换芯片高亮，内容现场由宿主 postUiState 重拉（pi 会话=唯一真相，
   *  webview 零影子状态——切回页签丢失现场在架构上不可能，因为根本不存在本地副本） */
  // 子 agent 浮窗按页签绑定：每页签 runs 列表（多次派发累积留档，工单十五刀5 宿主不喂
  // 后台流，故在消息丢弃前截获；切回页签时概览随该页签数据恢复，不串台）
  var subCollapsedByTab: Record<string, boolean> = {};
  function applyTabSubState(tid: string) {
    subDetailView = null; // 页签切换退出下钻（详情缓存按 runId 全局，切回重开仍命中）
    var runs = subRunsByTab[tid];
    if (runs && Object.keys(runs).length) {
      subCollapsed = subCollapsedByTab[tid] === true;
      if (subdock && !subCollapsed) dockResetPos(subdock);
      renderSubDock();
    } else {
      // 该页签没有子 agent 数据：浮窗收起隐藏、spinner 熄灭（图标随缓存判空自动隐藏）
      subRunning = false;
      if (subdock) dockSetCollapsed(true);
      updateSubInd();
    }
  }
  /** 页签切换（工单24 架构归位二期）：整个下区视图换可见性 O(1)。每个控件的实时状态都已在
   *  各自视图里活渲染（后台也一样），这里没有任何重渲——只有页头会话标题（页面级）和
   *  代码上下文 chip（页面级数据）需要补一下；跟随标志为真则补拉底（后台滚不动，见 scroll） */
  function activateTab(tid: string) {
    if (activeTabId === tid) { renderTabs(); return; }
    activeTabId = tid; tabId = tid;
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
    applyTabSubState(tid); // 子 agent 浮窗/图标随页签切换（该页签的快照缓存恢复或收起）
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
        var chip = el('span', 'tab-chip' + (t.id === activeTabId ? ' active' : '') + (t.busy ? ' busy' : '') + (t.unread && t.id !== activeTabId ? ' unread' : ''));
        chip.title = t.title;
        chip.appendChild(el('span', 'tab-dot'));
        chip.appendChild(el('span', 'tab-title', shorten(t.title, 14)));
        var x = el('span', 'tab-x', '\u00d7');
        x.title = L.tabCloseTitle;
        if (t.busy) x.className = 'tab-x always'; // busy 中关标签宿主会弹确认，× 常显提醒
        x.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'tabClose', tabId: t.id }); });
        chip.appendChild(x);
        chip.addEventListener('click', function () {
          if (t.id === activeTabId) return;
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
    if (activeTabId === null || m.activeTabId !== activeTabId) {
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
    // 标签清单先于 tabId 过滤处理（宿主是事实源）
    if (m.type === 'tabs') { handleTabs(m); return; }
    // 子 agent 快照在页签过滤前截获：后台页签的流虽不渲染但必须缓存，
    // 否则切回时该页签的浮窗/图标状态丢失；活动页签则实时渲染
    if (m.type === 'subagentUpdate') {
      var stid = m.tabId !== undefined ? m.tabId : activeTabId;
      if (stid === null) return;
      // 宿主关壳：异步派发的同步壳行删除（真进度走 sa-n 句柄行）；正下钻着它就退回概览
      if ((m as any).closed) {
        var cruns = subRunsByTab[stid];
        if (cruns) delete cruns[m.id];
        if (subDetailView && subDetailView.split(':')[0] === m.id) subDetailView = null;
        if (stid === activeTabId) renderSubDock();
        return;
      }
      updateSubRun(stid, m.id, m.snapshot, m.final, m.startAt, m.endAt);
      if (stid === activeTabId) { if (subdock && !subCollapsed) dockResetPos(subdock); renderSubDock(); }
      return;
    }
    // 下钻响应同款截获（宿主 this.post 带发起时页签，若用户已切页签则不能丢——缓存全局）
    if (m.type === 'subagentDetail') {
      subDetailCache[m.id] = m.snapshot;
      if (subDetailView && subDetailView.split(':')[0] === m.id) renderSubDock();
      return;
    }
    // tabId 路由（工单24 架构归位）：非活动页签的消息照收——写进该页签自己的隐藏树
    // （现场累加，切回即现，不再依赖切回重拉）；页面控件类后台只记账不渲染（bgMode 守卫）
    routeMsg(m);
  });
  // 启动握手：通知宿主 webview 已就绪，宿主拉会话历史重绘（防止设置 HTML 后立刻 postMessage 被丢的竞态）
  vscode.postMessage({ type: 'webviewReady' });
})();

