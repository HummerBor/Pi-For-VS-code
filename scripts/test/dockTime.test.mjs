/**
 * 浮窗时间口径回归（2026-11-18 用户：「完成后把时间换成完成的时间，不用再继续占内存数秒」）。
 *
 * 为什么用源码口径（grab 式）而不是 DOM 冒烟：webview 没仓库内 DOM shim，而这条规则的核心是
 * 「终态行不许再有相对时间 / 1s 定时器不许无条件常驻」——源码里守得住就不会回退。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dock = readFileSync(path.join(root, "webview/features/subagentDock.ts"), "utf8");
const i18n = readFileSync(path.join(root, "src/core/i18n.ts"), "utf8");

// 去注释后再断言（注释里会提到 data-ts / fmtRel 这些历史名词）
const code = dock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

console.log("subagentDock 时间口径：");
ok("终态行不再使用相对时间 fmtRel()", !/\bfmtRel\s*\(/.test(code));
ok("时间列不再挂 data-ts（不参与刷新）", !/data-ts/.test(code));
ok("固定时刻函数 fmtClock() 存在", /function\s+fmtClock\s*\(/.test(code));
ok("秒表只在 syncSubTick 里开（无顶层无条件 setInterval）", !/^\s*setInterval\s*\(/m.test(code) && /function\s+syncSubTick\s*\(/.test(code));
ok("停表用 clearInterval(subTickTimer)", /clearInterval\(subTickTimer\)/.test(code));
ok("renderSubDock 渲染完同步秒表状态", /syncSubTick\(\)/.test(code.split("function renderSubDock")[1] || ""));
ok("对应 i18n 死键已清（smJustNow/smMinAgo/smHourAgo/smDayAgo）",
  !/smJustNow|smMinAgo|smHourAgo|smDayAgo/.test(i18n));

console.log("\ndockTime: " + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
