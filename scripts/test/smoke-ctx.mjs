// 上下文用量弹层主链路冒烟（2026-11-05）：真 PiCore + 真 PiClient + 真会话，零 LLM 调用。
//
// 怎么跑（仓库根目录，先 npm run compile）：
//   node scripts/test/smoke-ctx.mjs
//
// 覆盖的是「宿主算得对不对」这一段（webview 渲染仍要人来眼看）：
//   ① ctxQuery → ctxDetail 真值帧到达（window/used/percent 来自 pi 原生 contextUsage）
//   ② 分类明细：系统提示词/工具/消息都有量，且各分项之和 == estimated（other 之外的恒等式）
//   ③ 压缩阈值：compactAt == window - reserveTokens，与 pi 的 shouldCompact 判据同式
//   ④ 滑块写盘：ctxSetReserve → reserveTokens 真变、compactAt 跟着走（写在 finally 里还原）
//
// ④ 只改**本会话**的 pi 设置内存态（piClient.setCompactionReserve → settingsManager.applyOverrides），
//    **不碰全局 ~/.pi/agent/settings.json**——这条本身就是判据：跑完对比文件字节，变了就 FAIL
//    （2026-11-05 用户红线：调阈值不能影响其它会话）。
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { readdirSync, statSync, mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const { PiCore } = require(join(root, "out", "core", "piCore.js"));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
};

function findSessionFile() {
  const base = join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "sessions");
  let best = null;
  for (const dir of readdirSync(base)) {
    let files = [];
    try {
      files = readdirSync(join(base, dir)).filter((f) => f.endsWith(".jsonl") && !f.startsWith("subagent-"));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(base, dir, f);
      try {
        const sz = statSync(p).size;
        if (!best || sz > best.sz) best = { p, sz };
      } catch {
        /* skip */
      }
    }
  }
  return best?.p;
}

// 全局配置文件快照（判据：整轮跑完必须一字不差）
const settingsPath = join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "settings.json");
const settingsBefore = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : null;

const sessionFile = findSessionFile();
if (!sessionFile) {
  console.error("找不到真实会话文件，冒烟无法覆盖分类明细");
  process.exit(2);
}
console.log("样本会话: " + sessionFile);

const scratch = mkdtempSync(join(tmpdir(), "pi-smoke-ctx-"));
const caps = {
  getCwd: () => scratch,
  getConfig: (_s, _k, d) => d,
  getPersist: (_k, d) => d,
  setPersist: () => {},
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showConfirm: async () => false,
  notify: async () => undefined,
  uiRequest: () => {},
};
const ui = new Proxy({}, { get: () => () => Promise.resolve() });

const posts = [];
const core = new PiCore(caps, ui, (m) => posts.push({ t: Date.now(), m }), "smoke-ctx");
core.lang = "zh";
core.tabKey = "smokectx1";
core.getSessionForWs = () => sessionFile;

/** 发一条 webview 消息并等下一次指定类型的 post 回包（超时判红） */
function waitFor(type, trigger, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const from = posts.length;
    trigger();
    const t0 = Date.now();
    const timer = setInterval(() => {
      for (let i = from; i < posts.length; i++) {
        if (posts[i].m.type === type) {
          clearInterval(timer);
          resolve(posts[i].m);
          return;
        }
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, 50);
  });
}

const first = await waitFor("ctxDetail", () => {
  // 跟 panel 的 webviewReady 同序：先 ensureClient（建 client + boot 链），再发 ctxQuery
  // （client 未建时 collectContextDetail 直接返回 null，什么都没有）
  core.ensureClient();
  setTimeout(() => void core.onWebviewMessage({ type: "ctxQuery" }), 200);
});
if (!first) {
  console.log("FAIL  ① ctxDetail 超时未到（30s）");
  process.exit(1);
}

const seg = (m, k) => (m.segments || []).find((s) => s.key === k) || { tokens: 0, percent: null };
const sumAll = (m) => (m.segments || []).reduce((a, s) => a + s.tokens, 0);

