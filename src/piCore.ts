/**
 * piCore —— 核心控制器（DIRECTOR.md 工单四：panel.ts 核心/宿主分层的产品线地基）。
 *
 * 铁律：本文件禁止 import vscode。所有宿主能力经 HostCapabilities 接口注入，
 * VS Code 特定 UI（QuickPick 菜单/文件对话框/编辑器操作）住在 panel.ts（adapter），
 * 经 UiActions 回调进来。本文件只做：onPiEvent 状态机、prompt 组装（附件/代码上下文协议）、
 * 队列转正逻辑、会话恢复编排、webview 消息路由。
 *
 * 搬运纪律：方法体自 panel.ts 逐字符移植（工单四要求行为零变化），仅 vscode 触点换 caps。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { PiClient } from "./piClient";
import { STRINGS, NATIVE_KEYS, bb, fmt, fmt2, type Lang } from "./i18n";
import type { BannerPayload, GetSessionStatsResult, HostToWebview, PiEvent, PiUnknownEvent, ToolChangedFile, WebviewToHost } from "./protocol";
import { subagentSnapshot, subagentSnapshotFull } from "./subagentSnapshot";
import { toolDetail } from "./toolDetail";
import type { HostCapabilities } from "./hostCapabilities";

/** webview 消息路由里属于「VS Code 原生 UI 流程」的分支，由 adapter 实现本接口承接 */
export interface UiActions {
  pickSession(scope: "project" | "all"): Promise<void>;
  treeFork(): Promise<void>;
  importSession(): Promise<void>;
  shareSession(): Promise<void>;
  uploadImage(): Promise<void>;
  pickMode(): Promise<void>;
  revealSessionFile(file: string): Promise<void>;
  openPath(path: string): Promise<void>;
  /** 拖入 URI → 绝对路径（vscode.Uri 转 fsPath 并校验存在；不存在的丢弃） */
  resolveUris(uris: string[]): Promise<{ name: string; path: string }[]>;
  more(): Promise<void>;
  settings(): Promise<void>;
  pickModel(): Promise<void>;
  pickThinking(): Promise<void>;
  pickTheme(): Promise<void>;
  pickLang(): Promise<void>;
  /** 压缩上下文（面板原生 /compact：直接压不二次确认，810f39c）；带可选指令的入口在 ⚡ 菜单，属 adapter */
  compactSession(): Promise<void>;
  /** 导出会话为 HTML（面板原生 /export） */
  exportSession(): Promise<void>;
  /** 克隆当前会话（面板原生 /clone） */
  cloneSession(): Promise<void>;
  openTerminalLogin(): void;
  /** pi 启动失败（找不到命令等）：宿主弹错误框并提供一键安装 */
  startError(err: Error): void;
  /** 工单七：展示「本次改动」QuickPick（git/diff/还原语义全在 adapter） */
  showChanges(): Promise<void>;
  /** 工单七：收起「本次改动」条（宿主状态收口，webview 重建不重发） */
  dismissChanges(): Promise<void>;
}

export class PiCore {
  static readonly viewId = "piChat.view"; // 保持与原 panel.ts 相同的视图 id 常量位

  private client?: PiClient;
  private clientNoSession = false;
  /** 在途 assistant 消息的全量对象（刀5b）：pi 的 message_start/update 事件自带完整消息
   *  （同一对象 in-place 更新，agent-session.js:501），供切回 busy 页签时 liveSync 重定基；
   *  agent_start 清空（新 run 无在途）、message_start 覆写（新消息开始） */
  private liveMessage: any = null;
  /** 在途标记（工单24）：message_start(assistant) 置位、message_end/agent_start/settled 清除。
   *  liveMessage 引用不是在途凭证——工具窗口期它指向已完成消息（stale），只作内容载体；
   *  误把 stale 消息当在途发 live 基线会双画（工单十八 ×2 同根） */
  private liveStreaming = false;
  /** busy 已从镜像退化为派生真相（工单十五刀6，用户问「busy 还有存在的必要吗」）：
   *  RPC 时代靠镜像+三层对账去猜（piClient 头注释原话），直连后 pi 的 isStreaming
   *  （agent-session.d.ts:295）同步可读——8 处 setter/对账纠偏/观察断言全是给漂移擦屁股，
   *  整树回收。剩两个合成项：①isStreaming 真相；②pendingPrompt 乐观窗口（prompt 已发
   *  尚未翻转的空窗 + /llama 类命令式应答——4s 兑底红线保留，职责收窄为此）。busy 事件
   *  （推 webview）不废：webview 无法轮询，spinner/stop 按钮事件驱动 */
  private get busy(): boolean {
    return this.pendingPrompt || (this.client?.isStreaming ?? false);
  }
  /** 当前编辑器的代码上下文（adapter 监听选区后经 setCodeContext 注入，prompt 组装消费） */
  private codeCtx: { name: string; rel: string; range: string; text: string } | null = null;
  /** 中断后跳过一次 settled 重绘（会话里被中断的消息是空的，重绘会抹掉现场） */
  private abortSkipRender = false;
  /** 排队镜像（插件自己发过的插队消息）。kind = pi 队列归属（工单十六）：插件链路入队一律
   *  streamingBehavior:"steer"（见 sendPromptCore），发送时即知类型，不靠 queue_update 对账猜；
   *  取回重排队时按原类型走 steer()/followUp() */
  private queued: { qid: string; sentText: string; text: string; imageCount: number; codeInfo?: string; kind: "steer" | "followUp" }[] = [];
  /** 最近一次已知会话名/文件（用于自动命名判断） */
  private lastSessionName: string | null = null;
  /** 命令式应答标记：发出 prompt 后未等到 agent_start 前为 true（用于清除乐观 busy/免误导性中断提示） */
  private pendingPrompt = false;
  /** 压缩进行中（compaction_start→compaction_end）：驱动 webview 状态栏「⏳ 正在压缩上下文」。
   *  手动压缩不走 agent_start（空闲会话无 agent 事件），没有它压缩期间零反馈；且压缩中发消息
   *  被 preflight 拒收时 sendPromptCore 的 busy:false 会清状态栏——webview 靠这条真相保住压缩标签 */
  private compacting = false;
  /** 本轮 agent 运行起点（agent_start 时记录，settled 时算实测耗时）；0=无运行 */
  private runStartTs = 0;
  private lastSessionFile: string | null = null;
  /** 已自动命名过的会话文件（避免重复 RPC） */
  private autoTitledFor: string | null = null;
  /** pi 侧 queue_update 报告的排队总数（steering+followUp），用于检测“队列变短=插话已被取走” */
  private lastQueueTotal = 0;
  /** 工单十六：取回事务进行中。clearQueue/重排队自己就会触发 queue_update，若不抑制，
   *  「队列变短」会被既有转正逻辑误判成 agent 取走 → 保留集还没重排队就被转正成用户气泡。
   *  抑制期间只记账 lastQueueTotal；收口对账由 retrieveQueued 自己做（历史比对后 queuedDelivered） */
  private retrieving = false;
  // ── 工单24：快照期事件闸门──
  /** 闸门开=快照窗口中：post 出口统一分流，流式/状态事件入队不直发（uiState 本身与
   *  notice/交互应答/subagentUpdate 直发）。不逐事件 case 打补丁——漏一类就是新事故 */
  private gateOpen = false;
  private gateQueue: HostToWebview[] = [];
  /** postUiState 单飞：窗口期再入只标重跑（用最新真相重拉），避免重叠快照互冲 */
  private uiStateRunning = false;
  private uiStateRerun = false;
  /** 原始出口（panel.pipeFromCore）；post 是带闸门的包装（见构造器） */
  private readonly rawPost: (msg: HostToWebview) => void;
  readonly post: (msg: HostToWebview) => void;
  /** 最近一次权限模式徽标文本（webview 重建后补发用：session_start 的 setStatus 只推一次） */
  private lastModeText = "";
  /** 启动恢复闸门：按项目恢复上次会话期间，webviewReady 的重绘等它完成，
   * 避免先画出 -c 恢复的会话再跳到记住的会话（「闪一下 + 标题/内容对不上」的根源） */
  private restoringSession: Promise<void> | null = null;
  /** 压缩横幅（工单六）：单份持有、变更才下发；webview 重建后 webviewReady 握手重发 */
  private banner: BannerPayload | null = null;
  /** 阈值预警闸门：涨破阈值只提醒一次（同一会话）；占比回落（压缩后）/换会话 re-arm */
  private contextWarnArmed = true;
  /** 工单七：本轮 pi 经 edit/write 工具触碰的文件（工具调用提取，同 pi 官方压缩口径
   *  extractFileOpsFromMessage；bash/powershell 改动 pi 自身不追踪，由 adapter git 比对兜底）。
   *  会话域持有：agent_start 清空、换 sessionFile 清空，多标签落地时直接复用为归属层 */
  private runChangedFiles = new Map<string, ToolChangedFile>();
  /** 工单七：toolCallId → 文件路径。end 事件不带 args（实查 pi-agent-core types.d.ts:410
   *  只有 toolCallId/toolName/result/isError），patch 归档必须靠 start 时记下的映射。
   *  注：此修复曾随 5f30a51 后的未提交态被 11:24 的 checkout 连坐丢失，本次重打 */
  private toolCallPaths = new Map<string, string>();
  /** toolCallId → 工具行摘要（start 时的 toolDetail(args)）。end 事件不带 args（见上）,
   *  toolEnd 转发时 detail 恒为空串——webview toolEnd() 整行重建后命令/路径摘要蒸发，
   *  要等 settled 全量重绘（c.arguments）才回来（2026-09-20 用户实测截图）。缓存兜底 */
  private toolCallDetails = new Map<string, string>();
  /** 工单 A（下钻）：subagent 运行留存 —— id（toolCallId 或异步句柄）→ 最新全量 details + 计时。
   *  快照协议消息只带 12 条尾窗（概览够用），下钻要看全量活动流，宿主必须自留正本；
   *  计时同理：pi 事件不带时间戳，宿主首见即起表。上限 30 个防长会话无界增长 */
  private subagentRuns = new Map<string, { details: unknown; startAt: number; endAt?: number }>();
  /** 历史重放已消费的会话文件（债务④）：每文件只放一次，此后 live 事件接管，
   *  防切页签 uiState 反复重放同帧覆写 webview 较新状态 */
  private subagentHistoryReplayedFor: string | null = null;
  /** 已终结的 subagent 工具调用 id。异步派发的同步壳在 end 之后还会收到 onUpdate 流（后台
   *  每个回合边界 emitUpdate，pi 照发 tool_execution_update），不拦的话 webview 会重建
   *  已关闭的行——2026-09-18 实测事故：4 次异步派发 = 4 条永转“处理中”幽灵行 */
  private subagentEndedCalls = new Set<string>();

  /** 留存/更新运行正本；超上限淘汰最早的（Map 迭代序即插入序） */
  private trackSubagentRun(id: string, details: unknown): { startAt: number; endAt?: number } {
    let rec = this.subagentRuns.get(id);
    if (!rec) {
      rec = { details, startAt: Date.now() };
      this.subagentRuns.set(id, rec);
      if (this.subagentRuns.size > 30) {
        const oldest = this.subagentRuns.keys().next().value;
        if (oldest !== undefined) this.subagentRuns.delete(oldest);
      }
    } else {
      if (details !== undefined && details !== null) rec.details = details;
    }
    return rec;
  }

  /** 恢复重绘后重放子 agent 浮窗：runs 全是内存态，重载后不重放就「聊天里有卡片、浮窗
   *  却空了」（2026-09-18 用户实测）。数据源=持久化 toolResult.details（磁盘真相），
   *  final:true 原子回放并回填 subagentRuns（下钻视图重载后仍有全量 details）。
   *  异步壳（end 时仍全 running，工单25）与活跑同口径剔除；endAt 用工具结果消息的
   *  时间戳，浮窗「x分钟前」对齐聊天真实时序 */
  private replaySubagentRuns(msgs: unknown[]): void {
    for (const msg of msgs) {
      const m = msg as
        | { role?: string; toolCallId?: string; details?: unknown; timestamp?: unknown }
        | null;
      if (!m || m.role !== "toolResult" || !m.toolCallId) continue;
      const snap = subagentSnapshot(m.details);
      if (!snap || snap.tasks.some((t) => t.status === "running")) continue;
      const rec = this.trackSubagentRun(m.toolCallId, m.details);
      const ts =
        typeof m.timestamp === "number"
          ? m.timestamp
          : typeof m.timestamp === "string"
            ? Date.parse(m.timestamp)
            : NaN;
      if (isFinite(ts)) rec.endAt = ts;
      this.post({
        type: "subagentUpdate",
        id: m.toolCallId,
        snapshot: snap,
        final: true,
        startAt: rec.startAt,
        endAt: rec.endAt,
      });
    }
  }
  /** 字节通道附件：内容 md5 → 已落盘临时路径。同一内容复用同一路径，
   *  路径层去重天然成立（含 webview 按名判重覆盖不到的「a(1).txt」改名场景） */
  private byteAttachCache = new Map<string, string>();
  /** 工单七 run 边界回调：核心只产中性事件，adapter 拿它做 git 快照/比对。
   *  可为 null（宿主未接时收集照常、事件丢弃） */
  onRunStart: (() => void) | null = null;
  onRunSettled: ((files: ToolChangedFile[]) => void) | null = null;

  /** 面板语言（zh 默认 / en），头部 中/EN 按钮切换；持久化由 adapter 完成 */
  lang: Lang = "zh";

  /** 本核心所属标签（工单十五刀3）：panel 的 ensureCore 在创建时赋值；只作为每标签
   *  持久化键的组成（项目会话记忆/模型与思考记忆），核心不感知 UI 标签语义 */
  tabKey = "t1";

