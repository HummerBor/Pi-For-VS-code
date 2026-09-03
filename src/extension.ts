import * as vscode from "vscode";
import { ChatPanelProvider } from "./panel";

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new ChatPanelProvider(ctx.extensionUri, ctx.globalState);
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
  statusItem.tooltip = "打开 pi 聊天面板";
  statusItem.command = "piChat.view.focus";
  statusItem.show();
  ctx.subscriptions.push(statusItem);
}

export function deactivate(): void {
  // 由 subscriptions 的 dispose 处理
}
