/**
 * 最后一问「粘性气泡」（2026-11-23 第 5 刀子刀 5e，从 webview/main.ts 整块拆出）：
 * updateStickyChip / stickyWants / applySticky / observeSticky + 状态 stickyQ / stickyIO。
 * 最后一条 user 气泡滚到顶后钉住（position:sticky）并把超 3 行的内容折起，chip 可展开/收起。
 *
 * 为什么是 initSticky(deps)：本模块是**每页签一套**的视图成员（每棵消息树一个 IntersectionObserver
 * 实例、一个「当前最后一问」引用）。入口在 makeSessionView 里装配一次；依赖只有两个——root
 * （消息区根：IO 的 root + 钉住判据用的滚动坐标系）与 lang（chip 文案 stickyExpand/stickyCollapse）。
 *
 * ★ 红线 R7（scroll ↔ applySticky 只能有一条路）：scroll 留 main.ts，它只经本模块的 pinCheck()
 *   调进来（内容变长后补一次钉住判定）；addUser 在 features/messageList.ts，经 deps 拿 scroll。
 *   stickyQ 全仓**只此一处声明**——别处再存一份 = 「切页签回来钉错气泡 / 钉住态来回闪」原样回归。
 *
 * ★ 追加二/三/四/五 四轮闪烁修正的判据（below ≥ 一屏才允许钉、dScroll 回落必须能被 dShrink
 *   收缩解释）是用户实测三轮修出来的止血，注释整段随逻辑搬来，「看起来能简化」一行都不许动。
 *
 * 行为红线：DOM class（sticky-q / pinned / sticky-open / sticky-sent）、attr(data-st)、CSS 一律
 * 不动；这是纯搬家，逐字核对见 reports/REPORT-t41.md。
 */

export interface StickyDeps {
  /** 消息区根（IO 的观察根 + 钉住判据的滚动坐标系） */
  root: HTMLElement;
  /** i18n 文案表（chip 文案） */
  lang: Record<string, any>;
}

export function initSticky(deps: StickyDeps) {
  var root = deps.root;
  var L = deps.lang;

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
  /** 新 user 气泡接管钉住角色（原 addUser 里的「旧泡摘态 + 换引用」四行）：
   *  工单28 追加（用户直令 2026-09-20）：迁移时旧 bubble 连 sticky-open/pinned 状态一起摘、
   *  旧 sentinel 一并 unobserve；新 bubble 从未折叠原位态起步（钉住后才折，超 3 行才出 chip）。
   *  调用点：features/messageList.ts 的 addUser（重绘历史时同一路径，循环末尾自然只剩最后一条）。 */
  function adoptSticky(b: any) {
    if (stickyQ) {
      stickyQ.classList.remove('sticky-q'); stickyQ.classList.remove('sticky-open'); stickyQ.classList.remove('pinned');
      if (stickyIO && (stickyQ as any)._sent) stickyIO.unobserve((stickyQ as any)._sent);
    }
    stickyQ = b; // sticky-q 由 applySticky 在「可钉」时加（追加三：短内容不钉，避免振荡）
  }
  /** 滚动跟随点（scroll 留 main.ts，R7）：追加三——回复变长后补一次钉住判定
   *（IO 只在 sentinel 越界瞬间回调，内容从短到长时不会再触发） */
  function pinCheck() {
    if (stickyQ && (stickyQ as any)._sent && !stickyQ.classList.contains('pinned')) applySticky(stickyQ);
  }

  return {
    /** chip 文案与显隐（超 3 行才有） */
    updateStickyChip: updateStickyChip,
    /** 新 sentinel/bubble 配对并开始观察 */
    observeSticky: observeSticky,
    /** 换「最后一问」（旧泡摘态、旧 sentinel 摘观察） */
    adoptSticky: adoptSticky,
    /** ★ scroll 的唯一入口（R7）：内容变长后补一次钉住判定 */
    pinCheck: pinCheck
  };
}