  /** 新标签=新会话（工单十五刀4，用户实测打回的根因修复）：panel 对「＋新建标签」
   *  登记的 id 置位。true 时 ensureClient 不带 -c（pi 映射到 SessionManager.create 新持久
   *  会话，session-manager.d.ts:319），restoringSession 跳过按工作区恢复——否则新标签会
   *  continueRecent 接上当前目录最近会话（= 另一标签正在写的文件），两个标签真写同一个
   *  jsonl（写冲突），用户实测「临时会话/记录消失/标题同名」三现象全是它。t1 恒 false，
   *  单标签 continue 语义不变 */
  freshTab = false;

  constructor(
    private readonly caps: HostCapabilities,
    private readonly ui: UiActions,
    post: (msg: HostToWebview) => void,
    private readonly version: string
  ) {
    this.rawPost = post;
    // 工单24：出口闸门——所有 this.post 调用点零改动，分流集中在这一处
    this.post = (msg) => {
      if (this.gateOpen && !GATE_PASS_TYPES.has(msg.type)) {
        this.gateQueue.push(msg);
        return;
      }
      this.rawPost(msg);
    };
  }

  /** 当前语言字典：面板通知/状态跟随中/EN 按钮；原生对话框专用键双语展示 */
  get L(): Record<string, any> {
    const lang = this.lang;
    return new Proxy({} as Record<string, any>, {
      get: (_t, k) => {
        const key = String(k);
        return NATIVE_KEYS.has(key) ? bb(key) : (STRINGS[lang][key] ?? bb(key));
      },
    });
  }

  get clientRef(): PiClient | undefined {
    return this.client;
  }
  get isBusy(): boolean {
    return this.busy;
  }
  get isNoSession(): boolean {
    return this.clientNoSession;
  }

  /** 横幅状态机出口（工单六）：内容变化才下发——refreshState 高频调用，不重发相同文案 */
  private setBanner(b: BannerPayload | null): void {
    const next = b ?? null;
    if (JSON.stringify(next) === JSON.stringify(this.banner)) return;
    this.banner = next;
    this.post({ type: "banner", banner: next });
  }

  /** 关键链路诊断日志（排查图片丢失/状态机等诡异问题用） */
  private dbg(msg: string): void {
    try {
      const fpath = path.join(os.homedir(), ".pi", "agent", "pi-chat-debug.log");
      // 日志轮转：超过 5MB 时把旧日志改名保留一代（rename 比截断简单，不用读盘；
      // 旧文件最多保留一代，不会无限膨胀；再超限就覆盖新文件，因为诊断日志可重放）
      try { const s = fs.statSync(fpath); if (s.size > 5 * 1024 * 1024) { fs.renameSync(fpath, fpath + ".1"); } } catch { /* 不存在/无权限则跳过 */ }
      fs.appendFileSync(fpath, new Date().toISOString() + " " + msg + String.fromCharCode(10));
    } catch { /* ignore */ }
  }

  /** adapter 监听编辑器选区后注入代码上下文（选区 → 选中行；无选区 → 整个文件） */
  setCodeContext(ctx: { name: string; rel: string; range: string; text: string } | null): void {
    this.codeCtx = ctx;
  }

