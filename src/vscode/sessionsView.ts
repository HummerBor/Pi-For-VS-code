import * as vscode from "vscode";
import * as path from "path";
import { listSessions, peekListSessions, listSubagentSessions, peekSubagentSessions, subagentParentMap, handleFromSubPath, samePath } from "./sessionCache";
import { ChatPanelProvider } from "./panel";
import { bb } from "../core/i18n";
import { getSessionsHtml } from "./webview-html";
import { markWebviewAttached } from "./webviewGuard";

/** 列表条目（宿主→webview svItems 的形状；本地零影子状态，宿主全量重发）。
 *  subs（2026-11-02 用户拍板「主会话加收放按钮，展开是对应的子智能体」）：
 *  属于本主会话的子会话，嵌套在行上——不再全堆在底部一个全局组里（那样跟右侧浮窗重复）*/
interface SvItem {
  file: string;
  label: string;
  time: string;
  subs?: SvItem[];
}

/**
 * SessionsViewProvider —— 刀6 B：左侧会话列表从原生 TreeView 改写成 webview。
 *
 * 为什么推翻刀4 的「能用原生就用原生」选型（2026-10-19 用户拍板 B）：原生 TreeView 只认
 * VS Code 主题，插件主题（piChat.theme：午夜蓝/CC 暗黑）够不着它——三块布局（副栏聊天/
 * 编辑器标签/列表）样式永远分裂，且适配新主题要两套体系。CC 自己的会话列表也是 webview
 *（manifest type:webview），与聊天同色的代价是搜索/键盘导航/悬停删除自绘（webview/sessions.ts）。
 * 视觉与交互对齐原生树既有能力：搜索过滤、↑↓+Enter 导航、悬停删除、点击打开。
 *
 * 数据源不变：pi 原生 SessionManager（sessionCache.listSessions，与 ⏱ 选择器同源同真值）。
 * 点击路由（2026-10-22「右侧=切换」交互拍板）：openOrFocusSession —— 与 ⏱ 选择器
 * 选中同一条 applySessionPick 链（已打开→切到持有页签，未打开→副栏当前页签就地切换，
 * busy 才开新并行标签），不再默认在中间开编辑器标签；
 * 删除不变：deleteSessionFile 单一真相（跨实例守卫/边界/模态确认）。
 */
/** 旧同步单迁移（2026-11-02）：v6 之前的同步单没有独立 session-dir，会话落在项目目录里，
 *  但名字是「职务 · 代号：任务」格式（v3 起 --name 写的）。按名字格式识别为子会话，从
 *  主列表移到折叠组——文件不删不动，只改展示归类（不动磁盘是硬约束：会话文件是审计真值）。
 *  新单（v6+）已经直接落 subagents/，不需要依赖这条启发式。 */
const SUB_NAME_RE = /^[^：]{1,24} · [^：]{1,12}：/;

