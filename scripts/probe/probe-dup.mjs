// 探针二（0.1.32 事故排查）：看最新 session jsonl 的消息序列——找重复内容、模型切换、fork 痕迹
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
console.log('== 最新5个会话文件：');
for (const f of files.slice(0, 5)) console.log('  ', f.f, new Date(f.t).toISOString());
const latest = files[0];
console.log('== 检查:', latest.f);

const lines = readFileSync(latest.p, 'utf8').split('\n').filter(Boolean);
const seq = [];
for (const ln of lines) {
  let e;
  try { e = JSON.parse(ln); } catch { continue; }
  // 宽松取 message：e.message 或 e 本身带 role
  const m = e.message && e.message.role ? e.message : (e.role ? e : null);
  if (!m) continue;
  const role = m.role;
  let brief = '';
  if (Array.isArray(m.content)) {
    brief = m.content.map(c => {
      if (!c) return 'null';
      if (c.type === 'text') return 'T:' + String(c.text || '').replace(/\s+/g, ' ').slice(0, 40);
      if (c.type === 'thinking') return 'K:' + String(c.thinking || '').replace(/\s+/g, ' ').slice(0, 40);
      if (c.type === 'toolCall') return 'C:' + (c.name || '?');
      return c.type;
    }).join(' ');
  } else if (typeof m.content === 'string') {
    brief = 'S:' + m.content.replace(/\s+/g, ' ').slice(0, 40);
  }
  const model = m.provider && m.model ? m.provider + '/' + m.model : '';
  seq.push({ role, brief, model });
}
console.log('== 消息序列（后 40 条）==');
for (const s of seq.slice(-40)) console.log(s.role.padEnd(10), (s.model || '').padEnd(20), s.brief);
// 重复检测：相邻 assistant 的 thinking/text 前 40 字符是否出现两次以上
const counts = {};
for (const s of seq) if (s.brief) counts[s.brief] = (counts[s.brief] || 0) + 1;
const dups = Object.entries(counts).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('== 重复内容 top（brief 相同计数）==');
for (const [b, n] of dups) console.log(' x' + n, b);
