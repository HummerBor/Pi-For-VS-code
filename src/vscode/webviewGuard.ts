/**
 * webview 自检 + 一键修复（2026-11-04 事故固化，别再删）
 *
 * ── 事故（用户报「一打开插件就报错」，重载窗口治不了）──
 * VS Code 自动更新（2c33b50b16 → 261c84cb1e / 1.144.1）之后，`%APPDATA%\Code\Service Worker`
 * 里只剩**旧 build** 的注册记录，新 build 的 `service-worker.js` 一次都没成功落库。于是每个
 * webview 的壳页（VS Code 自己的 `webview/browser/pre/index.html`，第 269 行
 * `navigator.serviceWorker.register(...)`）在注册那一步抛：
 *   InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state.
 * VS Code 判定「webview 加载失败」，**根本不会调扩展的 resolveWebviewView**——
 * 面板白屏 + 一句用户看不懂的报错，而我们连一行日志都打不出来（代码没被调用过）。
 * 实测治法是：全退 VS Code → 删 `Service Worker` + `Cache` → 重启，壳页重新注册即恢复。
 *
 * ── 为什么扩展侧没有「不用 SW」的开关 ──
 * VS Code 内部给几个自建 webview 显式传了 `disableServiceWorker:!0`
 * （`createWebviewElement` / `createWebviewOverlay` 的私有 options），扩展 API
 * (`WebviewOptions`) 没有这个能力，所以只能「坏了以后自救」，不能「绕过」。
 *
 * ── 本模块干三件事，边界写死 ──
 *  1. 取证 probeServiceWorkerStore()：SW 脚本库里有没有**当前 build** 的脚本
 *     （fresh / stale / unknown 三态；unknown 一律不提示，宁可不提醒也不误报）
 *  2. 自检 startWebviewGuard()：`vscode.version` 变过 && 库是 stale && 15s 内一次
 *     `markWebviewAttached()` 都没有 → 弹提示（每个版本最多烦用户一次）
 *  3. 修复 runWebviewRepair()：写临时脚本 → 无窗口拉起 → 用户退出后删两个目录
 *
 * 【产品口径】用户不知道也不需要知道 service worker 是什么，更不会去翻命令面板。
 * 所以主路径是：面板白屏 → 用户重启 VS Code → 本模块自己取证到 stale 且 pi 以前能用
 * → 弹一条说人话的通知，按钮就写「关闭 VS Code 并修复」（点了才退，不骗人）。
 * 命令面板那条只当兑底给“知道自己在干嘛”的人。
 *
 * 红线：脚本不许自己退 VS Code、不许 taskkill、不许事后自己把 VS Code 拉起来（都已踩过）。
 * 主动退出只允许发生在用户点了「关闭 VS Code 并修复」这个按钮之后。
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { STRINGS, Lang, bb } from "../core/i18n";
import { dbgAppend } from "../core/piCore";

/** 上一次运行时的 VS Code 版本（判据之一：更新后的第一次启动值得提醒） */
const KEY_LAST_VERSION = "piChat.swGuard.lastVscodeVersion";
/** 用户点过「稍后」的版本号：同一版本不再提示（下个版本再坏再提） */
const KEY_DECLINED = "piChat.swGuard.declinedFor";
/** pi 以前在这个机器上成功起过 webview（关键：没有它，自检只在「版本刚变」时醒一次，
 *  用户重载一次之后就永远等不到提示了——2026-11-04 用户实测就是这个状态） */
const KEY_PI_USED = "piChat.swGuard.piUsed";
/** 自检宽限：正常启动 attachView 都在 1s 内到，15s 还没到就是真没起来 */
const GUARD_DELAY_MS = 15000;

/** 本窗口是否成功装配过 webview（panel/sessionsView/transcriptTab 三处成功点共用一个开关） */
let attachedThisWindow = false;
/** 由 startWebviewGuard 注入：让 attach 打点能往 globalState 记一笔「pi 用过」 */
let guardState: vscode.Memento | undefined;

/** webview 装配成功打点：panel.attachView / sessionsView.resolveWebviewView /
 *  transcriptTab 建页签三处调用。只置位不重置——本窗口起来过就不再报警。 */
export function markWebviewAttached(): void {
  attachedThisWindow = true;
  try {
    if (guardState && guardState.get<boolean>(KEY_PI_USED) !== true) void guardState.update(KEY_PI_USED, true);
  } catch { /* 记账失败不影响主链路 */ }
}

/** 诊断/验收用（单测与现场取证都能读） */
export function isWebviewAttached(): boolean {
  return attachedThisWindow;
}

type SwProbeState = "fresh" | "stale" | "unknown";

export interface SwProbe {
  state: SwProbeState;
  /** 一行取证串，直接进 dbgAppend（现场不猜，看这行） */
  detail: string;
}

