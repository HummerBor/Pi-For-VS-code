/**
 * 输入区（2026-11-23 第 4 刀，从 webview/main.ts 整块拆出）：附件摄入与去重 / 附件条渲染 /
 * `/` `@` 联想菜单 / 发送链 / 键位 / 高度自适应 / 全角归一 / 粘贴图片。
 *
 * 为什么是 initComposer(deps)：本模块是**每页签一套**的视图成员（每页签各有一个 #input /
 * #attachbar / #suggest）。入口在 makeSessionView 里调一次，元素经 deps.q 查（**禁止**
 * document.getElementById——ID 在每个 .session-view 内重复，见 main.ts 的 q 注释）。
 *
 * ★ 红线一（事故级）：本模块**不许**给 `#input` / `#send` 绑任何事件。
 *   `bindComposerOnce`（留在 main.ts）已经绑了 click/keydown/paste/input/compositionend，
 *   两边各绑一次 → 一次点击发**两条** prompt。本模块只读写元素的 value/selection/focus。
 * ★ 红线二：页面级共享变量一律**注入不复制**（sentHistory / slashCmds / workspaceFiles /
 *   codeCtx+codeOn）——复制成 per-view 副本 = 行为变更（每页签一份输入历史 / 各自拉一次 getSlash）。
 * ★ 红线三：`histIdx`/`histDraft` 住在 main.ts：`bindComposerOnce` 正文里有 `histIdx = -1;
 *   histDraft = '';` 两行裸赋值，把它们搬走就得改那个函数（「发送命脉」）的正文——本刀不碰。
 *   这里只经 deps.resetHist / deps.histNav 转调（`histNav` 正文里调 autoSize，故它留在 main.ts）。
 *
 * 状态归属（见 core/state.ts 头注释的「同一份状态不许两边各留一份」）：
 * - 本模块**独占**：pendingImages / pendingFiles / sgList / sgSel / sgKind / slashMenuOn
 *  （原 main.ts 视图闭包里的成员，搬家后只有这里持有；main.ts 一律经本模块 API 读写）。
 * - 外部持有、本模块只读：sentHistory（模块级一份 = 所有会话通用）、slashCmds /
 *   workspaceFiles（宿主回包缓存）、codeCtx / codeOn（页面级数据）。
 * - 转调：notice（第 5 刀才搬）、autoSize（histNav 还要调）、lastNotice 复位。
 *
 * 行为红线：DOM id/class、CSS、消息协议（getSlash / getFiles / attachUri / attachFile /
 * prompt）一律不动；这是纯搬家，逐字核对见 reports/REPORT-t36.md。
 */

export interface ComposerDeps {
  /** 查本视图内的元素（原 makeSessionView 的 q()；ID 各视图重复，必须 scope 到视图） */
  q: (sel: string) => HTMLElement;
  /** 上行消息（原 vpost：显式带本视图 tabId） */
  post: (m: any) => void;
  /** i18n 文案表 */
  lang: Record<string, any>;
  /** 建 DOM 工具（原 el） */
  el: (tag: string, cls: string, text?: string) => HTMLElement;
  /** SVG 图标（原 ico） */
  ico: (name: string, size?: number) => string;
  /** HTML 转义（原 esc） */
  esc: (s: any) => string;
  /** 中段省略（原 shorten） */
  shorten: (s: string, max: number) => string;
  /** 瞬时 toast（仍在消息区第 5 刀，注入回调） */
  notice: (t: string) => void;
  /** ★ 页面级 sentHistory(59)：跨页签一份，注入数组引用，绝不复制 */
  history: string[];
  /** ★ 页面级 codeCtx(1909) */
  getCodeCtx: () => any;
  /** ★ 页面级 codeOn(1909) */
  isCodeOn: () => boolean;
  /** 退出 ↑↓ 回溯（改 main.ts 里 histIdx/histDraft 两个视图成员） */
  resetHist: () => void;
  /** ↑↓ 回溯本体（住 main.ts：正文里调 autoSize 与 sentHistory，搬它没有收益） */
  histNav: (dir: number) => boolean;
  /** 变更页开/合（inputKeydown 的 Esc 分支：先关覆盖层，再考虑中断任务） */
  pages: { hasPage: () => boolean; close: () => void };
  /** ★ 页面级 slashCmds(1939)：宿主 slashList 回包缓存，只读 */
  getSlashCmds: () => any;
  /** ★ 页面级 workspaceFiles(1940)：宿主 fileList 回包缓存，只读 */
  getFiles: () => any;
  /** 清 lastNotice（仍住 main.ts 的视图成员；send 的新回合边界语义） */
  resetNotice: () => void;
}

