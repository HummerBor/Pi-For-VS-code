/**
 * 内置 subagent 扩展同步（2026-10-30 用户拍板「内置到 pi-vscode，别新开一个项目就找不到子 agent」）。
 *
 * 为什么：subagent 扩展（派单/台账/列表，harness/subagent/）此前只装在开发机
 * ~/.pi/agent/extensions，换机器/换环境开箱就没有子 agent 能力。照 vendor-pi 先例
 * 「内置随插件分发」：harness 源码随 vsix 走（harness/subagent/，.vscodeignore 黑名单
 * 制自动进包），激活建 services 前同步到 <agentDir>/extensions/subagent，pi 原生扩展
 * 机制照常加载——插件是壳，能力用 pi 的。
 *
 * 版本门（harness.json 的 version，只增不减）：bundled > target 才覆盖——尊重本地
 * 修改，不无脑覆写；目标缺失直接装。同步失败绝不抛：观测面不许阻会话创建。
 */

import * as fs from "fs";
import { dirname, join } from "path";

const FILES = ["index.ts", "agents.ts", "runsLedger.ts", "harness.json"];
let synced = false;

function readVersion(dir: string): number {
  try {
    const raw = fs.readFileSync(join(dir, "harness.json"), "utf8");
    const v = JSON.parse(raw)?.version;
    return typeof v === "number" ? v : 0;
  } catch {
    // 无 harness.json = 上古安装（或非本插件所装），按 0 算——首装即接管
    return 0;
  }
}

/** 扩展根目录定位：out/pi/xxx.js 上两级（findPiPackageRoot 同款口径） */
function bundledDir(): string {
  return join(dirname(dirname(__dirname)), "harness", "subagent");
}

export function ensureSubagentHarness(agentDir: string): void {
  if (synced) return;
  synced = true;
  syncSubagentHarness(agentDir);
}

/** 同步核心（无幂等门，探针直接测装/版本门/不覆写三分支） */
export function syncSubagentHarness(agentDir: string): void {
  try {
    const src = bundledDir();
    if (!fs.existsSync(join(src, "index.ts"))) return; // 源缺失（异常包），不折腾
    const dst = join(agentDir, "extensions", "subagent");
    const targetHas = fs.existsSync(join(dst, "index.ts"));
    if (targetHas && readVersion(dst) >= readVersion(src)) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const f of FILES) {
      const from = join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, join(dst, f));
    }
  } catch {
    /* 同步失败不阻会话创建 */
  }
}
