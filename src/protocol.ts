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

import type { SubagentSnapshot } from "./subagentSnapshot";

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
/** 工单十六：queuebar 条目「取回」→ 文本回编辑框（pi 原生 dequeue 语义的单条版） */
export interface WvQueuedRetrieveMsg {
  type: "queuedRetrieve";
  qid: string;
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
  | WvSubagentDetailRequestMsg
  | WvPickModelMsg
  | WvPickThinkingMsg
  | WvPickThemeMsg
  | WvPickLangMsg
  | WvBannerCloseMsg
  | WvCompactSessionMsg
  | WvShowChangesMsg
  | WvChangesDismissMsg
  | WvQueuedRetrieveMsg
  | WvTabSwitchMsg
  | WvTabNewMsg
  | WvTabCloseMsg;

/* 工单十五刀2：标签栏控制消息（panel 级，不过核心——panel.ts onDidReceiveMessage 在路由核心前拦截） */
export interface WvTabSwitchMsg {
  type: "tabSwitch";
  tabId: string;
}
export interface WvTabNewMsg {
  type: "tabNew";
}
export interface WvTabCloseMsg {
  type: "tabClose";
  tabId: string;
}

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
/** 子 agent 监控快照（流式 update 与最终 end 共用同一条消息，final 区分） */
export interface SubagentUpdateMsg {
  type: "subagentUpdate";
  /** toolCallId（同步）或异步句柄 sa-n：webview 靠它定位监控运行 */
  id: string;
  snapshot: SubagentSnapshot;
  final: boolean;
  /** 宿主关闭该运行：异步派发的同步壳行应删除（真进度走 sa-n 句柄行，别双份） */
  closed?: boolean;
  /** 运行计时（宿主测量，概览用时列/下钻显示用）；异步路径来自扩展 entry */
  startAt?: number;
  endAt?: number;
}
/** 下钻请求：webview 点概览行 → 宿主用留存的全量 details 构建 Full 快照回给 webview */
export interface WvSubagentDetailRequestMsg {
  type: "subagentDetailRequest";
  /** 运行 id（同 subagentUpdate.id） */
  id: string;
}
export interface SubagentDetailMsg {
  type: "subagentDetail";
  id: string;
  /** Full 快照（活动流上限 400 条、产出 60k 字，webview markdown 渲染） */
  snapshot: SubagentSnapshot;
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
/** 压缩进行中（compaction_start→compaction_end 窗口）：webview 用 ⏳ 压缩标签压过 Working，
 *  且 busy:false 不再清它——手动压缩不走 agent_start（空闲会话无 agent 事件），没有这条
 *  消息压缩期间状态栏零反馈；用户实测压缩中发消息被 preflight 拒收，busy:false 连面板
 *  的一次性 status 也一并抹掉，「正在压缩」提示消失事故的根治 */
export interface CompactingMsg {
  type: "compacting";
  value: boolean;
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
/** 工单十八：uiState.queued 的项 payload（同 QueuedAddMsg 形状但无判别 type——
 *  原子快照里它是嵌套数据不是独立消息） */
export interface QueuedItemPayload {
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
/** 工单十八补刀：乐观入队失败回滚——单条移除（sendPromptCore 先画后发，prompt/steer 失败时
 *  pi 队列无此条，不回滚则计数与 queuebar 永久分叉） */
export interface QueuedRemoveMsg {
  type: "queuedRemove";
  qid: string;
}
/** 工单十六：取回完成——qid 项出队，text（sentText，含附件胶囊块）合入编辑框。
 *  与 queuedDelivered 的区别：不进气泡流，只回编辑框（用户在编辑框里删改，同 TUI alt+up） */
export interface QueuedRetrievedMsg {
  type: "queuedRetrieved";
  qid: string;
  text: string;
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
/** 工单十五刀2：标签栏全量状态（宿主是唯一事实源，webview 只渲染；标题/busy 由宿主从
 *  各核心的 state/busy 消息记账）。webview 本地另叠 dirty 未读点（后台标签完成亮提示） */
export interface TabInfo {
  id: string;
  title: string;
  busy: boolean;
  /** 工单十五刀5：后台页签跑完亮未读点（宿主记账——webview 零影子状态，切回即清） */
  unread?: boolean;
}
export interface TabsMsg {
  type: "tabs";
  tabs: TabInfo[];
  activeTabId: string;
}
/** 工单十五刀5b：流式续接重定基（pi 原生姿势——TUI 的 message_update 就是拿全量在途
 *  消息 updateContent，从不攒增量）。切回 busy 页签时，快照剥掉在途消息后由本消息
 *  携带全量在途消息重建 live 气泡，后续 delta 在正确基础上续接——
 *  「切回去一直重新开始思考/内容重复」的根治 */
export interface LiveSyncMsg {
  type: "liveSync";
  message: SessionMessage;
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
/** 工单十八：切页签/真相重拉的原子快照——postUiState 原先连发 render/liveSync/busy/mode/
 *  banner/queuedClear/queuedAdd 七条消息，webview 各区域各自更新，中间态混搭（消息区 B、
 *  排队条/Working 还是 A）被切页签空分支漏发固化成永久态（用户实测「两个 DOM 结构」/串显）。
 *  一条消息打包全部区域，webview 原子应用；tabId 戳根治连切竞态（快照无戳时慢到的旧页签
 *  快照会覆盖新活动页签内容）——webview 收到非活动页签的快照直接丢弃 */
export interface UiStateMsg {
  type: "uiState";
  tabId: string;
  /** 全量消息快照（busy 且有在途消息时已剥尾部在途消息，刀 5b 同款保守条件） */
  messages: SessionMessage[];
  /** busy 时的全量在途消息（liveSync 同款数据，webview 复用重定基逻辑） */
  live?: SessionMessage;
  busy: boolean;
  /** 压缩进行中（同 CompactingMsg 真相；切回页签快照恢复压缩标签） */
  compacting: boolean;
  /** busy 本轮实测耗时（同 BusyMsg.elapsedMs 口径） */
  elapsedMs?: number;
  modeText: string;
  banner: BannerPayload | null;
  /** 排队项（镜像 payload，同 QueuedAddMsg 形状；webview 原子重建 queuebar） */
  queued: QueuedItemPayload[];
  /** 页脚（同 StateMsg 字段口径；client 未 running 时 model 等为 null） */
  ver?: string;
  model?: { id: string; name?: string; provider?: string } | null;
  thinkingLevel?: number | null;
  sessionFile?: string | null;
  sessionName?: string | null;
  stats?: { contextPercent?: number | null; cost?: number } | null;
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

/* ══════════════ 工单十五：tabId 附加字段 ══════════════ */

/** 面板内多标签（工单十五刀1）：宿主↔webview 双向消息的 tabId 附加字段。
 *  以交叉类型附加而不并入各判别联合成员（✅活 2 约定照守——逐成员加公共字段改动面大且
 *  有毒化字面量收窄的前科；交叉类型附加零成员改动，两侧按需读写 tabId）。
 *  tabId 缺省 = 未标归属（webview 启动握手期等），宿主按活动标签兑底路由。 */
export interface TabTag {
  tabId?: string;
}
export type HostToWebviewTagged = HostToWebview & TabTag;
export type WebviewToHostTagged = WebviewToHost & TabTag;

export type HostToWebview =
  | UserMsg
  | NewLiveMsg
  | DeltaMsg
  | ThinkingMsg
  | ToolStartMsg
  | ToolCallStartMsg
  | ToolCallDeltaMsg
  | ToolEndMsg
  | SubagentUpdateMsg
  | SubagentDetailMsg
  | BusyMsg
  | RenderMsg
  | QueueMsg
  | NoticeMsg
  | FillInputMsg
  | StatusMsg
  | CompactingMsg
  | ModeMsg
  | QueuedAddMsg
  | QueuedDeliveredMsg
  | QueuedClearMsg
  | QueuedRemoveMsg
  | QueuedRetrievedMsg
  | CodeCtxMsg
  | AddImagesMsg
  | AddFilesMsg
  | SlashListMsg
  | FileListMsg
  | StateMsg
  | ThemeMsg
  | BannerMsg
  | ChangesListMsg
  | TabsMsg
  | LiveSyncMsg
  | UiStateMsg;

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
  /** 全量在途消息（pi 源码验证：agent-session.js:501 _emit 携带 event.message，
   *  同一对象 in-place 更新）——续接重定基（刀5b liveSync）的真相源 */
  message?: { role: string; content?: unknown[] };
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
/** 工具执行中的流式部分结果（pi extensions/types.d.ts:615）——subagent 监控的数据源 */
export interface PiToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args?: unknown;
  /** subagent 扩展在 onUpdate 里上报 AgentToolResult，进度在 .details.results（保守可选） */
  partialResult?: { details?: unknown } | null;
}
/** 异步子 agent 后台进度（A2+B：subagent 扩展 appendEntry("subagent-async")，不进 LLM 上下文的旁路） */
export interface PiEntryAppendedEvent {
  type: "entry_appended";
  entry?: { type?: string; customType?: string; data?: unknown } | null;
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
  | PiToolExecutionUpdateEvent
  | PiEntryAppendedEvent
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
