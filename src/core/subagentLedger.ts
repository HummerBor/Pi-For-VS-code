/**
 * 子 agent 运行台账读取（2026-10-30 段 3 刀 1）：跨会话/跨重启全局列表的数据源。
 *
 * 台账是 harness（harness/subagent/runsLedger.ts）写的 <agentDir>/sessions/subagents/
 * runs/<handle>.json——状态唯一真值；本模块是宿主侧只读消费端。为什么不直接 import
 * harness 的 runsLedger.ts：它依赖 pi 运行时（getAgentDir 裸包名），宿主编译产物里
 * 解析不到；耦合面只在文件形状（与 RunRecord 对齐，两处注释互相指向）。
 *
 * 归位纪律：本文件带 fs/path，宿主专用（webview 共享编译无 node 类型）——别让
 * webview 图 import 它；wire 形状（SubagentLedgerRow）住 protocol.ts，两边共用。
 * 防御口径（subagentSnapshot 头注释同款）：字段保守可选，烂 JSON/非台账对象跳过，
 * 未知 status 归 failed——不认识的形状绝不弄崩面板。
 */
import * as fs from "fs";
import { join } from "path";
import type { SubagentLedgerRow } from "./protocol";

const STATUSES = new Set<string>(["running", "completed", "failed", "killed", "orphaned"]);

/** 读全量台账，startedAt 倒序。目录缺失/读失败返回 []（首用即空库，非异常） */
export function readLedgerRows(agentDir: string): SubagentLedgerRow[] {
  const dir = join(agentDir, "sessions", "subagents", "runs");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows: SubagentLedgerRow[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw.handle !== "string" || typeof raw.agent !== "string") continue;
      rows.push({
        handle: raw.handle,
        agent: raw.agent,
        task: typeof raw.task === "string" ? raw.task : "",
        status: STATUSES.has(raw.status as string)
          ? (raw.status as SubagentLedgerRow["status"])
          : "failed",
        deathReason: typeof raw.deathReason === "string" ? raw.deathReason : undefined,
        startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
        endedAt: typeof raw.endedAt === "number" ? raw.endedAt : undefined,
        model: typeof raw.model === "string" ? raw.model : undefined,
        sessionDir: typeof raw.sessionDir === "string" ? raw.sessionDir : undefined,
        reported: typeof raw.reported === "boolean" ? raw.reported : undefined,
      });
    } catch {
      /* 烂 JSON/截断文件跳过 */
    }
  }
  rows.sort((a, b) => b.startedAt - a.startedAt);
  return rows;
}
