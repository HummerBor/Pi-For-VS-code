import { spawn } from "child_process";

/** 标签栏持久化条目（按工作区分桶，见 TAB_BAR_BY_WS_KEY） */
interface SavedTabBar { tabs: { id: string; title: string }[]; active: string; }
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { PiClient } from "./piClient";
import { STRINGS, NATIVE_KEYS, Lang, bb } from "./i18n";
import { getHtml } from "./webview-html";
import { loadPiSdk } from "./piSdk";
import type { ChangesFileInfo, HostToWebview, HostToWebviewTagged, TabInfo, ToolChangedFile, WebviewToHostTagged } from "./protocol";
import { reverseApplyPatch } from "./patchRevert";
import { extractText, PiCore, UiActions } from "./piCore";
import type { HostCapabilities, HostQuickItem } from "./hostCapabilities";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "piChat.view";

  private view?: vscode.WebviewView;
  /** 工单十五刀1：核心多实例——每个标签一个 PiCore（独立 PiClient/AgentSession，可同时各自 busy）。
   *  panel 持 Map<tabId, PiCore>；活动标签 id 见 activeTabId。刀2 落标签栏 UI，
   *  刀3 落会话语义（lastSessionByWs 按标签、模型/思考记忆按标签等）；本刀只铺路由，UI 仍单标签。 */
  private readonly cores = new Map<string, PiCore>();
  /** 活动标签（webview 当前显示的标签）；webview 端由 tabs 消息同步（工单十五刀2） */
  private activeTabId = "t1";
  private tabSeq = 1;
  /** 工单十五刀4：「＋新建标签」登记簿——ensureCore 创建核心时置 freshTab=true（新标签
   *  必须开新持久会话，禁止 continueRecent 接别的标签正在写的文件）；核心创建后登记即销 */
  private readonly freshTabs = new Set<string>();
  /** 工单十五刀2：标签元数据（宿主是唯一事实源）：标题随各核心 state 记账、busy 随 busy 记账，
   *  未读随后台跑完记账（刀5：webview 零影子状态，未读点也归宿主） */
  private tabMeta = new Map<string, { title: string; busy: boolean; unread?: boolean }>();
  /** 标签栏持久化（用户直令 09-18「按1」）：重启前聊在非 t1 标签、重启后标签栏整体消失，
   *  活动标签退回 t1 → 恢复的是 t1 名下的陈旧会话记忆（lastSessionByWs2 按标签存），
   *  把 -c 已接对的最近会话顶掉（用户实测：重启后打开的是上午的会话，不是重启前聊的）。
   *  治本 = 标签栏（id/顺序/标题/活动标签）落 globalState，重启按原样重建；各标签沿用
   *  自己的 tabKey 恢复各自记忆的会话，语义自然成立。busy/unread 是会话态不落盘；
   *  freshTabs 绝不落盘——恢复的标签一律按既有记忆恢复，只有「＋新建」才开新会话 */
  private static readonly TAB_BAR_KEY = "piChat.tabBar";
  /** 标签栏按工作区分桶（2026-09-20 事故：globalState 跨项目共享，A 项目的标签原样
   *  长进 B 项目的面板——串项目）。照 lastSessionByWs2 的 cwdKey 模式分桶 */
  private static readonly TAB_BAR_BY_WS_KEY = "piChat.tabBarByWs";
  /** 重启时从持久化重建的标签 id：首次切到时尚无 pi 进程，要起新进程按该标签记忆恢复会话
   *  （普通「没启动过的标签」切到只清空显示不起进程——那是新建/关剩补位的语义，见 handleTabSwitch） */
  private readonly restoredTabs = new Set<string>();
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

  // ── 工单七：本次改动（git diff 可视化）宿主侧状态。git/还原语义全在本 adapter，核心只产中性事件 ──
  // 三期 per-tab 化（2026-09-20 用户实测「其他会话看的也是同一个改动条」）：原是 panel 全局
  // 单份（单会话时代遗产），多页签下归属错乱——A 页签 run 结束时条画进当时活动的 B 视图。
  // 现 keys=tabId；「查看/关闭」只在活动视图的条上发生，取 activeTabId 即可
  private changesTab = new Map<
    string,
    {
      files: ChangesFileInfo[];
      detail: Map<string, { source: "tool" | "git"; tool: string; patches: string[]; canGit: boolean; inHead: boolean; preexisting: boolean }>;
      dismissed: boolean;
      startP: Promise<Map<string, string> | null> | null;
      lastStateFile: string | null;
    }
  >();
  private changesOf(tabId: string) {
    let s = this.changesTab.get(tabId);
    if (!s) {
      s = { files: [], detail: new Map(), dismissed: false, startP: null, lastStateFile: null };
      this.changesTab.set(tabId, s);
    }
    return s;
  }
  /** HEAD 版本内容只读文档提供器（vscode.diff 左侧用，懒注册一次） */
  private headProvider = vscode.workspace.registerTextDocumentContentProvider("pi-head", {
    provideTextDocumentContent: (uri) => this.headContent(uri),
  });

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
    private readonly version: string
  ) {
    this.lang = (globalState.get<Lang>("piChat.lang") ?? "zh") as Lang;
    // 标签栏重建必须先于一切 ensureCore/postTabs：活动标签 id 决定首个核心的 tabKey，
    // 进而决定恢复哪个标签记忆的会话（顺序错了等于白存）
    this.restoreTabBar();
    // 核心创建延迟到首次访问（ensureCore）：多标签时代每个标签各自组装，构造器不再预建单例
  }

  /** 从 globalState 重建标签栏（构造器调用一次）。形状不对整体放弃回单标签——
   *  持久化数据不可信时，退回旧行为（单 t1）比半恢复安全 */
  private restoreTabBar(): void {
    const wsKey = this.wsKey();
    const byWs = this.globalState.get<Record<string, SavedTabBar>>(
      ChatPanelProvider.TAB_BAR_BY_WS_KEY, {});
    let saved = byWs[wsKey];
    if (!saved) {
      // 旧全局 key 一次性收编：旧数据不知道属于哪个工作区，按当前工作区认领
      // （分桶前只有单工作区场景，大概率正确）；收编后写回新桶，下次不再走 legacy
      const legacy = this.globalState.get<SavedTabBar | undefined>(ChatPanelProvider.TAB_BAR_KEY, undefined);
      if (legacy?.tabs?.length) { saved = legacy; byWs[wsKey] = saved; void this.globalState.update(ChatPanelProvider.TAB_BAR_BY_WS_KEY, byWs); }
    }
    if (!saved?.tabs?.length) return;
    let maxSeq = 0;
    for (const t of saved.tabs) {
      if (typeof t?.id !== "string" || !/^t\d+$/.test(t.id)) return;
      const n = parseInt(t.id.slice(1), 10);
      if (n > maxSeq) maxSeq = n;
      this.tabMeta.set(t.id, { title: t.title || this.L.tabUntitled, busy: false });
      this.restoredTabs.add(t.id);
    }
    this.tabSeq = maxSeq;
    // 活动标签失效（如跨版本手改）兑底到最后一个，不猜第一个
    this.activeTabId = saved.tabs.some((t) => t.id === saved.active)
      ? saved.active
      : saved.tabs[saved.tabs.length - 1].id;
  }

  /** 标签栏落盘（id/顺序/标题/活动标签）——按工作区分桶（globalState 跨项目共享，
   *  不分桶会把 A 项目的标签长进 B 项目，2026-09-20 串项目事故） */
  private saveTabBar(): void {
    const tabs = [...this.tabMeta.entries()].map(([id, m]) => ({ id, title: m.title }));
    const saved: SavedTabBar = { tabs, active: this.activeTabId };
    const byWs = this.globalState.get<Record<string, SavedTabBar>>(ChatPanelProvider.TAB_BAR_BY_WS_KEY, {});
    byWs[this.wsKey()] = saved;
    void this.globalState.update(ChatPanelProvider.TAB_BAR_BY_WS_KEY, byWs);
  }

  private wsKey(): string {
    return (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "")
      .replace(/\\+$/, "").toLowerCase();
  }

  /** 取（或创建）指定标签的核心控制器（工单十五刀1）。创建即接线：post 桥打 tabId 标、
   *  工单七 run 边界回调接 adapter；caps/ui 每实例一份（闭包无共享状态，安全）。
   *  core.lang 只在创建时同步：语言切换走 applyHtml 重载 webview，webviewReady 握手后
   *  重绘链路经核心；后台标签保持旧语言到下次创建——可接受，刀3 会话语义再按标签收口 */
  private ensureCore(tabId: string): PiCore {
    let core = this.cores.get(tabId);
    if (!core) {
      core = new PiCore(this.buildCaps(), this.buildUi(), (msg) => this.pipeFromCore(msg, tabId), this.version);
      core.lang = this.lang;
      core.tabKey = tabId; // 每标签持久化键（工单十五刀3：项目会话/模型/思考记忆按标签）
      // 工单十五刀4：＋新建的标签 = 新会话（SessionManager.create，禁 continueRecent）
      core.freshTab = this.freshTabs.has(tabId);
      this.freshTabs.delete(tabId);
      // 工单七 run 边界回调：agent_start 快照 / agent_settled 接收工具命中清单（合并 git 比对在 handleRunSettled）
      core.onRunStart = () => this.snapshotGitStatus(tabId); // 回调捕获 tabId：后台页签的 run 也归自己
      core.onRunSettled = (files) => void this.handleRunSettled(tabId, files);
      this.cores.set(tabId, core);
    }
    return core;
  }

  /** 活动标签的核心。历史 QuickPick/⚡菜单/设置等宿主 UI 流程一律作用于活动标签
   *  （工单十五刀3 口径预埋）；单标签时代与原 this.core 字段行为等价 */
  private get core(): PiCore {
    return this.ensureCore(this.activeTabId);
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
      resolveUris: async (uris) => {
        const out: { name: string; path: string }[] = [];
        for (const u of uris) {
          try {
            const fsPath = vscode.Uri.parse(u).fsPath;
            if (fsPath && fs.statSync(fsPath).isFile()) out.push({ name: path.basename(fsPath), path: fsPath });
          } catch { /* 拖入项不是本地文件（远端/虚拟文档）→ 丢弃 */ }
        }
        return out;
      },
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
      showChanges: () => this.showChangesFlow(),
      dismissChanges: async () => {
        // 条只属活动视图，点击必在活动页签（工单七 per-tab 化：后台条点不到）
        const s = this.changesOf(this.activeTabId);
        s.dismissed = true;
        this.postChangesList(this.activeTabId);
      },
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
    let op = c.get<number>("backgroundOpacity", 0.35);
    // opacity 钳位 [0,1]（工单九-3）：配置可为任意字符串，裸注入会污染 style 属性
    if (typeof op !== "number" || Number.isNaN(op)) op = 0.35;
    op = Math.min(1, Math.max(0, op));
    let url = "";
    if (img) {
      // http(s) 分支：new URL() 解析 + 协议白名单，替代裸正则前缀匹配（工单九-1）。
      // 恶意串如 https://x</style><script> 在 URL 解析层即被拒（<> 非法 → throw）；
      // 用规范化后的 u.href（危险字符被百分号编码）而非原串，注入面再收窄一道。
      // javascript:/data:/ftp: 等均可被 new URL 解析，故必须协议白名单而非“解析成功即放行”。
      if (/^https?:\/\//i.test(img)) {
        try {
          const u = new URL(img);
          url = u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
        } catch {
          url = ""; // new URL 解析失败（含 <> 等非法字符）→ 不启用
        }
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
    // 背景图注入前 HTML/CSS 值消毒（工单九-2）：注入点是 url('${bgImage}')，单引号已转 %27，
    // 补 < > & " 实体转义。这是第一道防线，CSP nonce 是最后防线（挡无 nonce 的 script 与
    // 内联事件），两者不重复依赖，别删任一道。先转 & 防 < > 转出的实体里的 & 被二次转义；
    // base64 data URI 无这些字符，转义无副作用。
    const sanitized = url
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "%27");
    view.webview.html = getHtml(theme, this.duckUri, floorColor, sanitized, op, this.lang);
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
    view.webview.onDidReceiveMessage((m: WebviewToHostTagged) => {
      // 工单七：变更条随握手重发（横幅同款语义），webview 重建后不丢
      if (m.type === "webviewReady") {
        // 工单七：变更条随握手重发（横幅同款语义），webview 重建后不丢——三期 per-tab：逐页签各发各的
        for (const [tid, s] of this.changesTab) if (s.files.length) this.postChangesList(tid);
        // 工单十五刀2：标签清单随握手下发（webview 启动即渲染标签条）
        this.postTabs();
        // 工单24 架构归位：webview 重载后每页签的树都空了，给所有已建核心各发一次快照——
        // 后台页签的流式事件要写进它们自己的隐藏树，没有历史底子就会从半截开始累积
        for (const [, c] of this.cores) void c.postUiState();
        // 工单十三二刀-3：后台预热 listSessions → 填 mtime 缓存，首次点击也毫秒级出列。
        // fire-and-forget（不 await）+ 错误静默：预热失败不影响面板，pi 包提前加载更早触发
        void listSessions().catch(() => {});
      }
      // 工单十五刀2：标签栏控制消息是 panel 级（不过核心），先于核心路由拦截
      if (m.type === "tabNew") { this.handleTabNew(); return; }
      if (m.type === "tabSwitch") {
        this.handleTabSwitch(m.tabId);
        // 工单24 架构归位：webview 未建树的页签随切换要一次快照（切页签零重拉的唯一例外）
        if ((m as { needState?: boolean }).needState) {
          const c = this.ensureCore(m.tabId);
          if (c.clientRef?.running) void c.postUiState();
          else this.postEmptyUiState(m.tabId);
        }
        return;
      }
      if (m.type === "tabClose") { void this.handleTabClose(m.tabId); return; }
      // 工单十五刀1：webview→宿主按 tabId 路由——消息带已知标签 id 走对应核心；
      // 未标（启动握手期）或带已关闭标签 id 的兑底落活动标签
      const core = (m.tabId && this.cores.get(m.tabId)) || this.ensureCore(this.activeTabId);
      void core.onWebviewMessage(m);
    });

    // 监听编辑器选区，自动把选中代码 / 整个文件作为上下文（CC 同款）
    if (!this.editorDisposables.length) {
      this.editorDisposables.push(
        vscode.window.onDidChangeActiveTextEditor(() => this.pushCodeContext()),
        // 关 tab 必触发：activeTextEditor 在「焦点落入 webview 预览/面板」时会滞留为已关
        // 编辑器（VS Code 陈旧行为），只靠上面两个事件胶囊永远不刷新（用户实测：关了
        // tsconfig.json 胶囊还在，且下条消息会静默附上已关文件）——复用选区防抖重算
        vscode.window.onDidChangeVisibleTextEditors(() => {
          if (this.selTimer) clearTimeout(this.selTimer);
          this.selTimer = setTimeout(() => this.pushCodeContext(), 250);
        }),
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
    // 工单十五：全部标签的核心一起回收（dispose 链各核心互不共享 PiClient）
    for (const core of this.cores.values()) core.dispose();
    this.cores.clear();
    for (const d of this.editorDisposables) d.dispose();
    this.editorDisposables = [];
    if (this.selTimer) clearTimeout(this.selTimer);
  }

  /** 宿主→webview 全消息打 tabId 标（工单十五刀1，协议见 protocol.ts TabTag）：
   *  核心桥转发的消息带所属标签 id；宿主直发的 UI 流程（附件回发/重绘等）归活动标签 */
  private post(msg: HostToWebviewTagged, tabId?: string): void {
    if (tabId !== undefined) msg.tabId = tabId;
    else if (msg.tabId === undefined) msg.tabId = this.activeTabId;
    void this.view?.webview.postMessage(msg);
  }

  // ════════ 工单十五刀2：标签栏宿主侧 ════════

  /** 会话标题格式化（webview fmtSession 同款口径：名字 > 文件名内的时间戳 > 裸文件名） */
  private fmtSessionTitle(file: string | null): string {
    if (!file) return this.L.tabUntitled;
    const mm = file.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
    if (mm) return mm[2] + "-" + mm[3] + " " + mm[4] + ":" + mm[5];
    return path.basename(file) || this.L.tabUntitled;
  }

  /** 下发标签栏全量状态（唯一事实源）：webview 只渲染，本地只叠 dirty 未读点 */
  private postTabs(): void {
    // 活动标签元数据兑底：核心懒创建时（新标签未发消息）syncTabMeta 尚未跑过，也要出现在清单里
    if (!this.tabMeta.has(this.activeTabId)) {
      this.tabMeta.set(this.activeTabId, { title: this.L.tabUntitled, busy: false });
    }
    const tabs: TabInfo[] = [];
    for (const [id, m] of this.tabMeta) tabs.push({ id, title: m.title, busy: m.busy, unread: m.unread });
    this.post({ type: "tabs", tabs, activeTabId: this.activeTabId });
  }

  /** 标签元数据记账：标题随核心 state（sessionName/sessionFile）、busy 随核心 busy；
   *  变化即重发 tabs（高频 delta 不经过这里，只 busy/state 两类低频消息触发） */
  private syncTabMeta(msg: HostToWebview, tabId: string): void {
    let meta = this.tabMeta.get(tabId);
    if (!meta) {
      meta = { title: this.L.tabUntitled, busy: false };
      this.tabMeta.set(tabId, meta);
    }
    let changed = false;
    let titleDirty = false;
    if (msg.type === "busy") {
      if (meta.busy !== msg.value) { meta.busy = msg.value; changed = true; }
    } else if (msg.type === "state") {
      const t = msg.sessionName || this.fmtSessionTitle(msg.sessionFile ?? null);
      if (t && meta.title !== t) { meta.title = t; changed = true; titleDirty = true; }
    }
    if (changed) this.postTabs();
    // 标题变了才落盘：busy/unread 高频变化不碰 globalState
    if (titleDirty) this.saveTabBar();
  }

  // ════════ 工单十五刀2：标签生命周期（panel 级，不过核心） ════════

  /** 新标签 = 新空会话：只登记元数据，PiCore 懒创建（首条消息/切历史时 ensureCore 才建） */
  private handleTabNew(): void {
    const id = "t" + (++this.tabSeq);
    this.tabMeta.set(id, { title: this.L.tabUntitled, busy: false });
    this.freshTabs.add(id); // 刀4：新标签=新持久会话（ensureCore 时置 core.freshTab）
    this.activeTabId = id;
    this.postTabs();
    this.saveTabBar(); // 新标签立刻入册，中途崩进程也不丢标签栏
    // 刀5：单一渲染上下文，新页签的一切旧现场都得显式清（刀2 时代每页签自带欢迎页 DOM，
    // 这项真空是刀5 引入的——用户实测「新建了会话但内容还是上一个的」）
    this.postEmptyUiState(id);
    // 立即起会话（刀4 freshTab→SessionManager.create）：模型/思考记忆当场恢复上屏，
    // 页脚不再显示「—」/「临时(未保存)」——与 t1 面板打开即 prewarm 同口径。
    // forceSession=true：新标签=新持久会话是本单铁语义，不受 sessionMode=ephemeral 影响
    this.ensureCore(id).ensureClient(true);
  }

  /** 工单十八：空页签的原子空快照——原先散发 state/render（部分分支还漏 queuedClear/banner/
   *  busy:false），A 页签的 Working/排队/横幅残留到 B（串显/两套 DOM）。一条 uiState 打包
   *  全部区域的空值，漏发在架构上不可能 */
  private postEmptyUiState(tabId: string): void {
    this.post({
      type: "uiState",
      tabId,
      messages: [],
      busy: false,
      compacting: false, // 空页签无压缩窗口；同 busy 口径必发，漏发在架构上不可能
      modeText: "",
      banner: null,
      queued: [],
      model: null,
      thinkingLevel: null,
      sessionFile: null,
      sessionName: null,
      stats: null,
    });
  }

  /** 切换活动标签（工单24 架构归位：切页签零重拉——webview 每页签一棵 DOM，O(1) 换可见性；
   *  未建树的页签由 webview 随 tabSwitch 带 needState 来要快照，这里是唯一例外路径） */
  private handleTabSwitch(tabId: string): void {
    if (!this.tabMeta.has(tabId) || tabId === this.activeTabId) return;
    this.activeTabId = tabId;
    const meta = this.tabMeta.get(tabId);
    if (meta) meta.unread = false;
    this.postTabs();
    this.saveTabBar();
    // 标签栏持久化：重启恢复的标签首次切到时必须起进程——piCore.ensureClient 会按
    // 该标签 tabKey 的会话记忆 switchSession 恢复历史（先清空再异步渲染，同 t1 启动口径）。
    // 不起进程的话用户切回重启前聊天的标签只看到欢迎页，「恢复现场」名存实亡。
    // 恢复后的历史由 init 链路的 render/webviewReady 全量快照送进该页签自己的树
    if (this.restoredTabs.delete(tabId)) this.ensureCore(tabId).ensureClient();
  }

  /** 关标签：进程在跑时必须确认（中断任务属破坏性动作，同 newSession 口径）；
   *  关活动标签时转移到剩余最后一个（无剩余则补一个空标签），并 dispose 回收 pi 会话资源 */
  private async handleTabClose(tabId: string): Promise<void> {
    const core = this.cores.get(tabId);
    if (core?.isBusy) {
      const yes = await vscode.window.showWarningMessage(this.L.tabCloseBusyAsk, { modal: true }, this.L.tabCloseYes);
      if (yes !== this.L.tabCloseYes) return;
      try { await core.clientRef?.abort(); } catch { /* ignore */ }
    }
    core?.dispose();
    this.cores.delete(tabId);
    this.tabMeta.delete(tabId);
    this.restoredTabs.delete(tabId); // 关了就不算恢复现场（id 永不复用，纯卫生）
    if (tabId === this.activeTabId) {
      const rest = [...this.tabMeta.keys()];
      if (rest.length) {
        this.activeTabId = rest[rest.length - 1];
      } else {
        const nid = "t" + (++this.tabSeq);
        this.tabMeta.set(nid, { title: this.L.tabUntitled, busy: false });
        this.freshTabs.add(nid);
        this.activeTabId = nid;
        this.postEmptyUiState(nid);
        this.ensureCore(nid).ensureClient(true); // 同 handleTabNew：立即起会话恢复模型记忆
      }
      const next = this.cores.get(this.activeTabId);
      // 工单24 架构归位：转移后的活动页签不再盲发快照——webview 树若未建，
      // 会随 tabs 消息驱动的 activateTab 带 needState 来要（切页签零重拉）
      if (next && !next.clientRef?.running) this.postEmptyUiState(this.activeTabId);
    }
    this.postTabs();
    this.saveTabBar(); // 标签增减/活动标签变化都要落盘，重启才还原得住
  }

  /** 计算当前编辑器的代码上下文（选区 → 选中行；无选区 → 整个文件）并推给 webview；
   *  上下文本体存核心（prompt 组装消费），本方法只负责计算+推送（工单四接线） */
  private pushCodeContext(): void {
    const ed = vscode.window.activeTextEditor;
    // 滞留守卫：焦点落入 webview 预览/终端时 activeTextEditor 可能还是刚关掉的编辑器，
    // 不在可见列表 = 已关 → 清上下文（否则胶囊滞留 + 下条消息静默附已关文件）
    if (!ed || !vscode.window.visibleTextEditors.includes(ed) || ed.document.uri.scheme !== "file") {
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
    const t0 = Date.now(); // 工单十三二刀-1 计时：消息到达
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // 工单十五刀4（用户直令 2026-09-14）：多标签时代 busy 不再一刀切禁历史——
    // busy 中选中的会话开进新并行标签（写冲突由跨标签占用守卫擋），「随时可看历史」
    // （若原守卫把整个选择器摁死，用户实测吐槽：都并发多个了为啥不让看历史）
    // ephemeral 进程没挂会话文件，需要重启为持久模式才能恢复历史
    if (this.core.clientRef?.running && this.core.isNoSession) {
      this.core.disposeClient();
      this.post({ type: "status", text: this.L.restartingPi });
    }

    // 注意：不能用 kind 作字段名，会和 QuickPickItem 内置的 QuickPickItemKind 枚举冲突
    type Item = {
      label: string;
      description?: string;
      detail?: string;
      action: "file" | "newTab" | "all" | "delete";
      file?: string;
      busy?: boolean;
    };
    // 工单十三二刀-2：先弹占位 busy 项，立即反馈（不等 listSessions），完成后原地填充。
    // 「点历史零反馈」的直接治理：原来 showQuickPick 等 listSessions 完才弹，等待期只看到
    // 命令触发、无任何 UI 反应。占位 busy:true 在 VS Code 17+ 显示加载动画。
    const picker = vscode.window.createQuickPick<Item>();
    picker.placeholder =
      scope === "all" ? this.L.pickSessionAll : this.L.pickSessionProj;

    // 工单十九：条目构建统一入口——秒开快路径与占位慢路径共用，保证 scope 过滤/
    // 排序/入口项两条路径完全一致（工单验收点：后台刷新后的列表与现逻辑同构）
    const buildItems = (sessions: SessionInfo[]): Item[] => {
      const items: Item[] = [];
      // 工单十五入口收敛（2026-09-14 拍板）：「开始新会话」项已删——开新会话=开新标签，
      // 全插件只剩头部＋与本项两个入口，行为一致；busy 中选中会话自动开进新标签
      items.push({ label: "$(add) " + this.L.tabNewTitle, action: "newTab" });
      if (scope !== "all") {
        items.push({ label: this.L.browseAllSessions, action: "all" });
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
      return items;
    };

    // 工单十九：热路径秒开。fingerprintSessions（walk 整树 + 逐文件 stat）是 pickSession
    // 唯一剩余前置开销（NTFS 几百 ms，随会话数线性涨）——有上次结果缓存槽时先用它立即
    // 出列表（无 loading 占位），后台再跑指纹校验：命中即结束（列表已对）；未命中重算
    // listAll 入槽后**原地更新同一个 picker 的 items**（不重弹新 QuickPick、不重置选中，
    // activeItems 保持同 file 项——防用户在刷新完成前已选中某项被冲掉）。
    // 真首次（无槽）照旧 loading 占位→填充路径。pickerClosed 守卫：用户已关掉选择器后
    // 后台刷新不再碰 items（picker 即将 dispose，防止打在尸体上）。
    let pickerClosed = false;
    const keepAlive = picker.onDidHide(() => {
      pickerClosed = true;
    });
    const cwdFilter = scope === "all" ? undefined : wsPath;
    const cachedSlot = listAllSlot;
    if (cachedSlot) {
      picker.items = buildItems(toSessionInfos(cachedSlot.result, cwdFilter));
      picker.show();
      dbgLog(`pickSession 缓存秒开 ${(Date.now() - t0).toFixed(0)}ms（消息到达→列表就绪）`);
      // 后台指纹校验：listAllCached 指纹命中返回同一份 result（引用相等即列表未变）；
      // 未命中则内部已重算 listAll 并入槽，返回新引用 → 原地刷新 items
      void listAllCached()
        .then((fresh) => {
          if (pickerClosed || fresh === cachedSlot.result) return; // 指纹命中/已关闭 → 列表已对
          const prev = picker.selectedItems[0];
          picker.items = buildItems(toSessionInfos(fresh, cwdFilter));
          // 防选中丢失：原选中是会话条目 → 同 file 项保持 active（非会话入口项无需保）
          if (prev?.file) {
            const again = picker.items.find(
              (it) => it.action === "file" && it.file === prev.file
            );
            if (again) picker.activeItems = [again];
          }
          dbgLog(
            `pickSession 后台刷新就绪 ${(Date.now() - t0).toFixed(0)}ms（指纹变化→原地更新）`
          );
        })
        .catch(() => {}); // 后台刷新失败 → 列表维持旧数据，不打扰用户
    } else {
      // 工单十三二刀-2：先弹占位 busy 项，立即反馈（不等 listSessions），完成后原地填充。
      // 「点历史零反馈」的直接治理：原来 showQuickPick 等 listSessions 完才弹，等待期只看到
      // 命令触发、无任何 UI 反应。占位 busy:true 在 VS Code 17+ 显示加载动画。
      picker.items = [{ label: this.L.loadingSessions, action: "file", busy: true }];
      picker.show();
      dbgLog(`pickSession 占位弹出 ${(Date.now() - t0).toFixed(0)}ms（消息到达→占位，立即响应）`);

      const sessions = await listSessions(cwdFilter).catch(() => []);
      dbgLog(`pickSession listSessions ${(Date.now() - t0).toFixed(0)}ms（占位→列表就绪）`);

      // 占位 busy 项已被完整 items 替换；无会话时仍留有操作入口（开始新会话/删除），不走 notice
      picker.items = buildItems(sessions);
      dbgLog(`pickSession 内容就绪 ${picker.items.length} 项 @ ${(Date.now() - t0).toFixed(0)}ms`);
    }

    // —— showQuickPick 语义平移为 createQuickPick：选中/取消等价，渲染链（switch/
    //    getMessages/refreshState）照旧，不许借本单顺手改 ——
    const pick = await new Promise<Item | undefined>((resolve) => {
      picker.onDidAccept(() => {
        const s = picker.selectedItems[0];
        picker.hide();
        resolve(s);
      });
      picker.onDidHide(() => resolve(undefined)); // 用户取消
    });
    keepAlive.dispose(); // 工单十九：pickerClosed 监听随 picker 一起收尸
    picker.dispose();
    if (!pick) return; // 用户取消 → 保持现状，首次输入消息时再启动 pi
    if (pick.busy) return; // 占位/空态项不可交互，兑底不落渲染链
    if (pick.action === "delete") {
      await this.deleteSessionPick(scope);
      return;
    }

    const client = this.core.ensureClient(true);
    try {
      if (pick.action === "newTab") {
        // 入口收敛后唯一的「开新标签」选择器项（头部＋同款语义）
        this.handleTabNew();
        return;
      } else if (pick.action === "all") {
        void this.pickSession("all");
        return;
      } else if (pick.file) {
        // 工单十五刀3/4：同一会话文件禁止被两个标签同时打开（双窗口写冲突等价）。
        // 已被别的标签持有 → 直接跳过去看（比报错更符合「随时查看历史」意图）
        for (const [tid, c] of this.cores) {
          if (c.currentSessionFile && samePath(pick.file, c.currentSessionFile)) {
            if (tid !== this.activeTabId) {
              this.handleTabSwitch(tid);
              this.post({ type: "notice", text: this.L.sessionOpenInTab });
              return;
            }
            // 双写者事故（2026-09-20 用户实测「我切了会话，另外的会话也变成了你好」）：
            // 活动标签自己持有且 busy 时，原 code 破守卫落到下方 busy 分支 handleTabNew——
            // 同一个 jsonl 开进第二棵页签，两个页签同名同内容双写（pi 双进程同文件追加）。
            // 占用守卫必须盖住 busy 分支：会话已在本页签，提示即收，绝不开第二棵
            if (this.core.isBusy) {
              this.post({ type: "notice", text: this.L.sessionOpenHere });
              return;
            }
            break; // 活动标签自己持有且空闲：幂等重开无害，走正常切换
          }
        }
        if (this.core.isBusy) {
          // busy 中选历史：开进新并行标签，不中断当前任务（用户直令 2026-09-14）。
          // 新标签 freshTab=true → SessionManager.create 后立刻 switch 到目标文件
          this.handleTabNew();
          const nc = this.ensureCore(this.activeTabId);
          const r2 = await nc.ensureClient(true).switchSession(pick.file);
          if (r2?.cancelled) { this.post({ type: "notice", text: this.L.switchCancelled }); return; }
          const d2 = await nc.ensureClient(true).getMessages();
          this.post({ type: "render", messages: d2?.messages ?? [] });
          const name2 = (pick.label ?? "").replace(/^\$\(history\) /, "");
          this.post({ type: "notice", text: this.L.sessionRestored + name2 });
          // 切完补回每标签模型/思考记忆并同步页脚（刀3 语义补全，同下方主路径口径）
          await nc.reapplyModelMemory();
          return;
        }
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
      // 工单15刀3 记忆语义补全：switchSession 会把模型重置为会话文件里存的值，
      // 页签上自选的模型/思考等级要在切完后补回（用户报「一切会话模型就变了」）
      await this.core.reapplyModelMemory();
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
    const sessions = scope === "all" ? await listSessions() : await listSessions(wsPath);
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
    // 工单十五刀3：被任意标签打开的会话都不可删（原守卫只看活动标签；多标签后任何
    // 持有该文件的 pi 会话都在追加写入，删了数据丢失）
    for (const c of this.cores.values()) {
      if (c.currentSessionFile && samePath(pick.file, c.currentSessionFile)) {
        this.post({ type: "notice", text: this.L.delSessionCur });
        return;
      }
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
    const textFiles: { name: string; text?: string; path?: string }[] = [];
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
          // 路径模式：把绝对路径传给 webview，由 webview 传给 pi 让 pi 自己读
          textFiles.push({ name: path.basename(uri.fsPath), path: uri.fsPath });
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
    try {
      await client.compact(inst || undefined);
    } catch {
      // pi 对过小/已压缩的会话直接抛错（agent-session.js: prepareCompaction 返回 null →
      // "Nothing to compact"/"Already compacted"），不接住就是零反馈（2026-09-09 短会话实测）。
      // 错误/完成通知都由 piCore compaction_end 在 postUiState 重绘之后发（2026-09-18 零反馈
      // 事故收敛）——这里先发会被同一事件里的整体重绘冲掉，只剩状态标签清理职责；
      // compact() 所有失败路径（含抛错前）都先 emit 过 compaction_end，通知不会丢
    }
    this.post({ type: "status", text: "" });
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
    // 大小上限：50MB（审计要求，超大文件 copyFileSync 本身会长时间阻塞 + 耗尽内存）——
    // 收刀上移到守卫区（工单十遗留）：与 .jsonl 检查同层，不合格直接拒，不做无谓的 disposeClient/ensureClient
    const srcStat = fs.statSync(src);
    if (srcStat.size > 50 * 1024 * 1024) {
      this.post({ type: "notice", text: this.L.importTooLarge });
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

    // 面板外观：语言/主题（原头部 EN/◐ 按钮的功能收编于此，头部只留监控/历史/新会话/菜单）
    items.push({
      label: this.L.sLang + (this.lang === "zh" ? "中文" : "English"),
      run: async () => { await this.toggleLang(); },
    });
    items.push({
      label: this.L.sTheme + (this.globalState.get<string>("piChat.theme") ?? "midnight"),
      run: async () => { await this.pickTheme(); },
    });
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
      // 每标签记忆 + 同工作区影子兑底（二维键，跨窗口/跨项目隔离——旧扁平键跨窗口泄漏，
      // 2026-09-22 用户实测；读写口径都收拢在 PiCore，键布局单一真相）
      this.core.rememberModel({ provider: pick.model.provider, id: pick.model.id });
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
      // 每标签记忆 + 同工作区影子（同 pickModel 口径，二维键防跨窗口泄漏）
      this.core.rememberThinking(pick);
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

  // ════════ 工单七：pi 变更 Git diff 可视化（混合方案，裁决 11） ════════

  /** 核心消息桥（工单十五刀1 → 工单24 架构归位）：①记账标签元数据（busy/state → tabs 清单，
   *  含后台跑完置未读）；②后台页签的消息**照喍 webview**——写进该页签自己的隐藏树，现场累加
   *  （切回即现，零重拉；刀5 的「后台不喍」随重拉架构一并废止）；只挡页面控件/交互应答类：
   *  ③活动标签的 state 会话切换时清变更条 */
  private pipeFromCore(msg: HostToWebview, tabId: string): void {
    this.syncTabMeta(msg, tabId);
    if (tabId !== this.activeTabId) {
      if (msg.type === "busy" && !msg.value) {
        const meta = this.tabMeta.get(tabId);
        if (meta && !meta.unread) { meta.unread = true; this.postTabs(); }
      }
      // 交互应答/浮层类不投后台（notice 弹给谁看？输入框回填/状态行只属活动页签）
      if (msg.type === "notice" || msg.type === "status" || msg.type === "fillInput") return;
      this.post(msg, tabId);
      return;
    }
    if (msg.type === "state") {
      const s = this.changesOf(tabId);
      const f = msg.sessionFile ?? null;
      if (f !== s.lastStateFile) {
        s.lastStateFile = f;
        if (s.files.length) {
          s.files = [];
          s.detail.clear();
          this.postChangesList(tabId);
        }
      }
    }
    this.post(msg, tabId);
  }

  private postChangesList(tabId: string): void {
    const s = this.changesOf(tabId);
    this.post({ type: "changesList", files: s.dismissed ? [] : s.files }, tabId);
  }

  /** agent_start 时对 workspace 做 git status 快照（run 的 baseline；非 git 目录得 null 兑底） */
  private snapshotGitStatus(tabId: string): void {
    const s = this.changesOf(tabId);
    s.startP = null;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    s.startP = this.gitStatus(root);
  }

  /** 跑一条 git 命令，成功回 stdout、失败回 null（非 git 目录/git 不在 PATH 都走 null，不抛） */
  private git(args: string[], cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      // 不用 shell:true：路径参数含空格/中文时不被 shell 拆坏（Windows 上 libuv 会搜 PATH）
      const p = spawn("git", args, { cwd });
      let out = "";
      const timer = setTimeout(() => p.kill(), 15000);
      p.stdout.on("data", (d) => (out += String(d)));
      p.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? out : null);
      });
    });
  }

  /** git status --porcelain -z → 相对路径(正斜杠) → XY 状态；非 git 目录回 null。
   *  -z 避开 quotepath 对中文路径的转义；rename 在 -z 下是 new\0old 两段，old 段跳过 */
  private async gitStatus(root: string): Promise<Map<string, string> | null> {
    const out = await this.git(["status", "--porcelain", "-z"], root);
    if (out === null) return null;
    const map = new Map<string, string>();
    const parts = out.split("\0");
    for (let i = 0; i < parts.length - 1; i++) {
      const tok = parts[i];
      if (!tok || tok.length < 4) continue;
      const xy = tok.slice(0, 2);
      const p = tok.slice(3);
      if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") i++; // 旧路径段
      map.set(p, xy);
    }
    return map;
  }

  /** agent_settled：合并工具命中清单（piCore 中性回调）与 git 比对兜底，产出「本次改动」 */
  private async handleRunSettled(tabId: string, files: ToolChangedFile[]): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const s = this.changesOf(tabId);
    const startStatus = s.startP ? await s.startP : null;
    s.startP = null;
    const nowStatus = await this.gitStatus(root);
    const relOf = (abs: string): string | null => {
      const r = path.relative(root, abs);
      return r.startsWith("..") ? null : r.replace(/\\/g, "/"); // 工作区外不归因
    };
    const norm = (p: string): string => path.normalize(p);
    s.detail.clear();
    const list: ChangesFileInfo[] = [];
    // 1) 工具命中（裁决 11②：还原只对工具清单命中文件提供；git-only 仅展示）
    for (const f of files) {
      // 工单十一：pi 的 edit args.path 常为模型传给的原样相对路径，不锚定 root 会按 ext host
      // 的 cwd 解析成盘符根/垃圾值——relOf 的 path.relative 也基于 cwd 得到乱值使 nowStatus
      // 查不到（tracked 的 package.json 因此误判 inHead=false 错走 prerun 通道，症状二）。
      // 这里单点锚定，归一化后入 changesDetail/changesFiles，下游 diff/还原全链路收直。
      const abs = path.isAbsolute(f.path) ? f.path : path.join(root, f.path);
      const r = relOf(abs);
      const xy = r && nowStatus ? nowStatus.get(r) : undefined;
      const canGit = nowStatus !== null;
      // inHead：HEAD 里有此文件（checkout 可回退）；?? 未跟踪 / A 新增不在 HEAD，只能走 patch 逆向
      const inHead = canGit && !!xy && xy !== "??" && xy[0] !== "A" && xy[1] !== "A";
      s.detail.set(norm(abs), {
        source: "tool",
        tool: f.tool,
        patches: f.patches,
        canGit,
        inHead,
        preexisting: !!(r && startStatus?.has(r)),
      });
      list.push({ path: norm(abs), source: "tool" });
    }
    // 2) git 兑底（裁决 11①：捕获 bash/powershell 改动）——settled 快照里新出现的路径
    if (nowStatus) {
      for (const [r, xy] of nowStatus) {
        const abs = norm(path.join(root, r));
        if ([...s.detail.keys()].some((k) => k.toLowerCase() === abs.toLowerCase())) continue;
        if (startStatus?.has(r)) continue; // 运行前已 dirty，不归因本轮
        s.detail.set(abs, { source: "git", tool: "", patches: [], canGit: true, inHead: xy !== "??" && xy[0] !== "A", preexisting: false });
        list.push({ path: abs, source: "git" });
      }
    }
    s.files = list;
    s.dismissed = false;
    this.postChangesList(tabId);
  }

  /** 「查看本次改动」主链路：文件 QuickPick → 动作二选（diff / 还原） */
  private async showChangesFlow(): Promise<void> {
    // QuickPick 是模态全局 UI，用户在活动视图的条上点击 → 数据取活动页签的（工单七 per-tab）
    const s = this.changesOf(this.activeTabId);
    if (!s.files.length) {
      this.post({ type: "notice", text: this.L.chgNone });
      return;
    }
    // 2026-09-10 交互收敛（用户反馈两层 QuickPick 不友好）：文件清单拍成一层，
    // 行内按钮直达 diff/还原，回车默认「看」（能 diff 就 diff，否则尝试还原）
    type ChgButton = vscode.QuickInputButton & { act?: string };
    type ChgItem = vscode.QuickPickItem & { path: string; buttons?: ChgButton[] };
    const buildItems = (): ChgItem[] =>
      s.files.map((f) => {
        const d = s.detail.get(f.path);
        const src = !d ? ""
          : d.source === "git" ? this.L.chgGitOnly
          : this.revertable(d) ? this.L.chgToolRev
          : this.L.chgToolIrrev;
        return {
          label: "$(git-compare) " + path.basename(f.path),
          description: src + (d?.preexisting ? " · " + this.L.chgPreexisting : ""),
          detail: f.path,
          path: f.path,
          buttons: [
            ...(d && (d.canGit && d.inHead || d.source === "tool" && d.patches.length > 0)
              ? [{ iconPath: new vscode.ThemeIcon("diff"), tooltip: this.L.chgActDiff, act: "diff" }]
              : []),
            ...(d && this.revertable(d)
              ? [{ iconPath: new vscode.ThemeIcon("discard"), tooltip: this.L.chgActRevert, act: "revert" }]
              : []),
          ],
        };
      });
    const qp = vscode.window.createQuickPick<ChgItem>();
    qp.items = buildItems();
    qp.placeholder = this.L.chgPickPh;
    qp.onDidTriggerItemButton(async ({ item, button }) => {
      const act = (button as ChgButton).act;
      const d = s.detail.get(item.path);
      if (act === "diff") await this.openChangesDiff(item.path);
      else if (act === "revert" && d) {
        await this.revertFile(item.path, d);
        qp.items = buildItems(); // 还原完原地刷新清单（revertFile 已把文件移出清单）
      }
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      qp.hide();
      if (!item) return;
      const d = s.detail.get(item.path);
      if (d && (d.canGit && d.inHead || d.source === "tool" && d.patches.length > 0)) void this.openChangesDiff(item.path);
      else this.post({ type: "notice", text: this.L.chgNoAction });
    });
    qp.show();
  }

  /** 还原资格（裁决 11②③）：仅工具命中；tracked 走 git，未跟踪/无 git 仅 edit 有 patch 可逆打 */
  private revertable(d: { source: string; tool: string; patches: string[]; canGit: boolean; inHead: boolean }): boolean {
    if (d.source !== "tool") return false;
    if (d.canGit && d.inHead) return true;
    return d.tool === "edit" && d.patches.length > 0;
  }

  /** diff 入口路由：tracked 开 HEAD 对比；未跟踪/无基线开「本轮改动前 ↔ 当前」
   *  （patch 链逆向取 pi 动文件前的状态，未跟踪文件也有代码对比可看） */
  private hunkKey(p: string): string {
    return path.normalize(p);
  }

  private async openChangesDiff(abs: string): Promise<void> {
    const d = this.changesOf(this.activeTabId).detail.get(this.hunkKey(abs));
    if (d?.canGit && d.inHead) await this.openHeadDiff(abs);
    else await this.openPrerunDiff(abs);
  }

  /** 未跟踪文件的对比：本轮改动前（patch 逆向）↔ 当前 */
  private async openPrerunDiff(abs: string): Promise<void> {
    const headUri = vscode.Uri.parse("pi-head:/" + encodeURIComponent(abs) + "?" + encodeURIComponent("prerun:" + abs));
    await vscode.commands.executeCommand(
      "vscode.diff",
      headUri,
      vscode.Uri.file(abs),
      path.basename(abs) + "  (本轮改动前 ↔ " + this.L.chgWorking + ")",
      { preview: true }
    );
  }

  /** vscode.diff 左侧：HEAD 版本只读内容（TextDocumentContentProvider 回调） */
  private async headContent(uri: vscode.Uri): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // 未跟踪文件的对比侧：query 带 prerun: 前缀 → 返回本轮改动前内容（patch 链逆向，
    // 任一步不符返回失败占位——与 revertFile 同源校验，不硬猜）
    // 工单十一实证：uri.query 是编码形态（URI.parse 只拆分不解码，%3A 原样保留）。
    // 故统一先 decodeURIComponent 整个 query 再 startsWith("prerun:") 判断——
    // 旧代码双分支判断（%3A 与裸冒号）+ slice(7) 会把编码串 "prerun%3A..." 切出
    // 半编码残片（"3Ad%3A…"），decode 后带前导垃圾 → changesDetail 查不到 → 左侧白屏；
    // 且 encodeURIComponent 拼的 query 恒为编码形态，裸冒号分支实际永远走不到。
    // 统一 decode 后判断，两种 startsWith 分支之谜就此了结。
    const q = decodeURIComponent(uri.query);
    if (q.startsWith("prerun:")) {
      const abs = q.slice("prerun:".length);
      const d = this.changesOf(this.activeTabId).detail.get(this.hunkKey(abs));
      if (!d || !d.patches.length) return "";
      try {
        let content = fs.readFileSync(abs, "utf8");
        for (let i = d.patches.length - 1; i >= 0; i--) {
          const r = reverseApplyPatch(content, d.patches[i]);
          if (!r.ok || r.content === null) return this.L.chgHeadFail;
          content = r.content;
        }
        return content;
      } catch {
        return this.L.chgHeadFail;
      }
    }
    const rel = q;
    if (!root) return this.L.chgHeadFail;
    const out = await this.git(["show", "HEAD:" + rel], root);
    return out ?? this.L.chgHeadFail;
  }

  /** 查看 tracked 文件的 HEAD ↔ 工作区 diff */
  private async openHeadDiff(abs: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    const headUri = vscode.Uri.parse("pi-head:/" + encodeURIComponent(abs) + "?" + encodeURIComponent(rel));
    await vscode.commands.executeCommand(
      "vscode.diff",
      headUri,
      vscode.Uri.file(abs),
      path.basename(abs) + "  (HEAD ↔ " + this.L.chgWorking + ")",
      { preview: true }
    );
  }

  /** 单文件还原（破坏性操作，deleteSession 同规格：模态二次确认，失败只报不硬打） */
  private async revertFile(
    abs: string,
    d: { source: string; tool: string; patches: string[]; canGit: boolean; inHead: boolean; preexisting: boolean }
  ): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    // 编辑器里有未保存修改时提醒：还原的是磁盘内容，脏缓冲不会自动同步
    const dirty = vscode.workspace.textDocuments.some((doc) => doc.uri.fsPath === abs && doc.isDirty);
    const detailParts = [abs];
    if (d.preexisting) detailParts.push(this.L.chgPreexisting);
    if (dirty) detailParts.push(this.L.chgDirtyWarn);
    const yes = await vscode.window.showWarningMessage(
      this.L.chgRevertAsk,
      { modal: true, detail: detailParts.join("\n") },
      this.L.chgRevertBtn
    );
    if (yes !== this.L.chgRevertBtn) return;
    try {
      if (d.canGit && d.inHead) {
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        const out = await this.git(["checkout", "HEAD", "--", rel], root);
        if (out === null) {
          this.post({ type: "notice", text: this.L.chgRevertFail + "git checkout 失败" });
          return;
        }
      } else {
        // 未跟踪/无 git：edit patch 链逆序逆向（裁决 11③）。任一步不符 → 拒打不落盘
        let content = fs.readFileSync(abs, "utf8");
        for (let i = d.patches.length - 1; i >= 0; i--) {
          const r = reverseApplyPatch(content, d.patches[i]);
          if (!r.ok || r.content === null) {
            this.post({ type: "notice", text: this.L.chgIrreversible + (r.reason ?? "") });
            return;
          }
          content = r.content;
        }
        fs.writeFileSync(abs, content, "utf8");
      }
      this.post({ type: "notice", text: this.L.chgRevertDone + path.basename(abs) });
      const s = this.changesOf(this.activeTabId);
      s.files = s.files.filter((f) => f.path !== abs);
      s.detail.delete(abs);
      this.postChangesList(this.activeTabId);
    } catch (err: any) {
      this.post({ type: "notice", text: this.L.chgRevertFail + (err?.message ?? err) });
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

/** panel 侧关键链路诊断日志（工单十三二刀-1）：与 piCore.dbg 共用
 *  ~/.pi/agent/pi-chat-debug.log，不新开文件；只追加不改既有日志行。 */
function dbgLog(msg: string): void {
  try {
    const fpath = path.join(os.homedir(), ".pi", "agent", "pi-chat-debug.log");
    // 日志轮转：超过 5MB 时改名保留一代（与 piCore.dbg 同策略，rename 比截断简单）
    try { const s = fs.statSync(fpath); if (s.size > 5 * 1024 * 1024) { fs.renameSync(fpath, fpath + ".1"); } } catch { /* 不存在/无权限则跳过 */ }
    fs.appendFileSync(fpath, new Date().toISOString() + " " + msg + String.fromCharCode(10));
  } catch { /* ignore */ }
}

/** 模块级会话展示缓存（工单十三-4，UI 层职责放 panel 模块级，不进 PiCore）：
 *  mtime 未变视为内容未改动，直接复用缓存的 SessionInfo，免重建展示对象。
 *  删除会话后残留条无害：缓存按 key=file 惰性覆盖，文件不在列表即不被引用。 */
const sessionMetaCache = new Map<string, { mtimeMs: number; meta: SessionInfo }>();

/** 指纹缓存（工单十三二刀-5 补修）：**单槽** {fp, result}——指纹变即作废，永远只留最新
 *  一份（原 Map 每换指纹新增条目，而 pi 每发消息必改 mtime → 指纹连变 → 聊 50 轮滞留
 *  50 份 → ext host OOM）。只存轻量投影（path/cwd/name/firstMessage/modified 五字段），
 *  弃 allMessagesText——listAll 每会话携带全会话文本拼接的重串（session-manager.js 实证
 *  单次几十上百 MB），整枚缓存直接内存爆炸。投影后降 KB 级；面板重开不失效（模块级），
 *  扩展重载失效（可接受）。PiSessionEntry 类型内联 import 保留（零运行时依赖，类型参考
 *  正确做法）。 */
type PiSessionEntry = import("@earendil-works/pi-coding-agent").SessionInfo;
/** 展示链唯一需要的投影字段（轻量缓存用，allMessagesText 等重串不进来） */
type PiSessionProjection = Pick<PiSessionEntry, "path" | "cwd" | "name" | "firstMessage" | "modified">;
let listAllSlot: { fp: string; result: PiSessionProjection[] } | null = null;

/** 会话目录文件集指纹（工单十三重做后唯一幸存的轻量探测，自研扫描备胎已删）：
 *  递归收集 ~/.pi/agent/sessions 下 .jsonl 路径并 stat，路径+mtimeMs 进 FNV-1a 哈希
 *  （79 文件 ≈10-30ms，比 listAll 全量解析便宜两个量级）。任何文件新增/删除/mtime 变化
 *  → 指纹变 → 重跑 listAll；未变只重扫目录，省全量解析。 */
async function fingerprintSessions(): Promise<string> {
  const root = path.join(os.homedir(), ".pi", "agent", "sessions");
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限 → 空指纹，安全
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) files.push(full);
    }
  };
  await walk(root);
  let h1 = 2166136261; // FNV-1a 32 位 offset basis
  for (const file of files) {
    let mtime = 0;
    try {
      mtime = (await fs.promises.stat(file)).mtimeMs;
    } catch {
      // stat 失败（文件刚被删/无权限）→ mtime 记 0，指纹必变 → 强制重算，安全
    }
    const tag = file + ":" + mtime + ";";
    for (let i = 0; i < tag.length; i++) {
      h1 ^= tag.charCodeAt(i);
      h1 = (h1 * 16777619) & 0xffffffff; // FNV 素数，& 保持 32 位
    }
  }
  return files.length + ":" + h1; // 文件数也进指纹，防碰撞
}

/** listAll 指纹单槽缓存入口：指纹命中直接返回上次轻量投影结果（真毫秒级），未命中才跑
 *  pi 全量解析并投影后入槽（旧槽作废，永远只一份）。调用方无需关心缓存细节。 */
async function listAllCached(): Promise<PiSessionProjection[]> {
  const fp = await fingerprintSessions();
  if (listAllSlot && listAllSlot.fp === fp) return listAllSlot.result;
  const sdk = await loadPiSdk();
  const fresh = (await sdk.SessionManager.listAll()) as PiSessionEntry[];
  listAllSlot = {
    fp,
    result: fresh.map((x) => ({
      path: x.path,
      cwd: x.cwd,
      name: x.name,
      firstMessage: x.firstMessage,
      modified: x.modified,
    })),
  };
  return listAllSlot.result;
}

/** 投影→展示条目变换（cwd 过滤 + mtime 缓存复用 + 按最近使用排序 + 截断）。
 *  工单十九从 listSessions 抽出：pickSession 秒开快路径要对缓存槽里的投影做**同一套**
 *  变换，抽成纯函数保证快/慢两条路径的 scope 过滤与排序行为永远一致，不各写一份漂移。 */
function toSessionInfos(
  entries: PiSessionProjection[],
  cwd?: string,
  limit = 50
): SessionInfo[] {
  const result: SessionInfo[] = [];
  for (const e of entries) {
    if (cwd && !samePath(e.cwd, cwd)) continue; // 只保留属于该项目的会话（pi 的 list 不做项目过滤）
    const file = e.path;
    const mtime = e.modified.getTime();
    const hit = sessionMetaCache.get(file);
    let info: SessionInfo;
    if (hit && hit.mtimeMs === mtime) {
      info = hit.meta; // mtime 未变 → 复用缓存（免重建展示对象；解析已由 listAll 扛）
    } else {
      info = {
        file,
        mtime,
        time: new Date(mtime).toLocaleString(),
        cwd: e.cwd ?? "",
        preview: (e.firstMessage || "").slice(0, 60),
        name: e.name,
      };
      sessionMetaCache.set(file, { mtimeMs: mtime, meta: info });
    }
    result.push(info);
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result.slice(0, limit);
}

/** 列出历史会话，按最近使用排序；传入 cwd 则只保留属于该项目的会话（异步，工单十三）。
 *  工单十三二刀-4/5：主路径改用 pi 公开 API SessionManager.listAll()（pi -r 同款，10 路
 *  并发全量解析，字段白拿，格式变更 pi 自己扛），按 cwd 的 samePath 过滤（pi 的 list 不做
 *  项目过滤）；刀 5 指纹缓存包在外——指纹命中直接复用上次 listAll 结果（免 700ms 全量解析），
 *  未命中才 listAll 并填缓存。展示层 mtime 缓存（key=file）照旧免重建。 */
async function listSessions(cwd?: string, limit = 50): Promise<SessionInfo[]> {
  return toSessionInfos(await listAllCached(), cwd, limit);
}

