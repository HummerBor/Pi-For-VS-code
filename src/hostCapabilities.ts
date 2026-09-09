/**
 * HostCapabilities —— 核心控制器（piCore）所需的宿主能力接口。
 *
 * 架构铁律（DIRECTOR.md 工单四）：核心功能不与 VS Code 深度绑定。核心逻辑只依赖本接口，
 * 不 import vscode；VS Code 特定能力全部住在 panel.ts（adapter）里实现本接口。
 * 签名只用 protocol.ts / 本文件类型与原始类型（string/number/boolean），不暴露 vscode 类型。
 */

/** QuickPick 条目的宿主中立形状（原 vscode.QuickPickItem 的最小子集） */
export interface HostQuickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface HostInputOptions {
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
}

export interface HostConfirmOptions {
  /** 模态框补充说明（原 showWarningMessage 的 detail） */
  detail?: string;
  confirmText: string;
  cancelText: string;
}

export interface HostCapabilities {
  /** 当前工作区根目录（无工作区时宿主自行兜底） */
  getCwd(): string;
  /** 读 VS Code 设置（section 如 "piChat"/"http"） */
  getConfig<T>(section: string, key: string, defaultValue: T): T;
  /** 全局持久化（原 globalState.Memento；get 同步、set 火后不理） */
  getPersist<T>(key: string, defaultValue: T): T;
  setPersist(key: string, value: unknown): void;
  /** 单选列表（返回 undefined = 用户取消） */
  showQuickPick<T extends HostQuickItem>(items: T[], placeHolder?: string): Promise<T | undefined>;
  /** 单行输入框（返回 undefined = 用户取消） */
  showInputBox(options: HostInputOptions): Promise<string | undefined>;
  /** 模态确认框（true = 用户点了确认键） */
  showConfirm(title: string, options: HostConfirmOptions): Promise<boolean>;
  /** 通知条（error 级可带动作按钮，返回被点的动作文本） */
  notify(level: "info" | "warn" | "error", message: string, actions?: string[]): Promise<string | undefined>;
  /** pi 扩展发来的 UI 请求（extension_ui_request）由宿主用原生 UI 处理 */
  uiRequest(req: any): void;
}
