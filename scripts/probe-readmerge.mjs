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
const selfMarker = 'probe-readmerge';
for (const cand of files) {
  const raw = readFileSync(cand.p, 'utf8');
  if (raw.includes(selfMarker)) continue; // 排除本调试会话
  if (!raw.includes('txt2.txt') || !raw.includes('reflex-skill')) continue;
  console.log('== session:', cand.f, 'lines:', raw.split('\n').filter(Boolean).length);
  let shown = 0;
  for (const ln of raw.split('\n').filter(Boolean)) {
    let e;
    try { e = JSON.parse(ln); } catch { continue; }
    const m = e.message || e.entry?.message || (e.type === 'message' ? e : null);
    if (!m || m.role !== 'assistant') continue;
    const types = (m.content || []).map(c => {
      if (!c) return 'null';
      if (c.type === 'text') return 'text' + (c.text ? '(' + c.text.length + ')' : '(空)');
      if (c.type === 'thinking') return 'think' + (c.thinking ? '(' + c.thinking.length + ')' : '(空)');
      if (c.type === 'toolCall' || c.type === 'tool_use' || c.type === 'toolcall')
        return 'TC:' + (c.name || '?') + ':' + String((c.arguments && (c.arguments.path || c.arguments.file_path || c.arguments.command)) || '').replace(/.*[\\/]/, '').slice(0, 30);
      return c.type;
    });
    console.log('A |', types.join(' | '));
    if (++shown >= 30) break;
  }
  break;
}
