/**
 * 消息渲染（2026-11-23 第 5 刀子刀 5d，从 webview/main.ts 整块拆出）：
 * imgsOf / addUser（用户气泡 + 子 agent 回报卡）/ textOf / makeThink / makeCompaction /
 * notice（toast）/ renderAll（整树重绘）/ renderCompact（压缩浮动条）+ 状态 lastNotice /
 * seenCompactions / compactBarShownAt。
 *
 * 为什么是 initMessageList(deps)：本模块是**每页签一套**的视图成员（消息树 root、toast 存活
 * 记录、压缩计数基线都每树一份）。入口在 makeSessionView 里装配一次。
 *
 * ★ 红线 R12（renderAll 的四个外部耦合点，一律 deps 注入，不许复制状态）：
 *   ① 队列条（queuebarEl / queuedItems / addQueuedDom，与 uiState 原子分支双写幂等）→ rebuildQueuebar；
 *   ② 空会话欢迎页（welcomeHTML / duckInto / pickTip，页面级启动快照）→ 三个引用注入；
 *   ③ 大纲轨道（outlineRebuild + olSuspend，逐条 addUser 时挂起防 O(N²)）→ rebuild + setOlSuspend；
 *   ④ 压缩条基线（seenCompactions / compactBarShownAt / renderCompact）→ 已随本刀进来（上面状态三件）。
 * ★ 红线 R13（linkify 总闸时序）：renderAll 里 setLinkifyEnabled(false) 在 root.innerHTML=''
 *   之后、循环之前，循环到最近 15 条再打开——这是大会话卡顿的唯一止血，位置一个字都不许动。
 *   linkifyEnabled 的唯一持有者仍是 main.ts（与 features/linkify.ts 同一对 accessor）。
 * ★ 红线 R7（钉住气泡）：本模块不持有 stickyQ/stickyIO，addUser 只经 deps 的 adoptSticky /
 *   observeSticky / updateStickyChip 交接；scroll 也只经 deps 调（它住 main.ts，见 features/sticky.ts）。
 * ★ resetToolRows / liveReset 由 5c / 5b 提供，重绘前照调（别把两句 reset 抄回来）。
 *
 * 行为红线：渲染语义（addUser 时间戳/去重、imgsOf 去重、makeThink/makeCompaction 折叠、
 * notice 去重、压缩条首渲立基线）与 DOM class/协议一律不动；这是纯搬家，
 * 逐字核对见 reports/REPORT-t41.md。
 */
import { toolDetail } from "../../src/domain/toolDetail";
import { isEditRetryable } from "../../src/domain/errorClass"; // 余额/配额/鉴权类错误不给「修改后重试」入口

export interface MessageListDeps {
  /** 消息区根（原 makeSessionView 的 root） */
  root: HTMLElement;
  /** 建 DOM 工具（原 el） */
  el: (tag: string, cls: string, text?: string) => HTMLElement;
  /** 图标（filecode / image / clock 等） */
  ico: (name: string, size?: number) => string;
  /** HTML 转义（子 agent 回报卡的 codeInfo 等） */
  esc: (s: any) => string;
  /** 文件路径/符号可点（features/linkify.ts） */
  linkify: (root: HTMLElement | null) => void;
  /** markdown 渲染（features/markdown.ts） */
  renderRich: (parent: any, text: any) => void;
  /** i18n 文案表 */
  lang: Record<string, any>;
  /** 滚动跟随（住 main.ts：R7，它调 sticky 的 pinCheck） */
  scroll: () => void;
  /** 上行消息（原视图 vpost，带本视图 tabId）：openImage / retryFromLast */
  post: (m: any) => void;
  /** ★ 粘性气泡三缝（features/sticky.ts）：本模块不持有 stickyQ/stickyIO（R7） */
  adoptSticky: (b: any) => void;
  updateStickyChip: (b: any) => void;
  observeSticky: (sent: any, b: any) => void;
  /** 工具行（5c，features/toolRows.ts）：历史重放逐工具 start/end */
  toolStart: (id: string, name: string, detail?: string, collapsed?: boolean) => void;
  toolEnd: (id: string, name: string, isError: boolean, text: any, detail?: string) => void;
  /** 工具行索引作废（5c 出口） */
  resetToolRows: () => void;
  /** 在途消息清空（5b 出口：整树重绘前收起 live 树） */
  liveReset: () => void;
  /** 大纲轨道重建（5g 未搬，住 main.ts） */
  outlineRebuild: () => void;
  /** 大纲挂起开关（olSuspend 住 main.ts，R12 ③） */
  setOlSuspend: (v: boolean) => void;
  /** ★ linkify 总闸写入端（唯一持有者 main.ts，R13 时序不动） */
  setLinkifyEnabled: (v: boolean) => void;
  /** 滚动跟随标志写入（followingEnd 住 main.ts，R7 的滚动域） */
  setFollowingEnd: (v: boolean) => void;
  /** 空会话欢迎页（页面级启动快照 + 鸭子 + 小贴士，R12 ②） */
  welcomeHTML: string;
  duckInto: (root: HTMLElement) => void;
  pickTip: (el: any) => void;
  /** 队列条幂等重建（R12 ①，main.ts 的 rebuildQueuebar） */
  rebuildQueuebar: () => void;
  /** 压缩浮动条（本视图元素） */
  compactbarEl: HTMLElement;
}