/** 按名字把条目分成主列表/遗留子会话两堆 */
function splitLegacySubs(list: { file: string; name?: string; preview: string; time: string }[]): {
  main: typeof list;
  legacy: typeof list;
} {
  const main: typeof list = [];
  const legacy: typeof list = [];
  for (const s of list) (SUB_NAME_RE.test(s.name || "") ? legacy : main).push(s);
  return { main, legacy };
}

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private refreshTimer: NodeJS.Timeout | undefined;

  /** 请求刷新（debounce 2s）：多个状态事件连发只刷一次——每次刷新都是一次 listSessions */
  refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.sendItems(), 2000);
  }

  /** 工单32刀3：立即刷新（不吃 2s debounce）——外部新建会话 ≤2s 上列表的验收预算
   *  经不起 debounce；sendItems 自带在途合并（sessionCache inFlight），连发不会重扫多次 */
  refreshNow(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = undefined; }
    void this.sendItems();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.applyHtml();
    markWebviewAttached(); // webview 自检打点（webviewGuard.ts）：会话列表也是 webview，它起来就说明 SW 链路是通的
    view.webview.onDidReceiveMessage(async (m: { type: string; file?: string; label?: string }) => {
      if (m.type === "svReady") void this.sendItems();
      else if (m.type === "svRefresh") void this.sendItems();
      else if (m.type === "svNew") void vscode.commands.executeCommand("piChat.openInEditor");
      else if (m.type === "svMore") ChatPanelProvider.moreFromList(); // ⚡ 菜单（2026-10-20 图2：中间区 ✳ 移列）
      else if (m.type === "svOpen" && m.file) {
        // 子会话走单独页面（2026-11-03 用户拍板「页面也分开」）：只读转录预览，
        // 绝不把子会话套进主会话聊天页（那要建 SessionManager，会往子进程正在写的文件里写）
        if (/[\/]subagents[\/]/.test(m.file)) {
          ChatPanelProvider.openTranscriptFor(m.file, m.label);
        } else {
          void ChatPanelProvider.openOrFocusSession(m.file, m.label);
        }
      }
      else if (m.type === "svDelete" && m.file) {
        // 守卫/确认/落盘复用 panel.deleteSessionFile 单一真相（跨实例双开保护同款）；
        // 结果码 → 原生通知（双语 bb，同原树删除按钮口径）
        const r = await ChatPanelProvider.deleteSessionFile(m.file);
        if (r.status === "deleted") void vscode.window.showInformationMessage(bb("delSessionDone") + r.name);
        else if (r.status === "open") void vscode.window.showWarningMessage(bb("delSessionCur"));
        else if (r.status === "failed") void vscode.window.showErrorMessage(bb("delSessionFail") + r.err);
        else if (r.status === "notfound") void vscode.window.showErrorMessage(bb("delSessionFail") + "file not found");
        else if (r.status === "outside") void vscode.window.showErrorMessage(bb("delSessionFail") + "outside sessions dir");
        // cancelled：静默
      }
    });
    view.onDidDispose(() => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
    });
  }

  /** 按当前主题/语言重生成 HTML（语言切换、视图重建共用）——theme/lang 读 globalState
   *  活值，与面板同源（刀6 广播修复后三块永远同步） */
  private applyHtml(): void {
    const view = this.view;
    if (!view) return;
    const theme = this.globalState().get<string>("piChat.theme") ?? "midnight";
    const lang = this.globalState().get<string>("piChat.lang") ?? "zh";
    // 地板色口径与面板 applyHtml 一致（midnight/cc-dark 固定值，auto 跟随 VS Code 亮暗）
    const kind = vscode.window.activeColorTheme.kind;
    const floorColor =
      theme === "midnight" ? "#0b1220" : theme === "cc-dark" ? "#0a0a0c" : kind === vscode.ColorThemeKind.Light ? "#f3f3f3" : kind === vscode.ColorThemeKind.HighContrast ? "#000000" : "#1f1f1f";
    view.webview.html = getSessionsHtml(theme, floorColor, lang === "en" ? "en" : "zh");
  }

  /** globalState 走 setSessionsView 注入（构造器传入会与 provider 注册顺序耦合） */
  private state: vscode.Memento | undefined;
  bindState(s: vscode.Memento): void {
    this.state = s;
  }
  private globalState(): vscode.Memento {
    if (!this.state) throw new Error("SessionsViewProvider.bindState 未调用");
    return this.state;
  }

  /** 下发全量条目（宿主是唯一事实源；webview 零影子状态）：秒出 + 后台真值双发 */
  private async sendItems(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cached = peekListSessions(cwd);
    const cachedSubs = await peekSubagentSessions(cwd).catch(() => null);
    if (cached) {
      const sp = splitLegacySubs(cached);
      const subs = toItemMsgs([...(cachedSubs ?? []), ...sp.legacy]);
      const { items, orphans } = nestSubs(toItemMsgs(sp.main), subs, await subagentParentMap());
      void view.webview.postMessage({ type: "svItems", items, subs: orphans });
    }
    // 渐进上屏（与 ⏱ 选择器同款，2026-10-22「2比1加载慢」定案）：原来 await 全量才发，
    // 死等 1.2~2s（宿主拥堵下 22~30s）期间侧栏空白——partial 首批 ~19ms 就有货，
    // picker 先修了这里漏了。有缓存时不再上屏 partial（秒出已兜底，真值到达原地替换）；
    // 200ms 限流同 picker：pi 每批回调都 postMessage 会抢事件循环
    let lastProgressAt = 0;
    let paintedPartial = false;
    const sessions = await listSessions(cwd, 50, (_loaded, _total, partial) => {
      if (cached || !partial?.length) return;
      const now = Date.now();
      if (paintedPartial && now - lastProgressAt < 200) return;
      paintedPartial = true;
      lastProgressAt = now;
      void view.webview.postMessage({ type: "svItems", items: toItemMsgs(partial) });
    }).catch(() => []);
    // 子会话：扫 subagents/ 目录 + v6 之前遗留的同步单（按名字格式识别），按 parentSession 嵌套
    const subs = await listSubagentSessions(cwd).catch(() => []);
    const sp = splitLegacySubs(sessions);
    const merged = toItemMsgs([...subs, ...sp.legacy]);
    const { items, orphans } = nestSubs(toItemMsgs(sp.main), merged, await subagentParentMap());
    void view.webview.postMessage({ type: "svItems", items, subs: orphans });
  }

  /** 主题切换广播（panel.pickTheme 全实例广播的补充——本 provider 不是 ChatPanelProvider，
   *  不在 allProviders 里，同病同修）：body[data-theme] 就地换，不重建 HTML */
  broadcastTheme(name: string): void {
    void this.view?.webview.postMessage({ type: "svTheme", name });
  }

  /** 语言切换广播：文案烧在 HTML 里（{{t:key}}），只能重生成 */
  broadcastLang(): void {
    this.applyHtml();
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}

