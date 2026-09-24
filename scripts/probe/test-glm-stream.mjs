// 总监实验（2026-09-15）：glm-5.3 流式 delta 是否一大段一大段到达
// 方法：直打智谱 coding 端点，逐块打印到达间隔与内容长度。分锅：
//   间隔大且每块字多 = provider/网关攒块（壳无责）；块小且密 = 壳渲染链问题
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
const key = auth["zai-coding-cn"]?.key || auth["zai"]?.key;
if (!key) { console.error("no key"); process.exit(1); }

const res = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: "glm-5.3",
    stream: true,
    max_tokens: 500,
    messages: [{ role: "user", content: "从 1 数到 30，每个数字一行，不要其他内容" }],
  }),
});
if (!res.ok) { console.error("HTTP", res.status, (await res.text()).slice(0, 300)); process.exit(1); }

const t0 = Date.now();
let last = t0, n = 0, chars = 0, maxGap = 0, maxGapLen = 0;
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    const c = j.choices?.[0]?.delta?.content || "";
    if (!c) continue;
    const now = Date.now(), gap = now - last; last = now; n++; chars += c.length;
    if (gap > maxGap) { maxGap = gap; maxGapLen = c.length; }
    if (n <= 12 || gap > 400) console.log(`#${String(n).padStart(3)} gap=${String(gap).padStart(4)}ms len=${String(c.length).padStart(3)} ${JSON.stringify(c.slice(0, 20))}`);
  }
}
console.log(`\n== 总块数=${n} 总字数=${chars} 平均块大小=${(chars / n).toFixed(1)}字 最大间隔=${maxGap}ms（该块 ${maxGapLen} 字）耗时=${Date.now() - t0}ms`);
