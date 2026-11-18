/**
 * 变更页（2026-11-05 上线；2026-11-21 从 webview/main.ts 整块拆出）：左文件清单
 * （+N/-M，顶部汇总相加）+ 右并排 diff。
 *
 * 数据面全在宿主（git/patch 逆向/pi 的 generateUnifiedPatch），这里零 git/磁盘访问，
 * 只解析 hunk 文本。打开时向宿主要一次（同轮改动宿主有缓存，反复开页不重算）。
 *
 * 为什么是 initChangesPage(deps) 而不是模块级单例：变更页是**每页签一个**覆盖层
 * （#chgpage 随 .session-view 克隆），清单/选中态也是每页签一份——各页签各看各的本轮改动。
 * 所以入口在 makeSessionView 里调一次，元素与数据都关在自己的闭包里；跨文件只从这里拿
 * 宿主真需要的那几个动作（open/close/apply/reset/hasPage/bind）。
 *
 * 行为红线：DOM id/class、CSS、消息协议（changesPageOpen / changesPage / changesList /
 * changesNativeDiff / changesRevert）一律不动——这是纯搬家。
 */
import { parseUnifiedDiff } from "../../src/domain/diffView";
import type { ChangesData, ViewState } from "../core/state";

export interface ChangesPageDeps {
  /** 本会话视图的状态容器（chgData / chgSel 住这里，每页签一份） */
  state: ViewState;
  /** 查本视图内的元素（原来 makeSessionView 里的 q()：ID 在各视图内重复，必须 scope 到视图） */
  q: (sel: string) => HTMLElement;
  /** 上行消息（原 vpost：显式带本视图 tabId） */
  post: (m: any) => void;
  /** i18n 文案表（宿主注入的整份字典） */
  lang: Record<string, any>;
  /** 建 DOM 的小工具（main.ts 的 el：textContent 安全写入） */
  el: (tag: string, cls?: string, text?: string) => HTMLElement;
}