export function initMessageList(deps: MessageListDeps) {
  var root = deps.root; var el = deps.el; var ico = deps.ico; var esc = deps.esc;
  var linkify = deps.linkify; var renderRich = deps.renderRich; var L = deps.lang;
  var scroll = deps.scroll; var vpost = deps.post;
  var adoptSticky = deps.adoptSticky; var updateStickyChip = deps.updateStickyChip; var observeSticky = deps.observeSticky;
  var toolStart = deps.toolStart; var toolEnd = deps.toolEnd; var resetToolRows = deps.resetToolRows;
  var liveReset = deps.liveReset; var outlineRebuild = deps.outlineRebuild; var setOlSuspend = deps.setOlSuspend;
  var setLinkifyEnabled = deps.setLinkifyEnabled; var setFollowingEnd = deps.setFollowingEnd;
  var welcomeHTML = deps.welcomeHTML; var duckInto = deps.duckInto; var pickTip = deps.pickTip;
  var rebuildQueuebar = deps.rebuildQueuebar; var compactbarEl = deps.compactbarEl;

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
      root.appendChild(card); setFollowingEnd(true); scroll();
      return;
    }
    var w = root.querySelector('#welcome'); if (w) w.remove(); var b = el('div', 'bubble user');
    (b as any)._olText = text || ''; // 大纲轨道条目文案（空文本=代码上下文泡，olText 里有兑底）
    adoptSticky(b); // 旧泡摘态 + 换钉住引用（细节与事故注释在 features/sticky.ts 的 adoptSticky）
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
    if (codeInfo) { var n1 = el('div', 'notice'); n1.innerHTML = ico('filecode', 12) + ' ' + L.attachedCode + esc(codeInfo); b.appendChild(n1); } if (fileCount) { var n3 = el('div', 'notice'); n3.innerHTML = ico('filecode', 12) + ' ' + fileCount + L.filesUnit; b.appendChild(n3); } if (imageCount && !(images && images.length)) { var n2 = el('div', 'notice'); n2.innerHTML = ico('image', 12) + ' ' + imageCount + L.imagesUnit; b.appendChild(n2); } var sent = el('div', 'sticky-sent'); root.appendChild(sent); root.appendChild(b); setFollowingEnd(true); scroll();
    // 原位态量一次完整内容高（未 clamp，后续钉住判定用它，不再反复读布局）；
    // sentinel 在 bubble 前，IO 观察它判定钉住（工单28 追加二）
    observeSticky(sent, b);
    requestAnimationFrame(function () { (b as any)._fullH = b.scrollHeight; updateStickyChip(b as any); });
    outlineRebuild(); // 新用户消息 → 大纲轨道补一行（历史重绘走 renderAll 出口，不在此重复）
  }  // 主动发消息=回底意图（工单十七要点 3）
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
    setOlSuspend(true); // 重绘期逐条 addUser 不重建轨道（O(N²)），结尾一次建好
    root.innerHTML = '';
    liveReset();
    resetToolRows(); // 工具行索引作废（重绘后 DOM 全换，见 features/toolRows.ts 的 resetToolRows）
    if (!list || !list.length) {
      if (welcomeHTML) { root.innerHTML = welcomeHTML; duckInto(root); pickTip(root.querySelector('#welcome')); }
      setOlSuspend(false);
      outlineRebuild(); // 空会话无锚点，轨道自动隐藏
      return;
    }
    setLinkifyEnabled(false); // 老消息不 linkify，循环到最近 15 条时再打开
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
      if (i >= list.length - 15) setLinkifyEnabled(true);
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
    // 队列条幂等重建（R12 ①）：queuebar 三个成员属队列域（5f 未搬），调用与事故原委见
    // main.ts 的 rebuildQueuebar（工单十八补刀3：先清再建，与 uiState 原子分支谁先谁后都不叠加）
    rebuildQueuebar();
    // 重挂存活的 toast（renderAll 开头清了 root；空列表 welcome 早退分支不挂——新会话无历史 toast）
    if (lastNotice) { var ln = el('div', 'notice', lastNotice); linkify(ln); root.appendChild(ln); }
    scroll();
    setOlSuspend(false);
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
  /** 会话边界清 toast（render 分支用：lastNotice 归本模块独占，main.ts 只经此口清） */
  function clearNotice() { lastNotice = ''; }

  return {
    /** 用户气泡（当场回显 + 历史重绘同一路径）+ 子 agent 回报卡 */
    addUser: addUser,
    /** 整树重绘（切历史 / uiState 快照 / 压缩后重建） */
    renderAll: renderAll,
    /** 瞬时 toast（同文去重、跨重渲重挂） */
    notice: notice,
    /** toast 周期边界（send 新回合 / render 整体替换会话时清） */
    clearNotice: clearNotice
  };
}