/** VS Code 用户数据目录（= `<profile>`）。优先抓自身进程 argv 的 `--user-data-dir=`
 *  ——实测扩展宿主是 `Code.exe --type=utility ... --user-data-dir="C:\Users\x\AppData\Roaming\Code"`，
 *  便携版/自定义 profile 时只有这条路能删对地方。拿不到再回退到 %APPDATA%/<产品名>。
 *  为什么只在 Windows 做：事故现场（VS Code 1.144.1 更新后 SW 库陈旧）是 Windows，
 *  macOS/Linux 的 profile 布局不同且有多个候选，宁可不救也不乱删——那边一律 unknown。 */
function profileRoot(): string | null {
  if (process.platform !== "win32") return null;
  const arg = process.argv.find((a) => a.startsWith("--user-data-dir="));
  if (arg) {
    const p = arg.slice("--user-data-dir=".length).replace(/^"(.*)"$/, "$1");
    try {
      if (p && fs.statSync(p).isDirectory()) return p;
    } catch { /* 解析不出就当没有 */ }
  }
  const appData = process.env.APPDATA;
  if (!appData) return null;
  // 稳定版 / Insiders / VSCodium / Cursor 都是「<product>」布局，取第一个真实存在的
  // （不读 package.json 猜名字：用户可能装在任一分支上）
  for (const name of ["Code", "Code - Insiders", "VSCodium", "Cursor"]) {
    const p = path.join(appData, name);
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch { /* 不存在就试下一个 */ }
  }
  return null;
}

