/**
 * 毛玻璃 A/B 实测（调试辅助）：拷贝 preview.html 生成两份——
 *   .glass-on.html  强制 hover 态 + blur(28px)
 *   .glass-off.html 强制 hover 态 + backdrop-filter:none（其余完全一致）
 * 无头 Chrome 各截一张，对比玻璃后面内容：off 应见锐利文字透出，on 应见模糊色块。
 * 若两张看不出差别 = blur 在真页面里真没生效（结构性问题）；有差别 = 浏览器正常。
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const html = readFileSync(join(root, "dist", "webview", "preview.html"), "utf8");

// lastIndexOf：payload（会话数据）里可能内嵌 </body>，必须锚最后一个
function make(mode) {
  const blur = mode === "on"
    ? "backdrop-filter: blur(28px) saturate(1.4) !important; -webkit-backdrop-filter: blur(28px) saturate(1.4) !important;"
    : "backdrop-filter: none !important; -webkit-backdrop-filter: none !important;";
  return html.slice(0, html.lastIndexOf("</body>")) + `<style id="force-glass">
  .outline { display:flex !important; pointer-events:auto !important;
    background: rgba(28,28,34,.62) !important; border-color: rgba(255,255,255,.08) !important; ${blur} }
  .outline .ol-label { max-width:240px !important; opacity:1 !important; transform:none !important; padding:3px 8px !important; }
  .outline .ol-dash { background:#fff !important; }
</style>` + html.slice(html.lastIndexOf("</body>"));
}

writeFileSync(join(root, "dist", "webview", ".glass-on.html"), make("on"));
writeFileSync(join(root, "dist", "webview", ".glass-off.html"), make("off"));
console.log("✓ .glass-on.html / .glass-off.html 已生成");
