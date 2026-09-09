import { EventEmitter } from "events";
import type { GetMessagesResult, GetSessionStatsResult, GetStateResult } from "./protocol";
import { loadPiSdk } from "./piSdk";

/**
 * piClient：进程内直连 pi 的适配器。
 *
 * 历史：本类曾 spawn "pi --mode rpc" 子进程、在 stdin/stdout 上按行收发 JSON
 * （协议见 pi 文档 rpc.md）。2026-09-09 用户拍板改为进程内直连（AgentSession /
 * AgentSessionRuntime，见 piSdk.ts 头注释），对外方法签名、事件形状、UI 请求链路
 * 与 RPC 时代保持一致——panel.ts / webview / protocol.ts 不感知底层切换。
 *
 * RPC 语义保留对照（改本文件前必读，这是两代实现的行为契约）：
 * - prompt「接受即回响应」：SDK 的 session.prompt() 要等整轮跑完（含重试）才
 *   resolve，用 PromptOptions.preflightResult 在验收时提前 resolve 外层 Promise；
 *   验收后的失败走事件流，与 rpc.md「Failures after acceptance are reported
 *   through the normal event stream」一致。
 * - 忙时发 prompt（不带 streamingBehavior）：SDK 抛 "Agent is already processing.
 *   Specify streamingBehavior ('steer' or 'followUp') to queue the message."——
 *   与 panel.ts steer 自愈正则 /already processing|streamingBehavior/i 原样匹配，
 *   自愈兜底继续有效。别改这条文案，它是跨模块契约。
 * - 事件形状：AgentSessionEvent 与 RPC 事件流同构（同一套 AgentEvent 的两种出口，
 *   RPC 只多了 JSON 序列化），panel.ts 的 onPiEvent 处理器零改动。
 * - busy/队列：RPC 时代靠镜像+三层对账去猜；现在 isStreaming/pendingMessageCount/
 *   getSteeringMessages() 都是同步真读。panel 的对账代码暂留（变成永真保险），
 *   状态机收敛另立工单处理。
 */
export class PiClient {
  /** pi 推送的事件流（agent_start / message_update / tool_execution_* / queue_update 等） */
  readonly events = new EventEmitter();
  /** 进程内直连没有「进程退出」概念，保留字段兼容 panel 接线，不再触发 */
  onExit?: (code: number | null, detail: string) => void;
  /** 启动失败回调（找不到 pi 包 / 版本不兼容 / 会话创建失败），panel 展示安装指引 */
  onError?: (err: Error) => void;
  /** 扩展请求用户交互（select/confirm/input/editor/notify/setStatus），由上层实现真正的 UI */
  onUiRequest?: (req: any) => void;

