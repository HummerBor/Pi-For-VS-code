// 回归：webview-html.getHtml 资源路径（__dirname 下探深度 bug，2026-09-24「还原视图时出错」）。
// 刀 B 把 webview-html.ts 从 src/ 移到 src/vscode/ → __dirname 深一层（out/vscode），
// join(__dirname,"..",...) 少一个 ".." → 去 out/dist/webview（ENOENT）→ applyHtml 抛 →
// resolveWebviewView 抛「还原视图时出错」。教训：移动文件时其内部 __dirname 相对路径要跟着调深度。
// 本用例锁死 getHtml 能读到 dist/webview 资源 + package.json。先 npm run compile 再跑。
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { getHtml } = require("../../out/vscode/webview-html.js");
const html = getHtml("zh", "data:image/png;base64,x", "#000", "", 0.35, "zh");
if (typeof html !== "string" || html.length < 1000) throw new Error("getHtml 返回异常: " + (html && html.length));
if (!/<html/i.test(html)) throw new Error("getHtml 输出不像 HTML");
if (!html.includes("main.js")) throw new Error("getHtml 未注入 JS 资源");
console.log("getHtml 回归 OK（资源路径正确，HTML " + html.length + " 字节）");
