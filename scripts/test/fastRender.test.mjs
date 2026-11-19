/**
 * 回归：R 刀快路径也要看到 `custom_message`（工单43 遗留 3a，2026-11-19）。
 *
 * 事故：打开历史会话时，权威 render（pi 就绪后 getMessages）要等 2~7s（services 全树扫描），
 * 这段时间的画面靠 piCore 的 R 刀快路径直接读会话 jsonl。快路径原先只认 `type:"message"`，
 * `harness/memory` 压缩后注入的指针（`type:"custom_message"` / customType:"memory-pointer"）
 * 在这段窗口里整条缺失——提示晚到才补上 = 视觉闪烁（内容不丢，但「先没有后出现」）。
 *
 * 本用例打的是**真实**路径的两段拼合，不重写逻辑：
 *   ① src/core/piCore.ts 的 fastRenderMessagesFromJsonl（快路径的 jsonl 读法）；
 *   ② src/domain/customMessage.ts 的 filterCustomMessagesForWebview（webviewMessages 出口的
 *      同一份挑选口径）。
 * 断言：
 *   - 含 `type:"custom_message"` + display:true 的条目 → 消息流里出现 `role:"custom"`、
 *     customType 正确、正文是 content 里 text 项拼好的文本；
 *   - display:false 的同名条目 → 出口后**不出现**（快路径不新开一条渲染通道）；
 *   - 顺序与文件行序一致（custom 落在它在文件里的时间位置，不被挪到末尾）；
 *   - 坏行（崩溃尾部半行）跳过，不丢前后条目；
 *   - subagent 专属通道类型（display:true）仍被出口谓词拦掉。
 *
 * 为什么能真跑：两个函数都是纯函数（字符串/数组进、数组出），Node 24 原生剥 TS 类型直跑，
 * 无扩展名相对 import 靠下面的 resolve 钩子补 .ts（同 scripts/test/customMessage.test.mjs）。
 *
 * 运行：npm run test:fastrender
 * 注：用例要 import src/core/piCore.ts，而 PiCore 构造函数用了**参数属性**（`constructor(private
 * readonly caps: ...)`）—— strip-only 模式不支持，必须 `--experimental-transform-types`（脚本里已带；
 * 不为跑一次用例去改生产代码写法，也不为它拖 dist/ 里的构建产物）。
 */
import assert from "node:assert";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── 无扩展名相对 import → 补 .ts（vite 口径）──
module.registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && !/\.[cm]?[jt]s$/.test(spec)) {
      const cand = new URL(spec + ".ts", ctx.parentURL);
      if (fs.existsSync(fileURLToPath(cand))) return { url: cand.href, format: "module-typescript", shortCircuit: true };
    }
    return next(spec);
  },
});

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
}

const { fastRenderMessagesFromJsonl } = await import(pathToFileURL(path.join(root, "src/core/piCore.ts")).href);
const { customMessageText, filterCustomMessagesForWebview } = await import(
  pathToFileURL(path.join(root, "src/domain/customMessage.ts")).href
);

// ── 样本：真实 jsonl 形状（pi appendCustomMessageEntry 落盘字段）──
const pointer = {
  type: "custom_message",
  customType: "memory-pointer",
  content: [
    { type: "text", text: "上下文已压缩。" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "text", text: "动手前按需重读：AGENTS.md" },
  ],
  display: true,
  details: { injected: true },
  id: "e3",
  parentId: "e2",
  timestamp: "2026-11-19T10:00:03.000Z",
};
const hiddenPointer = { ...pointer, id: "e4", display: false, customType: "memory-pointer-hidden" };
const subagentFrame = { ...pointer, id: "e5", customType: "subagent-async-stream", display: true };
const user = { type: "message", id: "e1", message: { role: "user", content: "开工", timestamp: 1732000000000 } };
const assistant = { type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "好" }], timestamp: 1732000001000 } };

const jsonl = [user, assistant, pointer, hiddenPointer, subagentFrame, ""].map((e, i) =>
  i === 5 ? "" : JSON.stringify(e)
);
// 加一条崩溃尾部半行 + 一行坏 JSON：都不许影响其余条目
const text = jsonl.join("\n") + '{"type":"message","id":"e6","mess';

const raw = fastRenderMessagesFromJsonl(text);
// webviewMessages 出口口径（piCore.webviewMessages 用的就是这一句）
const shown = filterCustomMessagesForWebview(raw);

console.log("快路径 jsonl 读法 fastRenderMessagesFromJsonl");
ok("message 条目照旧透传（逐条原样）", raw.length === 5 && raw[0].role === "user" && raw[0].content === "开工" && raw[1].role === "assistant", "raw.length=" + raw.length);
const custom = raw[2];
ok("custom_message → role:\"custom\"", custom && custom.role === "custom", JSON.stringify(custom));
ok("customType 透传", custom && custom.customType === "memory-pointer");
ok("content 原样搬运（不在快路径里另拼）", Array.isArray(custom.content) && custom.content.length === 3);
ok("正文 = content 里 text 项拼好的文本", customMessageText(custom.content) === "上下文已压缩。动手前按需重读：AGENTS.md", customMessageText(custom.content));
ok("timestamp 有则带", custom.timestamp === pointer.timestamp);
ok("坏行跳过、不丢其余条目", raw.length === 5);

console.log("出口挑选口径（webviewMessages → filterCustomMessagesForWebview）");
ok("display:true 的压缩指针出现在消息流里", shown.some((m) => m.role === "custom" && m.customType === "memory-pointer"));
ok("display:false 的不出现", !shown.some((m) => m.customType === "memory-pointer-hidden"));
ok("subagent 专属通道仍被拦（快路径不新开通道）", !shown.some((m) => m.customType === "subagent-async-stream"));
ok("非 custom 角色一条不动", shown.filter((m) => m.role !== "custom").length === 2);
ok("顺序 = 文件行序（custom 落在原位，不被挪末尾）", shown.map((m) => m.role).join(",") === "user,assistant,custom", shown.map((m) => m.role).join(","));

assert.ok(fail === 0, fail + " 条断言失败");
console.log("\n通过 " + pass + " / " + (pass + fail));
