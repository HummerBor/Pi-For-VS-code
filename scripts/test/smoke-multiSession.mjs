/**
 * 工单十五刀1 开工前置冒烟：同进程建两个 AgentSession，各 prompt 一次，
 * 验证 pi 包无单例假设（事件不串流、状态互相独立）。结论写进 BUILDER.md 回报。
 * 零依赖，node scripts/smoke-multiSession.mjs 直接跑。
 */
import { existsSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const dynamicImport = new Function("u", "return import(u)");

// 定位 pi 包（与 src/piSdk.ts 同逻辑，本地 node_modules 优先）
let root = null;
try {
  root = dirname(require.resolve(join("@earendil-works/pi-coding-agent", "package.json")));
} catch {}
if (!root) {
  console.error("未找到 pi 包");
  process.exit(1);
}
const sdk = await dynamicImport(pathToFileURL(join(root, "dist", "index.js")).href);

const CWD = process.cwd();
const results = [];

async function makeSession(tag) {
  const sessionManager = sdk.SessionManager.inMemory(CWD);
  const createRuntime = async (opts) => {
    const services = await sdk.createAgentSessionServices({ cwd: opts.cwd });
    return {
      ...(await sdk.createAgentSessionFromServices({
        services,
        sessionManager: opts.sessionManager,
      })),
      services,
    };
  };
  const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
    cwd: CWD,
    agentDir: sdk.getAgentDir(),
    sessionManager,
  });
  const session = runtime.session;
  const events = [];
  session.subscribe((e) => {
    if (e.type === "message_update") {
      const d = e.assistantMessageEvent;
      if (d?.type === "text_delta" && d.delta) events.push(d.delta);
    } else {
      events.push("[" + e.type + "]");
    }
  });
  return { tag, session, events };
}

// 两个会话问不同的问题，答案必须各归各——串流 = 单例假设成立，工单退回子进程方案
const prompts = [
  ["A", "只回答一个数字：1+1 等于几？"],
  ["B", "只回答一个数字：2+2 等于几？"],
];

const sessions = [];
for (const [tag, p] of prompts) {
  const s = await makeSession(tag);
  sessions.push(s);
  console.log(`[${tag}] session created, model = ${s.session.model?.id ?? "?"}`);
  s.session.prompt(p).catch((err) => console.error(`[${tag}] prompt rejected:`, err?.message ?? err));
}

// 等两个都跑完（agent_settled），最多 120s
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  if (sessions.every((s) => !s.session.isStreaming && s.session.messages.length >= 2)) break;
}

for (const s of sessions) {
  const assistant = s.session.messages.filter((m) => m.role === "assistant");
  const text = assistant
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(" | ");
  console.log(`\n[${s.tag}] isStreaming=${s.session.isStreaming} messages=${s.session.messages.length}`);
  console.log(`[${s.tag}] assistant text: ${text.slice(0, 200)}`);
  console.log(`[${s.tag}] event stream (first 15): ${s.events.slice(0, 15).join(" ")}`);
  results.push({ tag: s.tag, text, events: s.events.join("") });
}

// 串流判定：A 的事件流里不该出现 B 的答案文本，反之亦然
const a = results.find((r) => r.tag === "A");
const b = results.find((r) => r.tag === "B");
const cross = (x, y) => y.text && x.events.includes(y.text.trim()) && y.text.trim().length > 0;
console.log("\n=== 判定 ===");
console.log("A sessions object distinct:", sessions[0].session !== sessions[1].session);
console.log("A got own answer:", /4|四/.test(a.text) === false);
console.log("B got own answer:", /2|二/.test(b.text) === false && /4|四/.test(b.text));
console.log("A stream contains B answer:", cross(a, b));
console.log("B stream contains A answer:", cross(b, a));
console.log("smoke done");
process.exit(0);