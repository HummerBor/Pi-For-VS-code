/**
 * subagent 工具进度快照（子 agent 监控可视化，2026-09-18）。
 *
 * 数据来源与「插件就是壳」对账：
 * - pi 原生 AgentSession 事件 tool_execution_update 携带 partialResult（extensions/types.d.ts:615），
 *   subagent 扩展在 onUpdate 里持续上报 details.results（每任务含至今为止的完整 messages）——
 *   宿主零轮询，订阅转发即可。本模块只做「details → 展示快照」的纯变换，无任何 IO。
 * - 格式对齐官方扩展折叠视图（index.ts formatUsageStats / 工具调用摘要），别漂移。
 * - 宿主（流式 tool_execution_update/end）与 webview（历史重绘，toolResult.details
 *   是 pi 会话持久化字段，session-format.md「details?: any」）共用本模块，防两处摘要分叉。
 *
 * 防御口径：subagent 扩展是用户侧安装件（本项目 .pi/extensions/ 随仓库分发），
 * 字段一律保守可选（裁决 4 惯例），形状不符返回 null，调用方静默跳过——
 * 不认识的结果形状绝不许弄崩面板。
 */

export interface SubagentTaskSnapshot {
  agent: string;
  /** 任务描述（单行截断） */
  task: string;
  status: "running" | "done" | "failed";
  /** chain 模式的步序（从 1 起） */
  step?: number;
  model?: string;
  /** 预格式化用量串，如 "3 turns ↑1.2k ↓340 $0.0021 ctx:45k" */
  usage: string;
  /** 最近活动（旧→新）：助手文本摘要 / 格式化工具调用 */
  items: string[];
  /** 活动总条数（items 是它的尾窗） */
  activityCount: number;
  /** 最终输出（仅结束态非空，单行截断） */
  output: string;
}

export interface SubagentSnapshot {
  mode: "single" | "parallel" | "chain";
  tasks: SubagentTaskSnapshot[];
}

/** 每任务最多携带的最近活动条数（头尾窗，webview 展开也只看这些，防消息历史撑爆协议） */
/** 每任务最多携带的最近活动条数（尾窗，防消息历史撑爆协议）；下钻视图用 FULL 变体不截 */
const MAX_ITEMS = 12;
/** 下钻视图（subagentSnapshotFull）的活动条数上限：足够完整又不至于撑爆协议 */
const FULL_ITEMS = 400;
const TASK_MAX = 120;
const ITEM_MAX = 160;
const OUTPUT_MAX = 2000;
/** 下钻视图的产出上限：markdown 全文渲染用，比概览尾窗宽两个量级 */
const FULL_OUTPUT_MAX = 60_000;

function oneLine(s: string, max: number): string {
  return String(s).replace(/\s+/g, " ").trim().slice(0, max);
}

function fmtTokens(n: unknown): string {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

/** 对齐官方扩展 formatUsageStats（index.ts:45），字段缺失静默跳过 */
function fmtUsage(u: unknown): string {
  if (!u || typeof u !== "object") return "";
  const usage = u as Record<string, unknown>;
  const parts: string[] = [];
  const turns = usage.turns;
  if (typeof turns === "number" && turns > 0) parts.push(turns + (turns > 1 ? " turns" : " turn"));
  const up = fmtTokens(usage.input);
  if (up) parts.push("↑" + up);
  const down = fmtTokens(usage.output);
  if (down) parts.push("↓" + down);
  const cr = fmtTokens(usage.cacheRead);
  if (cr) parts.push("R" + cr);
  const cw = fmtTokens(usage.cacheWrite);
  if (cw) parts.push("W" + cw);
  if (typeof usage.cost === "number" && usage.cost > 0) parts.push("$" + usage.cost.toFixed(4));
  const ctx = fmtTokens(usage.contextTokens);
  if (ctx) parts.push("ctx:" + ctx);
  return parts.join(" ");
}

/** 工具调用单行摘要，格式对齐官方扩展（$ cmd / read path / grep /p/ in path …） */
function fmtToolCall(name: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name) {
    case "bash":
      return "$ " + oneLine(str("command") || str("cmd"), ITEM_MAX - 2);
    case "read":
      return "read " + oneLine(str("path") || str("file_path"), ITEM_MAX - 5);
    case "grep": {
      const g = "grep /" + oneLine(str("pattern"), 60) + "/" + (str("path") ? " in " + oneLine(str("path"), 60) : "");
      return g.slice(0, ITEM_MAX);
    }
    case "find":
      return "find " + oneLine(str("pattern") || str("path"), ITEM_MAX - 5);
    case "ls":
      return "ls " + oneLine(str("path"), ITEM_MAX - 3);
    case "edit":
      return "edit " + oneLine(str("path") || str("file_path"), ITEM_MAX - 5);
    case "write":
      return "write " + oneLine(str("path") || str("file_path"), ITEM_MAX - 6);
    default: {
      const detail = toolCallFallback(a);
      return oneLine(name + (detail ? " " + detail : ""), ITEM_MAX);
    }
  }
}

