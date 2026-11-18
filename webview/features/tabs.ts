/**
 * 页签与路由（2026-11-26 第 6 刀子刀 6a，从 webview/main.ts 整块拆出）：
 * views 表（每页签一个 SessionView）+ 视图路由（routeMsg/viewFor/renderCodeChipAll）+
 * 页签切换/标签条/宿主清单（activateTab/renderTabs/handleTabs）+ 两个页面级监听
 * （document Esc 关页、window message 入口）。
 *
 * 为什么是 initTabs(deps)：views 是**页面级唯一**的视图注册表（页签 id → 视图实例），
 * 路由、页签切换、宿主清单、Esc 关页四处都要它；搬进本模块后 main.ts 不再持有同名变量
 * （R20：tabId 的两个写点 activateTab / routeMsg 也一并归到本模块——跨文件双写就会重演
 * 「消息打到别的页签」）。
 *
 * ★ 红线一（R16 判序契约，别重排）：window.message 里 auth / tabs / subagentUpdate /
 *   subagentLedger / duck / panelInfo 六类「页签过滤前截获」的分支必须保持原位置原顺序、
 *   各自 return——后台页签的帧虽不渲染但必须缓存（subagent*），页面级覆盖层与页签无关
 *   （auth / duck / panelInfo）。任何重排都会让后台页签丢帧或串台。
 * ★ 红线二（语义零改）：Esc 先关浮层（上下文用量弹层）再关整页；renderTabs 的选中/busy/
 *   未读口径；activateTab 的 offview 口径（show(vid === tid) O(1) 换可见性，零重渲零重拉）。
 *   逐字核对与逐条差异理由见 reports/REPORT-t44.md。
 * ★ 红线三（R18 元素查询纪律）：本模块只碰页面级元素 #tabbar（不在 .session-view 内，
 *   不随页签克隆）；视图内元素一律经视图方法访问，禁止 document.getElementById。
 *
 * 装配时机：initTabs 在 main.ts 原 Esc 监听的位置调用（早于凭证页 keydown 的注册），
 * 故页签元素/子 agent 浮窗等「初始化更晚」的页面级依赖一律以 getter / 回调注入。
 */
import type { HostToWebviewTagged, TabsMsg, TabInfo } from "../../src/core/protocol";
import { getActiveTabId, setActiveTabId } from "../core/state";

export interface TabsDeps {
  /** 建视图（main.ts 的 makeSessionView；函数声明 → initTabs 装配时已提升） */
  makeView: (id: string) => any;
  /** i18n 文案表（main.ts 的 L） */
  lang: Record<string, any>;
  /** 上行消息（原 vscode.postMessage：带活动页签 tabId 打标） */
  post: (m: any) => void;
  /** 建 DOM 的小工具（main.ts 的 el：textContent 安全写入） */
  el: (tag: string, cls?: string, text?: string) => HTMLElement;
  /** 图标集查询（main.ts 的 ico：名字 → svg 串） */
  ico: (name: string, size?: number) => string;
  /** 标题截断（main.ts 的 shorten） */
  shorten: (s: string, max: number) => string;
  /** 页头会话标题元素（页面级；初始化晚于本模块装配 → getter） */
  getSessionEl: () => HTMLElement;
  /** 子 agent 浮窗随页签切换（原 subDock.applyTab；subDock 初始化晚于本模块装配 → 转调） */
  applySubTab: (tid: string) => void;
  /** 子 agent 帧（原 subDock.handleUpdate）：页签过滤前截获，后台页签也要缓存 */
  subagentUpdate: (m: any) => void;
  /** 台账行（原 subDock.setLedger）：全局推送无页签归属 */
  subagentLedger: (rows: any[]) => void;
  /** 凭证配置页（页面级覆盖层，先于 tabId 过滤截获） */
  showAuthPanel: () => void;
  renderAuthProviders: (list: any[]) => void;
  /** 鸭子换图（页面级，图源与页签无关，不过路由） */
  applyDuck: (uri: string) => void;
  /** webview state 快照（原 vscodeApi.setState：panelInfo 存 tabKey） */
  setWebviewState: (s: unknown) => void;
}

export interface TabsApi {
  viewFor: (tid: string) => any;
  renderCodeChipAll: () => void;
  routeMsg: (m: HostToWebviewTagged) => void;
  handleTabs: (m: TabsMsg) => void;
}

var views: Record<string, any> = {};
var tabsList: TabInfo[] = [];
// 上行消息打标用的活动页签：两个写点（routeMsg / activateTab）都在本模块（R20）；
// main.ts 的 vscode.postMessage 经 getTabTag() 读它
var tabId: string | null = null;

/** 当前活动页签（main.ts 的消息打标口读这个，替代原先 main.ts 里的同名变量） */
export function getTabTag(): string | null { return tabId; }

