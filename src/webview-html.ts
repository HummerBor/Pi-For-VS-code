import { readFileSync } from "fs";
import { join } from "path";
import { STRINGS, Lang } from "./i18n";

/**
 * webview HTML 装配：
 * - HTML 模板在 webview/index.html（vite 构建时拷贝到 dist/webview/，源码不随 vsix 分发）
 * - CSS / JS 由 vite 构建到 dist/webview/main.css / main.js
 * - 这里读取产物，替换模板占位符：{{key}} 取运行时变量，{{t:key}} 取 i18n 文案
 * VS Code 的 webview HTML 必须运行时生成（CSP nonce / i18n / 条件片段），所以是“模板 + 填充”而不是静态文件。
 */

let cachedTemplate = "";
let cachedJs = "";
let cachedCss = "";

function loadAssets(): { template: string; js: string; css: string } {
  const dir = join(__dirname, "..", "dist", "webview");
  if (!cachedTemplate) cachedTemplate = readFileSync(join(dir, "index.html"), "utf8");
  if (!cachedJs) cachedJs = readFileSync(join(dir, "main.js"), "utf8");
  if (!cachedCss) {
    try { cachedCss = readFileSync(join(dir, "main.css"), "utf8"); } catch { cachedCss = ""; }
  }
  return { template: cachedTemplate, js: cachedJs, css: cachedCss };
}

export function getHtml(
  theme = "midnight",
  duckUri = "",
  floorColor = "#1f1f1f",
  bgImage = "",
  bgOpacity = 0.35,
  lang: Lang = "zh",
): string {
  const L = STRINGS[lang];
  const nonce = Math.random().toString(36).slice(2);
  const { template, js, css } = loadAssets();

  const vars: Record<string, string> = {
    lang,
    langBtn: lang === "zh" ? "EN" : "中",
    theme,
    nonce,
    duckUri,
    // 样式注入整体在 TS 侧拼装：模板里不放 CSS，避免编辑器把 {{css}} 占位符当真 CSS 报错
    headAssets:
      "<style>" + css + "</style>" +
      "<style>html { background: " + floorColor + " !important; }</style>",
    // 防止产物里出现 </script 提前闭合标签
    js: js.replace(/<\/script/gi, "<\\/script"),
    // 条件片段：背景图层
    bgLayer: bgImage ? `<div id="bg-layer" style="background-image:url('${bgImage}');opacity:${bgOpacity}"></div>` : "",
  };

  return template.replace(/\{\{(?:(\w+):)?([\w.]+)\}\}/g, (_, ns: string | undefined, key: string) => {
    // 占位符拼写错误若静默变空串，症状是 CSP 拦脚本/文案消失，无从排查 —— 未知 key 直接喊出来
    if (ns === "t") {
      if (!(key in L)) console.warn("[pi-for-vscode] i18n 字典缺少 key: " + key);
      return String(L[key] ?? "");
    }
    if (!(key in vars)) console.warn("[pi-for-vscode] HTML 模板未知占位符: {{" + key + "}}");
    return vars[key] ?? "";
  });
}
