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
  /** 跨实例会话双开守卫的闸：file 是否已被「别的实例/页签」持有。
   *  selfTabKey = 询问方自己的 tabKey（同 provider 同页签自己问不算占用——幂等重开无害）。
   *  可选：宿主没有多实例信息时省略，核心退化为不过闸（单实例行为不变） */
  isSessionHeld?(file: string, selfTabKey: string): boolean;
  /** agent 目录（getAgentDir，~/.pi/agent）：subagent 台账读取用（段 3）。可选：
   *  sdk 未加载/宿主不支持时返回 null，核心退化为不发台账，不影响主链路 */
  getAgentDir?(): string | null;
  /** 子 agent 终态时通知宿主刷新列表（2026-11-02）：左侧「主会话→子会话」嵌套靠它
   *  自动出现，不用用户手点刷新。可选：不实现就不刷（核心不依赖） */
  onSubagentSettled?(): void;
  /** 会话文件另开一个页签展示（openOrFocusSession 语义：新页签，绝不顶当前会话）。
   *  可选：宿主不支持时核心静默降级（子 agent 展开回看不可用）。
   *  title 可选：子会话没有 pi 生成的会话名（jsonl name 为空），不传就 fallback 成文件名
   *  时间戳（用户实测「标题只有 11-02 11:54，认不出是哪个任务」）——传了则优先当标签题 */
  openSessionInTab?(file: string, title?: string): void;
  /** 子 agent 转录页（2026-11-03 用户拍板「页面也分开」）：子会话的查看走单独页面
   *  （只读 Markdown 预览，不建会话、不写文件），绝不套用主会话的聊天页。
   *  follow=true 时页面自己每 2s 重读刷新，台账翻终态自动停。 */
  openSubagentTranscript?(file: string, title: string | undefined, follow: boolean): void;
  /** 子 agent 转录的实时增量（2026-11-03）：事件驱动，不轮询——harness 每收到子进程一条
   *  message_end 就推一帧（tool_execution_update / entry_appended），核心比对已推条数后
   *  把「新消息」经这里递进已打开的转录页。没开页面时是空操作。 */
  pushSubagentTranscript?(handle: string, messages: unknown[], from?: number): void;
  /** 子 agent 的 delta 级流式增量（2026-11-03，与主会话同口径）：harness 把子进程的
   *  message_update 攒批上来，核心原样递给转录页，页面用主会话那套 live 协议逐字追加。 */
  pushSubagentStream?(handle: string, kind: "text" | "thinking", text: string): void;
}
