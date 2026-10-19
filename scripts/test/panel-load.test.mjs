// panel 运行时回归（mock vscode，零依赖）：加载 panel + resolveWebviewView + webviewReady，
// 捕获 host 推的 uiState，检查 model/thinkingLevel 非空。补 panel 长期缺的运行时覆盖——
// getHtml ENOENT/「还原视图出错」、状态栏模型思考空 这类 bug 只有加载 panel 才暴露（smoke-boot
// 只 require core，够不到）。先 npm run compile。
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const Module = require("module");

const posted = [];
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
    getConfiguration: () => ({ get: (_k, d) => d }),
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
const globalState = { get: (k, d) => (k in store ? store[k] : d), update: (k, v) => void (store[k] = v) };

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
    html: "",
    postMessage: (m) => (posted.push(m), Promise.resolve(true)),
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

// 触发 webviewReady 握手 → host 推 uiState
try { msgHandler && msgHandler({ type: "webviewReady" }); } catch (e) { console.log("webviewReady 处理抛:", e.message); }

setTimeout(() => {
  const frames = posted.filter((m) => m.type === "uiState");
  console.log("uiState 帧数:", frames.length);
  let bad = 0;
  for (const f of frames) {
    const okModel = f.model != null;
    const okThink = f.thinkingLevel != null;
    console.log("  model=" + JSON.stringify(f.model) + " thinkingLevel=" + f.thinkingLevel + (okModel && okThink ? " ✅" : " ❌ 空"));
    if (!okModel || !okThink) bad++;
  }
  console.log(bad ? "❌ " + bad + " 帧模型/思考为空（状态栏显示 —）" : "✅ 状态栏 model/thinking 均非空");
  process.exit(bad ? 1 : 0);
}, 800);
