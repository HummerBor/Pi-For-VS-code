// 探针（工单29扩权返工）：看最新 session jsonl 里 assistant 消息的 content 结构——
// 连续 toolCall 是同一条消息还是分属多条、中间夹了什么块。只读，零依赖
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const home = process.env.USERPROFILE || process.env.HOME;
const rootDir = join(home, '.pi', 'agent', 'sessions');
let files = [];
function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (f.endsWith('.jsonl')) files.push({ f, t: st.mtimeMs, p });
  }
}
try { walk(rootDir); } catch {}
files.sort((a, b) => b.t - a.t);
if (!files.length) { console.log('no session files'); process.exit(0); }
const latest = files[0];
console.log('== session:', latest.f);

const lines = readFileSync(latest.p, 'utf8').split('\n').filter(Boolean);
// message 条目形状探查：找含 message 的帧
let shown = 0;
for (const ln of lines.reverse()) {
  let e;
  try { e = JSON.parse(ln); } catch { continue; }
  const m = e.message || e.entry?.message || (e.type === 'message' ? e : null);
  if (!m || m.role !== 'assistant') continue;
  const types = (m.content || []).map(c => {
    if (!c) return 'null';
    if (c.type === 'text') return 'text' + (c.text ? '' : '(空)');
    if (c.type === 'thinking') return 'think' + (c.thinking ? '' : '(空)');
    if (c.type === 'toolCall' || c.type === 'tool_use' || c.type === 'toolcall') return 'toolCall:' + (c.name || '?');
    return c.type;
  });
  console.log('--', types.join(' | '));
  if (++shown >= 12) break;
}