function toItemMsgs(sessions: { file: string; name?: string; preview: string; time: string }[]): SvItem[] {
  return sessions.map((s) => ({
    file: s.file,
    label: s.name || s.preview || path.basename(s.file),
    time: s.time,
  }));
}

/** 主列表 + 子会话 → 嵌套结构（2026-11-02 用户拍板）。
 *  归属依据 = 台账 parentSession（harness 派单时记的父会话文件）；
 *  无台账/子会话目录的老同步单归不进去——它们按名字格式认出是子会话，
 *  统一放到未归属组（不丢、也不污染主列表）。 */
function nestSubs(
  main: SvItem[],
  subs: { file: string; label: string; time: string }[],
  parents: Map<string, string>,
): { items: SvItem[]; orphans: SvItem[] } {
  const byParent = new Map<string, SvItem[]>();
  const orphans: SvItem[] = [];
  for (const s of subs) {
    const handle = handleFromSubPath(s.file);
    const parent = handle ? parents.get(handle) : undefined;
    const host = parent ? main.find((m) => samePath(m.file, parent)) : undefined;
    if (!host) {
      orphans.push({ ...s });
      continue;
    }
    if (!host.subs) host.subs = [];
    host.subs.push({ ...s });
  }
  return { items: main, orphans };
}

/** 注册左侧会话列表（extension.activate 调用一次）：容器 piChatSessions 常驻左侧活动栏，
 *  视图 = webview（刀6 B，与聊天共用 tokens 同色） */
export function registerSessionsView(ctx: vscode.ExtensionContext): SessionsViewProvider {
  const provider = new SessionsViewProvider();
  provider.bindState(ctx.globalState);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("piChat.sessions", provider, {
      // 保活：切走再回来不重建（搜索框内容/滚动位置不丢，同聊天视图口径）
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider
  );
  return provider;
}

/** 会话列表的宿主侧刷新入口（静态钩子，panel.ts 在会话增删/切换后调用） */
let sessionsViewRef: SessionsViewProvider | undefined;
export function setSessionsView(v: SessionsViewProvider): void {
  sessionsViewRef = v;
}
export function notifySessionsChanged(): void {
  sessionsViewRef?.refresh();
}
/** 工单32刀3：外部新建/删除会话的立即刷新入口（watcher 调，≤2s 验收口径） */
export function notifySessionsChangedNow(): void {
  sessionsViewRef?.refreshNow();
}
/** 主题/语言广播（panel 切换后调用——三块同色的最后一环，2026-10-19 广播修复同批） */
export function notifySessionsTheme(name: string): void {
  sessionsViewRef?.broadcastTheme(name);
}
export function notifySessionsLang(): void {
  sessionsViewRef?.broadcastLang();
}
