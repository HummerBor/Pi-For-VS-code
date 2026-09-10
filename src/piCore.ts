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
import { PiClient } from "./piClient";
import { STRINGS, NATIVE_KEYS, bb, fmt, fmt2, type Lang } from "./i18n";
import type { BannerPayload, GetSessionStatsResult, HostToWebview, PiEvent, PiUnknownEvent, ToolChangedFile, WebviewToHost } from "./protocol";
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
  private busy = false;
  /** 当前编辑器的代码上下文（adapter 监听选区后经 setCodeContext 注入，prompt 组装消费） */
  private codeCtx: { name: string; rel: string; range: string; text: string } | null = null;
  /** 中断后跳过一次 settled 重绘（会话里被中断的消息是空的，重绘会抹掉现场） */
  private abortSkipRender = false;
  private queued: { qid: string; sentText: string; text: string; imageCount: number; codeInfo?: string }[] = [];
  /** 最近一次已知会话名/文件（用于自动命名判断） */
  private lastSessionName: string | null = null;
  /** 命令式应答标记：发出 prompt 后未等到 agent_start 前为 true（用于清除乐观 busy/免误导性中断提示） */
  private pendingPrompt = false;
  /** 本轮 agent 运行起点（agent_start 时记录，settled 时算实测耗时）；0=无运行 */
  private runStartTs = 0;
  private lastSessionFile: string | null = null;
  /** 已自动命名过的会话文件（避免重复 RPC） */
  private autoTitledFor: string | null = null;
  /** pi 侧 queue_update 报告的排队总数（steering+followUp），用于检测“队列变短=插话已被取走” */
  private lastQueueTotal = 0;
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
  /** 工单七 run 边界回调：核心只产中性事件，adapter 拿它做 git 快照/比对。
   *  可为 null（宿主未接时收集照常、事件丢弃） */
  onRunStart: (() => void) | null = null;
  onRunSettled: ((files: ToolChangedFile[]) => void) | null = null;

  /** 面板语言（zh 默认 / en），头部 中/EN 按钮切换；持久化由 adapter 完成 */
  lang: Lang = "zh";

  constructor(
    private readonly caps: HostCapabilities,
    private readonly ui: UiActions,
    private readonly post: (msg: HostToWebview) => void,
    private readonly version: string
  ) {}

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

  /** 权限模式徽标文本：优先用 pi 推送过的值，没有则读 mode.json 兑底；
   *  文件也缺失时回退 pi 默认 auto——返回空串会把徽标清空（用户实测徽标消失，fc134df） */
  modeBadgeText(): string {
    if (this.lastModeText) return this.lastModeText;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "mode.json"), "utf8")).mode;
      const labels: Record<string, string> = { manual: "Manual", "edit-auto": "Edit automatically", plan: "Plan", auto: "Auto" };
      if (m && labels[m]) return "⚡ " + labels[m];
    } catch {
      // ignore
    }
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
    const args = ephemeral ? ["--no-session"] : mode === "continue" ? ["-c"] : [];
    const sessionDir = this.caps.getConfig("piChat", "sessionDir", "");
    if (sessionDir) args.push("--session-dir", sessionDir);
    this.clientNoSession = ephemeral;

    const client = new PiClient();
    this.client = client;

    client.onUiRequest = (req) => void this.handleUiRequest(req);
    client.onExit = (code, detail) => {
      this.busy = false;
      this.post({ type: "busy", value: false });
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

    // 恢复上次使用的模型 / 思考等级（跨窗口、跨重启记忆）
    const lastModel = this.caps.getPersist<{ provider: string; id: string } | undefined>(
      "piChat.lastModel", undefined
    );
    const lastThinking = this.caps.getPersist<string | undefined>("piChat.lastThinking", undefined);
    if (lastModel || lastThinking) {
      void (async () => {
        try {
          if (lastModel) await client.setModel(lastModel.provider, lastModel.id);
          if (lastThinking) await client.setThinkingLevel(lastThinking);
        } catch {
          // 恢复失败不影响使用
        }
        await this.refreshState();
      })();
    }

    // 初始化状态和已有会话内容：按项目恢复上次使用的会话文件（免重选，且不串项目）。
    // 注意顺序：先等恢复（可能 switchSession）完成再刷新状态/重绘，
    // 否则标题是 -c 恢复的会话、内容却是记住的会话，两边对不上
    this.restoringSession = (async () => {
      try {
        const last = this.getSessionForWs(cwd);
        if (last && fs.existsSync(last)) {
          try {
            await client.switchSession(last);
          } catch {
            // 文件失效则退回 -c 恢复的最近会话
          }
          await this.refreshState(); // 切换后立刻同步标题，杜绝「内容 A 标题 B」
        } else {
          await this.refreshState();
        }
        const d = await client.getMessages();
        this.post({ type: "render", messages: d?.messages ?? [] });
      } catch {
        // 忽略
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

  /** 读取当前项目对应的“上次会话”（全局 Map：工作区路径 → 会话文件） */
  private getSessionForWs(cwd: string): string | undefined {
    const map = this.caps.getPersist<Record<string, string>>("piChat.lastSessionByWs", {});
    const key = cwd.replace(/\\+$/, "").toLowerCase();
    return map[key];
  }

  /** 写入当前项目对应的“上次会话” */
  private setSessionForWs(file: string): void {
    const cwd = this.caps.getCwd();
    if (!cwd) return;
    const map = this.caps.getPersist<Record<string, string>>("piChat.lastSessionByWs", {});
    map[cwd.replace(/\\+$/, "").toLowerCase()] = file;
    this.caps.setPersist("piChat.lastSessionByWs", map);
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
    // 兜底 catch：case 内未自行接住的抛错不得静默蒸发（async 方法无人接 reject，
    // compactSession 抛错零反馈事故的类级修复，2026-09-09）；各 case 自身的
    // try/catch 优先生效，此处只接漏网之鱼
    try {
      await this.dispatchWebviewMessage(m);
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.opFail + (err?.message ?? err) });
    }
  }

  private async dispatchWebviewMessage(m: WebviewToHost): Promise<void> {
    switch (m.type) {
      case "webviewReady": {
        // webview（重）加载完成：无条件拉一次会话重绘。重开插件/窗口重载/临时切走后回来，
        // 历史聊天都在——这是「聊天记录丢了」事故的第一道保险
        void (async () => {
          try {
            // 启动恢复（switchSession）还在进行时先等它，避免重绘到旧会话再跳一次
            if (this.restoringSession) await this.restoringSession.catch(() => {});
            const d = await this.client?.getMessages();
            this.post({ type: "render", messages: d?.messages ?? [] });
            this.post({ type: "busy", value: this.busy });
            // 权限模式徽标：session_start 的 setStatus 只推一次，webview 重建（切语言/改背景）后不会重发，
            // 这里用记住的值/ mode.json 兑底补发，否则徽标永远空白
            this.post({ type: "mode", text: this.modeBadgeText() });
            // 压缩横幅随握手重发：横幅状态在宿主（工单六），webview 重建后不丢
            this.post({ type: "banner", banner: this.banner });
          } catch {
            // ignore
          }
          await this.refreshState();
        })();
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
          "/reload": this.L.tuiOnly,
          "/trust": this.L.tuiOnly,
          "/changelog": this.L.tuiOnly,
          "/debug": this.L.tuiOnly,
        };
        if (tuiOnly[firstTok]) {
          this.post({ type: "notice", text: tuiOnly[firstTok] });
          break;
        }
        const client = this.ensureClient();
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
        // 乐观反馈：立刻显示工作状态，不等 agent_start 事件（省掉 1~2s 的无反馈空窗）
        const wasBusy = this.busy;
        this.busy = true;
        // 插话（wasBusy=true）时 run 仍在跑：必须带上真实已过时长，否则 webview 计时起点
        // 被重置——「一排队 Working 就重新计时」的根源；新消息（空闲）不带=从现在起算
        this.post({
          type: "busy",
          value: true,
          ...(wasBusy && this.runStartTs > 0 ? { elapsedMs: Date.now() - this.runStartTs } : {}),
        });
        this.dbg("busy=true (prompt_optimistic, wasBusy=" + wasBusy + ")");
        // 气泡显示实际发送的内容：有文字显示文字；纯代码附带/纯图片时显示对应的占位语（与会话记录一致）
        const displayText = m.text || (codeInfo ? this.L.seeCode : m.images?.length ? this.L.seeImage : m.files?.length ? this.L.seeFiles : m.text);
        // 气泡先行：pi 启动/发送可能要几秒，等 await 完才画会让用户以为消息丢了
        if (wasBusy) {
          // 插队消息：只显示「排队中」气泡，等 queue_update 报告被取走后再转正为正式气泡（避免重复）
          const qid = "q" + Date.now();
          this.queued.push({ qid, sentText: text, text: displayText, imageCount: m.images?.length ?? 0, codeInfo });
          this.post({ type: "queuedAdd", qid, text: displayText, imageCount: m.images?.length ?? 0, fileCount: m.files?.length ?? 0, codeInfo });
        } else {
          this.post({ type: "user", text: displayText, imageCount: m.images?.length ?? 0, fileCount: m.files?.length ?? 0, codeInfo });
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
            if (!steered && this.busy && this.pendingPrompt) {
              this.pendingPrompt = false;
              this.busy = false;
              this.dbg("busy=false (4s_pendingPrompt_fallback: no agent_start within 4s)");
              this.post({ type: "busy", value: false });
            }
          }, 4000);
        }
        try {
          try {
            await client.prompt(text, wasBusy, m.images);
          } catch (e: any) {
            // busy 标志与 pi 真实状态错位时（如 agent_start 晚于 4s 兜底，busy 已被清），
            // pi 会拒收不带 streamingBehavior 的 prompt → 自动转 steer 重发，消息照常排队
            // 工单五-3 可达性结论（直连）：自愈保留。panel 读 wasBusy 与调 client.prompt 之间
            // 无异步间隙（同一线程同步块），正常永不触发拒收；唯一可达场景是镜像已漂移
            // （4s 兜底误清 busy 后用户再发消息 → steer=false 撞上运行中的 session.prompt）。
            // 它是对账/兜底两层全失效时的最后一层，撤掉后漂移会以「发送失败」报错形式砸给用户
            const msg = String(e?.message ?? e);
            if (!/already processing|streamingBehavior/i.test(msg)) throw e;
            this.post({ type: "notice", text: this.L.autoQueued });
            steered = true;
            // pi 拒收 = 它一定正在跑上一个 run：busy 必须纠回 true 并同步给 webview。
            // 若不纠回：steer 不触发 agent_start，4s 兜底会把 busy 清掉 → 整个 run 期间
            // 宿主自认空闲，后续消息全部误判（Working 消失/排队气泡丢失的根源）
            this.busy = true;
            this.post({ type: "busy", value: true, elapsedMs: this.runStartTs > 0 ? Date.now() - this.runStartTs : 0 });
            this.dbg("busy=true (steer_resend: pi rejected prompt as already processing)");
            await client.prompt(text, true, m.images);
          }
          // 新会话首条真实文字消息 → 自动命名会话（CC 风格，历史列表/头部都能显示标题）
          if (!wasBusy && m.text) void this.autoTitleSession(m.text);
        } catch (err: any) {
          this.busy = false;
          this.post({ type: "busy", value: false });
          this.dbg("busy=false (prompt_send_fail: " + String(err?.message ?? err).slice(0, 120) + ")");
          this.post({ type: "notice", text: this.L.sendFail + (err?.message ?? err) });
        }
        break;
      }
      case "abort":
        try {
          if (this.client?.running) {
            await this.client.abort();
            if (this.busy && this.pendingPrompt) {
              // 命令式应答（如 /llama，无 agent 运行）：没有可中断的东西，直接清掉乐观 busy，不弹中断提示
              this.pendingPrompt = false;
              this.busy = false;
              this.post({ type: "busy", value: false });
              this.dbg("busy=false (abort_while_pendingPrompt)");
              break;
            }
            // pi 不把中断时的部分内容写进会话文件（content 为空），
            // 下次 agent_settled 的整页重绘会把已显示的思考/工具行抹掉——跳过那一次重绘，保留现场
            this.abortSkipRender = true;
            this.post({ type: "notice", text: this.L.aborted });
          }
        } catch {
          // ignore
        }
        break;
      case "retryFromLast": {
        // 模型请求失败后回退：fork 到最近一条用户消息（错误消息从活跃分支清除），原文填回输入框供修改重发
        try {
          const fm = await this.client?.getForkMessages();
          const list: any[] = fm?.messages ?? [];
          const last = list[list.length - 1];
          if (!last) {
            this.post({ type: "notice", text: this.L.noMsgToFork });
            break;
          }
          const fr = await this.client!.fork(last.entryId);
          if (fr?.cancelled) {
            this.post({ type: "notice", text: this.L.forkCancelled });
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
          this.syncRenderKeepQueued();
          this.post({ type: "notice", text: this.L.forked });
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
          // 路径兑底字节通道：OS 拖入/剪贴板拿不到绝对路径，宿主落临时文件再把路径交给 pi
          const safeName = String(m.name || "file").replace(/[\\/:*?"<>|]/g, "_");
          const tmp = path.join(os.tmpdir(), "pi-attach-" + Date.now() + "-" + safeName);
          try {
            fs.writeFileSync(tmp, Buffer.from(m.data, "base64"));
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
    ];
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
      // pi 的 new_session 会把模型重置为默认值 → 把记住的模型/思考等级补回去
      const lastModel = this.caps.getPersist<{ provider: string; id: string } | undefined>(
        "piChat.lastModel", undefined
      );
      const lastThinking = this.caps.getPersist<string | undefined>("piChat.lastThinking", undefined);
      try {
        if (lastModel) await client.setModel(lastModel.provider, lastModel.id);
        if (lastThinking) await client.setThinkingLevel(lastThinking);
      } catch {
        // 补回失败不影响使用
      }
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.nsFail + (err?.message ?? err) });
    }
  }

  /** 给 webview 提供 /命令列表（懒加载一次） */
  private async sendSlashCommands(): Promise<void> {
    let cmds: any[] = [];
    try {
      const client = this.ensureClient();
      const d = await client.getCommands();
      cmds = d?.commands ?? [];
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
    const ext = cmds
      .filter((c: any) => !nativeNames.has(String(c.name)))
      .map((c: any) => ({
        group: this.L.grpCmds,
        label: "/" + c.name,
        description: c.description || c.source || "",
        name: c.name,
      }));
    this.post({ type: "slashList", commands: [...builtin, ...native, ...ext] });
  }

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
    const client = this.client;
    if (!client?.running) return;
    try {
      const st = await client.getState();
      let stats: GetSessionStatsResult | null = null;
      try {
        stats = await client.getSessionStats();
      } catch {
        // ignore
      }
      // 真相对账：get_state.isStreaming 是 pi 的权威状态。只纠「镜像说空闲、真相在跑」方向——
      // 反向不纠：prompt 乐观置位窗口内 isStreaming 尚为 false，纠了会打断正常反馈（那是 4s 兜底的职责）
      if (st.isStreaming === true && !this.busy) {
        this.busy = true;
        this.pendingPrompt = false;
        if (!this.runStartTs) this.runStartTs = Date.now();
        this.post({ type: "busy", value: true, elapsedMs: Date.now() - this.runStartTs });
        this.dbg("busy=true (reconcile: get_state.isStreaming)");
      }
      // 工单五-1 观察期断言（直连后镜像应与真相零漂移）：反向不一致只记日志不纠——
      // busy=true 且已过 pendingPrompt 窗口时 pi 却空闲，意味着某个 busy setter 误清/漏清。
      // 零触发观察期满后，本处与 onPiEvent 顶部的对账纠偏逻辑一并删除（DIRECTOR.md 工单五-1）
      if (this.busy && !this.pendingPrompt && st.isStreaming === false) {
        this.dbg("MISMATCH(reverse, observe-only): mirror busy but pi idle, pendingPrompt=false");
      }
      // 按项目记住当前会话文件，下次启动自动恢复（切走/重启不用重选会话）
      if (st?.sessionFile) this.setSessionForWs(st.sessionFile);
      // 换会话（切换/新会话/分叉都会换 sessionFile）：阈值预警 re-arm + 清会话域横幅（工单六）
      if ((st?.sessionFile ?? null) !== this.lastSessionFile) {
        this.contextWarnArmed = true;
        if (this.banner) this.setBanner(null);
        // 工单七：变更清单同样是会话域信息，不残留到别的会话
        this.runChangedFiles.clear();
        this.toolCallPaths.clear();
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
      this.post({
        type: "state",
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
      });
    } catch {
      // ignore
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
        this.post({ type: "queuedClear" });
        this.post({ type: "render", messages: msgs });
      } catch {
        // ignore
      }
    })();
  }

  private async onPiEvent(e: PiEvent): Promise<void> {
    // 事件流即真相：这四类事件只在 agent 运行中产生。若 busy 镜像为 false 时收到，
    // 说明镜像已漂移（如 4s 兜底误清），立即纠回——脱同步不再能存活到 run 结束
    if (
      !this.busy &&
      (e.type === "message_start" || e.type === "message_update" ||
       e.type === "tool_execution_start" || e.type === "tool_execution_end")
    ) {
      this.busy = true;
      this.pendingPrompt = false;
      if (!this.runStartTs) this.runStartTs = Date.now();
      this.post({ type: "busy", value: true, elapsedMs: Date.now() - this.runStartTs });
      this.dbg("busy=true (reconcile: " + e.type + " while mirror idle)");
    }
    switch (e.type) {
      case "agent_start":
        this.busy = true;
        this.pendingPrompt = false;
        this.runStartTs = Date.now();
        // 工单七：新 run 开始——上一轮清单作废，通知 adapter 做 git 快照（baseline 用）
        this.runChangedFiles.clear();
        this.toolCallPaths.clear();
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
          this.post({ type: "newLive" });
        }
        break;
      }

      case "message_update": {
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
        this.post({
          type: "toolStart",
          id: e.toolCallId,
          name: e.toolName,
          detail: toolDetail(e.args),
        });
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
          // 不带 detail 的话，webview 重建工具行时命令摘要会蒸发，直到 settled 全量重绘才回来
          detail: toolDetail(e.args),
        });
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
        // start 事件不消费（工单六只显性化 end）。缺此 case 时会落 default 分支被当
        // 未知事件透传「⚠ compaction_start: manual」假警告（2026-09-09 实测抓到）
        break;

      case "compaction_end": {
        // 自动压缩（threshold/overflow）成功 → 横幅显性化（工单六）。手动压缩已有
        // compactDone 通知不重复；aborted/willRetry 属未完成或将重试，静默等下一次 end
        if (e.reason !== "manual" && e.aborted !== true && e.willRetry !== true) {
          const err = typeof e.errorMessage === "string" ? e.errorMessage : "";
          if (err) {
            // 压缩失败不可见，后续请求会莫名超限——透传面板
            this.post({ type: "notice", text: this.L.compactionFail + err.slice(0, 150) });
          } else {
            const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            this.setBanner({ kind: "compacted", text: fmt(this.L.bannerCompacted, time) });
            this.dbg("banner: compacted (reason=" + (e.reason ?? "?") + ")");
          }
        }
        // 压缩后占比大降：刷新用量显示 + re-arm 阈值预警
        await this.refreshState();
        break;
      }

      case "queue_update": {
        const steering = e.steering ?? [];
        const followUp = e.followUp ?? [];
        const total = steering.length + followUp.length;
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
        this.busy = false;
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

/** 从消息 content 里抽纯文本（核心与 adapter 共用；adapter 的会话预览读取也用它） */
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
