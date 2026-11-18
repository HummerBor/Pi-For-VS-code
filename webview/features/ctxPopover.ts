/**
 * 上下文用量弹层 + 页脚用量圆环（2026-11-05 上线；2026-11-21 从 webview/main.ts 整块拆出）：
 * 页脚 #usage 圆环（占比 + 金额）hover 打开 #ctxpop —— 预算百分比、分段条与图例、用量与花费
 * 分项、价目行、分时段估算、压缩阈值滑块与三档刻度。
 *
 * 为什么和页脚圆环同住一个模块：两者共用**同一次真值帧**（宿主 ctxDetail）和同一套金额格式化。
 * 事故（2026-11-16 用户实测「弹层 19.8% / 页脚 19.6%」）：两处各自采样各自的时刻，必然差一截；
 * 页脚那行「28.6% · $0.43」还必须跟着真值帧走（原先只吃 state 帧 → 平时冻着）。拆成两份状态
 * 只会把这个 bug 装回来，所以 ring 与 pop 是一个整体。
 *
 * 为什么是 initCtxPopover(deps) 而不是模块级单例：弹层随 .session-view 克隆，**每页签一套**
 * DOM 与定时器（ctxDetail 缓存 / 1s 心跳 / 400ms 补查 / 420ms 移出关闭都是本页签的）。入口在
 * makeSessionView 里调一次，元素与数据都关在自己的闭包里；跨文件只从这里拿宿主真需要的那几个
 * 动作（bind / refreshUsage / applyDetail / setBusy / scheduleQuery / close / isOpen / dispose）。
 *
 * 行为红线：DOM id/class、CSS、消息协议（ctxQuery / ctxSetReserve / ctxDetail）一律不动；
 * 时间常数（1s 心跳 / 400ms 补查 / 420ms 移出关闭 / 1.5s 编辑窗口）也不许动——这是纯搬家。
 */
import { compactionStops } from "../../src/domain/ctxBreakdown";

export interface CtxPopoverDeps {
  /** 查本视图内的元素（ID 在各视图内重复，必须 scope 到视图；原来 makeSessionView 里的 q()） */
  q: (sel: string) => HTMLElement;
  /** 上行消息（原 vpost：显式带本视图 tabId） */
  post: (m: any) => void;
  /** i18n 文案表（宿主注入的整份字典） */
  lang: Record<string, any>;
  /** HTML 转义（分段图例/花费分项是拼字符串 innerHTML，必须过它） */
  esc: (s: any) => string;
}

