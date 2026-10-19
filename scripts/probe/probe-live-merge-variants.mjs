// 无头浏览器变体实验：同一套真实 webview，灌不同 live 事件序，看哪种破坏同名合并。
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const tmp = mkdtempSync(join(tmpdir(), 'wvprobe-'));
let chrome = null;
for (const c of CHROME_CANDIDATES) {
  try {
    chrome = spawn(c, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--user-data-dir=' + tmp, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
    break;
  } catch { /* next */ }
}
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('timeout')), 15000);
  chrome.stderr.on('data', (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(t); resolve(m[1] + '/browser'); }
  });
});
const browserWs = new WebSocket(wsUrl);
await new Promise((res, rej) => { browserWs.onopen = res; browserWs.onerror = rej; });
let seq = 0; const pending = new Map();
browserWs.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); } };
function send(method, params = {}, sessionId) {
  const id = ++seq;
  browserWs.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res) => pending.set(id, res));
}
const target = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
await send('Page.enable', {}, sessionId);
const url = 'file:///' + join(process.cwd(), 'dist', 'webview', 'preview.html').replace(/\\/g, '/');
await send('Page.navigate', { url }, sessionId);
await new Promise(r => setTimeout(r, 1200));
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
const DUMP = `JSON.parse(JSON.stringify((function(){
  var rows = document.querySelectorAll('.tool');
  var out = [];
  for (var i=0;i<rows.length;i++){
    var nm = rows[i].querySelector('.t-name');
    var cnt = rows[i].querySelector('.t-count');
    var det = rows[i].querySelector('.t-detail');
    out.push(((det?det.textContent:'') + (cnt?(' ×'+cnt.textContent.trim()):'')) || (nm?nm.textContent:'?'));
  }
  return out.filter(function(s){return s;});
})()))`;
function dispatch(m) { return `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(m)} })); 0`; }

// 基础素材：一条 think + 4 并行 read 的消息（对齐截图会话 msg3）
function readCalls(ids, paths) {
  return ids.map((id, i) => ({ type: 'toolCallStart', ci: i + 1, id, name: 'read' }));
}
async function run(tag, seqBuilder) {
  // 每个变体独立页签/页面，避免状态串染
  const target2 = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await send('Target.attachToTarget', { targetId: target2.targetId, flatten: true });
  await send('Page.navigate', { url }, sid);
  await new Promise(r => setTimeout(r, 1200));
  const ev2 = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  const msgs = seqBuilder();
  for (const m of msgs) { await ev2(dispatch(m)); await new Promise(r => setTimeout(r, 3)); }
  const res = await ev2(DUMP);
  console.log(tag, '=>', JSON.stringify(res));
  await send('Target.closeTarget', { targetId: target2.targetId });
}

const paths = ['txt1.txt', 'txt2.txt', 'SKILL.md', 'README.md'];
function baseMsgs() {
  const m = [
    { type: 'newLive' },
    { type: 'thinking', text: 'thinking 31 chars.', ci: 0 },
  ];
  for (let i = 0; i < 4; i++) {
    m.push({ type: 'toolCallStart', ci: i + 1, id: 'r' + (i + 1), name: 'read' });
    m.push({ type: 'toolCallDelta', ci: i + 1, chunk: '{"path":"' + paths[i] + '"}' });
  }
  return m;
}
// 变体A：start 全到 → end 顺序（复刻 agent-loop 并行语义）
await run('A start×4→end×4 顺序:', () => [
  ...baseMsgs(),
  ...[1, 2, 3, 4].map(i => ({ type: 'toolStart', id: 'r' + i, name: 'read', detail: paths[i - 1] })),
  ...[1, 2, 3, 4].map(i => ({ type: 'toolEnd', id: 'r' + i, name: 'read', isError: false, text: 'content ' + i, detail: paths[i - 1] })),
]);
// 变体B：end 逆序完成
await run('B start×4→end×4 逆序:', () => [
  ...baseMsgs(),
  ...[1, 2, 3, 4].map(i => ({ type: 'toolStart', id: 'r' + i, name: 'read', detail: paths[i - 1] })),
  ...[4, 3, 2, 1].map(i => ({ type: 'toolEnd', id: 'r' + i, name: 'read', isError: false, text: 'content ' + i, detail: paths[i - 1] })),
]);
// 变体C：串行 start/end 交错
await run('C start/end 交错:', () => {
  const m = baseMsgs();
  for (let i = 1; i <= 4; i++) {
    m.push({ type: 'toolStart', id: 'r' + i, name: 'read', detail: paths[i - 1] });
    m.push({ type: 'toolEnd', id: 'r' + i, name: 'read', isError: false, text: 'content ' + i, detail: paths[i - 1] });
  }
  return m;
});
// 变体D：两条消息（每条 think+1 read，中间有 newLive）——模拟 pi 每工具一条消息的旧认知
await run('D 每消息一条工具:', () => {
  const m = [];
  for (let i = 1; i <= 4; i++) {
    m.push({ type: 'newLive' });
    m.push({ type: 'thinking', text: 'think ' + i, ci: 0 });
    m.push({ type: 'toolCallStart', ci: 1, id: 'r' + i, name: 'read' });
    m.push({ type: 'toolCallDelta', ci: 1, chunk: '{"path":"' + paths[i - 1] + '"}' });
    m.push({ type: 'toolStart', id: 'r' + i, name: 'read', detail: paths[i - 1] });
    m.push({ type: 'toolEnd', id: 'r' + i, name: 'read', isError: false, text: 'content ' + i, detail: paths[i - 1] });
  }
  return m;
});
// 变体E：A 的基础上在 start 与 end 之间插 toolCallDelta（流式收尾与执行重叠假想）
await run('E end 前夹 toolCallDelta:', () => [
  ...baseMsgs(),
  ...[1, 2, 3, 4].map(i => ({ type: 'toolStart', id: 'r' + i, name: 'read', detail: paths[i - 1] })),
  { type: 'toolCallDelta', ci: 4, chunk: '"}' },
  ...[1, 2, 3, 4].map(i => ({ type: 'toolEnd', id: 'r' + i, name: 'read', isError: false, text: 'content ' + i, detail: paths[i - 1] })),
]);
chrome.kill();
process.exit(0);
