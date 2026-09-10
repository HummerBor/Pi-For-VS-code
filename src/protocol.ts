/**
 * 跨边界消息协议：宿主↔webview、pi RPC→宿主 的全部消息判别联合。
 *
 * 唯一事实来源：
 * - WebviewToHost 以 panel.ts onWebviewMessage 的 case 为准
 * - HostToWebview 以 webview/main.ts message 监听分发的 case 为准
 * - PiEvent 以 panel.ts onPiEvent 的 case + piClient.ts 转发为准
 *
 * 本文件只含类型与纯类型辅助，零运行时逻辑（webview 产物可安全 type-only 导入）。
 * 新增/修改消息时三处同步：发送方、接收方、本文件。
 */

/* ══════════════ webview → 宿主 ══════════════ */

export interface WvReadyMsg {
  type: "webviewReady";
}
export interface WvPromptMsg {
  type: "prompt";
  text: string;
  images?: { data: string; mimeType: string }[];
  files?: { name: string; text?: string; path?: string }[];
  attachCode?: boolean;
}
export interface WvAbortMsg {
  type: "abort";
}
export interface WvRetryFromLastMsg {
  type: "retryFromLast";
}
export interface WvPickSessionMsg {
  type: "pickSession";
}
export interface WvTreeForkMsg {
  type: "treeFork";
}
export interface WvImportSessionMsg {
  type: "importSession";
}
export interface WvShareSessionMsg {
  type: "shareSession";
}
export interface WvNewSessionMsg {
  type: "newSession";
}
export interface WvUploadImageMsg {
  type: "uploadImage";
}
export interface WvAttachFileMsg {
  type: "attachFile";
  name?: string;
  text?: string;
  /** 路径兑底字节通道：webview 拿不到绝对路径时（OS 拖入/剪贴板），base64 交宿主落临时文件 */
  data?: string;
  path?: string;
}
/** VS Code 资源管理器拖入：webview 拿不到 File.path，但 dataTransfer 带资源 URI，宿主转 fsPath */
export interface WvAttachUriMsg {
  type: "attachUri";
  uris: string[];
}
export interface WvPickModeMsg {
  type: "pickMode";
}
export interface WvGetSlashMsg {
  type: "getSlash";
}
export interface WvOpenSessionMsg {
  type: "openSession";
  file: string;
}
export interface WvRevealSessionFileMsg {
  type: "revealSessionFile";
  file: string;
}
export interface WvOpenPathMsg {
  type: "openPath";
  path: string;
}
// WvDeleteSessionMsg 已删（工单四-3 死链清理）：webview 从无发送端，宿主 case 曾是裸 rmSync。
// 删除走宿主 QuickPick deleteSessionPick 路径（4781f78），webview 直删不再提供
export interface WvGetFilesMsg {
  type: "getFiles";
}
export interface WvMoreMsg {
  type: "more";
}
export interface WvSettingsMsg {
  type: "settings";
}
export interface WvPickModelMsg {
  type: "pickModel";
}
export interface WvPickThinkingMsg {
  type: "pickThinking";
}
export interface WvPickThemeMsg {
  type: "pickTheme";
}
export interface WvPickLangMsg {
  type: "pickLang";
}

/** 横幅关闭按钮（工单六）：webview 只上报，横幅状态机在 piCore，宿主回发 banner:null 收口 */
export interface WvBannerCloseMsg {
  type: "bannerClose";
}
/** 横幅「一键压缩」按钮：宿主走 ui.compactSession() 直压语义（同 810f39c 口径） */
export interface WvCompactSessionMsg {
  type: "compactSession";
}
/** 工单七：点击「查看本次改动」入口，宿主出 QuickPick 文件清单 */
export interface WvShowChangesMsg {
  type: "showChanges";
}
/** 工单七：关闭「本次改动」条；宿主状态收口（webview 重建不重发） */
export interface WvChangesDismissMsg {
  type: "changesDismiss";
}
export type WebviewToHost =
  | WvReadyMsg
  | WvPromptMsg
  | WvAbortMsg
  | WvRetryFromLastMsg
  | WvPickSessionMsg
  | WvTreeForkMsg
  | WvImportSessionMsg
  | WvShareSessionMsg
  | WvNewSessionMsg
  | WvUploadImageMsg
  | WvAttachFileMsg
  | WvAttachUriMsg
  | WvPickModeMsg
  | WvGetSlashMsg
  | WvOpenSessionMsg
  | WvRevealSessionFileMsg
  | WvOpenPathMsg
  | WvGetFilesMsg
  | WvMoreMsg
  | WvSettingsMsg
  | WvPickModelMsg
  | WvPickThinkingMsg
  | WvPickThemeMsg
  | WvPickLangMsg
  | WvBannerCloseMsg
  | WvCompactSessionMsg
  | WvShowChangesMsg
  | WvChangesDismissMsg;

/* ══════════════ 宿主 → webview ══════════════ */

/** 渲染用会话消息：结构由 pi 落盘格式决定，这里保持宽松 */
export interface SessionMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  attachments?: unknown[];
  toolCallId?: string;
  isError?: boolean;
  [k: string]: unknown;
}

