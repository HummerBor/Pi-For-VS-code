/**
 * 子 agent 转录 tab（2026-11-03 用户拍板）：**新建一个主会话页面的副本**，不是另造一套页面。
 *
 * 复用方式：同一份 getHtml（webview/index.html + main.js + style.css/tokens.css）+ 同一个
 * 渲染入口（`{type:"render", messages}` → renderAll）。所以看起来、用起来就是主会话那个页面，
 * 思考块可折叠、工具行同款、用户气泡同款——因为它就是同一份代码跑出来的另一个实例。
 *
 * 边界（避免把主会话写坏）：
 *  - 独立 WebviewPanel、独立 tabId、独立消息数组；不碰任何 PiCore / SessionManager
 *  - 只读：本实例只收 render，输入框发来的消息一律忽略（不转发给任何会话）
 *  - 数据源：打开时读一次 jsonl 做历史；运行中吃 piCore 的事件流增量（不轮询）
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getHtml } from "./webview-html";
import type { Lang } from "../core/i18n";

interface Tab {
  panel: vscode.WebviewPanel;
  tabId: string;
  handle?: string;
  messages: unknown[];
  nextIndex: number;
  ready: boolean;
  /** 页脚展示用（模型 / 思考等级 / 花费）：只读，不让点 */
  meta: History;
  /** 是否已开了一条 live 气泡（主会话 webview 的 newLive/delta 协议） */
  liveOpen: boolean;
  title?: string;
}

const tabs = new Map<string, Tab>();
let seq = 0;

function keyOf(handle: string | undefined, file: string): string {
  return handle ? "h:" + handle : "f:" + file;
}

function handleOf(file: string): string | undefined {
  return /[\\/](sa-\d+)[\\/]/.exec(file)?.[1];
}

interface History {
  messages: unknown[];
  /** 上下文用量（最后一条 assistant 的 totalTokens）：页脚「上下文 N%」要用它 ÷ 模型窗口 */
  contextTokens?: number;
  model?: { id: string; provider?: string };
  thinkingLevel?: string | number | null;
  cost?: number;
}

/** 打开时读一次历史（只此一次）；运行中后续内容走事件流。
 *  顺手把页脚要展示的三件东西读出来（模型 / 思考等级 / 花费）——转录 tab 是只读的，
 *  但用量和思考模式必须看得见（2026-11-03 用户要求） */
function readHistory(file: string): History {
  const out: History = { messages: [] };
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const e = entry as {
        type?: string;
        provider?: string;
        modelId?: string;
        thinkingLevel?: string;
        message?: { role?: string; usage?: { cost?: { total?: number }; totalTokens?: number } };
      };
      if (e?.type === "model_change" && e.modelId) out.model = { id: e.modelId, provider: e.provider };
      else if (e?.type === "thinking_level_change") out.thinkingLevel = e.thinkingLevel ?? null;
      if (e?.type !== "message" || !e.message) continue;
      if (e.message.role === "system") continue; // 与事件流同口径（details.messages 不含 system）
      const c = e.message.usage?.cost?.total;
      if (typeof c === "number") out.cost = (out.cost ?? 0) + c;
      const tt = e.message.usage?.totalTokens;
      if (typeof tt === "number" && e.message.role === "assistant") out.contextTokens = tt;
      out.messages.push(e.message);
    }
    return out;
  } catch {
    return out;
  }
}

/** 模型上下文窗口：从 pi 的模型目录缓存里查（几 MB json，只读一次并记忆）。
 *  子会话文件里没有窗口信息，页脚「上下文 N%」只能这么算——查不到就返回 null，页脚只显示花费。 */
let catalogCache: Record<string, number> | null = null;
function contextWindowOf(provider: string | undefined, modelId: string | undefined): number | null {
  if (!provider || !modelId) return null;
  try {
    if (!catalogCache) {
      const dir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
      const raw = JSON.parse(fs.readFileSync(path.join(dir, "models-store.json"), "utf8")) as Record<string, unknown>;
      const map: Record<string, number> = {};
      const walk = (v: unknown): void => {
        if (!v || typeof v !== "object") return;
        const o = v as Record<string, unknown>;
        if (typeof o.id === "string" && typeof o.contextWindow === "number") map[o.id] = o.contextWindow;
        for (const k of Object.keys(o)) walk(o[k]);
      };
      walk(raw);
      catalogCache = map;
    }
    return catalogCache[modelId] ?? null;
  } catch {
    return null;
  }
}

