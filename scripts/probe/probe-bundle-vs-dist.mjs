// 单文件 bundle vs 未打包 dist 的启动成本对照（2026-11-03 启动慢战役）。
// 背景：真机 [boot-svc] mr=2721~3030ms，但用未打包 dist 离线测 ModelRuntime.create 只有 20ms。
// 插件实际加载的是 vendor/pi/dist/bundle/index.js（piSdk.ts 优先 bundle，M 刀），所以必须
// 用同一个入口复测，否则量的不是生产路径。
// 用法：node scripts/probe/probe-bundle-vs-dist.mjs
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

const agentDir = path.join(os.homedir(), ".pi/agent");
const base = { authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") };
const t = () => Date.now();

async function bench(label, entry) {
  const a = t();
  const mod = await import(pathToFileURL(entry).href);
  const tLoad = t() - a;
  const b = t();
  const mr = await mod.ModelRuntime.create({ ...base, refreshOnCreate: false });
  const tMr = t() - b;
  const c2 = t();
  const mr2 = await mod.ModelRuntime.create({ ...base, refreshOnCreate: false });
  console.log(label.padEnd(24), `import=${tLoad}ms`, `mr冷=${tMr}ms`, `mr热=${t() - c2}ms`, "models=" + (mr.getModels?.()?.length ?? "?"));
  mr2?.dispose?.();
  mr?.dispose?.();
}

await bench("① vendor bundle", "vendor/pi/dist/bundle/index.js");
await bench("② 未打包 dist", "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