/** 宿主页签清单（唯一事实源在宿主；main.ts 的 applyState 兑底页头标题时读这个） */
export function getTabsList(): TabInfo[] { return tabsList; }

export function initTabs(deps: TabsDeps): TabsApi {
  var L = deps.lang;
  var post = deps.post;
  var el = deps.el;
  var ico = deps.ico;
  var shorten = deps.shorten;
  var getSessionEl = deps.getSessionEl;
  var applySubTab = deps.applySubTab;
  var subagentUpdate = deps.subagentUpdate;
  var subagentLedger = deps.subagentLedger;
  var showAuthPanel = deps.showAuthPanel;
  var renderAuthProviders = deps.renderAuthProviders;
  var applyDuck = deps.applyDuck;
  var setWebviewState = deps.setWebviewState;
  var makeSessionView = deps.makeView;
  var tabbarEl = document.getElementById('tabbar') as HTMLElement;

  // 变更页 Esc 关页（焦点不在输入框时的兑底：点了清单/diff 后焦点不在 composer）
  document.addEventListener('keydown', function (e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.isComposing || getActiveTabId() === null) return;
    var v = views[getActiveTabId()];
    // Esc 先关浮层（上下文用量弹层），没有浮层才关整页
    if (v && v.isCtxPopOpen()) { v.closeCtxPop(); return; }
    if (v && v.hasPage()) v.closePage();
  });
  function viewFor(tid: string) { return views[tid] || (views[tid] = makeSessionView(tid)); }
  /** codeCtx 是页面级数据：变更时循环各视图重渲 chip（三期⑥） */
  function renderCodeChipAll() { for (var vid in views) views[vid].renderCodeChip(); }
  /** 消息路由（三期）：后台只挡焦点类，其余各归各的视图——串写结构上不可能 */
  function routeMsg(m: HostToWebviewTagged) {
    var tid = m.tabId !== undefined ? m.tabId : getActiveTabId();
    if (tid === null || tid === undefined) return;
    if (getActiveTabId() === null) { setActiveTabId(tid); tabId = tid; }
    if (tid !== getActiveTabId() && m.type === 'fillInput') return; // 后台页签只挡焦点类（回填+focus）
    viewFor(tid).handleMsg(m);
  }
  /** 页签切换（刀5）：本地只换芯片高亮，内容现场由宿主 postUiState 重拉（pi 会话=唯一真相，
   *  webview 零影子状态——切回页签丢失现场在架构上不可能，因为根本不存在本地副本） */
  /** 页签切换（工单24 架构归位二期）：整个下区视图换可见性 O(1)。每个控件的实时状态都已在
   *  各自视图里活渲染（后台也一样），这里没有任何重渲——只有页头会话标题（页面级）和
   *  代码上下文 chip（页面级数据）需要补一下；跟随标志为真则补拉底（后台滚不动，见 scroll） */
  function activateTab(tid: string) {
    if (getActiveTabId() === tid) { renderTabs(); return; }
    setActiveTabId(tid); tabId = tid;
    var v = viewFor(tid); // 三期：闭包原始值不走对象属性，必须方法访问器
    for (var vid in views) views[vid].show(vid === tid); // 换可见性 O(1)，零重渲零重拉
    // 页头会话标题是页面级，切页签时从宿主清单对齐（会话名即标签题）
    for (var ti = 0; ti < tabsList.length; ti++) {
      if (tabsList[ti].id === tid) { getSessionEl().textContent = L.sessionLabel + tabsList[ti].title; break; }
    }
    v.renderCodeChip(); // codeCtx 是页面级数据，新视图的 chip 可能还是原型态
    // 残留清扫（白 Working 事故兑底）：按本页签真相重渲状态行，不残留历史漂移写口
    v.refreshBusy();
    // 后台视图期间内容在长而滚不动（display:none 无布局），跟随标志为真则切回后补拉底
    if (v.isFollowing()) v.forceScrollToBottom();
    applySubTab(tid); // 子 agent 浮窗/图标随页签切换（该页签的快照缓存恢复或收起）
    renderTabs();
    // 未建树的页签向宿主要一次快照（webview 重载后未轮到的后台页签/重启恢复页签）；
    // 已建树的不重拉——切页签零快照窗口，竞态整类消失
    if (!v.isBuilt()) post({ type: 'tabSwitch', tabId: tid, needState: true });
  }

  /** 标签条渲染：宿主 tabs 消息是唯一事实源（id/title/busy/unread）；≤1 会话默认隐藏（用户定调） */
  function renderTabs() {
    tabbarEl.innerHTML = '';
    if (tabsList.length <= 1) { tabbarEl.classList.remove('has-tabs'); return; }
    tabbarEl.classList.add('has-tabs');
    for (var i = 0; i < tabsList.length; i++) {
      (function (t: TabInfo) {
        var chip = el('span', 'tab-chip' + (t.id === getActiveTabId() ? ' active' : '') + (t.busy ? ' busy' : '') + (t.unread && t.id !== getActiveTabId() ? ' unread' : ''));
        chip.title = t.title;
        chip.appendChild(el('span', 'tab-dot'));
        chip.appendChild(el('span', 'tab-title', shorten(t.title, 14)));
        var x = el('span', 'tab-x', '\u00d7');
        x.title = L.tabCloseTitle;
        if (t.busy) x.className = 'tab-x always'; // busy 中关标签宿主会弹确认，× 常显提醒
        x.addEventListener('click', function (e) { e.stopPropagation(); post({ type: 'tabClose', tabId: t.id }); });
        chip.appendChild(x);
        chip.addEventListener('click', function () {
          if (t.id === getActiveTabId()) return;
          activateTab(t.id); // 本地先切（零延迟），宿主 postUiState 拉真相回填
          post({ type: 'tabSwitch', tabId: t.id });
        });
        tabbarEl.appendChild(chip);
      })(tabsList[i]);
    }
    // ＋入口变迁：2026-09-14 曾按用户拍板收敛到头部（当时吐槽点：与标签条＋撞脸）；
    // 2026-09-20 用户拍板恢复——页签末尾要 add 按钮开新标签会话，头部＋保留，双入口并存
    var add = el('span', 'tab-add');
    add.innerHTML = ico('plus', 12);
    add.title = L.tabNewTitle;
    add.addEventListener('click', function () { post({ type: 'tabNew' }); });
    tabbarEl.appendChild(add);
  }

  /** 宿主标签清单（唯一事实源）：未读点由宿主记账（后台跑完置位，切回时清） */
  function handleTabs(m: TabsMsg) {
    tabsList = m.tabs || [];
    // J 刀：页头随宿主标题刷新（宿主是标题唯一事实源）；无标题不覆盖，applyState 仍兑底
    for (var tTi = 0; tTi < tabsList.length; tTi++) {
      if (tabsList[tTi].id === getActiveTabId() && tabsList[tTi].title) {
        getSessionEl().textContent = L.sessionLabel + tabsList[tTi].title;
        break;
      }
    }
    if (getActiveTabId() === null || m.activeTabId !== getActiveTabId()) {
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
    // 凭证配置页（2026-11-05）：页面级覆盖层，与页签无关，先于 tabId 过滤截获
    if (m.type === 'authPanelOpen') { showAuthPanel(); return; }
    if (m.type === 'authState') { renderAuthProviders(((m as any).providers || []) as any[]); return; }
    // 标签清单先于 tabId 过滤处理（宿主是事实源）
    if (m.type === 'tabs') { handleTabs(m); return; }
    // 子 agent 快照在页签过滤前截获：后台页签的流虽不渲染但必须缓存，
    // 否则切回时该页签的浮窗/图标状态丢失；活动页签则实时渲染
    if (m.type === 'subagentUpdate') { subagentUpdate(m); return; }
    // 台账行（段 3 刀 2）：全局推送无页签归属——覆盖缓存并重绘当前浮窗
    if (m.type === 'subagentLedger') { subagentLedger((m as any).rows || []); return; }
    // 鸭子换图是页面级（图源与页签无关），不过路由
    if (m.type === 'duck') { applyDuck(m.uri); return; }
    // 刀3 编辑器面板：tabKey 存进 webview state 快照（VS Code 序列化面板时捕获，
    // 重启后 serializer 传回宿主 → 面板按原 tabKey 恢复原会话）。纯存储不渲染
    if (m.type === 'panelInfo') {
      setWebviewState({ tabKey: (m as any).tabKey });
      // 2026-10-20 拍板（图1 红框退役）：中间编辑区页头整行隐藏——会话标题/历史/新建/
      // 菜单（含 logo）全部移交左侧会话列表（列表点击=打开&切换、＋=新增、齿轮=菜单）。
      // panelInfo 只发给编辑器实例（panel.ts webviewReady），副栏页头原样保留；
      // subind（子 agent 收合开关）是页头唯一活控件，updateSubInd 露出 subind-live 行保功能
      document.body.classList.add('editor-panel');
      return;
    }
    // tabId 路由（工单24 架构归位）：非活动页签的消息照收——写进该页签自己的隐藏树
    // （现场累加，切回即现，不再依赖切回重拉）；页面控件类后台只记账不渲染（bgMode 守卫）
    routeMsg(m);
  });

  return {
    viewFor: viewFor, renderCodeChipAll: renderCodeChipAll,
    routeMsg: routeMsg, handleTabs: handleTabs
  };
}
