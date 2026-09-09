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
  files?: { name: string; text: string }[];
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
  text: string;
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
export interface WvDeleteSessionMsg {
  type: "deleteSession";
  file: string;
}
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
  | WvPickModeMsg
  | WvGetSlashMsg
  | WvOpenSessionMsg
  | WvRevealSessionFileMsg
  | WvOpenPathMsg
  | WvDeleteSessionMsg
  | WvGetFilesMsg
  | WvMoreMsg
  | WvSettingsMsg
  | WvPickModelMsg
  | WvPickThinkingMsg
  | WvPickThemeMsg
  | WvPickLangMsg;

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
  files: { name: string; text: string }[];
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
  | ThemeMsg;

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
  result?: { content?: unknown };
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
  | PiAgentSettledEvent;
