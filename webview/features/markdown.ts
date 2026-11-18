/**
 * 渲染基座（2026-11-23 第 5 刀子刀 5a，从 webview/main.ts 整块拆出）：轻量 markdown——
 * 代码块 / 标题 / 列表 / 行内 code / 粗体 / 表格。
 *
 * 为什么是 initMarkdown(deps)：本模块**没有自己的状态**（纯函数群，只碰传入的 DOM），
 * deps 只有两个——建 DOM 的 el（原 main.ts 里 100+ 处共用，留家）与 linkify（渲染完顺手把
 * 路径/符号做成可点，住 features/linkify.ts）。main.ts 装配一次，调用点仍走同名别名
 * `renderRich`（调用方 addUser / makeCompaction / appendFinal / setMdTail / renderAll 全在
 * 第 5 刀的 5b/5d，未搬）。
 *
 * 语义红线（2026-09-23 假链事故的邻居，一条都别「顺手优化」）：
 * - 围栏必须**行首**才算代码块（`/^```/`）——曾「任意位置都算」，行内反引号把大段正文吞进代码框；
 * - 表格按连续 `|` 行分组，第 2 行是表头分隔行时跳过（renderTable 的 ri===1 判断）；
 * - 顺序恒为 renderRich → renderPlain → renderInline，末尾统一 linkify 一次。
 *
 * 行为红线：DOM tag/class（md-h / md-li / md-quote / md-p / md-table / code）、CSS 一律不动；
 * 这是纯搬家，逐字核对见 reports/REPORT-t38.md。
 */

export interface MarkdownDeps {
  /** 建 DOM 工具（原 main.ts 的 el：textContent 安全写入，不解析 HTML） */
  el: (tag: string, cls?: string, text?: string) => HTMLElement;
  /** 路径/符号可点（features/linkify.ts 返回的 linkify） */
  linkify: (root: HTMLElement | null) => void;
}

export function initMarkdown(deps: MarkdownDeps) {
  var el = deps.el;
  var linkify = deps.linkify;
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
  return { renderInline: renderInline, renderPlain: renderPlain, renderTable: renderTable, renderRich: renderRich };
}