  private runtime: any = null; // AgentSessionRuntime（会话替换：new/switch/fork/clone/import）
  private session: any = null; // 当前 AgentSession
  private unsubscribe: (() => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private startOpts: { cwd: string; extraArgs: string[]; proxyUrl?: string } | null = null;
  /** 扩展 UI 对话框的挂起请求：id → resolver（panel respondUi 回来时配对） */
  private uiPending = new Map<string, { method: string; resolve: (v: any) => void; timer?: NodeJS.Timeout }>();
  private uiSeq = 1;

  get running(): boolean {
    return this.session !== null;
  }

  /** 启动参数（cwd/启动模式/代理）由 panel 传入；初始化是异步的，所有方法先 await ready() */
  start(cwd: string, extraArgs: string[] = [], proxyUrl?: string): void {
    if (this.session || this.initPromise) return;
    this.startOpts = { cwd, extraArgs, proxyUrl };
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    try {
      const sdk = await loadPiSdk();
      const { cwd, extraArgs, proxyUrl } = this.startOpts!;

      // 代理：RPC 时代透传给子进程环境；进程内直接写当前进程环境（pi 的网络栈读环境变量）
      if (proxyUrl) {
        process.env.HTTP_PROXY = proxyUrl;
        process.env.HTTPS_PROXY = proxyUrl;
        process.env.http_proxy = proxyUrl;
        process.env.https_proxy = proxyUrl;
      }

      // 启动参数映射（对应 panel.ensureClient 的 sessionMode，默认值契约见那边的注释）
      // --no-session → inMemory（不落盘）；-c → continueRecent（接最近一次）；默认 create（新会话）
      // --session-dir <dir> → sessionManager 的 sessionDir 参数
      const dirIdx = extraArgs.indexOf("--session-dir");
      const sessionDir = dirIdx >= 0 ? extraArgs[dirIdx + 1] : undefined;
      const ephemeral = extraArgs.includes("--no-session");
      const useContinue = extraArgs.includes("-c");
      const sessionManager = ephemeral
        ? sdk.SessionManager.inMemory(cwd)
        : useContinue
          ? sdk.SessionManager.continueRecent(cwd, sessionDir)
          : sdk.SessionManager.create(cwd, sessionDir);

      // 官方 runtime 工厂姿势（sdk.md「Session Management」）：services 绑定 cwd，
      // runtime 负责会话替换（new/switch/fork/clone/import 后 runtime.session 会换新对象）
      const createRuntime = async (opts: {
        cwd: string;
        sessionManager: any;
        sessionStartEvent?: any;
      }) => {
        const services = await sdk.createAgentSessionServices({ cwd: opts.cwd });
        return {
          ...(await sdk.createAgentSessionFromServices({
            services,
            sessionManager: opts.sessionManager,
            sessionStartEvent: opts.sessionStartEvent,
          })),
          services,
          diagnostics: services.diagnostics,
        };
      };
      this.runtime = await sdk.createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir: sdk.getAgentDir(),
        sessionManager,
      });
      this.bindSession();
      // 扩展 UI：0.84.4 不在创建参数里收 uiContext，创建后经 extensionRunner 注入
      // （与 TUI/RPC 模式同款接法）。mode 传 "rpc"：扩展看到的 ctx.mode 语义不变
      // （hasUI=true，TUI 专属方法已在 uiContext 里安全降级）
      this.session.extensionRunner?.setUIContext?.(this.createUiContext(), "rpc");
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** 绑定当前 runtime.session 的事件订阅；每次会话替换后必须重调 */
  private bindSession(): void {
    this.unsubscribe?.();
    this.session = this.runtime.session;
    this.unsubscribe = this.session.subscribe((e: any) => {
      this.events.emit("event", e);
    });
  }

  /** 会话替换后的统一收尾：重订阅 + 给新 session 的 extensionRunner 补挂 UI */
  private afterSessionSwap(): void {
    this.bindSession();
    this.session.extensionRunner?.setUIContext?.(this.createUiContext(), "rpc");
  }

  /** 所有公开方法先过这道门：启动失败时 reject 原始错误（panel 有提示链路） */
  private async ready(): Promise<void> {
    if (!this.initPromise) throw new Error("pi 未启动");
    await this.initPromise;
  }

  /** 回复扩展的 UI 请求（select/confirm/input/editor），与 RPC 时代的响应格式一致 */
  respondUi(resp: Record<string, unknown>): void {
    const id = String(resp.id ?? "");
    const p = this.uiPending.get(id);
    if (!p) return;
    this.uiPending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (p.method === "confirm") p.resolve(resp.cancelled ? false : resp.confirmed === true);
    else p.resolve(resp.cancelled ? undefined : resp.value);
  }

  private createUiContext(): any {
    const request = (method: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<any> => {
      const id = "ui-" + this.uiSeq++;
      if (!this.onUiRequest) {
        // 无上层 UI：与 RPC 无客户端时行为一致——对话框请求直接取消
        return Promise.resolve(undefined);
      }
      return new Promise<any>((resolve) => {
        const entry: { method: string; resolve: (v: any) => void; timer?: NodeJS.Timeout } = {
          method,
          resolve: (v) => {
            if (entry.timer) clearTimeout(entry.timer);
            resolve(v);
          },
        };
        // 超时自动兜底：RPC 时代由 pi 侧自动 resolve（rpc.md「dialog with timeout」），
        // 进程内由本适配器承担同一职责——select/input/editor 超时回 undefined，confirm 回 false
        if (timeoutMs && timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            this.uiPending.delete(id);
            resolve(method === "confirm" ? false : undefined);
          }, timeoutMs);
        }
        this.uiPending.set(id, entry);
        this.onUiRequest!({ type: "extension_ui_request", id, method, ...payload });
      });
    };
    return {
      // ── 对话框：桥接到 panel 的 handleUiRequest（QuickPick/模态确认/输入框）──
      select: (title: string, options: string[], opts?: { timeout?: number }) =>
        request("select", { title, options }, opts?.timeout),
      confirm: (title: string, message: string, opts?: { timeout?: number }) =>
        request("confirm", { title, message }, opts?.timeout),
      input: (title: string, placeholder?: string, opts?: { timeout?: number }) =>
        request("input", { title, placeholder }, opts?.timeout),
      editor: (title: string, prefill?: string) => request("editor", { title, prefill }),
      // fire-and-forget：panel 侧直接展示
      notify: (message: string, notifyType?: string) => {
        if (!this.onUiRequest) return;
        this.onUiRequest({ type: "extension_ui_request", id: "ui-" + this.uiSeq++, method: "notify", message, notifyType });
      },
      // 权限模式显示依赖这条：模式扩展用 statusKey="mode" 推当前权限模式，panel 画在状态栏
      setStatus: (statusKey: string, statusText?: string) => {
        if (!this.onUiRequest) return;
        this.onUiRequest({ type: "extension_ui_request", id: "ui-" + this.uiSeq++, method: "setStatus", statusKey, statusText });
      },
      // ── TUI 专属能力：扩展宿主没有终端，安全 no-op（对齐 rpc.md 的降级表）──
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      setToolsExpanded: () => false,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: async () => ({ success: false, error: "not supported in vscode extension" }),
    };
  }