function post(tab: Tab, msg: Record<string, unknown>): void {
  if (!tab.ready) return;
  try {
    void tab.panel.webview.postMessage({ ...msg, tabId: tab.tabId });
  } catch {
    /* 页面已关 */
  }
}

function render(tab: Tab): void {
  // 先打状态：页脚（模型/思考/用量）与页头名字都靠 state 消息渲染，applyState 里这两块
  // 与主会话完全同一套代码——只是本页面把可点的控件用 CSS 锁死（见 READONLY_CSS）
  post(tab, {
    type: "state",
    model: tab.meta.model ?? null,
    thinkingLevel: tab.meta.thinkingLevel ?? null,
    sessionName: tab.title ? " " + tab.title : null,
    sessionFile: null,
    stats: {
      cost: tab.meta.cost ?? 0,
      // 子会话没有 session stats，用「最后一条 assistant 的 totalTokens ÷ 模型窗口」等价计算
      contextPercent:
        tab.meta.contextTokens && tab.meta.model
          ? (() => {
              const win = contextWindowOf(tab.meta.model!.provider, tab.meta.model!.id);
              return win ? (tab.meta.contextTokens! / win) * 100 : null;
            })()
          : null,
    },
  });
  // 页签/模式/状态与主会话同一套消息：页头标题走 tabs（宿主标题唯一事实源），
  // 页脚模式徽标走 mode（子 agent 非交互运行 = Auto，与主会话默认一致）
  post(tab, {
    type: "tabs",
    tabs: [{ id: tab.tabId, title: tab.title ?? "子 agent", busy: false }],
    activeTabId: tab.tabId,
  });
  post(tab, { type: "mode", text: "Auto" });
  post(tab, { type: "render", messages: tab.messages });
  post(tab, { type: "busy", value: false });
}

/** 只读约束（不改 main.js，只加一层样式）：**只收输入区**，页头/页脚/主题/气泡全部与
 *  主会话一模一样。 */
const READONLY_CSS = `
<style>
  /* 2026-11-03 用户两次纠正：①「标题重复」→ 曾隐页头会话名；②「应与主会话一致」+「只读标记去掉」
     → 恢复页头/页脚原样，不再加（只读）后缀、不再弹提示。只留输入区收起。 */
  #composer { display: none !important; }
  /* 2026-11-03 用户截图两次指出「多了这些」「整行都去掉」：页头整行（鸭子/会话名/历史/
     新建/更多/子 agent 指示）在转录页全部收起——标题只在 VS Code 标签栏那一份 */
  #hdr-row1 { display: none !important; }
  #header { display: none !important; }
</style>
`;

/** 短标题：台账里给的「职务 · 代号 · 任务前20字」太长，标签栏只留「职务 · 代号 (sa-N)」 */
function shortTitle(title: string | undefined, handle: string | undefined, file: string): string {
  const base = (title ?? "").split(" · ").slice(0, 2).join(" · ") || "子 agent";
  const h = handle ?? "";
  return h ? `${base} (${h})` : base || file;
}

export interface OpenTranscriptOptions {
  file: string;
  title?: string;
  theme: string;
  duckUri: string;
  floorColor: string;
  bgImage: string;
  bgOpacity: number;
  lang: Lang;
  /** 打开到哪个编辑器组（2026-11-03 用户：不要再开分屏）：传宿主当前活动组，
   *  它就以「并列标签」开在聊天页旁边；不传才回退到 Beside 分屏 */
  viewColumn?: vscode.ViewColumn;
  /** 标签栏图标：与主会话编辑器标签同一个（media/source/pi-icon-small.svg） */
  iconPath?: vscode.Uri;
}

