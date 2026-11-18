/**
 * live 流式增量渲染（2026-11-23 第 5 刀子刀 5b，从 webview/main.ts 整块拆出）：
 * 边收边画的在途消息树——liveEnsure/liveBlock/finalizeLive/liveReset/appendFinal/
 * setMdTail/streamTick/appendDelta/appendThink/applyLiveSync。
 *
 * 为什么是 initLiveStream(deps)：本模块是**每页签一套**的视图成员（每个 SessionView 一个在途
 * 气泡、一套 parts 表、一个流式定时器）。入口在 makeSessionView 里装配一次；依赖只有五个——
 * root（消息区根，气泡往哪挂）、el（建 DOM）、renderRich（features/markdown.ts 的基座）、
 * lang（i18n：L.thinkingProcess / L.genArgs）、scroll（滚动跟随仍住 main.ts，见红线二）。
 *
 * ★ 红线一（R11，pdet 不跨模块）：`pdet` 是占位行工具块的「行内进度」节点，在 liveBlock 赋值、
 *   toolCallDelta 读、liveReset 清——三处全在本模块。第 5c 单搬 toolStart/toolEnd 时**不许**
 *   带走它，也不许在 main.ts 再存一份；外部只经 setPDet() 写。两个模块各留一份 = 进度文案
 *   写进孤儿节点（用户看不到），是「工具行跑着跑着不再动」的现成事故形态。
 *
 * ★ 红线二（R7，scroll ↔ 钉住判定）：scroll 留 main.ts（它只经 features/sticky.ts 的 pinCheck()
 *   进钉住判定），本模块**只经 deps.scroll 调**、绝不自己持有 scroll/stickyQ/followingEnd——
 *   两份滚动状态必然对不上（切页签回来不跟随 / 钉住气泡来回闪）。
 *
 * ★ 红线三（流式语义）：appendDelta 的节流与合帧、appendThink 的「贴底才自动滚」、finalizeLive
 *   的收尾时机（思考块收起 / text 尾巴定型）、streamTick 的表格防劈叉与围栏行首判定，一条都
 *   别「顺手优化」。注释就是事故史（0.1.28 返工、2026-09-18 表格劈叉）。
 *
 * 状态归属：liveMsg/liveDiv/pdet/liveParts/liveRTimer 本模块独占（原 main.ts 视图闭包成员，
 * 搬后只有这里持有）。外部读写口见文件末尾的「观察/写入缝」——那是第 5c 与 handleMsg 的接口，
 * 每多一个口都是零散耦合，够用即止。
 *
 * 行为红线：DOM tag/class（bubble assistant / think / md-p / pre.code / prow）、CSS、消息协议
 * 一律不动；这是纯搬家，逐字核对见 reports/REPORT-t39.md。
 */
import type { SessionMessage } from "../../src/core/protocol";

export interface LiveStreamDeps {
  /** 消息区根（原 makeSessionView 的 root：在途气泡与各段节点往这里挂） */
  root: HTMLElement;
  /** 建 DOM 工具（原 el：textContent 安全写入） */
  el: (tag: string, cls: string, text?: string) => HTMLElement;
  /** markdown 渲染（features/markdown.ts 的 renderRich：文本块定型时一次成块） */
  renderRich: (parent: any, text: any) => void;
  /** i18n 文案表 */
  lang: Record<string, any>;
  /** ★ 滚动跟随仍住 main.ts（R7：它只经 sticky 的 pinCheck() 进钉住判定），本模块只调不持有 */
  scroll: () => void;
}

export function initLiveStream(deps: LiveStreamDeps) {
  var root = deps.root;
  var el = deps.el;
  var renderRich = deps.renderRich;
  var L = deps.lang;
  var scroll = deps.scroll;

  var liveMsg = null; var liveDiv: HTMLElement | null = null; var pdet: HTMLElement | null = null; var liveParts: any = null; var liveRTimer: number | null = null;

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
      if (p && p.kind === 'thinking' && p.body && p.body.parentNode) {
        // 返工（用户实测 0.1.28）：思考块结束（切正文/工具块出现/收尾）即收起 details——
        // body 的父节点就是 details.think；用户手动展开仍可看全文（限高滚动照旧）
        p.body.parentNode.removeAttribute('open');
      }
      else if (p && p.kind === 'text' && !p.done) {
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
    // 返工（用户实测 0.1.28）：只在用户本就贴底时才自动滚底——否则每拍 delta 都拽回底部，
    // 思考块「无法往上翻、不能被打断」。贴底判定必须在追加前算（追加会增大 scrollHeight）
    var b = p.body;
    var atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 30;
    p.buf += t; b.appendChild(document.createTextNode(t));
    if (atBottom) b.scrollTop = b.scrollHeight;
    scroll();
  }

  // ── 观察/写入缝（本模块独占状态，外部只经这里读写；第 5c 单接着用）──────────────
  // 每个口都是 handleMsg/dispose 里原来直接读写闭包变量的那半句，整句搬进来、语义零改：
  // 外部少一句裸读写，就少一处「两份状态各改一边」的机会（见头注释红线一）。
  /** 取某段的在途工具块（原 toolCallDelta 的 `liveMsg && liveMsg.content[ci]`） */
  function liveToolPart(ci) { return liveMsg ? liveMsg.content[ci] : null; }
  /** 登记在途工具块（原 toolCallStart 的 `liveMsg.content[ci] = tp`；此处 liveMsg 必已由 liveBlock 建好） */
  function bindToolPart(ci, p) { liveMsg.content[ci] = p; }
  /** 占位行工具块的行内进度文案（原 toolCallDelta 的 `if (pdet) pdet.textContent = …`） */
  function setPDet(text) { if (pdet) pdet.textContent = text; }
  /** 清空壳 assistant bubble（原 handleMsg toolStart 分支那一句，2026-09-20 实测两案同根因） */
  function dropEmptyLive() { if (liveDiv && !liveDiv.textContent && !liveDiv.querySelector('img')) liveDiv.parentNode.removeChild(liveDiv); }
  /** 停流式定时器（原视图 dispose 的那一句） */
  function clearStreamTimer() { if (liveRTimer) { clearTimeout(liveRTimer); liveRTimer = null; } }

  /** 续接重定基（刀5b）：把宿主推来的在途消息按 content 段重建进本视图的在途树。
   *  与 renderAll 同拍执行，顺序由 main.ts 的 flushRender 保证（先快照重绘，再重定基） */
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

  // scheduleStream 是**存量死代码**（SCOUT-t34-cuts 六.5：全文件只有定义，appendDelta 直接调
  // streamTick，从未有人调它）。按「存量死代码不动」照搬进本模块保留，不删；要清走单独立票。
  return {
    liveEnsure: liveEnsure, liveBlock: liveBlock, finalizeLive: finalizeLive, liveReset: liveReset,
    appendFinal: appendFinal, setMdTail: setMdTail, streamTick: streamTick, scheduleStream: scheduleStream,
    appendDelta: appendDelta, appendThink: appendThink, applyLiveSync: applyLiveSync,
    liveToolPart: liveToolPart, bindToolPart: bindToolPart, setPDet: setPDet,
    dropEmptyLive: dropEmptyLive, clearStreamTimer: clearStreamTimer
  };
}
