// 聚焦调试：变体B（end 乱序）逐事件 dump DOM 可见性 + webview 内部组状态
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const tmp = mkdtempSync(join(tmpdir(), 'wvdbg-'));
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
const DUMP = `JSON.parse(JSON.stringify((function(){
  var rows = document.querySelectorAll('.tool');
  var out = [];
  for (var i=0;i<rows.length;i++){
    var r = rows[i];
    var det = r.querySelector('.t-detail'); var cnt = r.querySelector('.t-count');
    var hidden = r.style.display === 'none';
    out.push((hidden?'[隐]':'') + (det?det.textContent:'') + (cnt?(' ×'+cnt.textContent.trim()):''));
  }
  return out.slice(-6);
})()))`;
function dispatch(m) { return `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(m)} })); 0`; }
async function fire(m) { await ev(dispatch(m)); await new Promise(r => setTimeout(r, 3)); }

const paths = ['txt1.txt', 'txt2.txt', 'SKILL.md', 'README.md'];
await fire({ type: 'newLive' });
await fire({ type: 'thinking', text: 'thinking.', ci: 0 });
for (let i = 0; i < 4; i++) {
  await fire({ type: 'toolCallStart', ci: i + 1, id: 'r' + (i + 1), name: 'read' });
  await fire({ type: 'toolCallDelta', ci: i + 1, chunk: '{"path":"' + paths[i] + '"}' });
}
for (let i = 0; i < 4; i++) await fire({ type: 'toolStart', id: 'r' + (i + 1), name: 'read', detail: paths[i] });
console.log('starts 后:', await ev(DUMP));
for (const i of [4, 3, 2, 1]) {
  await fire({ type: 'toolEnd', id: 'r' + i, name: 'read', isError: false, text: 'content ' + i, detail: paths[i - 1] });
  console.log('end(r' + i + ') 后:', await ev(DUMP));
}
chrome.kill();
process.exit(0);