/** 打开（或聚焦）子 agent 转录 tab */
export function openTranscriptTab(opts: OpenTranscriptOptions): void {
  const handle = handleOf(opts.file);
  const key = keyOf(handle, opts.file);
  const hit = tabs.get(key);
  if (hit) {
    hit.panel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "piChat.subagentTranscript",
    shortTitle(opts.title, handle, opts.file),
    opts.viewColumn ?? vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  if (opts.iconPath) panel.iconPath = opts.iconPath;
  const hist = readHistory(opts.file);
  const tab: Tab = {
    panel,
    tabId: "tr" + ++seq, // 独立页签 id：主会话页的 tab 路由按它建视图，互不干扰
    handle,
    messages: hist.messages,
    nextIndex: hist.messages.length,
    ready: false,
    meta: hist,
    liveOpen: false,
    title: shortTitle(opts.title, handle, opts.file),
  };
  tabs.set(key, tab);
  panel.onDidDispose(() => {
    tabs.delete(key);
    if (tab.handle) for (const [k, v] of tabs) if (v.handle === tab.handle) tabs.delete(k);
  });
  // 同一份模板 + 同一份产物：这就是主会话页面；末尾追加一层只读样式
  panel.webview.html =
    getHtml(opts.theme, opts.duckUri, opts.floorColor, opts.bgImage, opts.bgOpacity, opts.lang).replace(
      "</head>",
      READONLY_CSS + "</head>"
    );
  panel.webview.onDidReceiveMessage((m: { type?: string }) => {
    if (m?.type === "webviewReady") {
      tab.ready = true;
      render(tab);
      return;
    }
    // 只读：输入框/命令/设置等一律不理（不转发给任何会话，也绝不写文件）
  });
}

/** 事件流增量（piCore 每帧调）：只追加新消息，然后重绘一次（renderAll 与主会话切会话同一条路） */
export function pushTranscript(handle: string, messages: unknown[], from?: number): void {
  const tab = tabs.get("h:" + handle);
  if (!tab || !messages?.length) return;
  const base = typeof from === "number" ? from : tab.nextIndex;
  for (let i = 0; i < messages.length; i++) {
    if (base + i < tab.nextIndex) continue; // 与打开时读到的历史重叠，跳过
    tab.messages.push(messages[i]);
  }
  tab.nextIndex = Math.max(tab.nextIndex, base + messages.length);
  tab.liveOpen = false; // 消息已完整到达：live 气泡交还给正式 render
  // 页面侧最多保留 500 条（长转录不至于每帧重绘上千节点）
  if (tab.messages.length > 500) tab.messages = tab.messages.slice(-500);
  render(tab);
}

/** 供 sessionsView 直接调用（左侧列表点子会话行） */
export function openTranscriptFor(
  file: string,
  title: string | undefined,
  page: {
    theme: string;
    duckUri: string;
    floorColor: string;
    bgImage: string;
    bgOpacity: number;
    lang: Lang;
  }
): void {
  openTranscriptTab({ file, title, ...page });
}

/** 测试/清理用：关掉所有转录 tab */
export function closeTranscriptTabs(): void {
  for (const [, t] of tabs) {
    try {
      t.panel.dispose();
    } catch {
      /* ignore */
    }
  }
  tabs.clear();
}

export { handleOf as transcriptHandleOf };

/**
 * delta 级流式（2026-11-03，与主会话同口径）：页面用主会话那套 live 协议逐字追加，
 * 不再等 message_end 一整条跳出来。
 *   text/thinking 第一段 → 先 newLive 开一条新气泡，随后 delta/thinking 往里灌
 * 消息结束（pushTranscript）时会 flush + render 一次，用最终渲染对齐（含工具行/折叠块）。
 */
export function pushTranscriptStream(handle: string, kind: "text" | "thinking", text: string): void {
  const tab = tabs.get("h:" + handle);
  if (!tab || !text) return;
  if (!tab.liveOpen) {
    tab.liveOpen = true;
    post(tab, { type: "newLive" });
  }
  post(tab, { type: kind === "thinking" ? "thinking" : "delta", text });
}

/** 消息级对齐：把 live 气泡收掉，用 render 落地最终内容（保住工具行/折叠块等结构） */
export function endTranscriptStream(handle: string): void {
  const tab = tabs.get("h:" + handle);
  if (tab) tab.liveOpen = false;
}
