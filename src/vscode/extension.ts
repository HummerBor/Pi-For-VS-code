import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatPanelProvider } from "./panel";
import { registerSessionsView, setSessionsView, notifySessionsChangedNow } from "./sessionsView";
import { listSessions, invalidateListMemo } from "./sessionCache";
import { prewarmPiServices } from "../pi/piClient";
import { bb, Lang, STRINGS } from "../core/i18n";
import { dbgAppend } from "../core/piCore";
import { setExternalWriting, setExternalWritingName } from "../core/externalWriting";

/** 工单32 刀1：openSession/externalWriting 两命令的入参 file/name 解析（file 优先；
 *  name 兜底扫列表 name 字段——`--name` 写进 session_info 的那个名）。解析不出返回 null。
 *  存疑记录：name 匹配用精确相等（外部调用方传的应是完整 --name 值）；重名取 mtime
 *  最新的一条（listSessions 已按 mtime 降序）。实现级自裁，进 REPORT */
async function resolveSessionFile(args: { file?: string; name?: string } | undefined): Promise<string | null> {
  const file = typeof args?.file === "string" ? args.file : "";
  if (file) return file; // 存在性校验归调用方（openSession 查 existsSync、externalWriting 只登记）
  const name = typeof args?.name === "string" ? args.name : "";
  if (!name) return null;
  try {
    const all = await listSessions(); // 全量扫（外部写者的会话可能属别的项目 cwd）
    const hit = all.find((s) => s.name === name);
    return hit?.file ?? null;
  } catch {
    return null;
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  // 诊断锚点（2026-10-19）：扩展宿主重启 = webview 重建的头号嫌疑，但此前日志里
  // 没有它的名字（只看到 webviewReady/boot 重跑）——「面板莫名重建」无从判因。
  // activate/deactivate 各留一行，重启在日志里一眼可辨
  dbgAppend("=== extension activate v" + String(ctx.extension.packageJSON.version));  // Q 刀②（2026-09-23）：激活即后台预热 services——resourceLoader 全树扫描（冷 5~10s）
  // 藏进「开面板之前」的空窗；失败静默（boot 时还会再试）
  const ws0 = vscode.workspace.workspaceFolders?.[0];
  if (ws0) prewarmPiServices(ws0.uri.fsPath);
  const version = ctx.extension.packageJSON.version;
  // 新建编辑器标签的初始题（2026-10-20 用户拍板「新建会话由 "pi" 改成 "新会话"」）：
  // 与 panel 的 tabMeta 初值同源同语（tabUntitled），首帧 state 到达前标签就是最终文案；
  // 同时 panel.syncTabMeta 有补写兑底（初值分歧不等 titleDirty），两头夹住不回退 "pi"
  const lang0 = (ctx.globalState.get<Lang>("piChat.lang") ?? "zh") as Lang;
  const newTabTitle: string = STRINGS[lang0].tabUntitled;
  const provider = new ChatPanelProvider(ctx.extensionUri, ctx.globalState, version);
  // CC 同款版本门槛（抄技巧不抄代码）：viewsContainers.secondarySidebar 声明点是
  // VS Code 1.106+ 才有的；老版本忽略该键（manifest 未知贡献点静默忽略），靠
  // doesNotSupportSecondarySidebar 把聊天视图切回 activitybar 容器兜底。
  // context 未设（新版本）时 when 取反 = 副栏默认显示，新装环境零配置即 CC 布局
  const [major, minor] = vscode.version.split(".").map(Number);
  const noSecondary = (major ?? 1) < 1 || ((major === 1) && (minor ?? 0) < 106);
  if (noSecondary) {
    void vscode.commands.executeCommand("setContext", "piChat.doesNotSupportSecondarySidebar", true);
  }
  const viewOpts = { webviewOptions: { retainContextWhenHidden: true } };
  // 刀3 CC 布局：编辑器标签开新会话——每标签一个 WebviewPanel + 独立 provider 实例
  //（独立 PiCore/独立会话，跨实例守卫见 panel.ts findHolder）。
  // viewType 稳定串：VS Code 用它序列化/恢复编辑器标签（重启后标签还在，webview 重建
  // 会重发 webviewReady 握手，会话记忆按实例 tabKey p{n} 恢复）
  // 编辑器标签 tab 图标（2026-10-20 用户拍板：标签图标与 editor/title 按钮都换
  // pi-icon-small.svg）：WebviewPanel.iconPath 单 Uri（彩色 svg，亮暗同用）；
  // 文件在 media/source/，必须过 .vscodeignore 的 media/* 白名单才进 vsix
  const tabIcon = vscode.Uri.joinPath(ctx.extensionUri, "media", "source", "pi-icon-small.svg");
  const openEditorTab = (sessionFile?: string) => {
    const panel = vscode.window.createWebviewPanel(
      "piChat.editorPanel",
      newTabTitle,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = tabIcon;
    const inst = new ChatPanelProvider(ctx.extensionUri, ctx.globalState, version, panel);
    inst.attachEditorPanel(sessionFile);
  };
  ChatPanelProvider.setFactories({ openEditorTab });
  // 刀4：左侧活动栏会话列表（原生 TreeView，点击打开/聚焦会话）
  setSessionsView(registerSessionsView(ctx));
  // ── 工单32 刀3：会话目录 watcher（验收 C/D）──
  // 外部进程（ops-panel pi -p 等）新建/删除会话文件 → ≤2s 上列表。轮询文件名指纹
  // （不用 mtime——NTFS 同 tick 粒度坑，见技能 §6）每 500ms 一拍；变更 → invalidateListMemo
  // + 立即重扫（notifySessionsChangedNow 不吃 refresh 的 2s debounce——验收 ≤2s 预算）。
  // 覆盖面：piChat.sessionDir 配置目录 + 默认库根（recursive readdir 扫全部项目子目录）；
  // PI_AGENT_DIR 自定义 agent 目录不在此列（记 REPORT 遗留）。append 到已有会话不触发
  // （列表 mtime 列的实时性不在验收面；打开态会话的追加由刀2 跟随器管）
  const watchRoots = (): string[] => {
    const roots: string[] = [];
    try {
      const cfg = vscode.workspace.getConfiguration("piChat").get<string>("sessionDir", "").trim();
      if (cfg) roots.push(cfg);
    } catch { /* 配置读失败只看默认库 */ }
    roots.push(path.join(os.homedir(), ".pi", "agent", "sessions"));
    return roots;
  };
  const fpOf = (root: string): string => {
    try {
      const names = (fs.readdirSync as any)(root, { recursive: true, encoding: "utf8" }) as string[];
      return names.join("|");
    } catch {
      try { return fs.readdirSync(root).join("|"); } catch { return ""; } // 目录不存在（尚无会话）
    }
  };
  let lastFp = watchRoots().map(fpOf).join("§"); // 起步打底：首拍不触发（防启动即重扫）
  const fpTimer = setInterval(() => {
    const fp = watchRoots().map(fpOf).join("§");
    if (fp === lastFp) return;
    lastFp = fp;
    invalidateListMemo(); // 新建/删除必须绕过 TTL 窗口（3s 内的旧库应答不许再吐）
    notifySessionsChangedNow();
  }, 500);
  ctx.subscriptions.push({ dispose: () => clearInterval(fpTimer) });
  // 刀3 重启恢复：VS Code 序列化编辑器面板时捕获 webview state（panelInfo 存的
  // tabKey），窗口重开时逐面板回调 resolveWebviewPanel——按原 tabKey 重建实例 →
  // 会话记忆同键恢复原会话（state 缺失 = 面板没握手过 = 新会话语义）
  ctx.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("piChat.editorPanel", {
      deserializeWebviewPanel: async (panel, state) => {
        const tabKey = (state as { tabKey?: string } | undefined)?.tabKey;
        panel.iconPath = tabIcon; // 重启恢复的标签同样要图标（iconPath 不进 webview state）
        const inst = new ChatPanelProvider(ctx.extensionUri, ctx.globalState, version, panel, tabKey);
        inst.attachEditorPanel();
      },
    })
  );
  ctx.subscriptions.push(
    vscode.commands.registerCommand("piChat.openInEditor", () => openEditorTab()),
    // 工单32 刀1：通用外部接入命令（纯程序接口，不进 package.json contributes，不污染命令面板）。
    // openSession：打开/聚焦外部会话。返回 {ok, reason?}——not-found 在命令入口先查
    // （existsSync/列表命中），openOrFocusSession 的 pendingSessionFile 握手后失败走 notice
    // 不改返回值（返回值只代表「已路由」，语义写进 REPORT-t32）。openInEditor 原样保留
    vscode.commands.registerCommand(
      "piChat.openSession",
      async (args?: { file?: string; name?: string }) => {
        const file = await resolveSessionFile(args);
        if (!file || !fs.existsSync(file)) return { ok: false, reason: "not-found" };
        await ChatPanelProvider.openOrFocusSession(file);
        return { ok: true };
      }
    ),
    // 工单32 刀1：外部写者登记（控制面信号）。writing:true=外部开始写，false=交棒。
    // 登记表在 core/externalWriting.ts（纯逻辑叶），刀2 的只读判定/交棒查它。
    // name 无条件登记（文件未建/未进 memo 时 file 解析不到，信号不能丢——刀2 实测缺口补修）；
    // file 能解析到则双写双清，piClient 判活跃时 path/name 任一命中即真
    vscode.commands.registerCommand(
      "piChat.externalWriting",
      async (args?: { file?: string; name?: string; writing?: boolean }) => {
        // 返修P4：writing 必填 boolean——漏传当 false 会静默误清登记还回 {ok:true}
        if (typeof args?.writing !== "boolean") return { ok: false, reason: "bad-args" };
        const writing = args.writing;
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const file = await resolveSessionFile(args);
        if (name) setExternalWritingName(name, writing);
        if (file) setExternalWriting(file, writing);
        return { ok: !!(name || file) };
      }
    ),
    // retainContextWhenHidden：切走时保活 webview，回来不重建、不丢会话。
    // 同一 provider 注册两个 viewId（副栏/老版本 activitybar）——when 互斥保证
    // 同时至多一个实例化，resolveWebviewView 不会被抢跑覆盖
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, provider, viewOpts),
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.secondaryViewId, provider, viewOpts),
    { dispose: () => provider.dispose() }
  );

  // 状态栏入口：点击打开聊天面板
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusItem.text = "$(comment) pi";
  statusItem.tooltip = bb("statusBarTooltip");
  // 新布局（副栏）下 piChat.view 被 when 隐藏，focus 会打空——
  // 状态栏入口按版本门槛路由到实际存在的那个视图
  statusItem.command = noSecondary ? "piChat.view.focus" : "piChat.viewSecondary.focus";
  statusItem.show();
  ctx.subscriptions.push(statusItem);
}

export function deactivate(): void {
  // 由 subscriptions 的 dispose 处理
  dbgAppend("=== extension deactivate"); // 与 activate 配对：日志里一眼看出宿主重启边界
}
