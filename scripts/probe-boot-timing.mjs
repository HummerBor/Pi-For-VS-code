// M 刀探针（2026-09-23）：启动慢定位——零副作用实测 boot 链各跳耗时。
// 背景：用户报「终端 pi -r/-c 秒开，插件启动卡；两个窗口都慢」→ 会话加载/SDK 本身
// 排除，嫌疑收敛到「插件 boot 链把网络调用（getModeAndModel→listModels）串行挡在
// 首帧渲染之前」。本探针独立加载 pi 包计时各跳，不建会话（不落盘）、不动配置。
// 用法：node scripts/probe-boot-timing.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const t0 = Date.now();
const { loadPiSdk } = require("../out/piSdk.js");
const t1 = Date.now();
const sdk = await loadPiSdk();
const t2 = Date.now();

let models = null, listErr = null, t3;
try {
  models = await sdk.listModels();
  t3 = Date.now();
} catch (e) {
  t3 = Date.now();
  listErr = (e && e.message) || String(e);
}

let warmErr = null, t4 = Date.now();
try {
  await sdk.listModels();
} catch (e) {
  warmErr = (e && e.message) || String(e);
}
const t5 = Date.now();

let svcMs = null, svcErr = null;
try {
  const s0 = Date.now();
  await sdk.createAgentSessionServices({ cwd: process.cwd() });
  svcMs = Date.now() - s0;
} catch (e) {
  svcErr = (e && e.message) || String(e);
}

console.log(JSON.stringify({
  locateAndRequireMs: t1 - t0,
  loadPiSdkMs: t2 - t1,
  listModelsColdMs: t3 - t2,
  listModelsWarmMs: t5 - t4,
  modelCount: models ? (models.length ?? Object.keys(models).length) : 0,
  listErr,
  warmErr,
  createServicesMs: svcMs,
  svcErr,
}, null, 2));