export interface ComposerApi {
  send: () => void;
  inputKeydown: (e: KeyboardEvent) => void;
  inputPaste: (e: ClipboardEvent) => void;
  normalizeInputWidth: () => void;
  updateSuggest: () => void;
  autoSize: () => void;
  handleFiles: (files: any, dt?: any) => void;
  hideSuggest: () => void;
  applySuggest: (item: any) => void;
  /** 宿主 addImages / addFiles 回包（原 handleMsg 分支，读写本模块的待发附件） */
  addImages: (list: any) => void;
  addFiles: (list: any) => void;
}

export function initComposer(deps: ComposerDeps): ComposerApi {
  var vpost = deps.post;
  var L = deps.lang;
  var el = deps.el;
  var ico = deps.ico;
  var esc = deps.esc;
  var shorten = deps.shorten;
  var notice = deps.notice;
  var sentHistory = deps.history; // 页面级数组引用（不复制）：send 入账 + histNav 读
  var pages = deps.pages;
  var histNav = deps.histNav;

  // 本视图的输入区元素（视图克隆后各一份；查一次，别在事件里反复 querySelector）
  var input = deps.q('#input') as HTMLTextAreaElement;
  var attachbarEl = deps.q('#attachbar');
  var suggestEl = deps.q('#suggest');

  // 待发附件（本模块独占）：图片带 base64 + 尺寸，文件带路径（字节通道的临时文件无路径）
  var pendingImages: any[] = []; var pendingFiles: any[] = [];
  var sgList = []; var sgSel = 0; var sgKind = null;
  // '/' 菜单打开状态：仅在打开瞬间向宿主要一次新列表。updateSuggest 在 slashList
  // 到达时会再次执行，若每次都发 getSlash 就是乒乓死循环（列表不停重渲染把选中项
  // 冲回第一行，方向键永远选不中——2026-09-18 实测）；hideSuggest 时复位，下次打开再拉新
  var slashMenuOn = false;
  // 附件无感去重（重复拖入/粘贴直接跳过，不提示不报错）。图片按 base64 内容判重——
  // 同名不同图不误伤、同图不同名也能拦住；文件按归一化绝对路径判重（Windows 大小写/
  // 分隔符不敏感）。字节通道文件（OS 拖入拿不到路径）宿主每次落盘都生成新临时名
  // pi-attach-<时间戳>，路径判重对它永远失效（同一文件拖三次进来三份的事故）——
  // 这类一次性临时条目改信原始文件名判重；真路径条目只比路径，同名不同目录不误伤
  function normPath(p) { return String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }
  function isTmpAttach(pathStr) { var b = String(pathStr).split(/[\\/]/).pop() || ''; return b.indexOf('pi-attach-') === 0; }
  function hasImg(data) { for (var i = 0; i < pendingImages.length; i++) { if (pendingImages[i].data === data) return true; } return false; }
  function hasFile(pathStr, name) {
    if (!pathStr && !name) return false;
    var k = pathStr ? normPath(pathStr) : '';
    for (var i = 0; i < pendingFiles.length; i++) {
      var e = pendingFiles[i];
      if (k && e.path && normPath(e.path) === k) return true;
      // 一方是字节通道临时文件时路径无意义，退回按原始文件名判重
      if (name && e.name === name && ((!e.path && !pathStr) || isTmpAttach(e.path) || isTmpAttach(pathStr))) return true;
    }
    return false;
  }
  function handleFiles(files, dt) {
    var textDone = false;
    var fileCount = 0;
    // VS Code 资源管理器拖入：File 对象无 MIME 无 path，但 dataTransfer 带资源 URI
    var uris = null;
    if (dt) {
      var raw = dt.getData('resourceurls') || dt.getData('text/uri-list') || '';
      var list = String(raw || '').split(/\s+/).filter(function (u) { return /^file:/i.test(u); });
      if (list.length) uris = list;
    }
    // 资源管理器拖入的部分 VS Code 版本 dataTransfer.files 为空、只带 text/uri-list——
    // 循环体一行不进，attachUri 永远发不出去，drop 又被 preventDefault 吞掉：体感
    // 「拖进输入框没反应」（2026-10 用户实测）。无 File 对象也照走 URI 通道
    if (uris && (!files || !files.length)) { vpost({ type: 'attachUri', uris: uris }); return; }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      // 图片判定：f.type 不可靠——从 VS Code 资源管理器拖入的 File 没有 MIME（type 为空），
      // 只看 type 会把图片误判成普通文件；用扩展名兑底
      var isImg = f.type.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '');
      if (!isImg) {
        // 数量不设限（用户裁决 2026-09-11「不限制」；路径模式只传字符串，个数不影响开销）
        // 路径模式：只传路径，不读内容，不限大小。三级兑底：
        // ① Electron 暴露的 f.path（部分版本 OS 拖入可用）
        var p = (f as any).path;
        if (p) {
          (function(file, filePath) {
            if (hasFile(filePath, file.name)) return; // 重复拖入同一文件：无感跳过
            pendingFiles.push({ name: file.name || 'file', path: filePath });
            renderAttach();
          })(f, p);
          continue;
        }
        // ② 资源 URI（VS Code 资源管理器拖入）→ 宿主转 fsPath 后回发 addFiles
        if (uris && uris.length) {
          vpost({ type: 'attachUri', uris: uris });
          uris = null; // 一拖多文件只发一次，URI 已覆盖整个 drop
          continue;
        }
        // ③ 字节通道：OS 拖入拿不到任何路径 → 读 base64 交宿主落临时文件（20MB 上限防 webview 卡死）
        if (f.size > 20 * 1024 * 1024) { notice(L.attachTooBig + (f.name || '')); continue; }
        (function(file) {
          var r = new FileReader();
          r.onload = function() {
            var data = String(r.result || '').split(',')[1] || '';
            if (!data) { notice('ⓐ ' + L.dragNoPath); return; }
            vpost({ type: 'attachFile', name: file.name || 'file', data: data });
          };
          r.readAsDataURL(file);
        })(f);
        continue;
      }
      // 图片数量同样不设限（同上裁决）
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
            if (hasImg(data)) return; // 重复图片：无感跳过
            pendingImages.push({ data: data, mimeType: file.type || 'image/png', name: file.name || 'image.png', w: probe.naturalWidth, h: probe.naturalHeight });
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
        var name = p.name + (p.w ? ' ' + p.w + '\u00d7' + p.h : '');
        chip.title = name;
        chip.appendChild(img);
        // JS 截短（保头保尾）+ .chip-label 兑底 ellipsis；全名看 title
        chip.appendChild(el('span', 'chip-label', shorten(name, 22)));
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
        // JS 截短文件名；路径提示也走 .chip-label（可收缩），别把 × 挤出可视区
        chip.innerHTML = ico('filecode', 12) + ' <span class="chip-label">' + esc(shorten(p.name, 18)) + '</span>';
        if (p.path) {
          chip.title = p.path;
          var base = p.path.split(/[\\/]/).pop() || p.path;
          var pathHint = el('span', 'chip-label hint', ' · ' + esc(shorten(base, 16)));
          chip.appendChild(pathHint);
        }
        var x = el('span', 'chip-x', '\u00d7');
        x.addEventListener('click', function() { pendingFiles.splice(idx, 1); renderAttach(); });
        chip.appendChild(x);
        attachbarEl.appendChild(chip);
      })(j);
    }
    attachbarEl.style.display = (pendingImages.length + pendingFiles.length) ? 'flex' : 'none';
  }
  function hideSuggest() { suggestEl.style.display = 'none'; slashMenuOn = false; }
  function updateSuggest() {
    var t = input.value;
    var m = t.match(/(^|\s)([\/@])([^\s]*)$/);
    if (!m) { hideSuggest(); return; }
    var trigger = m[2], q = m[3];
    if (trigger === '/') {
      sgKind = 'slash';
      // 每次打开菜单都向宿主要新列表（缓存先渲染，新列表到了再刷新）：包变更自动检测
      // 挂在宿主的 getSlash 处理里，若只在 slashCmds===null 时请求，getSlash 一辈子只发
      // 一次，新装/卸载的技能永远进不了菜单（2026-09-18 实测：卸载后 probe 仍显示）
      if (!slashMenuOn) { slashMenuOn = true; vpost({ type: 'getSlash' }); }
      var slashCmds = deps.getSlashCmds(); // ★ 页面级缓存只读注入（原闭包裸读，第 4 刀走 deps）
      if (slashCmds === null) { hideSuggest(); return; }
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
      var workspaceFiles = deps.getFiles(); // ★ 页面级缓存只读注入（同上）
      if (workspaceFiles === null) { vpost({ type: 'getFiles' }); hideSuggest(); return; }
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
    if (item.builtin) { input.value = input.value.replace(/(^|\s)[\/@][^\s]*$/, '$1'); hideSuggest(); vpost({ type: item.builtin }); return; }
    var t = input.value;
    var m = t.match(/(^|\s)([\/@])([^\s]*)$/);
    var label = sgKind === 'slash' ? ('/' + item.name) : (m && m[2] === '@' ? '@' : '') + item.rel;
    if (m) t = t.slice(0, t.length - m[0].length) + m[1] + label + ' ';
    input.value = t;
    hideSuggest();
    input.focus();
  }
  function send() {
    var t = toHalfWidth(input.value).trim(); // 兜底再归一：组字中途 Enter 上屏的全角也不许按全角发给 pi
    if (!t && !pendingImages.length && !pendingFiles.length) return;
    var imgs = pendingImages.map(function(p) { return { data: p.data, mimeType: p.mimeType }; });
    var fs2 = pendingFiles.map(function(p) { return { name: p.name, text: p.text || undefined, path: p.path || undefined }; });
    var attachCode = deps.getCodeCtx() && deps.isCodeOn(); // ★ 页面级 codeCtx/codeOn 只读注入
    // 输入历史入账（所有会话通用，含排队）：只记文字，连续重复不入账
    if (t && sentHistory[sentHistory.length - 1] !== t) { sentHistory.push(t); if (sentHistory.length > 200) sentHistory.shift(); }
    deps.resetHist(); // 回溯复位：下次 ↑ 从最新一条重新开始（histIdx/histDraft 住 main.ts）
    input.value = '';
    autoSize();
    pendingImages = []; pendingFiles = []; renderAttach();
    deps.resetNotice(); // 新回合开始：瞬时反馈（含压缩完成）不再跨回合存活，与 pi TUI 状态行语义一致
    vpost({ type: 'prompt', text: t || (imgs.length ? L.seeImage : (fs2.length ? L.seeFiles : (attachCode ? L.seeCode : ''))), images: imgs, files: fs2, attachCode: !!attachCode });
  }
  // 自适应高度：随内容增长，到 220px 上限后改为内部滚动（消息区不会被挤没）
  function autoSize() {
    input.style.height = 'auto';
    var over = input.scrollHeight > 220;
    input.style.overflowY = over ? 'auto' : 'hidden';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }
  function inputKeydown(e: KeyboardEvent) {
    var sgOpen = suggestEl.style.display === 'block';
    if (sgOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); nextSel(1); paintSuggest(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); nextSel(-1); paintSuggest(); return; }
      if (e.key === 'Tab') { e.preventDefault(); var r1 = sgList[sgSel]; if (r1) applySuggest(r1.item); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        // V 刀（2026-09-23 用户报「启动中发消息被挡」，日志零留痕=消息死在 webview 端）：
        // 原行为：联想框开着就一律 return——空列表/未选中也吞，消息无声消失。
        // 现行为：有选中项才应用建议；否则收起联想框、落回下方正常发送
        var r0 = sgList[sgSel];
        if (r0) { e.preventDefault(); applySuggest(r0.item); return; }
        hideSuggest();
      }
      if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }
    }
    // ↑↓ 回溯输入历史：↑ 在首行 / ↓ 在末行时接管（多行中间的光标移动不受影响）；修饰键按下不抢
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && input.selectionStart === input.selectionEnd) {
      var dir = e.key === 'ArrowUp' ? -1 : 1;
      var edgeOk = dir < 0
        ? input.value.slice(0, input.selectionStart).indexOf('\n') < 0   // 光标在首行
        : input.value.slice(input.selectionEnd).indexOf('\n') < 0;       // 光标在末行
      if (edgeOk && histNav(dir)) { e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && !sgOpen && !e.isComposing) {
      // 变更页开着时 Esc 先关页（它是覆盖层，底下会话还在）——不关就直接断任务会误伤
      if (pages.hasPage()) pages.close();
      else vpost({ type: 'abort' });
    }
    // isComposing 守门：中文输入法取消候选词也是 Esc，不拦的话打字打到一半就把运行中的任务中断了
    // （2026-09-18 事故：用户没点停止却见“已中断当前任务”）
  }
  // ── 全角 ASCII 归一 ──
  // 2026-11-03 用户报：输入法切全角时，输入框里的英文成了「ｓ ｓ ｓ」——字形窄、字宽占满一个汉字位，
  // 视觉上像每个字母之间空了一大格。这不是插件样式的锅（#input 没有 letter-spacing），是全角字符本身。
  // 射程只有「全角数字/字母 + 表意空格」：！？（），；： 这些**不转**——全角标点和全角英数是输入法里
  // 两个独立开关（微软拼音 Ctrl+. 切标点），中文句子里的「你好，世界」是用户真要写的中文标点，
  // 一并转成半角就是篡改正文；而 . 、句号。这些本来就没全角形态问题。映射 1 字符对 1 字符，
  // 长度不变，故光标/选区偏移原样可用。
  function toHalfWidth(s: string): string {
    return s.replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A\u3000]/g, function (c) {
      return c === '\u3000' ? ' ' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
  }
  // 就地归一：只在真有全角字符时才写 value。直接赋 value 会清掉 textarea 的 undo 栈
  // （浏览器不给程序化写值留历史），所以代价只落在「真的打了全角」的那几次按键上；
  // 半角态打字根本不进这里，Ctrl+Z 行为不受影响。
  function normalizeInputWidth() {
    var v = input.value;
    var half = toHalfWidth(v);
    if (half === v) return;
    var selS = input.selectionStart, selE = input.selectionEnd;
    input.value = half;
    try { input.setSelectionRange(selS, selE); } catch (e) { /* 选区越界忽略 */ }
  }
  function filesFromClipboard(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') { var f = items[i].getAsFile(); if (f) out.push(f); }
    }
    return out;
  }
  function inputPaste(e: ClipboardEvent) {
    var files = filesFromClipboard((e.clipboardData || {}).items || []);
    if (files.length) { e.preventDefault(); handleFiles(files, null); }
  }
  /** 宿主转发图片（复制图片等入口）：逐张预检尺寸 + 去重后入待发区，最多 4 张。
   *  原住 handleMsg 的 addImages 分支内嵌 IIFE，第 4 刀随输入区搬来（逻辑逐字未动）。 */
  function addImages(images: any) {
    var list = images || []; var k = 0;
    function nextAdi() {
      if (k >= list.length || pendingImages.length >= 4) { renderAttach(); return; }
      var p = list[k++]; if (!p.mimeType) p.mimeType = 'image/png';
      var probe = new Image();
      probe.onload = function() {
        if (probe.naturalWidth < 16 || probe.naturalHeight < 16) { notice('ⓐ ' + L.imgTooSmall2.replace('{w}', probe.naturalWidth).replace('{h}', probe.naturalHeight).replace('{v}', p.name || '')); nextAdi(); return; }
        p.w = probe.naturalWidth; p.h = probe.naturalHeight;
        if (!hasImg(p.data)) pendingImages.push(p); // 宿主转发同样去重（复制图片等入口）
        nextAdi();
      };
      probe.onerror = function() { notice('ⓐ ' + L.imgReadFail + (p.name || '')); nextAdi(); };
      probe.src = 'data:' + p.mimeType + ';base64,' + p.data;
    }
    nextAdi();
  }
  /** 宿主转发的文件清单（资源 URI 拖入的 addFiles 回包）：去重后入待发区。 */
  function addFiles(files: any) {
    pendingFiles = pendingFiles.concat((files || []).filter(function (f: any) { return !hasFile(f.path, f.name); }));
    renderAttach();
  }

  return {
    send: send, inputKeydown: inputKeydown, inputPaste: inputPaste,
    normalizeInputWidth: normalizeInputWidth, updateSuggest: updateSuggest, autoSize: autoSize,
    handleFiles: handleFiles, hideSuggest: hideSuggest, applySuggest: applySuggest,
    addImages: addImages, addFiles: addFiles
  };
}
