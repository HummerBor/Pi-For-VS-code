import * as vscode from "vscode";
import * as path from "path";
import { listSessions, peekListSessions } from "./sessionCache";
import { ChatPanelProvider } from "./panel";
import { bb } from "../core/i18n";
import { getSessionsHtml } from "./webview-html";

/** 列表条目（宿主→webview svItems 的形状；本地零影子状态，宿主全量重发） */
interface SvItem {
  file: string;
  label: string;
  time: string;
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
 * 点击路由不变：openOrFocusSession（已打开→聚焦，未打开→编辑器标签）；
 * 删除不变：deleteSessionFile 单一真相（跨实例守卫/边界/模态确认）。
 */
export class SessionsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private refreshTimer: NodeJS.Timeout | undefined;

  /** 请求刷新（debounce 2s）：多个状态事件连发只刷一次——每次刷新都是一次 listSessions */
  refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.sendItems(), 2000);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.applyHtml();
    view.webview.onDidReceiveMessage(async (m: { type: string; file?: string }) => {
      if (m.type === "svReady") void this.sendItems();
      else if (m.type === "svRefresh") void this.sendItems();
      else if (m.type === "svNew") void vscode.commands.executeCommand("piChat.openInEditor");
      else if (m.type === "svOpen" && m.file) void ChatPanelProvider.openOrFocusSession(m.file);
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
    if (cached) void view.webview.postMessage({ type: "svItems", items: toItemMsgs(cached) });
    const sessions = await listSessions(cwd, 50).catch(() => []);
    void view.webview.postMessage({ type: "svItems", items: toItemMsgs(sessions) });
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
/** 主题/语言广播（panel 切换后调用——三块同色的最后一环，2026-10-19 广播修复同批） */
export function notifySessionsTheme(name: string): void {
  sessionsViewRef?.broadcastTheme(name);
}
export function notifySessionsLang(): void {
  sessionsViewRef?.broadcastLang();
}