check(
  "① 总量真值来自 pi 原生 contextUsage",
  typeof first.window === "number" && first.window > 0 && (first.used === null || first.used >= 0),
  "used=" + first.used + " window=" + first.window + " percent=" + first.percent
);
check(
  "② 分类明细：系统提示词/工具/消息都有量",
  seg(first, "prompt").tokens > 0 && seg(first, "tools").tokens > 0 && seg(first, "messages").tokens >= 0,
  "prompt=" + seg(first, "prompt").tokens + " tools=" + seg(first, "tools").tokens + " msgs=" + seg(first, "messages").tokens
);
// 分类已按真值总量缩放（否则中文会话会凭空多出一半「其他」）：分段总和必须等于 used，
// 容差 = 七个分类各自四舍五入的零头
check(
  "② 分段总和 ≈ 真值总量（已缩放到 used，other 只接零头）",
  first.used === null || Math.abs(sumAll(first) - first.used) <= 7,
  "sum=" + sumAll(first) + " used=" + first.used + " other=" + seg(first, "other").tokens
);
check(
  "③ compactAt == window - reserveTokens（与 pi shouldCompact 同式）",
  first.compactAt === Math.max(0, first.window - first.reserveTokens),
  "compactAt=" + first.compactAt + " reserve=" + first.reserveTokens
);
// ②b 预算口径（2026-11-05 用户拍板）：主百分比的分母是压缩点，不是模型窗口。
// 这条锁死「拖阈值时上面的数字要跟着变」——窗口口径下它们数学上不可能变（用户实测报就是这个）。
check(
  "②b budget = compactAt，且 percent = used / budget",
  first.compactEnabled
    ? first.budget === first.compactAt && Math.abs(first.percent - (first.used / first.budget) * 100) < 0.01
    : first.budget === first.window,
  "budget=" + first.budget + " compactAt=" + first.compactAt + " percent=" + first.percent
);

// ④ 写盘往返（临时改，finally 还原）
const original = first.reserveTokens;
const probe = original === 20000 ? 12000 : 20000; // 必须与当前值不同，否则「跟着变」判据永远同数
let wrote = null;
try {
  wrote = await waitFor("ctxDetail", () => void core.onWebviewMessage({ type: "ctxSetReserve", reserveTokens: probe }));
  check(
    "④ 滑块写盘：reserveTokens 真变、compactAt 跟着走",
    !!wrote && wrote.reserveTokens === probe && wrote.compactAt === Math.max(0, wrote.window - probe),
    wrote ? "reserve=" + wrote.reserveTokens + " compactAt=" + wrote.compactAt : "无回包"
  );
  // ④b 关键回归（用户原话「这些数字没有跟着调整变化啊」）：预算变了，主占比必须变
  check(
    "④b 阈值变化 → 主占比跟着变（预算口径）",
    !!wrote && wrote.percent !== first.percent && Math.abs(wrote.percent - (wrote.used / wrote.compactAt) * 100) < 0.01,
    wrote ? "before=" + first.percent.toFixed(2) + "% after=" + Number(wrote.percent).toFixed(2) + "%" : "无回包"
  );
} finally {
  await waitFor("ctxDetail", () => void core.onWebviewMessage({ type: "ctxSetReserve", reserveTokens: original }));
  console.log("  （会话内阈值已复位=" + original + "；全局配置文件全程未动）");
}

// ④c 红线：调阈值绝不许写全局 settings.json（改了就是「影响其他会话」，用户明确否决）
const settingsAfter = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : null;
check(
  "④c 调阈值不写全局 settings.json（不污染其它会话）",
  settingsBefore === settingsAfter,
  settingsBefore === null && settingsAfter === null ? "无 settings.json（视为未改动）" : settingsBefore === settingsAfter ? "字节一致" : "!! 文件被改了"
);

const fail = results.some((r) => !r.ok);
console.log(fail ? "\n冒烟 FAIL" : "\n冒烟 PASS");
process.exit(fail ? 1 : 0);
