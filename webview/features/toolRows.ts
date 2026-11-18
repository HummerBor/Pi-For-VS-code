/**
 * 工具调用行（2026-11-23 第 5 刀子刀 5c，从 webview/main.ts 整块拆出）：
 * toolStart / toolEnd + 配套状态 toolEls / lastToolGroup —— 每个工具一行「工具名 + IN/OUT」，
 * 同名连续行在 start 时成组、end 时并入组头挂 ×N。
 *
 * 为什么是 initToolRows(deps)：本模块是**每页签一套**的视图成员（每个 SessionView 一棵消息树，
 * 工具行挂在自己的 root 下，toolEls/lastToolGroup 也每树一份）。入口在 makeSessionView 里装配
 * 一次；依赖只有六个——root（消息区根）、el（建 DOM）、ico（chev 箭头）、linkify
 * （features/linkify.ts 的基座：IN/OUT 文本里的路径可点）、lang（i18n：L.toolTruncated）、
 * scroll（滚动跟随仍住 main.ts，模块只调不持有，与 liveStream 同款红线）。
 *
 * ★ 红线一（R11，pdet 不跨模块）：占位行「生成参数 (N 字符)」的进度节点 pdet 属 live 流式域，
 *   5b 已把它独占在 features/liveStream.ts，外部只经 setPDet() 写。本模块**没有 pdet**，也不许
 *   为「顺便更新进度」再存一份——两份必然写进孤儿节点（用户看不到 =「工具行跑着跑着不再动」）。
 *
 * ★ 红线二（成组语义一字不改）：成组判定在 toolStart（此刻行序=事件序，并行批次乱序完成时相邻
 *   判定才成立）、toolEnd 按行反查组、内容并进组头盒后**隐藏**自身行/盒不 remove（尾链永不断）、
 *   lastToolGroup 的追加时机、组头 ×N 徽标重挂、点开展开全量 OUT —— 全部逐字搬走，逐字核对见
 *   reports/REPORT-t40.md。
 *
 * 状态归属：toolEls / lastToolGroup 本模块独占（原 main.ts 视图闭包成员）。renderAll 整树重绘前
 * 要清空旧引用，经出口 resetToolRows() 做，外部不再持有这两个变量。
 *
 * 行为红线：DOM tag/class（tool run / t-dot / t-name / t-detail / t-arrow / tool-box / tb-row /
 * tb-tag / tb-val / t-count）、CSS、消息协议一律不动；这是纯搬家。
 */

export interface ToolRowsDeps {
  /** 消息区根（原 makeSessionView 的 root：工具行与内容盒往这里挂） */
  root: HTMLElement;
  /** 建 DOM 工具（原 el：textContent 安全写入） */
  el: (tag: string, cls: string, text?: string) => HTMLElement;
  /** 图标（chev 折叠箭头） */
  ico: (name: string, size?: number) => string;
  /** 文件路径/符号可点（features/linkify.ts 的 linkify：IN 摘要与 OUT 文本都过一遍） */
  linkify: (root: HTMLElement | null) => void;
  /** i18n 文案表 */
  lang: Record<string, any>;
  /** ★ 滚动跟随仍住 main.ts（它调 applySticky(stickyQ)），本模块只调不持有 */
  scroll: () => void;
}

export function initToolRows(deps: ToolRowsDeps) {
  var root = deps.root;
  var el = deps.el;
  var ico = deps.ico;
  var linkify = deps.linkify;
  var L = deps.lang;
  var scroll = deps.scroll;

  var toolEls: Record<string, any> = {};
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
  /** 整树重绘前清空工具行索引（renderAll 调用；退出/换会话同理走重绘）。
   *  toolEls 置空 + lastToolGroup 置 null：旧 DOM 已全换，旧引用必须作废，否则下一次
   *  start 的相邻判定会拿已摘出文档的旧节点比较（nextElementSibling 恒 null）。
   *  注：相邻判定本身也兑底（见上方成组注释「重绘后旧引用 nextElementSibling 为 null 兑底」），
   *  这里显式清一层，两道守卫都在。 */
  function resetToolRows() {
    toolEls = {};
    lastToolGroup = null; // 重绘后 DOM 全换，旧引用作废（相邻判定本身也兕底，这里显式清）
  }

  return { toolStart: toolStart, toolEnd: toolEnd, resetToolRows: resetToolRows };
}