export function initCtxPopover(deps: CtxPopoverDeps) {
  var q = deps.q;
  var vpost = deps.post;
  var L = deps.lang;
  var esc = deps.esc;

  // 页脚用量入口（与弹层共用同一次真值帧，故在这里；原先散在 makeSessionView 的引用组里）
  var usageEl = q('#usage');
  /** 圆圈百分比的内部节点（bindViewEvents 建，applyState 每次刷新） */
  var ringFillEl: any = null; var usageTxtEl: any = null;
    // 上下文用量弹层（2026-11-05）：随页签克隆；数据全由宿主 ctxDetail 一条消息给全
    var ctxPopEl = q('#ctxpop'); var cpPctEl = q('#ctxpop .cp-pct'); var cpUsedEl = q('#ctxpop .cp-used');
    var cpBarEl = q('#ctxpop .cp-bar'); var cpLegendEl = q('#ctxpop .cp-legend');
    var cpRangeEl = q('#ctxpop .cp-range') as HTMLInputElement; var cpThValEl = q('#ctxpop .cp-thval');
    var cpThLabelEl = q('#ctxpop .cp-thlabel'); var cpCloseEl = q('#ctxpop .cp-close');
    var cpTicksEl = q('#ctxpop .cp-ticks');
    var cpCostEl = q('#ctxpop .cp-cost'); var cpCostListEl = q('#ctxpop .cp-cost-list');
    var cpCostAmtEl = q('#ctxpop .cp-cost-amount'); var cpCostTagEl = q('#ctxpop .cp-cost-tag');
    var cpCostNoteEl = q('#ctxpop .cp-cost-note'); var cpCostHitEl = q('#ctxpop .cp-cost-hit');
    var cpPriceEl = q('#ctxpop .cp-price');
    var cpEstEl = q('#ctxpop .cp-est');
    /** 顶部「压缩点」读数（拖动滑块时原地联动，不等宿主回包） */
    var cpAtEl = q('#ctxpop .cp-at');
    /** 最近一条 ctxDetail 真值（拖动滑块时以它为基准局部重算，不必等宿主回包） */
    var ctxDetail: any = null;
    /** 用户正在动阈值（拖滑块 / 点刻度）的本地真值 + 时间戳。
     *  事故（2026-11-16 用户「改后直接不能用了」）：弹层开着时宿主每秒发一帧 ctxDetail
     *  （心跳），而 renderCtxDetail 每次都拿宿主值回填滑块 —— 拖到一半被每秒弹回去，
     *  看着就是「滑不动」。编辑窗口期内一律以本地值为准，别拿回包盖用户的手。 */
    var ctxEditTh: any = null;
    var ctxEditAt = 0;
    /** 弹层补查节流（state/uiState 帧到了才补查一次）：弹层开着时跟着宿主真相走。
     *  事故（2026-11-05 用户报「上面数字有延迟」）：弹层只在 hover 打开那一刻查一次，
     *  之后 agent 干活、页脚圆环跟着 state 帧动，弹层却冻在打开瞬间 —— 看着就像卡住。 */
    var ctxQueryTimer: any = null;

    function scheduleCtxQuery() {
      if (ctxQueryTimer) return;
      ctxQueryTimer = setTimeout(function () {
        ctxQueryTimer = null;
        if (ctxPopEl.style.display === 'block') vpost({ type: 'ctxQuery' });
      }, 400);
    }
    // 弹层/跑活期间的 1s 心跳（2026-11-05 用户：「这个百分比不是实时的，pi 本身好像是实时的」）。
    // 只靠 state 帧刷新的话，流式输出期间数字会冻住（state 只在轮次边界发）。
    // 【2026-11-16 用户实测】原先只在弹层 hover 时心跳 → 页脚那个「28.6% · $0.43」
    // 平时是冻的，**鼠标一移上去（弹层打开）数字才动**，看着就像页脚跟着弹层走。
    // 现在两个条件任一成立就心跳：弹层开着 ∪ 本会话在跑活（busy）。
    var ctxBusy = false;
    var ctxTick: any = null;
    function startCtxTick() {
      if (ctxTick) return;
      ctxTick = setInterval(function () {
        vpost({ type: 'ctxQuery', light: true });
        if (!ctxBusy && ctxPopEl.style.display !== 'block') stopCtxTick();
      }, 1000);
    }
    function stopCtxTick() {
      if (ctxTick) { clearInterval(ctxTick); ctxTick = null; }
    }
    /** 心跳开关唯一入口：弹层开着或 busy 才跑 */
    function syncCtxTick() {
      if (ctxBusy || ctxPopEl.style.display === 'block') startCtxTick();
      else stopCtxTick();
    }
  // ── 上下文用量弹层（2026-11-05 用户工单）──
  // 分段颜色/顺序/文案全在这里：宿主只给 key + token 数（+percent），不跨边界传颜色文案。
  // other 是估算与真值的差额（tokenizer/缓存），单列不藏。
  var CP_SEGS = [
    { key: 'prompt', color: '#7c6cf5', label: 'ctxSegPrompt' },
    { key: 'tools', color: '#2f9e6e', label: 'ctxSegTools' },
    { key: 'messages', color: '#e8912d', label: 'ctxSegMessages' },
    { key: 'mcp', color: '#9333ea', label: 'ctxSegMcp' },
    { key: 'skills', color: '#e0559a', label: 'ctxSegSkills' },
    { key: 'project', color: '#3b82f6', label: 'ctxSegProject' },
    { key: 'other', color: '#94a3b8', label: 'ctxSegOther' }
  ];
  function fmtTok(n) {
    if (n === null || n === undefined) return L.ctxNoData;
    if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
    if (n >= 1000) return (Math.round(n / 100) / 10) + 'K';
    return String(Math.round(n));
  }
  function cpSegOf(m, key) {
    var list = (m && m.segments) || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }
  /** 金额格式：币种由宿主下发（cny/usd）；钱小的时候给足小数位，否则 ¥0.00 会把小额看成「免费」 */
  function fmtCost(v, currency) {
    if (v === null || v === undefined || !isFinite(v)) return L.ctxNoData;
    return (currency === 'cny' ? '\u00a5' : '$') + fmtMoneyNum(v);
  }
  /** 金额数字部分（不带符号）：≥1 两位、≥0.01 三位、其余四位。页脚与弹层共用同一套小数位，
   *  否则「页脚 $0.2 / 弹层 $0.183」会被当成两个数。 */
  function fmtMoneyNum(v) {
    if (v === null || v === undefined || !isFinite(v) || v <= 0) return '0';
    if (v >= 1) return v.toFixed(2);
    if (v >= 0.01) return v.toFixed(3);
    return v.toFixed(4);
  }
  /** 用量与花费（2026-11-05 用户：积分式百分比不适合 API 计费）：
   *  缓存命中 / 缓存写入 / 非缓存输入 / 输出 四行，各显 token 与金额，末行合计。
   *  数据由宿主 domain/usageTotals.ts 从 pi 消息 usage 累加（含 pi 算好的分项成本）——
   *  这里零计算，只排版。全零分类不占行（与图例同口径）；无价目时只显 token。 */
  function renderCtxCost(u) {
    if (!u) { cpCostEl.style.display = 'none'; return; }
    cpCostEl.style.display = 'block';
    var money = u.priced === true;
    var split = money && u.splitKnown === true;
    if (cpCostNoteEl) {
      cpCostNoteEl.style.display = money ? 'none' : 'block';
    }
    if (cpCostTagEl) {
      // 展示的是「pi 的数 + 我们的汇率」：换算写在明面上，别让人以为是账单原值
      cpCostTagEl.textContent = money && u.currency === 'cny' ? L.ctxCostFx.replace('{r}', String(u.fx)) : '';
      cpCostTagEl.className = 'cp-cost-tag';
    }
    var rows = '';
    if (u.cacheRead) rows += cpCostRow(L.ctxCostCacheRead, u.cacheRead, u.costCacheRead, split, u.currency, 'cache');
    if (u.cacheWrite) rows += cpCostRow(L.ctxCostCacheWrite, u.cacheWrite, u.costCacheWrite, split, u.currency, 'write');
    if (u.input) rows += cpCostRow(L.ctxCostInput, u.input, u.costInput, split, u.currency, 'input');
    if (u.output) rows += cpCostRow(L.ctxCostOutput, u.output, u.costOutput, split, u.currency, 'output');
    cpCostListEl.innerHTML = rows;
    // 缓存命中率（2026-11-05 用户要）：DeepSeek 命中/未命中差 50 倍价，这是「便宜了多少」的唯一
    // 直观指标。null（还没输入）留空，别拿 0% 骗人。
    if (cpCostHitEl) {
      cpCostHitEl.textContent = u.cacheHitRate === null || u.cacheHitRate === undefined
        ? ''
        : L.ctxCostHitRate + ' ' + (Math.round(Number(u.cacheHitRate) * 1000) / 10) + '%';
    }
    cpCostAmtEl.textContent = money ? fmtCost(u.cost, u.currency) : fmtTok(u.tokens) + ' tokens';
    cpCostAmtEl.title = u.tokens ? u.tokens.toLocaleString() + ' tokens' : '';
  }
  /** 价目行：derived=true 时是**本会话实际用量反推**的成交单价（与金额同源），
   *  否则是新会话还没有用法时的当前模型目录价。单位按弹层货币换算（估算）。
   *  这一行是「对账锚点」——pi 算出来的钱对不对，看它就知道 pi 用的是哪套价。 */
  function renderCtxPrice(p, u) {
    if (!cpPriceEl) return;
    if (!p) { cpPriceEl.style.display = 'none'; return; }
    var currency = (u && u.currency) || 'cny';
    var fx = (u && u.fx) || 1;
    function perM(v) { return fmtCost((v || 0) * fx, currency) + '/M'; }
    if (p.derived && !(p.input || p.output || p.cacheRead || p.cacheWrite)) {
      cpPriceEl.style.display = 'none'; // 免费模型/无分项：没有"单价"可谈，不编排一行 0
      return;
    }
    cpPriceEl.style.display = 'block';
    var models = (p.models && p.models.length ? p.models.join(' + ') : p.name || p.id);
    cpPriceEl.textContent =
      (p.derived ? L.ctxPriceLineDerived : L.ctxPriceLine)
        .replace('{m}', models)
        .replace('{i}', perM(p.input))
        .replace('{c}', perM(p.cacheRead))
        .replace('{w}', perM(p.cacheWrite))
        .replace('{o}', perM(p.output));
    cpPriceEl.title = p.derived ? models : p.provider + '/' + p.id;
  }
  /** 分时段估算（2026-11-17 方案 A）：厂商高峰/空闲两档价，pi 目录只有一套（≈高峰价），
   *  所以这一行才是「跟账单对得上」的数。合计行不动（pi 记账 = 对账锚点），两个数都摆着。
   *  表里没有的模型不估价，标一句「无价目，未计」。 */
  function renderCtxEstimate(e, u) {
    if (!cpEstEl) return;
    if (!e) { cpEstEl.style.display = 'none'; return; }
    var currency = (u && u.currency) || 'cny';
    var band = e.band === 'peak' ? L.ctxEstPeak : L.ctxEstOffpeak;
    var line = L.ctxEstLine.replace('{v}', fmtCost(e.cny, currency)).replace('{band}', band);
    if (e.unpriced && e.unpriced.length) {
      line += ' · ' + L.ctxEstUnpriced.replace('{m}', e.unpriced.join(' + '));
    }
    cpEstEl.style.display = 'block';
    cpEstEl.textContent = line;
    cpEstEl.title = L.ctxEstNote;
  }
  function cpCostRow(label, tokens, cost, showMoney, currency, kind) {
    return '<li><i class="cp-cc cp-cc-' + kind + '"></i><span class="cp-lb">' + esc(label) + '</span>' +
      '<span class="cp-lv">' + fmtTok(tokens) + '</span>' +
      '<span class="cp-cm">' + (showMoney ? fmtCost(cost, currency) : '') + '</span></li>';
  }
  /** 弹层渲染（2026-11-05 第二版：百分比分母改成**压缩预算**）。
   *  budget = 压缩点（window - reserveTokens），满宽就是「压到这里就自动压缩」。
   *  拖动滑块时用 budgetOverride 局部重算（不等宿主回包），所以全部数字会一起动——
   *  用户的原始诉求就是这样：拖阈值，上面全变（窗口口径下它们数学上不可能变）。 */
  function renderCtxDetail(m, budgetOverride?: number) {
    ctxDetail = m;
    var win = m.window || 0;
    if (budgetOverride !== undefined) { ctxEditTh = budgetOverride; ctxEditAt = Date.now(); }
    // 编辑窗口 1.5s：拖完/松手后留给宿主回包的时间，期间不回填、不覆写用户刚设的值
    var editing = budgetOverride !== undefined || (ctxEditTh !== null && Date.now() - ctxEditAt < 1500);
    if (!editing) ctxEditTh = null;
    var budget = editing ? Number(ctxEditTh) : (m.budget || win);
    var p = budget > 0 && m.used !== null && m.used !== undefined ? (m.used / budget) * 100 : null;
    // 弹层关着时也会有 ctxDetail（busy 期间每秒一帧心跳）：只刷页脚圆环，整块弹层 DOM
    // 等打开时再画（openCtxPop 会用最新 ctxDetail 重渲一遍）——不白干活也不抖
    if (ctxPopEl.style.display !== 'block' && !budgetOverride) {
      if (m.usage && m.usage.priced !== false) {
        // 页脚恒美元；金额优先用**分时段估算**（与账单同口径），pi 台账进 title 对账
        lastPiCost = usdOf(m.usage);
        lastUsageCost = m.estimate ? Number(m.estimate.usd) || lastPiCost : lastPiCost;
        lastUsageSign = '$';
        lastUsageFromDetail = true;
      }
      if (p !== null) paintUsage(p, lastUsageCost, lastUsageSign);
      return;
    }
    cpPctEl.textContent = p === null ? L.ctxNoData : (Math.round(p * 10) / 10) + '%';
    cpPctEl.classList.toggle('hot', p !== null && p >= 100);
    // 页脚圆环用同一份数据重画：用户实测「弹层 19.8% / 页脚 19.6%」——两处各自采样各的时刻
    // 必然差一截。ctxDetail 是真值帧，圆环跟着它走（拖阈值时也走这条，所以零延迟）。
    // 【2026-11-16 用户实测】页脚的「· $0.43」也要跟着真值帧走：原先它只吃 state 帧的
    // stats.cost（轮次边界才发）—→ 金额平时冻着，只有弹层（hover）重画时才连带变一下。
    // 金额取 m.usage（= 弹层合计同一份 pi cost），但**换成美元**再打：页脚恒美元（2026-11-16
    // 用户拍板），弹层里那份人民币只是按汇率的估算，跳得刺眼。
    if (m.usage && m.usage.priced !== false) {
      lastPiCost = usdOf(m.usage);
      lastUsageCost = m.estimate ? Number(m.estimate.usd) || lastPiCost : lastPiCost;
      lastUsageSign = '$';
      lastUsageFromDetail = true;
    }
    if (p !== null) paintUsage(p, lastUsageCost, lastUsageSign);
    cpUsedEl.textContent = m.used === null || m.used === undefined || !budget ? '' : L.ctxUsed + ' ' + fmtTok(m.used) + '/' + fmtTok(budget);
    cpUsedEl.title = win ? L.ctxWindowLabel + ' ' + fmtTok(win) : '';
    // 分段条：满宽 = 压缩预算（不是窗口），这样条子越满 = 越接近自动压缩
    var bar = '';
    if (budget > 0) {
      for (var i = 0; i < CP_SEGS.length; i++) {
        var s = cpSegOf(m, CP_SEGS[i].key);
        if (!s || !s.tokens) continue;
        var w = (s.tokens / budget) * 100;
        if (w > 100) w = 100;
        bar += '<i class="cp-seg" style="width:' + w + '%;background:' + CP_SEGS[i].color + '"></i>';
      }
    }
    cpBarEl.innerHTML = bar;
    // 图例：只列有量的分类（0 值不占行，避免“一串 0.0%”噪音）；百分比同样按预算算
    var rows = '';
    for (var j = 0; j < CP_SEGS.length; j++) {
      var sg = cpSegOf(m, CP_SEGS[j].key);
      if (!sg || !sg.tokens) continue;
      var lv = budget > 0 ? (Math.round((sg.tokens / budget) * 1000) / 10) + '%' : fmtTok(sg.tokens);
      rows += '<li><i style="background:' + CP_SEGS[j].color + '"></i><span class="cp-lb">' + esc(L[CP_SEGS[j].label]) + '</span><span class="cp-lv">' + lv + '</span></li>';
    }
    cpLegendEl.innerHTML = rows;
    // 拖动阈值（budgetOverride）时只重算「随预算变」的那几块：金额/价目与阈值无关，
    // 每次 input 都重建它们纯属给主线程添堵（用户实测拖动卡）
    if (budgetOverride === undefined) {
      renderCtxCost(m.usage);
      renderCtxPrice(m.pricing, m.usage);
      renderCtxEstimate(m.estimate, m.usage);
    }
    // 阈值滑块（真相 = pi 的 compaction.reserveTokens，webview 这边用“触发点占窗口百分比”表达）
    cpThLabelEl.textContent = m.compactEnabled ? L.ctxCompactHint : L.ctxCompactOff;
    var usable = m.compactEnabled && win > 0;
    cpRangeEl.disabled = !usable;
    cpTicksEl.classList.toggle('disabled', !usable);
    if (win > 0 && m.compactAt !== null && m.compactAt !== undefined) {
      if (!editing) {
        renderTicks(); // 刻度标签随窗口/语言刷新（点刻度 = 直接跳档并写盘）
        cpRangeEl.value = String(thresholdToRange(m.compactAt)); // 旋钮 = 真值位置
        markNearestTick(m.compactAt);
      }
      syncThresholdUi(budget);
    } else {
      cpThValEl.textContent = L.ctxNoData;
      cpAtEl.textContent = '';
    }
  }
  /** 三段档位 = 模型窗口三等分，并对齐到好读的整数（≥300K 用 50K 步进）：
   *  1M 窗口 → 350K / 700K / 1M。末档恒等于窗口本身（「拉满」= 到窗口才压缩）。
   *  2026-11-05 用户拍板：连续百分比太难拖，三段就够。 */
  function ctxStops() {
    // 纯计算在 domain（有独立用例锁行为）：webview 只负责取值/渲染
    return compactionStops(ctxDetail && ctxDetail.window ? ctxDetail.window : 0);
  }
  /** 滑块区间：首档（窗口 1/3）→ 窗口。旋钮位置按此线性映射，永远反映真值 */
  function rangeBounds() {
    var stops = ctxStops();
    var win = ctxDetail && ctxDetail.window ? Number(ctxDetail.window) : 0;
    if (!stops.length || !win) return null;
    return { lo: stops[0], hi: win };
  }
  function rangeToThreshold(v) {
    var b = rangeBounds();
    if (!b) return 0;
    var r = Math.max(0, Math.min(1000, isFinite(v) ? v : 0)) / 1000;
    return b.lo + (b.hi - b.lo) * r;
  }
  function thresholdToRange(th) {
    var b = rangeBounds();
    if (!b) return 1000;
    var r = (th - b.lo) / (b.hi - b.lo);
    return Math.round(Math.max(0, Math.min(1, r)) * 1000);
  }
  /** 阈值落在某个预设点上（±0.5% 窗口）才高亮那个刻度；否则三个都不亮 ——
   *  宁可没有选中态，也不许把 183.6K 标成「拉满 200K」（用户截图里就是这么被骗的） */
  function markNearestTick(th) {
    var stops = ctxStops();
    var win = ctxDetail && ctxDetail.window ? Number(ctxDetail.window) : 0;
    if (!stops.length || !win) { markActiveTick(-1); return; }
    for (var i = 0; i < stops.length; i++) {
      if (Math.abs(stops[i] - th) <= win * 0.005) { markActiveTick(i); return; }
    }
    markActiveTick(-1);
  }
  /** 三段刻度：标签 = 档位 token 数（点一下直接跳档并写盘） */
  function renderTicks() {
    var stops = ctxStops();
    var spans = cpTicksEl.children;
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i] as HTMLElement;
      var has = i < stops.length;
      sp.style.display = has ? '' : 'none';
      sp.textContent = has ? fmtTok(stops[i]) : '';
      sp.onclick = (function (idx) {
        return function () { applyStop(idx, true); };
      })(i);
    }
  }
  /** 切档唯一入口（滑块与刻度共用）：commit=false 只本地重算（拖动中），true 才写库。
   *  写库走 piCore.setCompactionReserve → 只改本会话设置内存（不碰全局配置文件）。 */
  function applyStop(idx, commit) {
    if (!ctxDetail || !ctxDetail.window) return;
    if (!ctxDetail.compactEnabled) return; // 压缩关着：档位不可用（宿主那边也不会写）
    var stops = ctxStops();
    if (idx < 0 || idx >= stops.length) return;
    var th = stops[idx];
    cpRangeEl.value = String(thresholdToRange(th)); // 旋钮跟着档位走（否则滑块与数字又对不上）
    if (!commit) { renderCtxDetail(ctxDetail, th); markActiveTick(idx); return; }
    renderCtxDetail(ctxDetail, th); // 先本地重算，宿主回 ctxDetail 时以真值为准
    markActiveTick(idx);
    vpost({ type: 'ctxSetReserve', reserveTokens: Math.round(ctxDetail.window - th) });
  }
  /** 当前档高亮（滑块位置 ↦ 下面刻度的选中态） */
  function markActiveTick(idx) {
    var spans = cpTicksEl.children;
    for (var i = 0; i < spans.length; i++) {
      if (i === idx) spans[i].className = 'on';
      else spans[i].className = '';
    }
  }
  /** 阈值读数联动：底部「压缩点 X · 预留 Y」+ 顶部「压缩点 N%」（占模型窗口）。 */
  function syncThresholdUi(th) {
    var win = ctxDetail && ctxDetail.window ? ctxDetail.window : 0;
    if (!win || !th) return;
    var p = Math.max(0, Math.min(100, (th / win) * 100));
    cpThValEl.textContent = fmtTok(th) + ' · ' + L.ctxReserveLabel + ' ' + fmtTok(win - th);
    cpAtEl.textContent = L.ctxCompactAt.replace('{p}', String(Math.round(p)));
  }
  /** 圆环周长：SVG r=8 → 2πr；dashoffset 按占比推进 */
  var RING_C = 2 * Math.PI * 8;
  /** 最近一次已知成本（圆环与弹层共用：拖阈值时圆环也要跟着重画）。
   *  2026-11-16：改成以 ctxDetail 的真值帧为准，state 帧只在还没拿到过 ctxDetail 时当兜底。
   *  单位：**美元**（页脚恒 USD，与 pi 原生 TUI 状态行一致；人民币只在弹层里估算）。 */
  var lastUsageCost = 0;
  var lastUsageSign = '$';
  var lastUsageFromDetail = false;
  /** pi 记账的金额（美元）：页脚显示的是「时段估算」，pi 台账放 title 里当对账锚点 */
  var lastPiCost = 0;
  /** 页脚金额 = pi 的 USD 原值：usage.cost 已是按汇率折出的人民币，除回 fx 就是 pi 那个数。
   *  为什么不追一个 usd 字段：边界上只留一份金额，避免两套四舍五入各跑各的。 */
  function usdOf(u) {
    var cost = Number(u && u.cost) || 0;
    var fx = Number(u && u.fx) || 1;
    return fx > 0 ? cost / fx : cost;
  }
  /** 圆环 + 百分比文字的唯一画笔。三条入口都走这里，保证页脚永远只有一个数、一个时刻：
   *  ① state 帧（renderUsageRing）② 弹层数据到达（renderCtxDetail）③ 拖阈值（本地预算重算） */
  function paintUsage(p, cost, sign) {
    if (p === null || p === undefined) {
      ringFillEl.style.strokeDashoffset = String(RING_C); // 无数据 = 空环
      usageTxtEl.textContent = '';
      usageEl.title = L.ctxTitle;
      return;
    }
    var pct = Math.max(0, Math.min(100, p));
    ringFillEl.style.strokeDashoffset = String(RING_C * (1 - pct / 100));
    ringFillEl.style.stroke = pct >= 90 ? '#e05a5a' : pct >= 70 ? '#e8912d' : 'var(--vscode-charts-blue, #3b82f6)';
    usageTxtEl.textContent = (Math.round(p * 10) / 10) + '%' +
      (cost ? ' · ' + (sign || '$') + fmtMoneyNum(Number(cost)) : '');
    usageEl.title = L.ctxTitle + ' ' + (Math.round(p * 10) / 10) + '%' +
      (lastPiCost ? ' · ' + L.ctxPiLedger + ' $' + fmtMoneyNum(lastPiCost) : '');
  }
  /** 页脚圆环（state 帧入口）：分母与弹层同一口径（压缩预算 = 窗口 − reserveTokens），
   *  stats.contextLimit 缺失（老帧/压缩关闭）时退回 pi 原生的窗口百分比。
   *  金额**恒显美元**（2026-11-16 用户拍板「页脚用美元」）：stats.cost 就是 pi 的 USD 原值，
   *  与 pi 原生 TUI 状态行的 $ 是同一个数；人民币只在弹层里按汇率估算。 */
  function renderUsageRing(stats) {
    // 金额优先给 ctxDetail 真值帧（同一份 pi cost，已换成美元）；
    // 还没拿到过弹层数据时兜底用 state 帧的 pi 原值（本来就是 USD）
    if (!lastUsageFromDetail) {
      lastPiCost = stats && stats.cost ? Number(stats.cost) : 0;
      lastUsageCost = lastPiCost;
      lastUsageSign = '$';
    }
    var budget = stats ? Number(stats.contextLimit || stats.contextWindow || 0) : 0;
    var p = null;
    if (stats && stats.contextTokens !== null && stats.contextTokens !== undefined && budget > 0) {
      p = (Number(stats.contextTokens) / budget) * 100;
    } else if (stats && stats.contextPercent !== null && stats.contextPercent !== undefined) {
      p = Number(stats.contextPercent);
    }
    paintUsage(p, lastUsageCost, lastUsageSign);
  }

  // 上下文用量弹层（2026-11-05）：**hover 打开**（用户 2026-11-05 指定，不用点击），
  // 移出去 280ms 才关——鼠标从页脚滑进弹层要过一道缝，立刻关会来回闪。
  // 弹层自身 hover 时取消关闭定时器；✕ / Esc 立即关。
  // 开合三函数原来嵌在 bindViewEvents 里，这里提到 init 作用域：Esc / 点消息区也走
  // 本模块的 close()，逻辑与常数（420ms）逐字未动。
  var ctxCloseTimer: any = null;
  function openCtxPop() {
    if (ctxCloseTimer) { clearTimeout(ctxCloseTimer); ctxCloseTimer = null; }
    if (ctxPopEl.style.display === 'block') return;
    ctxPopEl.style.display = 'block';
    positionCtxPop();
    if (ctxDetail) renderCtxDetail(ctxDetail); // 先用上次真值垫一帧，等宿主回包再替换（避免闪空）
    vpost({ type: 'ctxQuery' });
    syncCtxTick(); // 弹层开着期间每秒跟一次真值（pi 的 percent 每轮都在动）
  }
  /** 弹层贴在**输入区上方**（不是底栏上方）：2026-11-05 用户截图实锤，原先 bottom:32px
   *  一开就把输入框右下角的发送按钮盖住，鼠标从页脚圆环往上挪去点发送，点到的是弹层。
   *  这里按输入区 + 底栏的实际高度定位，面板变高/输入框长高都自适。 */
  function positionCtxPop() {
    var comp = q('#composer');
    var bar = q('#bottombar');
    ctxPopEl.style.bottom = ((comp ? comp.offsetHeight : 0) + (bar ? bar.offsetHeight : 0) + 10) + 'px';
  }
  function closeCtxPopLater() {
    if (ctxCloseTimer) clearTimeout(ctxCloseTimer);
    ctxCloseTimer = setTimeout(function () {
      ctxCloseTimer = null;
      ctxPopEl.style.display = 'none';
      syncCtxTick();
    }, 420);
  }

  /** 一次性事件绑定（原来住在 main.ts 的 bindViewEvents）：先建页脚圆环结构，再绑弹层事件。
   *  调用点保持在 bindViewEvents 里原位置（替换原「页脚用量入口」结构那段）。 */
  function bind() {
    // 页脚用量入口：圆圈百分比（2026-11-05 用户指定样式）。结构一次建好，
    // applyState 每次只改 dashoffset/颜色/文字（不重建节点，否则过渡动画和 hover 都会断）
    usageEl.innerHTML = '<svg class="uring" viewBox="0 0 20 20" aria-hidden="true"><circle class="uring-t" cx="10" cy="10" r="8"></circle><circle class="uring-f" cx="10" cy="10" r="8" stroke-dasharray="50.27" stroke-dashoffset="50.27"></circle></svg><span class="utxt"></span>';
    ringFillEl = usageEl.querySelector('.uring-f');
    usageTxtEl = usageEl.querySelector('.utxt');
    usageEl.addEventListener('mouseenter', openCtxPop);
    usageEl.addEventListener('mouseleave', closeCtxPopLater);
    ctxPopEl.addEventListener('mouseenter', openCtxPop);
    ctxPopEl.addEventListener('mouseleave', closeCtxPopLater);
    cpCloseEl.addEventListener('click', function () { ctxPopEl.style.display = 'none'; syncCtxTick(); });
    // 滑块是**连续**的（0..1000 → [首档..窗口]），刻度只是三个预设点：
    // 事故（2026-11-05 用户「？？？」截图）：滑块曾按档位吸附，pi 默认 reserve 16K 时真值
    // 183.6K 被吸附到「拉满 200K」——旋钮在最右、数字却说 183.6K，自相矛盾。
    // 现在旋钮位置 = 真值位置，永不撒谎；想省事就点下面的刻度。
    cpRangeEl.addEventListener('input', function () {
      renderCtxDetail(ctxDetail, rangeToThreshold(Number(cpRangeEl.value)));
      markNearestTick(rangeToThreshold(Number(cpRangeEl.value)));
    });
    cpRangeEl.addEventListener('change', function () {
      if (!ctxDetail || !ctxDetail.window) return;
      var th = rangeToThreshold(Number(cpRangeEl.value));
      vpost({ type: 'ctxSetReserve', reserveTokens: Math.round(ctxDetail.window - th) });
    });
  }

  return {
    /** 事件绑定（bindViewEvents 调用）：页脚圆环结构 + hover/✕/滑块绑定 */
    bind: bind,
    /** state 帧到达：刷页脚圆环（分母口径与弹层一致） */
    refreshUsage: function (stats: any) { renderUsageRing(stats); },
    /** 宿主 ctxDetail 到达：真值帧（页脚圆环 + 弹层，若开着） */
    applyDetail: function (m: any) { renderCtxDetail(m); },
    /** busy 变化：1s 心跳的开关条件之一（弹层开着 ∪ 本会话在跑活） */
    setBusy: function (v: boolean) { ctxBusy = !!v; syncCtxTick(); },
    /** state/uiState 帧到达：弹层开着时补查一次（跟宿主真相走） */
    scheduleQuery: function () { scheduleCtxQuery(); },
    /** 关闭（✕ / Esc / 点消息区共用） */
    close: function () { ctxPopEl.style.display = 'none'; syncCtxTick(); },
    /** 弹层是否开着（Esc 判定） */
    isOpen: function () { return ctxPopEl.style.display === 'block'; },
    /** 视图销毁：停 1s 心跳（原 dispose 里的 stopCtxTick，其余定时器不归本模块管） */
    dispose: function () { stopCtxTick(); }
  };
}
