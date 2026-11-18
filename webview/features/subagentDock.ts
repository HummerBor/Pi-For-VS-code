/**
 * 子 agent 浮窗（2026-11-21 从 webview/main.ts 整块拆出，第 3 刀）：页头 cpu 锚点 + 右上角浮窗
 * 概览（已开启/完成两张分组行）+ 秒表 + 失败原因行 + 台账并入同一张表 + 跨页签去重。
 *
 * 为什么是 initSubagentDock(deps) 而不是模块级单例：浮窗本身是**页面级单例**（subdock /
 * subCollapsed / dockDragged），但它按页签记数据（subRunsByTab / subCollapsedByTab /
 * subSeenByTab）——宿主按 tabId 推帧，后台页签的流不渲染但必须缓存，切回时概览才恢复现场。
 * 所以状态关在 init 的闭包里，跨文件只从这里拿宿主真需要的那几个动作
 * （bind / applyTab / handleUpdate / setLedger / runsOf / anyLive）。
 *
 * 数据面全在宿主（subagentSnapshot.ts 出展示快照，帧走 appendEntry）；这里零磁盘/零子进程访问，
 * 只把快照排成行。台账（subagentLedger）是第二个源：活行走帧，台账补历史/死因/回传未达，
 * 同一句柄只要有任何页签的活行就不再补（liveSeen 跨页签去重，2026-11-19 用户拍板单表）。
 *
 * 行为红线：DOM id/class、CSS、消息协议（subagentUpdate / subagentLedger /
 * subagentOpenHandle / subagentOpenSession / subagentOpenLabel）、SUB_STALE_MS 阈值、
 * 收尾列表封顶 8 条、秒表 1s 心跳——一律不动，这是纯搬家。
 */
import { livenessStatus, type SubagentSnapshot } from "../../src/domain/subagentSnapshot";

export interface SubagentDockDeps {
  /** i18n 文案表（宿主注入的整份字典） */
  lang: Record<string, any>;
  /** 建 DOM 的小工具（main.ts 的 el：textContent 安全写入） */
  el: (tag: string, cls?: string, text?: string) => HTMLElement;
  /** 图标容器（main.ts 的 elIco：span + innerHTML 的 svg） */
  elIco: (cls: string, svg: string) => HTMLElement;
  /** 图标集查询（main.ts 的 ico：名字 → svg 串） */
  ico: (name: string, size?: number) => string;
  /** 路径/符号可点击（main.ts 的 linkify：任务摘要里的路径要能点开） */
  linkify: (root: HTMLElement | null) => void;
  /** 上行消息（原 vscode.postMessage） */
  post: (m: any) => void;
  /** 当前活动页签（core/state.ts） */
  getActiveTabId: () => string | null;
  /** 底部会话区（chip 查询/事件委托：#subchip 随页签克隆） */
  sessionArea: HTMLElement;
  /** 页头 cpu 锚点（#subind，页面级，不随页签克隆） */
  subindEl: HTMLElement;
  /** 状态行重算（原 viewFor(tid).refreshBusy()：子 agent 开跑/收尾/删行会翻转「主会话还在干活」） */
  refreshBusy: (tabId: string) => void;
}

