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
  solidBg = "",
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
    floorColor,
    duckUri,
    css,
    // 防止产物里出现 </script 提前闭合标签
    js: js.replace(/<\/script/gi, "<\\/script"),
    // 条件片段：纯色背景覆盖 / 背景图层
    solidBgStyle: solidBg ? `<style>body { background: ${solidBg} !important; }</style>` : "",
    bgLayer: bgImage ? `<div id="bg-layer" style="background-image:url('${bgImage}');opacity:${bgOpacity}"></div>` : "",
  };

  return template.replace(/\{\{(?:(\w+):)?([\w.]+)\}\}/g, (_, ns: string | undefined, key: string) =>
    ns === "t" ? String(L[key] ?? "") : vars[key] ?? "",
  );
}
