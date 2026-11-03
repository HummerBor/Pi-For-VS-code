// services 冷扫分解探针（2026-11-03 启动慢战役）：
// 背景 —— 真机日志 `[boot] services +9215ms (单跳9197ms)`，怀疑是"扫描慢"。
// 本探针离线拆开：冷/热、逐项关闭（扩展/技能/上下文）、换空 agentDir/空 cwd。
// 结论（2026-11-03 本机）：冷 1322ms、热 200–280ms、地板 95ms、空 agentDir 68ms。
//   → services 本身没有 9 秒的量级；真机 9.2s 属于排队/事件循环饥饿，得看 [boot-svc] 打点。
// 用法：node scripts/probe/probe-services-split.mjs（在仓库根跑，import 走本仓 node_modules）
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createAgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const agentDir = path.join(os.homedir(), ".pi/agent");
const emptyAgent = fs.mkdtempSync(path.join(os.tmpdir(), "empty-agent-"));
const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "empty-cwd-"));

const t0 = Date.now();
const mr = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
});
console.log("ModelRuntime.create（客户端已共享，不算 services）:", Date.now() - t0, "ms\n");

async function run(label, opts) {
  const t = Date.now();
  let info = "";
  try {
    const s = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime: mr,
      resourceLoaderOptions: { extensionFactories: [() => {}] },
      ...opts,
    });
    const ex = s.resourceLoader?.getExtensions?.();
    info = `ext=${ex?.extensions?.length ?? "?"} diag=${s.diagnostics?.length ?? 0}`;
  } catch (e) {
    info = "ERR " + String(e?.message ?? e).slice(0, 60);
  }
  console.log(label.padEnd(56), String(Date.now() - t).padStart(6) + "ms ", info);
}

await run("① 基线 第1次（冷：jiti 现场编译扩展）", {});
await run("① 基线 第2次（热）", {});
await run("① 基线 第3次（热）", {});
await run("② 关扩展", { resourceLoaderOptions: { extensionFactories: [() => {}], noExtensions: true } });
await run("③ 关技能/提示/主题/上下文", {
  resourceLoaderOptions: { extensionFactories: [() => {}], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
});
await run("④ 全关（地板）", {
  resourceLoaderOptions: {
    extensionFactories: [() => {}],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  },
});
await run("⑤ 空 agentDir（无 harness/secc-api/mcp.json）", { agentDir: emptyAgent });
await run("⑥ 空 cwd（无项目侧技能/AGENTS.md）", { cwd: emptyCwd });
await run("⑦ 空 agentDir + 空 cwd", { agentDir: emptyAgent, cwd: emptyCwd });
fs.rmSync(emptyAgent, { recursive: true, force: true });
fs.rmSync(emptyCwd, { recursive: true, force: true });
