import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PiClient } from "./piClient";
import { STRINGS, NATIVE_KEYS, Lang, bb, fmt, fmt2 } from "./i18n";
import { getHtml } from "./webview-html";
import type { GetSessionStatsResult, HostToWebview, PiEvent, PiUnknownEvent, WebviewToHost } from "./protocol";
import { toolDetail } from "./toolDetail";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "piChat.view";

  private view?: vscode.WebviewView;
  private client?: PiClient;
  private clientNoSession = false;
  private sessionPickerShown = false;
  private busy = false;
  private codeCtx: { name: string; rel: string; range: string; text: string } | null = null;
  /** 中断后跳过一次 settled 重绘（会话里被中断的消息是空的，重绘会抹掉现场） */
  private abortSkipRender = false;
  private queued: { qid: string; sentText: string; text: string; imageCount: number; codeInfo?: string }[] = [];
  /** 最近一次已知会话名/文件（用于自动命名判断） */
  private lastSessionName: string | null = null;
  /** 命令式应答标记：发出 prompt 后未等到 agent_start 前为 true（用于清除乐观 busy/免误导性中断提示） */
  private pendingPrompt = false;
  private lastSessionFile: string | null = null;
  /** 已自动命名过的会话文件（避免重复 RPC） */
  private autoTitledFor: string | null = null;
  /** pi 侧 queue_update 报告的排队总数（steering+followUp），用于检测“队列变短=插话已被取走” */
  private lastQueueTotal = 0;
  /** 启动时是否已检测过 pi 安装（避免重复弹窗） */
  private piCheckDone = false;
  /** 本窗口是否已提醒过配置凭证（避免反复打扰） */
  private authOfferShown = false;
  private selTimer: NodeJS.Timeout | undefined;
  private editorDisposables: vscode.Disposable[] = [];
  /** 面板语言（zh 默认 / en），头部 中/EN 按钮切换，globalState 持久化 */
  private lang: Lang = "zh";
  /** 鸭子 logo 的 data URI（重生成 HTML 时复用，不必每次读盘） */
  private duckUri = "";
  /** 最近一次权限模式徽标文本（webview 重建后补发用：session_start 的 setStatus 只推一次） */
  private lastModeText = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
    private readonly version: string
  ) {
    this.lang = (globalState.get<Lang>("piChat.lang") ?? "zh") as Lang;
  }

  /** 当前语言字典：面板通知/状态跟随中/EN 按钮；原生对话框专用键双语展示 */
  private get L(): Record<string, any> {
    const lang = this.lang;
    return new Proxy({} as Record<string, any>, {
      get: (_t, k) => {
        const key = String(k);
        return NATIVE_KEYS.has(key) ? bb(key) : (STRINGS[lang][key] ?? bb(key));
      },
    });
  }

  /** 按当前语言/主题/背景重生成 webview HTML（语言切换、背景变更共用） */
  private applyHtml(): void {
    const view = this.view;
    if (!view) return;
    if (!this.duckUri) {
      this.duckUri =
        "data:image/png;base64," +
        fs.readFileSync(path.join(this.extensionUri.fsPath, "media", "pi-icon.png")).toString("base64");
    }
    const kind = vscode.window.activeColorTheme.kind;
    const theme = this.globalState.get<string>("piChat.theme") ?? "midnight";
    const floorColor =
      theme === "midnight" ? "#0b1220" : theme === "cc-dark" ? "#0a0a0c" : kind === vscode.ColorThemeKind.Light ? "#f3f3f3" : kind === vscode.ColorThemeKind.HighContrast ? "#000000" : "#1f1f1f";
    // 面板自带壁纸：本地路径转 data URI（避开 CSP 资源限制），http(s) 直接用
    const c = vscode.workspace.getConfiguration("piChat");
    const img = c.get<string>("backgroundImage", "").trim();
    const op = c.get<number>("backgroundOpacity", 0.35);
    let url = "";
    if (img) {
      if (/^https?:/i.test(img)) {
        url = img;
      } else {
        try {
          const p = img.startsWith("~") ? path.join(os.homedir(), img.slice(1)) : img;
          const ext = path.extname(p).toLowerCase();
          const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : ext === ".bmp" ? "image/bmp" : "image/jpeg";
          url = `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
        } catch {
          url = ""; // 文件读不到则不启用
        }
      }
    }
    view.webview.html = getHtml(theme, this.duckUri, floorColor, url.replace(/'/g, "%27"), op, this.lang);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // retainContextWhenHidden：切到其他侧边栏时保活 webview，回来不重建、不丢会话
    view.webview.options = { enableScripts: true };
    this.applyHtml();
    // 背景图/透明度配置变更 → 重置 webview（webviewReady 握手会自动重绘历史）
    const bgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("piChat.backgroundImage") || e.affectsConfiguration("piChat.backgroundOpacity")) {
        this.applyHtml();
      }
    });
    view.onDidDispose(() => bgWatcher.dispose());
    // webview 若仍被销毁重建（极端情况）：从活着的 pi 进程重绘当前会话，不用重选
    if (this.client?.running) {
      void (async () => {
        try {
          const d = await this.client!.getMessages();
          this.post({ type: "render", messages: d?.messages ?? [] });
          this.post({ type: "busy", value: this.busy });
        } catch {
          // ignore
        }
        await this.refreshState();
      })();
    } else if (
      vscode.workspace.getConfiguration("piChat").get<string>("sessionMode", "continue") !== "ephemeral"
    ) {
      // 首次打开面板 → 主动启动 pi（持久模式，continue/-c 恢复最近会话）：
      // 启动完成后 webviewReady 握手会拉历史重绘，重开插件立刻看到上次聊天
      this.ensureClient();
    }
    view.webview.onDidReceiveMessage((m) => void this.onWebviewMessage(m));

    // 监听编辑器选区，自动把选中代码 / 整个文件作为上下文（CC 同款）
    if (!this.editorDisposables.length) {
      this.editorDisposables.push(
        vscode.window.onDidChangeActiveTextEditor(() => this.pushCodeContext()),
        vscode.window.onDidChangeTextEditorSelection(() => {
          if (this.selTimer) clearTimeout(this.selTimer);
          this.selTimer = setTimeout(() => this.pushCodeContext(), 250);
        })
      );
    }
    this.pushCodeContext();

    // 面板第一次展示时，预热 pi 进程（不弹任何选择框；恢复历史走 ⏱ / 「会话」按钮）
    const prewarm = () => {
      // 首次可见：检测 pi 是否安装；没装则提供一键安装
      if (!this.piCheckDone) {
        this.piCheckDone = true;
        void (async () => {
          const v = await this.piVersion();
          if (v === null) {
            const pick = await vscode.window.showErrorMessage(
              this.L.piNotDetected,
              this.L.installPiBtn,
              this.L.openNodejs
            );
            if (pick === this.L.installPiBtn) await this.installPi();
            else if (pick === this.L.openNodejs)
              void vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
          } else {
            const c = this.ensureClient();
            void c;
            // pi 已装但没配过模型凭证 → 引导配置
            void this.maybeOfferKeyConfig(false);
          }
        })();
      } else if (!this.client) {
        const c = this.ensureClient();
        void c;
      }
    };
    view.onDidChangeVisibility(() => {
      if (view.visible && !this.sessionPickerShown) {
        this.sessionPickerShown = true;
        prewarm();
      }
    });
    if (view.visible && !this.sessionPickerShown) {
      this.sessionPickerShown = true;
      prewarm();
    }
  }

  dispose(): void {
    this.client?.dispose();
    for (const d of this.editorDisposables) d.dispose();
    this.editorDisposables = [];
    if (this.selTimer) clearTimeout(this.selTimer);
  }

  /** 关键链路诊断日志（排查图片丢失等诡异问题用） */
  private dbg(msg: string): void {
    try {
      fs.appendFileSync(path.join(os.homedir(), ".pi", "agent", "pi-chat-debug.log"),
        new Date().toISOString() + " " + msg + String.fromCharCode(10));
    } catch { /* ignore */ }
  }

  private post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  /** 计算当前编辑器的代码上下文（选区 → 选中行；无选区 → 整个文件）并推给 webview */
  private pushCodeContext(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== "file") {
      if (this.codeCtx) {
        this.codeCtx = null;
        this.post({ type: "codeCtx", ctx: null });
      }
      return;
    }
    const doc = ed.document;
    const wsRoot = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
    const rel = wsRoot
      ? path.relative(wsRoot, doc.fileName).replace(/\\/g, "/")
      : path.basename(doc.fileName);
    const sel = ed.selection;
    let text: string;
    let range: string;
    if (sel.isEmpty) {
      // 点了空白处，无选区 → 带整个文件（太大则放弃）
      text = doc.getText();
      if (text.length > 80 * 1024) {
        this.codeCtx = null;
        this.post({ type: "codeCtx", ctx: null });
        return;
      }
      range = this.L.wholeFile;
    } else {
      const s = Math.min(sel.start.line, sel.end.line) + 1;
      const e = Math.max(sel.start.line, sel.end.line) + 1;
      text = doc.getText(new vscode.Range(sel.start, sel.end));
      range = s === e ? "L" + s : "L" + s + "-L" + e;
    }
    this.codeCtx = { name: path.basename(doc.fileName), rel, range, text };
    this.post({
      type: "codeCtx",
      ctx: { name: this.codeCtx.name, rel: this.codeCtx.rel, range, lines: text.split("\n").length },
    });
  }

  /** 启动恢复闸门：按项目恢复上次会话期间，webviewReady 的重绘等它完成，
   * 避免先画出 -c 恢复的会话再跳到记住的会话（「闪一下 + 标题/内容对不上」的根源） */
  private restoringSession: Promise<void> | null = null;

  /** 首次发消息时才启动 pi 后台进程；forceSession=true 时不用 --no-session（如切换历史会话） */
  private ensureClient(forceSession = false): PiClient {
    if (this.client) return this.client;

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const cfg = vscode.workspace.getConfiguration("piChat");
    // ⚠ 会话模式读取：默认必须与 package.json 里的 default 保持一致（continue）。
    // 教训：曾默认 ephemeral(--no-session)，用户聊天全程不落盘，进程被替换后记录永久丢失。
    const mode = cfg.get<string>("sessionMode", "continue");
    const ephemeral = mode === "ephemeral" && !forceSession;
    const args = ephemeral ? ["--no-session"] : mode === "continue" ? ["-c"] : [];
    const sessionDir = cfg.get<string>("sessionDir", "");
    if (sessionDir) args.push("--session-dir", sessionDir);
    this.clientNoSession = ephemeral;

    const client = new PiClient();
    this.client = client;

    client.onUiRequest = (req) => void this.handleUiRequest(req);
    client.onExit = (code, detail) => {
      this.busy = false;
      this.post({ type: "busy", value: false });
      this.post({ type: "status", text: this.L.piExitedPre + code + this.L.piExitedSuf + (detail ? this.L.seeNotify : "") });
      // 下一条消息前会自动重启 pi；把 stderr 尾巴透出，崩溃原因不再靠猜
      if (detail) this.post({ type: "notice", text: this.L.piExitedNotice + code + this.L.piExitedSuf + String.fromCharCode(10) + detail });
    };
    client.onError = (err) => {
      this.post({ type: "notice", text: this.L.startFail + err.message });
      void vscode.window
        .showErrorMessage(this.L.piStartFail + err.message, this.L.installPiBtn)
        .then((pick) => {
          if (pick === this.L.installPiBtn) void this.installPi();
        });
    };
    client.events.on("event", (e: PiEvent) => void this.onPiEvent(e));

    this.post({ type: "status", text: this.L.startingPi });
    // 公司网络下模型接口需要走代理：pi 子进程不会继承 shell 里的代理变量，
    // 这里把 VSCode 内置 http.proxy 设置透传给 pi（HTTP_PROXY/HTTPS_PROXY）
    const proxyUrl = vscode.workspace.getConfiguration("http").get<string>("proxy", "").trim();
    client.start(cwd, args, proxyUrl || undefined);

    // 插话送达方式（默认逐条，CC 风格：排队消息一条条处理）
    const steerMode = cfg.get<string>("steeringMode", "one-at-a-time");
    // 模型请求失败自动重试（默认开启，Z.ai 免费档超时/过载常见）
    const autoRetry = cfg.get<boolean>("autoRetry", true);
    void (async () => {
      try {
        await client.setSteeringMode(steerMode as "all" | "one-at-a-time");
        await client.setAutoRetry(autoRetry);
      } catch {
        // 应用失败不影响使用
      }
    })();

    // 恢复上次使用的模型 / 思考等级（跨窗口、跨重启记忆）
    const lastModel = this.globalState.get<{ provider: string; id: string } | undefined>(
      "piChat.lastModel"
    );
    const lastThinking = this.globalState.get<string | undefined>("piChat.lastThinking");
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

  private async onWebviewMessage(m: WebviewToHost): Promise<void> {
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
          } catch {
            // ignore
          }
          await this.refreshState();
        })();
        break;
      }
      case "prompt": {
        // pi 的 TUI 内置命令（/login /settings 等）在 RPC 模式下不会执行，只会被当成普通消息——拦截并给出正确入口
        const tuiCmds: Record<string, { text?: string; run?: () => Promise<void> }> = {
          "/login": { run: async () => this.openTerminalLogin() },
          "/settings": { text: this.L.tuiSettings },
          "/hotkeys": { text: this.L.tuiHotkeys },
          "/theme": { text: this.L.tuiTheme },
          "/help": { text: this.L.tuiHelp },
          "/resume": { text: this.L.tuiResume },
          "/model": { text: this.L.tuiModel },
          "/thinking": { text: this.L.tuiThinking },
          "/tree": { run: () => this.forkToMessage() },
          "/import": { run: () => this.importSession() },
          "/share": { run: () => this.shareSession() },
          "/copy": { text: this.L.tuiCopy },
          "/quit": { text: this.L.tuiQuit },
        };
        const trimmed = String(m.text ?? "").trim().toLowerCase();
        if (tuiCmds[trimmed]) {
          const entry = tuiCmds[trimmed];
          if (entry.text) this.post({ type: "notice", text: entry.text });
          if (entry.run) void entry.run();
          break;
        }
        const client = this.ensureClient();
        this.dbg("prompt: images=" + (m.images ? m.images.length : 0) + " files=" + (m.files ? m.files.length : 0) + " busy=" + this.busy);
        let text = m.text;
        const codeInfo = m.attachCode && this.codeCtx ? this.codeCtx.name + " " + this.codeCtx.range : undefined;
        // 附件文件（顶部胶囊行，可多个）→ 拼进消息文本
        if (Array.isArray(m.files) && m.files.length) {
          for (const f of m.files) {
            if (f && typeof f.text === "string" && f.text.length) {
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
        this.post({ type: "busy", value: true });
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
        try {
          try {
            await client.prompt(text, wasBusy, m.images);
          } catch (e: any) {
            // busy 标志与 pi 真实状态错位时（如 agent_start 晚于 4s 兜底，busy 已被清），
            // pi 会拒收不带 streamingBehavior 的 prompt → 自动转 steer 重发，消息照常排队
            const msg = String(e?.message ?? e);
            if (!/already processing|streamingBehavior/i.test(msg)) throw e;
            this.post({ type: "notice", text: this.L.autoQueued });
            await client.prompt(text, true, m.images);
          }
          // 新会话首条真实文字消息 → 自动命名会话（CC 风格，历史列表/头部都能显示标题）
          if (!wasBusy && m.text) void this.autoTitleSession(m.text);
          // 命令式应答（如 /llama）不触发 agent_start/agent_settled，乐观置位的 busy 会永远卡住：
          // 若 4s 后仍未等到 agent_start 则兑底清除（真跑起来的话 agent_start 会先置 pendingPrompt=false）
          if (!wasBusy) {
            this.pendingPrompt = true;
            setTimeout(() => {
              if (this.busy && this.pendingPrompt) {
                this.pendingPrompt = false;
                this.busy = false;
                this.post({ type: "busy", value: false });
              }
            }, 4000);
          }
        } catch (err: any) {
          this.busy = false;
          this.post({ type: "busy", value: false });
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
        await this.pickSession("project");
        break;
      case "treeFork":
        await this.forkToMessage();
        break;
      case "importSession":
        await this.importSession();
        break;
      case "shareSession":
        await this.shareSession();
        break;
      case "newSession":
        await this.newSession();
        break;
      case "uploadImage":
        await this.pickLocalFiles();
        break;
      case "attachFile":
        // 非图片文件 → 顶部附件行胶囊（与拖拽/粘贴/上传同一模型）
        if (typeof m.text === "string" && m.text.length) {
          this.post({ type: "addFiles", files: [{ name: String(m.name || "file"), text: m.text }] });
        }
        break;
      case "pickMode":
        await this.pickModeMenu();
        break;
      case "getSlash":
        await this.sendSlashCommands();
        break;
      case "openSession":
        await this.openSessionFile(m.file);
        break;
      case "revealSessionFile":
        try {
          const sdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file));
          await vscode.window.showTextDocument(sdoc.uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        } catch (err: any) {
          this.post({ type: "notice", text: this.L.openSessionFileFail + (err?.message ?? err) });
        }
        break;
      case "openPath":
        await this.openFilePath(m.path);
        break;
      case "deleteSession":
        try {
          fs.rmSync(m.file, { force: true });
        } catch {
          // ignore
        }
        break;
      case "getFiles":
        await this.sendWorkspaceFiles();
        break;
      case "more":
        await this.runCommand();
        break;
      case "settings":
        await this.settingsMenu();
        break;
      case "pickModel":
        await this.pickModel();
        break;
      case "pickThinking":
        await this.pickThinking();
        break;
      case "pickTheme":
        await this.pickTheme();
        break;
      case "pickLang":
        await this.toggleLang();
        break;
    }
  }

  /** 中/EN 语言切换：持久化后重生成 HTML（webviewReady 握手会自动重绘历史） */
  private async toggleLang(): Promise<void> {
    this.lang = this.lang === "zh" ? "en" : "zh";
    await this.globalState.update("piChat.lang", this.lang);
    this.applyHtml();
  }

  /** 🎨 主题/背景选择，持久化 globalState，重载后自动应用 */
  private async pickTheme(): Promise<void> {
    const themes = [
      { id: "midnight", label: this.L.themeMidnight },
      { id: "auto", label: this.L.themeAuto },
      { id: "cc-dark", label: this.L.themeCcDark },
    ];
    const cur = this.globalState.get<string>("piChat.theme") ?? "midnight";
    const pick = await vscode.window.showQuickPick(
      themes.map((t) => ({
        label: t.label,
        description: t.id === cur ? this.L.themeCurrent : "",
        id: t.id,
      })),
      { placeHolder: this.L.themePicker }
    );
    if (!pick) return;
    await this.globalState.update("piChat.theme", pick.id);
    this.post({ type: "theme", name: pick.id });
    this.post({ type: "notice", text: this.L.themeSet + pick.label });
  }

  private async newSession(): Promise<void> {
    const client = this.ensureClient();
    // 防误触：agent 正在干活时，新会话会终止当前任务，先确认
    if (this.busy) {
      const pick = await vscode.window.showWarningMessage(
        this.L.nsConfirm,
        { modal: true },
        this.L.nsAbortAndNew,
        this.L.cancel
      );
      if (pick !== this.L.nsAbortAndNew) return;
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
      const lastModel = this.globalState.get<{ provider: string; id: string } | undefined>(
        "piChat.lastModel"
      );
      const lastThinking = this.globalState.get<string | undefined>("piChat.lastThinking");
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

  /**
   * 弹出历史会话选择。
   * scope="project" 只显示当前工作空间的会话；"all" 显示全部；"auto"=项目会话+浏览全部入口（面板打开时用）。
   */
  private async pickSession(scope: "project" | "all" | "auto" = "project"): Promise<void> {
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // ephemeral 进程没挂会话文件，需要重启为持久模式才能恢复历史
    if (this.client?.running && this.clientNoSession) {
      this.client.dispose();
      this.client = undefined;
      this.post({ type: "status", text: this.L.restartingPi });
    }

    const sessions = scope === "all" ? listSessions() : listSessions(wsPath);

    // 注意：不能用 kind 作字段名，会和 QuickPickItem 内置的 QuickPickItemKind 枚举冲突
    type Item = {
      label: string;
      description?: string;
      detail?: string;
      action: "file" | "new" | "all";
      file?: string;
    };
    const items: Item[] = [];
    if (scope !== "all") {
      items.push({ label: this.L.startNewSession, action: "new" });
      if (scope === "auto") {
        items.push({ label: this.L.browseAllSessions, action: "all" });
      }
    }
    for (const s of sessions) {
      items.push({
        label: "$(history) " + (s.name || s.preview || path.basename(s.file)),
        description: s.cwd || undefined,
        detail: s.time + "  ·  " + s.file,
        action: "file",
        file: s.file,
      });
    }
    if (!items.length) {
      this.post({ type: "notice", text: this.L.noSessions });
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder:
        scope === "all"
          ? this.L.pickSessionAll
          : this.L.pickSessionProj,
    });
    if (!pick) return; // 用户取消 → 保持现状，首次输入消息时再启动 pi

    const client = this.ensureClient(true);
    try {
      if (pick.action === "new") {
        this.post({ type: "render", messages: [] });
      } else if (pick.action === "all") {
        void this.pickSession("all");
        return;
      } else if (pick.file) {
        const r = await client.switchSession(pick.file);
        if (r?.cancelled) {
          this.post({ type: "notice", text: this.L.switchCancelled });
          return;
        }
        const d = await client.getMessages();
        this.post({ type: "render", messages: d?.messages ?? [] });
        const name = (pick.label ?? "").replace(/^\$\(history\) /, "");
        this.post({ type: "notice", text: this.L.sessionRestored + name });
      }
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.sessionOpFail + (err?.message ?? err) });
    }
  }

  /** 从电脑选择图片/文件 → 图片转 base64 塞进附件栏，其他文件读成文本注入上下文（/ 菜单「上传文件」用） */
  private async pickLocalFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { [this.L.allFiles]: ["*"] },
    });
    if (!uris?.length) return;
    const images: any[] = [];
    const imgExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
    const textFiles: { name: string; text: string }[] = [];
    for (const uri of uris) {
      try {
        const ext = path.extname(uri.fsPath).toLowerCase();
        if (imgExts.includes(ext)) {
          const data = fs.readFileSync(uri.fsPath).toString("base64");
          const mime =
            ext === ".png" ? "image/png" :
            ext === ".gif" ? "image/gif" :
            ext === ".webp" ? "image/webp" :
            ext === ".bmp" ? "image/bmp" : "image/jpeg";
          images.push({
            data,
            mimeType: mime,
            name: path.basename(uri.fsPath),
          });
        } else if (textFiles.length < 5) {
          // 非图片 → 读成文本，作为顶部附件行胶囊（最多 5 个，单个超 200KB 跳过）
          const stat = fs.statSync(uri.fsPath);
          if (stat.size > 200 * 1024) {
            this.post({ type: "notice", text: this.L.fileTooBigI + path.basename(uri.fsPath) });
            continue;
          }
          textFiles.push({ name: path.basename(uri.fsPath), text: fs.readFileSync(uri.fsPath, "utf8") });
        }
      } catch {
        // ignore
      }
    }
    if (images.length) this.post({ type: "addImages", images });
    if (textFiles.length) this.post({ type: "addFiles", files: textFiles });
  }

  /** 点击状态栏模式徽标 → 弹出权限模式选择（直接写 mode.json，pi 扩展在下次工具调用时生效） */
  private async pickModeMenu(): Promise<void> {
    const modeFile = path.join(os.homedir(), ".pi", "agent", "mode.json");
    let cur = "auto";
    try {
      cur = JSON.parse(fs.readFileSync(modeFile, "utf8")).mode ?? "auto";
    } catch {
      // ignore
    }
    const modes = [
      { id: "manual", label: this.L.modeManual, detail: this.L.modeManualDetail },
      { id: "edit-auto", label: this.L.modeEditAuto, detail: this.L.modeEditAutoDetail },
      { id: "plan", label: this.L.modePlan, detail: this.L.modePlanDetail },
      { id: "auto", label: this.L.modeAuto, detail: this.L.modeAutoDetail },
    ];
    const pick = await vscode.window.showQuickPick(
      modes.map((m) => ({
        label: m.label,
        description: m.id === cur ? this.L.themeCurrent : "",
        detail: m.detail,
        id: m.id,
      })),
      { placeHolder: this.L.modePicker }
    );
    if (!pick) return;
    try {
      fs.mkdirSync(path.dirname(modeFile), { recursive: true });
      fs.writeFileSync(modeFile, JSON.stringify({ mode: pick.id }, null, 2) + "\n", "utf8");
      const badge = pick.label.replace(/^\$\([^)]+\) /, "");
      this.lastModeText = badge;
      this.post({ type: "mode", text: badge });
      this.post({ type: "notice", text: this.L.modeSet + pick.label.replace(/^\$\([^)]*\) /, "") });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.modeSaveFail + (err?.message ?? err) });
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
    const ext = cmds.map((c: any) => ({
      group: this.L.grpCmds,
      label: "/" + c.name,
      description: c.description || c.source || "",
      name: c.name,
    }));
    this.post({ type: "slashList", commands: [...builtin, ...ext] });
  }

  /** 给 webview 提供工作区文件列表（相对路径 + 所在目录），供 @ 补全 */
  private async sendWorkspaceFiles(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
      this.client.dispose();
      this.client = undefined;
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

  /** /login 是 pi 终端内置命令，RPC 模式不可用 → 打开集成终端跑交互式 pi 完成 OAuth */
  private openTerminalLogin(): void {
    const term = vscode.window.createTerminal({ name: this.L.loginTermName });
    term.show();
    term.sendText("pi");
    this.post({
      type: "notice",
      text: this.L.loginNotice,
    });
  }

  /** 点击聊天里出现的文件路径 → 在编辑器打开（支持 path:line，相对路径按工作区解析） */
  private async openFilePath(raw: string): Promise<void> {
    if (!raw) return;
    // 剩尾 :行号（或 :行:列）
    const mm = raw.match(/^(.*?)(?::(\d{1,5})(?::(\d{1,5}))?)?$/);
    let p = mm ? mm[1] : raw;
    const line = mm && mm[2] ? parseInt(mm[2], 10) : undefined;
    const col = mm && mm[3] ? parseInt(mm[3], 10) : undefined;
    if (!p || /^[a-z]+:\/\//i.test(p)) return; // http(s):// 等非文件开头不处理
    // 解析为绝对路径：相对路径依次尝试各工作区文件夹
    let resolved: string | undefined;
    const candidates = [p];
    if (!path.isAbsolute(p)) {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(path.join(f.uri.fsPath, p));
      }
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) { resolved = c; break; }
      } catch { /* ignore */ }
    }
    // 直接路径没找到 → 全工作区按文件名搜（兜底光文件名/深层相对路径）
    if (!resolved) {
      try {
        const hits = await vscode.workspace.findFiles("**/" + path.basename(p), "**/node_modules/**", 2);
        if (hits.length) resolved = hits[0].fsPath;
      } catch { /* ignore */ }
    }
    if (!resolved) {
      this.post({ type: "notice", text: this.L.fileNotFound + raw });
      return;
    }
    // 二进制文件开了也是报错页，直接提示
    if (/\.(vsix|zip|exe|dll|jar|7z|tar|gz|rar|bin|iso|class|pyc|woff2?|ttf|eot)$/i.test(resolved)) {
      this.post({ type: "notice", text: this.L.binaryFile + path.basename(resolved) });
      return;
    }
    // 图片/PDF 等二进制但 VS Code 自带预览器的文件 → vscode.open（和 VSC 直接点开图片一致）
    if (/\.(png|jpe?g|gif|webp|bmp|ico|avif|svg|pdf)$/i.test(resolved)) {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(resolved), {
        viewColumn: this.bestViewColumn(),
        preview: true,
      });
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
      let sel: vscode.Range | undefined;
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), col ? col - 1 : 0);
        sel = new vscode.Range(pos, pos);
      }
    // 打开在「用户正在用的那一列」：优先活动编辑器组，否则第一组——不另起新栏
    // （不用 ViewColumn.Active：焦点在侧边栏 webview 时它有歧义，实测仍可能新分一栏）
    const openCol = this.bestViewColumn();
    await vscode.window.showTextDocument(doc.uri, {
      viewColumn: openCol,
      preview: true,
      selection: sel,
    });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.openFail + (err?.message ?? err) });
    }
  }

  // 目标编辑器列：优先活动编辑器组，否则第一组
  private bestViewColumn(): vscode.ViewColumn {
    const tgs = vscode.window.tabGroups.all;
    const act = tgs.find((g) => g.isActive) ?? tgs[0];
    return act ? act.viewColumn : vscode.ViewColumn.One;
  }

  /** ⚡ 命令菜单：对应 pi 命令行里的各种操作指令 */
  private async runCommand(): Promise<void> {
    if (this.client?.running && this.clientNoSession) {
      this.client.dispose();
      this.client = undefined;
    }
    const client = this.ensureClient(true);
    this.post({ type: "status", text: "" });

    type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
    const items: Item[] = [
      {
        label: this.L.cmdRename,
        run: async () => {
          const name = await vscode.window.showInputBox({
            prompt: this.L.renamePrompt,
            value: "",
          });
          if (name === undefined || name === "") return;
          await client.setSessionName(name);
          this.post({ type: "notice", text: this.L.renamed + name });
        },
      },
      {
        label: this.L.cmdCompact,
        run: async () => {
          const inst = await vscode.window.showInputBox({
            prompt: this.L.compactPrompt,
          });
          if (inst === undefined) return;
          this.post({ type: "status", text: this.L.compacting });
          const r = await client.compact(inst || undefined);
          this.post({ type: "status", text: "" });
          this.post({
            type: "notice",
            text: r?.result
              ? this.L.compactDone + (r.result.tokensBefore ?? "?") + " → ≈ " + (r.result.estimatedTokensAfter ?? "?") + " tokens"
              : this.L.compactEnded,
          });
        },
      },
      {
        label: this.L.cmdClearQueue,
        run: async () => {
          const r = await client.clearQueue();
          const all = [...(r?.steering ?? []), ...(r?.followUp ?? [])];
          this.post({ type: "notice", text: all.length ? this.L.queueCleared + all.join(" / ") : this.L.queueEmpty });
        },
      },
      {
        label: this.L.cmdExport,
        run: async () => {
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(os.homedir(), "Desktop", "pi-session.html")),
            filters: { HTML: ["html"] },
          });
          if (!target) return;
          const r = await client.exportHtml(target.fsPath);
          if (r?.path) {
            void vscode.env.openExternal(vscode.Uri.file(r.path));
            this.post({ type: "notice", text: this.L.exported + r.path });
          }
        },
      },
      {
        label: this.L.cmdFork,
        run: async () => {
          await this.forkToMessage();
        },
      },
      {
        label: this.L.cmdClone,
        run: async () => {
          const r = await client.clone();
          if (r?.cancelled) return;
          this.post({ type: "notice", text: this.L.cloned });
        },
      },
      {
        label: this.L.cmdBash,
        run: async () => {
          const cmd = await vscode.window.showInputBox({ prompt: this.L.bashPrompt });
          if (!cmd) return;
          this.post({ type: "notice", text: "$ " + cmd });
          const r = await client.bash(cmd);
          if (r?.output) {
            this.post({ type: "notice", text: this.L.exitCode + (r.exitCode ?? "?") + ": " + String(r.output).slice(0, 200) });
          }
        },
      },
      {
        label: this.L.cmdList,
        run: async () => {
          const d = await client.getCommands();
          const cmds: any[] = d?.commands ?? [];
          if (!cmds.length) {
            this.post({ type: "notice", text: this.L.noSlashCmds });
            return;
          }
          await vscode.window.showQuickPick(
            cmds.map((c) => ({
              label: "/" + c.name,
              description: c.source,
              detail: (c.description ?? "") + (c.path ? "  ·  " + c.path : ""),
            })),
            { placeHolder: this.L.cmdListPh }
          );
        },
      },
    ];

    // 合并设置菜单（分组展示，原 ⚙ 按钮内容全部保留在此）
    items.push({ label: this.L.grpConfig, kind: vscode.QuickPickItemKind.Separator });
    items.push(...(await this.buildSettingsItems(client)));

    const pick = await vscode.window.showQuickPick(items, { placeHolder: this.L.menuPh });
    if (!pick?.run) return;
    try {
      await pick.run();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.opFail + (err?.message ?? err) });
    }
  }

  /** 权限模式徽标文本：优先用 pi 推送过的值，没有则读 mode.json 兑底 */
  private modeBadgeText(): string {
    if (this.lastModeText) return this.lastModeText;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "mode.json"), "utf8")).mode;
      const labels: Record<string, string> = { manual: "Manual", "edit-auto": "Edit automatically", plan: "Plan", auto: "Auto" };
      if (m && labels[m]) return "⚡ " + labels[m];
    } catch {
      // ignore
    }
    return "";
  }

  /** 会话树导航：列出活跃分支上的用户消息，选一条从那里继续（对应 pi TUI 的 /tree，RPC 走 fork） */
  private async forkToMessage(): Promise<void> {
    const client = this.ensureClient(true);
    try {
      const d = await client.getForkMessages();
      const msgs: any[] = d?.messages ?? [];
      if (!msgs.length) {
        this.post({ type: "notice", text: this.L.noForkMsgs });
        return;
      }
      const pick = await vscode.window.showQuickPick(
        msgs.map((m) => ({ label: m.text?.slice(0, 80) ?? "", entryId: m.entryId })),
        { placeHolder: this.L.forkPick }
      );
      if (!pick) return;
      const r = await client.fork(pick.entryId);
      if (r?.cancelled) return;
      const md = await client.getMessages();
      this.post({ type: "render", messages: md?.messages ?? [] });
      this.post({ type: "notice", text: this.L.forkedTo + (r?.text ?? "").slice(0, 50) });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.opFail + (err?.message ?? err) });
    }
  }

  /** 导入 .jsonl 会话文件并恢复继续（对应 pi TUI 的 /import） */
  private async importSession(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { JSONL: ["jsonl"] },
    });
    if (!uris?.length) return;
    const src = uris[0].fsPath;
    if (!/\.jsonl$/i.test(src)) {
      this.post({ type: "notice", text: this.L.importInvalid });
      return;
    }
    if (this.client?.running && this.clientNoSession) {
      this.client.dispose();
      this.client = undefined;
    }
    const client = this.ensureClient(true);
    try {
      const destDir = path.join(os.homedir(), ".pi", "agent", "sessions");
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, "imported-" + Date.now() + "-" + path.basename(src));
      fs.copyFileSync(src, dest);
      const r = await client.switchSession(dest);
      if (r?.cancelled) return;
      const d = await client.getMessages();
      this.post({ type: "render", messages: d?.messages ?? [] });
      this.post({ type: "notice", text: this.L.imported + path.basename(dest) });
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.sessionOpFail + (err?.message ?? err) });
    }
  }

  /** 分享会话：导出 HTML 并在浏览器打开，把文件发给对方即可（GitHub gist 自动分享需终端版 /share） */
  private async shareSession(): Promise<void> {
    const client = this.ensureClient(true);
    try {
      const out = path.join(os.tmpdir(), "pi-session-" + new Date().toISOString().replace(/[:.]/g, "-") + ".html");
      const r = await client.exportHtml(out);
      if (r?.path) {
        void vscode.env.openExternal(vscode.Uri.file(r.path));
        this.post({ type: "notice", text: this.L.shareDone });
      }
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.opFail + (err?.message ?? err) });
    }
  }

  /** ⚙ 设置菜单条目（已合并进 ⚡ 菜单；/ 菜单「pi 设置…」仍单独打开） */
  private async buildSettingsItems(client: PiClient): Promise<(vscode.QuickPickItem & { run?: () => Promise<void> })[]> {
    const st = await client.getState().catch(() => null);
    const cfg = vscode.workspace.getConfiguration("piChat");
    const mode = cfg.get<string>("sessionMode", "continue");
    const sessionDir = cfg.get<string>("sessionDir", "");

    const items: (vscode.QuickPickItem & { run?: () => Promise<void> })[] = [];

    items.push({
      label: this.L.sApiKey,
      run: async () => {
        await this.configApiKey();
      },
    });
    items.push({
      label: this.L.sLogin,
      run: async () => {
        await this.openTerminalLogin();
      },
    });
    items.push({
      label: this.L.sManageAuth,
      run: async () => {
        await this.manageAuth();
      },
    });
    items.push({
      label: this.L.sInstall,
      run: async () => {
        await this.installPi();
      },
    });
    items.push({
      label: this.L.sMode,
      run: async () => {
        // /mode 是扩展命令，立即执行并弹出选择（走 extension_ui_request → QuickPick）
        await client.prompt("/mode");
      },
    });
    items.push({
      label: this.L.sSteering + ": " + (st?.steeringMode === "all" ? this.L.sSteeringAll : this.L.sSteeringOne),
      run: async () => {
        const next = st?.steeringMode === "all" ? "one-at-a-time" : "all";
        await client.setSteeringMode(next);
        // 同步持久化到插件配置，重启 pi 后仍生效
        await vscode.workspace
          .getConfiguration("piChat")
          .update("steeringMode", next, vscode.ConfigurationTarget.Global);
        this.post({ type: "notice", text: this.L.sSteeringSet + (next === "all" ? this.L.sSteeringAll : this.L.sSteeringOne) });
      },
    });
    items.push({
      label: this.L.sFollowUp + ": " + (st?.followUpMode === "all" ? this.L.sSteeringAll : this.L.sSteeringOne),
      run: async () => {
        const next = st?.followUpMode === "all" ? "one-at-a-time" : "all";
        await client.setFollowUpMode(next);
        this.post({ type: "notice", text: this.L.sFollowUpSet + (next === "all" ? this.L.sSteeringAll : this.L.sSteeringOne) });
      },
    });
    items.push({
      label: this.L.sAutoCompact + ": " + ((st?.autoCompactionEnabled ?? true) ? this.L.on : this.L.off),
      run: async () => {
        const next = !(st?.autoCompactionEnabled ?? true);
        await client.setAutoCompaction(next);
        this.post({ type: "notice", text: next ? this.L.sAutoCompactSetOn : this.L.sAutoCompactSetOff });
      },
    });
    items.push({
      label: this.L.sAutoRetry,
      run: async () => {
        const pick2 = await vscode.window.showQuickPick([this.L.on, this.L.off], {
          placeHolder: this.L.sAutoRetryPicker,
        });
        if (!pick2) return;
        await client.setAutoRetry(pick2 === this.L.on);
        this.post({ type: "notice", text: pick2 === this.L.on ? this.L.sAutoRetrySetOn : this.L.sAutoRetrySetOff });
      },
    });
    items.push({
      label: this.L.sSessionMode + ": " + mode,
      run: async () => {
        const pick2 = await vscode.window.showQuickPick(
          [
            { label: this.L.sModeEphemeral, value: "ephemeral" },
            { label: this.L.sModeContinue, value: "continue" },
            { label: this.L.sModeNew, value: "new" },
          ],
          { placeHolder: this.L.sSessionModePh }
        );
        if (!pick2) return;
        await vscode.workspace
          .getConfiguration("piChat")
          .update("sessionMode", pick2.value, vscode.ConfigurationTarget.Global);
        this.post({ type: "notice", text: this.L.sSessionModeSet + pick2.value + this.L.sSessionModeReload });
      },
    });
    items.push({
      label: this.L.sSessionDir + ": " + (sessionDir || this.L.sSessionDirDefault),
      run: async () => {
        const val = await vscode.window.showInputBox({
          prompt: this.L.sSessionDirPrompt,
          value: sessionDir,
        });
        if (val === undefined) return;
        await vscode.workspace
          .getConfiguration("piChat")
          .update("sessionDir", val, vscode.ConfigurationTarget.Global);
        this.post({ type: "notice", text: this.L.sSessionDirSet });
      },
    });
    items.push({
      label: this.L.sOpenCfgDir,
      run: async () => {
        void vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(path.join(os.homedir(), ".pi", "agent"))
        );
      },
    });
    items.push({
      label: this.L.sEditSettings,
      run: async () => {
        const f = vscode.Uri.file(path.join(os.homedir(), ".pi", "agent", "settings.json"));
        try {
          void vscode.window.showTextDocument(await vscode.workspace.openTextDocument(f));
        } catch {
          fs.writeFileSync(f.fsPath, "{}\n", "utf8");
          void vscode.window.showTextDocument(await vscode.workspace.openTextDocument(f));
        }
      },
    });

    return items;
  }

  /** ⚙ 设置菜单（/ 菜单入口用） */
  private async settingsMenu(): Promise<void> {
    if (this.client?.running && this.clientNoSession) {
      this.client.dispose();
      this.client = undefined;
    }
    const client = this.ensureClient(true);
    const items = await this.buildSettingsItems(client);
    const pick = await vscode.window.showQuickPick(items, { placeHolder: this.L.settingsPh });
    if (!pick?.run) return;
    try {
      await pick.run();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.settingsFail + (err?.message ?? err) });
    }
  }

  /** auth.json 里是否已有凭证 */
  private hasAuthConfig(): boolean {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8")
      );
      return Object.keys(data).length > 0;
    } catch {
      return false;
    }
  }

  /** 还没有模型凭证时引导用户去配 key（force=安装完立即弹） */
  private async maybeOfferKeyConfig(force: boolean): Promise<void> {
    if (this.hasAuthConfig()) return;
    if (force) {
      const pick = await vscode.window.showInformationMessage(
        this.L.keyReady,
        this.L.configNow,
        this.L.later
      );
      if (pick === this.L.configNow) await this.configApiKey();
    } else if (!this.authOfferShown) {
      this.authOfferShown = true; // 每次窗口只提醒一次，不反复打扰
      const pick = await vscode.window.showInformationMessage(
        this.L.noAuthDetected,
        this.L.configKeyBtn,
        this.L.loginBtn,
        this.L.later
      );
      if (pick === this.L.configKeyBtn) await this.configApiKey();
      else if (pick === this.L.loginBtn) {
        const c = this.ensureClient();
        this.post({ type: "user", text: "/login" });
        await c.prompt("/login");
      }
    }
  }

  /** 检测 pi 是否可用，返回版本号字符串，不可用返回 null。
   *  10s 超时杀掉子进程兑底，防 pi --version 挂起时 Promise 永不 resolve */
  private piVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const p = spawn("pi", ["--version"], {
        shell: process.platform === "win32",
        windowsHide: true,
      });
      let out = "";
      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          // ignore
        }
        finish(null);
      }, 10000);
      p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      p.on("error", () => finish(null));
      p.on("close", (code) => finish(code === 0 ? out.trim().split("\n")[0] || "ok" : null));
    });
  }

  /** 一键安装/更新 pi（npm 全局装），进度与结果显示在面板 */
  private async installPi(): Promise<void> {
    this.post({ type: "status", text: this.L.installing });
    this.post({ type: "notice", text: "📦 npm install -g @earendil-works/pi-coding-agent…" });
    const proc = spawn("npm", ["install", "-g", "@earendil-works/pi-coding-agent"], {
      shell: true,
      windowsHide: true,
    });
    let tail = "";
    const onOut = (d: Buffer) => (tail = (tail + d.toString()).slice(-300));
    proc.stdout?.on("data", onOut);
    proc.stderr?.on("data", onOut);
    proc.on("error", () => {
      this.post({ type: "status", text: "" });
      void vscode.window.showErrorMessage(
        this.L.npmMissing
      );
    });
    proc.on("close", (code) => {
      this.post({ type: "status", text: "" });
      if (code === 0) {
        this.post({ type: "notice", text: this.L.installDone });
        // 装完后（重新）拉起客户端；还没有凭证则直接弹 key 配置
        if (!this.client?.running) this.client = undefined;
        const c = this.ensureClient();
        void c;
        void this.maybeOfferKeyConfig(true);
      } else {
        void vscode.window.showErrorMessage(this.L.installFail + tail.slice(-200));
      }
    });
  }

  /** 配置模型 API key：写入 ~/.pi/agent/auth.json（与 pi 的 /login 存储格式一致） */
  private async configApiKey(): Promise<void> {
    const providers = [
      { id: "zai", label: this.L.providerZai },
      { id: "zai-coding-cn", label: this.L.providerZaiCn },
      { id: "openrouter", label: "OpenRouter" },
      { id: "anthropic", label: "Anthropic" },
      { id: "openai", label: "OpenAI" },
      { id: "deepseek", label: "DeepSeek" },
      { id: "google", label: "Google Gemini" },
      { id: "kimi-coding", label: "Kimi For Coding" },
      { id: "qwen-token-plan-cn", label: this.L.providerQwen },
      { id: "xiaomi", label: this.L.providerXiaomi },
    ];
    const pick = await vscode.window.showQuickPick(
      providers.map((p) => ({ label: p.label, description: p.id, id: p.id })),
      { placeHolder: this.L.pickProvider }
    );
    if (!pick) return;
    const key = await vscode.window.showInputBox({
      prompt: this.L.enterKey,
      password: true,
    });
    if (!key) return;
    const file = path.join(os.homedir(), ".pi", "agent", "auth.json");
    let data: any = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // 文件不存在/损坏 → 新建
    }
    data[pick.id] = { type: "api_key", key };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
      this.post({ type: "notice", text: this.L.keySaved + pick.label });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.saveFail + (err?.message ?? err) });
    }
  }

  /** 查看/删除已保存的凭证（auth.json） */
  private async manageAuth(): Promise<void> {
    const file = path.join(os.homedir(), ".pi", "agent", "auth.json");
    let data: any = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.post({ type: "notice", text: this.L.noAuth });
      return;
    }
    const ids = Object.keys(data);
    if (!ids.length) {
      this.post({ type: "notice", text: this.L.noAuth });
      return;
    }
    const pick = await vscode.window.showQuickPick(
      ids.map((id) => ({
        label: id,
        description: data[id]?.type ?? "",
        detail: this.L.authDetail,
        id,
      })),
      { placeHolder: this.L.authPicker }
    );
    if (!pick) return;
    const yes = await vscode.window.showWarningMessage(
      this.L.delAuthAsk,
      { modal: true },
      this.L.delete
    );
    if (yes !== this.L.delete) return;
    delete data[pick.id];
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
      this.post({ type: "notice", text: this.L.deleted + pick.id });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.delFail + (err?.message ?? err) });
    }
  }

  private async pickModel(): Promise<void> {
    const client = this.ensureClient();
    let models: any[] = [];
    try {
      models = (await client.getAvailableModels())?.models ?? [];
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.modelListFail + (err?.message ?? err) });
      return;
    }
    if (!models.length) {
      this.post({ type: "notice", text: this.L.noModels });
      return;
    }
    const items = models.map((m) => ({
      label: m.name ?? m.id,
      description: m.provider + "/" + m.id,
      detail: this.L.ctx + (m.contextWindow ?? "?"),
      model: m,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: this.L.modelPicker,
    });
    if (!pick) return;
    try {
      await client.setModel(pick.model.provider, pick.model.id);
      void this.globalState.update("piChat.lastModel", {
        provider: pick.model.provider,
        id: pick.model.id,
      });
      this.post({ type: "notice", text: this.L.modelSet + pick.label });
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.switchFail + (err?.message ?? err) });
    }
  }

  private async pickThinking(): Promise<void> {
    const client = this.ensureClient();
    let levels: string[] = [];
    try {
      levels = (await client.getAvailableThinkingLevels())?.levels ?? [];
    } catch {
      return;
    }
    if (!levels.length) {
      this.post({ type: "notice", text: this.L.noThinking });
      return;
    }
    const pick = await vscode.window.showQuickPick(levels, {
      placeHolder: this.L.thinkingPicker,
    });
    if (!pick) return;
    try {
      await client.setThinkingLevel(pick);
      void this.globalState.update("piChat.lastThinking", pick);
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.setFail + (err?.message ?? err) });
    }
  }

  /** 扩展的 UI 请求 → VS Code 原生对话框 */
  private async handleUiRequest(req: any): Promise<void> {
    const client = this.client;
    if (!client) return;
    const respond = (resp: Record<string, unknown>) =>
      client.respondUi({ type: "extension_ui_response", id: req.id, ...resp });
    try {
      switch (req.method) {
        case "select": {
          const pick = await vscode.window.showQuickPick(req.options ?? [], {
            placeHolder: req.title ?? this.L.pleaseSelect,
          });
          if (pick === undefined) respond({ cancelled: true });
          else respond({ value: pick });
          break;
        }
        case "confirm": {
          const sel = await vscode.window.showWarningMessage(
            req.title ?? this.L.confirm,
            { modal: true, detail: req.message ?? "" },
            this.L.confirm,
            this.L.cancel
          );
          if (sel === undefined) respond({ cancelled: true });
          else respond({ confirmed: sel === this.L.confirm });
          break;
        }
        case "input":
        case "editor": {
          // editor（多行编辑）降级为单行输入框
          const val = await vscode.window.showInputBox({
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

  /** 读取当前项目对应的“上次会话”（全局 Map：工作区路径 → 会话文件） */
  private getSessionForWs(cwd: string): string | undefined {
    const map = this.globalState.get<Record<string, string>>("piChat.lastSessionByWs") ?? {};
    const key = cwd.replace(/\\+$/, "").toLowerCase();
    return map[key];
  }

  /** 写入当前项目对应的“上次会话” */
  private setSessionForWs(file: string): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    const map = this.globalState.get<Record<string, string>>("piChat.lastSessionByWs") ?? {};
    map[cwd.replace(/\\+$/, "").toLowerCase()] = file;
    void this.globalState.update("piChat.lastSessionByWs", map);
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

  /** 拉取当前模型/思考等级/token 用量并更新头部状态栏 */
  private async refreshState(): Promise<void> {
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
      // 按项目记住当前会话文件，下次启动自动恢复（切走/重启不用重选会话）
      if (st?.sessionFile) this.setSessionForWs(st.sessionFile);
      this.lastSessionName = st?.sessionName ?? null;
      this.lastSessionFile = st?.sessionFile ?? null;
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
  private syncRenderKeepQueued(): void {
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
    switch (e.type) {
      case "agent_start":
        this.busy = true;
        this.pendingPrompt = false;
        // 空闲时的 abort 会遗留 skipRender 标记，新运行开始时清掉，避免吞掉下次 settled 重绘
        this.abortSkipRender = false;
        this.post({ type: "busy", value: true });
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
        this.post({
          type: "toolStart",
          id: e.toolCallId,
          name: e.toolName,
          detail: toolDetail(e.args),
        });
        break;

      case "tool_execution_end": {
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
        this.post({ type: "busy", value: false });
        this.lastQueueTotal = 0;
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

interface SessionInfo {
  file: string;
  name?: string;
  cwd: string;
  preview: string;
  mtime: number;
  time: string;
}

/** 路径相等判断（忽略大小写和分隔符差异，Windows 友好） */
function samePath(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) =>
    p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** 递归收集目录下所有 .jsonl 文件 */
function collectJsonlFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectJsonlFiles(full, out);
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** 列出 ~/.pi/agent/sessions 下的历史会话，按最近使用排序；传入 cwd 则只保留属于该项目的会话 */
function listSessions(cwd?: string, limit = 50): SessionInfo[] {
  const root = path.join(os.homedir(), ".pi", "agent", "sessions");
  const files = collectJsonlFiles(root);
  const result: SessionInfo[] = [];
  for (const file of files) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const meta = readSessionMeta(file);
    if (cwd && !samePath(meta.cwd, cwd)) continue;
    result.push({
      file,
      mtime,
      time: new Date(mtime).toLocaleString(),
      cwd: meta.cwd ?? "",
      preview: meta.preview ?? "",
      name: meta.name,
    });
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result.slice(0, limit);
}

/** 读取会话 JSONL 开头：会话名、工作目录、首条用户消息预览（只读文件头部，不解析全部） */
function readSessionMeta(file: string): { name?: string; cwd?: string; preview?: string } {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let name: string | undefined;
    let cwd: string | undefined;
    let preview: string | undefined;
    for (const line of buf.toString("utf8", 0, bytes).split("\n")) {
      if (!line.trim()) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
      if (!name && (typeof e.name === "string" || typeof e.sessionName === "string")) {
        name = (e.name ?? e.sessionName) as string;
      }
      const msg = e.message && e.message.role ? e.message : e.role ? e : null;
      if (!preview && msg?.role === "user") {
        let t = extractText(msg.content);
        if (t) {
          // 纯代码上下文消息（历史 bug 时期写入）：剥离前缀和代码围栏，只留真实文字
          const mm = t.match(/^---\s*代码上下文[^\n]*\n```[\s\S]*?```\n\n?([\s\S]*)$/);
          if (mm) t = mm[1];
          else if (t.trimStart().startsWith("---")) t = ""; // 纯上下文无正文，不合适当标题
          t = t.replace(/\s+/g, " ").trim();
          if (t && !["请看这段代码", "请看这张图片", "Please look at this code", "Please look at this image"].includes(t)) preview = t.slice(0, 60);
        }
      }
      if (preview && cwd) break;
    }
    return { name, cwd, preview };
  } catch {
    return {};
  }
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  let out = "";
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === "text" && c.text) out += c.text;
    }
  }
  return out;
}