export function initChangesPage(deps: ChangesPageDeps) {
  var state = deps.state;
  var q = deps.q;
  var vpost = deps.post;
  var L = deps.lang;
  var el = deps.el;

  // 变更页（2026-11-05）：页级覆盖层，随视图克隆——各页签各看各的本轮改动
  var chgPageEl = q('#chgpage'); var chgFilesEl = q('#chg-files'); var chgDiffEl = q('#chg-diff');
  var chgTotEl = q('#chg-tot'); var chgBackEl = q('#chg-back'); var chgSplitEl = q('#chg-split');

  // ── 变更页（2026-11-05）：左文件清单（+N/-M，顶部汇总相加）+ 右并排 diff ──
  // 数据面全在宿主（git/patch 逆向/pi 的 generateUnifiedPatch），这里零 git/磁盘访问，
  // 只解析 hunk 文本。打开时向宿主要一次（同轮改动宿主有缓存，反复开页不重算）。
  function openChgPage() {
    chgPageEl.style.display = 'flex';
    if (!state.chgData) {
      chgFilesEl.innerHTML = '';
      chgFilesEl.appendChild(el('div', 'chg-empty', L.chgPageLoading));
      chgDiffEl.innerHTML = '';
    }
    vpost({ type: 'changesPageOpen' });
  }
  function closeChgPage() { chgPageEl.style.display = 'none'; }
  /** 页是否开着（Esc 与页内返回共用同一判据，别各自读 style） */
  function hasPage() { return chgPageEl.style.display !== 'none'; }
  /** 清单作废（宿主 changesList 到达：清单变了，同轮 hunk 必变，下次打开重拉） */
  function resetChgData() { state.chgData = null; }
  function renderChgPage(data) {
    state.chgData = data;
    chgFilesEl.innerHTML = '';
    var files = (data && data.files) || [];
    if (!files.length) {
      chgTotEl.textContent = '';
      chgDiffEl.innerHTML = '';
      chgDiffEl.appendChild(el('div', 'chg-empty', L.chgPageEmpty));
      return;
    }
    // 顶部汇总：「相加」就是这个数——各文件 +/- 之和
    chgTotEl.innerHTML = '';
    chgTotEl.appendChild(el('span', 'chg-a', '+' + data.totalAdds));
    chgTotEl.appendChild(el('span', 'chg-x', '-' + data.totalDels));
    renderChgFiles(files);
    var want = state.chgSel;
    var hit = false;
    for (var k = 0; k < files.length; k++) if (files[k].path === want) hit = true;
    selectChgFile(hit ? want : files[0].path);
  }
  /** 左侧清单行（文件名 + 该文件 +/-）——纯 DOM，点击切选中文件 */
  function renderChgFiles(files) {
    for (var i = 0; i < files.length; i++) {
      (function (f) {
        var row = el('div', 'chg-f');
        row.setAttribute('data-p', f.path);
        var base = String(f.rel).split('/').pop() || f.rel;
        row.title = f.rel + (f.note ? '\n' + f.note : '');
        row.appendChild(el('span', 'chg-n', base));
        var counts = el('span', 'chg-c');
        if (f.adds) counts.appendChild(el('span', 'chg-a', '+' + f.adds));
        // 删除数为 0 不画（截图同款：只有新增的文件不挂 -0）
        if (f.dels) counts.appendChild(el('span', 'chg-x', '-' + f.dels));
        row.appendChild(counts);
        row.onclick = function () { selectChgFile(f.path); };
        chgFilesEl.appendChild(row);
      })(files[i]);
    }
  }
  function selectChgFile(p) {
    if (!state.chgData || !state.chgData.files) return;
    state.chgSel = p;
    var rows = chgFilesEl.children;
    for (var i = 0; i < rows.length; i++) (rows[i] as HTMLElement).classList.toggle('sel', rows[i].getAttribute('data-p') === p);
    var f = null;
    for (var k = 0; k < state.chgData.files.length; k++) if (state.chgData.files[k].path === p) f = state.chgData.files[k];
    chgDiffEl.innerHTML = '';
    if (!f) return;
    var head = el('div', 'chg-dhead');
    head.appendChild(el('span', 'chg-dpath', f.rel));
    if (f.preexisting) head.appendChild(el('span', 'chg-dpre', L.chgPreexisting));
    var hc = el('span', 'chg-c');
    if (f.adds) hc.appendChild(el('span', 'chg-a', '+' + f.adds));
    if (f.dels) hc.appendChild(el('span', 'chg-x', '-' + f.dels));
    head.appendChild(hc);
    // 页内动作（顶4）：原生 diff / 还原——两个能力都复用 QuickPick 那条链路，不另写一套。
    // 显不显示由宿主算好的资格决定（canDiff/canRevert），webview 不自己判
    if (f.canDiff) {
      var bd = el('button', 'chg-act', L.chgPageNative);
      bd.onclick = function () { vpost({ type: 'changesNativeDiff', path: f.path }); };
      head.appendChild(bd);
    }
    if (f.canRevert) {
      var br = el('button', 'chg-act chg-act-danger', L.chgActRevert);
      br.onclick = function () { vpost({ type: 'changesRevert', path: f.path }); };
      head.appendChild(br);
    }
    chgDiffEl.appendChild(head);
    renderDiffInto(chgDiffEl, f);
  }
  /** 单侧行：行号 + 代码（长行不裁：由这一格自己的横向滚动条承接） */
  function chgSide(cell, kind) {
    var side = el('div', 'chg-side' + (cell ? ' ' + kind : ''));
    side.appendChild(el('span', 'chg-ln', cell ? String(cell.no) : ''));
    side.appendChild(el('span', 'chg-code', cell ? String(cell.text) : ''));
    return side;
  }
  /** 并排渲染：宿主已把每个文件的 diff 剥成 hunk-only，行配对/行号由纯逻辑叶
   *  parseUnifiedDiff 算好（domain/diffView.ts，有裸跑用例），这里只做 DiffRow → DOM。
   *
   *  滚动模型对齐 VS Code（2026-11-05 用户实测口径「vsc 有两个横向滚动条，一个动另一个也跟着动」）：
   *  左右各一格独立滚动（各有一条自己的横向滚动条，长行只撑开自己那格，另一侧不会跑出屏幕），
   *  拖动任一格时双向同步 scrollTop/scrollLeft。行高等高靠同一个 line-height + 单行 pre 保证。 */
  function renderDiffInto(host, file) {
    if (file.note) { host.appendChild(el('div', 'chg-empty', file.note)); return; }
    if (!file.diff) { host.appendChild(el('div', 'chg-empty', L.chgPageNoDiff)); return; }
    var rows = parseUnifiedDiff(String(file.diff));
    if (!rows.length) { host.appendChild(el('div', 'chg-empty', L.chgPageNoDiff)); return; }
    var panes = el('div', 'chg-panes');
    var left = el('div', 'chg-pane');
    var right = el('div', 'chg-pane');
    panes.appendChild(left);
    panes.appendChild(right);
    var fragL = document.createDocumentFragment();
    var fragR = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === 'hunk') {
        // hunk 头两格各一份（等高才能对齐行；只画一份另一侧就会整体错行）
        fragL.appendChild(el('div', 'chg-hunk', r.text));
        fragR.appendChild(el('div', 'chg-hunk', r.text));
        continue;
      }
      fragL.appendChild(chgSide(r.left, r.changed ? 'del' : 'ctx'));
      fragR.appendChild(chgSide(r.right, r.changed ? 'ins' : 'ctx'));
    }
    left.appendChild(fragL);
    right.appendChild(fragR);
    // 双向滚动同步：谁被拖动谁是主，另一格跟到同位置（赋同值不会重触发自己的 scroll）
    var syncing = false;
    function link(from, to) {
      from.addEventListener('scroll', function () {
        if (syncing) return;
        syncing = true;
        to.scrollTop = from.scrollTop;
        to.scrollLeft = from.scrollLeft;
        syncing = false;
      }, { passive: true });
    }
    link(left, right);
    link(right, left);
    host.appendChild(panes);
  }

  /** 一次性事件绑定（原来住在 main.ts 的 bindViewEvents 开头两段）。
   *  调用点保持在 bindViewEvents 里的原位置：绑定顺序/时机与拆分前一致。 */
  function bind() {
    // 变更页：返回按钮（页头）+ 标题/返回文案（i18n）
    chgBackEl.textContent = '↖ ' + L.chgPageBack;
    chgBackEl.onclick = closeChgPage;
    // 左清单宽度可拖（2026-11-05 用户「这块不能拉动吗」）：mousemove/mouseup 只在拖动期间挂在
    // document 上，松手即摘——常驻的话每个页签视图都会留一份监听，dispose 也带不走
    (function () {
      var dragging = false;
      function onMove(e) {
        if (!dragging) return;
        var box = chgPageEl.getBoundingClientRect();
        // 夹在 140px ~ (页宽-160px)：给自己留一列可见的 diff，别拖到只剩滚动条
        var w = Math.max(140, Math.min(e.clientX - box.left, box.width - 160));
        chgFilesEl.style.width = w + 'px';
      }
      function onUp() {
        if (!dragging) return;
        dragging = false;
        chgSplitEl.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      chgSplitEl.addEventListener('mousedown', function (e) {
        dragging = true;
        chgSplitEl.classList.add('dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });
    })();
  }

  return {
    /** 打开变更页（顶部变更条的「查看」按钮 / Esc 外的一切入口） */
    open: openChgPage,
    /** 关闭（页内返回 / Esc） */
    close: closeChgPage,
    /** 页是否开着 */
    hasPage: hasPage,
    /** 宿主 changesPage 到达：全量重渲（清单 + 当前选中文件的 diff） */
    apply: function (data: ChangesData) { renderChgPage(data); },
    /** 宿主 changesList 到达：清掉本页数据（清单变了，hunk 必变） */
    reset: resetChgData,
    /** 事件绑定（bindViewEvents 调用） */
    bind: bind
  };
}