export function initSubagentDock(deps: SubagentDockDeps) {
  var L = deps.lang;
  var el = deps.el;
  var elIco = deps.elIco;
  var ico = deps.ico;
  var linkify = deps.linkify;
  var post = deps.post;
  var getActiveTabId = deps.getActiveTabId;
  var sessionArea = deps.sessionArea;
  var subindEl = deps.subindEl;
  var refreshBusy = deps.refreshBusy;

  // ── 子 agent 监控：浮窗（codex 风格）——概览列表 + 点击下钻（工单 A，对齐 Codex 交互）──
  // 概览 = 已开启/完成 分组行（每任务一行：状态图标/名称/处理中/相对时间），点击行下钻
  // 完整活动流 + markdown 产出（subagentDetailRequest → 宿主留存的全量 details）。
  // 数据模型：每页签 runs（id → {snap, final, startAt, endAt}），id 是 toolCallId 或异步句柄
  // sa-n；一个 parallel 运行拆多行（每任务一行，Codex 同款）
  var SM_ICONS: Record<string, string> = { running: ico('loading', 12), done: ico('check', 12), failed: ico('x', 12) };
  /** 每 agent 固定色（抄 CC agentColorManager.getAgentColor）：名字哈希 → HSL，同 agent
   *  恒同色——并行多 agent 一眼分清谁是谁 */
  function agentColor(name: string): string {
    // 颜色按「职务」取（2026-11-02「职务 · 随机代号」）：同一职务的不同单共色，
    // 不同职务不同色——否则随机代号把颜色也打散，「每 agent 固定色」就名存实亡
    var duty = String(name).split('·')[0].trim();
    var h = 0;
    for (var i = 0; i < duty.length; i++) h = (h * 31 + duty.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h % 360) + ', 55%, 62%)';
  }
  // 浮窗：单例。收起（subCollapsed）= 整块隐藏、头部 spinner 亮（运行中），codex 模型；
  // 拖过一次（dockDragged）后位置归用户，未拖则每次刷新回默认右上角（防漂移事故）
  var subdock: HTMLElement | null = null;
  var subCollapsed = false;
  var dockDragged = false;
  function dockSetCollapsed(c: boolean) {
    subCollapsed = c;
    if (getActiveTabId() !== null) subCollapsedByTab[getActiveTabId()] = c; // 收起偏好按页签记忆，切回不串台
    if (subdock) subdock.classList.toggle('hidden', c);
    updateSubInd();
  }
  /** 头部 loading 图标：浮窗的锚点——首次有子 agent 后常驻（用户拍板：图标不消失）；
   *  运行中旋转，全部停止停转但不隐藏，点它展开/收起浮窗 */
  var subRunning = false;
  /** 出过 subagent 记录的页签（2026-10-23 按钮常驻修复，用户实测「第一遍调用没按钮、浮窗
   *  一关就再没入口」）：按钮判据不能用「此刻 runs 非空」——异步派发的壳 closed 事件先删
   *  壳行，runs 空窗里按钮不露、浮窗却被 unhide 空壳挂着，关掉即失联。出过即认领，
   *  壳删除不抹（用户拍板「图标不消失」的原语义就是常驻） */
  var subSeenByTab: Record<string, boolean> = {};
  function updateSubInd() {
    // 图标跟页签走：该页签出过 subagent 就常驻（判据独立于 runs 增删，收起/清行都不掉按钮）
    // 台账历史也点亮入口（段 3）：跨会话可见——任何页签有历史就看得见列表
    var show = !!subdock && getActiveTabId() !== null && (!!subSeenByTab[getActiveTabId()] || subLedgerRows.length > 0);
    subindEl.style.display = show ? 'inline-flex' : 'none';
    // 编辑器实例页头默认整行隐藏（CSS）；子 agent 运行中才露出仅含 subind 的页头行
    document.body.classList.toggle('subind-live', show);
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
  interface SubRunRec { snap: SubagentSnapshot; final: boolean; startAt?: number; endAt?: number; lastFrameAt?: number }
  var subRunsByTab: Record<string, Record<string, SubRunRec>> = {};
  /** 台账行（段 3 刀 2）：宿主 subagentLedger 推送的全局历史/在册状态（跨会话/跨重启），
   *  与页签 runs（浮窗直播）双源并存——活行走 runs，台账补历史/死因/回传未达 */
  var subLedgerRows: any[] = [];
  var subShowAllDone = false; // 完成列表封顶的展开开关（「…展开剩余」点开）
  // （计时口径已归位：一轮一只累计秒表，走秒/冻结都在视图状态行 renderBusyUi，
  //   chip 不带表——2026-10-23 用户三连纠偏「这是啥/上一轮的？/会不会懵逼」）

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
  /** 失联降级（2026-10-27 幽灵条目修复，用户实测截图：底层进程零残留，面板「已开启」
   *  条目 13h20m 仍「处理中」跳字，底部 Working 被连坐钉死，重启 VS Code 才清）：
   *  「处理中」= 最后一帧快照的 status，终态帧只要没送达 webview（扩展 appendEntry 是
   *  静默 catch / 宿主重启 / 事件链断环）记录就永驻已开启组。running 行超过 30 分钟
   *  没有任何新帧 → 判「疑似失联」：停表、不转图标、不再算「还在跑」。阈值依据：扩展
   *  每回合结束必推一帧（message_end → emitAsyncProgress），长工具调用可能静默更久，
   *  误报无害——只降级显示不删数据，下一帧到达即自愈回「处理中」
   *
   *  【2026-11-18 失联判定改 pid（交接遗留 3）】上面 30 分钟无帧从「唯一判据」降为**最后兜底**：
   *  宿主读台账时对 status==="running" 的行做 process.kill(pid,0) 探活，带 procAlive 上来。
   *  procAlive===false = 进程已死、台账还没收尸 → 立即按失败落终态（见 procDead / renderSubRow），
   *  不再等 30 分钟（真机事故：底层进程零残留，面板「处理中」跳字 13h20m）。
   *  procAlive 缺省（老台账没 pid）或为 true 时照旧走时间兜底——探活只能证明「死」不能证明「活」 */
  var SUB_STALE_MS = 30 * 60 * 1000;
  /** 台账探活结论：该句柄的子进程是否已死（无对应台账行 / 老台账没 pid → false = 不知道） */
  function procDead(handle: string | undefined): boolean {
    var h = String(handle || '');
    if (!h) return false;
    for (var i = 0; i < subLedgerRows.length; i++) {
      if (String(subLedgerRows[i].handle || '') === h) return subLedgerRows[i].procAlive === false;
    }
    return false;
  }
  function runStale(rec: SubRunRec): boolean {
    var last = rec.lastFrameAt || rec.startAt || 0;
    return !!last && Date.now() - last > SUB_STALE_MS;
  }
  /** 失联 = 进程已死（立即）或长时间无帧（兜底）。handle 缺省（老同步行只认 toolCallId）→ 只走时间判定 */
  function runGone(rec: SubRunRec, handle?: string): boolean {
    return procDead(handle) || runStale(rec);
  }
  /** 「真在跑」口径（Working 计时/头部 spinner/chip 走这只）：幽灵不算活。
   *  概览秒表重绘循环仍走 anySubRunning（raw），保证 running→stale 翻转帧被画出来 */
  function anySubLive(runs: Record<string, SubRunRec>): boolean {
    for (var k in runs) {
      if (runGone(runs[k], k)) continue;
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
    subSeenByTab[tab] = true; // 按钮常驻锚点（见 updateSubInd 头注释），只增不减
    // 运行 id 一律字符串判等（2026-10-23 拍板「无视任务内容差异」）：Map 键归一化收口，
    // toolCallId/异步句柄两类 id 都不靠隐式转换或内容碰运气
    var rid = String(id);
    var runs = subRunsByTab[tab] || (subRunsByTab[tab] = {});
    var rec = runs[rid] || (runs[rid] = { snap: snap, final: final });
    rec.snap = snap; rec.final = final;
    rec.lastFrameAt = Date.now(); // 每帧刷新「最后活动」——失联判定基准（幽灵条目修复，2026-10-27）
    if (startAt !== undefined) rec.startAt = startAt;
    if (endAt !== undefined) rec.endAt = endAt;
  }
  function renderSubDock() {
    var d = dockEnsure();
    var runs = subRunsOf(getActiveTabId());
    // 无内容不挂空壳（2026-10-23）：原实现先 unhide 再判空——壳 closed 删行后的 runs 空窗里
    // 浮窗空壳先弹、按钮却没露（show 当时判 runs 空），「有浮窗没按钮」怪象的根源。判空前置，
    // 空壳直接隐藏；按钮显隐走 subSeenByTab，不受影响
    if ((!runs || !Object.keys(runs).length) && !subLedgerRows.length) {
      subRunning = false;
      d.classList.add('hidden');
      updateSubInd();
      return;
    }
    if (!subCollapsed) dockResetPos(d); // 用户没主动拖过就回默认位，防历史漂移
    if (subCollapsed) d.classList.add('hidden');
    else requestAnimationFrame(function () { d.classList.remove('hidden'); }); // 触发从图标处缩放切出
    subRunning = runs ? anySubLive(runs) : false;
    var head = d.firstElementChild as HTMLElement;
    var body = d.lastElementChild as HTMLElement;
    head.innerHTML = '';
    head.appendChild(elIco('sm-ico' + (subRunning ? ' spin' : ''), ico(subRunning ? 'loading' : 'cpu', 13)));
    head.appendChild(el('span', 'sm-title', L.smTitle));
    var minB = el('span', 'sd-btn', '—'); minB.title = L.smCollapse;
    minB.addEventListener('click', function (e) { e.stopPropagation(); dockSetCollapsed(true); });
    head.appendChild(minB);
    body.innerHTML = '';
    body.classList.remove('sm-detail');
    renderSubOverview(body, runs);
    linkify(body);
    updateSubInd();
    renderSubChip();
  }
  /** 主会话状态行的子 agent 摘要（2026-10-23 用户「主会话的状态应该改一下」）：
   *  常驻一行「⚙ <agent> <用时> · N 运行中」，不问也能看到子 agent 进程；点击开合浮窗。
   *  无子 agent 数据则隐藏。渲染只碰可见视图的 chip（随页签克隆，切换由 applyTabSubState 补刷） */
  function renderSubChip() {
    var chip = sessionArea.querySelector('.session-view:not(.offview) #subchip') as HTMLElement;
    if (!chip) return;
    var runs = subRunsOf(getActiveTabId());
    if (!runs || !Object.keys(runs).length) { chip.style.display = 'none'; return; }
    var runN = 0, topName = '';
    for (var k in runs) {
      if (runGone(runs[k], k)) continue; // 失联幽灵不占 chip：不显示名字、不钉 Working
      var ts = runs[k].snap.tasks;
      for (var j = 0; j < ts.length; j++) {
        if (ts[j].status === 'running') {
          runN++;
          if (!topName) topName = ts[j].agent;
        }
      }
    }
    // 一轮一只钟（2026-10-23 用户「你看了会不会懵逼」+「主会话还有子 agent 在跑就还是
    // Working…」）：计时只在状态行（Working 走秒 / 全收尾白字冻结），chip 不带第二只表——
    // 跑着只给名字认人，收尾即隐藏。条数同样不带（「去掉条数交互就正确了」）
    if (!runN) { chip.style.display = 'none'; return; }
    chip.style.display = 'inline-flex';
    chip.className = '';
    chip.textContent = '⚙ ' + topName;
    chip.title = L.smTitle;
  }
  function renderSubOverview(body: HTMLElement, runs: Record<string, SubRunRec>) {
    // 展平：每任务一行（parallel 拆多行，Codex 同款）；运行中在上、收尾在下
    var runningRows: any[] = []; var doneRows: any[] = [];
    for (var runId in runs) {
      var rec = runs[runId];
      for (var ti = 0; ti < rec.snap.tasks.length; ti++) {
        var t = rec.snap.tasks[ti];
        // 进程已死的行不留在「已开启」组（2026-11-18）：探活已确认它不会再有终态帧
        var live = t.status === 'running' && !procDead(t.handle || runId);
        (live ? runningRows : doneRows).push({ runId: runId, ti: ti, t: t, rec: rec });
      }
    }
    // 台账行并入同一张表（2026-11-19 用户拍板）：不再单独开「历史（台账）」第二个表，
    // 也不再露句柄——同一句柄只要有任何页签的活行就不再补（跨页签 liveSeen 去重），
    // 补进来的行状态/时间/任务字全部取台账磁盘真值（帧断了也有终态）。
    var liveSeen: Record<string, boolean> = {};
    for (var tk in subRunsByTab) {
      var tr = subRunsByTab[tk];
      for (var rk in tr) liveSeen[rk] = true;
    }
    for (var li = 0; li < subLedgerRows.length; li++) {
      var lr = subLedgerRows[li];
      var lh = String(lr.handle || '');
      if (liveSeen[lh]) continue;
      var lst = lr.status === 'completed' ? 'done' : lr.status === 'running' ? livenessStatus('running', lr.procAlive) : 'failed';
      var lt = {
        agent: String(lr.agent || lh), task: String(lr.task || ''), status: lst,
        handle: /^sa-(?:\d+|[0-9a-f]{8})$/.test(lh) ? lh : undefined,
        sessionDir: lr.sessionDir, reported: lr.reported, deathReason: lr.deathReason, ledger: true
      };
      var lrec = { snap: null, startAt: lr.startedAt || 0, endAt: lr.endedAt, final: true, ledger: true };
      (lst === 'running' ? runningRows : doneRows).push({ runId: lh, ti: 0, t: lt, rec: lrec });
    }
    // 最新在上（2026-10-23 用户拍板）：组内按时间倒序——收尾行取 endAt、运行中取 startAt；
    // sort 稳定，同刻（parallel 同批）保持相对序
    var byNewest = function (a: any, b: any) {
      return ((b.rec.endAt || b.rec.startAt) || 0) - ((a.rec.endAt || a.rec.startAt) || 0);
    };
    runningRows.sort(byNewest);
    doneRows.sort(byNewest);
    if (runningRows.length === 0 && doneRows.length === 0) {
      body.appendChild(el('div', 'sm-empty', L.smNoRuns));
      return;
    }
    // 收尾列表封顶（2026-10-23「很漏」：83 条完成行全量铺开就是噪音）：默认只露最新 8 条，
    // 「…还有 N 条」点开才全量；运行中行不封顶（活的都要看得见）
    var hiddenN = 0;
    if (!subShowAllDone && doneRows.length > 8) {
      hiddenN = doneRows.length - 8;
      doneRows = doneRows.slice(0, 8);
    }
    var groups = [runningRows, doneRows];
    // 分组标题不带条数（同上「去掉条数」拍板：计数只会被误读，全量看「展开剩余」）
    var titles = [L.smRunningGroup, L.smDoneGroup];
    for (var g = 0; g < 2; g++) {
      if (!groups[g].length) continue;
      body.appendChild(el('div', 'sm-group-title', titles[g]));
      for (var ri = 0; ri < groups[g].length; ri++) {
        var r = groups[g][ri];
        body.appendChild(renderSubRow(r));
      }
      if (g === 1 && hiddenN > 0) {
        var more = el('div', 'sm-more-row', L.smExpand);
        more.addEventListener('click', function () { subShowAllDone = true; renderSubDock(); });
        body.appendChild(more);
      }
    }
  }

  function renderSubRow(row: any): HTMLElement {
    var t = row.t;
    // 失联降级展示（2026-10-27；2026-11-18 改 pid 两档）：
    // ① 进程已死（台账 procAlive===false）= 确定失联 → 直接按失败画，立即落终态；
    // ② 只是长时间无帧 = 疑似失联 → 徽标翻「疑似失联」、停表、悬停出 ✕ 可清
    var dead = t.status === 'running' && procDead(t.handle || row.runId);
    var stale = t.status === 'running' && !dead && runStale(row.rec);
    var effStatus = livenessStatus(t.status, dead ? false : undefined);
    var rowEl = el('div', 'sm-row ' + effStatus + (stale ? ' stale' : ''));
    rowEl.appendChild(elIco('sm-ico' + (effStatus === 'running' && !stale ? ' spin' : ''), SM_ICONS[effStatus] || '·'));
    var main = el('div', 'sm-row-main');
    // 第一行：agent 名 + 状态徽标（2026-10-23 列表重设计：状态从第二行提进名字行成徽标，
    // 第二行整行留给任务摘要——原来「完成 · 【派单令：…】」挤一行、换行乱、还漏 prompt 原文）
    var stTxt = effStatus === 'running' ? (stale ? L.smStale : L.smProcessing) : effStatus === 'failed' ? L.smFailedSt : L.smDoneGroup;
    // 状态显性化（2026-10-23 用户「对号错号是状态？？」）：三种状态都给彩色文字徽标，
    // ✓/✗ 图标只作辅助——状态不许靠猜
    var line1 = el('div', 'sm-name');
    var agEl = el('span', 'sm-agent', t.agent + (t.step ? ' #' + t.step : ''));
    agEl.style.color = agentColor(t.agent); // 每 agent 固定色（抄 CC）
    line1.appendChild(agEl);
    line1.appendChild(el('span', 'sm-st ' + (effStatus === 'running' ? (stale ? 'stale' : 'run') : effStatus === 'failed' ? 'fail' : 'done'), stTxt));
    // （用量收束行 2026-11-19 删除：ctx/花费不进浮窗，要看点进子会话）
    main.appendChild(line1);
    // 第二行只留任务（2026-11-19 用户拍板：浮窗只留 子名称 + 状态 + 父任务 + 时间；
    // 活动明细与用量全部删除——要看过程点进子会话转录页）。
    // 失败行例外保留「为什么挂」首行：那是状态信息，不然挂了只能点进去才知道原因
    var taskSnipBase = effStatus === 'failed'
      ? (((t.error || '').split('\n')[0] || '').trim() || t.task || '')
      : (t.task || '');
    // 摘要去 markdown 记号（2026-10-23「很漏」：**只测不修** 这类原文星号直接漏在列表上）
    var taskSnip = taskSnipBase.replace(/\s+/g, ' ').replace(/[*_`#]/g, '').slice(0, 48);
    var line2 = el('div', 'sm-status' + (effStatus === 'failed' ? ' fail' : ''), taskSnip);
    line2.title = taskSnipBase;
    main.appendChild(line2);
    rowEl.appendChild(main);
    // 右侧时间：运行中=已用时长（秒表每秒重绘概览），收尾=相对时间（Codex 同款）。
    // 收尾行 endAt 缺失（并行任务先完而 run 未收口等）回退 startAt——时间列不许空窗
    // data-el / data-ts 供 refreshSubTimes 就地刷新（见其头注释）
    var timeSpan: HTMLElement | null = null;
    if (effStatus === 'running' && row.rec.startAt) {
      timeSpan = el('span', 'sm-time', fmtElapsed(Date.now() - row.rec.startAt));
      timeSpan.setAttribute('data-el', String(row.rec.startAt));
    } else if ((stale || dead) && (row.rec.lastFrameAt || row.rec.startAt)) {
      timeSpan = el('span', 'sm-time', fmtRel(row.rec.lastFrameAt || row.rec.startAt)); // 失联停表：最后活动相对时间
      timeSpan.setAttribute('data-ts', String(row.rec.lastFrameAt || row.rec.startAt));
    } else if (row.rec.endAt || row.rec.startAt) {
      timeSpan = el('span', 'sm-time', fmtRel(row.rec.endAt || row.rec.startAt));
      timeSpan.setAttribute('data-ts', String(row.rec.endAt || row.rec.startAt));
    }
    if (timeSpan) rowEl.appendChild(timeSpan);
    if (t.ledger && t.reported === false) rowEl.title = L.smUnreported; // 回传未达：悬停可见，不占版面
    // （下钻按钮/明细浮层 2026-11-19 用户拍板删除：明细去子会话转录页看，浮窗只留名字/状态/任务/时间）
    // 失联行悬停 ✕（2026-10-27）：底层进程已死、终态帧永不会来，唯一清除路径就是手动。
    // （2026-11-18 探活确认已死的行同样给 ✕，不再等 30 分钟）
    // stopPropagation：别点穿成下钻
    if (stale || dead) {
      var delBtn = el('span', 'sm-del', '✕'); delBtn.title = L.smRemove;
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var runs = subRunsOf(getActiveTabId());
        if (runs) delete runs[row.runId];
        renderSubDock();
        if (getActiveTabId() !== null) refreshBusy(getActiveTabId()); // 删除可能翻转「还在跑」→ 状态行重算
      });
      rowEl.appendChild(delBtn);
    }
    // 点行去向（2026-11-02 用户拍板）：终态句柄行 → 直接在会话页面打开（另开页签，pi 原生
    // 渲染转录）；无句柄的老行/同步调用 → 浮窗下钻看活动流。
    // 【运行中也开 2026-11-03 用户质疑「禁开不如禁写」】——对：现在宿主侧对运行中的单开
    // 「转录快照」（拷一份 jsonl 去开），真身只有子进程在写，双写者红线不被破。
    // 拷不了快照（罕见）就退回真身，不把人挡在门外。
    rowEl.addEventListener('click', function () {
      // 句柄优先（2026-11-02：同步单现在也落独立会话，快照带 handle）：异步/同步统一走
      // 「开页签」。无句柄 = v6 之前的存量行 → 按显示名回找文件（subagentOpenLabel，
      // 宿主侧扫 session_info.name）
      // 台账行（没有活行快照的存量单）：点开子会话文件（pi 原生渲染），不走转录页
      if (t.ledger) {
        if (t.sessionDir) post({ type: 'subagentOpenSession', sessionDir: String(t.sessionDir) });
        return;
      }
      var openId = (/^sa-(?:\d+|[0-9a-f]{8})$/.test(String(t.handle || ''))) ? String(t.handle) : row.runId;
      if (/^sa-(?:\d+|[0-9a-f]{8})$/.test(openId)) {
        post({ type: 'subagentOpenHandle', handle: openId });
        return;
      }
      if (t.status !== 'running' && t.agent && /^.+ · .+$/.test(String(t.agent))) {
        post({ type: 'subagentOpenLabel', label: String(t.agent) });
        return;
      }
      // 无句柄无标签的存量行：没有可跳的目标，点行不再做任何事（下钻 2026-11-19 删除）
    });
    return rowEl;
  }
  // 秒表：运行中有概览时每秒重绘（用时列跳动）。收起（hidden）时不绘。
  // 无运行中行时只就地刷时间文本（2026-11-18 用户反馈「时间和状态都不更新」）：原来全收尾后
  // 重绘循环直接空转，浮窗整个冻住——「5 分钟前」可以停一整天。就地改文本不重建 DOM，
  // 不重置滚动位置、不打断悬停/点击。
  setInterval(function () {
    if (!subdock || subdock.classList.contains('hidden')) return;
    var runs = subRunsOf(getActiveTabId());
    if (runs && anySubRunning(runs)) renderSubDock();
    else refreshSubTimes();
  }, 1000);
  /** 时间列就地刷新：data-el=起始时刻（跑表）/ data-ts=时间点（相对时间） */
  function refreshSubTimes() {
    if (!subdock) return;
    var spans = subdock.querySelectorAll('.sd-body .sm-time');
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i] as HTMLElement;
      var el0 = sp.getAttribute('data-el');
      var ts = sp.getAttribute('data-ts');
      var next = '';
      if (el0 && isFinite(Number(el0))) next = fmtElapsed(Date.now() - Number(el0));
      else if (ts && isFinite(Number(ts))) next = fmtRel(Number(ts));
      if (next && next !== sp.textContent) sp.textContent = next;
    }
  }
  /** 一次性事件绑定（原来住在 main.ts 的页面级头部控件段）。调用点保持原位：
   *  绑定顺序/时机与拆分前一致。 */
  function bind() {
    // 子 agent 监控浮窗收起（头部 spinner 顶班）时，点 spinner 重新展开
    subindEl.addEventListener('click', function () { dockSetCollapsed(!subCollapsed); }); // toggle（09-18 用户反馈）
    // 状态行 chip 点击同开合浮窗（事件委托：chip 随页签克隆，逐视图绑不值）
    sessionArea.addEventListener('click', function (e) {
      var t = e.target as HTMLElement;
      if (t && t.closest && t.closest('#subchip')) dockSetCollapsed(!subCollapsed);
    });
  }

  // 子 agent 浮窗按页签绑定：每页签 runs 列表（多次派发累积留档，工单十五刀5 宿主不喂
  // 后台流，故在消息丢弃前截获；切回页签时概览随该页签数据恢复，不串台）
  var subCollapsedByTab: Record<string, boolean> = {};
  function applyTabSubState(tid: string) {
    var runs = subRunsByTab[tid];
    if (runs && Object.keys(runs).length) {
      subCollapsed = subCollapsedByTab[tid] === true;
      if (subdock && !subCollapsed) dockResetPos(subdock);
      renderSubDock();
    } else {
      // 该页签没有子 agent 数据：临时收起隐藏、spinner 熄灭。**不能走 dockSetCollapsed**——
      // 它会顺手把 subCollapsedByTab[tid]=true 记账，页签一切换就永久记成「收起」，
      // 浮窗被关后按钮再怎么点都回不来（2026-10-23 用户实测事故）。收起偏好只由用户点击写入
      subRunning = false;
      subCollapsed = true;
      if (subdock) subdock.classList.add('hidden');
      updateSubInd();
      renderSubChip();
    }
  }

  /** 宿主 subagentUpdate 到达：在页签过滤前截获（后台页签的流虽不渲染但必须缓存，
   *  否则切回时该页签的浮窗/图标状态丢失；活动页签则实时渲染） */
  function handleUpdate(m: any) {
    var stid = m.tabId !== undefined ? m.tabId : getActiveTabId();
    if (stid === null) return;
    // 宿主关壳：异步派发的同步壳行删除（真进度走 sa-n 句柄行）；正下钻着它就退回概览
    if ((m as any).closed) {
      var cruns = subRunsByTab[stid];
      if (cruns) delete cruns[String(m.id)];
      if (stid === getActiveTabId()) renderSubDock();
      refreshBusy(stid); // 壳删除也可能翻转「还在跑」判定 → 状态行重算
      return;
    }
    updateSubRun(stid, m.id, m.snapshot, m.final, m.startAt, m.endAt);
    if (stid === getActiveTabId()) { if (subdock && !subCollapsed) dockResetPos(subdock); renderSubDock(); }
    refreshBusy(stid); // 子 agent 开跑/收尾翻转「主会话还在干活」：Working 走秒/冻结值接力
  }
  /** 宿主 subagentLedger 到达（全局推送无页签归属）：覆盖缓存并重绘当前浮窗 */
  function setLedger(rows: any[]) {
    subLedgerRows = rows || [];
    renderSubDock();
  }

  return {
    /** 页面级事件绑定（main.ts 头部控件段调用一次） */
    bind: bind,
    /** 页签切换：该页签有快照就恢复概览，没有就收起（原 applyTabSubState） */
    applyTab: applyTabSubState,
    /** 宿主 subagentUpdate：缓存/渲染/状态行重算（原 window message 里的截获分支） */
    handleUpdate: handleUpdate,
    /** 宿主 subagentLedger：覆盖台账缓存并重绘 */
    setLedger: setLedger,
    /** 某页签的运行记录（状态行的「子 agent 还在跑」判据用） */
    runsOf: subRunsOf,
    /** 「真在跑」口径（失联幽灵不算活） */
    anyLive: anySubLive
  };
}
