// 冷启动 services 分解探针（2026-11-04 启动慢战役第四段）
//
// 真机日志冷启动：`[boot-svc] mr=3506ms create=6931ms 合计=10439ms`（首次），
// 同窗口后续 services 只有 172~242ms（热）。而 probe-modelruntime.mjs 里
// ModelRuntime.create 单跑仅 27ms —— 差 130 倍，说明「单个 API 的成本」不是答案，
// 答案是「冷启动那一刻进程里同时在干什么」。
//
// 头号嫌疑：prewarmPiServices（piClient.ts:116）在 createServices **之前**就把 pi
// bundle 的 78 个 chunks 全动态 import 了一遍（chunks-preload）= 同一线程上塞满
// 「解析+编译 7.7MB bundle」的同步 CPU 活，mr-create/createServices 的 await 只能排在后面。
//
// 用法：node scripts/probe/probe-cold-services.mjs <mode>
//   host      复刻宿主顺序：load-pkg → chunks-preload 风暴 → mr → create
//   nopreload 只 load-pkg → mr → create（不预载 chunks）
//   serial    load-pkg → mr → create 全做完，再预载 chunks（顺序调换的对照组）
// 每个 mode 必须在**独立进程**里跑（冷成本是进程级一次性），故一次只跑一个 mode。
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { readdirSync } from "fs";
import { pathToFileURL } from "url";
import os from "os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { loadPiSdk, findPiPackageRoot, getAgentDirSync } = require(join(root, "out", "pi", "piSdk.js"));

const mode = process.argv[2] || "host";
const cwd = process.argv[3] || root;
const t = () => Date.now();
const log = (label, ms) => console.log(String(ms).padStart(7) + "ms  " + label);

async function preloadChunks() {
  const pkgRoot = findPiPackageRoot();
  const dir = join(pkgRoot, "dist", "bundle", "chunks");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  const dynImport = new Function("u", "return import(u)");
  const t0 = t();
  await Promise.all(
    files.map((f) =>
      dynImport(pathToFileURL(join(dir, f)).href).catch(() => {}),
    ),
  );
  log("chunks-preload (count=" + files.length + ")", t() - t0);
}

const tBoot = t();
const sdk = await loadPiSdk();
log("load-pkg", t() - tBoot);

// 与 getSharedModelRuntime 同参数（piClient.ts:38）
const agentDir = getAgentDirSync() || join(os.homedir(), ".pi", "agent");
async function mkModelRuntime() {
  const t0 = t();
  const mr = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  log("ModelRuntime.create", t() - t0);
  return mr;
}
async function mkServices(mr) {
  const t0 = t();
  const svc = await sdk.createAgentSessionServices({ cwd, modelRuntime: mr });
  log("createAgentSessionServices", t() - t0);
  return svc;
}

let preloadPromise = null;
if (mode === "host") {
  preloadPromise = preloadChunks(); // 不 await：复刻宿主里「火焰与 services 并发」
  const mr = await mkModelRuntime();
  await mkServices(mr);
  await preloadPromise;
} else if (mode === "nopreload") {
  const mr = await mkModelRuntime();
  await mkServices(mr);
} else if (mode === "serial") {
  const mr = await mkModelRuntime();
  await mkServices(mr);
  await preloadChunks();
} else {
  console.error("mode 必须是 host | nopreload | serial");
  process.exit(2);
}
log("TOTAL", t() - tBoot);
process.exit(0);
