// ModelRuntime.create 冷热成本探针（2026-11-03 启动慢战役第三段）：
// 真机 [boot-svc] mr=2721/3030ms、[boot] bench mr-create 最高 4517ms，离线曾测 257ms（无 refreshOnCreate 选项）。
// 本探针用客户端同款参数复测冷/热，并分别关网络/关 store 刷新定位。
// 用法：node scripts/probe/probe-modelruntime.mjs
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const agentDir = path.join(os.homedir(), ".pi/agent");
const base = { authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") };
const t = () => Date.now();

async function run(label, opts) {
  const a = t();
  try {
    const mr = await ModelRuntime.create({ ...base, ...opts });
    const models = mr.getModels?.()?.length ?? "?";
    console.log(label.padEnd(46), String(t() - a).padStart(6) + "ms", "models=" + models);
  } catch (e) {
    console.log(label.padEnd(46), "ERR", String(e?.message ?? e).slice(0, 70));
  }
}

await run("① 客户端同款（refreshOnCreate:false）冷", { refreshOnCreate: false });
await run("① 同上 第2次（热）", { refreshOnCreate: false });
await run("② 不带 refreshOnCreate（默认，可能走网络）", {});
await run("③ 默认 + allowModelNetwork:false", { allowModelNetwork: false });
