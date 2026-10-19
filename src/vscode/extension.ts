import * as vscode from "vscode";
import { ChatPanelProvider } from "./panel";
import { prewarmPiServices } from "../pi/piClient";
import { bb, Lang } from "../core/i18n";
import { dbgAppend } from "../core/piCore";

export function activate(ctx: vscode.ExtensionContext): void {
  // 诊断锚点（2026-10-19）：扩展宿主重启 = webview 重建的头号嫌疑，但此前日志里
  // 没有它的名字（只看到 webviewReady/boot 重跑）——「面板莫名重建」无从判因。
  // activate/deactivate 各留一行，重启在日志里一眼可辨
  dbgAppend("=== extension activate v" + String(ctx.extension.packageJSON.version));
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
  dbgAppend("=== extension deactivate"); // 与 activate 配对：日志里一眼看出宿主重启边界
}
