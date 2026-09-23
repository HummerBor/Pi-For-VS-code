import * as vscode from "vscode";
import { ChatPanelProvider } from "./panel";
import { prewarmPiServices } from "./piClient";
import { bb, Lang } from "./i18n";

export function activate(ctx: vscode.ExtensionContext): void {
  // Q 刀②（2026-09-23）：激活即后台预热 services——resourceLoader 全树扫描（冷 5~10s）
  // 藏进「开面板之前」的空窗；失败静默（boot 时还会再试）
  const ws0 = vscode.workspace.workspaceFolders?.[0];
  if (ws0) prewarmPiServices(ws0.uri.fsPath);
  const provider = new ChatPanelProvider(ctx.extensionUri, ctx.globalState, ctx.extension.packageJSON.version);
  ctx.subscriptions.push(
    // retainContextWhenHidden：切到其他侧边栏时保活 webview，回来不重建、不丢会话
    vscode.window.registerWebviewViewProvider(
      ChatPanelProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    { dispose: () => provider.dispose() }
  );

  // 状态栏入口：点击打开聊天面板
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusItem.text = "$(comment) pi";
  statusItem.tooltip = bb("statusBarTooltip");
  statusItem.command = "piChat.view.focus";
  statusItem.show();
  ctx.subscriptions.push(statusItem);
}

export function deactivate(): void {
  // 由 subscriptions 的 dispose 处理
}
