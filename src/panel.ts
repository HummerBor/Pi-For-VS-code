import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PiClient } from "./piClient";

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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
    private readonly version: string
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // retainContextWhenHidden：切到其他侧边栏时保活 webview，回来不重建、不丢会话
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(
      this.globalState.get<string>("piChat.theme") ?? "auto"
    );
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
              "未检测到 pi coding agent，面板需要它才能工作",
              "一键安装 pi",
              "打开 nodejs.org"
            );
            if (pick === "一键安装 pi") await this.installPi();
            else if (pick === "打开 nodejs.org")
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

  private post(msg: any): void {
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
      range = "整个文件";
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

  /** 首次发消息时才启动 pi 后台进程；forceSession=true 时不用 --no-session（如切换历史会话） */
  private ensureClient(forceSession = false): PiClient {
    if (this.client) return this.client;

    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const cfg = vscode.workspace.getConfiguration("piChat");
    const mode = cfg.get<string>("sessionMode", "ephemeral");
    const ephemeral = mode === "ephemeral" && !forceSession;
    const args = ephemeral ? ["--no-session"] : mode === "continue" ? ["-c"] : [];
    const sessionDir = cfg.get<string>("sessionDir", "");
    if (sessionDir) args.push("--session-dir", sessionDir);
    this.clientNoSession = ephemeral;

    const client = new PiClient();
    this.client = client;

    client.onUiRequest = (req) => void this.handleUiRequest(req);
    client.onExit = (code) => {
      this.busy = false;
      this.post({ type: "busy", value: false });
      this.post({ type: "status", text: "pi 进程已退出 (code " + code + ")" });
    };
    client.onError = (err) => {
      this.post({ type: "notice", text: "启动失败: " + err.message });
      void vscode.window
        .showErrorMessage("pi 启动失败: " + err.message, "一键安装 pi")
        .then((pick) => {
          if (pick === "一键安装 pi") void this.installPi();
        });
    };
    client.events.on("event", (e: any) => void this.onPiEvent(e));

    this.post({ type: "status", text: "正在启动 pi…" });
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

    // 初始化状态和已有会话内容：按项目恢复上次使用的会话文件（免重选，且不串项目）
    void this.refreshState();
    void (async () => {
      try {
        const last = this.getSessionForWs(cwd);
        if (last && fs.existsSync(last)) {
          try {
            await client.switchSession(last);
          } catch {
            // 文件失效则退回默认行为
          }
        }
        const d = await client.getMessages();
        this.post({ type: "render", messages: d?.messages ?? [] });
      } catch {
        // 忽略
      }
    })();
    return client;
  }

  private async onWebviewMessage(m: any): Promise<void> {
    switch (m.type) {
      case "prompt": {
        // pi 的 TUI 内置命令（/login /settings 等）在 RPC 模式下不会执行，只会被当成普通消息——拦截并给出正确入口
        const tuiCmds: Record<string, string> = {
          "/login": "订阅登录请点齿轮菜单 → 「订阅登录 (/login)」（会在终端打开 pi 完成授权）",
          "/settings": "pi 终端设置在面板里不可用；面板相关设置在齿轮菜单里",
          "/hotkeys": "/hotkeys 是 pi 终端专属命令，面板不支持",
          "/theme": "/theme 是 pi 终端专属命令；面板主题点头部最后一个按钮切换",
          "/help": "/help 是 pi 终端专属命令；面板用法可看扩展 README",
        };
        const trimmed = String(m.text ?? "").trim().toLowerCase();
        if (tuiCmds[trimmed]) {
          this.post({ type: "notice", text: "ⓘ " + tuiCmds[trimmed] });
          if (trimmed === "/login") this.openTerminalLogin();
          break;
        }
        const client = this.ensureClient();
        let text = m.text;
        const codeInfo = m.attachCode && this.codeCtx ? this.codeCtx.name + " " + this.codeCtx.range : undefined;
        if (m.attachCode && this.codeCtx) {
          const c = this.codeCtx;
          text =
            "--- 代码上下文: " + c.rel + " (" + c.range + ") ---\n```\n" + c.text + "\n```\n\n" + text;
        }
        // 乐观反馈：立刻显示工作状态，不等 agent_start 事件（省掉 1~2s 的无反馈空窗）
        const wasBusy = this.busy;
        this.busy = true;
        this.post({ type: "busy", value: true });
        // 气泡显示实际发送的内容：有文字显示文字；纯代码附带/纯图片时显示对应的占位语（与会话记录一致）
        const displayText = m.text || (codeInfo ? "请看这段代码" : m.images?.length ? "请看这张图片" : m.text);
        // 气泡先行：pi 启动/发送可能要几秒，等 await 完才画会让用户以为消息丢了
        if (wasBusy) {
          // 插队消息：只显示「排队中」气泡，等 queue_update 报告被取走后再转正为正式气泡（避免重复）
          const qid = "q" + Date.now();
          this.queued.push({ qid, sentText: text, text: displayText, imageCount: m.images?.length ?? 0, codeInfo });
          this.post({ type: "queuedAdd", qid, text: displayText, imageCount: m.images?.length ?? 0, codeInfo });
        } else {
          this.post({ type: "user", text: displayText, imageCount: m.images?.length ?? 0, codeInfo });
        }
        try {
          // agent 真的工作中 → steer 排队插话；空闲 → 直接发（不能用乐观置位的 busy，否则会被当成插话变慢）
          await client.prompt(text, wasBusy, m.images);
          // 新会话首条真实文字消息 → 自动命名会话（CC 风格，历史列表/头部都能显示标题）
          if (!wasBusy && m.text) void this.autoTitleSession(m.text);
        } catch (err: any) {
          this.busy = false;
          this.post({ type: "busy", value: false });
          this.post({ type: "notice", text: "发送失败: " + (err?.message ?? err) });
        }
        break;
      }
      case "abort":
        try {
          if (this.client?.running) {
            await this.client.abort();
            // pi 不把中断时的部分内容写进会话文件（content 为空），
            // 下次 agent_settled 的整页重绘会把已显示的思考/工具行抹掉——跳过那一次重绘，保留现场
            this.abortSkipRender = true;
            this.post({ type: "notice", text: "⏹ 已中断当前任务（已发送的消息保留在会话中）" });
          }
        } catch {
          // ignore
        }
        break;
      case "pickSession":
        await this.pickSession("project");
        break;
      case "newSession":
        await this.newSession();
        break;
      case "uploadImage":
        await this.pickLocalFiles();
        break;
      case "attachFile":
        // 上传的非图片文件 → 读成文本注入上下文
        if (typeof m.text === "string" && m.text.length) {
          this.codeCtx = { name: String(m.name || "file"), rel: String(m.name || "file"), range: "文件", text: m.text };
          this.post({ type: "codeCtx", ctx: { name: this.codeCtx.name, rel: this.codeCtx.rel, range: this.codeCtx.range } });
        }
        break;
      case "pickMode":
        await this.pickModeMenu();
        break;
      case "getSlash":
        await this.sendSlashCommands();
        break;
      case "listSessions":
        await this.sendSessionList();
        break;
      case "openSession":
        await this.openSessionFile(m.file);
        break;
      case "revealSessionFile":
        try {
          const sdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file));
          await vscode.window.showTextDocument(sdoc.uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        } catch (err: any) {
          this.post({ type: "notice", text: "打开会话文件失败: " + (err?.message ?? err) });
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
        await this.sendSessionList();
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
    }
  }

  /** 🎨 主题/背景选择，持久化 globalState，重载后自动应用 */
  private async pickTheme(): Promise<void> {
    const themes = [
      { id: "auto", label: "跟随 VS Code" },
      { id: "cc-dark", label: "CC 暗黑（Claude Code 风格）" },
      { id: "midnight", label: "午夜蓝" },
    ];
    const cur = this.globalState.get<string>("piChat.theme") ?? "auto";
    const pick = await vscode.window.showQuickPick(
      themes.map((t) => ({
        label: t.label,
        description: t.id === cur ? "✓ 当前" : "",
        id: t.id,
      })),
      { placeHolder: "面板主题 / 背景" }
    );
    if (!pick) return;
    await this.globalState.update("piChat.theme", pick.id);
    this.post({ type: "theme", name: pick.id });
    this.post({ type: "notice", text: "主题: " + pick.label });
  }

  private async newSession(): Promise<void> {
    const client = this.ensureClient();
    // 防误触：agent 正在干活时，新会话会终止当前任务，先确认
    if (this.busy) {
      const pick = await vscode.window.showWarningMessage(
        "pi 正在工作中，新建会话会终止当前任务，确定？",
        { modal: true },
        "终止并新建",
        "取消"
      );
      if (pick !== "终止并新建") return;
      try {
        await client.abort();
      } catch {
        // ignore
      }
    }
    try {
      const result = await client.newSession();
      if (result?.cancelled) {
        this.post({ type: "notice", text: "新建会话被扩展取消" });
        return;
      }
      this.post({ type: "render", messages: [] });
      this.queued = [];
      this.post({ type: "queuedClear" });
      this.post({ type: "notice", text: "已开始新会话" });
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
      this.post({ type: "notice", text: "新建会话失败: " + (err?.message ?? err) });
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
      this.post({ type: "status", text: "正在以持久模式重启 pi…" });
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
      items.push({ label: "$(add) 开始新会话", action: "new" });
      if (scope === "auto") {
        items.push({ label: "$(folder) 浏览所有项目的会话…", action: "all" });
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
      this.post({ type: "notice", text: "没有找到历史会话（~/.pi/agent/sessions 为空）" });
      return;
    }
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder:
        scope === "all"
          ? "选择要恢复的历史会话（全部项目，按最近使用排序）"
          : "选择当前项目的历史会话继续工作，或开始新会话",
    });
    if (!pick) return; // 用户取消 → 保持现状，首次输入消息时再启动 pi

    const client = this.ensureClient(true);
    try {
      if (pick.action === "new") {
        this.post({ type: "render", messages: [] });
        this.post({ type: "notice", text: "已开始新会话" });
      } else if (pick.action === "all") {
        void this.pickSession("all");
        return;
      } else if (pick.file) {
        const r = await client.switchSession(pick.file);
        if (r?.cancelled) {
          this.post({ type: "notice", text: "切换会话被扩展取消" });
          return;
        }
        const d = await client.getMessages();
        this.post({ type: "render", messages: d?.messages ?? [] });
        const name = (pick.label ?? "").replace(/^\$\(history\) /, "");
        this.post({ type: "notice", text: "已恢复会话: " + name });
      }
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: "会话操作失败: " + (err?.message ?? err) });
    }
  }

  /** 从电脑选择图片/文件 → 图片转 base64 塞进附件栏，其他文件读成文本注入上下文（/ 菜单「上传文件」用） */
  private async pickLocalFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { "所有文件": ["*"] },
    });
    if (!uris?.length) return;
    const images: any[] = [];
    const imgExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
    let ctxAttached = false;
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
        } else if (!ctxAttached) {
          // 非图片 → 读成文本注入上下文（一次一个，超 200KB 跳过）
          const stat = fs.statSync(uri.fsPath);
          if (stat.size > 200 * 1024) {
            this.post({ type: "notice", text: "ⓘ 文件超过 200KB，跳过: " + path.basename(uri.fsPath) });
            continue;
          }
          const text = fs.readFileSync(uri.fsPath, "utf8");
          this.codeCtx = { name: path.basename(uri.fsPath), rel: path.basename(uri.fsPath), range: "文件", text };
          this.post({ type: "codeCtx", ctx: { name: this.codeCtx.name, rel: this.codeCtx.rel, range: this.codeCtx.range } });
          ctxAttached = true;
        }
      } catch {
        // ignore
      }
    }
    if (images.length) this.post({ type: "addImages", images });
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
      { id: "manual", label: "$(pencil) Manual", detail: "每次编辑/命令前确认" },
      { id: "edit-auto", label: "$(edit) Edit automatically", detail: "编辑自动，危险命令需确认" },
      { id: "plan", label: "$(file-text) Plan", detail: "只读：禁止修改文件" },
      { id: "auto", label: "$(zap) Auto", detail: "全部自动批准" },
    ];
    const pick = await vscode.window.showQuickPick(
      modes.map((m) => ({
        label: m.label,
        description: m.id === cur ? "✓ 当前" : "",
        detail: m.detail,
        id: m.id,
      })),
      { placeHolder: "权限模式" }
    );
    if (!pick) return;
    try {
      fs.mkdirSync(path.dirname(modeFile), { recursive: true });
      fs.writeFileSync(modeFile, JSON.stringify({ mode: pick.id }, null, 2) + "\n", "utf8");
      this.post({ type: "mode", text: pick.label.replace(/^\$\([^)]+\) /, "") });
      this.post({ type: "notice", text: "权限模式已切换: " + pick.label.replace(/^\$\([^)]*\) /, "") });
    } catch (err: any) {
      this.post({ type: "notice", text: "保存模式失败: " + (err?.message ?? err) });
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
      { group: "上下文", label: "上传文件…", description: "从电脑选择图片或文件注入上下文", builtin: "uploadImage" },
      { group: "上下文", label: "引用项目文件…", description: "在输入框插入 @ 搜索", builtin: "mentionFile" },
      // 会话
      { group: "会话", label: "新建会话", description: "清空并开始新对话", builtin: "newSession" },
      { group: "会话", label: "恢复历史会话…", description: "选择当前项目的历史对话", builtin: "pickSession" },
      { group: "会话", label: "回退 / 分叉 / 导出…", description: "打开操作命令菜单", builtin: "more" },
      // 模型
      { group: "模型", label: "切换模型…", description: "选择可用模型", builtin: "pickModel" },
      { group: "模型", label: "思考等级…", description: "off/low/medium/high…", builtin: "pickThinking" },
      { group: "模型", label: "权限模式…", description: "Manual / Edit auto / Plan / Auto", builtin: "pickMode" },
      // 配置（已合并进操作命令菜单，条目在菜单里分组展示）
      { group: "配置", label: "pi 设置…", description: "API key / 登录 / 送达 / 自动压缩 / 会话", builtin: "settings" },
    ];
    const ext = cmds.map((c: any) => ({
      group: "命令 / 技能 / 模板",
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

  /** 给 webview 提供当前项目的会话列表（历史面板用） */
  private async sendSessionList(): Promise<void> {
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const sessions = listSessions(wsPath, 100).map((s) => ({
      file: s.file,
      name: s.name ?? null,
      preview: s.preview,
      time: s.time,
    }));
    this.post({ type: "sessionList", sessions });
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
      this.post({ type: "notice", text: "已恢复会话" });
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: "切换会话失败: " + (err?.message ?? err) });
    }
  }

  /** /login 是 pi 终端内置命令，RPC 模式不可用 → 打开集成终端跑交互式 pi 完成 OAuth */
  private openTerminalLogin(): void {
    const term = vscode.window.createTerminal({ name: "pi 订阅登录" });
    term.show();
    term.sendText("pi");
    this.post({
      type: "notice",
      text: "已在下方终端启动 pi：请输入 /login 选择订阅授权，完成后重载窗口（Ctrl+Shift+P → Reload Window）让面板使用新凭证",
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
      this.post({ type: "notice", text: "工作区里没找到文件: " + raw });
      return;
    }
    // 二进制文件开了也是报错页，直接提示
    if (/\.(vsix|zip|exe|dll|jar|7z|tar|gz|rar|bin|iso|class|pyc|woff2?|ttf|eot)$/i.test(resolved)) {
      this.post({ type: "notice", text: "ⓘ 二进制文件，不在编辑器打开: " + path.basename(resolved) });
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
    let openCol = vscode.ViewColumn.One;
    const tgs = vscode.window.tabGroups.all;
    const act = tgs.find((g) => g.isActive) ?? tgs[0];
    if (act) openCol = act.viewColumn;
    await vscode.window.showTextDocument(doc.uri, {
      viewColumn: openCol,
      preview: true,
      selection: sel,
    });
    } catch (err: any) {
      this.post({ type: "notice", text: "打开失败: " + (err?.message ?? err) });
    }
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
        label: "$(pencil) 重命名当前会话…",
        detail: "对应 pi 的 --name / set_session_name",
        run: async () => {
          const name = await vscode.window.showInputBox({
            prompt: "输入会话名称",
            value: "",
          });
          if (name === undefined || name === "") return;
          await client.setSessionName(name);
          this.post({ type: "notice", text: "会话已重命名: " + name });
        },
      },
      {
        label: "$(output) 手动压缩上下文 (compact)…",
        detail: "上下文快满时手动压缩，可附加说明",
        run: async () => {
          const inst = await vscode.window.showInputBox({
            prompt: "压缩提示（可选，直接回车跳过）",
          });
          if (inst === undefined) return;
          this.post({ type: "status", text: "正在压缩上下文…" });
          const r = await client.compact(inst || undefined);
          this.post({ type: "status", text: "" });
          this.post({
            type: "notice",
            text: r?.result
              ? "压缩完成: " + (r.result.tokensBefore ?? "?") + " → 约 " + (r.result.estimatedTokensAfter ?? "?") + " tokens"
              : "压缩已结束",
          });
        },
      },
      {
        label: "$(clear-all) 清空排队消息 (clear_queue)",
        detail: "取消已排队但未发送的插话/追问，内容会贴回输入框",
        run: async () => {
          const r = await client.clearQueue();
          const all = [...(r?.steering ?? []), ...(r?.followUp ?? [])];
          this.post({ type: "notice", text: all.length ? "已取消排队: " + all.join(" / ") : "没有排队的消息" });
        },
      },
      {
        label: "$(link-external) 导出会话为 HTML…",
        detail: "export_html，导出后自动用浏览器打开",
        run: async () => {
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(os.homedir(), "Desktop", "pi-session.html")),
            filters: { HTML: ["html"] },
          });
          if (!target) return;
          const r = await client.exportHtml(target.fsPath);
          if (r?.path) {
            void vscode.env.openExternal(vscode.Uri.file(r.path));
            this.post({ type: "notice", text: "已导出: " + r.path });
          }
        },
      },
      {
        label: "$(git-branch) 从历史消息分叉 (fork)…",
        detail: "回到某条用户消息重新开始，后续消息被丢弃",
        run: async () => {
          const d = await client.getForkMessages();
          const msgs: any[] = d?.messages ?? [];
          if (!msgs.length) {
            this.post({ type: "notice", text: "没有可分叉的历史消息" });
            return;
          }
          const pick = await vscode.window.showQuickPick(
            msgs.map((m) => ({ label: m.text?.slice(0, 80) ?? "", entryId: m.entryId })),
            { placeHolder: "选择要回到的用户消息（之后的对话将被丢弃）" }
          );
          if (!pick) return;
          const r = await client.fork(pick.entryId);
          if (r?.cancelled) return;
          const md = await client.getMessages();
          this.post({ type: "render", messages: md?.messages ?? [] });
          this.post({ type: "notice", text: "已分叉到: " + (r?.text ?? "").slice(0, 50) });
        },
      },
      {
        label: "$(copy) 克隆当前会话 (clone)",
        detail: "把当前对话复制为一个新会话继续",
        run: async () => {
          const r = await client.clone();
          if (r?.cancelled) return;
          this.post({ type: "notice", text: "已克隆为新会话" });
        },
      },
      {
        label: "$(terminal) 直接执行 shell 命令…",
        detail: "输出会进入对话上下文，agent 下次回复时可见",
        run: async () => {
          const cmd = await vscode.window.showInputBox({ prompt: "要执行的命令" });
          if (!cmd) return;
          this.post({ type: "notice", text: "$ " + cmd });
          const r = await client.bash(cmd);
          if (r?.output) {
            this.post({ type: "notice", text: "退出码 " + (r.exitCode ?? "?") + ": " + String(r.output).slice(0, 200) });
          }
        },
      },
      {
        label: "$(tools) 查看 /命令、技能与提示模板",
        detail: "在输入框里输入 /命令名 即可执行",
        run: async () => {
          const d = await client.getCommands();
          const cmds: any[] = d?.commands ?? [];
          if (!cmds.length) {
            this.post({ type: "notice", text: "没有可用的 /命令" });
            return;
          }
          await vscode.window.showQuickPick(
            cmds.map((c) => ({
              label: "/" + c.name,
              description: c.source,
              detail: (c.description ?? "") + (c.path ? "  ·  " + c.path : ""),
            })),
            { placeHolder: "可用命令（在聊天输入框输入 /命令名 回车执行）" }
          );
        },
      },
    ];

    // 合并设置菜单（分组展示，原 ⚙ 按钮内容全部保留在此）
    items.push({ label: "配置", kind: vscode.QuickPickItemKind.Separator });
    items.push(...(await this.buildSettingsItems(client)));

    const pick = await vscode.window.showQuickPick(items, { placeHolder: "pi 菜单：会话操作 / 配置" });
    if (!pick?.run) return;
    try {
      await pick.run();
    } catch (err: any) {
      this.post({ type: "notice", text: "操作失败: " + (err?.message ?? err) });
    }
  }

  /** ⚙ 设置菜单条目（已合并进 ⚡ 菜单；/ 菜单「pi 设置…」仍单独打开） */
  private async buildSettingsItems(client: PiClient): Promise<(vscode.QuickPickItem & { run?: () => Promise<void> })[]> {
    const st = await client.getState().catch(() => null);
    const cfg = vscode.workspace.getConfiguration("piChat");
    const mode = cfg.get<string>("sessionMode", "ephemeral");
    const sessionDir = cfg.get<string>("sessionDir", "");

    const items: (vscode.QuickPickItem & { run?: () => Promise<void> })[] = [];

    items.push({
      label: "$(key) 配置模型 API key…",
      detail: "写入 ~/.pi/agent/auth.json（Z.ai / OpenRouter / OpenAI / DeepSeek / Kimi…）",
      run: async () => {
        await this.configApiKey();
      },
    });
    items.push({
      label: "$(globe) 订阅登录 (/login)",
      detail: "Claude Pro/Max、ChatGPT Plus/Pro、Codex 等订阅授权（在集成终端完成浏览器流程）",
      run: async () => {
        await this.openTerminalLogin();
      },
    });
    items.push({
      label: "$(trash) 查看/删除已保存的凭证",
      detail: "管理 ~/.pi/agent/auth.json 里的 key / 授权",
      run: async () => {
        await this.manageAuth();
      },
    });
    items.push({
      label: "$(cloud-download) 安装 / 更新 pi",
      detail: "npm install -g @earendil-works/pi-coding-agent",
      run: async () => {
        await this.installPi();
      },
    });
    items.push({
      label: "$(shield) 权限模式…",
      detail: "Manual / Edit automatically / Plan / Auto（对应 pi 的 /mode 扩展命令）",
      run: async () => {
        // /mode 是扩展命令，立即执行并弹出选择（走 extension_ui_request → QuickPick）
        await client.prompt("/mode");
      },
    });
    items.push({
      label: "$(comment-discussion) 插话送达: " + (st?.steeringMode === "all" ? "全部" : "逐条"),
      detail: "agent 工作中插话的送达方式（对应 set_steering_mode）",
      run: async () => {
        const next = st?.steeringMode === "all" ? "one-at-a-time" : "all";
        await client.setSteeringMode(next);
        // 同步持久化到插件配置，重启 pi 后仍生效
        await vscode.workspace
          .getConfiguration("piChat")
          .update("steeringMode", next, vscode.ConfigurationTarget.Global);
        this.post({ type: "notice", text: "插话送达方式: " + (next === "all" ? "全部" : "逐条") });
      },
    });
    items.push({
      label: "$(arrow-down) 追问送达: " + (st?.followUpMode === "all" ? "全部" : "逐条"),
      detail: "排队追问的送达方式（对应 set_follow_up_mode）",
      run: async () => {
        const next = st?.followUpMode === "all" ? "one-at-a-time" : "all";
        await client.setFollowUpMode(next);
        this.post({ type: "notice", text: "追问送达方式: " + (next === "all" ? "全部" : "逐条") });
      },
    });
    items.push({
      label: "$(fold) 自动压缩: " + ((st?.autoCompactionEnabled ?? true) ? "开" : "关"),
      detail: "上下文接近满时自动压缩（对应 set_auto_compaction）",
      run: async () => {
        const next = !(st?.autoCompactionEnabled ?? true);
        await client.setAutoCompaction(next);
        this.post({ type: "notice", text: "自动压缩已" + (next ? "开启" : "关闭") });
      },
    });
    items.push({
      label: "$(sync) 自动重试…",
      detail: "遇到临时错误（限流/过载）自动重试（对应 set_auto_retry）",
      run: async () => {
        const pick2 = await vscode.window.showQuickPick(["开启", "关闭"], {
          placeHolder: "自动重试",
        });
        if (!pick2) return;
        await client.setAutoRetry(pick2 === "开启");
        this.post({ type: "notice", text: "自动重试已" + (pick2 === "开启" ? "开启" : "关闭") });
      },
    });
    items.push({
      label: "$(history) 会话模式: " + mode,
      detail: "ephemeral=不保存 / continue=继续最近 / new=新建持久（piChat.sessionMode）",
      run: async () => {
        const pick2 = await vscode.window.showQuickPick(
          [
            { label: "ephemeral — 不保存会话（关闭即丢失）", value: "ephemeral" },
            { label: "continue — 启动时继续最近一次会话", value: "continue" },
            { label: "new — 新建持久会话", value: "new" },
          ],
          { placeHolder: "piChat.sessionMode（修改后重载窗口生效）" }
        );
        if (!pick2) return;
        await vscode.workspace
          .getConfiguration("piChat")
          .update("sessionMode", pick2.value, vscode.ConfigurationTarget.Global);
        this.post({ type: "notice", text: "会话模式已改为 " + pick2.value + "（重载窗口后生效）" });
      },
    });
    items.push({
      label: "$(folder) 会话存储目录: " + (sessionDir || "默认"),
      detail: "默认为 ~/.pi/agent/sessions（piChat.sessionDir）",
      run: async () => {
        const val = await vscode.window.showInputBox({
          prompt: "自定义会话存储目录（留空用默认）",
          value: sessionDir,
        });
        if (val === undefined) return;
        await vscode.workspace
          .getConfiguration("piChat")
          .update("sessionDir", val, vscode.ConfigurationTarget.Global);
        this.post({ type: "notice", text: "会话目录已更新（重启 pi 后生效）" });
      },
    });
    items.push({
      label: "$(gear) 打开 pi 配置目录 (~/.pi/agent)",
      run: async () => {
        void vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(path.join(os.homedir(), ".pi", "agent"))
        );
      },
    });
    items.push({
      label: "$(json) 编辑 pi settings.json",
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
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "pi 设置" });
    if (!pick?.run) return;
    try {
      await pick.run();
    } catch (err: any) {
      this.post({ type: "notice", text: "设置失败: " + (err?.message ?? err) });
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
        "pi 已就绪，还需要一个模型 API key 才能对话",
        "现在配置",
        "稍后"
      );
      if (pick === "现在配置") await this.configApiKey();
    } else if (!this.authOfferShown) {
      this.authOfferShown = true; // 每次窗口只提醒一次，不反复打扰
      const pick = await vscode.window.showInformationMessage(
        "检测到尚未配置任何模型凭证（API key / 订阅登录）",
        "配置 API key",
        "订阅登录 /login",
        "稍后"
      );
      if (pick === "配置 API key") await this.configApiKey();
      else if (pick === "订阅登录 /login") {
        const c = this.ensureClient();
        this.post({ type: "user", text: "/login" });
        await c.prompt("/login");
      }
    }
  }

  /** 检测 pi 是否可用，返回版本号字符串，不可用返回 null */
  private piVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const p = spawn("pi", ["--version"], {
        shell: process.platform === "win32",
        windowsHide: true,
      });
      let out = "";
      p.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      p.on("error", () => resolve(null));
      p.on("close", (code) => resolve(code === 0 ? out.trim().split("\n")[0] || "ok" : null));
    });
  }

  /** 一键安装/更新 pi（npm 全局装），进度与结果显示在面板 */
  private async installPi(): Promise<void> {
    this.post({ type: "status", text: "正在安装/更新 pi…（可能需要 1~2 分钟）" });
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
        "安装失败：未找到 npm，请先安装 Node.js（nodejs.org）"
      );
    });
    proc.on("close", (code) => {
      this.post({ type: "status", text: "" });
      if (code === 0) {
        this.post({ type: "notice", text: "✔ pi 安装/更新完成" });
        // 装完后（重新）拉起客户端；还没有凭证则直接弹 key 配置
        if (!this.client?.running) this.client = undefined;
        const c = this.ensureClient();
        void c;
        void this.maybeOfferKeyConfig(true);
      } else {
        void vscode.window.showErrorMessage("安装失败: " + tail.slice(-200));
      }
    });
  }

  /** 配置模型 API key：写入 ~/.pi/agent/auth.json（与 pi 的 /login 存储格式一致） */
  private async configApiKey(): Promise<void> {
    const providers = [
      { id: "zai", label: "Z.ai（GLM，全球）" },
      { id: "zai-coding-cn", label: "Z.ai（GLM，中国区）" },
      { id: "openrouter", label: "OpenRouter" },
      { id: "anthropic", label: "Anthropic" },
      { id: "openai", label: "OpenAI" },
      { id: "deepseek", label: "DeepSeek" },
      { id: "google", label: "Google Gemini" },
      { id: "kimi-coding", label: "Kimi For Coding" },
      { id: "qwen-token-plan-cn", label: "Qwen Token 套餐（中国）" },
      { id: "xiaomi", label: "小米 MiMo" },
    ];
    const pick = await vscode.window.showQuickPick(
      providers.map((p) => ({ label: p.label, description: p.id, id: p.id })),
      { placeHolder: "选择 API key 所属服务商" }
    );
    if (!pick) return;
    const key = await vscode.window.showInputBox({
      prompt: "输入 API key（仅保存到本机 ~/.pi/agent/auth.json）",
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
      this.post({ type: "notice", text: "✔ 已保存 " + pick.label + " 的 API key，在工具条「模型」按钮选择即可使用" });
    } catch (err: any) {
      this.post({ type: "notice", text: "保存失败: " + (err?.message ?? err) });
    }
  }

  /** 查看/删除已保存的凭证（auth.json） */
  private async manageAuth(): Promise<void> {
    const file = path.join(os.homedir(), ".pi", "agent", "auth.json");
    let data: any = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.post({ type: "notice", text: "没有已保存的凭证" });
      return;
    }
    const ids = Object.keys(data);
    if (!ids.length) {
      this.post({ type: "notice", text: "没有已保存的凭证" });
      return;
    }
    const pick = await vscode.window.showQuickPick(
      ids.map((id) => ({
        label: id,
        description: data[id]?.type ?? "",
        detail: "选中后将删除该凭证（订阅凭证删除后需重新 /login）",
        id,
      })),
      { placeHolder: "查看/删除已保存的凭证（auth.json）" }
    );
    if (!pick) return;
    const yes = await vscode.window.showWarningMessage(
      "删除 " + pick.id + " 的凭证？",
      { modal: true },
      "删除"
    );
    if (yes !== "删除") return;
    delete data[pick.id];
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
      this.post({ type: "notice", text: "已删除 " + pick.id });
    } catch (err: any) {
      this.post({ type: "notice", text: "删除失败: " + (err?.message ?? err) });
    }
  }

  private async pickModel(): Promise<void> {
    const client = this.ensureClient();
    let models: any[] = [];
    try {
      models = (await client.getAvailableModels())?.models ?? [];
    } catch (err: any) {
      this.post({ type: "notice", text: "获取模型列表失败: " + (err?.message ?? err) });
      return;
    }
    if (!models.length) {
      this.post({ type: "notice", text: "没有可用模型（先用 /login 或 API key 配置）" });
      return;
    }
    const items = models.map((m) => ({
      label: m.name ?? m.id,
      description: m.provider + "/" + m.id,
      detail: "上下文 " + (m.contextWindow ?? "?"),
      model: m,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "选择模型",
    });
    if (!pick) return;
    try {
      await client.setModel(pick.model.provider, pick.model.id);
      void this.globalState.update("piChat.lastModel", {
        provider: pick.model.provider,
        id: pick.model.id,
      });
      this.post({ type: "notice", text: "模型已切换: " + pick.label });
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: "切换失败: " + (err?.message ?? err) });
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
      this.post({ type: "notice", text: "当前模型不支持思考等级" });
      return;
    }
    const pick = await vscode.window.showQuickPick(levels, {
      placeHolder: "选择思考等级",
    });
    if (!pick) return;
    try {
      await client.setThinkingLevel(pick);
      void this.globalState.update("piChat.lastThinking", pick);
      await this.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: "设置失败: " + (err?.message ?? err) });
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
            placeHolder: req.title ?? "请选择",
          });
          if (pick === undefined) respond({ cancelled: true });
          else respond({ value: pick });
          break;
        }
        case "confirm": {
          const sel = await vscode.window.showWarningMessage(
            req.title ?? "确认",
            { modal: true, detail: req.message ?? "" },
            "确认",
            "取消"
          );
          if (sel === undefined) respond({ cancelled: true });
          else respond({ confirmed: sel === "确认" });
          break;
        }
        case "input":
        case "editor": {
          // editor（多行编辑）降级为单行输入框
          const val = await vscode.window.showInputBox({
            prompt: req.title ?? "请输入",
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
            this.post({ type: "mode", text: req.statusText ?? "" });
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
      let stats: any = null;
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
        .filter((m: any) => m.role === "user")
        .map((m: any) => extractText(m.content));
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
          .filter((m: any) => m.role === "user")
          .map((m: any) => extractText(m.content));
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

  private async onPiEvent(e: any): Promise<void> {
    switch (e.type) {
      case "agent_start":
        this.busy = true;
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
          detail: toolDetail(e.toolName, e.args),
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
            "⚠ 请求失败，自动重试 (" +
            (e.attempt ?? "?") + "/" + (e.maxAttempts ?? "?") + ")" +
            (why ? ": " + why.slice(0, 120) : ""),
        });
        this.post({
          type: "status",
          text: "自动重试中 (" + (e.attempt ?? "?") + "/" + (e.maxAttempts ?? "?") + ")…",
        });
        break;
      }
      case "auto_retry_end": {
        this.post({ type: "status", text: "" });
        if (e.success === false) {
          this.post({
            type: "notice",
            text:
              "✘ 重试 " + (e.attempt ?? "?") + " 次仍失败: " +
              (e.finalError ? String(e.finalError).slice(0, 150) : "网络/服务端错误") +
              "，可重发消息再试",
          });
        } else if (e.attempt && e.attempt > 1) {
          this.post({ type: "notice", text: "✔ 重试成功（第 " + e.attempt + " 次）" });
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
          text: "扩展错误 (" + e.event + "): " + e.error,
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
        const err = e.error ?? e.errorMessage ?? e.reason;
        if (typeof err === "string" && err) {
          this.post({ type: "notice", text: "⚠ " + e.type + ": " + err.slice(0, 200) });
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
          if (t && t !== "请看这段代码" && t !== "请看这张图片") preview = t.slice(0, 60);
        }
      }
      if (preview && cwd) break;
    }
    return { name, cwd, preview };
  } catch {
    return {};
  }
}

