// pi SessionManager.listAll / list 全量扫描成本（2026-11-03 启动慢战役）。
// 背景：真机 10:44 那次激活里，1MB 会话文件的同步扫描被拖成 2.6s——怀疑是启动期 listAll
// 在同一线程上解析上千个会话文件（左侧列表的数据源），把 prewarm 的 await 一起堵住。
// 用法：node scripts/probe/probe-listall-cost.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const agentDir = path.join(os.homedir(), ".pi/agent");
const dir = path.join(agentDir, "sessions");
const t = () => Date.now();

function walk(p, out) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (e.name.endsWith(".jsonl")) out.push(f);
  }
  return out;
}
const t0 = Date.now();
const files = walk(dir, []);
const totalMB = files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1048576;
console.log(`会话文件 ${files.length} 个，合计 ${totalMB.toFixed(0)}MB（walk ${Date.now() - t0}ms）\n`);

// 注意签名：listAll(sessionDir?) 传错会静默返回 0 条（上面 + dir 的写法就踩了），
// 生产路径（sessionCache.listSessions）不传 sessionDir → 走默认 sessions 根并递归项目桶
for (const [label, fn] of [
  ["listAll() 第1次", () => SessionManager.listAll()],
  ["listAll() 第2次（热）", () => SessionManager.listAll()],
]) {
  const a = t();
  const r = await fn();
  console.log(label.padEnd(24), String(t() - a).padStart(6) + "ms", "sessions=" + r.length);
}

// 对照：project 作用域 list(cwd)（左侧列表默认口径）
{
  const cwd = process.cwd();
  const a = t();
  const r = await SessionManager.list(cwd);
  console.log("list(cwd) 本机项目".padEnd(24), String(t() - a).padStart(6) + "ms", "sessions=" + r.length);
}
