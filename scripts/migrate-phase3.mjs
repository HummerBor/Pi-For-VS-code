// 三期整树搬迁机械搬运脚本（交接 4 六步法，一次性使用后可删）。
// 原则：函数体逐字符不动——按行区间从旧 main.ts 抽取拼接，只写胶水；
// 每段带首行断言，行号错位立即报错退出，不产出坏文件。
import { readFileSync, writeFileSync } from 'fs';

const SRC = 'webview/main.ts';
const OUT = 'webview/main.ts.new';
const lines = readFileSync(SRC, 'utf8').split('\n');
// 行区间 1-indexed 闭区间
const seg = (a, b, expectFirst, expectLast) => {
  const first = (lines[a - 1] || '').trim(), last = (lines[b - 1] || '').trim();
  if (expectFirst && !first.includes(expectFirst)) throw new Error(`seg(${a},${b}) 首行断言失败: "${first}" 不含 "${expectFirst}"`);
  if (expectLast && !last.includes(expectLast)) throw new Error(`seg(${a},${b}) 末行断言失败: "${last}" 不含 "${expectLast}"`);
  return lines.slice(a - 1, b).join('\n');
};
// 搬入工厂的段落统一做文本变换（语义修改点③⑤⑥，逐字符替换有限个固定串）
const tx = (text, ...pairs) => {
  let t = text;
  for (const [from, to] of pairs) t = t.split(from).join(to); // 宽容：目标不存在则原样（语义点是否齐靠产出后 grep 验证）
  return t;
};
const VPOST = ['vscode.postMessage(', 'vpost('];

const out = [];
const g = (s) => out.push(s);

// ── 页面级头部（1-28：头注释/i18n/imports/vscodeApi/tabId/vscode 桥）──
out.push(seg(1, 27, '/**'));

// ── 工厂（替换旧 29-148 的换镜机制整块）──
g(`  // ── 三期整树搬迁（交接 4 六步法）：每页签一个完全隔离的 SessionView 工厂闭包 ──
  // 自己的 DOM/状态/定时器/输入框；routeMsg 经 viewFor(tid).handleMsg 一行直达。换镜机制
  // （useTab/assignMirrors/saveMirrors/curTabId/bgMode）整体退役——镜像漂移（白 Working/
  // 串会话两类事故的根因）在结构上不可能再发生。函数体逐字符未动（scripts/migrate-phase3.mjs
  // 机械搬运），语义修改仅六处：①scroll bgMode→id 判定 ②applyState 同 ③上行改 vpost 显式带
  // 自己 tabId ④scheduleStream/scheduleRender 去换镜舞蹈 ⑤built 直写闭包 ⑥codeCtx 页面级
  // 数据 + renderCodeChipAll 循环各视图。重载实测重点见 BUILDER.md 交接 4。
  function makeSessionView(id: string) {
    var view = document.createElement('div');
    view.className = 'session-view' + (id === activeTabId ? '' : ' offview');
    view.innerHTML = protoHTML;
    sessionArea.appendChild(view);
    var root = view.querySelector('.msg-root') as HTMLElement;
    // 视图内上行显式带自己的 tabId（不再借活动页签打标——换镜退役后归属唯一）
    function vpost(m: any) { if (m.tabId === undefined) m.tabId = id; vscodeApi.postMessage(m); }`);
out.push(seg(35, 42, 'var toolEls', 'var banner')); // 每页签状态组原样入厂
g(`    var built = false; // uiState/render 快照是否已建树（activateTab 按此决定要不要向宿主要快照）`);
out.push(tx(seg(150, 180, 'function bindViewEvents', '}'), VPOST,
  ['codeOn = !codeOn; renderCodeChip();', 'codeOn = !codeOn; renderCodeChipAll();']));
g(`    // ＋菜单文档级关闭监听：每视图一份各关各的（原全局监听读镜像，随换镜退役）
    document.addEventListener('click', function (e) { var tgt = e.target as Node; if (!plusmenuEl.contains(tgt) && tgt !== attachEl) plusmenuEl.style.display = 'none'; });`);
