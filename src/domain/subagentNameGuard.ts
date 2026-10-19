/**
 * 子 agent 调用分类归位的派发层钩子（两层分离的宿主半边，2026-09-24 用户拍板）。
 * 需求与台账口径见 subagentNames.ts 头注释；本文件只负责「按 pi 分类」那一层：
 * tool_call 时把未注册名归位默认分类（worker 优先，否则第一个注册名），
 * pi 的注册表/校验原样保留——「Pi 底层该是啥还是啥」，pi 内容零改动。
 *
 * 挂点：SDK 给宿主的内联扩展口 resourceLoaderOptions.extensionFactories（sdk.md「Extensions」），
 * 由 piClient 建 services 时带上。
 *
 * 本文件宿主专用（fs/path）：别让 webview 共享模块 import 它（webview 编译无 node 类型）；
 * 纯逻辑（台账/归位算法）在 subagentNames.ts，node 裸跑用例直接测那边，本文件不进用例
 * （薄读盘层，债务记在 AGENTS.md 口径外——注册名解析与 subagent 扩展 agents.ts 同准入：
 * frontmatter 无 name 不算注册）。
 */
import * as fs from "fs";
import { join, resolve } from "path";
import { classifyDispatchName, noteDispatchNames, rewriteSubagentInput } from "./subagentNames";

/** 读一个 agents 目录的注册名（frontmatter name: 行；YAML 剥引号/行内注释，复杂标量不做） */
export function agentNamesFromDir(dir: string | null): string[] {
  if (!dir) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".md")) continue;
    let text: string;
    try {
      text = fs.readFileSync(join(dir, e), "utf-8");
    } catch {
      continue;
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) continue;
    const m = /^\s*name:\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/m.exec(fm[1]);
    const name = m?.[1]?.trim();
    if (name) names.push(name);
  }
  return names;
}

/** 就近向上找项目级 .pi/agents（与 subagent 扩展 agents.ts 的找法同口径） */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* 继续向上 */
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 按调用参数的 agentScope 算有效分类集合（默认 "user"，与 subagent 扩展 discoverAgents 同口径） */
function validNamesFor(agentScope: unknown, sdk: any, cwd: string): string[] {
  const user = agentNamesFromDir(join(sdk.getAgentDir(), "agents"));
  const project = agentNamesFromDir(findNearestProjectAgentsDir(cwd));
  if (agentScope === "project") return project;
  if (agentScope === "both") return Array.from(new Set([...user, ...project]));
  return user;
}

/**
 * 产出内联扩展（piClient 建 services 时挂 resourceLoaderOptions.extensionFactories）。
 * sdk 只用到 getAgentDir()（agents 目录定位），cwd 是 services 绑定的会话目录。
 * 注册表每次调用现读（subagent 调用相对 LLM 回合是稀疏事件，加缓存省不出什么）。
 */
export function makeSubagentNameGuard(sdk: any, cwd: string): { name: string; factory: (pi: any) => void } {
  return {
    name: "subagent-name-guard",
    factory: (pi: any) => {
      pi.on("tool_call", (event: any) => {
        if (!event || event.toolName !== "subagent" || !event.input || typeof event.input !== "object") return;
        const input = event.input as Record<string, unknown>;
        // 先记台账（原名），再归位改写——顺序反了台账里就是分类名了
        noteDispatchNames(input);
        const valid = validNamesFor(input.agentScope, sdk, cwd);
        const fallback = valid.includes("worker") ? "worker" : valid[0] ?? null;
        rewriteSubagentInput(input, (n) => classifyDispatchName(n, valid, fallback));
      });
    },
  };
}
