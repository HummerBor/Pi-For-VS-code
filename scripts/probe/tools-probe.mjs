// 工单33 注入防线探针：工具策略透传（tools 白名单生效 / noTools 全关）+ 只读工具集不含 bash/write。
// 跑法：node scripts/probe/tools-probe.mjs（先 npm run compile）。三段：
//   ① toolPolicyFields 纯映射（只带显式字段，undefined 键不污染 SDK 缺省语义）
//   ② SDK 端到端：createAgentSessionFromServices 带白名单 → getActiveToolNames 被裁剪
//   ③ createReadOnlyTools 只读集不含 bash/write/edit（采集步的能力裁剪原料）
// 姿势对齐被删的 follow-probe：out/ 编译产物 + 真 SDK（probe-compact 同款定位）。
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { toolPolicyFields } from "../../out/pi/piClient.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg); }
};

console.log("① toolPolicyFields：纯映射，只带显式字段");
ok(JSON.stringify(toolPolicyFields(null)) === "{}", "null 策略 → 空对象（不传键 = pi 默认工具集）");
ok(JSON.stringify(toolPolicyFields({ tools: ["read"] })) === '{"tools":["read"]}', "只设 tools → 只带 tools");
const full = toolPolicyFields({ tools: ["read", "grep", "ls"], excludeTools: ["mcp__*"], noTools: "builtin" });
ok(full.tools.length === 3 && full.excludeTools[0] === "mcp__*" && full.noTools === "builtin", "三字段齐设全带");
ok(!("tools" in toolPolicyFields({ noTools: "all" })) && !("noTools" in toolPolicyFields({ tools: ["read"] })), "未设字段不出现 undefined 键");

// —— 真 SDK 段（probe-compact 同款定位姿势）——
const candidates = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@earendil-works", "pi-coding-agent"),
  path.join(process.env.APPDATA ?? "", "nvm", "v24.19.0", "node_modules", "@earendil-works", "pi-coding-agent"),
];
const root = candidates.find((c) => fs.existsSync(path.join(c, "dist", "index.js")));
if (!root) { console.error("找不到 pi 包安装位置"); process.exit(1); }
const sdk = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tools-probe-"));
const cwd = tmp;
const sessDir = path.join(tmp, "sessions");
fs.mkdirSync(sessDir);

const makeSession = async (policy) => {
  const services = await sdk.createAgentSessionServices({ cwd });
  const sessionManager = sdk.SessionManager.create(cwd, sessDir);
  return sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    ...toolPolicyFields(policy),
  });
};

console.log("② SDK 端到端：tools 白名单 → 活动工具被裁剪（透传生效）");
{
  const s = await makeSession({ tools: ["read", "grep", "ls"] });
  const active = s.session.getActiveToolNames();
  ok(active.every((n) => ["read", "grep", "ls"].includes(n)), `白名单外工具全被裁：active=[${active.join(",")}]`);
  ok(!active.includes("bash") && !active.includes("write") && !active.includes("edit"), "bash/write/edit 不在活动集（只读步硬防线）");
  s.session.dispose?.();
}

console.log("②′ noTools:\"all\" → 全关（写操作步之外的极端裁剪）");
{
  const s = await makeSession({ noTools: "all" });
  const active = s.session.getActiveToolNames();
  ok(active.length === 0, `noTools:"all" 活动工具为空：[${active.join(",")}]`);
  s.session.dispose?.();
}

console.log("③ createReadOnlyTools：只读集不含 bash/write/edit/powerShell");
{
  const tools = sdk.createReadOnlyTools(cwd);
  const names = tools.map((t) => t.name ?? t.toolName ?? "(无名)");
  ok(names.includes("read"), `含 read：[${names.join(",")}]`);
  for (const banned of ["bash", "write", "edit", "powerShell"]) {
    ok(!names.includes(banned), `不含 ${banned}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
