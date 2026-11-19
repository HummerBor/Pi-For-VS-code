/**
 * 右缘「消息大纲轨道」（2026-11-24 第 5 刀子刀 5g，从 webview/main.ts 整块拆出）：
 * outlineRebuild / outlineResize / olText / olScan / olSpy + 状态 olAnchors / olSpyQueued /
 * olSuspend / olRO，以及挂在 root 上的 scroll spy 与 ResizeObserver。
 *
 * 用户直令 2026-09-21（对齐 DeepSeek/Codex web）：右缘一列短横线 = 每条用户消息一个锚点；
 * hover 错峰展开文字列表、点击平滑跳转+闪烁、滚动时当前条平滑跟随。纯视图内 DOM 零协议新增；
 * 锚点即 .bubble.user（addUser 单点打标，历史重绘同路径）。
 *
 * 为什么是 initOutline(deps)：本模块是**每页签一套**的视图成员（一棵 outlineEl、一个
 * ResizeObserver 实例、一份锚点表）。入口在 makeSessionView 里装配一次。
 *
 * ★ 两条监听别混（scout F3）：root.scroll 上挂两类监听——① 跟随贴底（followingEnd 判定）**留
 *   main.ts**；② 本模块的 olSpy（当前条判定）。用途不同、判定不同，禁止合并或换顺序。
 *
 * ★ olScan 只读队列条 DOM（.q-item[data-qid]）：排队中的用户消息也进轨道（发出即有锚点）。
 *   队列条状态归队列域，本模块只用 deps.q() 做只读查询——别把 queuedItems 之类搬进来。
 *
 * ★ olRO 随本模块走（不许留孤儿）：init 内建一次、observe(root)；页签视图销毁走 dispose()
 *   断开。RO 持有 root 强引用，不 disconnect 会把整棵已摘除的 DOM 树拖住（每关一个页签漏一棵）。
 *
 * 语义红线（用户逐条实测纠过，别「优化」）：锚点采样步长、hover 错峰步长 = 离选中条的距离
 * 且只错峰不位移、点击跳转闪烁后用定时器摘类（不是 animationend）、切页签回来不重放闪烁、
 * olSuspend 挂起重绘期逐条重建（O(N²)）。逐字核对见 reports/REPORT-t42.md。
 */

export interface OutlineDeps {
  /** 消息区根（RO 的观察对象 + 滚动坐标系 + scroll spy 挂载点） */
  root: HTMLElement;
  /** 本页签的大纲轨道容器（#outline，随视图克隆） */
  outlineEl: HTMLElement;
  /** 视图内元素查询：olScan 用它只读查队列条 pill（队列条状态不归本模块） */
  q: (sel: string) => HTMLElement;
  /** 建 DOM 工具（main.ts 的 el(tag, cls, text?)） */
  el: (tag: string, cls: string, text?: string) => HTMLElement;
  /** 本视图是否活动页签（后台视图 display:none 无布局，不量不判，切回时 RO 会再调） */
  isActiveView: () => boolean;
}

export function initOutline(deps: OutlineDeps) {
  var root = deps.root;
  var outlineEl = deps.outlineEl;
  var q = deps.q;
  var el = deps.el;
  var isActiveView = deps.isActiveView;

  // ── 消息大纲轨道（用户直令 2026-09-21，对齐 DeepSeek/Codex web）：右缘一列短横线 =
  // 每条用户消息一个锚点；hover 错峰展开文字列表、点击平滑跳转+闪烁、滚动时当前条平滑跟随。
  // 纯视图内 DOM 零协议新增；锚点即 .bubble.user（addUser 单点打标，历史重绘同路径）。
  // 当前条判定口径：视口**中线**（root.scrollTop + root.offsetTop + root.clientHeight / 2，见 olSpy）
  // 以上最近一条——不是上 1/3 线。选中线与点击跳转的 block:'center' 同一个中线，所以点中条必在线上；
  // 拉到底时最后一条必中。要改成 1/3 线属行为变更，需产品拍板，别照旧注释改代码。
  // （outlineResize 里的 1/3 是轨道 maxHeight 上限，与当前条判定无关，别混读）
  var olAnchors: { b: HTMLElement; row: HTMLElement }[] = [];
  var olSpyQueued = false; // rAF 合顿滚动事件，一帧一次布局读
  var olSuspend = false; // renderAll 逐条 addUser 时挂起（每条全量重建 = O(N²)，重绘完一次建好）
  /** 大纲挂起开关（olSuspend 属大纲域、住本模块）：重绘在 features/messageList.ts 里
   *  逐条 addUser 前后置位，写回经此口（R12 ③：注入 accessor，不复制状态） */
  function setOlSuspend(v: boolean) { olSuspend = v; }
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
    if (!isActiveView()) return; // 后台视图无布局，切回时 RO 会再调
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
    var pills = q('#queuebar').querySelectorAll('.q-item[data-qid]');
    for (var p = 0; p < pills.length; p++) {
      var qt = pills[p].querySelector('.q-text');
      out.push({ b: pills[p] as HTMLElement, row: null as any, queued: true, _t: qt ? qt.textContent || '' : '' } as any);
    }
    var bs = root.querySelectorAll('.bubble.user');
    for (var i = 0; i < bs.length; i++) out.push({ b: bs[i] as HTMLElement, row: null as any, queued: false } as any);
    return out;
  }
  function olSpy() {
    if (!isActiveView()) return; // 后台视图无布局，切回时 RO 会再调
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

  /** 页签视图销毁（main.ts 的 dispose）：RO 必须断开，否则被观察的 root 连整棵 DOM 一起留活 */
  function dispose() {
    olRO.disconnect();
    olAnchors = [];
  }

  return {
    /** 全量重建轨道（addUser 新增 / renderAll 重绘出口） */
    outlineRebuild: outlineRebuild,
    /** 重绘期挂起开关（messageList 逐条 addUser 前后置位，防 O(N²)） */
    setOlSuspend: setOlSuspend,
    /** 页签视图销毁时调用（断开 ResizeObserver） */
    dispose: dispose
  };
}
