/**
 * 工单24 探针（临时实验脚本，用完可删）：在途 assistant 消息到底在不在 session.messages？
 * 决定 piCore 剥离逻辑（stripFrom = baseCount-1 假设「在途消息在 state 里且是末条」）是否成立。
 * 跑法：node scripts/probe-inflight.mjs
 */
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const dynamicImport = new Function("u", "return import(u)");

let root = null;
try {
  root = dirname(require.resolve(join("@earendil-works/pi-coding-agent", "package.json")));
} catch {}
if (!root) { console.error("未找到 pi 包"); process.exit(1); }
const sdk = await dynamicImport(pathToFileURL(join(root, "dist", "index.js")).href);

const CWD = process.cwd();
const sessionManager = sdk.SessionManager.inMemory(CWD);
const createRuntime = async (opts) => {
  const services = await sdk.createAgentSessionServices({ cwd: opts.cwd });
  return {
    ...(await sdk.createAgentSessionFromServices({ services, sessionManager: opts.sessionManager })),
    services,
  };
};
const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
  cwd: CWD,
  agentDir: sdk.getAgentDir(),
  sessionManager,
});
const session = runtime.session;
console.log("model =", session.model?.id);

let updates = 0;
let lastState = "";
const snap = (label, e) => {
  const msgs = session.messages;
  const lastM = msgs[msgs.length - 1];
  const isEvent = e?.message ? lastM === e.message : null;
  const evLen = e?.message?.content
    ? JSON.stringify(e.message.content).length
    : null;
  const stateLen = lastM ? JSON.stringify(lastM.content).length : null;
  const key = `${label} isEvent=${isEvent}`;
  if (key !== lastState || updates < 8) {
    lastState = key;
    console.log(
      `${label} msgs=${msgs.length} lastRole=${lastM?.role ?? "-"} lastIsEventMsg=${isEvent} ` +
        `eventContentChars=${evLen} stateLastContentChars=${stateLen} streaming=${session.isStreaming}`
    );
  }
};

session.subscribe((e) => {
  if (e.type === "message_start") snap("message_start", e);
  else if (e.type === "message_update") { updates++; snap("message_update", e); }
  else if (e.type === "message_end") snap("message_end", e);
  else if (e.type === "agent_start" || e.type === "agent_settled" || e.type === "tool_execution_start" || e.type === "tool_execution_end")
    snap("[" + e.type + "]", e);
});

session.prompt("从 1 数到 200，每个数字一行，不要其他内容").catch((err) => console.error("prompt rejected:", err?.message ?? err));

const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  if (!session.isStreaming && session.messages.some((m) => m.role === "assistant")) break;
}
snap("[done]", null);
console.log("updates =", updates, "final msgs =", session.messages.length);
process.exit(0);
