// panel 运行时回归（mock vscode，零依赖）：加载 panel + resolveWebviewView + webviewReady，
// 捕获 host 推的 uiState，检查 model/thinkingLevel 非空。补 panel 长期缺的运行时覆盖——
// getHtml ENOENT/「还原视图出错」、状态栏模型思考空 这类 bug 只有加载 panel 才暴露（smoke-boot
// 只 require core，够不到）。先 npm run compile。
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Module = require("module");
const os = require("os");
const path = require("path");
// 测试不碰用户目录（2026-10-19 用户「不脏吗」拍板）：诊断日志与 pi 会话一律进 %TEMP%，
// 不往 ~/.pi/agent 写任何东西。必须在 require panel.js **之前**设——DBG_LOG_PATH 模块加载时定格
const TEST_TMP = path.join(os.tmpdir(), "pi-panel-load-test");
const TEST_SESSION_DIR = path.join(TEST_TMP, "sessions");
require("fs").mkdirSync(TEST_SESSION_DIR, { recursive: true });
process.env.PI_CHAT_DEBUG_LOG = path.join(TEST_TMP, "debug.log");

const posted = [];
const t0 = Date.now();
const store = {};
const dispo = { dispose() {} };
let msgHandler = null;

function callable() {
  return new Proxy(function () {}, {
    get: () => callable(),
    apply: () => callable(),
  });
}
const vscode = {
  Uri: { parse: () => ({ fsPath: "/x", scheme: "file", toString: () => "x" }), file: () => ({ fsPath: "/x", scheme: "file" }) },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
  ViewColumn: { Beside: 2 },
  Range: class Range {},
  ThemeIcon: class ThemeIcon {},
  workspace: {
    registerTextDocumentContentProvider: () => dispo,
    onDidChangeConfiguration: () => dispo,
    getConfiguration: (section) => ({ get: (k, d) => (section === "piChat" && k === "sessionDir" ? TEST_SESSION_DIR : d) }),
    workspaceFolders: [],
    getWorkspaceFolder: () => undefined,
  },
  window: {
    activeColorTheme: { kind: 2 },
    onDidChangeActiveTextEditor: () => dispo,
    onDidChangeVisibleTextEditors: () => dispo,
    onDidChangeTextEditorSelection: () => dispo,
    activeTextEditor: undefined,
    visibleTextEditors: [],
  },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscode;
  return origLoad.apply(this, [request, ...rest]);
};

const { ChatPanelProvider } = require("../../out/vscode/panel.js");
// DIAG=1：postUiState 调用点桩——「空帧是谁发的」必须看调用栈才能定位（帧内容不含来源）
if (process.env.DIAG) {
  const { PiCore } = require("../../out/core/piCore.js");
  const orig = PiCore.prototype.postUiState;
  // 谁把消息处理卡了 N 秒：同步段耗时要单独看（async 函数同步前缀跑在调用者线程上）
  const sc = require("../../out/vscode/sessionCache.js");
  const ols = sc.listSessions;
  sc.listSessions = function () {
    const t = Date.now();
    const p = ols.apply(this, arguments);
    console.log("  [sync] listSessions 同步段 " + (Date.now() - t) + "ms");
    return p;
  };
  PiCore.prototype.postUiState = function () {
    console.log("  [call @" + (Date.now() - t0) + "ms] postUiState <- " + String(new Error().stack).split("\n").slice(2, 5).join(" | ").trim());
    return orig.apply(this, arguments);
  };
}
const globalState = { get: (k, d) => (k in store ? store[k] : d), update: (k, v) => void (store[k] = v) };
// 种模型/思考记忆（用户真实形态：恢复页签都带记忆）：boot 窗口（services 扫描 2~29s）内
// 页脚必须也显示模型/思考，不许钉「—」（状态栏 bug 的用户实测形态）。
// 记忆模型用 pi 当前默认同款（openrouter/free），applyModelMemory 补回等价无副作用
const wsKey = process.cwd().replace(/\\+$/, "").toLowerCase();
store["piChat.lastModelByWs2"] = { [wsKey]: { t1: { provider: "openrouter", id: "openrouter/free" } } };
store["piChat.lastThinkingByWs2"] = { [wsKey]: { t1: "medium" } };

let provider;
try {
  provider = new ChatPanelProvider({ fsPath: process.cwd() }, globalState, "0.1.41"); // 真仓库根（有 media），别用假路径否则 applyHtml 假 ENOENT
  console.log("✅ 构造 ChatPanelProvider OK");
} catch (e) {
  console.log("❌ 构造抛:", e.stack);
  process.exit(1);
}

const view = {
  webview: {
    options: {},
    _html: "",
    _htmlSets: 0,
    get html() { return this._html; },
    set html(v) { this._html = v; this._htmlSets++; },
    postMessage: (m) => (posted.push([Date.now() - t0, m]), Promise.resolve(true)),
    onDidReceiveMessage: (h) => ((msgHandler = h), dispo),
  },
  visible: true,
  onDidDispose: () => dispo,
  onDidChangeVisibility: () => dispo,
};

