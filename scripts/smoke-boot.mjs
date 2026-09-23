// A 刀主链路冒烟（2026-09-23）：零 LLM、纯本地链路、真 PiClient（仅 prompt 打桩防真模型调用）。
// Z 刀教训的落地：主链路改动没自测不装机——本脚本就是「装机前冒烟」的机器化。
//
// 模拟 panel 的 webviewReady 流程：ensureClient → postUiState，断言四条主链路语义：
//  ① 首帧 uiState 不等 pi init——必须早于 boot 链尾的权威 render（A 刀前 postUiState 被
//     restoringSession + collectState(getState 等 init) 双闸压着，首帧必然晚于权威 render）
//  ② 首帧 uiState 带快路径缓存消息（历史不空窗）
//  ③ 启动中发消息：乐观 busy 出现、prompt 到达 client（不丢、不再被挡——V 刀语义不回归）
//  ④ 启动期再插一次 postUiState（=切页签重绘）不挂起（<500ms 返回）
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { readdirSync, statSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { PiCore } = require(join(root, "out", "piCore.js"));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
};

// —— 找一个真实会话文件（含消息的主会话，跳过 subagent 孪生）——
function findSessionFile() {
  const base = "C:/Users/Administrator/.pi/agent/sessions";
  let best = null;
  for (const dir of readdirSync(base)) {
    let files = [];
    try {
      files = readdirSync(join(base, dir)).filter((f) => f.endsWith(".jsonl") && !f.startsWith("subagent-"));
    } catch { continue; }
    for (const f of files) {
      const p = join(base, dir, f);
      try {
        const sz = statSync(p).size;
        if (!best || sz > best.sz) best = { p, sz };
      } catch { /* skip */ }
    }
  }
  return best?.p;
}

const sessionFile = findSessionFile();
if (!sessionFile) { console.error("找不到真实会话文件，冒烟无法覆盖快路径"); process.exit(2); }
console.log("样本会话: " + sessionFile);

// —— 宿主打桩（HostCapabilities / UiActions 都不碰 vscode）——
const scratch = mkdtempSync(join(tmpdir(), "pi-smoke-boot-"));
const caps = {
  getCwd: () => scratch,
  getConfig: (_s, _k, d) => d,
  getPersist: (_k, d) => d,
  setPersist: () => {},
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showConfirm: async () => false,
  notify: async () => undefined,
  uiRequest: () => {},
};
const ui = new Proxy({}, { get: () => () => Promise.resolve() });

const posts = [];
const post = (m) => posts.push({ t: Date.now(), m });
const core = new PiCore(caps, ui, post, "smoke");
core.lang = "zh";
core.tabKey = "smoke1";
// 会话记忆直供（绕开 persist 接线，只测主链时序）
core.getSessionForWs = () => sessionFile;

const T0 = Date.now();
// —— panel webviewReady 等价流程 ——
const client = core.ensureClient();
const promptCalls = [];
client.prompt = async (text) => { promptCalls.push({ t: Date.now(), text }); };
void core.postUiState();

// —— 启动中发消息（V 刀语义：不再被挡）——
setTimeout(() => {
  core.onWebviewMessage({ type: "prompt", text: "smoke-启动中消息" });
}, 30);
// —— 启动期切页签重绘（postUiState 不许挂起）——
let switchLatency = null;
setTimeout(() => {
  const t = Date.now();
  void core.postUiState().then(() => { switchLatency = Date.now() - t; });
}, 200);

// —— 收集 3.5s 后判卷（init 未完也有 4s pendingPrompt 兜底在跑，process.exit 统一收口）——
setTimeout(() => {
  const uiStates = posts.filter((p) => p.m.type === "uiState");
  const renders = posts.filter((p) => p.m.type === "render");
  const busies = posts.filter((p) => p.m.type === "busy");
  const first = uiStates[0];
  const lastRender = renders.length ? renders[renders.length - 1] : null;

  check("① 首帧 uiState 不等 init（早于 boot 链尾权威 render）",
    !!(first && lastRender && first.t < lastRender.t),
    first && lastRender ? "首帧+" + (first.t - T0) + "ms vs 权威render+" + (lastRender.t - T0) + "ms" : "缺帧");
  check("② 首帧带快路径历史（非空）",
    !!(first && Array.isArray(first.m.messages) && first.m.messages.length > 0),
    first ? "首帧消息数=" + (first.m.messages?.length ?? 0) : "无首帧");
  check("③ 启动中发消息：prompt 到达 client",
    promptCalls.length > 0 && promptCalls[0].text === "smoke-启动中消息",
    "prompt 调用=" + promptCalls.length + " 次");
  check("③ 启动中发消息：乐观 busy 上屏",
    busies.some((p) => p.m.value === true),
    "busy 帧=" + busies.map((p) => String(p.m.value)).join(","));
  check("④ 启动期 postUiState 不挂起（<500ms）",
    switchLatency !== null && switchLatency < 500,
    "耗时=" + switchLatency + "ms");

  const fail = results.some((r) => !r.ok);
  console.log(fail ? "\n冒烟 FAIL" : "\n冒烟 PASS");
  process.exit(fail ? 1 : 0);
}, 3500);
