/**
 * 内置技能同步（2026-11-17 用户拍板：「换模型截个图就能改价，这块做成技能内置到插件里」）。
 *
 * 为什么走技能：价目表是**厂商随时会改**的数据，写死在代码里必然过期；而「读一张价目表截图 →
 * 映射成结构化价格 → 写进 JSON」正好是 agent 的强项。所以插件只负责两件事：
 *   ① 把技能装到 <agentDir>/skills/（本文件），任何会话都能用；
 *   ② 跑时读同一个 JSON（panel.ts 的 readPricingTable → domain/priceTable）。
 *
 * 同步纪律与 ensureSubagentHarness 一致（照抄那套，别走第二条路）：
 *   harness/skills/<name>/{SKILL.md, skill.json} 随 vsix 分发（.vscodeignore 黑名单制自动进包），
 *   激活时按 skill.json 的 version **只升不降** 拷到 <agentDir>/skills/<name>——尊重本地修改，
 *   目标缺失直接装；同步失败绝不抛（观测面不许阻会话创建）。
 */
import * as fs from "fs";
import { dirname, join } from "path";

const FILES = ["SKILL.md", "skill.json"];
const SKILLS = ["pricing-table"];
let synced = false;

/** 扩展根目录定位：out/pi/xxx.js 上两级（ensureSubagentHarness 同款口径） */
function bundledDir(): string {
  return join(dirname(dirname(__dirname)), "harness", "skills");
}

function readVersion(dir: string): number {
  try {
    const v = JSON.parse(fs.readFileSync(join(dir, "skill.json"), "utf8"))?.version;
    return typeof v === "number" ? v : 0;
  } catch {
    return 0; // 无 skill.json = 非本插件所装，按 0 算（首装即接管）
  }
}

export function ensureBundledSkills(agentDir: string): void {
  if (synced) return;
  synced = true;
  syncBundledSkills(agentDir);
}

/** 同步核心（无幂等门，探针可直测装/版本门/不覆写三分支） */
export function syncBundledSkills(agentDir: string): void {
  try {
    const src = bundledDir();
    for (const name of SKILLS) {
      const from = join(src, name);
      if (!fs.existsSync(join(from, "SKILL.md"))) continue; // 源缺失（异常包），不折腾
      const dst = join(agentDir, "skills", name);
      if (fs.existsSync(join(dst, "SKILL.md")) && readVersion(dst) >= readVersion(from)) continue;
      fs.mkdirSync(dst, { recursive: true });
      for (const f of FILES) {
        const p = join(from, f);
        if (fs.existsSync(p)) fs.copyFileSync(p, join(dst, f));
      }
    }
  } catch {
    /* 同步失败不阻会话创建 */
  }
}
