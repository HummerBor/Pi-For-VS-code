/**
 * preview.html stub 语法检查（调试辅助，零依赖）：抽出 nonce script 内的 stub JS，
 * 落临时文件后 node --check。bash 内联 node -e 会吃反斜杠（全局 AGENTS 环境坑），
 * 故独立成文件。
 */
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "dist", "webview", "preview.html"), "utf8");
const marker = "window.__wvLog";
const idx = html.indexOf(marker);
if (idx < 0) throw new Error("stub 未找到（preview.html 里没有 " + marker + "）");
const start = html.lastIndexOf("<script", idx);
const gt = html.indexOf(">", start);
const end = html.indexOf("</" + "script>", idx);
const js = html.slice(gt + 1, end);
console.log("stub 长度:", js.length);
const tmp = join(tmpdir(), "preview-stub-check.js");
writeFileSync(tmp, js);
execFileSync(process.execPath, ["--check", tmp], { stdio: "inherit" });
unlinkSync(tmp);
console.log("✓ stub 语法 OK");
