import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PiClient } from "./piClient";
import { STRINGS, NATIVE_KEYS, Lang, bb } from "./i18n";
import { getHtml } from "./webview-html";
import type { HostToWebview, WebviewToHost } from "./protocol";
import { extractText, PiCore, UiActions } from "./piCore";
import type { HostCapabilities, HostQuickItem } from "./hostCapabilities";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "piChat.view";

  private view?: vscode.WebviewView;
  /** 核心控制器（piCore）：状态机/prompt 组装/事件路由住核心；本类只当 VS Code adapter（工单四） */
  private readonly core: PiCore;
  private sessionPickerShown = false;
  /** 启动时是否已检测过 pi 安装（避免重复弹窗） */
  private piCheckDone = false;
  /** 本窗口是否已提醒过配置凭证（避免反复打扰） */
  private authOfferShown = false;
  private selTimer: NodeJS.Timeout | undefined;
  private editorDisposables: vscode.Disposable[] = [];
  /** 面板语言（zh 默认 / en），头部 中/EN 按钮切换，globalState 持久化；变更须同步 core.lang */
  private lang: Lang = "zh";
  /** 鸭子 logo 的 data URI（重生成 HTML 时复用，不必每次读盘） */
  private duckUri = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
    private readonly version: string
  ) {
    this.lang = (globalState.get<Lang>("piChat.lang") ?? "zh") as Lang;
    // 组装核心：宿主能力与 UI 动作由本 adapter 注入，webview 消息经 post 桥回传
    this.core = new PiCore(this.buildCaps(), this.buildUi(), (msg) => this.post(msg), version);
    this.core.lang = this.lang;
  }

  /** HostCapabilities 的 VS Code 落地：核心（piCore）所需宿主能力，签名不含 vscode 类型 */
  private buildCaps(): HostCapabilities {
    return {
      getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      getConfig: <T>(section: string, key: string, defaultValue: T): T =>
        vscode.workspace.getConfiguration(section).get<T>(key, defaultValue),
      getPersist: <T>(key: string, defaultValue: T): T => this.globalState.get<T>(key, defaultValue),
      setPersist: (key, value) => void this.globalState.update(key, value),
      showQuickPick: async <T extends HostQuickItem>(items: T[], placeHolder?: string): Promise<T | undefined> =>
        vscode.window.showQuickPick(items, placeHolder ? { placeHolder } : undefined),
      showInputBox: async (options) => vscode.window.showInputBox(options),
      showConfirm: async (title, options) => {
        const sel = await vscode.window.showWarningMessage(
          title,
          { modal: true, detail: options.detail },
          options.confirmText,
          options.cancelText
        );
        return sel === options.confirmText;
      },
      notify: async (level, message, actions) => {
        const items = actions ?? [];
        if (level === "error") return vscode.window.showErrorMessage(message, ...items);
        if (level === "warn") return vscode.window.showWarningMessage(message, ...items);
        return vscode.window.showInformationMessage(message, ...items);
      },
      uiRequest: (req) => void this.core.handleUiRequest(req),
    };
  }

  /** UiActions 的 VS Code 落地：webview 消息路由里属于原生 UI 流程的分支，方法体即原 panel 实现 */
  private buildUi(): UiActions {
    return {
      pickSession: (scope) => this.pickSession(scope),
      treeFork: () => this.forkToMessage(),
      importSession: () => this.importSession(),
      shareSession: () => this.shareSession(),
      uploadImage: () => this.pickLocalFiles(),
      pickMode: () => this.pickModeMenu(),
      revealSessionFile: (file) => this.revealSessionFile(file),
      openPath: (p) => this.openFilePath(p),
      more: () => this.runCommand(),
      settings: () => this.settingsMenu(),
      pickModel: () => this.pickModel(),
      pickThinking: () => this.pickThinking(),
      pickTheme: () => this.pickTheme(),
      pickLang: () => this.toggleLang(),
      compactSession: () => this.compactSession(),
      exportSession: () => this.exportSession(),
      cloneSession: () => this.cloneSession(),
      openTerminalLogin: () => this.openTerminalLogin(),
      startError: (err) => this.onStartError(err),
    };
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
    if (this.core.clientRef?.running) {
      void (async () => {
        try {
          const d = await this.core.clientRef!.getMessages();
          this.post({ type: "render", messages: d?.messages ?? [] });
          this.post({ type: "busy", value: this.core.isBusy });
        } catch {
          // ignore
        }
        await this.core.refreshState();
      })();
    } else if (
      vscode.workspace.getConfiguration("piChat").get<string>("sessionMode", "continue") !== "ephemeral"
    ) {
      // 首次打开面板 → 主动启动 pi（持久模式，continue/-c 恢复最近会话）：
      // 启动完成后 webviewReady 握手会拉历史重绘，重开插件立刻看到上次聊天
      this.core.ensureClient();
    }
    view.webview.onDidReceiveMessage((m: WebviewToHost) => void this.core.onWebviewMessage(m));

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
            const c = this.core.ensureClient();
            void c;
            // pi 已装但没配过模型凭证 → 引导配置
            void this.maybeOfferKeyConfig(false);
          }
        })();
      } else if (!this.core.clientRef) {
        const c = this.core.ensureClient();
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
    this.core.dispose();
    for (const d of this.editorDisposables) d.dispose();
    this.editorDisposables = [];
    if (this.selTimer) clearTimeout(this.selTimer);
  }

  private post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  /** 计算当前编辑器的代码上下文（选区 → 选中行；无选区 → 整个文件）并推给 webview；
   *  上下文本体存核心（prompt 组装消费），本方法只负责计算+推送（工单四接线） */
  private pushCodeContext(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== "file") {
      if (this.core.hasCodeContext) {
        this.core.setCodeContext(null);
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
        this.core.setCodeContext(null);
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
    this.core.setCodeContext({ name: path.basename(doc.fileName), rel, range, text });
    this.post({
      type: "codeCtx",
      ctx: { name: path.basename(doc.fileName), rel, range, lines: text.split("\n").length },
    });
  }

  /** 中/EN 语言切换：持久化后重生成 HTML（webviewReady 握手会自动重绘历史） */
  private async toggleLang(): Promise<void> {
    this.lang = this.lang === "zh" ? "en" : "zh";
    this.core.lang = this.lang; // 核心的通知/状态文案跟随
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

  /**
   * 弹出历史会话选择。
   * scope="project" 只显示当前工作空间的会话；"all" 显示全部；"auto"=项目会话+浏览全部入口（面板打开时用）。
   */
  private async pickSession(scope: "project" | "all" | "auto" = "project"): Promise<void> {
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // ephemeral 进程没挂会话文件，需要重启为持久模式才能恢复历史
    if (this.core.clientRef?.running && this.core.isNoSession) {
      this.core.disposeClient();
      this.post({ type: "status", text: this.L.restartingPi });
    }

    const sessions = scope === "all" ? listSessions() : listSessions(wsPath);

    // 注意：不能用 kind 作字段名，会和 QuickPickItem 内置的 QuickPickItemKind 枚举冲突
    type Item = {
      label: string;
      description?: string;
      detail?: string;
      action: "file" | "new" | "all" | "delete";
      file?: string;
    };
    const items: Item[] = [];
    if (scope !== "all") {
      items.push({ label: this.L.startNewSession, action: "new" });
      if (scope === "auto") {
        items.push({ label: this.L.browseAllSessions, action: "all" });
      }
    }
    // 删除入口独立于会话条目：避免误触（条目点击=切换，删除走二级选择+确认）
    items.push({ label: this.L.delSessionEntry, action: "delete" });
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
    if (pick.action === "delete") {
      await this.deleteSessionPick(scope);
      return;
    }

    const client = this.core.ensureClient(true);
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
      await this.core.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.sessionOpFail + (err?.message ?? err) });
    }
  }

  /** 删除历史会话：二级选择 + 确认弹窗（破坏性不可逆）。
   *  守卫：① 当前打开的会话不删（pi 还在追加写入，删了数据丢失且进程行为未定义）；
   *  ② 路径必须位于 sessions 目录内（listSessions 虽然只从这里收，但 webview 直删
   *  死链曾有过裸 rmSync，这里把校验补在唯一用户可达的删除路径上） */
  private async deleteSessionPick(scope: "project" | "all" | "auto"): Promise<void> {
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const sessions = scope === "all" ? listSessions() : listSessions(wsPath);
    if (!sessions.length) {
      this.post({ type: "notice", text: this.L.noSessions });
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: "$(trash) " + (s.name || s.preview || path.basename(s.file)),
        description: s.cwd || undefined,
        detail: s.time + "  ·  " + s.file,
        file: s.file,
      })),
      { placeHolder: this.L.delSessionEntry }
    );
    if (!pick) return;
    if (this.core.currentSessionFile && samePath(pick.file, this.core.currentSessionFile)) {
      this.post({ type: "notice", text: this.L.delSessionCur });
      return;
    }
    const root = path.join(os.homedir(), ".pi", "agent", "sessions");
    let real: string;
    try {
      real = fs.realpathSync(pick.file);
    } catch {
      this.post({ type: "notice", text: this.L.delSessionFail + "file not found" });
      return;
    }
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) {
      this.post({ type: "notice", text: this.L.delSessionFail + "outside sessions dir" });
      return;
    }
    const yes = await vscode.window.showWarningMessage(
      this.L.delSessionAsk,
      { modal: true, detail: path.basename(pick.file) },
      this.L.delete
    );
    if (yes !== this.L.delete) return;
    try {
      fs.rmSync(real, { force: true });
      this.post({ type: "notice", text: this.L.delSessionDone + path.basename(real) });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.delSessionFail + (err?.message ?? err) });
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
      this.core.setModeText(badge);
      this.post({ type: "mode", text: badge });
      this.post({ type: "notice", text: this.L.modeSet + pick.label.replace(/^\$\([^)]*\) /, "") });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.modeSaveFail + (err?.message ?? err) });
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
    if (this.core.clientRef?.running && this.core.isNoSession) {
      this.core.disposeClient();
    }
    const client = this.core.ensureClient(true);
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
          await this.compactSession(true);
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
          await this.exportSession();
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
          await this.cloneSession();
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

  /** 压缩上下文。withNote=true 时先问可选指令（⚡ 菜单入口，用户主动选的不算打扰）；
   *  /compact 直接压不二次确认——用户实测：敲完命令再弹框属于繁琐 */
  private async compactSession(withNote = false): Promise<void> {
    const client = this.core.ensureClient(true);
    let inst: string | undefined;
    if (withNote) {
      inst = await vscode.window.showInputBox({ prompt: this.L.compactPrompt });
      if (inst === undefined) return;
    }
    this.post({ type: "status", text: this.L.compacting });
    const r = await client.compact(inst || undefined);
    this.post({ type: "status", text: "" });
    this.post({
      type: "notice",
      text: r?.result
        ? this.L.compactDone + (r.result.tokensBefore ?? "?") + " → ≈ " + (r.result.estimatedTokensAfter ?? "?") + " tokens"
        : this.L.compactEnded,
    });
  }

  /** 导出会话为 HTML（⚡ 菜单与 /export 共用） */
  private async exportSession(): Promise<void> {
    const client = this.core.ensureClient(true);
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
  }

  /** 克隆当前会话（⚡ 菜单与 /clone 共用） */
  private async cloneSession(): Promise<void> {
    const client = this.core.ensureClient(true);
    const r = await client.clone();
    if (r?.cancelled) return;
    this.post({ type: "notice", text: this.L.cloned });
  }

  /** 会话树导航：列出活跃分支上的用户消息，选一条从那里继续（对应 pi TUI 的 /tree，RPC 走 fork） */
  private async forkToMessage(): Promise<void> {
    const client = this.core.ensureClient(true);
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
    if (this.core.clientRef?.running && this.core.isNoSession) {
      this.core.disposeClient();
    }
    const client = this.core.ensureClient(true);
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
      await this.core.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.sessionOpFail + (err?.message ?? err) });
    }
  }

  /** 分享会话：导出 HTML 并在浏览器打开，把文件发给对方即可（GitHub gist 自动分享需终端版 /share） */
  private async shareSession(): Promise<void> {
    const client = this.core.ensureClient(true);
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
        // 直接本地弹选择并写 mode.json（与状态栏徽标同路）。
        // 不走 client.prompt("/mode")：那会让面板乐观置 busy，为一个纯 UI 命令假忙 4s
        await this.pickModeMenu();
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
    if (this.core.clientRef?.running && this.core.isNoSession) {
      this.core.disposeClient();
    }
    const client = this.core.ensureClient(true);
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
        const c = this.core.ensureClient();
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
        if (!this.core.clientRef?.running) this.core.disposeClient();
        const c = this.core.ensureClient();
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
    const client = this.core.ensureClient();
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
      await this.core.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.switchFail + (err?.message ?? err) });
    }
  }

  private async pickThinking(): Promise<void> {
    const client = this.core.ensureClient();
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
      await this.core.refreshState();
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.setFail + (err?.message ?? err) });
    }
  }

  /** 历史面板 📄 按钮：在旁栏打开会话 .jsonl 文件（原 webview case 内联体，提方法供 UiActions） */
  private async revealSessionFile(file: string): Promise<void> {
    try {
      const sdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(sdoc.uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.openSessionFileFail + (err?.message ?? err) });
    }
  }

  /** pi 启动失败（找不到命令等）：面板通知 + 原生错误框提供一键安装（原 client.onError 内联体） */
  private onStartError(err: Error): void {
    this.post({ type: "notice", text: this.L.startFail + err.message });
    void vscode.window
      .showErrorMessage(this.L.piStartFail + err.message, this.L.installPiBtn)
      .then((pick) => {
        if (pick === this.L.installPiBtn) void this.installPi();
      });
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