/** 从工具参数里提取一行摘要（命令 / 文件路径 / URL / 搜索词等） */
function toolDetail(name: string, args: any): string {
  if (!args) return "";
  const v =
    args.command ?? args.file_path ?? args.path ?? args.url ?? args.query ??
    args.pattern ?? args.content ?? args.skill ?? args.name;
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").slice(0, 120);
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

function getHtml(theme = "auto"): string {
  const nonce = Math.random().toString(36).slice(2);
  return [
    "<!DOCTYPE html>",
    '<html lang="zh">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-' + nonce + '\'; img-src data:;">',
    "<style>" + css() + "</style>",
    "</head>",
    '<body data-theme="' + theme + '">',
    '<div id="header">',
    '<div id="hdr-row1">',
    '<span id="session" class="hdr-btn" title="点击查看 / 切换历史会话">会话: —</span>',
    '<span class="spacer"></span>',
    '<span id="history" class="ico-btn" title="历史会话"></span>',
    '<span id="newchat" class="ico-btn" title="新建会话"></span>',
    '<span id="more" class="ico-btn" title="菜单：会话操作 / 配置"></span>',
    '<span id="theme" class="ico-btn" title="主题 / 背景"></span>',
    "</div>",
    '<div id="history-panel">',
    '<input id="his-search" placeholder="搜索会话…">',
    '<div id="his-list"></div>',
    "</div>",
    "</div>",
    '<div id="messages"><div class="notice">直接输入消息即可开始。工作中再发送会自动排队插话，Esc 或停止按钮可中断。</div></div>',
    '<div id="queuebar"></div>',
    '<div id="statusline"><span id="status"></span></div>',
    '<div id="composer">',
    '<div id="ctxrow"><span id="codechip" style="display:none"></span></div>',
    '<div id="suggest"></div>',
    '<div id="plusmenu">',
    '<div class="pm-item" id="pm-upload"></div>',
    '<div class="pm-item" id="pm-at"></div>',
    '</div>',
    '<input type="file" id="file" multiple style="display:none">',
    '<div id="attachbar"></div>',
    '<textarea id="input" placeholder="给 pi 发消息… (Enter 发送，Shift+Enter 换行)"></textarea>',
    '<div id="ctoolbar">',
    '<span id="attach" class="tb-btn" title="添加图片"></span>',
    '<span class="tb-spacer"></span>',
    '<button id="stop" title="停止 (Esc)"></button>',
    '<button id="send" title="Enter 发送"></button>',
    "</div>",
    "</div>",
    '<div id="bottombar">',
    '<span id="model" class="tb-btn" title="切换模型">—</span>',
    '<span id="think" class="tb-btn" title="思考等级">思考 —</span>',
    '<span id="modebadge" class="tb-btn" title="权限模式（点击切换）"></span>',
    '<span id="usage"></span>',
    '<span id="ver"></span>',
    "</div>",
    '<script nonce="' + nonce + '">' + webviewJs() + "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function css(): string {
  return [
    "html, body { height: 100%; margin: 0; }",
    "body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-editor-foreground); background: var(--vscode-sideBar-background); }",
    "",
    "/* ── 头部 ── */",
    "#header { padding: 6px 10px 5px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }",
    "#hdr-row1 { display: flex; align-items: center; gap: 6px; }",
    "#title { font-weight: bold; font-size: 12px; }",
    "#session { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    "#ctoolbar #usage { font-size: 11px; opacity: .6; margin-right: 8px; white-space: nowrap; }",
    ".ico-btn { cursor: pointer; padding: 3px 5px; border-radius: 4px; opacity: .8; display: inline-flex; align-items: center; line-height: 0; }",
    ".ico-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); opacity: 1; }",
    ".spacer { flex: 1; }",
    ".spacer-right { margin-left: auto; }",
    ".hdr-btn { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; }",
    ".hdr-btn:hover { opacity: 1; text-decoration: underline; }",
    "",
    "/* ── 消息区 ── */",
    "#messages { flex: 1; overflow-y: auto; padding: 10px 10px 4px; }",
    "* { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,.5) transparent; } /* 标准属性兑底：部分 Chromium 环境里 webkit 伪元素滚动条不生效 */",
    "::-webkit-scrollbar { width: 3px; height: 3px; }",
    "::-webkit-scrollbar-thumb { background: rgba(128,128,128,.45); border-radius: 1.5px; }",
    "::-webkit-scrollbar-thumb:hover { background: rgba(150,150,150,.65); }",
    "::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }",
    "#queuebar { padding: 0 12px 3px; }",
    ".q-item { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: .65; padding: 2px 0; }",
    ".q-item .q-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".bubble { margin: 8px 0; padding: 7px 11px; border-radius: 10px; line-height: 1.55; word-break: break-word; max-width: 92%; }",
    ".bubble.user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-left: auto; border-bottom-right-radius: 3px; white-space: pre-wrap; opacity: .92; }",
    ".bubble.assistant { background: var(--vscode-editorWidget-background, rgba(128,128,128,.10)); border-bottom-left-radius: 3px; }",
    ".bubble.queued { opacity: .5; border: 1px dashed var(--vscode-input-border, rgba(128,128,128,.4)); background: transparent; }",
    ".md-p { white-space: pre-wrap; }",
    ".md-h { font-weight: bold; margin: 6px 0 2px; }",
    ".md-li { padding-left: 12px; }",
    ".md-table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }",
    ".md-table th, .md-table td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); padding: 3px 8px; text-align: left; }",
    ".md-table th { background: var(--vscode-editorWidget-background, rgba(128,128,128,.12)); }",
    ".md-quote { border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,.4)); padding-left: 8px; margin: 2px 0; opacity: .85; }",
    "code { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.2)); padding: 0 3px; border-radius: 3px; }",
    "pre.code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.15)); padding: 8px 10px; border-radius: 6px; overflow-x: auto; white-space: pre; margin: 6px 0; }",
    "details.think { margin: 6px 0; opacity: .55; font-size: 12px; }",
    "details.think summary { cursor: pointer; user-select: none; }",
    ".think-body { white-space: pre-wrap; border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.4)); padding-left: 8px; margin-top: 4px; }",
    ".tool { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: .85; margin: 5px 0 2px 8px; padding: 2px 6px; border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.4)); }",
    ".tool-out { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: .55; white-space: pre-wrap; margin: 0 0 4px 16px; }",
    ".notice { font-size: 11px; opacity: .55; margin: 4px 8px; }",
    "",
    "/* ── 工具行（CC 风格块结构）── */",
    ".tool { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px 2px; padding: 4px 8px; font-size: 12px; cursor: pointer; border-radius: 6px; font-family: var(--vscode-font-family); }",
    ".tool:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }",
    ".tool .t-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--vscode-descriptionForeground, #888); }",
    ".tool.ok .t-dot { background: #4ec96e; box-shadow: 0 0 4px rgba(78,201,110,.5); }",
    ".tool.err .t-dot { background: #f66; box-shadow: 0 0 4px rgba(255,102,102,.5); }",
    ".tool.run .t-dot { background: transparent; border: 2px solid var(--vscode-focusBorder, #0078d4); animation: pulse 1s infinite; }",
    "@keyframes pulse { 50% { opacity: .3; } }",
    ".tool .t-name { font-weight: bold; color: var(--vscode-editor-foreground); }",
    ".tool .t-detail { opacity: .55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }",
    ".tool .t-arrow { opacity: .4; display: inline-flex; align-items: center; transition: transform .15s; }",
    ".tool.open .t-arrow { transform: rotate(90deg); }",
    ".tool-box { margin: 0 0 8px 18px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 8px; overflow: hidden; max-width: 92%; }",
    ".tool-box .tb-row { display: flex; gap: 8px; padding: 6px 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; }",
    ".tool-box .tb-row + .tb-row { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }",
    ".tool-box .tb-tag { flex: none; opacity: .65; width: 26px; }",
    ".tool-box .tb-val { white-space: pre-wrap; word-break: break-all; opacity: .85; }",
    "",
    "/* ── 输入区（Claude Code 风格卡片）── */",
    "#composer { margin: 0 10px 8px; position: relative; display: flex; flex-direction: column; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 10px; background: var(--vscode-input-background); }",
    "#composer:focus-within { border-color: var(--vscode-focusBorder, #0078d4); }",
    "#attachbar { display: none; flex-wrap: wrap; gap: 6px; padding: 8px 10px 0; }",
    "#ctxrow { display: none; flex-wrap: wrap; gap: 6px; padding: 8px 10px 0; }",
    "#ctxrow #codechip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; line-height: 18px; padding: 1px 10px; border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 999px; background: var(--vscode-badge-background, rgba(128,128,128,.15)); cursor: pointer; white-space: nowrap; opacity: 1; }",
    "#ctxrow #codechip:hover { border-color: var(--vscode-focusBorder, #0078d4); }",
    ".chip-img { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px 3px 3px; border-radius: 7px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.15)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); font-size: 11px; }",
    ".chip-img img { width: 26px; height: 26px; object-fit: cover; border-radius: 4px; display: block; }",
    ".chip-x { cursor: pointer; opacity: .6; padding: 0 2px; }",
    ".chip-x:hover { opacity: 1; }",
    "#suggest { display: none; position: absolute; bottom: calc(100% + 4px); left: 0; right: 0; max-height: 220px; overflow-y: auto; background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.4); z-index: 10; }",
    ".sg-item { display: flex; align-items: center; gap: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer; }",
    ".sg-item.active, .sg-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.2)); }",
    ".sg-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".sg-detail { margin-left: auto; opacity: .45; font-size: 11px; white-space: nowrap; }",
    ".sg-header { padding: 6px 10px 2px; font-size: 10px; font-weight: bold; opacity: .45; text-transform: uppercase; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); margin-top: 2px; }",
    ".sg-header:first-child { margin-top: 0; border-top: none; }",
    "#plusmenu { display: none; position: absolute; bottom: 42px; left: 8px; min-width: 170px; background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.4); z-index: 20; overflow: hidden; }",
    ".pm-item { padding: 6px 12px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; }",
    ".pm-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.2)); }",
    "#history-panel { display: none; position: absolute; top: 30px; right: 8px; width: min(340px, 90%); max-height: 60%; background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.4); z-index: 20; display: none; flex-direction: column; }",
    "#his-search { margin: 8px; padding: 5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 6px; outline: none; font-family: inherit; font-size: 12px; }",
    "#his-list { overflow-y: auto; padding: 0 4px 6px; }",
    ".his-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }",
    ".his-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.2)); }",
    ".his-main { flex: 1; overflow: hidden; }",
    ".his-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".his-sub { font-size: 10px; opacity: .5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".his-del { opacity: .4; cursor: pointer; padding: 2px 4px; display: inline-flex; align-items: center; line-height: 0; }",
    ".his-del:hover { opacity: 1; color: var(--vscode-inputValidation-errorForeground, #f66); }",
    ".his-open { opacity: .4; cursor: pointer; padding: 2px 4px; display: inline-flex; align-items: center; line-height: 0; }",
    ".his-open:hover { opacity: 1; }",
    ".fp { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }",
    ".fp:hover { color: var(--vscode-textLink-foreground, #4daafc); }",
    "#input { display: block; width: 100%; box-sizing: border-box; resize: none; height: 54px; min-height: 54px; max-height: 220px; overflow-y: hidden; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; padding: 8px 10px; font-family: inherit; font-size: var(--vscode-font-size, 13px); line-height: 1.5; }",
    "#ctoolbar { display: flex; align-items: center; gap: 6px; padding: 2px 8px 7px; }",
    ".tb-btn { cursor: pointer; padding: 0 8px; height: 26px; display: inline-flex; align-items: center; gap: 4px; border-radius: 5px; font-size: 12px; opacity: .8; white-space: nowrap; }",
    "#codechip.off { opacity: .4; text-decoration: line-through; }",
    ".tb-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); opacity: 1; }",
    ".tb-spacer { flex: 1; }",
    "#send, #stop { width: 34px; height: 26px; padding: 0; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); display: inline-flex; align-items: center; justify-content: center; flex: none; }",
    "#send:hover, #stop:hover { background: var(--vscode-button-hoverBackground); }",
    "#stop { display: none; background: var(--vscode-inputValidation-errorBackground, #b91c1c); }",
    "",
    "/* ── 底部状态栏 ── */",
    "#bottombar { display: flex; align-items: center; gap: 10px; padding: 0 12px 6px; font-size: 11px; opacity: .8; }",
    "#bottombar #usage { margin-left: auto; white-space: nowrap; opacity: .8; }",
    "#statusline { display: flex; align-items: center; min-height: 16px; padding: 0 14px 2px; font-size: 11px; }",
    "#bottombar #ver { opacity: .45; }",
    "#status.busy { font-weight: 600; color: var(--vscode-textLink-foreground, #4daafc); animation: wpulse 1.2s ease-in-out infinite; }",
    "#bottombar .tb-btn { padding: 0 6px; height: 20px; }",
    ".working-row { padding: 4px 14px; font-size: 12px; opacity: .7; }",
    "@keyframes wpulse { 0%, 100% { opacity: 1; text-shadow: 0 0 10px rgba(77,170,252,.9); } 50% { opacity: .4; text-shadow: none; } }",
    "",
    "/* ── 主题（🎨 切换，跟随 VS Code / CC 暗黑 / 午夜蓝）── */",
    "body[data-theme='cc-dark'] { background: #0a0a0c; color: #e6e6e9; }",
    "body[data-theme='cc-dark'] #header { border-bottom: 1px solid #22222a; }",
    "body[data-theme='cc-dark'] .bubble.user { background: #8a4b2f; color: #fff; }",
    "body[data-theme='cc-dark'] .bubble.assistant { background: #17171c; }",
    "body[data-theme='cc-dark'] .tool:hover, body[data-theme='cc-dark'] .tool-box { background: #121216; }",
    "body[data-theme='cc-dark'] pre.code { background: #121216; }",
    "body[data-theme='cc-dark'] #composer { background: #131318; border-color: #2a2a33; }",
    "body[data-theme='cc-dark'] #input { color: #e6e6e9; }",
    "body[data-theme='cc-dark'] #suggest, body[data-theme='cc-dark'] #plusmenu, body[data-theme='cc-dark'] #history-panel { background: #17171c; border-color: #2a2a33; }",
    "",
    "body[data-theme='midnight'] { background: #0b1220; color: #dbe4f0; }",
    "body[data-theme='midnight'] .bubble.user { background: #2b4a7a; color: #fff; }",
    "body[data-theme='midnight'] .bubble.assistant { background: #14203a; }",
    "body[data-theme='midnight'] .tool:hover, body[data-theme='midnight'] .tool-box { background: #101a30; }",
    "body[data-theme='midnight'] pre.code { background: #101a30; }",
    "body[data-theme='midnight'] #composer { background: #0e1830; border-color: #22345c; }",
    "body[data-theme='midnight'] #input { color: #dbe4f0; }",
    "body[data-theme='midnight'] #suggest, body[data-theme='midnight'] #plusmenu, body[data-theme='midnight'] #history-panel { background: #14203a; border-color: #22345c; }",
  ].join("\n");
}

/** 注意：这里面的代码不能出现 ${，否则会被外层拼接破坏 */
function webviewJs(): string {
  return [
    "(function(){",
    "  var vscode = acquireVsCodeApi();",
    "  var messages = document.getElementById('messages');",
    "  var input = document.getElementById('input');",
    "  var stopBtn = document.getElementById('stop');",
    "  var sendBtn = document.getElementById('send');",
    "  var statusEl = document.getElementById('status');",
    "  function setStatus(t) { if (t) { statusEl.classList.remove('busy'); statusEl.textContent = t; } else { statusEl.textContent = ''; } }",
    "  var modeBadge = document.getElementById('modebadge');",
    "  var codechipEl = document.getElementById('codechip');",
    "  var ctxrowEl = document.getElementById('ctxrow');",
    "  var codeCtx = null; var codeOn = true;",
    "  var modelEl = document.getElementById('model');",
    "  var thinkEl = document.getElementById('think');",
    "  var sessionEl = document.getElementById('session');",
    "  var moreEl = document.getElementById('more');",
  "  var themeEl = document.getElementById('theme');",
    "  var usageEl = document.getElementById('usage');",
    "  var newChatEl = document.getElementById('newchat');",
    "  var attachbarEl = document.getElementById('attachbar');",
    "  var attachEl = document.getElementById('attach');",
    "  var fileInput = document.getElementById('file');",
    "  var suggestEl = document.getElementById('suggest');",
    "  var plusmenuEl = document.getElementById('plusmenu');",
    "  var pmUpload = document.getElementById('pm-upload');",
    "  var pmAt = document.getElementById('pm-at');",
    "  var historyEl = document.getElementById('history');",
    "  var histPanel = document.getElementById('history-panel');",
    "  var hisSearch = document.getElementById('his-search');",
    "  var hisList = document.getElementById('his-list');",
    "  var sessionCache = null;",
    "",
    "  // ── 统一 SVG 图标集（16 网格描边风，currentColor 跟随主题）──",
    "  var ICON_PATHS = {",
    "    clock: '<circle cx=\"8\" cy=\"8\" r=\"6.2\"/><path d=\"M8 4.8V8l2.4 1.6\"/>',",
    "    plus: '<path d=\"M8 3.5v9M3.5 8h9\"/>',",
    "    term: '<path d=\"M3 5.5l3 2.5-3 2.5\"/><path d=\"M8.5 10.5H13\"/>',",
    "    gear: '<circle cx=\"8\" cy=\"8\" r=\"2.1\"/><path d=\"M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.5 3.5l1.6 1.6M10.9 10.9l1.6 1.6M12.5 3.5l-1.6 1.6M5.1 10.9l-1.6 1.6\"/>',",
    "    theme: '<circle cx=\"8\" cy=\"8\" r=\"6.2\"/><path d=\"M8 1.8a6.2 6.2 0 0 1 0 12.4Z\" fill=\"currentColor\" stroke=\"none\"/>',",
    "    image: '<rect x=\"2\" y=\"3\" width=\"12\" height=\"10\" rx=\"1.5\"/><circle cx=\"5.8\" cy=\"6.3\" r=\"1.1\"/><path d=\"M2.5 11.5L6 8.5l2.3 1.9 2.7-2.6 2.6 2.4\"/>',",
    "    file: '<path d=\"M4 1.8h5.2L12.5 5v9.2H4Z\"/><path d=\"M9 1.8V5h3.5\"/>',",
    "    filecode: '<path d=\"M4 1.8h5.2L12.5 5v9.2H4Z\"/><path d=\"M9 1.8V5h3.5\"/><path d=\"M6.2 8L5 9.2l1.2 1.2M9.8 8L11 9.2 9.8 10.4\"/>',",
    "    cpu: '<rect x=\"4.5\" y=\"4.5\" width=\"7\" height=\"7\" rx=\"1\"/><path d=\"M8 1.8v2.7M8 11.5v2.7M1.8 8h2.7M11.5 8h2.7\"/>',",
    "    up: '<path d=\"M8 13V3.5M4.2 7.3L8 3.5l3.8 3.8\"/>',",
    "    stop: '<rect x=\"4.5\" y=\"4.5\" width=\"7\" height=\"7\" rx=\"1.2\" fill=\"currentColor\" stroke=\"none\"/>',",
    "    x: '<path d=\"M4 4l8 8M12 4L4 12\"/>',",
    "    chev: '<path d=\"M6 3.5L10.5 8 6 12.5\"/>',",
    "    check: '<path d=\"M3.2 8.6l3 3L12.8 4.4\"/>',",
    "    at: '<circle cx=\"8\" cy=\"8\" r=\"2.2\"/><path d=\"M10.2 8v.8a2 2 0 0 0 4 0V8a6.2 6.2 0 1 0-2.4 4.9\"/>'",
    "  };",
    "  function ico(name, size) {",
    "    var s = size || 14;",
    "    return '<svg viewBox=\"0 0 16 16\" width=\"' + s + '\" height=\"' + s + '\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align:-2px\" aria-hidden=\"true\">' + (ICON_PATHS[name] || '') + '</svg>';",
    "  }",
    "  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }",
    "  // ── 文件路径可点击：识别文本里的路径 → .fp span → openPath 给宿主打开 ──",
    "  var FILE_RE = /([A-Za-z]:[\\/][\\w.\\- \\u4e00-\\u9fff\\/]*[\\w.\\-\\u4e00-\\u9fff]\\.[A-Za-z0-9]{1,8}(?:\\:\\d{1,5})?|[\\w.\\-]+(?:[\\/][\\w.\\- \\u4e00-\\u9fff]+)+\\.[A-Za-z0-9]{1,8}(?:\\:\\d{1,5})?|[\\w\\u4e00-\\u9fff][\\w\\-]*\\.(?:ts|tsx|js|jsx|mjs|json|md|txt|html?|css|scss|less|py|java|c|cpp|h|hpp|go|rs|rb|php|sh|bat|ps1|ya?ml|toml|xml|svg|vue|sql|ini|conf|log)(?::\\d{1,5})?)/g; // 第三支：光文件名（常见扩展名白名单）也可点，存在性由宿主 openFilePath 校验",
    "  function cleanPath(p) {",
    "    p = p.replace(/[.,;:!?)}\\]⟩】»]+$/, '');",
    "    var parts = p.split(' ');",
    "    while (parts.length > 1 && parts[parts.length - 1].indexOf('/') === -1 && parts[parts.length - 1].indexOf('\\\\') === -1) parts.pop();",
    "    return parts.join(' ');",
    "  }",
    "  var linkifyEnabled = true; // renderAll 批量重绘时关掉老消息的 linkify，只留最近几条（全量扫正则是大会话卡顿的主因）",
    "  function linkify(root) {",
    "    if (!root || !linkifyEnabled) return;",
    "    var nodes = [];",
    "    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);",
    "    while (w.nextNode()) { var n = w.currentNode; if (n.parentNode.nodeName !== 'PRE' && n.parentNode.classList && !n.parentNode.classList.contains('fp')) nodes.push(n); }",
    "    for (var i = 0; i < nodes.length; i++) {",
    "      var n = nodes[i]; var txt = n.nodeValue; if (!txt) continue;",
    "      FILE_RE.lastIndex = 0; if (!FILE_RE.test(txt)) continue;",
    "      FILE_RE.lastIndex = 0;",
    "      var frag = document.createDocumentFragment(); var last = 0, m2;",
    "      while ((m2 = FILE_RE.exec(txt)) !== null) {",
    "        if (m2.index > 0 && txt.charAt(m2.index - 1) === '/') { continue; } // URL 的一部分，不当作路径",
    "        if (m2[0].indexOf('://') !== -1) { continue; } // URL 协议头（如 https://）被盘符分支误认，跳过",
    "        if (/\\.(?:vsix|zip|exe|dll|jar|7z|tar|gz|rar|bin|iso|pyc|woff2?|ttf|eot)$/i.test(m2[0])) { continue; } // 二进制文件不做成链接，点了也是报错页",
    "        var p = cleanPath(m2[0]);",
    "        if (m2.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m2.index)));",
    "        if (p) { var sp = document.createElement('span'); sp.className = 'fp'; sp.textContent = p; sp.setAttribute('data-p', p); frag.appendChild(sp); }",
    "        else frag.appendChild(document.createTextNode(m2[0]));",
    "        last = m2.index + m2[0].length;",
    "      }",
    "      if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));",
    "      n.parentNode.replaceChild(frag, n);",
    "    }",
    "  }",
    "  // 点击 .fp → openPath 给宿主打开（捕获阶段，防止触发工具行折叠）",
    "  messages.addEventListener('click', function (e) {",
    "    var t = e.target;",
    "    while (t && t !== messages) {",
    "      if (t.classList && t.classList.contains('fp')) {",
    "        e.stopPropagation(); vscode.postMessage({ type: 'openPath', path: t.getAttribute('data-p') });",
    "        return;",
    "      }",
    "      t = t.parentNode;",
    "    }",
    "  }, true);",,
    "  // ── 头部/工具条图标注入（统一 SVG）──",
    "  historyEl.innerHTML = ico('clock');",
    "  newChatEl.innerHTML = ico('plus');",
    "  moreEl.innerHTML = ico('gear');",
    "  themeEl.innerHTML = ico('theme');",
    "  attachEl.innerHTML = ico('image');",
    "  pmUpload.innerHTML = ico('image', 13) + '<span>上传图片</span>';",
    "  pmAt.innerHTML = ico('at', 13) + '<span>引用文件</span>';",
    "  modelEl.innerHTML = ico('cpu') + ' —';",
    "  stopBtn.innerHTML = ico('stop', 11);",
    "  sendBtn.innerHTML = ico('up', 14);",
    "",
    "  // ── ＋菜单：上传图片 / 引用文件 ──",
    "  attachEl.addEventListener('click', function (e) {",
    "    e.stopPropagation();",
    "    plusmenuEl.style.display = plusmenuEl.style.display === 'block' ? 'none' : 'block';",
    "  });",
    "  pmUpload.addEventListener('click', function () { plusmenuEl.style.display = 'none'; fileInput.click(); });",
    "  pmAt.addEventListener('click', function () {",
    "    plusmenuEl.style.display = 'none';",
    "    var v = input.value.replace(/[\\s/@]+$/, ''); // 去掉尾部残留的斜杠/@/空格（斜杠菜单触发符、重复点击）",
    "    input.value = (v ? v + ' ' : '') + '@'; // 已有文字补空格，@ 才能触发搜索（@ 要求行首或空格后）",
    "    input.focus(); updateSuggest();",
    "  });",
    "  document.addEventListener('click', function (e) { if (!plusmenuEl.contains(e.target) && e.target !== attachEl) plusmenuEl.style.display = 'none'; });",
    "",
    "  // ── 历史会话面板 ──",
    "  historyEl.addEventListener('click', function () {",
    "    var open = histPanel.style.display === 'flex';",
    "    histPanel.style.display = open ? 'none' : 'flex';",
    "    if (!open) {",
    "      if (sessionCache === null) vscode.postMessage({ type: 'listSessions' });",
    "      hisSearch.value = ''; renderHistory();",
    "      hisSearch.focus();",
    "    }",
    "  });",
    "  hisSearch.addEventListener('input', renderHistory);",
    "  function renderHistory() {",
    "    if (!sessionCache) { hisList.innerHTML = '<div class=\"notice\" style=\"padding:8px\">加载中…</div>'; return; }",
    "    var q = hisSearch.value.toLowerCase();",
    "    hisList.innerHTML = '';",
    "    var n = 0;",
    "    for (var i = 0; i < sessionCache.length && n < 50; i++) {",
    "      var s = sessionCache[i];",
    "      var label = s.name || s.preview || '未命名会话';",
    "      if (q && (label + ' ' + s.time).toLowerCase().indexOf(q) === -1) continue;",
    "      n++;",
    "      (function(sess) {",
    "        var row = el('div', 'his-item');",
    "        var main = el('div', 'his-main');",
    "        main.appendChild(el('div', 'his-name', label));",
    "        main.appendChild(el('div', 'his-sub', sess.time));",
    "        row.appendChild(main);",
    "        var open = el('span', 'his-open'); open.innerHTML = ico('file', 12); open.title = '在编辑器打开会话文件 (.jsonl)';",
    "        open.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'revealSessionFile', file: sess.file }); });",
    "        row.appendChild(open);",
    "        var del = el('span', 'his-del'); del.innerHTML = ico('x', 12);",
    "        del.title = '删除会话';",
    "        del.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'deleteSession', file: sess.file }); });",
    "        row.appendChild(del);",
    "        row.title = sess.file;",
    "        row.addEventListener('click', function () { histPanel.style.display = 'none'; vscode.postMessage({ type: 'openSession', file: sess.file }); });",
    "        hisList.appendChild(row);",
    "      })(s);",
    "    }",
    "    if (!n) hisList.innerHTML = '<div class=\"notice\" style=\"padding:8px\">没有匹配的会话</div>';",
    "  }",
    "  var liveMsg = null; var liveDiv = null;",
    "  var toolEls = {};",
    "  var sgList = []; var sgSel = 0; var sgKind = null;",
    "  var slashCmds = null;",
    "  var workspaceFiles = null;",
    "  var streaming = false;",
    "  var pendingImages = [];",
    "",
    "  function renderCodeChip() {",
    "    if (!codeCtx) { codechipEl.style.display = 'none'; ctxrowEl.style.display = 'none'; return; }",
    "    codechipEl.style.display = 'inline-flex';",
    "    ctxrowEl.style.display = 'flex';",
    "    codechipEl.innerHTML = ico('filecode', 12) + ' ' + esc(codeCtx.name);",
    "    codechipEl.className = 'tb-btn' + (codeOn ? '' : ' off');",
    "    codechipEl.title = (codeOn ? '\\u00d7 点击不附带' : '\\u2713 点击附带') + '\\n' + codeCtx.rel + ' (' + codeCtx.range + ')';",
    "  }",
    "  var liveLast = null;",
    "  var toolEls = {};",
    "",
    "  function el(tag, cls, text) {",
    "    var e = document.createElement(tag);",
    "    if (cls) e.className = cls;",
    "    if (text !== undefined && text !== '') e.textContent = text;",
    "    return e;",
    "  }",
    "  function scroll() { messages.scrollTop = messages.scrollHeight; }",
    "  function setStatus(t) { if (t) { statusEl.classList.remove('busy'); statusEl.textContent = t; } else if (!streaming) { statusEl.textContent = ''; } }", // 忙碌时不许清空 Working
    "  var queueN = 0;",
    "  var modeText = 'Auto';",
    "  var busyTimer = null; var busyStart = 0;",
    "  function renderStatus() { modeBadge.textContent = modeText; }",
    "  function setBusy(v) {",
    "    streaming = v;",
    "    stopBtn.style.display = v ? 'inline-flex' : 'none';",
    "    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }",
    "    if (v) {",
    "      statusEl.classList.add('busy');",
    "      var frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];",
    "      var fi = 0;",
    "      statusEl.textContent = frames[0] + ' Working…';",
    "      busyTimer = setInterval(function () {",
    "        fi = (fi + 1) % frames.length;",
    "        statusEl.textContent = frames[fi] + ' Working…' + (queueN > 0 ? ' · 排队 ' + queueN + ' 条' : '');",
    "      }, 120);",
    "    } else {",
    "      statusEl.classList.remove('busy');",
    "      statusEl.textContent = '';",
    "    }",
    "    if (!v) { finalizeLive(); liveReset(); }",
    "  }",
    "",
    "  // 轻量 Markdown：代码块 / 标题 / 列表 / 行内 code / 粗体",
    "  function renderInline(elm, text) {",
    "    var re = /(`[^`]+`|\\*\\*[^*]+\\*\\*)/g;",
    "    var last = 0, m;",
    "    while ((m = re.exec(text)) !== null) {",
    "      if (m.index > last) elm.appendChild(document.createTextNode(text.slice(last, m.index)));",
    "      var tok = m[0];",
    "      if (tok.charAt(0) === '`') { var c = document.createElement('code'); c.textContent = tok.slice(1, -1); elm.appendChild(c); }",
    "      else { var b = document.createElement('b'); b.textContent = tok.slice(2, -2); elm.appendChild(b); }",
    "      last = m.index + tok.length;",
    "    }",
    "    if (last < text.length) elm.appendChild(document.createTextNode(text.slice(last)));",
    "  }",
    "  function renderPlain(parent, text) {",
    "    var lines = String(text).split('\\n');",
    "    var div = null;",
    "    for (var i = 0; i < lines.length; i++) {",
    "      var line = lines[i];",
    "      if (line.trim() === '') { div = null; continue; }",
    "      if (/^\\s*\\|.*\\|\\s*$/.test(line)) {",
    "        var tbl = [line];",
    "        while (i + 1 < lines.length && /^\\s*\\|.*\\|\\s*$/.test(lines[i + 1])) tbl.push(lines[++i]);",
    "        renderTable(parent, tbl);",
    "        div = null; continue;",
    "      }",
    "      if (/^#{1,6}\\s/.test(line)) {",
    "        var h = el('div', 'md-h'); renderInline(h, line.replace(/^#{1,6}\\s*/, '')); parent.appendChild(h); div = null; continue;",
    "      }",
    "      var lm = line.match(/^(\\s*)([-*]|\\d+\\.)\\s+(.*)$/);",
    "      if (lm) {",
    "        var li = el('div', 'md-li'); li.style.paddingLeft = (12 + lm[1].length * 10) + 'px';",
    "        li.appendChild(document.createTextNode((lm[2] === '-' || lm[2] === '*' ? '•' : lm[2]) + ' '));",
    "        renderInline(li, lm[3]); parent.appendChild(li); div = null; continue;",
    "      }",
    "      if (/^>\\s?/.test(line)) {",
    "        var qt = el('div', 'md-quote'); renderInline(qt, line.replace(/^>\\s?/, '')); parent.appendChild(qt); div = null; continue;",
    "      }",
    "      if (!div) { div = el('div', 'md-p'); parent.appendChild(div); }",
    "      renderInline(div, line);",
    "      div.appendChild(document.createTextNode('\\n'));",
    "    }",
    "  }",
    "  function renderTable(parent, rows) {",
    "    function cells(r) { return r.replace(/^\\s*\\|/, '').replace(/\\|\\s*$/, '').split('|'); }",
    "    var t = document.createElement('table'); t.className = 'md-table';",
    "    for (var ri = 0; ri < rows.length; ri++) {",
    "      var cs = cells(rows[ri]);",
    "      if (ri === 1 && cs.every(function (c) { return /^\\s*:?-+:?\\s*$/.test(c); })) continue; // 表头分隔行",
    "      var tr = document.createElement('tr');",
    "      for (var cj = 0; cj < cs.length; cj++) {",
    "        var td = document.createElement(ri === 0 ? 'th' : 'td');",
    "        renderInline(td, cs[cj].trim()); tr.appendChild(td);",
    "      }",
    "      t.appendChild(tr);",
    "    }",
    "    parent.appendChild(t);",
    "  }",
    "  function renderRich(parent, text) {",
    "    // 逐行扫描：围栏必须行首才算代码块，行内 ``` 不影响（之前任意位置都算，行内反引号会把大段内容吞进代码框）",
    "    var lines = String(text).split('\\n');",
    "    var buf = []; var code = []; var inCode = false;",
    "    function flushPlain() { if (buf.length) { renderPlain(parent, buf.join('\\n')); buf = []; } }",
    "    function flushCode() { if (code.length) { parent.appendChild(el('pre', 'code', code.join('\\n'))); code = []; } }",
    "    for (var i = 0; i < lines.length; i++) {",
    "      if (/^```/.test(lines[i])) {",
    "        if (!inCode) { flushPlain(); inCode = true; }",
    "        else { flushCode(); inCode = false; }",
    "        continue;",
    "      }",
    "      if (inCode) code.push(lines[i]); else buf.push(lines[i]);",
    "    }",
    "    if (code.length) parent.appendChild(el('pre', 'code', code.join('\\n')));",
    "    flushPlain();",
    "    linkify(parent);",
    "  }",
    "",
    "  function addUser(text, imageCount, codeInfo) { var b = el('div', 'bubble user'); if (text) { b.textContent = text; } else { b.innerHTML = ico('filecode', 12) + ' (代码上下文)'; } if (codeInfo) { var n1 = el('div', 'notice'); n1.innerHTML = ico('filecode', 12) + ' 附带代码: ' + esc(codeInfo); b.appendChild(n1); } if (imageCount) { var n2 = el('div', 'notice'); n2.innerHTML = ico('image', 12) + ' ' + imageCount + ' 张图片'; b.appendChild(n2); } messages.appendChild(b); scroll(); }",
    "  var queuedItems = [];",
    "  function addQueued(q) {",
    "    queuedItems.push(q);",
    "    var b = el('div', 'q-item');",
    "    b.setAttribute('data-qid', q.qid);",
    "    var qi = el('span', 'q-ico'); qi.innerHTML = ico('clock', 12); b.appendChild(qi);",,
    "    b.appendChild(el('span', 'q-text', q.text || '(图片/代码)'));",
    "    // 排队项固定在输入框上方的 queuebar，单行紧凑显示，不参与消息流",
    "    document.getElementById('queuebar').appendChild(b);",
    "  }",
    "  function removeQueued(qid) {",
    "    queuedItems = queuedItems.filter(function(x) { return x.qid !== qid; });",
    "    var els = document.getElementById('queuebar').querySelectorAll('[data-qid=\"' + qid + '\"]');",
    "    for (var i = 0; i < els.length; i++) els[i].parentNode.removeChild(els[i]);",
    "  }",
    "  var liveMsg = null; var liveDiv = null; var pdet = null;",
    "  // 增量渲染（照 pi TUI 的思路：只往已有节点追加，不整气泡重绘；文本块结束时才做一次 markdown 渲染，settled 再全量纠偏）",
    "  var liveParts = null;",
    "  function liveEnsure() {",
    "    if (!liveDiv) { liveDiv = el('div', 'bubble assistant'); messages.appendChild(liveDiv); }",
    "    if (!liveMsg) liveMsg = { content: [] };",
    "    if (!liveParts) liveParts = {};",
    "  }",
    "  function liveBlock(ci, kind, name) {",
    "    liveEnsure();",
    "    while (liveMsg.content.length <= ci) liveMsg.content.push(null);",
    "    var p = liveParts[ci];",
    "    if (p && p.kind !== kind) { finalizeLive(); p = null; }",
    "    if (!p) {",
    "      var wrap = document.createElement('div'); var body;",
    "      if (kind === 'thinking') {",
    "        var d = document.createElement('details'); d.className = 'think'; d.open = true;",
    "        var sm = document.createElement('summary'); sm.textContent = '思考过程';",
    "        body = el('div', 'think-body', ''); d.appendChild(sm); d.appendChild(body); wrap.appendChild(d);",
    "      } else if (kind === 'toolCall') {",
    "        var tl = el('div', 'tool run'); tl.appendChild(el('span', 't-dot')); tl.appendChild(el('span', 't-name', name || 'tool'));",
    "        body = el('span', 't-detail', ' 正在生成调用参数… 0 字符'); tl.appendChild(body); wrap.appendChild(tl); pdet = body;",
    "        wrap.className = 'prow'; // 占位行标记：工具真正开跑时按 class 全局清除",
    "        var abox = el('pre', 'code'); abox.style.display = 'none'; wrap.appendChild(abox);",
    "        tl.addEventListener('click', function () { abox.style.display = abox.style.display === 'none' ? 'block' : 'none'; });",
    "      } else {",
    "        body = el('div', 'md-p', ''); wrap.appendChild(body);",
    "      }",
    "      liveDiv.appendChild(wrap);",
    "      p = { kind: kind, wrap: wrap, body: body, buf: '', doneLen: 0, tail: null, tailCode: false };",
    "      if (kind === 'toolCall') { p.raw = ''; p.box = abox; }",
    "      liveParts[ci] = p;",
    "    }",
    "    return p;",
    "  }",
    "  function finalizeLive() {",
    "    if (!liveParts) return;",
    "    for (var k in liveParts) {",
    "      var p = liveParts[k];",
    "      if (p && p.kind === 'text' && !p.done) {",
    "        p.done = true;",
    "        appendFinal(p, p.buf.slice(p.doneLen));",
    "        p.doneLen = p.buf.length;",
    "      }",
    "    }",
    "  }",
    "  function liveReset() { liveMsg = null; liveDiv = null; pdet = null; liveParts = null; }",
    "  // 流式 markdown：已完成的行一次性定型不再动，只有当前行/未闭合代码块作为小尾巴更新",
    "  // （整块重渲染有顿挫感；行级增量才是 CC 那种连贯流式）",
    "  var liveRTimer = null;",
    "  function appendFinal(p, chunk) {",
    "    if (!chunk) return;",
    "    if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail);",
    "    p.tail = null;",
    "    var d = document.createElement('div'); renderRich(d, chunk); p.body.appendChild(d);",
    "  }",
    "  function setMdTail(p, text) {",
    "    if (!text) { if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail); p.tail = null; return; }",
    "    if (!p.tail || p.tailCode) {",
    "      if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail);",
    "      p.tail = el('div', 'md-p', ''); p.body.appendChild(p.tail); p.tailCode = false;",
    "    }",
    "    p.tail.textContent = text;",
    "  }",
    "  function streamTick(p) {",
    "    var rest = p.buf.slice(p.doneLen);",
    "    if (p.tailCode) {",
    "      var ci = rest.search(/^```/m);",
    "      if (ci === -1) { if (p.tail) p.tail.textContent = rest; return; }",
    "      var le = rest.indexOf('\\n', ci);",
    "      if (le === -1) { if (p.tail) p.tail.textContent = rest; return; }",
    "      appendFinal(p, rest.slice(0, le + 1));",
    "      p.tailCode = false; p.doneLen += le + 1;",
    "      rest = p.buf.slice(p.doneLen);",
    "    }",
    "    var nl = rest.lastIndexOf('\\n');",
    "    if (nl === -1) { setMdTail(p, rest); return; }",
    "    var complete = rest.slice(0, nl + 1);",
    "    var fences = complete.match(/^```/gm);",
    "    if (fences && fences.length % 2 === 1) {",
    "      var idx = complete.lastIndexOf('\\n```');",
    "      var lineEnd = idx === -1 ? complete.indexOf('\\n') : complete.indexOf('\\n', idx + 1);",
    "      var openEnd = lineEnd + 1;",
    "      appendFinal(p, complete.slice(0, openEnd));",
    "      p.doneLen += openEnd;",
    "      p.tailCode = true;",
    "      p.tail = document.createElement('pre'); p.tail.className = 'code';",
    "      p.body.appendChild(p.tail);",
    "      p.tail.textContent = p.buf.slice(p.doneLen);",
    "      return;",
    "    }",
    "    appendFinal(p, complete);",
    "    p.doneLen += complete.length;",
    "    setMdTail(p, rest.slice(nl + 1));",
    "  }",
    "  function scheduleStream() { if (!liveRTimer) liveRTimer = setTimeout(function () { liveRTimer = null; if (liveParts) for (var k in liveParts) { var p = liveParts[k]; if (p && p.kind === 'text' && !p.done && p.buf.length > p.doneLen) streamTick(p); } scroll(); }, 100); }",
    "  function appendDelta(t, ci) {",
    "    var p = liveBlock(ci, 'text');",
    "    p.buf += t;",
    "    streamTick(p); scroll();", // 事件驱动：每个增量立刻处理，单次成本极小（完成行定型/当前行 textContent），无攒批顿挫
    "  }",
    "  function appendThink(t, ci) {",
    "    var p = liveBlock(ci, 'thinking');",
    "    p.buf += t; p.body.appendChild(document.createTextNode(t));",
    "    scroll();",
    "  }",
    "  function toolStart(id, name, detail, collapsed) {",
    "    var t = el('div', 'tool run');",
    "    t.appendChild(el('span', 't-dot'));",
    "    t.appendChild(el('span', 't-name', name));",
    "    if (detail) { var d = el('span', 't-detail', detail); d.title = detail; t.appendChild(d); linkify(d); }",
    "    var arr = el('span', 't-arrow'); arr.innerHTML = ico('chev', 12); t.appendChild(arr);",
    "    var box = el('div', 'tool-box');",
    "    if (detail) {",
    "      var inRow = el('div', 'tb-row');",
    "      inRow.appendChild(el('span', 'tb-tag', 'IN'));",
    "      inRow.appendChild(el('span', 'tb-val', detail));",
    "      box.appendChild(inRow);",
    "    }",
    "    linkify(box);",
    "    box.style.display = collapsed ? 'none' : 'block';",
    "    if (!collapsed) t.classList.add('open');",
    "    t.addEventListener('click', function () {",
    "      if (!box.textContent) return;",
    "      box.style.display = box.style.display === 'none' ? 'block' : 'none';",
    "      t.classList.toggle('open');",
    "    });",
    "    toolEls[id] = { row: t, box: box };",
    "    messages.appendChild(t);",
    "    messages.appendChild(box);",
    "    scroll();",
    "  }",
    "  function toolEnd(id, name, isError, text, detail) {",
    "    var ref = toolEls[id];",
    "    if (!ref) {",
    "      var b2 = el('div', 'tool-box'); b2.style.display = 'none';",
    "      ref = { row: el('div', 'tool'), box: b2 };",
    "      toolEls[id] = ref;",
    "      messages.appendChild(ref.row);",
    "      messages.appendChild(ref.box);",
    "    }",
    "    var t = ref.row;",
    "    var wasOpen = ref.box.style.display !== 'none';",
    "    t.className = 'tool ' + (isError ? 'err' : 'ok');",
    "    t.innerHTML = '';",
    "    t.appendChild(el('span', 't-dot'));",
    "    t.appendChild(el('span', 't-name', name));",
    "    if (detail) { var d2 = el('span', 't-detail', detail); d2.title = detail; t.appendChild(d2); linkify(d2); }",
    "    var arr2 = el('span', 't-arrow'); arr2.innerHTML = ico('chev', 12); t.appendChild(arr2);",
    "    ref.box.innerHTML = '';",
    "    if (detail) {",
    "      var r1 = el('div', 'tb-row');",
    "      r1.appendChild(el('span', 'tb-tag', 'IN'));",
    "      r1.appendChild(el('span', 'tb-val', detail));",
    "      ref.box.appendChild(r1);",
    "    }",
    "    linkify(ref.box);",
    "    if (text) {",
    "      var r2 = el('div', 'tb-row');",
    "      r2.appendChild(el('span', 'tb-tag', 'OUT'));",
    "      r2.appendChild(el('span', 'tb-val', String(text).slice(0, 1000)));",
    "      ref.box.appendChild(r2);",
    "      t.title = String(text).slice(0, 400);",
    "    }",
    "    if (!ref.box.textContent) { ref.box.style.display = 'none'; }",
    "    if (wasOpen && ref.box.style.display !== 'none') t.classList.add('open');",
    "    scroll();",
    "  }",
    "  function notice(text) { if (/扩展已加载/.test(text)) return; var last = messages.lastElementChild; if (last && last.classList && last.classList.contains('notice') && last.textContent === text) return; var n = el('div', 'notice', text); linkify(n); messages.appendChild(n); scroll(); }",
    "  function textOf(content) {",
    "    if (typeof content === 'string') return content;",
    "    var out = '';",
    "    if (Array.isArray(content)) {",
    "      for (var i = 0; i < content.length; i++) {",
    "        var c = content[i];",
    "        if (c && c.type === 'text' && c.text) out += c.text;",
    "      }",
    "    }",
    "    return out;",
    "  }",
    "  function makeThink(text) {",
    "    var d = document.createElement('details');",
    "    d.className = 'think';",
    "    var s = document.createElement('summary'); s.textContent = '思考过程';",
    "    var body = el('div', 'think-body', text);",
    "    d.appendChild(s); d.appendChild(body);",
    "    return d;",
    "  }",
    "  function renderAll(list) {",
    "    messages.innerHTML = '';",
    "    liveReset();",
    "    toolEls = {};",
    "    if (!list || !list.length) return;",
    "    linkifyEnabled = false; // 老消息不 linkify，循环到最近 15 条时再打开",
    "    var results = {};",
    "    var resultList = [];",
    "    for (var k = 0; k < list.length; k++) {",
    "      var rr = list[k];",
    "      if (rr.role === 'toolResult') {",
    "        var entry = { text: textOf(rr.content), isError: !!rr.isError, used: false };",
    "        results[rr.toolCallId || ''] = entry;",
    "        resultList.push(entry);",
    "      }",
    "    }",
    "    function historyDetail(args) {",
    "      if (!args) return '';",
    "      var v = args.command || args.file_path || args.path || args.url || args.query || args.pattern || args.skill || args.file || args.cmd || '';",
    "      if (!v) { for (var kk in args) { if (typeof args[kk] === 'string' && args[kk]) { v = args[kk]; break; } } }",
    "      return typeof v === 'string' ? v.replace(/\\s+/g, ' ').slice(0, 120) : '';",
    "    }",
    "    function toolGroupRun(name, run, mi) {",
    "      var allOk = true;",
    "      var lines = [];",
    "      for (var gi = 0; gi < run.length; gi++) {",
    "        var g = run[gi];",
    "        var gd = historyDetail(g.arguments);",
    "        var gr = (g.id && results[g.id]) || null;",
    "        if (gr) { gr.used = true; }",
    "        else { for (var gp = 0; gp < resultList.length; gp++) { if (!resultList[gp].used) { gr = resultList[gp]; resultList[gp].used = true; break; } } }",
    "        if (gr && gr.isError) allOk = false;",
    "        var out1 = gr && gr.text ? String(gr.text).replace(/\\s+/g, ' ').slice(0, 80) : '';",
    "        lines.push({ d: gd, out: out1, err: gr ? gr.isError : false });",
    "      }",
    "      var t = el('div', 'tool ' + (allOk ? 'ok' : 'err'));",
    "      t.appendChild(el('span', 't-dot'));",
    "      t.appendChild(el('span', 't-name', name));",
    "      var det0 = lines[0] && lines[0].d ? '  ' + lines[0].d : '';",
    "      var dsum = el('span', 't-detail', '\\u00d7' + run.length + det0);",
    "      dsum.title = lines.map(function(l) { return (l.d || '(无参数)') + (l.out ? '  → ' + l.out : ''); }).join('\\n');",
    "      t.appendChild(dsum); linkify(dsum);",
    "      var arrA = el('span', 't-arrow'); arrA.innerHTML = ico('chev', 12); t.appendChild(arrA);",,
    "      var box = el('div', 'tool-box');",
    "      for (var li = 0; li < lines.length; li++) {",
    "        var row = el('div', 'tb-row');",
    "        var tag = el('span', 'tb-tag'); tag.innerHTML = ico(lines[li].err ? 'x' : 'check', 11);",,
    "        tag.style.color = lines[li].err ? '#f66' : '#4ec96e';",
    "        row.appendChild(tag);",
    "        row.appendChild(el('span', 'tb-val', (lines[li].d || '(无参数)') + (lines[li].out ? ('  \u2192 ' + lines[li].out) : '')));",
    "        box.appendChild(row);",
    "      }",
    "      box.style.display = 'none';",
    "      t.addEventListener('click', function () {",
    "        box.style.display = box.style.display === 'none' ? 'block' : 'none';",
    "        t.classList.toggle('open');",
    "      });",
    "      messages.appendChild(t);",
    "      messages.appendChild(box);",
    "    }",
    "    for (var i = 0; i < list.length; i++) {",
    "      if (i >= list.length - 15) linkifyEnabled = true;",
    "      var m = list[i];",
    "      if (m.role === 'user') {",
    "        var ut = textOf(m.content); var ui = null;",
    "        var ccm = ut.match(/^--- 代码上下文: (.+?) \\((.+?)\\) ---\\n```\\n/);",
    "        if (ccm) {",
    "          ui = ccm[1] + ' ' + ccm[2];",
    "          var ci2 = ut.lastIndexOf('\\n```\\n\\n'); // 附带文件里可能有 ```，取最后一个闭合围栏（与发送时拼接结构对应）",
    "          ut = ci2 > ccm[0].length ? ut.slice(ci2 + 6) : ut.slice(ccm[0].length);",
    "        }",
    "        addUser(ut, m.attachments ? m.attachments.length : 0, ui);",
    "      }",
    "      else if (m.role === 'assistant') {",
    "        var b = el('div', 'bubble assistant');",
    "        var flushB = function () { if (b.childNodes.length) { messages.appendChild(b); b = el('div', 'bubble assistant'); } };",
    "        if (Array.isArray(m.content)) {",
    "          for (var j = 0; j < m.content.length; j++) {",
    "            var c = m.content[j];",
    "            if (c && c.type === 'thinking' && c.thinking) b.appendChild(makeThink(c.thinking));",
    "            else if (c && c.type === 'text' && c.text) { var td = document.createElement('div'); renderRich(td, c.text); b.appendChild(td); }",
    "            else if (c && c.type === 'toolCall') {",
    "              flushB();",
    "              var run = [c];",
    "              while (j + 1 < m.content.length && m.content[j+1] && m.content[j+1].type === 'toolCall' && m.content[j+1].name === c.name) { run.push(m.content[++j]); }",
    "              if (run.length === 1) {",
    "                var hid = c.id || ('h' + i + '_' + j);",
    "                var det = historyDetail(c.arguments);",
    "                toolStart(hid, c.name, det, true);",
    "                var res = (c.id && results[c.id]) || null;",
    "                if (!res) { for (var rp = 0; rp < resultList.length; rp++) { if (!resultList[rp].used) { res = resultList[rp]; break; } } }",
    "                if (res) { res.used = true; toolEnd(hid, c.name, res.isError, res.text, det); }",
    "              } else {",
    "                toolGroupRun(c.name, run, i);",
    "              }",
    "            }",
    "          }",
    "        } else { renderRich(b, textOf(m.content)); }",
    "        flushB();",,
    "      }",
    "      else if (m.role === 'bashExecution') { messages.appendChild(el('div', 'tool ok', '! ' + m.command)); }",
    "    }",
    "    for (var rq = 0; rq < queuedItems.length; rq++) addQueued(queuedItems[rq]);",
    "    scroll();",
    "  }",
    "  function fmtSession(file, name) {",
    "    if (name) return name;",
    "    var s = String(file || '');",
    "    var mm = s.match(/(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})/);",
    "    if (mm) return mm[2] + '-' + mm[3] + ' ' + mm[4] + ':' + mm[5];",
    "    return s.split(/[\\\\/]/).pop() || '临时(未保存)';",
    "  }",
    "  function applyState(m) {",
    "    setStatus(''); // pi 已就绪，清掉「正在启动 pi…」之类的临时状态",
    "    modelEl.innerHTML = ico('cpu') + ' ' + esc(m.model ? (m.model.name || m.model.id) : '—');",
    "    modelEl.title = m.model ? ('切换模型 (当前: ' + (m.model.provider || '') + '/' + (m.model.id || '') + ')') : '切换模型';",
    "    thinkEl.textContent = '思考 ' + (m.thinkingLevel !== null && m.thinkingLevel !== undefined ? m.thinkingLevel : '—');",
    "    var sessName = fmtSession(m.sessionFile, m.sessionName);",
    "    sessionEl.textContent = '会话: ' + sessName;",
    "    sessionEl.title = m.sessionFile ? ('当前: ' + m.sessionFile + '\\n点击切换历史会话') : '点击选择历史会话';",
    "    if (m.stats) {",
    "      var parts = [];",
    "      if (m.stats.contextPercent !== null && m.stats.contextPercent !== undefined) parts.push('上下文 ' + (Math.round(m.stats.contextPercent * 10) / 10) + '%');",
    "      if (m.stats.cost) parts.push('$' + Number(m.stats.cost).toFixed(2));",
    "      usageEl.textContent = parts.join(' · ');",
    "      usageEl.title = parts.join(' · ');",
    "    } else { usageEl.textContent = ''; }",
    "  }",
    "",
    "  function handleFiles(files) {",
    "    var textDone = false;",
    "    for (var i = 0; i < files.length; i++) {",
    "      var f = files[i];",
    "      if (f.type.indexOf('image/') !== 0) {",
    "        // 非图片 → 读成文本注入上下文（一次一个，超 200KB 跳过）",
    "        if (textDone) continue;",
    "        if (f.size > 200 * 1024) { notice('文件超过 200KB，跳过: ' + (f.name || '')); textDone = true; continue; }",
    "        textDone = true;",
    "        (function(file) {",
    "          var r = new FileReader();",
    "          r.onload = function() { vscode.postMessage({ type: 'attachFile', name: file.name || 'file', text: String(r.result || '') }); };",
    "          r.readAsText(file);",
    "        })(f);",
    "        continue;",
    "      }",
    "      if (pendingImages.length >= 4) { notice('最多附 4 张图片'); break; }",
    "      (function(file) {",
    "        var r = new FileReader();",
    "        r.onload = function() {",
    "          var url = String(r.result);",
    "          var data = url.split(',')[1] || '';",
    "          if (!data) return;",
    "          var probe = new Image();",
    "          probe.onload = function() {",
    "            pendingImages.push({ data: data, mimeType: file.type, name: file.name || 'image.png', w: probe.naturalWidth, h: probe.naturalHeight });",
    "            renderAttach();",
    "          };",
    "          probe.src = url;",
    "        };",
    "        r.readAsDataURL(file);",
    "      })(f);",
    "    }",
    "  }",
    "  function renderAttach() {",
    "    attachbarEl.innerHTML = '';",
    "    for (var i = 0; i < pendingImages.length; i++) {",
    "      (function(idx) {",
    "        var p = pendingImages[idx];",
    "        var chip = el('span', 'chip-img');",
    "        var img = document.createElement('img');",
    "        img.src = 'data:' + p.mimeType + ';base64,' + p.data;",
    "        chip.appendChild(img);",
    "        chip.appendChild(document.createTextNode(p.name + ' ' + p.w + '\\u00d7' + p.h));",
    "        var x = el('span', 'chip-x', '\\u00d7');",
    "        x.addEventListener('click', function() { pendingImages.splice(idx, 1); renderAttach(); });",
    "        chip.appendChild(x);",
    "        attachbarEl.appendChild(chip);",
    "      })(i);",
    "    }",
    "    attachbarEl.style.display = pendingImages.length ? 'flex' : 'none';",
    "  }",
    "  function hideSuggest() { suggestEl.style.display = 'none'; }",
    "  function updateSuggest() {",
    "    var t = input.value;",
    "    var m = t.match(/(^|\\s)([\\/@])([^\\s]*)$/);",
    "    if (!m) { hideSuggest(); return; }",
    "    var trigger = m[2], q = m[3];",
    "    if (trigger === '/') {",
    "      sgKind = 'slash';",
    "      if (slashCmds === null) { vscode.postMessage({ type: 'getSlash' }); hideSuggest(); return; }",
    "      var ql = q.toLowerCase();",
    "      var list = slashCmds.filter(function(c) { return ((c.label || c.name || '') + ' ' + (c.description || '')).toLowerCase().indexOf(ql) !== -1; });",
    "      var rows = []; var lastGroup = null;",
    "      for (var i = 0; i < list.length; i++) {",
    "        if (list[i].group && list[i].group !== lastGroup) { lastGroup = list[i].group; rows.push({ header: true, label: list[i].group }); }",
    "        rows.push({ label: list[i].label || ('/' + (list[i].name || '')), detail: list[i].description || '', item: list[i] });",
    "      }",
    "      renderSuggest(rows.slice(0, 80));",
    "    } else {",
    "      sgKind = 'files';",
    "      if (workspaceFiles === null) { vscode.postMessage({ type: 'getFiles' }); hideSuggest(); return; }",
    "      var ql2 = q.toLowerCase();",
    "      var fl = workspaceFiles.filter(function(f) { return f.rel.toLowerCase().indexOf(ql2) !== -1; });",
    "      renderSuggest(fl.slice(0, 50).map(function(f) { return { label: f.rel, detail: f.dir, item: f }; }));",
    "    }",
    "  }",
    "  function renderSuggest(rows) {",
    "    if (!rows.length) { hideSuggest(); return; }",
    "    sgList = rows;",
    "    sgSel = 0; while (sgSel < rows.length && rows[sgSel].header) sgSel++;",
    "    if (sgSel >= rows.length) { hideSuggest(); return; }",
    "    suggestEl.innerHTML = '';",
    "    for (var i = 0; i < rows.length; i++) {",
    "      if (rows[i].header) { suggestEl.appendChild(el('div', 'sg-header', rows[i].label)); continue; }",
    "      (function(idx) {",
    "        var d = el('div', 'sg-item');",
    "        d.appendChild(el('span', 'sg-label', rows[idx].label));",
    "        if (rows[idx].detail) d.appendChild(el('span', 'sg-detail', rows[idx].detail));",
    "        d.addEventListener('mousedown', function(e) { e.preventDefault(); applySuggest(rows[idx].item); });",
    "        d.addEventListener('mouseenter', function() { sgSel = idx; paintSuggest(); });",
    "        suggestEl.appendChild(d);",
    "      })(i);",
    "    }",
    "    suggestEl.style.display = 'block';",
    "    paintSuggest();",
    "  }",
    "  function nextSel(dir) {",
    "    var n = sgSel;",
    "    for (var step = 0; step < sgList.length; step++) {",
    "      n += dir; if (n < 0) n = sgList.length - 1; if (n >= sgList.length) n = 0;",
    "      if (!sgList[n].header) break;",
    "    }",
    "    sgSel = n;",
    "  }",
    "  function paintSuggest() {",
    "    var items = suggestEl.children;",
    "    for (var i = 0; i < items.length; i++) { if (!sgList[i] || !sgList[i].header) items[i].className = 'sg-item' + (i === sgSel ? ' active' : ''); }",
    "    if (items[sgSel]) items[sgSel].scrollIntoView({ block: 'nearest' });",
    "  }",
    "  function applySuggest(item) {",
    "    if (!item || item.header) return; // 防止选中分组标题出现 /undefined",
    "    if (item.builtin === 'mentionFile') { var v = input.value.replace(/[\\s/@]+$/, ''); input.value = (v ? v + ' ' : '') + '@'; hideSuggest(); input.focus(); updateSuggest(); return; }",
    "    if (item.builtin) { if (item.builtin !== 'uploadImage') input.value = ''; hideSuggest(); vscode.postMessage({ type: item.builtin }); return; }",
    "    var t = input.value;",
    "    var m = t.match(/(^|\\s)([\\/@])([^\\s]*)$/);",
    "    var label = sgKind === 'slash' ? ('/' + item.name) : (m && m[2] === '@' ? '@' : '') + item.rel;",
    "    if (m) t = t.slice(0, t.length - m[0].length) + m[1] + label + ' ';",
    "    input.value = t;",
    "    hideSuggest();",
    "    input.focus();",
    "  }",
    "  function send() {",
    "    var t = input.value.trim();",
    "    if (!t && !pendingImages.length) return;",
    "    var imgs = pendingImages.map(function(p) { return { data: p.data, mimeType: p.mimeType }; });",
    "    var attachCode = codeCtx && codeOn;",
    "    input.value = '';",
    "    autoSize();",
    "    pendingImages = []; renderAttach();",
    "    vscode.postMessage({ type: 'prompt', text: t || (imgs.length ? '请看这张图片' : (attachCode ? '请看这段代码' : '')), images: imgs, attachCode: !!attachCode });",
    "  }",
    "  sendBtn.addEventListener('click', send);",
    "  stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'abort' }); });",
    "  fileInput.addEventListener('change', function () { handleFiles(fileInput.files || []); fileInput.value = ''; });",
    "  sessionEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickSession' }); });",
    "  moreEl.addEventListener('click', function () { vscode.postMessage({ type: 'more' }); });",
    "  themeEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickTheme' }); });",
    "  newChatEl.addEventListener('click', function () { vscode.postMessage({ type: 'newSession' }); });",
    "  modelEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickModel' }); });",
    "  thinkEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickThinking' }); });",
    "  modeBadge.addEventListener('click', function () { vscode.postMessage({ type: 'pickMode' }); });",
    "  codechipEl.addEventListener('click', function () { codeOn = !codeOn; renderCodeChip(); });",
    "  input.addEventListener('input', function () { updateSuggest(); autoSize(); });",
    "  // 自适应高度：随内容增长，到 220px 上限后改为内部滚动（消息区不会被挤没）",
    "  function autoSize() {",
    "    input.style.height = 'auto';",
    "    var over = input.scrollHeight > 220;",
    "    input.style.overflowY = over ? 'auto' : 'hidden';",
    "    input.style.height = Math.min(input.scrollHeight, 220) + 'px';",
    "  }",
    "  input.addEventListener('keydown', function (e) {",
    "    var sgOpen = suggestEl.style.display === 'block';",
    "    if (sgOpen) {",
    "      if (e.key === 'ArrowDown') { e.preventDefault(); nextSel(1); paintSuggest(); return; }",
    "      if (e.key === 'ArrowUp') { e.preventDefault(); nextSel(-1); paintSuggest(); return; }",
    "      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); var r0 = sgList[sgSel]; if (r0) applySuggest(r0.item); return; }",
    "      if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }",
    "    }",
    "    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }",
    "    else if (e.key === 'Escape' && !sgOpen) { vscode.postMessage({ type: 'abort' }); }",
    "  });",
    "  input.addEventListener('paste', function (e) {",
    "    var items = (e.clipboardData || {}).items || [];",
    "    var files = [];",
    "    for (var i = 0; i < items.length; i++) {",
    "      if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {",
    "        var f = items[i].getAsFile();",
    "        if (f) files.push(f);",
    "      }",
    "    }",
    "    if (files.length) { e.preventDefault(); handleFiles(files); }",
    "  });",
    "  input.addEventListener('dragover', function (e) { e.preventDefault(); });",
    "  input.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files); });",
    "  window.addEventListener('message', function (ev) {",
    "    var m = ev.data;",
    "    if (m.type === 'user') addUser(m.text, m.imageCount, m.codeInfo);",
    "    else if (m.type === 'newLive') { finalizeLive(); liveReset(); }",
    "    else if (m.type === 'delta') appendDelta(m.text, m.ci);",
    "    else if (m.type === 'thinking') appendThink(m.text, m.ci);",
    "    else if (m.type === 'toolStart') {",
    "      finalizeLive();",
    "      var olds = messages.querySelectorAll('.prow'); for (var oi = 0; oi < olds.length; oi++) olds[oi].parentNode.removeChild(olds[oi]);",
    "      liveReset(); toolStart(m.id, m.name, m.detail);",
    "    }",
    "    else if (m.type === 'toolCallStart') {",
    "      var tp = liveBlock(m.ci, 'toolCall', m.name);",
    "      tp._len = 0; tp.raw = '';",
    "      liveMsg.content[m.ci] = tp; scroll();",
    "    }",
    "    else if (m.type === 'toolCallDelta') { var tb = liveMsg && liveMsg.content[m.ci]; if (tb) { tb._len += (m.chunk || '').length; tb.raw += m.chunk || ''; if (pdet) pdet.textContent = ' 正在生成调用参数… ' + tb._len + ' 字符'; if (tb.box && tb.box.style.display === 'block') tb.box.textContent = tb.raw.slice(-20000); } }",
    "    else if (m.type === 'toolEnd') toolEnd(m.id, m.name, m.isError, m.text, m.detail);",
    "    else if (m.type === 'busy') setBusy(m.value);",
    "    else if (m.type === 'render') setTimeout(function () { renderAll(m.messages); }, 0); // 延后一拍：让刚到的用户气泡先上屏，再慢慢重绘全页",
    "    else if (m.type === 'queue') { queueN = (m.steering ? m.steering.length : 0) + (m.followUp ? m.followUp.length : 0); renderStatus(); }",
    "    else if (m.type === 'notice') notice(m.text);",
    "    else if (m.type === 'status') setStatus(m.text);",
    "    else if (m.type === 'mode') { modeText = m.text || ''; renderStatus(); }",
    "    else if (m.type === 'queuedAdd') addQueued(m);",
    "    else if (m.type === 'queuedDelivered') { removeQueued(m.qid); if (m.show) addUser(m.text, m.imageCount, m.codeInfo); }",
    "    else if (m.type === 'queuedClear') { queuedItems = []; document.getElementById('queuebar').innerHTML = ''; }",
    "    else if (m.type === 'codeCtx') { codeCtx = m.ctx; renderCodeChip(); }",
    "    else if (m.type === 'addImages') { for (var ai = 0; ai < (m.images || []).length; ai++) { if (pendingImages.length < 4) pendingImages.push(m.images[ai]); } renderAttach(); }",
    "    else if (m.type === 'sessionList') { sessionCache = m.sessions || []; renderHistory(); }",
    "    else if (m.type === 'slashList') { slashCmds = m.commands || []; updateSuggest(); }",
    "    else if (m.type === 'fileList') { workspaceFiles = m.files || []; updateSuggest(); }",
    "    else if (m.type === 'state') applyState(m);",
    "    else if (m.type === 'theme') { document.body.setAttribute('data-theme', m.name || 'auto'); }",
    "  });",
    "})();",
  ].join("\n");
}