  /** 权限模式徽标文本：mode.json 是磁盘全局态（pi 每次 tool_call 重读，用户实测跨页签
   *  立即生效）——刀5b 起一律磁盘优先，lastModeText 仅作文件缺失兑底；否则 A 页签切
   *  模式后切回 B 会用 B 的陈旧缓存回退徽标（显示与执行分裂）。返回空串会把徽标清空
   *  （用户实测徽标消失，fc134df） */
  modeBadgeText(): string {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "mode.json"), "utf8")).mode;
      const labels: Record<string, string> = { manual: "Manual", "edit-auto": "Edit automatically", plan: "Plan", auto: "Auto" };
      if (m && labels[m]) return "⚡ " + labels[m];
    } catch {
      // ignore
    }
    if (this.lastModeText) return this.lastModeText;
    return "⚡ Auto";
  }

  /** 首次发消息时才启动 pi 后台进程；forceSession=true 时不用 --no-session（如切换历史会话） */
  ensureClient(forceSession = false): PiClient {
    if (this.client) return this.client;

    const cwd = this.caps.getCwd();
    // ⚠ 会话模式读取：默认必须与 package.json 里的 default 保持一致（continue）。
    // 教训：曾默认 ephemeral(--no-session)，用户聊天全程不落盘，进程被替换后记录永久丢失。
    // 注解为 string：getConfig 泛型会把默认值收窄成字面量类型，后面跟 "ephemeral"
    // 比较直接 TS2367（panel.ts 原版用 vscode get<string>() 无此问题，搬运时的类型差异）
    const mode: string = this.caps.getConfig("piChat", "sessionMode", "continue");
    const ephemeral = mode === "ephemeral" && !forceSession;
    // 工单十五刀4：freshTab（＋新建的标签）不带 -c → piClient 映射到 SessionManager.create
    // （新持久会话）；绝不 continueRecent——否则接上的是别的标签正在写的会话文件（写冲突）
    // H 刀（2026-09-22 用户实测「空页签重启后变成历史第一条/之前点过的页签」，实证见
    // pi-chat-debug.log t56 时间线）：无会话记忆或记忆文件不在的页签**同样禁 -c**。pi 同
    // 口径：没内容的会话没有文件（pi -r 不列）——文件在⇔ 有内容可恢复。-c（continueRecent）
    // 只会把「最近一条会话」强加给空页签（还会和原页签双写同一文件）；无记忆一律 [] 新建。
    const mem = this.freshTab ? undefined : this.getSessionForWs(cwd);
    const memOk = !!mem && fs.existsSync(mem);
    const args = ephemeral ? ["--no-session"] : memOk && mode === "continue" ? ["-c"] : [];
    const sessionDir = this.caps.getConfig("piChat", "sessionDir", "");
    if (sessionDir) args.push("--session-dir", sessionDir);
    this.clientNoSession = ephemeral;

    const client = new PiClient();
    this.client = client;
    // 包签名随运行时创建定格：菜单打开时对比 detect 新装/卸载（见 sendSlashCommands）
    this.pkgsSig = this.readPkgsSig();

    client.onUiRequest = (req) => void this.handleUiRequest(req);
    client.onExit = (code, detail) => {
      // 刀6：进程没了 isStreaming 必为 false，busy 派生即假，无需清镜像；事件照发（webview 收尾）
      this.compacting = false; // 压缩状态随进程消亡（重连后 compaction_end 不再来，不重置标签会永久卡住）
      this.post({ type: "busy", value: false });
      this.post({ type: "compacting", value: false });
      this.dbg("busy=false (pi_exit)");
      this.post({ type: "status", text: this.L.piExitedPre + code + this.L.piExitedSuf + (detail ? this.L.seeNotify : "") });
      // 下一条消息前会自动重启 pi；把 stderr 尾巴透出，崩溃原因不再靠猜
      if (detail) this.post({ type: "notice", text: this.L.piExitedNotice + code + this.L.piExitedSuf + String.fromCharCode(10) + detail });
    };
    client.onError = (err) => this.ui.startError(err);
    client.events.on("event", (e: PiEvent) => void this.onPiEvent(e));

    this.post({ type: "status", text: this.L.startingPi });
    // 公司网络下模型接口需要走代理：pi 子进程不会继承 shell 里的代理变量，
    // 这里把 VSCode 内置 http.proxy 设置透传给 pi（HTTP_PROXY/HTTPS_PROXY）
    const proxyUrl = this.caps.getConfig("http", "proxy", "").trim();
    client.start(cwd, args, proxyUrl || undefined);

    // 插话送达方式（默认逐条，CC 风格：排队消息一条条处理）
    const steerMode = this.caps.getConfig("piChat", "steeringMode", "one-at-a-time");
    // 模型请求失败自动重试（默认开启，Z.ai 免费档超时/过载常见）
    const autoRetry = this.caps.getConfig("piChat", "autoRetry", true);
    void (async () => {
      try {
        await client.setSteeringMode(steerMode as "all" | "one-at-a-time");
        await client.setAutoRetry(autoRetry);
      } catch {
        // 应用失败不影响使用
      }
    })();

    // 恢复上次使用的模型/思考等级（每标签记忆，工单十五刀3）：不再与 switchSession 并行赛跑
    // （原 fire-and-forget 补回实测会被恢复流程的 switchSession 冲掉——pi 切会话会把模型
    // 重置为会话文件里存的值），改由 restore 流程在 switchSession 之后统一补回，见下

    // 初始化状态和已有会话内容：按项目恢复上次使用的会话文件（免重选，且不串项目）。
    // 注意顺序：先等恢复（可能 switchSession）完成再刷新状态/重绘，
    // 否则标题是 -c 恢复的会话、内容却是记住的会话，两边对不上
    this.restoringSession = (async () => {
      // A 刀诊断日志：boot 链三埋点（start/done/FAIL）。此前 catch 全静默是 P0 排查
      // 最大盲区——applyModelMemory 迁移这类早期一炸整链死，零痕迹（空白视图/页脚「—」
      // 全对不上号）。吞掉语义不变：这里只加留痕，不改任何行为。
      this.dbg("boot start tab=" + this.tabKey + (this.freshTab ? " freshTab" : ""));
      try {
        // 工单十五刀4：freshTab 跳过按工作区恢复——新标签的会话记忆由它自己首次会话写入，
        // 不能把别的标签存的会话文件抢过来当恢复目标（同根因：写冲突）
        const last = this.freshTab ? undefined : this.getSessionForWs(cwd);
        if (last && fs.existsSync(last)) {
          try {
            await client.switchSession(last);
          } catch {
            // 文件失效则退回 -c 恢复的最近会话
          }
        }
        // 模型/思考记忆补回必须在 switchSession **之后**（顺序即正确性），随后的
        // refreshState 把补回结果同步到页脚（用户报「一切会话模型就变了」的修复）
        await this.applyModelMemory();
        await this.refreshState(); // 切换后立刻同步标题，杜绝「内容 A 标题 B」
        const d = await client.getMessages();
        this.post({ type: "render", messages: d?.messages ?? [] });
        this.replaySubagentRuns(d?.messages ?? []);
        this.dbg("boot done tab=" + this.tabKey);
      } catch (err: any) {
        // 仍然吞掉（行为零变更，A 刀纯诊断）：FAIL 必须留痕，静默整链死是 P0 的隐身衣
        this.dbg("boot FAIL tab=" + this.tabKey + ": " + ((err && err.message) || String(err)));
      } finally {
        this.restoringSession = null;
      }
    })();
    return client;
  }

  /** 强制关闭当前 pi 进程（ephemeral 会话需要重启为持久模式时用） */
  disposeClient(): void {
    this.client?.dispose();
    this.client = undefined;
  }

  /** 释放全部资源（面板销毁/扩展卸载） */
  dispose(): void {
    this.client?.dispose();
    this.client = undefined;
  }

  /** 读取当前项目对应的“上次会话”——每标签一份（工单十五刀3）：
   *  新 key value 形状 {工作区: {tabKey: 会话文件}}；旧 key（{工作区: 文件} 单值）
   *  只读迁移不回写——t1 兑底沿用存量记忆（首条 switchSession 后 setSessionForWs
   *  自然写入新 key），其余标签不抢旧值（避免多标签启动互相踩同一恢复目标） */
  private getSessionForWs(cwd: string): string | undefined {
    const key = cwd.replace(/\\+$/, "").toLowerCase();
    return sessionMemoryFor(
      <T>(key2: string, defaultValue: T): T => this.caps.getPersist<T>(key2, defaultValue),
      key,
      this.tabKey
    );
  }

  /** 写入当前项目对应的“上次会话”（每标签一份，工单十五刀3；旧 key 不再写，可回滚） */
  private setSessionForWs(file: string): void {
    const cwd = this.caps.getCwd();
    if (!cwd) return;
    const key = cwd.replace(/\\+$/, "").toLowerCase();
    const tabMap = this.caps.getPersist<Record<string, Record<string, string>>>("piChat.lastSessionByWs2", {});
    (tabMap[key] ??= {})[this.tabKey] = file;
    this.caps.setPersist("piChat.lastSessionByWs2", tabMap);
  }

  /** pickModeMenu（adapter）写入新徽标文本；webview 重建补发用（modeBadgeText 兑底） */
  setModeText(text: string): void {
    this.lastModeText = text;
  }

  /** adapter 的 deleteSessionPick 守卫读取：当前打开的会话不删 */
  get currentSessionFile(): string | null {
    return this.lastSessionFile;
  }

  /** adapter 的 pushCodeContext 判断「无编辑器且无上下文」时是否需要发清理消息 */
  get hasCodeContext(): boolean {
    return this.codeCtx !== null;
  }

  /** webview 消息路由入口（adapter 的 onDidReceiveMessage 直连本方法） */
  async onWebviewMessage(m: WebviewToHost): Promise<void> {
    // A 刀诊断日志：in 落盘——消息进核心的到达证明（「消息到 webview 一跳」断链排查的
    // 对向锚点：in 有痕 out 无痕 = 断在核心之后；in 无痕 = 断在 webview/路由）
    this.dbg("in " + msgBrief(m) + " core=" + this.tabKey);
    // 兜底 catch：case 内未自行接住的抛错不得静默蒸发（async 方法无人接 reject，
    // compactSession 抛错零反馈事故的类级修复，2026-09-09）；各 case 自身的
    // try/catch 优先生效，此处只接漏网之鱼
    try {
      await this.dispatchWebviewMessage(m);
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.opFail + (err?.message ?? err) });
    }
  }

  /** UI 真相全量重发（工单十五刀5）：webview 不自养影子状态，页签切回/重建时由核心把
   *  pi 会话真相一次推齐——消息重绘（session.messages）+ busy（真实耗时）+ 排队（queued
   *  数组）+ 权限模式 + 压缩横幅。webviewReady 与页签切换共用。
   *
   *  【工单24 实证重写（推翻首版回放实现）】探针 scripts/probe-inflight.mjs 实测：
   *  在途 assistant 消息在 message_start/update 期间**不在 session.messages 里**
   *  （state 尾条仍是上一条已完成消息），直到 message_end 才入 state——刀5b 注释
   *  「message_start 起就在 agent.state.messages 里」是错的。后果：任何「剥末条+live
   *  重定基」的方案，剥掉的都是上一条**已完成**消息（内容凭空消失），首版按工单字面做的
   *  「T0 基线+全量回放」实测丢得更狠（20ms yield 被长会话重绘顶穿，回放事件先落地
   *  再被 renderAll 冲掉）。正确形状：
   *   ① 历史 = session.messages 全量（零剥离，天然不含在途消息）；
   *   ② live = 在途消息全量深拷贝（事件对象 in-place 更新，实测内容递增）；
   *   ③ ①②在**同一个同步块**里取（无 await，事件插不进来）→ 天然不重不漏；
   *   ④ 快照窗口内到达的事件一律丢弃——全部 ≤ 快照时刻，已被①②覆盖，重放=同段两遍；
   *   ⑤ 快照之后到达的事件由 webview 侧「重绘期流式事件延后一拍」兑底（main.ts
   *      pendingStream），顺序保证落在消费端，不再赌宿主侧 sleep。
   *  单飞保留：窗口期再入标重跑（最新真相重拉），连切页签重叠快照互冲消失 */
  async postUiState(): Promise<void> {
    if (this.uiStateRunning) {
      this.uiStateRerun = true;
      return;
    }
    this.uiStateRunning = true;
    // 关闸（两跳 await 之前）：窗口内流式事件不直达 webview——直达会先画、再被快照重绘冲掉
    this.gateOpen = true;
    const gateT0 = Date.now();
    try {
      // 启动恢复（switchSession）还在进行时先等它，避免重绘到旧会话再跳一次
      if (this.restoringSession) await this.restoringSession.catch(() => {});
      // 页脚数据（含既有副作用：会话记账/横幅 re-arm）先拉——它有 await，快照必须在其后取
      const foot = await this.collectState();
      // ——同步快照块（无 await，事件插不进来）：历史全量 + 在途消息深拷贝同拍取——
      // tabId 戳：webview 收到非活动页签快照直接丢弃（连切竞态：慢到的旧快照覆盖新页签内容）
      const msgs = this.client ? this.client.messagesSync() : [];
      const live = this.busy && this.liveStreaming && this.liveMessage
        ? JSON.parse(JSON.stringify(this.liveMessage))
        : null;
      this.post({
        type: "uiState",
        tabId: this.tabKey,
        messages: msgs,
        ...(live ? { live } : {}),
        busy: this.busy,
        compacting: this.compacting,
        ...(this.busy && this.runStartTs > 0 ? { elapsedMs: Date.now() - this.runStartTs } : {}),
        modeText: this.modeBadgeText(),
        banner: this.banner,
        queued: this.queued.map((q) => ({
          qid: q.qid,
          text: q.text,
          imageCount: q.imageCount,
          ...(q.codeInfo !== undefined ? { codeInfo: q.codeInfo } : {}),
        })),
        ver: foot?.ver,
        model: foot?.model ?? null,
        thinkingLevel: foot?.thinkingLevel ?? null,
        sessionName: foot?.sessionName ?? null,
        sessionFile: foot?.sessionFile ?? null,
        stats: foot?.stats ?? null,
      });
      // 浮窗历史重放（债务④）：webview 重载后内存账本清零，从会话文件回填——
      // 空闲时才放：busy 说明 live 事件正在流，重放帧可能用旧纪元同句柄的终态覆写运行中行。
      // subagentUpdate 走闸门直发（GATE_PASS_TYPES），不会被丢
      if (!this.busy) void this.replaySubagentHistory();
    } catch {
      // ignore
    }
    // 释放闸门：窗口内事件全部 ≤ 同步快照时刻，已被快照（历史+live）覆盖——丢弃不重放
    // （重放=同段内容两遍）。快照之后到达的事件由 webview 重绘期延后一拍兑底。
    // 丢弃清单进 dbg（实证留痕：窗口接住了什么、丢了什么一目了然）
    const dropped = this.gateQueue;
    this.gateQueue = [];
    this.gateOpen = false;
    if (dropped.length) {
      this.dbg(
        `gate drop: window=${Date.now() - gateT0}ms dropped=${dropped.length}` +
          ` types=[${dropped.map((m) => m.type).join(",")}]`
      );
    }
    this.uiStateRunning = false;
    if (this.uiStateRerun) {
      this.uiStateRerun = false;
      void this.postUiState();
    }
  }

  /**
   * 浮窗历史重放（债务④，2026-09-18）：subRunsByTab 只吃实时事件，重载即清——消息流
   * 从 jsonl 重放、浮窗不翻旧账。数据源 = 会话文件里 subagent-async 自定义 entry 帧
   * （detail 带全量 messages/startedAt/endedAt，实测持久）；**不能用 toolResult.details**——
   * 异步场景它是工具返回瞬间冻结的空壳（messages 0、usage 全 0，当日实捞验证）。
   * 只读尾部 2MB（会话文件可能很大，帧频率低尾部足够）；首行可能截断半条 JSON，丢弃。
   * 同句柄跨纪元重用（扩展进程重启后 handle 从 sa-1 重计、同一 jsonl 追加）：取终态帧
   * 优先于末帧。重放失败静默——这是增强不是链路必需。
   * 【0.0.126 修订】尾窗作废：长会话（大截图/长文本）尾部 2MB 只够装最后一个纪元，
   * 历史运行被拦腰截断（用户实测「列表里只有一个调用记录」）。改全文件扫描——
   * subagent-async 行稀疏，只 parse 命中行，一次性成本可接受。
   */
  private async replaySubagentHistory(): Promise<void> {
    const file = this.lastSessionFile;
    if (!file || file === this.subagentHistoryReplayedFor) return;
    this.subagentHistoryReplayedFor = file;
    try {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || stat.size === 0) return;
      const buf = await fs.promises.readFile(file);
      const lines = buf.toString("utf8").split("\n");
        const finals = new Map<string, { frame: { detail: unknown; final: boolean; startAt?: number; endAt?: number }; order: number }>();
        let order = 0;
        for (const line of lines) {
          let o: unknown;
          let isAsyncEntry = false;
          if (line.includes("subagent-async")) {
            isAsyncEntry = true;
            try { o = JSON.parse(line); } catch { continue; } // 截断半条/非 JSON 行跳过
          } else if (line.includes("toolResult") && line.includes('"details"')) {
            try { o = JSON.parse(line); } catch { continue; }
          } else {
            continue;
          }
          const rec = o as Record<string, unknown> | null;
          if (!rec) continue;
          let h: string | null = null;
          let frame: { detail: unknown; final: boolean; startAt?: number; endAt?: number } | null = null;
          if (isAsyncEntry) {
            if (rec.type !== "custom" || rec.customType !== "subagent-async") continue;
            const d = rec.data as Record<string, unknown> | undefined;
            h = typeof d?.handle === "string" ? d.handle : null;
            if (!h || !d) continue;
            frame = {
              detail: d.detail,
              final: d.status !== "running",
              ...(typeof d.startedAt === "number" ? { startAt: d.startedAt as number } : {}),
              ...(typeof d.endedAt === "number" ? { endAt: d.endedAt as number } : {}),
            };
          } else {
            // 同步调用（工单26验收后续缺口，自然语言分流下同步才是默认）：toolResult.details
            // 是全量正本。空壳防御：results 空或首任务 messages 为 0 = 异步返回值的冻结壳，跳过
            const m = rec.message as Record<string, unknown> | undefined;
            if (!m || m.role !== "toolResult") continue;
            const det = m.details as Record<string, unknown> | undefined;
            if (!det) continue;
            const mode = det.mode;
            if (mode !== "single" && mode !== "parallel" && mode !== "chain") continue;
            const results = det.results as Record<string, unknown>[] | undefined;
            if (!results || results.length === 0) continue;
            const msgs = results[0]?.messages as unknown[] | undefined;
            if (!msgs || msgs.length === 0) continue;
            h = typeof m.id === "string" ? m.id : null;
            if (!h) continue;
            frame = { detail: det, final: true, ...(rec.timestamp ? { endAt: Date.parse(rec.timestamp as string) || undefined } : {}) };
          }
          order++;
          const prev = finals.get(h);
          if (!prev || frame.final) finals.set(h, { frame, order });
        }
        const ordered = [...finals.entries()].sort((a, b) => a[1].order - b[1].order);
        for (const [h, { frame }] of ordered) {
          const snap = subagentSnapshot(frame.detail);
          if (!snap) continue;
          // 快照里还有 running 任务的帧不投（异步壳冻结态/口径异常），防水久「处理中」假行
          if (snap.tasks.some((t) => t.status === "running")) continue;
          const rec = this.trackSubagentRun(h, frame.detail);
          if (frame.startAt !== undefined) rec.startAt = frame.startAt;
          if (frame.endAt !== undefined) rec.endAt = frame.endAt;
          this.post({
            type: "subagentUpdate",
            id: h,
            snapshot: snap,
            final: frame.final,
            startAt: rec.startAt,
            endAt: rec.endAt,
          });
        }
    } catch {
      // 会话文件不可读（新建未落盘/切换中）静默
    }
  }

  private async dispatchWebviewMessage(m: WebviewToHost): Promise<void> {
    switch (m.type) {
      case "subagentDetailRequest": {
        // 工单 A 下钻：概览行点击 → 用留存的全量 details 构建 Full 快照（活动流 400 条、
        // 产出 60k 字）；无留存（webview 重载后历史丢失）回空任务快照，前端显示无数据
        const rec = this.subagentRuns.get(m.id);
        const snap = subagentSnapshotFull(rec?.details) ?? { mode: "single" as const, tasks: [] };
        this.post({ type: "subagentDetail", id: m.id, snapshot: snap });
        break;
      }
      case "webviewReady": {
        // webview（重）加载完成：无条件拉一次会话重绘。重开插件/窗口重载/临时切走后回来，
        // 历史聊天都在——这是「聊天记录丢了」事故的第一道保险（真相重发已抽成 postUiState，刀5）
        void this.postUiState();
        break;
      }
      case "prompt": {
        // 斜杠命令拦截（必须在乐观置 busy 之前）：
        // - 面板原生命令 → 本地执行，不碰 prompt（原因见 nativeSlashCommands 注释）
        // - 终端专用命令 → 提示去终端，同样不能漏给模型
        // - 技能/模板（/skill:xx、/模板名）不在表里 → 正常走 prompt，pi 展开后是真任务，busy 合理
        // 按首 token 匹配：/compact xxx、/model gpt 这类带参数写法也能命中（参数忽略，
        // 需要参数的原生命令自己弹输入框）
        const trimmed = String(m.text ?? "").trim().toLowerCase();
        const firstTok = trimmed.split(/\s+/)[0];
        const native = this.nativeSlashCommands().find((c) => "/" + c.name === firstTok);
        if (native) {
          void native.run();
          break;
        }
        const tuiOnly: Record<string, string> = {
          "/hotkeys": this.L.tuiHotkeys,
          "/help": this.L.tuiHelp,
          "/copy": this.L.tuiCopy,
          "/quit": this.L.tuiQuit,
          "/logout": this.L.tuiOnly,
          "/name": this.L.tuiOnly,
          "/session": this.L.tuiOnly,
          "/scoped-models": this.L.tuiOnly,
          "/trust": this.L.tuiOnly,
          "/changelog": this.L.tuiOnly,
          "/debug": this.L.tuiOnly,
        };
        if (tuiOnly[firstTok]) {
          this.post({ type: "notice", text: tuiOnly[firstTok] });
          break;
        }
        this.dbg("prompt: images=" + (m.images ? m.images.length : 0) + " files=" + (m.files ? m.files.length : 0) + " busy=" + this.busy);
        let text = m.text;
        const codeInfo = m.attachCode && this.codeCtx ? this.codeCtx.name + " " + this.codeCtx.range : undefined;
        // 附件文件（顶部胶囊行，可多个）→ 拼进消息文本
        if (Array.isArray(m.files) && m.files.length) {
          for (const f of m.files) {
            if (!f) continue;
            if (f.path) {
              // 路径模式：让 pi 自己读文件，不把内容内联进 prompt
              text = "--- 附件: " + (f.name || "file") + " (路径: " + f.path + ")\n请用 read 工具读取此文件。\n--- 附件结束: " + (f.name || "file") + " ---\n\n" + text;
            } else if (typeof f.text === "string" && f.text.length) {
              // 不用 ``` 包裹：文件内容本身可能含 ``` 会提前闭合围栏；用唯一结束行分界
              text = "--- 附件: " + (f.name || "file") + " ---\n" + f.text + "\n--- 附件结束: " + (f.name || "file") + " ---\n\n" + text;
            }
          }
        }
        if (m.attachCode && this.codeCtx) {
          const c = this.codeCtx;
          text = "--- 代码上下文: " + c.rel + " (" + c.range + ") ---\n" + c.text + "\n--- 代码上下文结束 ---\n\n" + text;
        }
        // 气泡显示实际发送的内容：有文字显示文字；纯代码附带/纯图片时显示对应的占位语（与会话记录一致）
        const displayText = m.text || (codeInfo ? this.L.seeCode : m.images?.length ? this.L.seeImage : m.files?.length ? this.L.seeFiles : m.text);
        // 工单十六：发送核心抽成 sendPromptCore（乐观 busy/4s 兜底/steer 自愈/自动命名全套语义），
        // 本 case 只留斜杠拦截与附件组装——取回重排队（retrieveQueued）的 idle 首项复用同一链路
        await this.sendPromptCore(text, displayText, m.text, { images: m.images, fileCount: m.files?.length ?? 0, codeInfo });
        break;
      }
      case "abort":
        try {
          if (this.client?.running) {
            // pi 不把中断时的部分内容写进会话文件（content 为空），
            // 下次 agent_settled 的整页重绘会把已显示的思考/工具行抹掉——跳过那一次重绘，保留现场。
            // 守卫必须在 abort() **之前**立：abort() 内部 await waitForIdle()，agent_settled 就在
            // 这个等待窗口里被处理完（实测日志 2026-09-22 10:39:05：settled 的重绘 .422 先跑、
            // abort 分支 .431 才续），事后补标记永远迟到——旧写法这守卫从未生效过。
            // 只在 busy 时立：空闲 abort 没有 run 可断，立了会变成吞下一次重绘的哑弹
            //（agent_start 清标只是兑底，命令式应答不触发 agent_start）
            if (this.busy) this.abortSkipRender = true;
            await this.client.abort();
            if (this.busy && this.pendingPrompt) {
              // 命令式应答（如 /llama，无 agent 运行）：没有可中断的东西，直接清掉乐观 busy，不弹中断提示
              this.abortSkipRender = false; // 没有 run 被中断，没有该跳的重绘，别反过来吞掉下一次
              this.pendingPrompt = false;
              this.post({ type: "busy", value: false });
              this.dbg("busy=false (abort_while_pendingPrompt)");
              break;
            }
            this.post({ type: "notice", text: this.L.aborted });
          }
        } catch {
          // abort 失败 = run 还在跑，之后的 settled 该正常重绘，不能被守卫吞掉
          this.abortSkipRender = false;
        }
        break;
      case "retryFromLast": {
        // 模型请求失败后的重试入口（错误气泡「↺ 修改后重试」）。
        // 事故教训（2026-09-20 用户拍板）：旧实现走 client.fork 回退到最近一条用户消息，
        // 会把该轮 assistant 已完成的全部工作（思考/几十个工具调用）从活跃分支裁掉——
        // 网络断一下也得从头再来。pi 原生 TUI 遇错从不删东西：错误消息留在分支里，
        // 用户直接再发消息（如「继续」）就能接着干。故改为纯回填：只把上一条用户消息
        // 原文填回输入框供修改重发，会话零改动、工作全保留。
        try {
          const fm = await this.client?.getForkMessages();
          const list: any[] = fm?.messages ?? [];
          const last = list[list.length - 1];
          if (!last) {
            this.post({ type: "notice", text: this.L.noMsgToFork });
            break;
          }
          let text = String(last.text ?? "");
          // 剥离头部块：新格式（结束行分界）为主，老格式（围栏）兜底
          const hdr = text.match(/^--- 代码上下文: .+? \((.+?)\) ---\n/);
          if (hdr) {
            const term = "\n--- 代码上下文结束 ---\n";
            const ei = text.indexOf(term);
            if (ei > 0) {
              text = text.slice(ei + term.length);
              if (text.startsWith("\n")) text = text.slice(1);
            } else {
              const ci = text.lastIndexOf("\n```\n\n");
              text = ci > hdr[0].length ? text.slice(ci + 6) : text.slice(hdr[0].length);
            }
          }
          let am: RegExpMatchArray | null;
          while ((am = text.match(/^--- 附件: ([^\n]*) ---\n/))) {
            const term2 = "\n--- 附件结束: " + am[1] + " ---\n";
            const ei2 = text.indexOf(term2);
            if (ei2 < 0) break;
            text = text.slice(ei2 + term2.length);
            if (text.startsWith("\n")) text = text.slice(1);
          }
          this.post({ type: "fillInput", text });
          this.post({ type: "notice", text: this.L.retryFilled });
        } catch (err) {
          this.post({ type: "notice", text: this.L.forkFail + (err as Error).message });
        }
        break;
      }
      case "pickSession":
        await this.ui.pickSession("project");
        break;
      case "treeFork":
        await this.ui.treeFork();
        break;
      case "importSession":
        await this.ui.importSession();
        break;
      case "shareSession":
        await this.ui.shareSession();
        break;
      case "newSession":
        await this.newSession();
        break;
      case "uploadImage":
        await this.ui.uploadImage();
        break;
      case "attachFile":
        // 非图片文件 → 顶部附件行胶囊（与拖拽/粘贴/上传同一模型）
        if (typeof m.data === "string" && m.data.length) {
          // 路径兑底字节通道：OS 拖入/剪贴板拿不到绝对路径（新版 Electron 移除 File.path），
          // 宿主落临时文件再把路径交给 pi。临时名带时间戳每次都不同 → webview 按路径去重
          // 对它失效（同一文件拖三次进来三份的事故），所以按内容 hash 复用临时文件：
          // 同样字节永远落同一路径，去重回到路径层天然成立；也顺带治好浏览器
          // 「a(1).txt」改名的绕名重复。发重复文件时 pi 收到的是同一路径，等于零成本
          const buf = Buffer.from(m.data, "base64");
          const digest = createHash("md5").update(buf).digest("hex");
          const dup = this.byteAttachCache.get(digest);
          if (dup) {
            this.post({ type: "addFiles", files: [{ name: String(m.name || "file"), path: dup }] });
            break;
          }
          const safeName = String(m.name || "file").replace(/[\\/:*?"<>|]/g, "_");
          const tmp = path.join(os.tmpdir(), "pi-attach-" + Date.now() + "-" + safeName);
          try {
            fs.writeFileSync(tmp, buf);
            // 只缓存本面板生命周期内的映射；缓存上限兑底防长会话内存增长
            this.byteAttachCache.set(digest, tmp);
            if (this.byteAttachCache.size > 50) {
              const first = this.byteAttachCache.keys().next().value;
              if (first !== undefined) this.byteAttachCache.delete(first);
            }
            this.post({ type: "addFiles", files: [{ name: safeName, path: tmp }] });
          } catch (err: any) {
            this.post({ type: "notice", text: this.L.attachTempFail + String(err?.message ?? err).slice(0, 120) });
          }
        } else if (typeof m.text === "string" && m.text.length) {
          this.post({ type: "addFiles", files: [{ name: String(m.name || "file"), text: m.text }] });
        }
        break;
      case "attachUri":
        // VS Code 资源管理器拖入：URI 转 fsPath 后走同一条 addFiles 回发
        if (Array.isArray(m.uris) && m.uris.length) {
          const files = await this.ui.resolveUris(m.uris);
          if (files.length) this.post({ type: "addFiles", files });
        }
        break;
      case "pickMode":
        await this.ui.pickMode();
        break;
      case "getSlash":
        await this.sendSlashCommands();
        break;
      case "openSession":
        await this.openSessionFile(m.file);
        break;
      case "revealSessionFile":
        await this.ui.revealSessionFile(m.file);
        break;
      case "openPath":
        await this.ui.openPath(m.path);
        break;
      case "openImage": {
        // 工单31：点击缩略图看原图——md5 去重写临时文件后走 openPath，VS Code 内置图片预览器
        // 打开（自带缩放/原尺寸），不造 lightbox。字节通道同口径：同字节永远同路径（缓存命中
        // 复用，未命中写入即入缓存，FIFO 50 兑底防长会话内存增长）；20MB 上限与字节通道一致
        const buf = Buffer.from(m.data || "", "base64");
        if (!buf.length) {
          this.post({ type: "notice", text: this.L.attachTempFail });
          break;
        }
        if (buf.length > 20 * 1024 * 1024) {
          this.post({ type: "notice", text: this.L.attachTooBig });
          break;
        }
        const digest = createHash("md5").update(buf).digest("hex");
        const dup = this.byteAttachCache.get(digest);
        if (dup) {
          await this.ui.openPath(dup);
          break;
        }
        // mimeType 映射扩展名（VS Code 预览器按扩展名选编辑器，不能省）；未知类型兑 png——
        // 图片入 pi 走的都是这几种，兑底只是为了不裂文件名
        const MIME_EXT: Record<string, string> = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/gif": "gif",
          "image/webp": "webp",
          "image/bmp": "bmp",
        };
        const ext = MIME_EXT[m.mimeType] || "png";
        const tmp = path.join(os.tmpdir(), "pi-img-" + Date.now() + "-" + digest.slice(0, 8) + "." + ext);
        try {
          fs.writeFileSync(tmp, buf);
          this.byteAttachCache.set(digest, tmp);
          if (this.byteAttachCache.size > 50) {
            const first = this.byteAttachCache.keys().next().value;
            if (first !== undefined) this.byteAttachCache.delete(first);
          }
          await this.ui.openPath(tmp);
        } catch (err: any) {
          this.post({ type: "notice", text: this.L.attachTempFail + String(err?.message ?? err).slice(0, 120) });
        }
        break;
      }
      case "getFiles":
        await this.sendWorkspaceFiles();
        break;
      case "more":
        await this.ui.more();
        break;
      case "settings":
        await this.ui.settings();
        break;
      case "pickModel":
        await this.ui.pickModel();
        break;
      case "pickThinking":
        await this.ui.pickThinking();
        break;
      case "pickTheme":
        await this.ui.pickTheme();
        break;
      case "pickLang":
        await this.ui.pickLang();
        break;
      case "bannerClose":
        // 用户手动关横幅：宿主状态机收口，webview 重建后也不会重发
        this.setBanner(null);
        break;
      case "compactSession":
        // 横幅「一键压缩」：直压语义（810f39c 口径）；带指令入口在 ⚡ 菜单，归 adapter
        await this.ui.compactSession();
        break;
      case "showChanges":
        // 工单七：「查看本次改动」→ adapter 的 QuickPick/diff/还原全链路
        await this.ui.showChanges();
        break;
      case "changesDismiss":
        await this.ui.dismissChanges();
        break;
      case "queuedRetrieve":
        // 工单十六：queuebar 条目「取回」→ 文本回编辑框（pi 原生 dequeue 语义的单条版）
        await this.retrieveQueued(m.qid);
        break;
    }
  }

  /** prompt 发送核心（工单十六自 prompt case 抽出，方法体逐字符移植，仅 m.images/m.files 换成参数）：
   *  乐观 busy → 气泡/排队镜像 → 4s pendingPrompt 兜底 → 发送 + steer 自愈 → 自动命名。
   *  取回重排队（retrieveQueued）的 idle 首项复用这里，保证 streamingBehavior/兜底/自愈
   *  语义全插件只有一份。titleText：自动命名用的文本（原 prompt case 的 m.text——
   *  不复用 displayText 是为保留「纯图片/纯代码占位语不参与命名」的原行为） */
  private async sendPromptCore(
    text: string,
    displayText: string,
    titleText: string,
    opts?: { images?: { data: string; mimeType: string }[]; fileCount?: number; codeInfo?: string }
  ): Promise<void> {
    const client = this.ensureClient();
    const images = opts?.images;
    const codeInfo = opts?.codeInfo;
    // 乐观反馈：立刻显示工作状态，不等 agent_start 事件（省掉 1~2s 的无反馈空窗）
    const wasBusy = this.busy;
    // 刀6：乐观置位由下方 pendingPrompt 承担（isStreaming 尚未翻转的空窗），不再写镜像
    // 插话（wasBusy=true）时 run 仍在跑：必须带上真实已过时长，否则 webview 计时起点
    // 被重置——「一排队 Working 就重新计时」的根源；新消息（空闲）不带=从现在起算
    this.post({
      type: "busy",
      value: true,
      ...(wasBusy && this.runStartTs > 0 ? { elapsedMs: Date.now() - this.runStartTs } : {}),
    });
    this.dbg("busy=true (prompt_optimistic, wasBusy=" + wasBusy + ")");
    // 气泡先行：pi 启动/发送可能要几秒，等 await 完才画会让用户以为消息丢了
    let queuedQid: string | null = null;
    if (wasBusy) {
      // 插队消息：只显示「排队中」气泡，等 queue_update 报告被取走后再转正为正式气泡（避免重复）
      const qid = "q" + Date.now();
      queuedQid = qid; // 工单十八补刀：失败回滚要定位本条（乐观入队 pi 侧可能没收到）
      // kind 记账（工单十六）：插件链路插队一律走 streamingBehavior:"steer"（见下方 client.prompt），
      // 归属发送时即知，不靠 queue_update 对账猜
      this.queued.push({ qid, sentText: text, text: displayText, imageCount: images?.length ?? 0, codeInfo, kind: "steer" });
      this.post({ type: "queuedAdd", qid, text: displayText, imageCount: images?.length ?? 0, fileCount: opts?.fileCount ?? 0, codeInfo });
    } else {
      // 工单31：乐观回显透传原图（webview→宿主同回合二次传递，本地 postMessage 非网络通道），
      // 气泡直接画缩略图不再只有数字；agent_settled 后整页 render 重绘覆盖，两路视觉一致
      this.post({ type: "user", text: displayText, imageCount: images?.length ?? 0, fileCount: opts?.fileCount ?? 0, codeInfo, images });
    }
    let steered = false;
    // 4s 兜底必须在 await 之前武装：agent_start 事件可能比 prompt 的 RPC 响应先到
    //（实录 07:30:16.357 事件 vs ~16.358 响应，1ms 反转）。若在响应回来后才置
    // pendingPrompt=true，会把事件刚清掉的标志覆写回 true → 4s 后误清运行中的 busy
    //（「Working 中途消失」的原始触发源）。定时器触发时再查 steered：被拒收转 steer
    // 的 prompt 不会有 agent_start，busy 已在 catch 里纠回 true，不能被兜底清掉
    // 工单五-2 重审结论（直连）：兜底保留。正常 prompt 的 agent_start 毫秒级到达，
    // 兜底唯一日常触发场景是「不产生 agent 运行的命令式 prompt」（扩展 registerCommand
    // 集合开放无法枚举拦截，b040fb2 只拦了 /mode）——撤掉兜底这类 prompt 的 busy
    // 将永久卡死。事件管线整体停摆 >4s 也会触发，那本身就是必须暴露的故障
    if (!wasBusy) {
      this.pendingPrompt = true;
      setTimeout(() => {
        // 刀6：agent_start 已清 pendingPrompt 的话本条件不成立；isStreaming 真跑起来时
        // busy 恒真——4s 兜底只清乐观窗口，不再有镜像可清
        if (!steered && this.pendingPrompt) {
          this.pendingPrompt = false;
          this.dbg("busy=false (4s_pendingPrompt_fallback: no agent_start within 4s)");
          this.post({ type: "busy", value: false });
        }
      }, 4000);
    }
    try {
      try {
        await client.prompt(text, wasBusy, images);
      } catch (e: any) {
        // busy 标志与 pi 真实状态错位时（如 agent_start 晚于 4s 兜底，busy 已被清），
        // pi 会拒收不带 streamingBehavior 的 prompt → 自动转 steer 重发，消息照常排队
        // 工单五-3 可达性结论（直连）：自愈保留。刀6 后镜像已死（busy=isStreaming 派生），
        // 「镜像漂移撞运行中 session.prompt」的场景在架构上不存在，自愈纯兜底
        const msg = String(e?.message ?? e);
        if (!/already processing|streamingBehavior/i.test(msg)) throw e;
        this.post({ type: "notice", text: this.L.autoQueued });
        steered = true;
        // pi 拒收 = 它一定正在跑上一个 run：isStreaming 必为 true，busy（派生，刀6）恒真，
        // 无镜像可纠；busy:true 事件重发是给 webview 的——4s 兜底可能刚发过 busy:false，
        // 若不重发：steer 不触发 agent_start，webview 的 Working 会消失（排队气泡丢失的根源）
        this.post({ type: "busy", value: true, elapsedMs: this.runStartTs > 0 ? Date.now() - this.runStartTs : 0 });
        this.dbg("busy event (steer_resend: pi rejected prompt as already processing)");
        // 工单十八补刀2（用户实测：每条插队切页签后变两条，用户气泡也成对）：
        // 拒收 ≠ 未入队——被拒的 prompt 可能已以某种方式入队，盲目重发 = 双入队。
        // 重发前先对账 pi 队列现状：同文本已在队列则跳过重发（镜像/queuebar 本就乐观画了一条，正好对应）
        try {
          const q = await client.getQueuedMessages();
          const dup = [...(q?.steering ?? []), ...(q?.followUp ?? [])].some((t: unknown) => t === text);
          if (dup) {
            this.dbg("steer_resend_skipped (already queued: pi has same text)");
            return;
          }
        } catch { /* 对账失败按原路径重发（宁可信没入，双条总比丟条好——丢条消息真没了） */ }
        await client.prompt(text, true, images);
      }
      // 新会话首条真实文字消息 → 自动命名会话（CC 风格，历史列表/头部都能显示标题）
      if (!wasBusy && titleText) void this.autoTitleSession(titleText);
    } catch (err: any) {
      // 刀6：清乐观窗口（isStreaming 本就 false——发送失败不会有 run 在跑）
      this.pendingPrompt = false;
      this.post({ type: "busy", value: false });
      this.dbg("busy=false (prompt_send_fail: " + String(err?.message ?? err).slice(0, 120) + ")");
      // 真错误透传（piClient 不再吞成通用文案）后的友好映射：压缩中拒收是日常操作，
      // pi 原文是英文长句，直接给结论
      const raw = String(err?.message ?? err);
      const failMsg = /compaction is in progress/i.test(raw) ? this.L.rejectedCompacting : raw;
      this.post({ type: "notice", text: this.L.sendFail + failMsg });
      // 工单十八补刀（用户实测「queuebar 2 条 vs 排队 1 条」）：乐观入队失败必须回滚——
      // 镜像/queuebar 是先画的（气泡先行），prompt/steer 失败时 pi 队列里根本没有这条，
      // 不回滚就是幽灵项：计数与 queuebar 永久分叉（镜像只增不减病灶的最后一处）
      if (queuedQid) {
        const existed = this.queued.some((q) => q.qid === queuedQid);
        this.queued = this.queued.filter((q) => q.qid !== queuedQid);
        if (existed) {
          this.post({ type: "queuedRemove", qid: queuedQid });
          this.dbg("queued_rollback (send_fail: qid=" + queuedQid + ")");
        }
      }
    }
  }

  /** 工单十六：排队消息「取回到编辑框」——pi 原生语义的单条版（TUI alt+up dequeue：
   *  clearQueue 全部取回编辑器，删改发生在编辑器里；pi 无单条删除 API，签单三处查
   *  留证见 DIRECTOR.md）。对齐范式不造第二种：clearQueue 全清 → 被取回项文本合入
   *  编辑框 → 保留集按原类型重排队。
   *  图片项已知局限：queued 只存 imageCount 不存原图，取回仅还原文本（sentText，含
   *  附件胶囊块——文件附件本就拼在文本里所以不丢），图片丢失；本工单不做附件数据回传 */
  private async retrieveQueued(qid: string): Promise<void> {
    const client = this.ensureClient();
    const q = this.queued.find((x) => x.qid === qid);
    if (!q) return;
    this.retrieving = true;
    try {
      // pi 真相快照：clearQueue 返回清空前的全部队列内容。保留集以它为准——镜像可能滞后
      //（agent 刚取走的项还在镜像里，但已不在 pi 队列）
      const r = await client.clearQueue();
      const snap: { text: string; kind: "steer" | "followUp" }[] = [
        ...(Array.isArray(r?.steering) ? r.steering : []).map((t: unknown) => ({ text: String(t), kind: "steer" as const })),
        ...(Array.isArray(r?.followUp) ? r.followUp : []).map((t: unknown) => ({ text: String(t), kind: "followUp" as const })),
      ];
      this.lastQueueTotal = 0; // pi 真相：队列已清空（抑制期事件只记账，这里直接落真相）
      if (!snap.some((x) => x.text === q.sentText)) {
        // 竞态：取回前 agent 刚把这条取走 → 回填编辑框必造成重复发送；队列条交还既有转正
        // 链路（agent_start 的 deliverQueuedInHistory / queue_update 变短）收口
        this.post({ type: "notice", text: this.L.retrieveTaken });
        return;
      }
      // 被 agent 取走的（镜像有、pi 快照没有）：保留在镜像与队列条，等既有转正链路收口
      const taken = this.queued.filter((y) => y.qid !== q.qid && !snap.some((x) => x.text === y.sentText));
      // 保留集 = pi 快照 − 被取回项；qid/气泡文案从镜像找回，镜像没有的项（扩展直入 pi
      // 队列等）用原文兑底自建镜像
      const kept = snap
        .filter((x) => x.text !== q.sentText)
        .map((x) => {
          const mirror = this.queued.find((y) => y.qid !== q.qid && y.sentText === x.text);
          return mirror
            ? { ...mirror, kind: x.kind }
            : { qid: "q" + Date.now() + "-" + Math.floor(Math.random() * 10000), sentText: x.text, text: x.text, imageCount: 0, kind: x.kind };
        });
      this.queued = [...taken, ...kept];
      // 被取回项文本回填编辑框（webview 合入：编辑框非空时换行追加，不覆盖正在输入的内容）
      this.post({ type: "queuedRetrieved", qid: q.qid, text: q.sentText });
      // 重排队：busy → 按原类型直入 pi 队列（steering 先于 followUp 送达的语义由 pi 队列
      // 结构保证，各队列内部保序）；idle → 第一项走 prompt 链路（乐观 busy/4s 兜底/steer
      // 自愈全套语义），其余照常排队——session.steer/followUp 对 idle 只入队不下跑
      //（agent.steer = steeringQueue.enqueue，下一轮 run 消费），不会开出第二个 run
      if (kept.length) {
        const requeue = async (items: typeof kept) => {
          for (const k of items) {
            try {
              if (k.kind === "followUp") await client.followUp(k.sentText);
              else await client.steer(k.sentText);
            } catch (err: any) {
              // 单条重排队失败不中断其余项：该项留在镜像/队列条，pi 侧缺位由 dbg 留痕
              this.dbg("retrieve_requeue_fail: " + String(err?.message ?? err).slice(0, 120));
            }
          }
        };
        if (this.busy) {
          await requeue(kept);
        } else {
          const first = kept[0];
          // 先把首项从镜像摘掉再发：它走正式 prompt 链路（乐观 user 气泡已发），留在镜像里
          // 会被 agent_start 的 deliverQueuedInHistory 再转正一次（重复气泡）
          this.queued = this.queued.filter((y) => y.qid !== first.qid);
          await this.sendPromptCore(first.sentText, first.text, first.text, { codeInfo: first.codeInfo });
          await requeue(kept.slice(1));
        }
      }
      // 收口对账（工单十六·竞态验收条）：重排队与 queuebar 重建之间 agent 可能已把 steer
      // 取走——steer 送达不触发 agent_start，错过 queue_update 就没有下一个事件可依赖，
      // 队列条会永久残留。以 pi 队列现状为准逐条核对：已不在队列的项，进历史才转正
      //（与既有 queue_update/deliverQueuedInHistory 口径一致，防误报），否则留在队列条
      try {
        const now = await client.getQueuedMessages();
        const stillQueued = [...(now?.steering ?? []), ...(now?.followUp ?? [])];
        this.lastQueueTotal = stillQueued.length;
        if (this.queued.some((y) => !stillQueued.includes(y.sentText))) {
          const d = await client.getMessages();
          const histTexts = (d?.messages ?? []).filter((mm: any) => mm.role === "user").map((mm: any) => extractText(mm.content));
          const waiting: typeof this.queued = [];
          for (const item of this.queued) {
            if (stillQueued.includes(item.sentText) || !histTexts.some((t: string) => t.includes(item.sentText))) {
              waiting.push(item);
            } else {
              this.post({ type: "queuedDelivered", qid: item.qid, show: true, text: item.text, imageCount: item.imageCount, codeInfo: item.codeInfo });
            }
          }
          this.queued = waiting;
        }
      } catch {
        // 对账失败不影响主流程（既有事件链路仍会兜底）
      }
      // 重建 queuebar（先清后发，同 postUiState 款；不做整页重绘——busy 红线）
      this.post({ type: "queuedClear" });
      for (const item of this.queued) {
        this.post({ type: "queuedAdd", qid: item.qid, text: item.text, imageCount: item.imageCount, codeInfo: item.codeInfo });
      }
    } finally {
      this.retrieving = false;
    }
  }

  /** 面板原生斜杠命令表：输入框拦截、/ 补全两处共用一份（ce8521b，自 panel.ts 对账移植）。
   *  这些命令绝不能走 client.prompt——pi SDK 对未注册的 /xxx 会把字面文本发给模型
   *  （用户消息变成 "/compact"），对已注册扩展命令则立即返回且零 agent 事件
   *  （面板乐观 busy → 假忙 4s），两条路都不对。
   *  run 目标：纯 UI 流程经 UiActions 住 adapter，会话编排（newSession）留在本类 */
  private nativeSlashCommands(): { name: string; desc: string; run: () => Promise<void> }[] {
    return [
      { name: "model", desc: this.L.natModel, run: () => this.ui.pickModel() },
      { name: "thinking", desc: this.L.natThinking, run: () => this.ui.pickThinking() },
      { name: "theme", desc: this.L.natTheme, run: () => this.ui.pickTheme() },
      { name: "mode", desc: this.L.natMode, run: () => this.ui.pickMode() },
      { name: "new", desc: this.L.natNew, run: () => this.newSession() },
      { name: "resume", desc: this.L.natResume, run: () => this.ui.pickSession("project") },
      { name: "fork", desc: this.L.natFork, run: () => this.ui.treeFork() },
      { name: "tree", desc: this.L.natFork, run: () => this.ui.treeFork() },
      { name: "import", desc: this.L.natImport, run: () => this.ui.importSession() },
      { name: "share", desc: this.L.natShare, run: () => this.ui.shareSession() },
      { name: "export", desc: this.L.natExport, run: () => this.ui.exportSession() },
      { name: "compact", desc: this.L.natCompact, run: () => this.ui.compactSession() },
      { name: "clone", desc: this.L.natClone, run: () => this.ui.cloneSession() },
      { name: "login", desc: this.L.natLogin, run: async () => this.ui.openTerminalLogin() },
      { name: "settings", desc: this.L.natSettings, run: () => this.ui.settings() },
      { name: "reload", desc: this.L.natReload, run: () => this.reloadBackend() },
    ];
  }

  /** 每标签记忆的模型/思考等级补回（工单十五刀3 语义补全，2026-09-18）：pi 的 switchSession
   *  会把模型重置为会话文件里存的值（用户实测：切老会话后页脚显示该会话的 Free Models
   *  Router，页签上自选的模型被顶掉）。补回必须在**每次 switchSession 之后**——启动恢复/
   *  切历史/新建/重载四条链路统一走这里；原先与 switchSession 并行的补回是竞态（谁后到谁赢）。
   *  panel 切历史链路用 reapplyModelMemory */
  private async applyModelMemory(): Promise<void> {
    const lastModel = this.lastModelFor();
    const lastThinking = this.lastThinkingFor();
    if (!lastModel && !lastThinking) return;
    try {
      if (lastModel) await this.client?.setModel(lastModel.provider, lastModel.id);
      if (lastThinking) await this.client?.setThinkingLevel(lastThinking);
    } catch {
      // 补回失败不影响使用
    }
  }
  /** 记忆键的工作区维度（与 getSessionForWs 同口径：去尾反斜杠 + 小写）。事故教训（2026-09-22
   *  用户实测）：旧键 piChat.lastModel.<tabKey> 只按页签维度存，而 globalState 机器级共享、
   *  tabId 每个窗口都从 t1 起算——A 窗口切的模型成了 B 窗口的「记忆」，跨窗口/跨项目必串；
   *  全局兑底键 piChat.lastModel 同病。改二维键 {工作区: {tabKey: 值}}（与 lastSessionByWs2
   *  同构）；同工作区影子兑底用 "_"（页签 id 只会是 t1/t2…，永不撞）。旧扁平键**不读**——
   *  读一次就把泄漏搬运进新键，等于没修；存量记忆作废一次可接受 */
  private wsKey(): string {
    return this.caps.getCwd().replace(/\\+$/, "").toLowerCase();
  }
  /** 写入本页签的模型记忆（panel pickModel 调用）：tabKey + 同工作区影子 "_" 一起写 */
  rememberModel(m: { provider: string; id: string }): void {
    const ws = this.wsKey();
    const tabMap = this.caps.getPersist<Record<string, Record<string, { provider: string; id: string } | undefined>>>("piChat.lastModelByWs2", {});
    (tabMap[ws] ??= {})[this.tabKey] = m;
    (tabMap[ws] ??= {})["_"] = m;
    this.caps.setPersist("piChat.lastModelByWs2", tabMap);
  }
  /** 写入本页签的思考等级记忆（panel pickThinking 调用，同上口径） */
  rememberThinking(level: string): void {
    const ws = this.wsKey();
    const tabMap = this.caps.getPersist<Record<string, Record<string, string | undefined>>>("piChat.lastThinkingByWs2", {});
    (tabMap[ws] ??= {})[this.tabKey] = level;
    (tabMap[ws] ??= {})["_"] = level;
    this.caps.setPersist("piChat.lastThinkingByWs2", tabMap);
  }
  private lastModelFor(): { provider: string; id: string } | undefined {
    const tabMap = this.caps.getPersist<Record<string, Record<string, { provider: string; id: string } | undefined>>>("piChat.lastModelByWs2", {});
    const ws = tabMap[this.wsKey()];
    return ws?.[this.tabKey] ?? ws?.["_"];
  }
  /** 每标签的思考等级记忆（同上口径，同工作区影子 "_" 兑底） */
  private lastThinkingFor(): string | undefined {
    const tabMap = this.caps.getPersist<Record<string, Record<string, string | undefined>>>("piChat.lastThinkingByWs2", {});
    const ws = tabMap[this.wsKey()];
    return ws?.[this.tabKey] ?? ws?.["_"];
  }
  /** panel 切历史会话后的补回入口（含页脚同步） */
  async reapplyModelMemory(): Promise<void> {
    await this.applyModelMemory();
    await this.refreshState();
  }

  /** 面板版 /reload：重建 pi 运行时，让新装的包/技能/扩展立即生效（pi 原生 /reload 的
   *  等价物）。此前被误归 tuiOnly 挡掉——装个技能就得重启插件，不合理（2026-09-18
   *  用户指出）。持久会话从文件恢复、聊天不丢（会话文件就是真相）；ephemeral
   *  （--no-session）无落盘真相可恢复，拒绝执行防聊天蒸发；busy 时拒绝（重建运行时
   *  会把在途流拦腰截断）。-c 兑底：文件失效则停在 -c 恢复的最近会话 */
  private async reloadBackend(): Promise<void> {
    if (this.busy) {
      this.post({ type: "notice", text: this.L.reloadBusy });
      return;
    }
    if (this.clientNoSession) {
      this.post({ type: "notice", text: this.L.reloadEphemeral });
      return;
    }
    const st = await this.client?.getState().catch(() => null);
    const file = st?.sessionFile ?? null;
    this.dbg("reload: begin file=" + (file ?? "(none)"));
    this.disposeClient();
    const client = this.ensureClient(false);
    if (file) {
      try {
        await client.switchSession(file);
      } catch {
        // 会话文件失效则停在 -c 恢复的最近会话，不阻断重载
      }
    }
    // switchSession 会把模型重置为会话文件里存的值——记忆补回（每标签，刀3）
    await this.applyModelMemory();
    this.dbg("reload: runtime rebuilt, refetching commands");
    await this.refreshState();
    this.syncRenderKeepQueued();
    // 重载后重发命令列表：webview 里的 slashCmds 是一次性懒加载缓存，不重发则
    // 菜单里看不到新装的技能/命令（2026-09-18 实测尾巴）
    await this.sendSlashCommands();
    this.post({ type: "notice", text: this.L.reloadDone });
  }

  /** ⚙ 新建会话（⚡ /commands 与 webview 皆可触发）：会话恢复编排的一部分 */
  private async newSession(): Promise<void> {
    const client = this.ensureClient();
    // 防误触：agent 正在干活时，新会话会终止当前任务，先确认
    if (this.busy) {
      const ok = await this.caps.showConfirm(this.L.nsConfirm, {
        confirmText: this.L.nsAbortAndNew,
        cancelText: this.L.cancel,
      });
      if (!ok) return;
      try {
        await client.abort();
      } catch {
        // ignore
      }
    }
    try {
      const result = await client.newSession();
      if (result?.cancelled) {
        this.post({ type: "notice", text: this.L.nsCancelled });
        return;
      }
      this.post({ type: "render", messages: [] });
      this.queued = [];
      this.post({ type: "queuedClear" });
      // 不再发「已开始新会话」通知：欢迎页本身就是反馈，多余通知会挂在欢迎页下面
      // pi 的 new_session 会把模型重置为默认值 → 把记住的模型/思考等级补回去（每标签，刀3，
      // 统一走 applyModelMemory——switchSession/newSession/reset 同口径）
      await this.applyModelMemory();
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.nsFail + (err?.message ?? err) });
    }
  }

  /** 给 webview 提供 /命令列表（懒加载一次） */
  private async sendSlashCommands(): Promise<void> {
    // 打开菜单时对比包签名：settings.json 的 packages 变了=有新装/卸载的包，自动重建
    // 运行时让技能/扩展即时生效（2026-09-18 用户诉求「打开界面新装的技能就在里面」）。
    // busy/ephemeral 时不自动重建（busy 截断在途流 / ephemeral 无落盘真相），列表照发
    // 并提示用 /reload；reloadBackend 内部 ensureClient 会刷新签名，此处不会死循环
    const sig = this.readPkgsSig();
    this.dbg("slash: getSlash sig=" + sig + " cached=" + this.pkgsSig);
    if (sig !== null && this.pkgsSig !== null && sig !== this.pkgsSig) {
      if (!this.busy && !this.clientNoSession) {
        this.post({ type: "notice", text: this.L.reloadAuto });
        await this.reloadBackend();
        return; // reloadBackend 内部已重发 slashList
      }
      this.post({ type: "notice", text: this.L.reloadHint });
    }
    let cmds: any[] = [];
    try {
      const client = this.ensureClient();
      const d = await client.getCommands();
      cmds = d?.commands ?? [];
      this.dbg("slash: commands=" + cmds.length + " probe=" + cmds.some((c: { name?: string }) => c.name === "skill:probe-skill"));
    } catch {
      // pi 未就绪时给空列表
    }
    const builtin: any[] = [
      // 上下文
      { group: this.L.grpContext, label: this.L.slashUpload, description: this.L.slashUploadDesc, builtin: "uploadImage" },
      { group: this.L.grpContext, label: this.L.slashMention, description: this.L.slashMentionDesc, builtin: "mentionFile" },
      // 会话
      { group: this.L.grpSession, label: this.L.slashNew, description: this.L.slashNewDesc, builtin: "newSession" },
      { group: this.L.grpSession, label: this.L.slashResume, description: this.L.slashResumeDesc, builtin: "pickSession" },
      { group: this.L.grpSession, label: this.L.slashTree, description: this.L.slashTreeDesc, builtin: "treeFork" },
      { group: this.L.grpSession, label: this.L.slashImport, description: this.L.slashImportDesc, builtin: "importSession" },
      { group: this.L.grpSession, label: this.L.slashShare, description: this.L.slashShareDesc, builtin: "shareSession" },
      { group: this.L.grpSession, label: this.L.slashMore, description: this.L.slashMoreDesc, builtin: "more" },
      // 模型
      { group: this.L.grpModel, label: this.L.slashModel, description: this.L.slashModelDesc, builtin: "pickModel" },
      { group: this.L.grpModel, label: this.L.slashThinking, description: this.L.slashThinkingDesc, builtin: "pickThinking" },
      { group: this.L.grpModel, label: this.L.slashMode, description: this.L.slashModeDesc, builtin: "pickMode" },
      // 配置（已合并进操作命令菜单，条目在菜单里分组展示）
      { group: this.L.grpConfig, label: this.L.slashSettings, description: this.L.slashSettingsDesc, builtin: "settings" },
    ];
    // 面板原生命令与 pi 扩展命令并列展示；同名（如 /mode 两边都有）以原生为准去重，
    // 否则补全面板出现两条 /mode，一条走本地一条走扩展
    const nat = this.nativeSlashCommands();
    const nativeNames = new Set(nat.map((c) => c.name));
    const native = nat.map((c) => ({
      group: this.L.grpCmds,
      label: "/" + c.name,
      description: c.desc,
      name: c.name,
    }));
    // 技能的内部名是 "skill:xxx"（pi 展开用），列表标签剥前缀只显示技能短名——
    // 长名被右侧长描述挤成 "/skill..." 啥也看不见（2026-09-18 用户实测）；
    // item.name 保持原样，applySuggest 照旧填入完整 /skill:xxx，pi 识别不受影响
    const ext = cmds
      .filter((c: any) => !nativeNames.has(String(c.name)))
      .map((c: any) => ({
        group: this.L.grpCmds,
        label: "/" + String(c.name).replace(/^skill:/, ""),
        description: c.description || c.source || "",
        name: c.name,
      }));
    this.post({ type: "slashList", commands: [...builtin, ...native, ...ext] });
  }

  /** settings.json 的 packages 签名：打开菜单时对比，变了=有新装/卸载的包。
   *  读不到（文件缺失/解析失败）返回 null，调用方视为「无签名」跳过对比 */
  private readPkgsSig(): string | null {
    try {
      const raw = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8");
      return JSON.stringify(JSON.parse(raw).packages ?? []);
    } catch {
      return null;
    }
  }

  /** 包签名缓存：运行时创建时定格，菜单打开时对比 detect 新装/卸载 */
  private pkgsSig: string | null = null;

  /** 给 webview 提供工作区文件列表（相对路径 + 所在目录），供 @ 补全 */
  private async sendWorkspaceFiles(): Promise<void> {
    const root = this.caps.getCwd();
    const files: { rel: string; dir: string }[] = [];
    if (root) {
      const walk = (dir: string, depth: number) => {
        if (depth > 6 || files.length > 2000) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "out") continue;
          const full = path.join(dir, ent.name);
          const rel = path.relative(root, full).replace(/\\/g, "/");
          if (ent.isDirectory()) {
            files.push({ rel: rel + "/", dir: "" });
            walk(full, depth + 1);
          } else {
            files.push({ rel, dir: path.dirname(rel) });
          }
        }
      };
      walk(root, 0);
    }
    this.post({ type: "fileList", files });
  }

  /** 从历史面板点击某条会话 → 切换过去 */
  private async openSessionFile(file: string): Promise<void> {
    if (this.client?.running && this.clientNoSession) {
      this.disposeClient();
    }
    try {
      const client = this.ensureClient(true);
      const r = await client.switchSession(file);
      if (r?.cancelled) return;
      const d = await client.getMessages();
      this.post({ type: "render", messages: d?.messages ?? [] });
      this.replaySubagentRuns(d?.messages ?? []);
      this.post({ type: "notice", text: this.L.sessionRestored });
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.sessionOpFail + (err?.message ?? err) });
    }
  }

  /** 扩展的 UI 请求 → 宿主原生对话框（能力经 HostCapabilities 注入，本文件不碰 vscode）；
   *  public：adapter 的 caps.uiRequest 也委托到这里 */
  async handleUiRequest(req: any): Promise<void> {
    const client = this.client;
    if (!client) return;
    const respond = (resp: Record<string, unknown>) =>
      client.respondUi({ type: "extension_ui_response", id: req.id, ...resp });
    try {
      switch (req.method) {
        case "select": {
          // pi 推来的是字符串选项，包一层 label 以适配通用 QuickPick 形状
          const options = ((req.options ?? []) as string[]).map((o) => ({ label: String(o) }));
          const pick = await this.caps.showQuickPick(options, req.title ?? this.L.pleaseSelect);
          if (pick === undefined) respond({ cancelled: true });
          else respond({ value: pick.label });
          break;
        }
        case "confirm": {
          const confirmed = await this.caps.showConfirm(req.title ?? this.L.confirm, {
            detail: req.message ?? "",
            confirmText: this.L.confirm,
            cancelText: this.L.cancel,
          });
          if (!confirmed) respond({ cancelled: true });
          else respond({ confirmed: true });
          break;
        }
        case "input":
        case "editor": {
          // editor（多行编辑）降级为单行输入框
          const val = await this.caps.showInputBox({
            prompt: req.title ?? this.L.pleaseInput,
            placeHolder: req.placeholder,
            value: req.prefill,
          });
          if (val === undefined) respond({ cancelled: true });
          else respond({ value: val });
          break;
        }
        case "notify": {
          // fire-and-forget，无需应答
          this.post({
            type: "notice",
            text: (req.title ? req.title + ": " : "") + (req.message ?? ""),
          });
          break;
        }
        case "setStatus": {
          // 模式扩展用 statusKey="mode" 推送当前权限模式，显示在底部状态栏
          if (req.statusKey === "mode") {
            this.lastModeText = req.statusText ?? "";
            this.post({ type: "mode", text: this.lastModeText });
          }
          break;
        }
        default:
          // setStatus/setWidget/setTitle 等忽略
          break;
      }
    } catch {
      respond({ cancelled: true });
    }
  }

  /** CC 风格自动命名：未命名会话收到首条真实用户消息后，用消息前 40 字做会话标题 */
  private async autoTitleSession(text: string): Promise<void> {
    try {
      const client = this.client;
      if (!client?.running) return;
      if (this.lastSessionName) return; // 已有名字，不覆盖
      const st = await client.getState().catch(() => null);
      if (!st?.sessionFile || st.sessionName) return;
      if (this.autoTitledFor === st.sessionFile) return;
      const title = text.replace(/\s+/g, " ").trim().slice(0, 40);
      if (!title) return;
      await client.setSessionName(title);
      this.autoTitledFor = st.sessionFile;
      this.lastSessionName = title;
      void this.refreshState(); // 头部「会话: …」立即更新
    } catch {
      // ignore
    }
  }

  /** 拉取当前模型/思考等级/token 用量并更新头部状态栏；
   *  public：adapter 的 webview 重建恢复路径（resolveWebviewView）也调用 */
  async refreshState(): Promise<void> {
    const foot = await this.collectState();
    if (!foot) return;
    this.post({
      type: "state",
      ver: foot.ver,
      model: foot.model,
      thinkingLevel: foot.thinkingLevel,
      sessionName: foot.sessionName,
      sessionFile: foot.sessionFile,
      stats: foot.stats,
    });
  }

  /** 工单十八：拉取页脚数据 + 既有副作用（会话记账/横幅 re-arm）。从 refreshState 抽出——
   *  postUiState 原子化后 uiState 需同源页脚数据，不再靠单独 state 消息拼 */
  private async collectState(): Promise<{
    ver: string;
    model: { name?: string; provider?: string; id: string } | null;
    thinkingLevel: number | null;
    sessionName: string | null;
    sessionFile: string | null;
    stats: { contextPercent: number | null; cost: number } | null;
  } | null> {
    const client = this.client;
    if (!client?.running) return null;
    try {
      const st = await client.getState();
      let stats: GetSessionStatsResult | null = null;
      try {
        stats = await client.getSessionStats();
      } catch {
        // ignore
      }
      // 刀6：原「get_state 真相对账 + 工单五-1 观察断言」整块删除——busy=isStreaming 派生后
      // 镜像不存在，对账无从谈起（工单五-1 的观察期到此期满结案）
      // 按项目记住当前会话文件，下次启动自动恢复（切走/重启不用重选会话）
      if (st?.sessionFile) this.setSessionForWs(st.sessionFile);
      // 换会话（切换/新会话/分叉都会换 sessionFile）：阈值预警 re-arm + 清会话域横幅（工单六）
      if ((st?.sessionFile ?? null) !== this.lastSessionFile) {
        this.contextWarnArmed = true;
        if (this.banner) this.setBanner(null);
        // 工单七：变更清单同样是会话域信息，不残留到别的会话
        this.runChangedFiles.clear();
        this.toolCallPaths.clear();
        this.toolCallDetails.clear();
      }
      this.lastSessionName = st?.sessionName ?? null;
      this.lastSessionFile = st?.sessionFile ?? null;
      // 上下文阈值预警（工单六）：涨破阈值提醒一次，占比回落（压缩后）re-arm 并收预警横幅。
      // 阈值走 VS Code 设置 piChat.contextWarnPercent（默认 70），经 caps 读取不碰 vscode
      const pct = stats?.contextUsage?.percent ?? null;
      if (typeof pct === "number") {
        const warnAt = this.caps.getConfig("piChat", "contextWarnPercent", 70);
        if (pct >= warnAt) {
          if (this.contextWarnArmed) {
            this.contextWarnArmed = false;
            this.setBanner({
              kind: "contextWarning",
              text: fmt(this.L.bannerContextWarn, Math.round(pct)),
              actionLabel: this.L.bannerCompactBtn,
            });
            this.dbg("banner: contextWarning (pct=" + Math.round(pct) + ")");
          }
        } else {
          this.contextWarnArmed = true;
          if (this.banner?.kind === "contextWarning") this.setBanner(null);
        }
      }
      return {
        ver: this.version,
        model: st?.model
          ? { name: st.model.name, provider: st.model.provider, id: st.model.id }
          : null,
        thinkingLevel: st?.thinkingLevel ?? null,
        sessionName: st?.sessionName ?? null,
        sessionFile: st?.sessionFile ?? null,
        stats: stats
          ? {
              contextPercent: stats?.contextUsage?.percent ?? null,
              cost: stats?.cost ?? 0,
            }
          : null,
      };
    } catch {
      // ignore
      return null;
    }
  }

  /** agent_start 时把已被 pi 取走的排队气泡原地转正为普通气泡（不做整页重绘，避免打断流式渲染顺序） */
  private async deliverQueuedInHistory(): Promise<void> {
    try {
      const d = await this.client?.getMessages();
      const histTexts = (d?.messages ?? [])
        .filter((m) => m.role === "user")
        .map((m) => extractText(m.content));
      const remaining: typeof this.queued = [];
      for (const q of this.queued) {
        if (histTexts.some((t: string) => t.includes(q.sentText))) {
          // 已进历史 → 转正（webview 移除 ⏳ 行并追加普通用户气泡）
          this.post({
            type: "queuedDelivered",
            qid: q.qid,
            show: true,
            text: q.text,
            imageCount: q.imageCount,
            codeInfo: q.codeInfo,
          });
        } else {
          remaining.push(q);
        }
      }
      this.queued = remaining;
    } catch {
      // ignore
    }
  }

  /** 拉取会话历史重绘；逐条送达模式下排队会分多次取走，尚未进历史的排队项保留在 queuebar */
  syncRenderKeepQueued(): void {
    void (async () => {
      try {
        const d = await this.client?.getMessages();
        const msgs = d?.messages ?? [];
        const histTexts = msgs
          .filter((m) => m.role === "user")
          .map((m) => extractText(m.content));
        this.queued = this.queued.filter(
          (q) => !histTexts.some((t: string) => t.includes(q.sentText))
        );
        // 先清后发原子重建（同 retrieveQueued「重建 queuebar」款）：queuedClear 连 webview 的
        // 账本（queuedItems）一起清空，不回灌就是「镜像留着、界面蒸发」——点暂停清掉排队消息
        // 的事故根源（实测日志 2026-09-22 10:39:05：中断的 settle 走到这里，刚经输入框发进去的
        // 排队内容整条消失；pi 侧队列其实没清，下次发送还会幽灵投递）。方法名/上注释的
        // 「尚未进历史的排队项保留在 queuebar」由下面的回灌兑现
        this.post({ type: "queuedClear" });
        for (const item of this.queued) {
          this.post({
            type: "queuedAdd",
            qid: item.qid,
            text: item.text,
            imageCount: item.imageCount,
            codeInfo: item.codeInfo,
          });
        }
        this.post({ type: "render", messages: msgs });
        this.replaySubagentRuns(msgs);
      } catch {
        // ignore
      }
    })();
  }

  private async onPiEvent(e: PiEvent): Promise<void> {
    // 刀6：原「事件流对账纠偏」块整块删除——busy=isStreaming 派生后漂移在架构上不可能，
    // 「镜像空闲却收到运行中事件」不存在（isStreaming 为真则 busy 恒真）
    switch (e.type) {
      case "agent_start":
        // 刀6：busy=isStreaming 派生，无需置位；pendingPrompt 清掉（乐观窗口结束）
        this.pendingPrompt = false;
        this.liveMessage = null; // 刀5b：新 run 无在途消息，防陈旧 liveSync
        this.liveStreaming = false; // 工单24：新 run 无在途
        this.runStartTs = Date.now();
        // 工单七：新 run 开始——上一轮清单作废，通知 adapter 做 git 快照（baseline 用）
        this.runChangedFiles.clear();
        this.toolCallPaths.clear();
        this.toolCallDetails.clear();
        try { this.onRunStart?.(); } catch { /* 快照失败不阻断 agent 运行 */ }
        // 空闲时的 abort 会遗留 skipRender 标记，新运行开始时清掉，避免吞掉下次 settled 重绘
        this.abortSkipRender = false;
        this.post({ type: "busy", value: true, elapsedMs: 0 });
        this.dbg("busy=true (agent_start)");
        if (this.queued.length) void this.deliverQueuedInHistory();
        break;

      case "message_start": {
        // 每条新的助手消息（含插话后继续生成的下一条）都开新气泡，避免增量拼进上一条导致错位
        if ((e.message?.role ?? "assistant") === "assistant") {
          this.liveMessage = e.message; // 刀5b：新在途消息开始
          this.liveStreaming = true; // 工单24：真在途标记（stale liveMessage 不是凭证）
          this.post({ type: "newLive" });
        } else if (e.message?.role === "user") {
          // 子 agent 回报实时上屏（2026-09-18 用户实测「先思考后卡片」倒序）：回报消息的
          // message_start 此前被无视，卡片要等 settled 重绘才补，而思考是实时流——观感顺序
          // 反了。只认回报前缀：面板自己发的消息在 sendPromptCore 已乐观上屏（displayText
          // 与会话原文不含代码上下文块而不等），不能在这里重复渲染
          const text = extractText((e.message as Record<string, unknown>).content);
          if (/^\[子 agent \S+ (完成|失败)\]/.test(text)) this.post({ type: "user", text });
        }
        break;
      }

      case "message_end": {
        // 工单24：pi 在 finalized 消息入 state 之后才发（agent-session.js:454）——此刻消息
        // 完整且不再变，在途标记清除。基线冻结/回放机制靠它区分「真在途」与「stale 引用」
        if ((e.message?.role ?? "assistant") === "assistant") this.liveStreaming = false;
        break;
      }

      case "message_update": {
        if (e.message) this.liveMessage = e.message; // 刀5b：全量在途消息（同一对象 in-place 更新）
        const d = e.assistantMessageEvent;
        if (d?.type === "text_delta" && d.delta) {
          this.post({ type: "delta", text: d.delta, ci: d.contentIndex ?? 0 });
        } else if (d?.type === "thinking_delta" && d.delta) {
          this.post({ type: "thinking", text: d.delta, ci: d.contentIndex ?? 0 });
        } else if (d?.type === "toolcall_start") {
          // 大参数工具（如 write 整个文件）光生成参数就要几十秒：转发开始事件，面板显示呼吸工具行
          this.post({ type: "toolCallStart", ci: d.contentIndex ?? 0, id: d.id, name: d.toolName });
        } else if (d?.type === "toolcall_delta") {
          this.post({ type: "toolCallDelta", ci: d.contentIndex ?? 0, chunk: d.delta ?? "" });
        }
        break;
      }

      case "tool_execution_start":
        // 工单七：edit/write 自带 args.path（schema 强制 string），流式期间即可归因。
        // 裁决 4：pi 未保证非空，一律保守检查；工具名以 pi 工具定义实查为准（edit/write）
        if ((e.toolName === "edit" || e.toolName === "write") && e.args && typeof e.args === "object"
            && typeof (e.args as Record<string, unknown>).path === "string") {
          const p = (e.args as Record<string, string>).path;
          if (!this.runChangedFiles.has(p)) this.runChangedFiles.set(p, { path: p, tool: e.toolName, patches: [] });
          // end 事件无 args，靠 toolCallId 找回文件（patch 归档必需）
          this.toolCallPaths.set(e.toolCallId, p);
        }
        const startDetail = toolDetail(e.args);
        this.toolCallDetails.set(e.toolCallId, startDetail);
        this.post({
          type: "toolStart",
          id: e.toolCallId,
          name: e.toolName,
          detail: startDetail,
        });
        break;

      case "tool_execution_update":
        // 子 agent 监控：subagent 扩展经 onUpdate 上报流式进度（partialResult.details.results），
        // pi 原生事件零轮询；非 subagent 工具无此需求，静默丢弃。快照构建失败（非本扩展
        // 的 details 形状）静默跳过，不许弄崩面板（subagentSnapshot.ts 头注释）
        if (e.toolName === "subagent") {
          // 异步壳的后台 onUpdate：工具已 end，行已关——别复活幽灵
          if (this.subagentEndedCalls.has(e.toolCallId)) break;
          const snap = subagentSnapshot(e.partialResult?.details);
          if (snap) {
            const rec = this.trackSubagentRun(e.toolCallId, e.partialResult?.details);
            this.post({ type: "subagentUpdate", id: e.toolCallId, snapshot: snap, final: false, startAt: rec.startAt });
          }
        }
        break;

      case "entry_appended":
        // A2+B：异步子 agent 后台进度——subagent 扩展 appendEntry("subagent-async") 推送，
        // 不进 LLM 上下文的旁路事件流；异步工具已返回，没有 tool_execution_update 可蹭，
        // 浮窗直播全靠这条。id 用句柄（sa-n）非 toolCallId——浮窗按 tab 缓存单例，无需对齐
        if (e.entry?.type === "custom" && e.entry?.customType === "subagent-async") {
          const data = e.entry.data as
            | { handle?: string; status?: string; detail?: unknown; startedAt?: number; endedAt?: number }
          | undefined;
          const asyncSnap = data?.handle ? subagentSnapshot(data.detail) : null;
          if (asyncSnap && data!.handle) {
            // 异步运行计时由扩展随 entry 带来（扩展侧 spawn 时起表，比宿主首见准）
            const rec = this.trackSubagentRun(data!.handle, data!.detail);
            if (typeof data!.startedAt === "number") rec.startAt = data!.startedAt;
            if (typeof data!.endedAt === "number") rec.endAt = data!.endedAt;
            this.post({
              type: "subagentUpdate",
              id: data!.handle,
              snapshot: asyncSnap,
              final: data!.status !== "running",
              startAt: rec.startAt,
              endAt: rec.endAt,
            });
          }
        }
        break;

      case "tool_execution_end": {
        // 工单七：edit 的 result.details.patch（jsdiff unified）按时间序累积——
        // 未跟踪文件逆序逆向还原的唯一依据（裁决 11③）；write 无 details，不可还原
        const patch = e.result?.details?.patch;
        // end 事件不带 args（见 toolCallPaths 注释），按 toolCallId 找回路径再归档 patch
        const callPath = this.toolCallPaths.get(e.toolCallId);
        const known = callPath ? this.runChangedFiles.get(callPath) : undefined;
        if (e.toolName === "edit" && known && typeof patch === "string" && patch) known.patches.push(patch);
        const text = extractText(e.result?.content);
        this.post({
          type: "toolEnd",
          id: e.toolCallId,
          name: e.toolName,
          isError: !!e.isError,
          text,
          // 不带 detail 的话，webview 重建工具行时命令摘要会蒸发，直到 settled 全量重绘才回来。
          // pi 的 end 事件不带 args（agent-session.js:547 只转发 toolCallId/toolName/result/isError），
          // toolDetail(e.args) 恒空——必须用 start 时缓存的摘要兜底，否则这个修复等于没修
          detail: toolDetail(e.args) || this.toolCallDetails.get(e.toolCallId) || "",
        });
        // 子 agent 监控收尾：最终 details.results 快照（含各任务最终输出/状态），
        // 先于 toolEnd 语义无差别——webview 两条都消费，顺序不敏感
        if (e.toolName === "subagent") {
          this.subagentEndedCalls.add(e.toolCallId);
          if (this.subagentEndedCalls.size > 500) {
            // 有界防泄漏：Set 迭代序即插入序，删最旧
            const oldest = this.subagentEndedCalls.values().next().value;
            if (oldest !== undefined) this.subagentEndedCalls.delete(oldest);
          }
          const finalSnap = subagentSnapshot(e.result?.details);
          // 异步壳判定（工单25，2026-09-18）：异步派发的返回值自带 asyncDetails(run)
          // （扩展 index.ts:909，SubagentDetails 兼容、状态 running）——end 时快照里还有
          // running 任务就是异步壳，伪装成最终结果；真进度走 sa-n 句柄行，壳行必须删。
          // 同步调用 end 时不可能有 running，零回归。首版幽灵修复只拦「end 后无收尾」，
          // 没验返回值载荷形状，故有第二轮（教训：归因不停在机制第一层）
          const isAsyncShell = !!finalSnap && finalSnap.tasks.some((t) => t.status === "running");
          if (finalSnap && !isAsyncShell) {
            const rec = this.trackSubagentRun(e.toolCallId, e.result?.details);
            rec.endAt = Date.now();
            this.post({
              type: "subagentUpdate",
              id: e.toolCallId,
              snapshot: finalSnap,
              final: true,
              startAt: rec.startAt,
              endAt: rec.endAt,
            });
          } else {
            // 异步派发壳：无 details，或 details 全 running（异步返回值载荷）——壳行关掉
            this.post({
              type: "subagentUpdate",
              id: e.toolCallId,
              snapshot: { mode: "single", tasks: [] },
              final: true,
              closed: true,
            });
          }
        }
        break;
      }

      case "model_select":
      case "thinking_level_select":
        await this.refreshState();
        break;

      case "auto_retry_start": {
        // 模型请求失败（超时/过载/限流）自动重试：面板必须可见
        const why =
          typeof e.errorMessage === "string"
            ? e.errorMessage
            : typeof e.error === "string"
              ? e.error
              : "";
        this.post({
          type: "notice",
          text:
            fmt2(this.L.retryAttempt, e.attempt ?? "?", e.maxAttempts ?? "?") +
            (why ? ": " + why.slice(0, 120) : ""),
        });
        this.post({
          type: "status",
          text: fmt2(this.L.retrying, e.attempt ?? "?", e.maxAttempts ?? "?"),
        });
        break;
      }
      case "auto_retry_end": {
        this.post({ type: "status", text: "" });
        if (e.success === false) {
          this.post({
            type: "notice",
            text:
              fmt(this.L.retryFailPre, e.attempt ?? "?") +
              (e.finalError ? String(e.finalError).slice(0, 150) : this.L.netErr) +
              this.L.resendHint,
          });
        } else if (e.attempt && e.attempt > 1) {
          this.post({ type: "notice", text: fmt(this.L.retryOk, e.attempt) });
        }
        break;
      }

      case "compaction_start":
        // 压缩进行中状态标签：手动压缩是空闲会话里的 RPC 调用，全程无 agent_start/settled 事件，
        // 没有它压缩期间状态栏零反馈；压缩中发消息被 preflight 拒收时 busy:false 也会把面板
        // 的一次性 status 抹掉（用户实测「正在压缩」提示消失事故）。webview 用它压过 Working
        // 并在 busy:false 时保住标签。start 事件的显性化横幅仍不做（工单六只显性化 end，
        // 缺此 case 时会落 default 被当未知事件透传「⚠ compaction_start: manual」假警告）
        this.compacting = true;
        this.post({ type: "compacting", value: true });
        break;

      case "compaction_end": {
        // 压缩窗口关闭：先落状态再走显性化，busy:false/settled 重绘按非压缩真相清标签
        this.compacting = false;
        this.post({ type: "compacting", value: false });
        // 压缩后占比大降 + 折叠块已入消息数组（pi 压缩完成即重建 agent.state.messages，
        // agent-session.js: buildSessionContext 合成 compactionSummary）——postUiState 整体
        // 重拉消息让折叠块立即上屏。事故教训：原先只 refreshState 刷页脚，DOM 留在压缩前，
        // 折叠块不切页签不出现（BUILDER 报告「settled 重绘出折叠块」被实测证伪，settled 不重拉消息）
        await this.postUiState();
        // 压缩反馈统一发在 postUiState 之后——notice 是 root 一次性 DOM，postUiState 的
        // 整体重绘（renderAll 清 root）会把先发的通知冲掉。事故教训：折叠块修复挂上
        // postUiState 后，panel 的 compactDone/错误 notice 被这次重绘冲掉（用户实测
        // /compact 压缩完零反馈，2026-09-18）；自动压缩失败提示同样中招。反馈从 panel
        // 收敛到此（pi 侧保证：compact() 全部失败路径都会 emit compaction_end，
        // agent-session.js compact() catch，aborted 时静默是有意为之）
        if (e.aborted !== true && e.willRetry !== true) {
          const err = typeof e.errorMessage === "string" ? e.errorMessage : "";
          if (err) {
            if (/Nothing to compact/i.test(err)) this.post({ type: "notice", text: this.L.compactTooSmall });
            else if (/Already compacted/i.test(err)) this.post({ type: "notice", text: this.L.compactAlready });
            // 压缩失败不可见，后续请求会莫名超限——透传面板
            else this.post({ type: "notice", text: this.L.compactionFail + err.slice(0, 150) });
          } else if (e.reason === "manual") {
            const r = e.result as { tokensBefore?: unknown; estimatedTokensAfter?: unknown } | undefined;
            this.post({
              type: "notice",
              text: r ? this.L.compactDone + (r.tokensBefore ?? "?") + " → ≈ " + (r.estimatedTokensAfter ?? "?") + " tokens" : this.L.compactEnded,
            });
          } else {
            const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            this.setBanner({ kind: "compacted", text: fmt(this.L.bannerCompacted, time) });
            this.dbg("banner: compacted (reason=" + (e.reason ?? "?") + ")");
          }
        }
        break;
      }

      case "queue_update": {
        const steering = e.steering ?? [];
        const followUp = e.followUp ?? [];
        const total = steering.length + followUp.length;
        // 工单十六：取回事务期间只记账不转正（否则 clearQueue 清空队列会被当成「全部被取走」，
        // 保留集还没重排队就被转正成用户气泡）。收口对账在 retrieveQueued 内完成
        if (this.retrieving) {
          this.lastQueueTotal = total;
          this.post({ type: "queue", steering, followUp });
          break;
        }
        // 关键：steering 是插进当前运行，不会触发 agent_start；只能靠队列变短感知插话已被取走
        if (total < this.lastQueueTotal && this.queued.length) {
          let n = Math.min(this.lastQueueTotal - total, this.queued.length);
          while (n-- > 0) {
            const q = this.queued.shift()!;
            this.post({
              type: "queuedDelivered",
              qid: q.qid,
              show: true,
              text: q.text,
              imageCount: q.imageCount,
              codeInfo: q.codeInfo,
            });
          }
        }
        this.lastQueueTotal = total;
        this.post({ type: "queue", steering, followUp });
        break;
      }

      case "extension_error":
        this.post({
          type: "notice",
          text: this.L.extErr + e.event + "): " + e.error,
        });
        break;

      case "agent_settled": {
        // 刀6：isStreaming 已翻 false，busy 派生即假，无需清镜像
        this.liveStreaming = false; // 工单24：settled 即无在途（中断路径 message_end 可能不发）
        // 本轮实测耗时随 busy:false 下发（中断也算一轮，时长到中断为止）；
        // 无 agent 运行（命令式应答）不带字段，webview 不显示耗时
        this.post({
          type: "busy",
          value: false,
          ...(this.runStartTs > 0 ? { elapsedMs: Date.now() - this.runStartTs } : {}),
        });
        this.dbg("busy=false (agent_settled, elapsedMs=" + (this.runStartTs > 0 ? Date.now() - this.runStartTs : "n/a") + ")");
        this.runStartTs = 0;
        this.lastQueueTotal = 0;
        // 工单七：run 结束——把工具命中清单交给 adapter（git 比对合并 + UI 出口都在那边）；
        // 清单本体保留到下次 agent_start/换会话，会话域持有（多标签预留）
        if (this.runChangedFiles.size) {
          try { this.onRunSettled?.([...this.runChangedFiles.values()]); } catch (err) { this.dbg("runChanges callback failed: " + err); }
        }
        if (this.abortSkipRender) {
          // 中断后的重绘会抹掉现场（会话文件里被中断的消息是空的），跳过
          this.abortSkipRender = false;
          await this.refreshState();
          break;
        }
        // 用完整会话消息重绘，纠正流式过程中的偏差；尚未送达的排队项保留气泡
        this.syncRenderKeepQueued();
        await this.refreshState();
        break;
      }

      default: {
        // 其余事件若携带错误信息（如模型请求超时），透传到面板，避免报错无反馈
        const u = e as PiUnknownEvent;
        const err = u.error ?? u.errorMessage ?? u.reason;
        if (typeof err === "string" && err) {
          this.post({ type: "notice", text: "⚠ " + u.type + ": " + err.slice(0, 200) });
        }
        break;
      }
    }
  }
}