function toolCallFallback(a: Record<string, unknown>): string {
  for (const k in a) {
    const v = a[k];
    if (typeof v === "string" && v) return oneLine(v, 80);
  }
  return "";
}

/** 助手消息里提取展示项（对齐官方扩展 getDisplayItems：只取 text 与 toolCall，跳过 thinking）；tail<=0 不截 */
function itemsFromMessages(messages: unknown, tail: number): { items: string[]; total: number } {
  const out: string[] = [];
  let total = 0;
  if (!Array.isArray(messages)) return { items: out, total };
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown> | null;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const content = msg.content as Record<string, unknown>[];
    for (let j = 0; j < content.length; j++) {
      const part = content[j];
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        total++;
        out.push(oneLine(part.text, ITEM_MAX));
      } else if (part.type === "toolCall" && typeof part.name === "string") {
        total++;
        out.push(fmtToolCall(part.name, part.arguments));
      }
    }
  }
  return { items: tail > 0 ? out.slice(-tail) : out, total };
}

/**
 * 结束态判定。官方 isFailedResult（exitCode!==0 / stopReason error|aborted）只用于**最终结果**；
 * 流式中间态不能照搬——扩展每回合结束都更新 stopReason，中间回合调工具时是 "toolCall"
 * （正常收尾才是 "end"），照搬会把运行中误判成 done：浮窗 ✓、头部图标不转（0.111 实测事故，
 * 用户看着图标全程没动）。修法："toolCall" 明确视为 running，未知收尾值保守回 running。
 */
function taskStatus(r: Record<string, unknown>): "running" | "done" | "failed" {
  const exitCode = r.exitCode;
  const stop = r.stopReason;
  if (exitCode !== 0 && typeof exitCode === "number") return "failed";
  if (stop === "error" || stop === "aborted") return "failed";
  if (stop === "toolCall") return "running";
  if (typeof stop === "string" && stop) return "done";
  return "running";
}

/** 结束态最终输出：失败取 errorMessage/stderr，成功取最后一条助手文本（对齐 getResultOutput） */
function finalOutput(r: Record<string, unknown>, max: number): string {
  const status = taskStatus(r);
  if (status === "running") return "";
  const err = typeof r.errorMessage === "string" ? r.errorMessage : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  let text = "";
  if (Array.isArray(r.messages)) {
    const msgs = r.messages as Record<string, unknown>[];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "assistant" && Array.isArray(m.content)) {
        const parts = m.content as Record<string, unknown>[];
        for (let j = parts.length - 1; j >= 0; j--) {
          if (parts[j] && parts[j].type === "text" && typeof parts[j].text === "string") {
            text = parts[j].text as string;
            break;
          }
        }
        if (text) break;
      }
    }
  }
  const raw = status === "failed" ? err || stderr || text : text;
  return raw ? oneLine(raw, max) : "";
}

function snapTask(raw: unknown, itemTail: number, outMax: number): SubagentTaskSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.agent !== "string") return null;
  const { items, total } = itemsFromMessages(r.messages, itemTail);
  return {
    agent: r.agent,
    task: typeof r.task === "string" ? oneLine(r.task, TASK_MAX) : "",
    status: taskStatus(r),
    step: typeof r.step === "number" ? r.step : undefined,
    model: typeof r.model === "string" ? r.model : undefined,
    usage: fmtUsage(r.usage),
    items,
    activityCount: total,
    output: finalOutput(r, outMax),
  };
}

/**
 * 从 subagent 工具的 details（SubagentDetails）构建展示快照。
 * 形状不符（非本扩展的 details / 旧版扩展）返回 null，调用方跳过即可。
 */
export function subagentSnapshot(details: unknown): SubagentSnapshot | null {
  return buildSnapshot(details, MAX_ITEMS, OUTPUT_MAX);
}

/** 下钻视图变体：活动流不截 12 条（上限 400）、产出不截 2000 字（上限 60k，markdown 全文渲染用） */
export function subagentSnapshotFull(details: unknown): SubagentSnapshot | null {
  return buildSnapshot(details, FULL_ITEMS, FULL_OUTPUT_MAX);
}

function buildSnapshot(details: unknown, itemTail: number, outMax: number): SubagentSnapshot | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const mode = d.mode;
  if (mode !== "single" && mode !== "parallel" && mode !== "chain") return null;
  if (!Array.isArray(d.results)) return null;
  const tasks: SubagentTaskSnapshot[] = [];
  for (let i = 0; i < d.results.length; i++) {
    const t = snapTask(d.results[i], itemTail, outMax);
    if (t) tasks.push(t);
  }
  return { mode, tasks };
}
