// 无头浏览器复现探针：把真实 webview 跑进 headless Chrome/Edge，灌入合成 live 事件序列，
// 观察 DOM 里工具行的合并状态。零依赖（Node 24 内建 WebSocket/fetch）。
// 用法：node scripts/probe-live-merge.mjs
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
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
    chrome = spawn(c, [
      '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + tmp, '--window-size=900,1400', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    break;
  } catch { /* 下一个 */ }
}
if (!chrome) { console.error('no chrome/edge'); process.exit(1); }

// --remote-debugging-port=0 时端口写在 stderr 的 DevTools listening 行
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('devtools line timeout')), 15000);
  const onData = (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(timer); chrome.stderr.off('data', onData); resolve(m[1] + '/browser'); }
  };
  chrome.stderr.on('data', onData);
});
console.log('devtools browser ws:', wsUrl);

// 浏览器级 WS → /json/new 建页签拿 page ws
const browserWs = new WebSocket(wsUrl);
await new Promise((res, rej) => { browserWs.onopen = res; browserWs.onerror = rej; });
let seq = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq;
  browserWs.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res) => pending.set(id, res));
}
browserWs.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
};

const target = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
await send('Page.enable', {}, sessionId);

const previewPath = join(process.cwd(), 'dist', 'webview', 'preview.html');
const url = 'file:///' + previewPath.replace(/\\/g, '/');
await send('Page.navigate', { url }, sessionId);
await new Promise(r => setTimeout(r, 1500)); // 等 main.js 启动 + webviewReady 后 80ms 的 tabs/uiState

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  if (r.exceptionDetails) { console.error('EVAL ERR:', JSON.stringify(r.exceptionDetails).slice(0, 500)); throw new Error('eval failed'); }
  return r.result.value;
}

// ── 合成 live 序列：完全复刻 piCore 真实 post 顺序（并行工具执行：start 全到 → end 按完成序）──
const msgs = [
  { type: 'user', text: '读一下这个 skill' },
  { type: 'newLive' },
  { type: 'thinking', text: '思考 31 字。', ci: 0 },
  { type: 'toolCallStart', ci: 1, id: 'r1', name: 'read' },
  { type: 'toolCallDelta', ci: 1, chunk: '{"path":"txt1.txt"}' },
  { type: 'toolCallStart', ci: 2, id: 'r2', name: 'read' },
  { type: 'toolCallDelta', ci: 2, chunk: '{"path":"txt2.txt"}' },
  { type: 'toolCallStart', ci: 3, id: 'r3', name: 'read' },
  { type: 'toolCallStart', ci: 4, id: 'r4', name: 'read' },
  { type: 'toolStart', id: 'r1', name: 'read', detail: 'txt1.txt' },
  { type: 'toolStart', id: 'r2', name: 'read', detail: 'txt2.txt' },
  { type: 'toolStart', id: 'r3', name: 'read', detail: 'SKILL.md' },
  { type: 'toolStart', id: 'r4', name: 'read', detail: 'README.md' },
  { type: 'toolEnd', id: 'r1', name: 'read', isError: false, text: 'txt1 内容', detail: 'txt1.txt' },
  { type: 'toolEnd', id: 'r2', name: 'read', isError: false, text: 'txt2 内容', detail: 'txt2.txt' },
  { type: 'toolEnd', id: 'r3', name: 'read', isError: false, text: 'SKILL 内容', detail: 'SKILL.md' },
  { type: 'toolEnd', id: 'r4', name: 'read', isError: false, text: 'README 内容', detail: 'README.md' },
];
function dump(tag) {
  return `JSON.parse(JSON.stringify((function(){
    var rows = document.querySelectorAll('.tool');
    var out = [];
    for (var i=0;i<rows.length;i++){
      var nm = rows[i].querySelector('.t-name'); var cnt = rows[i].querySelector('.t-count');
      out.push((nm?nm.textContent:'?') + (cnt?cnt.textContent:''));
    }
    return out;
  })()))`;
}
// data 必须是对象字面量（stub 与宿主同形：MessageEvent data 即消息对象）
function dispatch(m) {
  return `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(m)} })); 0`;
}
console.log('before:', await ev(dump()));
for (const m of msgs) {
  await ev(dispatch(m));
  await new Promise(r => setTimeout(r, 5));
}
console.log('after live seq:', await ev(dump()));

// DOM 结构细看：root 直接子元素序列（找插在工具行之间的东西）
// 先摸清容器：找含 .tool 行的最近祖先，列其直接子元素
console.log('root children:', await ev(`JSON.parse(JSON.stringify((function(){
  var t0 = document.querySelector('.tool');
  if (!t0) return ['no .tool'];
  var root = t0.parentNode;
  var out = ['ROOT=' + root.className];
  var kids = root.children;
  for (var i=0;i<kids.length;i++){
    var k = kids[i];
    var nm = k.querySelector && k.querySelector('.t-name');
    out.push('<' + k.tagName.toLowerCase() + ' ' + (k.className||'') + '>' + (nm ? ':' + nm.textContent : '') );
  }
  return out;
})()))`));

chrome.kill();
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