  /** 发送用户消息；agent 工作中时 steer=true 会排队插话；images 为 base64 图片列表。
   *  Promise 在「pi 验收/排队/拒收」时交付（对齐 RPC 响应时序），不等整轮跑完 */
  prompt(
    text: string,
    steer = false,
    images?: { data: string; mimeType: string }[]
  ): Promise<any> {
    return this.ready().then(
      () =>
        new Promise<any>((resolve, reject) => {
          const opts: any = {
            preflightResult: (ok: boolean) => {
              if (ok) resolve(undefined);
              else reject(new Error("pi 拒绝了该消息（preflight rejected）"));
            },
          };
          if (steer) opts.streamingBehavior = "steer";
          // ImageContent 形状与 panel 上送的一致（{type:"image", data, mimeType}），零转换
          if (images && images.length) {
            opts.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
          }
          // 验收后的失败走事件流（rpc.md 契约）；prompt() 自身若再 reject，
          // 外层 Promise 多半已 resolve——重复 reject 是 no-op，.catch 同时防未处理异常
          this.session.prompt(text, opts).catch(reject);
        })
    );
  }

  abort(): Promise<any> {
    return this.ready().then(() => this.session.abort()).then(() => ({}));
  }

  /** 快照化：把活对象深拷贝成纯数据，和 RPC 时代「JSONL 序列化产物」同构，
   *  防止 panel/webview 持有 pi 内部活引用造成渲染与真实状态纠缠 */
  private static snapshot<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
  }

  getMessages(): Promise<GetMessagesResult> {
    return this.ready().then(() => ({ messages: PiClient.snapshot(this.session.messages) }));
  }

  /** 同步真读拼成 RPC get_state 的形状（字段含义见 protocol.ts GetStateResult） */
  getState(): Promise<GetStateResult> {
    return this.ready().then(() => {
      const s = this.session;
      return {
        isStreaming: s.isStreaming,
        isCompacting: s.isCompacting,
        sessionFile: s.sessionFile ?? undefined,
        sessionId: s.sessionId,
        sessionName: s.sessionName ?? undefined,
        model: s.model ? { id: s.model.id, name: s.model.name, provider: s.model.provider } : null,
        thinkingLevel: s.thinkingLevel,
        steeringMode: s.steeringMode,
        followUpMode: s.followUpMode,
        autoCompactionEnabled: s.autoCompactionEnabled,
        messageCount: s.messages.length,
        pendingMessageCount: s.pendingMessageCount,
      };
    });
  }

  getSessionStats(): Promise<GetSessionStatsResult> {
    return this.ready().then(() => PiClient.snapshot(this.session.getSessionStats()));
  }

  getAvailableModels(): Promise<any> {
    return this.ready().then(async () => {
      const models = await this.session.modelRuntime.getAvailable();
      return { models: PiClient.snapshot(models) };
    });
  }

  setModel(provider: string, modelId: string): Promise<any> {
    return this.ready().then(async () => {
      const m = this.session.modelRuntime.getModel(provider, modelId);
      if (!m) throw new Error("Model not found: " + provider + "/" + modelId);
      await this.session.setModel(m);
      return { model: PiClient.snapshot(m) };
    });
  }

  getAvailableThinkingLevels(): Promise<any> {
    return this.ready().then(() => ({ levels: this.session.getAvailableThinkingLevels() }));
  }

  setThinkingLevel(level: string): Promise<any> {
    return this.ready().then(() => {
      this.session.setThinkingLevel(level);
      return {};
    });
  }

  newSession(): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.runtime.newSession();
      this.afterSessionSwap();
      return { cancelled: !!r?.cancelled };
    });
  }

  /** 加载指定的历史会话文件（*.jsonl） */
  switchSession(sessionPath: string): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.runtime.switchSession(sessionPath);
      this.afterSessionSwap();
      return { cancelled: !!r?.cancelled };
    });
  }

  /** 设置当前会话的显示名称 */
  setSessionName(name: string): Promise<any> {
    return this.ready().then(() => {
      this.session.setSessionName(name);
      return {};
    });
  }

  /** 手动压缩上下文。SDK 返回 CompactionResult 本体；panel 读 r.result.tokensBefore，
   *  包一层 .result 保持 RPC 响应形状 */
  compact(customInstructions?: string): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.session.compact(customInstructions);
      return { result: PiClient.snapshot(r) };
    });
  }

  setAutoCompaction(enabled: boolean): Promise<any> {
    return this.ready().then(() => {
      this.session.setAutoCompactionEnabled(enabled);
      return {};
    });
  }

  setAutoRetry(enabled: boolean): Promise<any> {
    return this.ready().then(() => {
      this.session.setAutoRetryEnabled(enabled);
      return {};
    });
  }

  /** 取消进行中的自动重试 */
  abortRetry(): Promise<any> {
    return this.ready().then(() => {
      this.session.abortRetry();
      return {};
    });
  }

  /** 移除排队中的 steer/follow_up 消息并返回其内容 */
  clearQueue(): Promise<any> {
    return this.ready().then(() => PiClient.snapshot(this.session.clearQueue()));
  }

  /** 导出会话为 HTML */
  exportHtml(outputPath?: string): Promise<any> {
    return this.ready().then(async () => {
      const path = await this.session.exportToHtml(outputPath || undefined);
      return { path };
    });
  }

  /** 获取可分叉的历史用户消息列表 */
  getForkMessages(): Promise<any> {
    return this.ready().then(() => ({ messages: PiClient.snapshot(this.session.getUserMessagesForForking()) }));
  }

  /** 从某条历史用户消息分叉 */
  fork(entryId: string): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.runtime.fork(entryId);
      this.afterSessionSwap();
      return { cancelled: !!r?.cancelled, text: r?.selectedText ?? "" };
    });
  }

  /** 把当前会话复制为新会话。照 RPC 模式源码实现：leaf 处 position:"at" 分叉 */
  clone(): Promise<any> {
    return this.ready().then(async () => {
      const leafId = this.session.sessionManager.getLeafId();
      if (!leafId) throw new Error("Cannot clone session: no current entry selected");
      const r = await this.runtime.fork(leafId, { position: "at" });
      this.afterSessionSwap();
      return { cancelled: !!r?.cancelled };
    });
  }

  /** 直接执行 shell 命令，输出进入对话上下文 */
  bash(command: string): Promise<any> {
    return this.ready().then(async () => {
      const r = await this.session.executeBash(command);
      return PiClient.snapshot({
        output: r.output,
        exitCode: r.exitCode,
        cancelled: !!r.cancelled,
        truncated: !!r.truncated,
        fullOutputPath: r.fullOutputPath ?? null,
      });
    });
  }

  /** 获取可用的 /命令（扩展命令、技能、提示模板）。
   *  拼装顺序与 RPC 模式源码一致（extension → prompt → skill），字段形状照抄 */
  getCommands(): Promise<any> {
    return this.ready().then(() => {
      const s = this.session;
      const commands: any[] = [];
      for (const c of s.extensionRunner.getRegisteredCommands()) {
        commands.push({ name: c.invocationName, description: c.description, source: "extension", sourceInfo: c.sourceInfo });
      }
      for (const t of s.promptTemplates) {
        commands.push({ name: t.name, description: t.description, source: "prompt", sourceInfo: t.sourceInfo });
      }
      for (const sk of s.resourceLoader.getSkills().skills) {
        commands.push({ name: "skill:" + sk.name, description: sk.description, source: "skill", sourceInfo: sk.sourceInfo });
      }
      return { commands };
    });
  }

  /** 插话（steer）送达方式：all=每次回复后全部送达；one-at-a-time=每次一条 */
  setSteeringMode(mode: "all" | "one-at-a-time"): Promise<any> {
    return this.ready().then(() => {
      this.session.setSteeringMode(mode);
      return {};
    });
  }

  /** 追问（follow_up）送达方式 */
  setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<any> {
    return this.ready().then(() => {
      this.session.setFollowUpMode(mode);
      return {};
    });
  }

  dispose(): void {
    // 进程内直连没有子进程可杀——RPC 时代 Windows taskkill /T /F 的脏方案随之作废
    for (const [, p] of this.uiPending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve(p.method === "confirm" ? false : undefined);
    }
    this.uiPending.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const runtime = this.runtime;
    this.runtime = null;
    this.session = null;
    this.initPromise = null;
    if (runtime) void Promise.resolve(runtime.dispose()).catch(() => {});
  }
}
