// 实证探针：恢复被压缩的会话，看 session.messages 里有没有 compactionSummary 折叠块消息。
// 对照 piClient.ts 的工厂姿势（零模型调用，只加载会话文件）。
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
import { existsSync } from "node:fs";
// exports 映射封锁子路径，require.resolve 解不了——直接试两个已知安装位置
const candidates = [
  join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@earendil-works", "pi-coding-agent"),
  join(process.env.APPDATA ?? "", "nvm", "v24.19.0", "node_modules", "@earendil-works", "pi-coding-agent"),
];
const root = candidates.find((c) => existsSync(join(c, "dist", "index.js")));
if (!root) throw new Error("找不到 pi 包安装位置");
const sdk = await import(pathToFileURL(join(root, "dist", "index.js")).href);

const file = process.argv[2];
if (!file) { console.error("用法: node scripts/probe-compact.mjs <session.jsonl>"); process.exit(1); }

const cwd = "D:/work/docs/pi test/pi-vscode";
const services = await sdk.createAgentSessionServices({ cwd });
const sessionManager = sdk.SessionManager.open(file, undefined, cwd);
const runtime = await sdk.createAgentSessionRuntime(
  async (opts) => {
    const s = await sdk.createAgentSessionServices({ cwd: opts.cwd });
    return { ...(await sdk.createAgentSessionFromServices({ services: s, sessionManager: opts.sessionManager })), services: s };
  },
  { cwd, agentDir: sdk.getAgentDir(), sessionManager }
);
const session = runtime.session;
const msgs = session.messages;
const roles = msgs.map((m) => m.role);
console.log("消息总数:", msgs.length);
console.log("角色序列前 8:", roles.slice(0, 8).join(", "));
const cs = msgs.filter((m) => m.role === "compactionSummary");
console.log("compactionSummary 条数:", cs.length);
if (cs.length) console.log("首条 tokensBefore:", cs[0].tokensBefore, "| summary 前 60 字:", String(cs[0].summary).slice(0, 60));
process.exit(0);