/** webview 的 Service Worker 库根：`<profile>/Service Worker` */
function swRoot(): string | null {
  const prof = profileRoot();
  if (!prof) return null;
  const p = path.join(prof, "Service Worker");
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/** 当前 VS Code build 的短 commit（安装目录名 / 更新 URL 里用的那 10 位） */
function currentCommit(): string | null {
  try {
    const raw = fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8");
    const commit = typeof JSON.parse(raw).commit === "string" ? JSON.parse(raw).commit : "";
    return commit ? commit.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** SW 脚本库取证：库里非空、且**一条都不含当前 build 的 commit** = 陈旧（升级后没重建）。
 * ⚠️ 这个判据是 2026-11-04 事故实测出来的：修复前 `grep 261c84cb1e ScriptCache/*` = 0 命中，
 * 清库重启后 = 2 命中。别改成正则/前缀匹配——脚本是压缩 JS，命中就是字面包含。
 * 库为空（`scripts=0`）时给 unknown：新装机器/从没开过 webview 也长这样，不能算陈旧。 */
export function probeServiceWorkerStore(): SwProbe {
  const root = swRoot();
  if (!root) return { state: "unknown", detail: "platform=" + process.platform + " 无 SW 库路径" };
  const cacheDir = path.join(root, "ScriptCache");
  let names: string[] = [];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return { state: "unknown", detail: "无 ScriptCache 目录 root=" + root };
  }
  if (names.length === 0) return { state: "unknown", detail: "SW 库为空（首次启动/没开过 webview）" };
  const commit = currentCommit();
  if (!commit) return { state: "unknown", detail: "读不到 product.json commit appRoot=" + vscode.env.appRoot };
  let hits = 0;
  for (const n of names) {
    try {
      if (fs.readFileSync(path.join(cacheDir, n), "utf8").includes(commit)) hits++;
    } catch { /* 读不动就跳过（占用/权限）——少算命中只会让判断偏保守 */ }
  }
  return {
    state: hits > 0 ? "fresh" : "stale",
    detail: "scripts=" + names.length + " hit=" + hits + " commit=" + commit + " root=" + root,
  };
}

function t(lang: Lang, key: string): string {
  const s = STRINGS[lang]?.[key];
  if (typeof s === "string") return s;
  const zh = STRINGS.zh?.[key];
  return typeof zh === "string" ? zh : key;
}

/** 启动自检（activate 末尾调用一次）。判据：
 *  ① 硬取证 SW 库 stale（空库/非 Windows 一律 unknown，不打扰）
 *  ② 值得提醒：`vscode.version` 变过 **或** pi 在这台机器上用成功过（KEY_PI_USED）
 *     —— 后者是关键：用户重启一次就已过了「版本变」这道门，只靠它会永远静默
 *  ③ 15s 宽限期内零 attachView（起来了说明这次没事，撤）
 * 用户对同一版本点过「稍后」就不再多嘴。 */
export function startWebviewGuard(ctx: vscode.ExtensionContext, lang: Lang): void {
  guardState = ctx.globalState;
  let versionChanged = false;
  try {
    const last = ctx.globalState.get<string>(KEY_LAST_VERSION);
    versionChanged = last !== vscode.version;
    void ctx.globalState.update(KEY_LAST_VERSION, vscode.version);
  } catch { /* globalState 坏掉不该阻断激活 */ }
  const piUsed = ctx.globalState.get<boolean>(KEY_PI_USED) === true;
  const probe = probeServiceWorkerStore();
  dbgAppend(
    "[sw-guard] vscode=" + vscode.version + " versionChanged=" + String(versionChanged) +
      " piUsed=" + String(piUsed) + " probe=" + probe.state + " " + probe.detail
  );
  if (probe.state !== "stale") return;
  if (!versionChanged && !piUsed) return;
  // 写死的比较陷阱（2026-11-04 自测踩到）：两个 undefined 也相等，直接全局相等比较会把
  // 「从没点过稍后」当成「点过了」→ 自检静默失效。必须要求 declined 是非空字符串。
  const declined = ctx.globalState.get<string>(KEY_DECLINED);
  if (typeof declined === "string" && declined !== "" && declined === vscode.version) {
    dbgAppend("[sw-guard] 本版本用户已选「稍后」，跳过");
    return;
  }
  const timer = setTimeout(() => {
    if (attachedThisWindow) {
      dbgAppend("[sw-guard] 15s 内 webview 已装配，撤掉自检");
      return;
    }
    dbgAppend("[sw-guard] 15s 内零 attachView → 弹修复提示（SW 库 stale）");
    void offerRepair(ctx, lang);
  }, GUARD_DELAY_MS);
  ctx.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

/** 预览入口（测试用，2026-11-04 用户问「我怎么测一版」）：不走取证、不等 15s，
 *  直接把用户会看到的那条提示弹出来——点「稍后」不会把真正的自检静默掉。 */
export async function previewRepairNotice(ctx: vscode.ExtensionContext, lang: Lang): Promise<void> {
  dbgAppend("[sw-guard] 预览提示（测试入口）");
  await offerRepair(ctx, lang, { declineOnLater: false });
}

/** 弹提示 → 用户点「关闭 VS Code 并修复」才动手（兵不血刃：按钮文案就是后果本身）。
 *  文案用 bb()（中 / EN 同行），与 BackgroundCover 那类“带来源的双语提示”同款式——
 *  装英文 UI 或只瞥一眼弹窗的人都能立刻看懂发生了什么、点下去会怎样。
 *  declineOnLater=false 时点「稍后」不记账（预览入口专用，不能把真正的自检静默掉）。 */
async function offerRepair(ctx: vscode.ExtensionContext, lang: Lang, opts?: { declineOnLater?: boolean }): Promise<void> {
  const later = bb("swRepairLater");
  const now = bb("swRepairNow");
  const pick = await vscode.window.showWarningMessage(bb("swRepairMsg"), now, later);
  dbgAppend("[sw-guard] 自检提示选择=" + String(pick ?? "(关闭)"));
  if (pick !== now) {
    if (pick === later && opts?.declineOnLater !== false) void ctx.globalState.update(KEY_DECLINED, vscode.version);
    return;
  }
  await runWebviewRepair(lang, { quit: true });
}

/** 准备修复：写脚本 + 无窗口拉起 + 告诉用户下一步。
 *
 * 【红线，2026-11-04 用户实测后拍死的】这个方法**不得**退出/重启 VS Code、**不得** kill 进程、
 * 也不得让脚本在事后自己把 VS Code 拉起来。上一版三条都干了：命令面板一执行 → 800ms 后自己
 * workbench.action.quit、还冒出一个黑控制台、脚本退出后又自动 start 一次 VS Code。从用户角度看
 * 就是「我只点了条命令，窗口自己没了、又自己开了，还窜出个黑框」。
 * 现在只做一件事：把待执行的清理写成脚本、在后台无声等用户退出，其余全部交给用户手动决定。
 * 用户不退 → 脚本 3 分钟后自己结束，什么都不删，可重新执行。 */
export async function runWebviewRepair(lang: Lang, opts?: { quit?: boolean }): Promise<boolean> {
  const root = swRoot();
  if (!root) {
    void vscode.window.showErrorMessage(t(lang, "swRepairUnsupported"));
    return false;
  }
  const script = writeRepairScript(path.dirname(root)); // <profile>/Service Worker → <profile>
  if (!script) {
    void vscode.window.showErrorMessage(t(lang, "swRepairFailed"));
    return false;
  }
  // 拉起方式：**必须经 wscript 的 VBS 中转**（2026-11-04 用户实测踩到）：
  // 直接 `spawn("cmd.exe", { detached:true, windowsHide:true })` 在 Windows 上照样会
  // 冒出一个黑控制台（标题还是当时的命令 `find /I "Code.exe"`）。`detached` 会给新进程组
  // 配一个新控制台，`windowsHide` 的 CREATE_NO_WINDOW 拦不住；VBS 的 sh.Run(..., 0, ...)
  // 才是真正无窗口（已用 cscript 实跑验证：隐藏拉起 + 目标 cmd 正常执行）。
  try {
    const launcher = writeHiddenLauncher(script);
    const child = launcher
      ? spawn("wscript.exe", ["//B", "//Nologo", launcher], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    dbgAppend("[sw-guard] 待命脚本已拉起 pid=" + String(child.pid) + " launcher=" + String(launcher || "cmd直接") + " script=" + script);
  } catch (e) {
    dbgAppend("[sw-guard] 待命脚本拉起失败 " + String(e));
    void vscode.window.showErrorMessage(t(lang, "swRepairFailed"));
    return false;
  }
  // 拉起后**绝不自己退 VS Code**（2026-11-04 用户实测事故）：上一版在 800ms 后自己调
  // workbench.action.quit，用户从命令面板跑完这条命令就直接被重启，还冒出一个黑控制台，
  // 体验上跟“插件把我窗口弄崩了”没区别。现在的约定是：脚本只负责等，退出与否由用户决定；
  // 用户不退 → 脚本 3 分钟后静静退出，什么也不删，可以再执行一次。
  // 只有用户主动点了「关闭 VS Code 并修复」这个按钮（按钮文案已写明后果），才代为退出。
  // 命令面板那条（opts.quit 为空）一律不动窗口，只给提示。
  if (opts?.quit) {
    void vscode.window.showInformationMessage(t(lang, "swRepairQuitting"));
    setTimeout(() => {
      void Promise.resolve(vscode.commands.executeCommand("workbench.action.quit")).then(
        () => dbgAppend("[sw-guard] 用户已选修复 → 已请求 quit"),
        (e) => dbgAppend("[sw-guard] quit 调用失败 " + String(e))
      );
    }, 800);
  } else {
    void vscode.window.showInformationMessage(t(lang, "swRepairNext"));
  }
  return true;
}

/** 写 VBS 隐藏启动器：`sh.Run "cmd.exe /c \"<cmd>\"", 0, False` —— 第 2 参 0 = 窗口隐藏。
 *  VBS 字符串里的双引号要写成 `""`（VBS 转义），所以 cmd 路径外面裹三个双引号。 */
function writeHiddenLauncher(cmdPath: string): string | null {
  const file = path.join(os.tmpdir(), "pi-fix-webview-" + Date.now() + ".vbs");
  const body = [
    "' 由 pi-for-vscode 的 webview 自检生成：无窗口地跑修复脚本（cmd 直接 detached 会冒黑框）",
    'Set sh = CreateObject("WScript.Shell")',
    // VBS 字符串里的双引号写成 ""：这行的实际命令行 = cmd.exe /c "<cmd>"
    'sh.Run "cmd.exe /c ""' + cmdPath + '""", 0, False',
    "",
  ].join("\r\n");
  try {
    fs.writeFileSync(file, body, "utf8");
    return file;
  } catch (e) {
    dbgAppend("[sw-guard] 写隐藏启动器失败（回退 cmd 直启，会冒黑框） " + String(e));
    return null;
  }
}

/** 写临时 .cmd：等 VS Code 退出 → 删 webview 的 SW/Cache 两个目录。**不重启、不强杀**。
 *  export 出去是为了让验收能在不真跑的前提下 diff 脚本内容。 */
export function writeRepairScript(profileDir: string): string | null {
  const file = path.join(os.tmpdir(), "pi-fix-webview-" + Date.now() + ".cmd");
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    "rem 由 pi-for-vscode 的 webview 自检生成：等 VS Code 退出 -> 清 webview 的 SW 缓存",
    "rem 【红线】等不到就什么也不做：3 分钟超时后静默退出，**不 taskkill、不删目录、不重启**。",
    "rem 重启由用户自己点（上一版脚本自己 start VS Code，从用户角度看就是“窗口自己又开了”）。",
    "set /a n=0",
    ":wait",
    "timeout /t 1 /nobreak >nul",
    'tasklist /FI "IMAGENAME eq Code.exe" 2>nul | find /I "Code.exe" >nul || goto clean',
    "set /a n+=1",
    "if %n% lss 180 goto wait",
    "exit /b",
    ":clean",
    'rd /s /q "' + path.join(profileDir, "Service Worker") + '" 2>nul',
    'rd /s /q "' + path.join(profileDir, "Cache") + '" 2>nul',
    "exit /b",
    "",
  ].join("\r\n");
  try {
    fs.writeFileSync(file, body, "utf8");
    return file;
  } catch (e) {
    dbgAppend("[sw-guard] 写修复脚本失败 " + String(e));
    return null;
  }
}