/** 工单24 闸门直发类型：uiState 本身（回放触发器，闸门解除前必须先到 webview）+ 非流式/
 *  交互应答类（notice/status/fillInput、下钻、斜杠菜单、文件附加等——与快照无序依赖，
 *  直发不被 renderAll 冲掉）。其余（流式 delta/thinking/toolCall*、newLive、toolStart/End、
 *  busy、render、user、queued*、subagentUpdate）入队保序回放 */
const GATE_PASS_TYPES = new Set<string>([
  "uiState",
  "notice",
  "status",
  "fillInput",
  "subagentDetail",
  "slashList",
  "fileList",
  "addFiles",
  "queuedRetrieved",
  "state",
  "mode",
  "banner",
  "queue",
  "compacting",
  "subagentUpdate",
]);

/** 从消息 content 里抽纯文本（核心与 adapter 共用；adapter 的会话预览读取也用它） */
/** 诊断日志行摘要（A 刀）：任意跨边界消息 → 一行紧凑线索（type + 字段形状）。
 *  「out 过滤落盘」就是指这里：render/uiState 整包可达 MB 级，全量 JSON 落盘会瞬间
 *  打穿 5MB 轮转、把真正要看的线索冲掉——字符串只留头 60 字 + 长度，数组留条数，
 *  嵌套对象留键名。纯函数零副作用，out（panel.post）/ in（onWebviewMessage）共用。 */
