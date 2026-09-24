/**
 * fileFinder —— 文件/符号点开的查找层（刀 C 第四簇纯函数部分自 panel.ts 搬出）。
 *
 * 搬运纪律（同 changes.ts/sessionCache.ts）：函数体自 panel.ts 逐字符搬运、行为零变化。
 * 职责：点开聊天里的光文件名/符号时有界搜索定位（工作区外的 pi 内部文件、pi 包源码内符号）。
 * findToken 保持模块内部（grepInPiPackage 专用）。教训注释随逻辑走。
 */
import * as fs from "fs";
import * as path from "path";
import { findPiPackageRoot } from "../pi/piSdk";

/**
 * 有界广度搜索同名文件（2026-09-23「这些都点不开」刀2）：点开聊天里的光文件名时，
 * pi 内部文件（~/.pi/agent 下的 agent 数据、装的技能/扩展）不在工作区，工作区 findFiles
 * 必然扑空 → 永远「找不到文件」。用 BFS（浅层优先）而不是 DFS：basename 同名时浅层的
 * 数据文件（如 agent/models-store.json）不该被 git 仓库里的深层同名文件截胡。
 * 跳 node_modules/.git、访问条目封顶，防大目录拖死宿主。
 */
export function findUnderDir(rootDir: string, base: string, budget = 4000): string | undefined {
  const queue: string[] = [rootDir];
  while (queue.length && budget > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (budget-- <= 0) return undefined;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        queue.push(full);
      } else if (e.isFile() && e.name === base) {
        return full;
      }
    }
  }
  return undefined;
}

/**
 * （2026-09-23「这些都点不开」刀3）：在 pi 包源码里搜符号首个命中并回报文件+行列。
 * 对象是 ModelRuntime.create 这类 pi 私有类.成员——用户截图实锤「全是 pi 私有类、没导出」，
 * 公开 API/工作区符号都到顶，文本搜索是唯一可行的「点开」。
 * 有界：BFS 只扫 js/mjs/cjs/ts/mts，跳 node_modules/.git，文件数封顶——点击时一次性动作，
 * 不许拖死宿主。命中边界校验防 ModelRuntime.createX 误配。
 */
export function grepInPiPackage(sym: string): { file: string; line: number; col: number } | undefined {
  const root = findPiPackageRoot();
  if (!root) return undefined;
  const queue: string[] = [root];
  let files = 0;
  while (queue.length && files < 1500) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        queue.push(full);
      } else if (e.isFile() && /\.(?:m?js|cjs|m?ts)$/.test(e.name)) {
        files++;
        let text: string;
        try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
        if (text.length > 8 * 1024 * 1024) continue;
        const idx = findToken(text, sym);
        if (idx >= 0) {
          const before = text.slice(0, idx);
          return { file: full, line: before.split("\n").length, col: idx - (before.lastIndexOf("\n") + 1) + 1 };
        }
      }
    }
  }
  return undefined;
}

/** 符号边界查找：命中位置前后不能是标识符字符 */
function findToken(text: string, sym: string): number {
  for (let from = 0; ; ) {
    const i = text.indexOf(sym, from);
    if (i < 0) return -1;
    const a = i > 0 ? text[i - 1] : "";
    const b = text[i + sym.length] ?? "";
    if (!/[\w$]/.test(a) && !/[\w$]/.test(b)) return i;
    from = i + 1;
  }
}