try {
  provider.resolveWebviewView(view);
  console.log("✅ resolveWebviewView OK，html " + view.webview.html.length + " 字节");
} catch (e) {
  console.log("❌ resolveWebviewView 抛（＝「还原视图时出错」）:", e.stack);
  process.exit(1);
}

// 触发 webviewReady 握手 → host 推 uiState。同步耗时必须短：webviewReady 处理里卡 1s+ =
// 握手/后续消息连坐阻塞（会话列表同步快扫詹1.5s 事故，2026-10-19）
const tReady = Date.now();
try { msgHandler && msgHandler({ type: "webviewReady" }); } catch (e) { console.log("webviewReady 处理抛:", e.message); }
const readyMs = Date.now() - tReady;
// webview 红字落盘桥：错误消息必须被 panel 级截获（不进核心、不回投 webview）
const postedBeforeErr = posted.length;
try { msgHandler && msgHandler({ type: "wvError", kind: "error", message: "test boom", file: "x.js", line: 1 }); } catch (e) { console.log("wvError 处理抛:", e.message); }
const errForwarded = posted.length - postedBeforeErr;

setTimeout(async () => {
  // 不变量⑥：会话列表快扫并发去重（「点多次会话列表才有数据」事故）——在途扫描共享同一
  // promise，4 路并发必须拿到同一份 result 引用（引用相等 = 只扫了一遍，不是 4 遍）
  let deduped = true;
  try {
    const sc = require("../../out/vscode/sessionCache.js");
    const four = await Promise.all([sc.listAllCached(), sc.listAllCached(), sc.listAllCached(), sc.listAllCached()]);
    deduped = four.every((r) => r === four[0]);
  } catch (e) {
    deduped = false;
  }
  // DIAG=1：消息全时序 dump（定位「谁把状态栏刷空/帧序错乱」这类问题的探针）
  if (process.env.DIAG) {
    for (const [t, m] of posted) {
      const brief = JSON.stringify(m, (k, v) =>
        k === "messages" || k === "live" || k === "queued" || k === "stats" || k === "tabs"
          ? (Array.isArray(v) ? "[" + v.length + "]" : v) : v).slice(0, 240);
      console.log(t + "ms " + brief);
    }
  }
  const frames = posted.map((p) => p[1]).filter((m) => m.type === "uiState");
  console.log("uiState 帧数:", frames.length);
  let bad = 0;
  let sawTruth = false;
  for (const f of frames) {
    const okModel = f.model != null;
    const okThink = f.thinkingLevel != null;
    console.log("  model=" + JSON.stringify(f.model) + " thinkingLevel=" + f.thinkingLevel + (okModel && okThink ? " ✅" : " ❌ 空"));
    if (okModel && okThink) sawTruth = true;
    // 不变量②：任何帧都不许空——真值/记忆都到位后空帧回刷会把页脚冲成「—」（状态栏 bug）。
    // 带记忆的启动占位（footFromMemory）就是为这把锁存在的
    else { console.log("  ❌ 空 foot 帧（有记忆时启动占位也该带值）"); bad++; }
  }
  // 不变量①：静止态（末帧）页脚必须是真值，状态栏才能不显示「—」
  const last = frames[frames.length - 1];
  if (!last || last.model == null || last.thinkingLevel == null) {
    console.log("❌ 末帧 model/thinking 为空（静止态状态栏显示 —）");
    bad++;
  } else {
    console.log("✅ 末帧页脚真值（静止态状态栏有值）");
  }
  // 不变量③：webview 不得被整页重载——html 只在 resolveWebviewView 设一次；
  // 空 render 换鸭子图曾 applyHtml 重载整个 webview（丢流式/丢焦/消息 Canceled）
  if (view.webview._htmlSets !== 1) {
    console.log("❌ webview.html 被重设 " + view.webview._htmlSets + " 次（整页重载事故）");
    bad++;
  } else {
    console.log("✅ webview.html 只设 1 次（无意外整页重载）");
  }
  // 不变量④：webviewReady 同步处理必须快——卡 1s+ 即握手/消息连坐阻塞
  if (readyMs > 400) {
    console.log("❌ webviewReady 同步处理耗时 " + readyMs + "ms（>400ms，消息处理被阻塞）");
    bad++;
  } else {
    console.log("✅ webviewReady 同步处理 " + readyMs + "ms（无阻塞）");
  }
  // 不变量⑤：webview 红字桥被 panel 级截获（不回投 webview、不进核心链路）
  if (errForwarded !== 0) {
    console.log("❌ wvError 被回投 " + errForwarded + " 条（应只落盘）");
    bad++;
  } else {
    console.log("✅ wvError 红字桥被截获（只落盘不回投）");
  }
  // 不变量⑥（续）：见上方并发去重检测
  if (!deduped) {
    console.log("❌ 会话列表快扫并发未去重（连点 N 次 = 扫 N 遍，列表卡十几秒）");
    bad++;
  } else {
    console.log("✅ 会话列表快扫并发去重（多路共享一次扫描）");
  }
  console.log(bad ? "❌ " + bad + " 项不过" : "✅ 全绿");
  process.exit(bad ? 1 : 0);
}, Number(process.env.WAIT || (process.env.DIAG ? 3500 : 800)));
