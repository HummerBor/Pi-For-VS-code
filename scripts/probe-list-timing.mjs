// 探针：量插件会话列表真实调用路径的分段耗时（2026-10-19，22s 之谜定案用）
// 路径 = 插件同款：loadPiSdk(bundle import) → SessionManager.list / listAll(onProgress)
// 关键指标：
//   sdkImportMs  —— bundle import 一次的代价（piSdk M 刀后的加载路径）
//   firstPartialMs —— 第一条 partialSessions 到达时刻（pi -r TUI 的首屏就画这个）
//   totalMs      —— 全量完成（插件现在等的就是这个才上屏）
// 用法：node scripts/probe-list-timing.mjs [cwd]
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";

const root = join(os.homedir(), ".pi", "agent", "..", ".."); // 占位，下面用 node_modules 实际定位
// 与 src/pi/piSdk.ts 同款：本地 node_modules 优先
const localPkg = process.env.PI_ROOT ? join(process.env.PI_ROOT, "package.json") : join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
let pkgRoot;
try {
  pkgRoot = dirname(await import("node:module").then((m) => m.createRequire(import.meta.url).resolve(localPkg)));
} catch {
  console.error("找不到本地 pi 包");
  process.exit(1);
}
const entry = join(pkgRoot, "dist", "bundle", "index.js");
console.log("pi 包:", pkgRoot);

const t0 = Date.now();
const sdk = await import(pathToFileURL(entry).href);
const sdkImportMs = Date.now() - t0;
console.log(`sdkImportMs = ${sdkImportMs}`);

const cwd = process.argv[2] || process.cwd();

async function probe(label, fn) {
  let firstPartialMs = null;
  let partialCount = 0;
  const t = Date.now();
  const onProgress = (loaded, total, partial) => {
    if (partial && partial.length && firstPartialMs === null) {
      firstPartialMs = Date.now() - t;
      partialCount++;
      console.log(`  [${label}] first partial @ ${firstPartialMs}ms (${partial.length} 条, loaded=${loaded}/${total})`);
    } else if (partial) {
      partialCount++;
    }
  };
  const sessions = await fn(onProgress);
  const totalMs = Date.now() - t;
  console.log(`[${label}] totalMs = ${totalMs}, firstPartialMs = ${firstPartialMs}, partial 发布次数 = ${partialCount}, 条数 = ${sessions.length}`);
}

await probe("list(cwd)", (cb) => sdk.SessionManager.list(cwd, undefined, cb));
await probe("listAll", (cb) => sdk.SessionManager.listAll(cb));
// 再跑一遍（热路径对比：memo 命中与否不影响这个探针，量的是 pi 本身重复全扫的代价）
await probe("listAll #2", (cb) => sdk.SessionManager.listAll(cb));
