/**
 * webview 前端脚本（聊天面板全部交互逻辑）。
 * 由 vite 构建：npm run build:webview → dist/webview/main.js，宿主 getHtml 注入 webview。
 * 历史说明：曾以字符串数组内联在 panel.ts 里，故主体保留 ES5 var 风格。
 * 类型门禁：strict:false 下 tsc 零报错（已摘除 @ts-nocheck，工单一验收项）。
 */
import { STRINGS, type Lang } from "../src/i18n";
import type { HostToWebview, SessionMessage, SlashCommand, WorkspaceFile } from "../src/protocol";
import "./style.css";
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(state: unknown): void };

// 语言跟随宿主写入的 <html lang="zh|en">
const L = STRINGS[((document.documentElement.lang || "zh") === "en" ? "en" : "zh") as Lang];
(function(){
  var vscode = acquireVsCodeApi();
  var messages = document.getElementById('messages') as HTMLElement;
  var input = document.getElementById('input') as HTMLTextAreaElement;
  var stopBtn = document.getElementById('stop') as HTMLButtonElement;
  var sendBtn = document.getElementById('send') as HTMLButtonElement;
  var statusEl = document.getElementById('status') as HTMLElement;
  var modeBadge = document.getElementById('modebadge') as HTMLElement;
  var langEl = document.getElementById('lang') as HTMLElement;
  var codechipEl = document.getElementById('codechip') as HTMLElement;
  var codeCtx = null; var codeOn = true;
  var modelEl = document.getElementById('model') as HTMLElement;
  var thinkEl = document.getElementById('think') as HTMLElement;
  var sessionEl = document.getElementById('session') as HTMLElement;
  var moreEl = document.getElementById('more') as HTMLElement;
  var themeEl = document.getElementById('theme') as HTMLElement;
  var usageEl = document.getElementById('usage') as HTMLElement;
  var newChatEl = document.getElementById('newchat') as HTMLElement;
  var attachbarEl = document.getElementById('attachbar') as HTMLElement;
  var attachEl = document.getElementById('attach') as HTMLElement;
  var fileInput = document.getElementById('file') as HTMLInputElement;
  var suggestEl = document.getElementById('suggest') as HTMLElement;
  var plusmenuEl = document.getElementById('plusmenu') as HTMLElement;
  var pmUpload = document.getElementById('pm-upload') as HTMLElement;
  var pmAt = document.getElementById('pm-at') as HTMLElement;
  var historyEl = document.getElementById('history') as HTMLElement;

  // ── 统一 SVG 图标集（16 网格描边风，currentColor 跟随主题）──
  var ICON_PATHS = {
    clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8V8l2.4 1.6"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    term: '<path d="M3 5.5l3 2.5-3 2.5"/><path d="M8.5 10.5H13"/>',
    gear: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.5 3.5l1.6 1.6M10.9 10.9l1.6 1.6M12.5 3.5l-1.6 1.6M5.1 10.9l-1.6 1.6"/>',
    theme: '<circle cx="8" cy="8" r="6.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4Z" fill="currentColor" stroke="none"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.3" r="1.1"/><path d="M2.5 11.5L6 8.5l2.3 1.9 2.7-2.6 2.6 2.4"/>',
    file: '<path d="M4 1.8h5.2L12.5 5v9.2H4Z"/><path d="M9 1.8V5h3.5"/>',
    filecode: '<path d="M4 1.8h5.2L12.5 5v9.2H4Z"/><path d="M9 1.8V5h3.5"/><path d="M6.2 8L5 9.2l1.2 1.2M9.8 8L11 9.2 9.8 10.4"/>',
    cpu: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/><path d="M8 1.8v2.7M8 11.5v2.7M1.8 8h2.7M11.5 8h2.7"/>',
    up: '<path d="M8 13V3.5M4.2 7.3L8 3.5l3.8 3.8"/>',
    stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/>',
    x: '<path d="M4 4l8 8M12 4L4 12"/>',
    chev: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    check: '<path d="M3.2 8.6l3 3L12.8 4.4"/>',
    at: '<circle cx="8" cy="8" r="2.2"/><path d="M10.2 8v.8a2 2 0 0 0 4 0V8a6.2 6.2 0 1 0-2.4 4.9"/>'
  };
  function ico(name: string, size?: number) {
    var s = size || 14;
    return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  // ── 文件路径可点击：识别文本里的路径 → .fp span → openPath 给宿主打开 ──
  var FILE_RE = /([A-Za-z]:[\/][\w.\- \u4e00-\u9fff\/]*[\w.\-\u4e00-\u9fff]\.[A-Za-z0-9]{1,8}(?:\:\d{1,5})?|[\w.\-]+(?:[\/][\w.\- \u4e00-\u9fff]+)+\.[A-Za-z0-9]{1,8}(?:\:\d{1,5})?|[\w\u4e00-\u9fff][\w\-]*\.(?:ts|tsx|js|jsx|mjs|json|md|txt|html?|css|scss|less|py|java|c|cpp|h|hpp|go|rs|rb|php|sh|bat|ps1|ya?ml|toml|xml|svg|vue|sql|ini|conf|log|png|jpe?g|gif|webp|bmp|ico|avif|pdf)(?::\d{1,5})?)/g; // 第三支：光文件名（常见扩展名白名单）也可点，存在性由宿主 openFilePath 校验
  function cleanPath(p) {
    p = p.replace(/[.,;:!?)}\]⟩】»]+$/, '');
    var parts = p.split(' ');
    while (parts.length > 1 && parts[parts.length - 1].indexOf('/') === -1 && parts[parts.length - 1].indexOf('\\') === -1) parts.pop();
    return parts.join(' ');
  }
  var linkifyEnabled = true; // renderAll 批量重绘时关掉老消息的 linkify，只留最近几条（全量扫正则是大会话卡顿的主因）
  function linkify(root: HTMLElement | null) {
    if (!root || !linkifyEnabled) return;
    var nodes = [];
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) { var n = w.currentNode as HTMLElement; var par = n.parentNode as HTMLElement; if (par.nodeName !== 'PRE' && par.classList && !par.classList.contains('fp')) nodes.push(n); }
    for (var i = 0; i < nodes.length; i++) {
      var n2 = nodes[i]; var txt = n2.nodeValue; if (!txt) continue;
      FILE_RE.lastIndex = 0; if (!FILE_RE.test(txt)) continue;
      FILE_RE.lastIndex = 0;
      var frag = document.createDocumentFragment(); var last = 0, m2;
      while ((m2 = FILE_RE.exec(txt)) !== null) {
        if (m2.index > 0 && txt.charAt(m2.index - 1) === '/') { continue; } // URL 的一部分，不当作路径
        if (m2[0].indexOf('://') !== -1) { continue; } // URL 协议头（如 https://）被盘符分支误认，跳过
        if (/\.(?:vsix|zip|exe|dll|jar|7z|tar|gz|rar|bin|iso|pyc|woff2?|ttf|eot)$/i.test(m2[0])) { continue; } // 二进制文件不做成链接，点了也是报错页
        var p = cleanPath(m2[0]);
        if (m2.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m2.index)));
        if (p) { var sp = document.createElement('span'); sp.className = 'fp'; sp.textContent = p; sp.setAttribute('data-p', p); frag.appendChild(sp); }
        else frag.appendChild(document.createTextNode(m2[0]));
        last = m2.index + m2[0].length;
      }
      if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
      n2.parentNode!.replaceChild(frag, n2);
    }
  }
  // 点击 .fp → openPath 给宿主打开（捕获阶段，防止触发工具行折叠）
  messages.addEventListener('click', function (e) {
    var t = e.target as HTMLElement | null;
    while (t && t !== messages) {
      if (t.classList && t.classList.contains('fp')) {
        e.stopPropagation(); vscode.postMessage({ type: 'openPath', path: t.getAttribute('data-p') });
        return;
      }
      t = t.parentNode as HTMLElement | null;
    }
  }, true);

  // ── 头部/工具条图标注入（统一 SVG）──
  historyEl.innerHTML = ico('clock');
  newChatEl.innerHTML = ico('plus');
  moreEl.innerHTML = ico('gear');
  themeEl.innerHTML = ico('theme');
  attachEl.innerHTML = ico('image');
  pmUpload.innerHTML = ico('image', 13) + '<span>' + L.uploadFile + '</span><span style=' + String.fromCharCode(34) + 'opacity:.5;font-size:10px;margin-left:auto;' + String.fromCharCode(34) + '>' + L.dragShift + '</span>';
  pmAt.innerHTML = ico('at', 13) + '<span>' + L.referenceFile + '</span>';
  modelEl.innerHTML = ico('cpu') + ' —';
  stopBtn.innerHTML = ico('stop', 11);
  sendBtn.innerHTML = ico('up', 14);

  // ── ＋菜单：上传图片 / 引用文件 ──
  attachEl.addEventListener('click', function (e) {
    e.stopPropagation();
    plusmenuEl.style.display = plusmenuEl.style.display === 'block' ? 'none' : 'block';
  });
  pmUpload.addEventListener('click', function () { plusmenuEl.style.display = 'none'; fileInput.click(); });
  pmAt.addEventListener('click', function () {
    plusmenuEl.style.display = 'none';
    var v = input.value.replace(/[\s/@]+$/, ''); // 去掉尾部残留的斜杠/@/空格（斜杠菜单触发符、重复点击）
    input.value = (v ? v + ' ' : '') + '@'; // 已有文字补空格，@ 才能触发搜索（@ 要求行首或空格后）
    input.focus(); updateSuggest();
  });
  document.addEventListener('click', function (e) { var tgt = e.target as Node; if (!plusmenuEl.contains(tgt) && tgt !== attachEl) plusmenuEl.style.display = 'none'; });

  // ── 历史会话：点 ⏱ 直接打开原生会话菜单（QuickPick）──
  historyEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickSession' }); });
  var liveMsg = null; var liveDiv = null;
  // ── 欢迎页：存快照 + 随机小贴士（新建会话时重新出现，每次换一条）──
  var welcomeEl = document.getElementById('welcome');
  var welcomeHTML = welcomeEl ? welcomeEl.outerHTML : '';
  var TIPS = L.tips;
  function pickTip(el) { if (el) { var t = el.querySelector('.w-tip'); if (t) t.textContent = '💡 ' + TIPS[Math.floor(Math.random() * TIPS.length)]; } }
  pickTip(welcomeEl);
  var toolEls = {};
  var sgList = []; var sgSel = 0; var sgKind = null;
  var slashCmds = null;
  var workspaceFiles = null;
  var streaming = false;
  var pendingImages = [];
  var pendingFiles = [];

  function renderCodeChip() {
    if (!codeCtx) { codechipEl.style.display = 'none'; return; }
    codechipEl.style.display = 'inline-flex';
    codechipEl.innerHTML = ico('filecode', 12) + ' ' + esc(codeCtx.name) + (codeCtx.range ? ' <span class="cc-range">' + esc(codeCtx.range) + '</span>' : '');
    codechipEl.className = 'tb-btn' + (codeOn ? '' : ' off');
    codechipEl.title = (codeOn ? L.chipOff : L.chipOn) + '\n' + codeCtx.rel + ' (' + codeCtx.range + ')';
  }
  var liveLast = null;
  var toolEls = {};

  function el(tag: string, cls: string, text?: string) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== '') e.textContent = text;
    return e;
  }
  function scroll() { messages.scrollTop = messages.scrollHeight; }
  function setStatus(t) { if (t) { statusEl.classList.remove('busy'); statusEl.textContent = t; } else if (!streaming) { statusEl.textContent = ''; } }
  var queueN = 0;
  var modeText = 'Auto';
  var busyTimer = null; var busyStart = 0;
  function renderStatus() { modeBadge.textContent = modeText; }
  function setBusy(v) {
    streaming = v;
    stopBtn.style.display = v ? 'inline-flex' : 'none';
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    if (v) {
      statusEl.classList.add('busy');
      var frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      var fi = 0;
      statusEl.textContent = frames[0] + ' Working…';
      busyTimer = setInterval(function () {
        fi = (fi + 1) % frames.length;
        statusEl.textContent = frames[fi] + ' Working…' + (queueN > 0 ? L.queuedCount.replace('{n}', queueN) : '');
      }, 120);
    } else {
      statusEl.classList.remove('busy');
      statusEl.textContent = '';
    }
    if (!v) { finalizeLive(); liveReset(); }
  }

  // 轻量 Markdown：代码块 / 标题 / 列表 / 行内 code / 粗体
  function renderInline(elm, text) {
    var re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) elm.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0];
      if (tok.charAt(0) === '`') { var c = document.createElement('code'); c.textContent = tok.slice(1, -1); elm.appendChild(c); }
      else { var b = document.createElement('b'); b.textContent = tok.slice(2, -2); elm.appendChild(b); }
      last = m.index + tok.length;
    }
    if (last < text.length) elm.appendChild(document.createTextNode(text.slice(last)));
  }
  function renderPlain(parent, text) {
    var lines = String(text).split('\n');
    var div = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.trim() === '') { div = null; continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        var tbl = [line];
        while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) tbl.push(lines[++i]);
        renderTable(parent, tbl);
        div = null; continue;
      }
      if (/^#{1,6}\s/.test(line)) {
        var h = el('div', 'md-h'); renderInline(h, line.replace(/^#{1,6}\s*/, '')); parent.appendChild(h); div = null; continue;
      }
      var lm = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (lm) {
        var li = el('div', 'md-li'); li.style.paddingLeft = (12 + lm[1].length * 10) + 'px';
        li.appendChild(document.createTextNode((lm[2] === '-' || lm[2] === '*' ? '•' : lm[2]) + ' '));
        renderInline(li, lm[3]); parent.appendChild(li); div = null; continue;
      }
      if (/^>\s?/.test(line)) {
        var qt = el('div', 'md-quote'); renderInline(qt, line.replace(/^>\s?/, '')); parent.appendChild(qt); div = null; continue;
      }
      if (!div) { div = el('div', 'md-p'); parent.appendChild(div); }
      renderInline(div, line);
      div.appendChild(document.createTextNode('\n'));
    }
  }
  function renderTable(parent, rows) {
    function cells(r) { return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|'); }
    var t = document.createElement('table'); t.className = 'md-table';
    for (var ri = 0; ri < rows.length; ri++) {
      var cs = cells(rows[ri]);
      if (ri === 1 && cs.every(function (c) { return /^\s*:?-+:?\s*$/.test(c); })) continue; // 表头分隔行
      var tr = document.createElement('tr');
      for (var cj = 0; cj < cs.length; cj++) {
        var td = document.createElement(ri === 0 ? 'th' : 'td');
        renderInline(td, cs[cj].trim()); tr.appendChild(td);
      }
      t.appendChild(tr);
    }
    parent.appendChild(t);
  }
  function renderRich(parent, text) {
    // 逐行扫描：围栏必须行首才算代码块，行内 ``` 不影响（之前任意位置都算，行内反引号会把大段内容吞进代码框）
    var lines = String(text).split('\n');
    var buf = []; var code = []; var inCode = false;
    function flushPlain() { if (buf.length) { renderPlain(parent, buf.join('\n')); buf = []; } }
    function flushCode() { if (code.length) { parent.appendChild(el('pre', 'code', code.join('\n'))); code = []; } }
    for (var i = 0; i < lines.length; i++) {
      if (/^```/.test(lines[i])) {
        if (!inCode) { flushPlain(); inCode = true; }
        else { flushCode(); inCode = false; }
        continue;
      }
      if (inCode) code.push(lines[i]); else buf.push(lines[i]);
    }
    if (code.length) parent.appendChild(el('pre', 'code', code.join('\n')));
    flushPlain();
    linkify(parent);
  }

  function addUser(text: string, imageCount?: number, codeInfo?: string, fileCount?: number) { var w = document.getElementById('welcome'); if (w) w.remove(); var b = el('div', 'bubble user'); if (text) { b.textContent = text; } else { b.innerHTML = ico('filecode', 12) + ' ' + L.codeCtxBubble; } if (codeInfo) { var n1 = el('div', 'notice'); n1.innerHTML = ico('filecode', 12) + ' ' + L.attachedCode + esc(codeInfo); b.appendChild(n1); } if (fileCount) { var n3 = el('div', 'notice'); n3.innerHTML = ico('filecode', 12) + ' ' + fileCount + L.filesUnit; b.appendChild(n3); } if (imageCount) { var n2 = el('div', 'notice'); n2.innerHTML = ico('image', 12) + ' ' + imageCount + L.imagesUnit; b.appendChild(n2); } messages.appendChild(b); scroll(); }
  var queuedItems = [];
  function addQueued(q) {
    queuedItems.push(q);
    var b = el('div', 'q-item');
    b.setAttribute('data-qid', q.qid);
    var qi = el('span', 'q-ico'); qi.innerHTML = ico('clock', 12); b.appendChild(qi);

    b.appendChild(el('span', 'q-text', (q.text || L.imgOrCode) + (q.fileCount ? ' +' + q.fileCount + L.qFilesUnit : '') + (q.imageCount ? ' +' + q.imageCount + L.qImgsUnit : '')));
    // 排队项固定在输入框上方的 queuebar，单行紧凑显示，不参与消息流
    document.getElementById('queuebar').appendChild(b);
  }
  function removeQueued(qid) {
    queuedItems = queuedItems.filter(function(x) { return x.qid !== qid; });
    var els = document.getElementById('queuebar').querySelectorAll('[data-qid="' + qid + '"]');
    for (var i = 0; i < els.length; i++) els[i].parentNode.removeChild(els[i]);
  }
  var liveMsg = null; var liveDiv = null; var pdet = null;
  // 增量渲染（照 pi TUI 的思路：只往已有节点追加，不整气泡重绘；文本块结束时才做一次 markdown 渲染，settled 再全量纠偏）
  var liveParts = null;
  function liveEnsure() {
    if (!liveDiv) { liveDiv = el('div', 'bubble assistant'); messages.appendChild(liveDiv); }
    if (!liveMsg) liveMsg = { content: [] };
    if (!liveParts) liveParts = {};
  }
  function liveBlock(ci: number, kind: string, name?: string) {
    liveEnsure();
    while (liveMsg.content.length <= ci) liveMsg.content.push(null);
    var p = liveParts[ci];
    if (p && p.kind !== kind) { finalizeLive(); p = null; }
    if (!p) {
      var wrap = document.createElement('div'); var body;
      if (kind === 'thinking') {
        var d = document.createElement('details'); d.className = 'think'; d.open = true;
        var sm = document.createElement('summary'); sm.textContent = L.thinkingProcess;
        body = el('div', 'think-body', ''); d.appendChild(sm); d.appendChild(body); wrap.appendChild(d);
      } else if (kind === 'toolCall') {
        var tl = el('div', 'tool run'); tl.appendChild(el('span', 't-dot')); tl.appendChild(el('span', 't-name', name || 'tool'));
        body = el('span', 't-detail', L.genArgs.replace('{n}', 0)); tl.appendChild(body); wrap.appendChild(tl); pdet = body;
        wrap.className = 'prow'; // 占位行标记：工具真正开跑时按 class 全局清除
        var abox = el('pre', 'code'); abox.style.display = 'none'; wrap.appendChild(abox);
        tl.addEventListener('click', function () { abox.style.display = abox.style.display === 'none' ? 'block' : 'none'; });
      } else {
        body = el('div', 'md-p', ''); wrap.appendChild(body);
      }
      liveDiv.appendChild(wrap);
      p = { kind: kind, wrap: wrap, body: body, buf: '', doneLen: 0, tail: null, tailCode: false };
      if (kind === 'toolCall') { p.raw = ''; p.box = abox; }
      liveParts[ci] = p;
    }
    return p;
  }
  function finalizeLive() {
    if (!liveParts) return;
    for (var k in liveParts) {
      var p = liveParts[k];
      if (p && p.kind === 'text' && !p.done) {
        p.done = true;
        appendFinal(p, p.buf.slice(p.doneLen));
        p.doneLen = p.buf.length;
      }
    }
  }
  function liveReset() { liveMsg = null; liveDiv = null; pdet = null; liveParts = null; }
  // 流式 markdown：已完成的行一次性定型不再动，只有当前行/未闭合代码块作为小尾巴更新
  // （整块重渲染有顿挫感；行级增量才是 CC 那种连贯流式）
  var liveRTimer = null;
  function appendFinal(p, chunk) {
    if (!chunk) return;
    if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail);
    p.tail = null;
    var d = document.createElement('div'); renderRich(d, chunk); p.body.appendChild(d);
  }
  function setMdTail(p, text) {
    if (!text) { if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail); p.tail = null; return; }
    if (!p.tail || p.tailCode) {
      if (p.tail && p.tail.parentNode) p.tail.parentNode.removeChild(p.tail);
      p.tail = el('div', 'md-p', ''); p.body.appendChild(p.tail); p.tailCode = false;
    }
    p.tail.textContent = text;
  }
  function streamTick(p) {
    var rest = p.buf.slice(p.doneLen);
    if (p.tailCode) {
      var ci = rest.search(/^```/m);
      if (ci === -1) { if (p.tail) p.tail.textContent = rest; return; }
      var le = rest.indexOf('\n', ci);
      if (le === -1) { if (p.tail) p.tail.textContent = rest; return; }
      appendFinal(p, rest.slice(0, le + 1));
      p.tailCode = false; p.doneLen += le + 1;
      rest = p.buf.slice(p.doneLen);
    }
    var nl = rest.lastIndexOf('\n');
    if (nl === -1) { setMdTail(p, rest); return; }
    var complete = rest.slice(0, nl + 1);
    var fences = complete.match(/^```/gm);
    if (fences && fences.length % 2 === 1) {
      var idx = complete.lastIndexOf('\n```');
      var lineEnd = idx === -1 ? complete.indexOf('\n') : complete.indexOf('\n', idx + 1);
      var openEnd = lineEnd + 1;
      appendFinal(p, complete.slice(0, openEnd));
      p.doneLen += openEnd;
      p.tailCode = true;
      p.tail = document.createElement('pre'); p.tail.className = 'code';
      p.body.appendChild(p.tail);
      p.tail.textContent = p.buf.slice(p.doneLen);
      return;
    }
    appendFinal(p, complete);
    p.doneLen += complete.length;
    setMdTail(p, rest.slice(nl + 1));
  }
  function scheduleStream() { if (!liveRTimer) liveRTimer = setTimeout(function () { liveRTimer = null; if (liveParts) for (var k in liveParts) { var p = liveParts[k]; if (p && p.kind === 'text' && !p.done && p.buf.length > p.doneLen) streamTick(p); } scroll(); }, 100); }
  function appendDelta(t, ci) {
    var p = liveBlock(ci, 'text');
    p.buf += t;
    streamTick(p); scroll();
  }
  function appendThink(t, ci) {
    var p = liveBlock(ci, 'thinking');
    p.buf += t; p.body.appendChild(document.createTextNode(t));
    scroll();
  }
  function toolStart(id: string, name: string, detail?: string, collapsed?: boolean) {
    var t = el('div', 'tool run');
    t.appendChild(el('span', 't-dot'));
    t.appendChild(el('span', 't-name', name));
    if (detail) { var d = el('span', 't-detail', detail); d.title = detail; t.appendChild(d); linkify(d); }
    var arr = el('span', 't-arrow'); arr.innerHTML = ico('chev', 12); t.appendChild(arr);
    var box = el('div', 'tool-box');
    if (detail) {
      var inRow = el('div', 'tb-row');
      inRow.appendChild(el('span', 'tb-tag', 'IN'));
      inRow.appendChild(el('span', 'tb-val', detail));
      box.appendChild(inRow);
    }
    linkify(box);
    box.style.display = collapsed ? 'none' : 'block';
    if (!collapsed) t.classList.add('open');
    t.addEventListener('click', function () {
      if (!box.textContent) return;
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      t.classList.toggle('open');
    });
    toolEls[id] = { row: t, box: box };
    messages.appendChild(t);
    messages.appendChild(box);
    scroll();
  }
  function toolEnd(id, name, isError, text, detail) {
    var ref = toolEls[id];
    if (!ref) {
      var b2 = el('div', 'tool-box'); b2.style.display = 'none';
      ref = { row: el('div', 'tool'), box: b2 };
      toolEls[id] = ref;
      messages.appendChild(ref.row);
      messages.appendChild(ref.box);
    }
    var t = ref.row;
    var wasOpen = ref.box.style.display !== 'none';
    t.className = 'tool ' + (isError ? 'err' : 'ok');
    t.innerHTML = '';
    t.appendChild(el('span', 't-dot'));
    t.appendChild(el('span', 't-name', name));
    if (detail) { var d2 = el('span', 't-detail', detail); d2.title = detail; t.appendChild(d2); linkify(d2); }
    var arr2 = el('span', 't-arrow'); arr2.innerHTML = ico('chev', 12); t.appendChild(arr2);
    ref.box.innerHTML = '';
    if (detail) {
      var r1 = el('div', 'tb-row');
      r1.appendChild(el('span', 'tb-tag', 'IN'));
      r1.appendChild(el('span', 'tb-val', detail));
      ref.box.appendChild(r1);
    }
    linkify(ref.box);
    if (text) {
      var r2 = el('div', 'tb-row');
      r2.appendChild(el('span', 'tb-tag', 'OUT'));
      r2.appendChild(el('span', 'tb-val', String(text).slice(0, 1000)));
      ref.box.appendChild(r2);
      t.title = String(text).slice(0, 400);
    }
    if (!ref.box.textContent) { ref.box.style.display = 'none'; }
    if (wasOpen && ref.box.style.display !== 'none') t.classList.add('open');
    scroll();
  }
  function notice(text) { if (/扩展已加载/.test(text)) return; var last = messages.lastElementChild; if (last && last.classList && last.classList.contains('notice') && last.textContent === text) return; var n = el('div', 'notice', text); linkify(n); messages.appendChild(n); scroll(); }
  function textOf(content) {
    if (typeof content === 'string') return content;
    var out = '';
    if (Array.isArray(content)) {
      for (var i = 0; i < content.length; i++) {
        var c = content[i];
        if (c && c.type === 'text' && c.text) out += c.text;
      }
    }
    return out;
  }
  function makeThink(text) {
    var d = document.createElement('details');
    d.className = 'think';
    var s = document.createElement('summary'); s.textContent = L.thinkingProcess;
    var body = el('div', 'think-body', text);
    d.appendChild(s); d.appendChild(body);
    return d;
  }
  function renderAll(list) {
    messages.innerHTML = '';
    liveReset();
    toolEls = {};
    if (!list || !list.length) {
      if (welcomeHTML) { messages.innerHTML = welcomeHTML; pickTip(messages.querySelector('#welcome')); }
      return;
    }
    linkifyEnabled = false; // 老消息不 linkify，循环到最近 15 条时再打开
    var results = {};
    var resultList = [];
    for (var k = 0; k < list.length; k++) {
      var rr = list[k];
      if (rr.role === 'toolResult') {
        var entry = { text: textOf(rr.content), isError: !!rr.isError, used: false };
        results[rr.toolCallId || ''] = entry;
        resultList.push(entry);
      }
    }
    function historyDetail(args) {
      if (!args) return '';
      var v = args.command || args.file_path || args.path || args.url || args.query || args.pattern || args.skill || args.file || args.cmd || '';
      if (!v) { for (var kk in args) { if (typeof args[kk] === 'string' && args[kk]) { v = args[kk]; break; } } }
      return typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 120) : '';
    }
    function toolGroupRun(name, run, mi) {
      var allOk = true;
      var lines = [];
      for (var gi = 0; gi < run.length; gi++) {
        var g = run[gi];
        var gd = historyDetail(g.arguments);
        var gr = (g.id && results[g.id]) || null;
        if (gr) { gr.used = true; }
        else { for (var gp = 0; gp < resultList.length; gp++) { if (!resultList[gp].used) { gr = resultList[gp]; resultList[gp].used = true; break; } } }
        if (gr && gr.isError) allOk = false;
        var out1 = gr && gr.text ? String(gr.text).replace(/\s+/g, ' ').slice(0, 80) : '';
        lines.push({ d: gd, out: out1, err: gr ? gr.isError : false });
      }
      var t = el('div', 'tool ' + (allOk ? 'ok' : 'err'));
      t.appendChild(el('span', 't-dot'));
      t.appendChild(el('span', 't-name', name));
      var det0 = lines[0] && lines[0].d ? '  ' + lines[0].d : '';
      var dsum = el('span', 't-detail', '\u00d7' + run.length + det0);
      dsum.title = lines.map(function(l) { return (l.d || L.noArgs) + (l.out ? '  → ' + l.out : ''); }).join('\n');
      t.appendChild(dsum); linkify(dsum);
      var arrA = el('span', 't-arrow'); arrA.innerHTML = ico('chev', 12); t.appendChild(arrA);

      var box = el('div', 'tool-box');
      for (var li = 0; li < lines.length; li++) {
        var row = el('div', 'tb-row');
        var tag = el('span', 'tb-tag'); tag.innerHTML = ico(lines[li].err ? 'x' : 'check', 11);

        tag.style.color = lines[li].err ? '#f66' : '#4ec96e';
        row.appendChild(tag);
        row.appendChild(el('span', 'tb-val', (lines[li].d || L.noArgs) + (lines[li].out ? ('  → ' + lines[li].out) : '')));
        box.appendChild(row);
      }
      box.style.display = 'none';
      t.addEventListener('click', function () {
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
        t.classList.toggle('open');
      });
      messages.appendChild(t);
      messages.appendChild(box);
    }
    for (var i = 0; i < list.length; i++) {
      if (i >= list.length - 15) linkifyEnabled = true;
      var m = list[i];
      if (m.role === 'user') {
        var ut = textOf(m.content); var ui = null; var ufiles = 0;
        var ccm = ut.match(/^--- 代码上下文: (.+?) \((.+?)\) ---\n/);
        if (ccm) {
          ui = ccm[1] + ' ' + ccm[2];
          var eIdx = ut.indexOf('\n--- 代码上下文结束 ---\n');
          if (eIdx > 0) { ut = ut.slice(eIdx + '\n--- 代码上下文结束 ---\n'.length); if (ut.charAt(0) === '\n') ut = ut.slice(1); }
          else { var ci2 = ut.lastIndexOf('\n```\n\n'); ut = ci2 > ccm[0].length ? ut.slice(ci2 + 6) : ut.slice(ccm[0].length); } // 老格式兑底
        }
        var am2;
        while ((am2 = ut.match(/^--- 附件: ([^\n]*) ---\n/))) {
          var term2 = '\n--- 附件结束: ' + am2[1] + ' ---\n';
          var ei2 = ut.indexOf(term2);
          if (ei2 < 0) { var fb = ut.match(/^--- 附件: [^\n]* ---\n```\n[\s\S]*?\n```\n\n/); if (!fb) break; ut = ut.slice(fb[0].length); if (ut.charAt(0) === '\n') ut = ut.slice(1); continue; }
          ufiles++;
          ut = ut.slice(ei2 + term2.length);
          if (ut.charAt(0) === '\n') ut = ut.slice(1);
        }
        addUser(ut, m.attachments ? m.attachments.length : 0, ui, ufiles);
      }
      else if (m.role === 'assistant') {
        var b = el('div', 'bubble assistant');
        var flushB = function () { if (b.childNodes.length) { messages.appendChild(b); b = el('div', 'bubble assistant'); } };
        if (Array.isArray(m.content)) {
          for (var j = 0; j < m.content.length; j++) {
            var c = m.content[j];
            if (c && c.type === 'thinking' && c.thinking) b.appendChild(makeThink(c.thinking));
            else if (c && c.type === 'text' && c.text) { var td = document.createElement('div'); renderRich(td, c.text); b.appendChild(td); }
            else if (c && c.type === 'toolCall') {
              flushB();
              var run = [c];
              while (j + 1 < m.content.length && m.content[j+1] && m.content[j+1].type === 'toolCall' && m.content[j+1].name === c.name) { run.push(m.content[++j]); }
              if (run.length === 1) {
                var hid = c.id || ('h' + i + '_' + j);
                var det = historyDetail(c.arguments);
                toolStart(hid, c.name, det, true);
                var res = (c.id && results[c.id]) || null;
                if (!res) { for (var rp = 0; rp < resultList.length; rp++) { if (!resultList[rp].used) { res = resultList[rp]; break; } } }
                if (res) { res.used = true; toolEnd(hid, c.name, res.isError, res.text, det); }
              } else {
                toolGroupRun(c.name, run, i);
              }
            }
          }
        } else { renderRich(b, textOf(m.content)); }
        flushB();
        if (m.stopReason === 'error' && m.errorMessage) {
          var eb = el('div', 'bubble assistant errmsg');
          eb.textContent = '✘ ' + String(m.errorMessage).slice(0, 300);
          var rb = el('span', 'errmsg-retry', L.retryEdit);
          rb.addEventListener('click', function () { vscode.postMessage({ type: 'retryFromLast' }); });
          eb.appendChild(document.createElement('br'));
          eb.appendChild(rb);
          messages.appendChild(eb);
        }
      }
      else if (m.role === 'bashExecution') { messages.appendChild(el('div', 'tool ok', '! ' + m.command)); }
    }
    for (var rq = 0; rq < queuedItems.length; rq++) addQueued(queuedItems[rq]);
    scroll();
  }
  function fmtSession(file, name) {
    if (name) return name;
    var s = String(file || '');
    var mm = s.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
    if (mm) return mm[2] + '-' + mm[3] + ' ' + mm[4] + ':' + mm[5];
    return s.split(/[\\/]/).pop() || L.ephemeralSession;
  }
  function applyState(m) {
    setStatus(''); // pi 已就绪，清掉「正在启动 pi…」之类的临时状态
    modelEl.innerHTML = ico('cpu') + ' ' + esc(m.model ? (m.model.name || m.model.id) : '—');
    modelEl.title = m.model ? L.modelTitleCur.replace('{v}', (m.model.provider || '') + '/' + (m.model.id || '')) : L.switchModel;
    thinkEl.textContent = L.thinkLabel + (m.thinkingLevel !== null && m.thinkingLevel !== undefined ? m.thinkingLevel : '—');
    var sessName = fmtSession(m.sessionFile, m.sessionName);
    sessionEl.textContent = L.sessionLabel + sessName;
    sessionEl.title = m.sessionFile ? (L.curSession + m.sessionFile + '\n' + L.clickSwitchSession) : L.clickPickSession;
    if (m.stats) {
      var parts = [];
      if (m.stats.contextPercent !== null && m.stats.contextPercent !== undefined) parts.push(L.ctx + (Math.round(m.stats.contextPercent * 10) / 10) + '%');
      if (m.stats.cost) parts.push('$' + Number(m.stats.cost).toFixed(2));
      usageEl.textContent = parts.join(' · ');
      usageEl.title = parts.join(' · ');
    } else { usageEl.textContent = ''; }
  }

  function handleFiles(files) {
    var textDone = false;
    var fileCount = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.type.indexOf('image/') !== 0) {
        // 非图片 → 读成文本，作为顶部附件行胶囊（最多 5 个，单个超 200KB 跳过）
        if (pendingFiles.length >= 5) { notice(L.maxFiles); break; }
        if (f.size > 200 * 1024) { notice(L.fileTooBig + (f.name || '')); continue; }
        (function(file) {
          var r = new FileReader();
          r.onload = function() { pendingFiles.push({ name: file.name || 'file', text: String(r.result || '') }); renderAttach(); };
          r.readAsText(file);
        })(f);
        continue;
      }
      if (pendingImages.length >= 4) { notice(L.maxImages); break; }
      (function(file) {
        var r = new FileReader();
        r.onload = function() {
          let url = String(r.result);
          var data = url.split(',')[1] || '';
          if (!data) return;
          var probe = new Image();
          probe.onerror = function() { notice('ⓐ ' + L.imgReadFail + (file.name || '') + L.imgReadFailSuf.replace('{v}', file.type || L.unknown)); };
          if (!file.type) { url = 'data:image/png;base64,' + data; }
          probe.onload = function() {
            // 尺寸过小的图片模型端会报 400（图片输入格式/解析错误），直接拦下
            if (probe.naturalWidth < 16 || probe.naturalHeight < 16) { notice('ⓐ ' + L.imgTooSmall.replace('{w}', probe.naturalWidth).replace('{h}', probe.naturalHeight)); return; }
            pendingImages.push({ data: data, mimeType: file.type, name: file.name || 'image.png', w: probe.naturalWidth, h: probe.naturalHeight });
            renderAttach();
          };
          probe.src = url;
        };
        r.readAsDataURL(file);
      })(f);
    }
  }
  function renderAttach() {
    attachbarEl.innerHTML = '';
    for (var i = 0; i < pendingImages.length; i++) {
      (function(idx) {
        var p = pendingImages[idx];
        var chip = el('span', 'chip-img');
        var img = document.createElement('img');
        img.src = 'data:' + p.mimeType + ';base64,' + p.data;
        chip.appendChild(img);
        chip.appendChild(document.createTextNode(p.name + (p.w ? ' ' + p.w + '\u00d7' + p.h : '')));
        var x = el('span', 'chip-x', '\u00d7');
        x.addEventListener('click', function() { pendingImages.splice(idx, 1); renderAttach(); });
        chip.appendChild(x);
        attachbarEl.appendChild(chip);
      })(i);
    }
    for (var j = 0; j < pendingFiles.length; j++) {
      (function(idx) {
        var p = pendingFiles[idx];
        var chip = el('span', 'chip-file');
        chip.innerHTML = ico('filecode', 12) + ' ' + esc(p.name);
        var x = el('span', 'chip-x', '\u00d7');
        x.addEventListener('click', function() { pendingFiles.splice(idx, 1); renderAttach(); });
        chip.appendChild(x);
        attachbarEl.appendChild(chip);
      })(j);
    }
    attachbarEl.style.display = (pendingImages.length + pendingFiles.length) ? 'flex' : 'none';
  }
  function hideSuggest() { suggestEl.style.display = 'none'; }
  function updateSuggest() {
    var t = input.value;
    var m = t.match(/(^|\s)([\/@])([^\s]*)$/);
    if (!m) { hideSuggest(); return; }
    var trigger = m[2], q = m[3];
    if (trigger === '/') {
      sgKind = 'slash';
      if (slashCmds === null) { vscode.postMessage({ type: 'getSlash' }); hideSuggest(); return; }
      var ql = q.toLowerCase();
      var list = slashCmds.filter(function(c) { return ((c.label || c.name || '') + ' ' + (c.description || '')).toLowerCase().indexOf(ql) !== -1; });
      var rows = []; var lastGroup = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].group && list[i].group !== lastGroup) { lastGroup = list[i].group; rows.push({ header: true, label: list[i].group }); }
        rows.push({ label: list[i].label || ('/' + (list[i].name || '')), detail: list[i].description || '', item: list[i] });
      }
      renderSuggest(rows.slice(0, 80));
    } else {
      sgKind = 'files';
      if (workspaceFiles === null) { vscode.postMessage({ type: 'getFiles' }); hideSuggest(); return; }
      var ql2 = q.toLowerCase();
      var fl = workspaceFiles.filter(function(f) { return f.rel.toLowerCase().indexOf(ql2) !== -1; });
      renderSuggest(fl.slice(0, 50).map(function(f) { return { label: f.rel, detail: f.dir, item: f }; }));
    }
  }
  function renderSuggest(rows) {
    if (!rows.length) { hideSuggest(); return; }
    sgList = rows;
    sgSel = 0; while (sgSel < rows.length && rows[sgSel].header) sgSel++;
    if (sgSel >= rows.length) { hideSuggest(); return; }
    suggestEl.innerHTML = '';
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].header) { suggestEl.appendChild(el('div', 'sg-header', rows[i].label)); continue; }
      (function(idx) {
        var d = el('div', 'sg-item');
        d.appendChild(el('span', 'sg-label', rows[idx].label));
        if (rows[idx].detail) d.appendChild(el('span', 'sg-detail', rows[idx].detail));
        d.addEventListener('mousedown', function(e) { e.preventDefault(); applySuggest(rows[idx].item); });
        d.addEventListener('mouseenter', function() { sgSel = idx; paintSuggest(); });
        suggestEl.appendChild(d);
      })(i);
    }
    suggestEl.style.display = 'block';
    paintSuggest();
  }
  function nextSel(dir) {
    var n = sgSel;
    for (var step = 0; step < sgList.length; step++) {
      n += dir; if (n < 0) n = sgList.length - 1; if (n >= sgList.length) n = 0;
      if (!sgList[n].header) break;
    }
    sgSel = n;
  }
  function paintSuggest() {
    var items = suggestEl.children;
    for (var i = 0; i < items.length; i++) { if (!sgList[i] || !sgList[i].header) items[i].className = 'sg-item' + (i === sgSel ? ' active' : ''); }
    if (items[sgSel]) items[sgSel].scrollIntoView({ block: 'nearest' });
  }
  function applySuggest(item) {
    if (!item || item.header) return; // 防止选中分组标题出现 /undefined
    if (item.builtin === 'mentionFile') { var v = input.value.replace(/[\s/@]+$/, ''); input.value = (v ? v + ' ' : '') + '@'; hideSuggest(); input.focus(); updateSuggest(); return; }
    if (item.builtin) { input.value = input.value.replace(/(^|\s)[\/@][^\s]*$/, '$1'); hideSuggest(); vscode.postMessage({ type: item.builtin }); return; }
    var t = input.value;
    var m = t.match(/(^|\s)([\/@])([^\s]*)$/);
    var label = sgKind === 'slash' ? ('/' + item.name) : (m && m[2] === '@' ? '@' : '') + item.rel;
    if (m) t = t.slice(0, t.length - m[0].length) + m[1] + label + ' ';
    input.value = t;
    hideSuggest();
    input.focus();
  }
  function send() {
    var t = input.value.trim();
    if (!t && !pendingImages.length && !pendingFiles.length) return;
    var imgs = pendingImages.map(function(p) { return { data: p.data, mimeType: p.mimeType }; });
    var fs2 = pendingFiles.map(function(p) { return { name: p.name, text: p.text }; });
    var attachCode = codeCtx && codeOn;
    input.value = '';
    autoSize();
    pendingImages = []; pendingFiles = []; renderAttach();
    vscode.postMessage({ type: 'prompt', text: t || (imgs.length ? L.seeImage : (fs2.length ? L.seeFiles : (attachCode ? L.seeCode : ''))), images: imgs, files: fs2, attachCode: !!attachCode });
  }
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', function () { vscode.postMessage({ type: 'abort' }); });
  fileInput.addEventListener('change', function () { handleFiles(fileInput.files || []); fileInput.value = ''; });
  sessionEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickSession' }); });
  moreEl.addEventListener('click', function () { vscode.postMessage({ type: 'more' }); });
  themeEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickTheme' }); });
  langEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickLang' }); });
  newChatEl.addEventListener('click', function () { vscode.postMessage({ type: 'newSession' }); });
  modelEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickModel' }); });
  thinkEl.addEventListener('click', function () { vscode.postMessage({ type: 'pickThinking' }); });
  modeBadge.addEventListener('click', function () { vscode.postMessage({ type: 'pickMode' }); });
  codechipEl.addEventListener('click', function () { codeOn = !codeOn; renderCodeChip(); });
  input.addEventListener('input', function () { updateSuggest(); autoSize(); });
  // 自适应高度：随内容增长，到 220px 上限后改为内部滚动（消息区不会被挤没）
  function autoSize() {
    input.style.height = 'auto';
    var over = input.scrollHeight > 220;
    input.style.overflowY = over ? 'auto' : 'hidden';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }
  input.addEventListener('keydown', function (e) {
    var sgOpen = suggestEl.style.display === 'block';
    if (sgOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); nextSel(1); paintSuggest(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); nextSel(-1); paintSuggest(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); var r0 = sgList[sgSel]; if (r0) applySuggest(r0.item); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && !sgOpen) { vscode.postMessage({ type: 'abort' }); }
  });
  function filesFromClipboard(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) out.push(f); }
    }
    return out;
  }
  input.addEventListener('paste', function (e) {
    var files = filesFromClipboard((e.clipboardData || {}).items || []);
    if (files.length) { e.preventDefault(); handleFiles(files); }
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); var dt = e.dataTransfer; if (dt && dt.files && dt.files.length) handleFiles(dt.files); });
  window.addEventListener('message', function (ev: MessageEvent) {
    var m = ev.data as HostToWebview;
    if (m.type === 'user') addUser(m.text, m.imageCount, m.codeInfo, m.fileCount);
    else if (m.type === 'newLive') { finalizeLive(); liveReset(); }
    else if (m.type === 'delta') appendDelta(m.text, m.ci);
    else if (m.type === 'thinking') appendThink(m.text, m.ci);
    else if (m.type === 'toolStart') {
      finalizeLive();
      var olds = messages.querySelectorAll('.prow'); for (var oi = 0; oi < olds.length; oi++) olds[oi].parentNode.removeChild(olds[oi]);
      liveReset(); toolStart(m.id, m.name, m.detail);
    }
    else if (m.type === 'toolCallStart') {
      var tp = liveBlock(m.ci, 'toolCall', m.name);
      tp._len = 0; tp.raw = '';
      liveMsg.content[m.ci] = tp; scroll();
    }
    else if (m.type === 'toolCallDelta') { var tb = liveMsg && liveMsg.content[m.ci]; if (tb) { tb._len += (m.chunk || '').length; tb.raw += m.chunk || ''; if (pdet) pdet.textContent = L.genArgs.replace('{n}', tb._len); if (tb.box && tb.box.style.display === 'block') tb.box.textContent = tb.raw.slice(-20000); } }
    else if (m.type === 'toolEnd') toolEnd(m.id, m.name, m.isError, m.text, m.detail);
    else if (m.type === 'busy') setBusy(m.value);
    else if (m.type === 'render') { var rm = m; setTimeout(function () { renderAll(rm.messages); }, 0); } // 延后一拍：让刚到的用户气泡先上屏，再慢慢重绘全页
    else if (m.type === 'queue') { queueN = (m.steering ? m.steering.length : 0) + (m.followUp ? m.followUp.length : 0); renderStatus(); }
    else if (m.type === 'notice') notice(m.text);
    else if (m.type === 'fillInput') { input.value = m.text || ''; input.focus(); scroll(); }
    else if (m.type === 'status') setStatus(m.text);
    else if (m.type === 'mode') { modeText = m.text || ''; renderStatus(); }
    else if (m.type === 'queuedAdd') addQueued(m);
    else if (m.type === 'queuedDelivered') { removeQueued(m.qid); if (m.show) addUser(m.text, m.imageCount, m.codeInfo); }
    else if (m.type === 'queuedClear') { queuedItems = []; document.getElementById('queuebar').innerHTML = ''; }
    else if (m.type === 'codeCtx') { codeCtx = m.ctx; renderCodeChip(); }
    else if (m.type === 'addImages') { (function() {
      var list = m.images || []; var k = 0;
      function nextAdi() {
        if (k >= list.length || pendingImages.length >= 4) { renderAttach(); return; }
        var p = list[k++]; if (!p.mimeType) p.mimeType = 'image/png';
        var probe = new Image();
        probe.onload = function() {
          if (probe.naturalWidth < 16 || probe.naturalHeight < 16) { notice('ⓐ ' + L.imgTooSmall2.replace('{w}', probe.naturalWidth).replace('{h}', probe.naturalHeight).replace('{v}', p.name || '')); nextAdi(); return; }
          p.w = probe.naturalWidth; p.h = probe.naturalHeight; pendingImages.push(p); nextAdi();
        };
        probe.onerror = function() { notice('ⓐ ' + L.imgReadFail + (p.name || '')); nextAdi(); };
        probe.src = 'data:' + p.mimeType + ';base64,' + p.data;
      }
      nextAdi();
    })(); }
    else if (m.type === 'addFiles') { pendingFiles = pendingFiles.concat(m.files || []); renderAttach(); }
    else if (m.type === 'slashList') { slashCmds = m.commands || []; updateSuggest(); }
    else if (m.type === 'fileList') { workspaceFiles = m.files || []; updateSuggest(); }
    else if (m.type === 'state') applyState(m);
    else if (m.type === 'theme') { document.body.setAttribute('data-theme', m.name || 'auto'); }
  });
  // 启动握手：通知宿主 webview 已就绪，宿主拉会话历史重绘（防止设置 HTML 后立刻 postMessage 被丢的竞态）
  vscode.postMessage({ type: 'webviewReady' });
})();