/** 会话记忆查询（H 刀抽出的单一事实源）：{工作区: {tabKey: 会话文件}} 二维键 + t1 的
 *  旧全局键兑底（只读迁移不回写）。piCore（boot 恢复/启动参数判定）与 panel（页签持久化
 *  过滤）同口径消费——同一查询双实现必漂移（bindViewEvents 教训：两处不一致编译器不报）。 */
export function sessionMemoryFor(
  getPersist: <T>(key: string, defaultValue: T) => T,
  wsKey: string,
  tabKey: string
): string | undefined {
  const tabMap = getPersist<Record<string, Record<string, string>>>("piChat.lastSessionByWs2", {});
  const hit = tabMap[wsKey]?.[tabKey];
  if (hit) return hit;
  const legacy = getPersist<Record<string, string>>("piChat.lastSessionByWs", {});
  return tabKey === "t1" ? legacy[wsKey] : undefined;
}

export function msgBrief(m: unknown): string {
  const o = m as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object") return String(m);
  const parts: string[] = [];
  for (const k of Object.keys(o)) {
    if (k === "type" || k === "tabId") continue;
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string")
      parts.push(k + "=" + (v.length > 60 ? JSON.stringify(v.slice(0, 60)) + "…" + v.length : JSON.stringify(v)));
    else if (Array.isArray(v)) parts.push(k + "=arr(" + v.length + ")");
    else if (typeof v === "object") parts.push(k + "={" + Object.keys(v).join(",") + "}");
    else parts.push(k + "=" + String(v));
  }
  const t = (o as { type?: unknown }).type;
  const head = (typeof t === "string" ? t : "?") + (o.tabId != null ? " tab=" + String(o.tabId) : "");
  return head + (parts.length ? " " + parts.join(" ") : "");
}

export function extractText(content: any): string {
  if (typeof content === "string") return content;
  let out = "";
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === "text" && c.text) out += c.text;
    }
  }
  return out;
}