out.push(seg(286, 290, 'var sgList', 'var slashMenuOn')); // suggest 键盘态随视图
out.push(seg(293, 311, '附件无感去重', '}')); // hasImg/hasFile（读写 pendingImages/Files）
out.push(seg(313, 319, 'function renderCodeChip', '}'));
out.push(seg(327, 340, '工单十七', '仅跟随时拉底')); // followingEnd/suppressScroll + 教训注释
out.push(tx(seg(341, 394, 'function scroll', '}'),
  ['if (bgMode) return;', 'if (id !== activeTabId) return;'])); // 三期①
g(`  /** 状态栏 DOM 重渲：直接渲本页签真相（三期后无镜像；ticker 闭包只写自己捕获的元素，
   *  白 Working 事故注释随 renderBusyUi 函数体保留） */`);
out.push(seg(402, 469, 'function renderBusyUi', '}')); // renderBusyUi/setBusy/setCompacting
out.push(tx(seg(471, 720, '轻量 Markdown', '}'), VPOST)); // renderInline..streamTick
g(`  function scheduleStream() {
    // 三期④：换镜舞蹈退役——timer 与回调都住自己视图闭包，触发时元素/状态天然就是自己的
    if (!liveRTimer) liveRTimer = setTimeout(function () {
      liveRTimer = null;
      if (liveParts) for (var k in liveParts) { var p = liveParts[k]; if (p && p.kind === 'text' && !p.done && p.buf.length > p.doneLen) streamTick(p); }
      scroll();
    }, 100);
  }`);
out.push(tx(seg(734, 805, 'function appendDelta', '}'), VPOST)); // appendDelta..toolEnd
out.push(seg(1048, 1048, 'function notice', null));
out.push(tx(seg(1049, 1445, 'function textOf', '}'), VPOST,
  ['if (!bgMode) {', 'if (id === activeTabId) {'])); // textOf..send（含三期② applyState）
out.push(tx(seg(1457, 1485, 'function autoSize', '}'), VPOST)); // autoSize..inputPaste
out.push(seg(1489, 1493, '重绘/续接排队', 'renderTimer')); // renderPending/liveSyncPending/renderTimer 声明
g(`  function scheduleRender() {
    // 三期④：换镜舞蹈退役（原「先换回发起页签再重绘」——闭包天然绑定，无需换）
    if (!renderTimer) renderTimer = setTimeout(function () {
      renderTimer = null;
      flushRender();
    }, 0);
  }`);
out.push(seg(1540, 1545, 'function flushRender', '}'));
out.push(seg(1549, 1571, 'function applyLiveSync', '}'));
out.push(tx(seg(1574, 1670, 'function handleMsg', '}'),
  ['if (tabCtx[curTabId]) tabCtx[curTabId].built = true;', 'built = true;'], // 三期⑤ ×2
  ["{ codeCtx = m.ctx; renderCodeChip(); }", "{ codeCtx = m.ctx; renderCodeChipAll(); }"])); // 三期⑥
g(`    return {
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
  }`);

// ── 页面级余部（原样保留的区间）──
out.push(seg(43, 50, 'var activeTabId', "sessionArea.innerHTML"));
out.push(seg(182, 276, '统一 SVG', null)); // 图标/工具函数/头部声明/.fp 委托
out.push(seg(278, 285, '历史会话', 'pickTip(welcomeEl)'));
out.push(seg(291, 292, 'var slashCmds', 'var workspaceFiles')); // 页面级缓存（闭包可写）
out.push(seg(321, 326, 'function el(', '}'));
out.push(seg(806, 1039, '子 agent 监控', '}, 1000);')); // 浮窗簇（subMonUpdate 死代码不搬=删除）
out.push(seg(1446, 1455, '下区控件监听', 'tabNew'));
out.push(seg(1487, 1488, 'dragover', 'drop')); // drop 行后续 edit 改路由到活动视图
out.push(seg(1506, 1519, '就被冲掉', '}')); // pendingStream/deferDuringRender/drainPendingStream
out.push(seg(1672, 1767, '页签切换（刀5）', '}')); // applyTabSubState/activateTab/renderTabs/handleTabs（后续 edit 改造）
out.push(seg(1769, lines.length, "window.addEventListener('message'", null)); // 收尾

writeFileSync(OUT, out.join('\n') + '\n');
console.log('OK ->', OUT, out.join('\n').split('\n').length, 'lines');
