import * as vscode from "vscode";
import { listSessions, peekListSessions } from "./sessionCache";
import { ChatPanelProvider } from "./panel";
import { bb } from "../core/i18n";

/**
 * SessionsTreeProvider —— 刀4 CC 布局：左侧活动栏的会话列表（原生 TreeView）。
 *
 * 选型（壳口径：能用原生就用原生）：CC 的会话列表是 webview 自绘，但 VS Code 的
 * TreeView 原生自带搜索/折叠/上下文菜单/键盘导航，零 webview 维护成本——数据源
 * 就是 pi 的会话 jsonl（sessionCache.listSessions，与面板 ⏱ 选择器同源同真值）。
 *
 * 行为：点击会话项 → 未打开则开编辑器标签（openEditorTab(file)，首开即切该会话）、
 * 已打开则聚焦持有者（跨实例守卫同款路由，见 panel.ts openOrFocusSession）。
 * 刷新：宿主静态 refresh()（会话增删/切换后调用，debounce 2s）+ 数据在拉取时才向
 * pi 要（listSessions 幂等 memo），树未展开零开销。
 */
export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private refreshTimer: NodeJS.Timeout | undefined;
  private cache: SessionItem[] | null = null;

  /** 请求刷新（debounce 2s）：多个状态事件连发只刷一次——每次刷新都是一次 listSessions */
  refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.cache = null;
      this.emitter.fire();
    }, 2000);
  }

  getTreeItem(item: SessionItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<SessionItem[]> {
    if (this.cache) return this.cache;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // 秒出 + 后台真值（同 pickSession 口径）：缓存有就先画，listSessions 到达后替换
    const cached = peekListSessions(cwd);
    if (cached) this.cache = cached.map(toItem);
    const sessions = await listSessions(cwd, 50).catch(() => []);
    this.cache = sessions.map(toItem);
    return this.cache;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.emitter.dispose();
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(readonly file: string, label: string, detail: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = file; // 稳定 id：VS Code 按 id 保展开/选中态，路径天然唯一
    this.description = detail;
    // 图标只用 ThemeIcon（零硬编码颜色）：浅/深/高对比主题随 VS Code 自动适配，
    // 将来适配新主题列表侧零成本——需要彩色信号时用 ThemeColor（如 charts.green）而非 hex
    this.iconPath = new vscode.ThemeIcon("history");
    this.tooltip = `${label}\n${detail}\n${file}`;
    // 点击 = 打开/聚焦（命令带 file 参数，宿主路由见 panel.openOrFocusSession）
    this.command = { command: "piChat.openSession", title: label, arguments: [file] };
    this.contextValue = "piSession"; // 删除按钮菜单的 when 锚点（view/item/context）
  }
}

function toItem(s: { file: string; name?: string; preview?: string; time: string }): SessionItem {
  const label = s.name || s.preview || s.file.split(/[\\/]/).pop() || s.file;
  return new SessionItem(s.file, label, s.time);
}

/** 注册左侧会话列表（extension.activate 调用一次）：容器 piChatSessions 常驻左侧活动栏
 *  （CC 同款独立容器——副栏接管聊天后，左侧活动栏的职责就是会话列表） */
export function registerSessionsView(ctx: vscode.ExtensionContext): SessionsTreeProvider {
  const provider = new SessionsTreeProvider();
  const view = vscode.window.createTreeView("piChat.sessions", { treeDataProvider: provider });
  ctx.subscriptions.push(view, provider);
  ctx.subscriptions.push(
    vscode.commands.registerCommand("piChat.newSession", () => {
      void vscode.commands.executeCommand("piChat.openInEditor");
    }),
    vscode.commands.registerCommand("piChat.refreshSessions", () => provider.refresh()),
    // 列表点击：已打开的会话聚焦持有者（面板 reveal/侧边栏 focus），未打开开编辑器标签
    vscode.commands.registerCommand("piChat.openSession", (file: string) => {
      void ChatPanelProvider.openOrFocusSession(file);
    }),
    // 列表删除按钮（刀5：悬停内联 + 右键菜单同命令）：守卫/确认/落盘复用 panel
    // deleteSessionFile 单一真相；结果码 → 原生通知（双语 bb，同面板原生弹窗口径）
    vscode.commands.registerCommand("piChat.deleteSession", async (file: string) => {
      if (!file) return;
      const r = await ChatPanelProvider.deleteSessionFile(file);
      if (r.status === "deleted") void vscode.window.showInformationMessage(bb("delSessionDone") + r.name);
      else if (r.status === "open") void vscode.window.showWarningMessage(bb("delSessionCur"));
      else if (r.status === "failed") void vscode.window.showErrorMessage(bb("delSessionFail") + r.err);
      else if (r.status === "notfound") void vscode.window.showErrorMessage(bb("delSessionFail") + "file not found");
      else if (r.status === "outside") void vscode.window.showErrorMessage(bb("delSessionFail") + "outside sessions dir");
      // cancelled：用户主动取消，静默
    })
  );
  return provider;
}

/** 会话列表的宿主侧刷新入口（静态钩子，panel.ts 在会话增删/切换后调用） */
let sessionsViewRef: SessionsTreeProvider | undefined;
export function setSessionsView(v: SessionsTreeProvider): void {
  sessionsViewRef = v;
}
export function notifySessionsChanged(): void {
  sessionsViewRef?.refresh();
}