export interface UserMsg {
  type: "user";
  text: string;
  /** 命令式应答的乐观回显（如 /login）可无图片 */
  imageCount?: number;
  fileCount?: number;
  codeInfo?: string;
}
export interface NewLiveMsg {
  type: "newLive";
}
export interface DeltaMsg {
  type: "delta";
  text: string;
  ci: number;
}
export interface ThinkingMsg {
  type: "thinking";
  text: string;
  ci: number;
}
export interface ToolStartMsg {
  type: "toolStart";
  id: string;
  name: string;
  detail?: string;
}
export interface ToolCallStartMsg {
  type: "toolCallStart";
  ci: number;
  id?: string;
  name?: string;
}
export interface ToolCallDeltaMsg {
  type: "toolCallDelta";
  ci: number;
  chunk: string;
}
export interface ToolEndMsg {
  type: "toolEnd";
  id: string;
  name: string;
  isError: boolean;
  text: string;
  detail?: string;
}
export interface BusyMsg {
  type: "busy";
  value: boolean;
  /** agent 本轮实测耗时 ms（agent_start→agent_settled，宿主测量）；
   *  命令式应答/pi 退出等无 agent 运行的 busy:false 不带此字段，webview 不显示耗时 */
  elapsedMs?: number;
}
export interface RenderMsg {
  type: "render";
  messages: SessionMessage[];
}
export interface QueueMsg {
  type: "queue";
  steering: unknown[];
  followUp: unknown[];
}
export interface NoticeMsg {
  type: "notice";
  text: string;
}
export interface FillInputMsg {
  type: "fillInput";
  text: string;
}
export interface StatusMsg {
  type: "status";
  text: string;
}
export interface ModeMsg {
  type: "mode";
  text: string;
}
export interface QueuedAddMsg {
  type: "queuedAdd";
  qid: string;
  text: string;
  imageCount: number;
  fileCount?: number;
  codeInfo?: string;
}
export interface QueuedDeliveredMsg {
  type: "queuedDelivered";
  qid: string;
  show: boolean;
  text: string;
  imageCount: number;
  codeInfo?: string;
}
export interface QueuedClearMsg {
  type: "queuedClear";
}
export interface CodeCtxInfo {
  name: string;
  rel: string;
  range: string;
  lines: number;
}
export interface CodeCtxMsg {
  type: "codeCtx";
  ctx: CodeCtxInfo | null;
}
/** 宿主探测合格的待发图片（base64） */
export interface PendingImage {
  data: string;
  mimeType: string;
  name: string;
  w?: number;
  h?: number;
}
export interface AddImagesMsg {
  type: "addImages";
  images: PendingImage[];
}
export interface AddFilesMsg {
  type: "addFiles";
  files: { name: string; text?: string; path?: string }[];
}
export interface SlashCommand {
  name: string;
  label?: string;
  description?: string;
  group?: string;
  builtin?: string;
}
export interface SlashListMsg {
  type: "slashList";
  commands: SlashCommand[];
}
export interface WorkspaceFile {
  rel: string;
  dir: string;
}
export interface FileListMsg {
  type: "fileList";
  files: WorkspaceFile[];
}
export interface StateMsg {
  type: "state";
  ver?: string;
  model?: { id: string; name?: string; provider?: string } | null;
  thinkingLevel?: number | null;
  sessionFile?: string | null;
  sessionName?: string | null;
  stats?: { contextPercent?: number | null; cost?: number } | null;
}
export interface ThemeMsg {
  type: "theme";
  name: string;
}
/** 面板顶部横幅（工单六：压缩显性化/阈值预警）。文案由宿主组装（含时间戳/占比，
 *  随宿主 i18n 走），webview 只负责渲染；actionLabel 有值时带操作按钮 */
export interface BannerPayload {
  kind: "compacted" | "contextWarning";
  text: string;
  actionLabel?: string;
}
export interface BannerMsg {
  type: "banner";
  /** null = 收起横幅 */
  banner: BannerPayload | null;
}
/** 工单七：单个变更文件的 webview 展示信息（还原/diff 所需细节留在宿主，不进 webview） */
export interface ChangesFileInfo {
  /** 绝对路径（webview 只取 basename 显示，tooltip 用全路径） */
  path: string;
  /** tool = pi 工具命中（edit/write 归因）；git = 仅 git 比对命中（可能是用户 WIP，只展示不可还原，裁决 11②） */
  source: "tool" | "git";
}
/** 工单七：本轮变更文件条。文案宿主组装，webview 只渲染；files 为空 = 收条 */
export interface ChangesListMsg {
  type: "changesList";
  files: ChangesFileInfo[];
}
/** 工单七：piCore→adapter 的 run 边界回调负载（不经 webview；git/还原语义全在 adapter）。
 *  tool 取 pi 工具名（edit/write）；patches 是同一文件本次 run 内按时间序累积的
 *  edit result.details.patch（未跟踪文件逆序逆向还原用，裁决 11③） */
