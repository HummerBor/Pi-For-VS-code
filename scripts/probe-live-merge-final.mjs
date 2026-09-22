// 综合验证：renderAll 历史重绘合并 / 组员报错 / 截图同款双消息（4+9 reads）
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const tmp = mkdtempSync(join(tmpdir(), 'wvfin-'));
let chrome = null;
for (const c of CHROME) {
  try { chrome = spawn(c, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--user-data-dir=' + tmp, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] }); break; } catch { /* next */ }
}
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''; const t = setTimeout(() => reject(new Error('timeout')), 15000);
  chrome.stderr.on('data', (d) => { buf += d.toString(); const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1] + '/browser'); } });
});
const bws = new WebSocket(wsUrl);
await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
let seq = 0; const pend = new Map();
bws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
function send(method, params = {}, sessionId) {
  const id = ++seq; bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res) => pend.set(id, res));
}
const target = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const url = 'file:///' + join(process.cwd(), 'dist', 'webview', 'preview.html').replace(/\\/g, '/');
await send('Page.navigate', { url }, sessionId);
await new Promise(r => setTimeout(r, 1200));
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
// 只看可见行（display:none 的组员不计），附 dot 颜色类
const DUMP = `JSON.parse(JSON.stringify((function(){
  var rows = document.querySelectorAll('.tool');
  var out = [];
  for (var i=0;i<rows.length;i++){
    var r = rows[i];
    if (r.style.display === 'none') continue;
    if (r.classList.contains('prow')) { out.push('(prow)'); continue; }
    var det = r.querySelector('.t-detail'); var cnt = r.querySelector('.t-count');
    out.push((det?det.textContent:'?') + (cnt?(' ×'+cnt.textContent.trim()):'') + (r.classList.contains('err')?' [红]':''));
  }
  return out.slice(-8);
})()))`;
function dispatch(m) { return `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(m)} })); 0`; }
async function fire(m) { await ev(dispatch(m)); await new Promise(r => setTimeout(r, 3)); }

const P3 = ['txt1.txt', 'txt2.txt', 'SKILL.md', 'README.md'];
const P4 = ['gold_writer.py', 'verify_gold.py', 'materialize.py', 'check_git.py', 'example.jsonl', 'README2.md', 'gold.jsonl', 'gold_state.json', '.gitignore'];

// ── 场景1：截图同款 live（乱序 end：4 连全乱 + 9 连前两个同序后乱）──
const m1 = [{ type: 'newLive' }, { type: 'thinking', text: 'think31', ci: 0 }];
P3.forEach((p, i) => { m1.push({ type: 'toolCallStart', ci: i + 1, id: 'a' + i, name: 'read' }); m1.push({ type: 'toolCallDelta', ci: i + 1, chunk: '{}' }); });
P3.forEach((p, i) => m1.push({ type: 'toolStart', id: 'a' + i, name: 'read', detail: p }));
[2, 0, 3, 1].forEach(i => m1.push({ type: 'toolEnd', id: 'a' + i, name: 'read', isError: false, text: 'x', detail: P3[i] }));
m1.push({ type: 'newLive' }, { type: 'thinking', text: 'think68', ci: 0 });
P4.forEach((p, i) => { m1.push({ type: 'toolCallStart', ci: i + 1, id: 'b' + i, name: 'read' }); m1.push({ type: 'toolCallDelta', ci: i + 1, chunk: '{}' }); });
P4.forEach((p, i) => m1.push({ type: 'toolStart', id: 'b' + i, name: 'read', detail: p }));
[0, 1, 4, 7, 2, 6, 3, 8, 5].forEach(i => m1.push({ type: 'toolEnd', id: 'b' + i, name: 'read', isError: false, text: 'x', detail: P4[i] }));
for (const m of m1) await fire(m);
console.log('场景1 截图同款（乱序）:', await ev(DUMP));

// ── 场景2：组员报错（组头先收尾 ok，随后组员 err）──
const m2 = [
  { type: 'newLive' }, { type: 'thinking', text: 't', ci: 0 },
  { type: 'toolCallStart', ci: 1, id: 'e0', name: 'read' }, { type: 'toolCallDelta', ci: 1, chunk: '{}' },
  { type: 'toolCallStart', ci: 2, id: 'e1', name: 'read' }, { type: 'toolCallDelta', ci: 2, chunk: '{}' },
  { type: 'toolStart', id: 'e0', name: 'read', detail: 'ok.txt' },
  { type: 'toolStart', id: 'e1', name: 'read', detail: 'err.txt' },
  { type: 'toolEnd', id: 'e0', name: 'read', isError: false, text: 'fine', detail: 'ok.txt' },
  { type: 'toolEnd', id: 'e1', name: 'read', isError: true, text: 'boom', detail: 'err.txt' },
];
for (const m of m2) await fire(m);
console.log('场景2 组员报错:', await ev(DUMP));

// ── 场景3：settled renderAll 历史重绘（think+4 reads 单消息 ×2 条）──
const hist = [];
hist.push({ role: 'user', content: [{ type: 'text', text: '读 skill' }] });
function msg(think, calls, tag) {
  return { role: 'assistant', content: [{ type: 'thinking', thinking: think }, ...calls.map((p, i) => ({ type: 'toolCall', id: tag + i, name: 'read', arguments: { path: p } }))] };
}
hist.push(msg('think A', P3, 'h1'));
P3.forEach((p, i) => hist.push({ role: 'toolResult', toolCallId: 'h1' + i, isError: false, content: [{ type: 'text', text: 'c' + i }] }));
hist.push(msg('think B', P4, 'h2'));
P4.forEach((p, i) => hist.push({ role: 'toolResult', toolCallId: 'h2' + i, isError: false, content: [{ type: 'text', text: 'c' + i }] }));
await ev(`window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify({ type: 'render', messages: hist })} })); 0`);
await new Promise(r => setTimeout(r, 50));
console.log('场景3 renderAll 重绘:', await ev(DUMP));

chrome.kill();
process.exit(0);