export interface ToolChangedFile {
  path: string;
  tool: string;
  patches: string[];
}
// sessionList / listSessions 死链已删除（工单二b）：webview 从无该消息处理器（会话切换走宿主 QuickPick），
// 面板内历史列表若重做再按需重建

export type HostToWebview =
  | UserMsg
  | NewLiveMsg
  | DeltaMsg
  | ThinkingMsg
  | ToolStartMsg
  | ToolCallStartMsg
  | ToolCallDeltaMsg
  | ToolEndMsg
  | BusyMsg
  | RenderMsg
  | QueueMsg
  | NoticeMsg
  | FillInputMsg
  | StatusMsg
  | ModeMsg
  | QueuedAddMsg
  | QueuedDeliveredMsg
  | QueuedClearMsg
  | CodeCtxMsg
  | AddImagesMsg
  | AddFilesMsg
  | SlashListMsg
  | FileListMsg
  | StateMsg
  | ThemeMsg
  | BannerMsg
  | ChangesListMsg;

/* ══════════════ pi RPC 命令响应（宿主 ← pi） ══════════════ */

/** get_messages 响应：当前会话消息列表（复用渲染用 SessionMessage） */
export interface GetMessagesResult {
  messages: SessionMessage[];
  [k: string]: unknown;
}
/** get_state 响应：会话/模型/思考等级等当前状态（pi 未保证的字段一律保守可选） */
export interface GetStateResult {
  /** pi 权限运行状态（rpc.md get_state）：busy 镜像漂移时的对账真相源 */
  isStreaming?: boolean;
  sessionFile?: string;
  sessionName?: string;
  model?: { id: string; name?: string; provider?: string } | null;
  thinkingLevel?: number | null;
  steeringMode?: string;
  followUpMode?: string;
  autoCompactionEnabled?: boolean;
  [k: string]: unknown;
}
/** get_session_stats 响应：token 用量与花费 */
export interface GetSessionStatsResult {
  contextUsage?: { percent?: number | null } | null;
  cost?: number;
  [k: string]: unknown;
}

/* ══════════════ pi RPC 事件 → 宿主 ══════════════ */

/** message_update 携带的助手消息增量事件 */
export interface AssistantMessageEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
  id?: string;
  toolName?: string;
}

export interface PiAgentStartEvent {
  type: "agent_start";
}
export interface PiMessageStartEvent {
  type: "message_start";
  message?: { role: string };
}
export interface PiMessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent?: AssistantMessageEvent;
}
export interface PiToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args?: unknown;
}
export interface PiToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  args?: unknown;
  result?: {
    content?: unknown;
    /** edit 工具的 EditToolDetails（pi 未保证非空，裁决 4 保守可选；write 恒 undefined） */
    details?: { patch?: string; diff?: string; firstChangedLine?: number } | null;
  };
}
export interface PiModelSelectEvent {
  type: "model_select";
}
export interface PiThinkingLevelSelectEvent {
  type: "thinking_level_select";
}
export interface PiAutoRetryStartEvent {
  type: "auto_retry_start";
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: unknown;
  error?: unknown;
}
export interface PiAutoRetryEndEvent {
  type: "auto_retry_end";
  success?: boolean;
  attempt?: number;
  finalError?: unknown;
}
export interface PiQueueUpdateEvent {
  type: "queue_update";
  steering?: unknown[];
  followUp?: unknown[];
}
export interface PiExtensionErrorEvent {
  type: "extension_error";
  event: string;
  error: unknown;
}
export interface PiAgentSettledEvent {
  type: "agent_settled";
}
/** 压缩开始（工单六）：手动压缩已有 compactDone 通知，start 事件本单不消费 */
export interface PiCompactionStartEvent {
  type: "compaction_start";
  reason?: "manual" | "threshold" | "overflow";
}
/** 压缩结束：threshold/overflow=自动压缩（显性化横幅）；result 是 pi CompactionResult，
 *  形状未逐字段验证，保守 unknown（裁决 4） */
export interface PiCompactionEndEvent {
  type: "compaction_end";
  reason?: "manual" | "threshold" | "overflow";
  result?: unknown;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: unknown;
}
/** 未识别事件：仅透传可能的错误信息（panel.ts onPiEvent default 分支，用显式断言取值）。
 *  不并入 PiEvent 联合——type: string 会毒化判别联合的字面量收窄 */
export interface PiUnknownEvent {
  type: string;
  error?: unknown;
  errorMessage?: unknown;
  reason?: unknown;
  [k: string]: unknown;
}

export type PiEvent =
  | PiAgentStartEvent
  | PiMessageStartEvent
  | PiMessageUpdateEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionEndEvent
  | PiModelSelectEvent
  | PiThinkingLevelSelectEvent
  | PiAutoRetryStartEvent
  | PiAutoRetryEndEvent
  | PiQueueUpdateEvent
  | PiExtensionErrorEvent
  | PiAgentSettledEvent
  | PiCompactionStartEvent
  | PiCompactionEndEvent;
