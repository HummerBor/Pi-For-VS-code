/**
 * 输入区（2026-11-23 第 4 刀，从 webview/main.ts 整块拆出）：附件 token 与镜像胶囊 /
 * `/` `@` 联想菜单 / 发送链 / 键位 / 高度自适应 / 全角归一 / 粘贴图片。
 *
 * 为什么是 initComposer(deps)：本模块是**每页签一套**的视图成员（每页签各有一个 #input /
 * #inputmirror / #suggest）。入口在 makeSessionView 里调一次，元素经 deps.q 查（**禁止**
 * document.getElementById——ID 在每个 .session-view 内重复，见 main.ts 的 q 注释）。
 *
 * ★ 附件模型（2026-11-19 用户裁决「pi 能在文字里随处添加，插件也要」）：
 *   附件不再是输入框上方的附件条，而是**正文里的一个 token**，插在光标位置、能塞进句子中间、
 *   删字符就删掉。textarea 装不了 DOM 胶囊，所以走「镜像层」：
 *     #input        纯文本，字由它显示 —— 光标/输入法/撤销栈/回溯全是原生行为，一项没改
 *     #inputmirror  同一段文字再画一遍，只上色不显字（color:transparent），token 区间套圆角底色
 *   两层同字体同宽度同换行 → 天然对齐。发送时才还原：文件 token → 绝对路径写回正文（模型看到的
 *   就是 pi TUI 那种路径，见 pi 的 interactive-mode.js handleClipboardPaste）；图片 token → 剥掉，
 *   仍走 images[] base64 视觉通道（比让模型自己 read 临时文件更直接，是插件比 TUI 多出来的能力）。
 *
 * ★ 红线一（事故级）：本模块**不许**给 `#input` / `#send` 绑 `bindComposerOnce` 已经绑过的
 *   事件（click/keydown/paste/input/compositionend）——两边各绑一次 → 一次点击发**两条** prompt。
 *   例外只有镜像层专用的三类：scroll / mousemove / mouseleave（只重画胶囊与 hover 预览，
 *   不进发送链，bindComposerOnce 也没绑过，见 initComposer 末尾的三条 addEventListener）。
 *   发送相关键位仍全在 inputKeydown 里，由 bindComposerOnce 统一绑定。
 * ★ 红线二：页面级共享变量一律**注入不复制**（sentHistory / slashCmds / workspaceFiles /
 *   codeCtx+codeOn）——复制成 per-view 副本 = 行为变更（每页签一份输入历史 / 各自拉一次 getSlash）。
 * ★ 红线三：`histIdx`/`histDraft` 住在 main.ts：`bindComposerOnce` 正文里有 `histIdx = -1;
 *   histDraft = '';` 两行裸赋值，把它们搬走就得改那个函数（「发送命脉」）的正文——本刀不碰。
 *   这里只经 deps.resetHist / deps.histNav 转调（`histNav` 正文里调 autoSize，故它留在 main.ts）。
 *
 * 状态归属（见 core/state.ts 头注释的「同一份状态不许两边各留一份」）：
 * - 本模块**独占**：attaches（token 登记表）/ imgSeq / lastRanges / previewEl /
 *   sgList / sgSel / sgKind / slashMenuOn
 *  （原 main.ts 视图闭包里的成员，搬家后只有这里持有；main.ts 一律经本模块 API 读写）。
 * - 外部持有、本模块只读：sentHistory（模块级一份 = 所有会话通用）、slashCmds /
 *   workspaceFiles（宿主回包缓存）、codeCtx / codeOn（页面级数据）。
 * - 转调：notice（第 5 刀才搬）、autoSize（histNav 还要调）、lastNotice 复位。
 *
 * 行为红线：DOM id/class、CSS、消息协议（getSlash / getFiles / attachUri / attachFile /
 * prompt）一律不动；本刀只改附件的展示与组包方式（附件条 → 正文 token + 镜像胶囊），
 * 宿主侧 prompt 不再收 files。
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
  /** 中段省略（main.ts 的 shorten：保头保尾，扩展名不会被吃掉）——图片 token 用文件名。 */
  shorten: (s: string, max: number) => string;
  /** HTML 转义（原 esc）。镜像层要把正文原样重画，转义是必需品 */
  esc: (s: any) => string;
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
  /** ★ 同上：工作区根绝对路径（@ 选中文件拼绝对路径用） */
  getFilesRoot: () => string;
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
  /** 宿主 addImages / addFiles 回包（原 handleMsg 分支，往正文里插 token） */
  addImages: (list: any) => void;
  addFiles: (list: any) => void;
  /** 程序化改 #input.value 后重画镜像层胶囊（不调就是「字变了、胶囊没跟」） */
  syncMirror: () => void;
  /** 视图销毁：断开镜像层的 ResizeObserver */
  dispose: () => void;
}

export function initComposer(deps: ComposerDeps): ComposerApi {
  var vpost = deps.post;
  var L = deps.lang;
  var el = deps.el;
  var shorten = deps.shorten;
  var esc = deps.esc;
  var notice = deps.notice;
  var sentHistory = deps.history; // 页面级数组引用（不复制）：send 入账 + histNav 读
  var pages = deps.pages;
  var histNav = deps.histNav;

  // 本视图的输入区元素（视图克隆后各一份；查一次，别在事件里反复 querySelector）
  var input = deps.q('#input') as HTMLTextAreaElement;
  var mirrorEl = deps.q('#inputmirror');
  var mirrorIn = deps.q('#inputmirror > div');
  var suggestEl = deps.q('#suggest');

  // 待发附件登记表（本模块独占）：正文里的 token ↔ 真实附件。
  // 文件带 path（发送时写回正文，模型看到的就是路径）；图片带 base64 + 尺寸（发送时进 images[]）。
  var attaches: any[] = [];
  var imgSeq = 0;   // 图片 token 编号：只增不减，删掉的编号不复用（避免两个 token 同号）
  var lastRanges: any[] = []; // 最近一次镜像渲染的 token 区间（hover 命中判定用）
  // hover 预览浮层：镜像层 pointer-events:none（否则挡住 textarea 输入），指针事件全在
  // textarea 上，见 onInputHover。挂 #composer 里，视图销毁时跟着走。
  var previewEl = document.createElement('div');
  previewEl.className = 'ap-preview';
  deps.q('#composer').appendChild(previewEl);
  var sgList = []; var sgSel = 0; var sgKind = null;
  // '/' 菜单打开状态：仅在打开瞬间向宿主要一次新列表。updateSuggest 在 slashList
  // 到达时会再次执行，若每次都发 getSlash 就是乒乓死循环（列表不停重渲染把选中项
  // 冲回第一行，方向键永远选不中——2026-09-18 实测）；hideSuggest 时复位，下次打开再拉新
  var slashMenuOn = false;
  // ── token 区间 / 镜像渲染 ──
  // 正文里每个 token 的出现位置。同一 token 出现多次（同名不同目录的两份文件）时按登记顺序
  // 依次认领：第 1 次出现 → 第 1 份、第 2 次 → 第 2 份，所以不用给文件名加 (2) 后缀也不串号。
  // 重叠（`@a.png` 与 `@a.png.bak` 并存）时保留更长的那个：先认领已覆盖的区间一律跳过。
  function tokenRanges() {
    var text = input.value;
    var byTok: Record<string, any[]> = {};
    for (var i = 0; i < attaches.length; i++) {
      var tk = attaches[i].token;
      if (!tk || text.indexOf(tk) === -1) continue;
      (byTok[tk] || (byTok[tk] = [])).push(attaches[i]);
    }
    var hits: any[] = [];
    for (var tok in byTok) {
      var owners = byTok[tok];
      var from = 0, idx, n = 0;
      while ((idx = text.indexOf(tok, from)) !== -1) {
        hits.push({ start: idx, end: idx + tok.length, a: owners[Math.min(n, owners.length - 1)] });
        from = idx + tok.length; n++;
      }
    }
    hits.sort(function(x, y) { return x.start - y.start || (y.end - y.start) - (x.end - x.start); });
    var out: any[] = []; var last = -1;
    for (var j = 0; j < hits.length; j++) { if (hits[j].start >= last) { out.push(hits[j]); last = hits[j].end; } }
    return out;
  }
  // 重画镜像层。文字照抄 textarea 的 value（含换行），token 区间包一层 .ap-pill；
  // 文字本身 color:transparent，只有胶囊底色可见 —— textarea 自己的字浮在底色上。
  // 尺寸/滚动必须逐帧对齐：出现内部滚动条时 clientWidth 变小，镜像跟着窄，否则错行。
  function syncMirror() {
    var text = input.value;
    var ranges = tokenRanges();
    lastRanges = ranges;
    var html = '', pos = 0;
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      html += esc(text.slice(pos, r.start));
      html += '<span class="ap-pill' + (r.a.kind === 'image' ? ' ap-img' : '') + '">' + esc(text.slice(r.start, r.end)) + '</span>';
      pos = r.end;
    }
    html += esc(text.slice(pos));
    mirrorIn.innerHTML = html || '&#8203;'; // 空文本也要有行盒，否则高度塌成 0
    // 视图隐藏时（非活动页签 display:none）量出来是 0，写进去就等于把镜像搞碎，直接跳过，
    // 等 ResizeObserver 在重新可见时再算
    if (!input.clientWidth) return;
    mirrorEl.style.width = input.clientWidth + 'px';
    mirrorEl.style.height = input.offsetHeight + 'px';
    mirrorIn.style.transform = 'translateY(' + (-input.scrollTop) + 'px)';
  }
  function hasImg(data) { for (var i = 0; i < attaches.length; i++) { if (attaches[i].kind === 'image' && attaches[i].data === data) return true; } return false; }
  // ── token 插入 ──
  // 光标处插入（setRangeText 保留 textarea 原生撤销栈）。程序化写入不触发 input 事件，
  // 所以高度与镜像要手动补 —— autoSize 末尾会调 syncMirror。
  // 空格规则对齐 pi TUI（interactive-mode.js handleClipboardPaste）：紧贴非空白就补空格，
  // 否则 token 会和前后文字粘连；末尾补尾随空格是因为 token 以 @ 开头时，紧跟其后打字会被
  // `@` 联想菜单当成提及（updateSuggest 的正则只认行尾的 @ 片段）。
  // 光标/选区端点落在某个 token 内部时吸到最近的边上。
  // 为什么必须有：胶囊只是普通文字，点一下或按方向键光标就能停在 token 中间，此时任何插入
  // 都会把它劈开（用户实测 2026-11-19：`[图片1]` 中插附件 → `[图 @rules.md 片1]`，老 token
  // 不再匹配、胶囊碎掉、图片也跟着丢）。token 一律当整体对待，跟胶囊的语义一致。
  function snapEdge(p: number): number {
    for (var i = 0; i < lastRanges.length; i++) {
      var r = lastRanges[i];
      if (p > r.start && p < r.end) return (p - r.start) * 2 < (r.end - r.start) ? r.start : r.end;
    }
    return p;
  }
  // 点在胶囊里 / ↑↓HomeEnd 走进胶囊 → 把折叠的光标吸到最近的边（选区不折叠时不动，
  // 用户要的就是选中一段）。
  // ★ 只管上下与行首尾：左右方向键走「方向感知」的跨域逻辑（inputKeydown 里 skipToken），
  // 不能靠这里——靠「吸到最近的边」会让从左侧按 → 的光标又被推回左侧，同一位置死循环，
  // 永远跨不过去（2026-11-19 用户实测「按左右方向键跨不过去」）
  function snapCaretOutOfToken() {
    if (input.selectionStart !== input.selectionEnd) return;
    var c = input.selectionStart;
    var s = snapEdge(c);
    if (s !== c) input.setSelectionRange(s, s);
  }
  // 左右方向键把胶囊当整体跨过去：贴在 token 左侧按 → 直接跳到另一端，贴右侧按 ← 跳回来。
  // 不这么做光标会停在 token 内部（胶囊只是普通文字），下一次打字就把胶囊劈了
  function skipToken(dir: number): boolean {
    if (input.selectionStart !== input.selectionEnd) return false;
    var c = input.selectionStart;
    for (var i = 0; i < lastRanges.length; i++) {
      var r = lastRanges[i];
      // 区间写宽一点：贴在边上、或已经被 Ctrl+→ 这种默认行为弄到里面了，一律按方向跳出去
      if (dir > 0 && c >= r.start && c < r.end) { input.setSelectionRange(r.end, r.end); return true; }
      if (dir < 0 && c > r.start && c <= r.end) { input.setSelectionRange(r.start, r.start); return true; }
    }
    return false;
  }
  function insertToken(tok: string) {
    var ss = snapEdge(input.selectionStart), se = snapEdge(input.selectionEnd), v = input.value;
    var before = ss > 0 ? v.charAt(ss - 1) : '';
    var after = se < v.length ? v.charAt(se) : '';
    var lead = before && !/\s/.test(before) ? ' ' : '';
    var trail = after ? (/\s/.test(after) ? '' : ' ') : ' ';
    input.setRangeText(lead + tok + trail, ss, se, 'end');
    deps.resetHist(); // 插附件=继续编辑本次输入：退出 ↑↓ 回溯
    input.focus();
    autoSize();
  }
  function focusToken(tok: string) {
    var i = input.value.indexOf(tok);
    input.focus();
    if (i >= 0) { var e = i + tok.length; input.setSelectionRange(e, e); }
  }
  /** 文件 → 光标处插 `@文件名` token，登记绝对路径。同一路径已登记过就只挪光标，不插第二份
   *  （对应旧版的「无感去重」；同名不同路径另算一份，靠 tokenRanges 的顺序认领区分）。 */
  function attachPath(pathStr: string, name: string) {
    var base = String(name || pathStr || 'file').split(/[\\/]/).pop() || 'file';
    var tok = '@' + base;
    for (var i = 0; i < attaches.length; i++) {
      if (attaches[i].kind !== 'file' || attaches[i].path !== pathStr) continue;
      // 同一路径已在正文里：只把光标挪过去，不插第二份（旧「无感去重」语义）。
      // token 已被删掉的条目不兑（否则丢了一个就再也插不回来），直接替换掉这条登记
      if (input.value.indexOf(attaches[i].token) !== -1) { focusToken(attaches[i].token); return; }
      attaches.splice(i, 1);
      break;
    }
    attaches.push({ token: tok, kind: 'file', path: pathStr, name: base });
    insertToken(tok);
  }
  /** 图片 → 光标处插一个 token，登记 base64。发送时图片按出现顺序进 images[]。
   *  token 优先用图片**文件名**（用户看得懂，比 `[图片1]` 有信息量）；名字太长中段省略，
   *  没像样名字的（剪贴板里的 image.png / blob / clipboard-1）退回 i18n 的 `[图片N]`。
   *  重名必须消歧（补 #N）：两枚同文 token 会被 tokenRanges 当成同一份，图会错位。 */
  function pushImage(p: any) {
    if (hasImg(p.data)) return; // 同一张图重复粘/拖：无感跳过
    var nm = String(p.name || '').replace(/[\[\]]/g, '');
    var generic = !nm || /^(image|blob|clipboard|paste)([-_. ]?\d+)?(\.\w+)?$/i.test(nm);
    var tok: string;
    if (generic) { imgSeq++; tok = String(L.imgToken || '[图片{n}]').replace('{n}', String(imgSeq)); }
    else tok = '[' + shorten(nm, 24) + ']';
    var base = tok, dup = 1;
    while (hasToken(tok)) { dup++; tok = base.replace(/\]$/, '') + '#' + dup + ']'; }
    attaches.push({ token: tok, kind: 'image', name: nm || 'image', data: p.data, mimeType: p.mimeType || 'image/png', w: p.w, h: p.h });
    insertToken(tok);
  }
  function hasToken(t: string): boolean { for (var i = 0; i < attaches.length; i++) { if (attaches[i].token === t) return true; } return false; }
  function handleFiles(files, dt) {
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
        if (p) { attachPath(p, f.name); continue; }
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
            pushImage({ data: data, mimeType: file.type || 'image/png', name: file.name || 'image.png', w: probe.naturalWidth, h: probe.naturalHeight });
          };
          probe.src = url;
        };
        r.readAsDataURL(file);
      })(f);
    }
  }
  // ── hover 预览（补回失去的附件条信息：图片缩略图 / 文件全路径）──
  // 镜像层 pointer-events:none（否则抢掉 textarea 的点击与光标定位），所以命中判定只能
  // 在 textarea 的 mousemove 里自己算：遍历镜像层的胶囊矩形，落在哪个上面就预览哪个。
  function hidePreview() { previewEl.style.display = 'none'; }
  function showPreview(a: any, rc: DOMRect) {
    previewEl.innerHTML = '';
    if (a.kind === 'image') {
      var im = document.createElement('img');
      im.src = 'data:' + a.mimeType + ';base64,' + a.data;
      previewEl.appendChild(im);
      previewEl.appendChild(el('div', 'ap-path', a.name + (a.w ? ' ' + a.w + '\u00d7' + a.h : '')));
    } else {
      previewEl.appendChild(el('div', 'ap-path', String(a.path || a.name)));
    }
    previewEl.style.display = 'block';
    // 固定定位（视口坐标）：胶囊在输入框内，浮层只在它上方/下方，无需跟 input 一起滚动
    var w = previewEl.offsetWidth, h = previewEl.offsetHeight;
    var left = Math.max(8, Math.min(rc.left, window.innerWidth - w - 8));
    var top = rc.top - h - 6;
    if (top < 8) top = rc.bottom + 6;
    previewEl.style.left = left + 'px';
    previewEl.style.top = top + 'px';
  }
  function onInputHover(e: MouseEvent) {
    var kids = mirrorIn.children; var hit: any = null; var k = 0;
    for (var i = 0; i < kids.length; i++) {
      var ne = kids[i] as HTMLElement;
      if (ne.className.indexOf('ap-pill') < 0) continue;
      var rc = ne.getBoundingClientRect();
      var r = lastRanges[k++];
      if (r && e.clientX >= rc.left - 2 && e.clientX <= rc.right + 2 && e.clientY >= rc.top && e.clientY <= rc.bottom) { hit = { rc: rc, a: r.a }; break; }
    }
    if (!hit) { hidePreview(); return; }
    showPreview(hit.a, hit.rc);
  }
  // 只绑镜像层专用的三类事件（均不在 bindComposerOnce 的绑定集里，不进发送链，见红线一注释）：
  // scroll → 镜像跟着滚；mousemove/mouseleave → hover 预览；尺寸变化 → 见下面的 ResizeObserver
  input.addEventListener('scroll', syncMirror);
  input.addEventListener('mousemove', onInputHover);
  input.addEventListener('mouseleave', hidePreview);
  // 点进胶囊 / 方向键走进胶囊后把光标吸到边上（防劈开，见 snapCaretOutOfToken）——
  // mouseup/keyup 都不在 bindComposerOnce 的绑定集里，不会重复触发
  input.addEventListener('mouseup', function () { setTimeout(snapCaretOutOfToken, 0); });
  input.addEventListener('keyup', function (e) {
    // 左右键不在此列：它们走 keydown 的方向感知跳过（skipToken），先吸边再跳过会卡死
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') snapCaretOutOfToken();
  });
  // 尺寸变化不能只靠 window.resize：拖侧栏不会改窗口尺寸，页签从 display:none 切回来也不发
  // resize 事件——这两种情况下镜像宽高是陈的，胶囊会跟字错位。观察 wrapper 最靠得住。
  // 观察对象是 wrapper（尺寸由 textarea 高度驱动），syncMirror 只写绝对定位的镜像层，
  // 不回写 wrapper，故不会自激成循环。
  var wrapEl = deps.q('#inputwrap');
  var ro: any = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(function () { syncMirror(); });
    ro.observe(wrapEl);
  }

  function hideSuggest() { suggestEl.style.display = 'none'; slashMenuOn = false; }
  // 当前光标处的 `/` `@` 片段（[start,end) + 正则结果），没有则 null。
  // ★ 只看光标**之前**的一半：原实现是对整个 value 用 `$` 锚点，光标在文本中间时永远不匹配
  // → 中间打 @ 弹不出联想菜单（2026-11-19 用户实测「前面那几个 @ 都调不出弹框」）。
  // 胶囊已经能把附件插在句中，光标自然不会总在末尾。
  function currentFragment() {
    if (input.selectionStart !== input.selectionEnd) return null;
    var caret = input.selectionStart;
    var m = input.value.slice(0, caret).match(/(^|\s)([\/@])([^\s]*)$/);
    return m ? { m: m, start: caret - m[0].length, end: caret } : null;
  }
  function updateSuggest() {
    var fr = currentFragment();
    if (!fr) { hideSuggest(); return; }
    var m = fr.m;
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
    var fr = currentFragment();
    if (item.builtin === 'mentionFile') {
      // 重新拉文件菜单：把光标处的片段换成单个 `@`（没有片段就插在光标处）
      if (fr) input.setRangeText(fr.m[1] + '@', fr.start, fr.end, 'end'); else input.setRangeText('@', input.selectionStart, input.selectionEnd, 'end');
      hideSuggest(); input.focus(); updateSuggest(); syncMirror(); return;
    }
    if (item.builtin) {
      if (fr) input.setRangeText(fr.m[1], fr.start, fr.end, 'end');
      hideSuggest(); syncMirror(); vpost({ type: item.builtin }); return;
    }
    if (sgKind === 'files') {
      // @ 选中的工作区文件 → 当**真附件**插（胶囊 + 发送时换成绝对路径），不再写一段
      // `@相对路径` 纯文本：用户直接比较的就是「@ 选的」和「拖进来的」两种文件，两种长得
      // 不一样就是同一件事两个样子（2026-11-19 用户实测）。根目录没拿到时退回纯文本。
      var root = String(deps.getFilesRoot() || '').replace(/[\\/]+$/, '');
      var rel = String(item.rel || '');
      if (root && rel) {
        var abs = root + '/' + rel;
        var base = rel.replace(/\/+$/, '').split('/').pop() || rel;
        if (fr) input.setRangeText(fr.m[1], fr.start, fr.end, 'end'); // 先清掉打的 @片段
        hideSuggest();
        attachPath(abs, base);
        return;
      }
    }
    var label = sgKind === 'slash' ? ('/' + item.name) : ('@' + item.rel);
    if (fr) input.setRangeText(fr.m[1] + label + ' ', fr.start, fr.end, 'end');
    hideSuggest();
    input.focus();
    syncMirror(); // 程序化写 value 不触发 input 事件，镜像得手动重画
  }
  // 发送：token 到这刻才还原，一次产出两个版本：
  //   text    → 发给模型：文件 token 换成**绝对路径**（跟 pi TUI 夹在句子里一样）；图片 token
  //             留着（模型会同时收到 image 块，句子里留个 `[图片N]` 等于标出「图插在这」）
  //   display → 给用户看（气泡/排队条/自动命名）：文件保留 `@文件名`，图片 token 也保留——
  //             气泡渲染时同一位置换成内联缩略图（见 messageList.renderUserText）
  // 两边都保留图片 token 还有一个硬理由：会话 jsonl 存的是 text，重开时气泡要从它重建，
  // 剔掉就重建不出来，会出现「刚发时图在句中、重开跑到泡底」的不一致。
  function resolveTokens(t: string) {
    var ranges = tokenRanges();
    var out = '', disp = '', pos = 0, imgs: any[] = [];
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      out += t.slice(pos, r.start);
      disp += t.slice(pos, r.start);
      if (r.a.kind === 'file') { out += r.a.path || ''; disp += t.slice(r.start, r.end); }
      else { out += t.slice(r.start, r.end); disp += t.slice(r.start, r.end); imgs.push({ data: r.a.data, mimeType: r.a.mimeType }); }
      pos = r.end;
    }
    out += t.slice(pos);
    disp += t.slice(pos);
    return { text: out, display: disp, images: imgs };
  }
  /** 本次草稿里还有哪些文件附件在正文里（气泡靠它把 `@名字` 画成胶囊，而不是靠猜） */
  function attachNames(): string[] {
    var out: string[] = [];
    for (var i = 0; i < lastRanges.length; i++) {
      var a = lastRanges[i].a;
      if (a && a.kind === 'file' && out.indexOf(a.name) < 0) out.push(a.name);
    }
    return out;
  }
  function send() {
    // ★ 顺序不能换：先归一（toHalfWidth 是 1 字符对 1 字符，长度不变，token 下标照旧可用）
    // 再认 token；先 trim 会让所有区间整体错位。兜底归一理由同前（组字中途 Enter 上屏的全角）
    var raw = toHalfWidth(input.value);
    var res = resolveTokens(raw);
    var t = res.text.trim();
    var shown = res.display.trim();
    var imgs = res.images;
    if (!t && !imgs.length) return;
    var names = attachNames(); // ★ 必须在清空登记表之前取（下面 attaches/lastRanges 都要清）
    var attachCode = deps.getCodeCtx() && deps.isCodeOn(); // ★ 页面级 codeCtx/codeOn 只读注入
    // 输入历史入账记**显示形态**（带 `@文件名`、不带图片 token）：回溯取回时它只是普通文字，
    // 附件不跟着回来（登记表已清）——已知取舍，总比把 base64 / 临时路径塞进历史好。
    if (shown && sentHistory[sentHistory.length - 1] !== shown) { sentHistory.push(shown); if (sentHistory.length > 200) sentHistory.shift(); }
    deps.resetHist(); // 回溯复位：下次 ↑ 从最新一条重新开始（histIdx/histDraft 住 main.ts）
    input.value = '';
    attaches = []; imgSeq = 0; lastRanges = [];
    hidePreview();
    autoSize();
    deps.resetNotice(); // 新回合开始：瞬时反馈（含压缩完成）不再跨回合存活，与 pi TUI 状态行语义一致
    // files 通道已废：文件附件改成正文里的路径，宿主不再拼「--- 附件 ---」头部块。
    // text = 发给模型的（文件 token 已换成绝对路径）；displayText = 气泡/排队条/会话名用的
    // 原文形态（`@文件名`，图片 token 已剥）——不分开的话气泡里就是一条临时文件路径。
    vpost({ type: 'prompt', text: t || (imgs.length ? L.seeImage : (attachCode ? L.seeCode : '')), displayText: shown, attachNames: names, images: imgs, attachCode: !!attachCode });
  }
  // 自适应高度：随内容增长，到 220px 上限后改为内部滚动（消息区不会被挤没）
  // 末尾必调 syncMirror：高度/内部滚动条一变，镜像的尺寸与换行就得重算（同一帧对齐）
  function autoSize() {
    input.style.height = 'auto';
    var over = input.scrollHeight > 220;
    input.style.overflowY = over ? 'auto' : 'hidden';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
    syncMirror();
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
    // ←→ 把胶囊当整体跨过去（方向感知，见 skipToken）。必须在 ↑↓ 回溯之前：两者都看
    // 修饰键与折叠选区，但键不重叠，顺序只为读起来顺
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (skipToken(e.key === 'ArrowRight' ? 1 : -1)) { e.preventDefault(); return; }
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
    // 胶囊当整体删：光标紧贴 token 尾部退格 / 贴在头部 Delete 时整块去掉。
    // 不这么做就得按 6 次（`[图片1]`），而且删到一半 token 不再匹配 → 胶囊视觉碎裂
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.isComposing && input.selectionStart === input.selectionEnd) {
      var caret = input.selectionStart;
      for (var ri = 0; ri < lastRanges.length; ri++) {
        var rg = lastRanges[ri];
        if ((e.key === 'Backspace' && rg.end === caret) || (e.key === 'Delete' && rg.start === caret)) {
          e.preventDefault();
          input.setRangeText('', rg.start, rg.end, 'end');
          deps.resetHist(); autoSize(); // autoSize 末尾重画镜像
          return;
        }
      }
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
    syncMirror(); // 归一后 token 可能变样（全角 @），镜像跟着重画
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
  /** 宿主转发图片（复制图片 / 上传菜单等入口）：逐张预检尺寸 → 登记成图片 token。
   *  token 只是正文里的位置标记，图片本体仍走 images[] base64 视觉通道（比 pi TUI
   *  让模型自己 read 临时文件更直接）。原住 handleMsg 的 addImages 分支内嵌 IIFE。 */
  function addImages(images: any) {
    var list = images || []; var k = 0;
    function nextAdi() {
      if (k >= list.length) return;
      var p = list[k++]; if (!p.mimeType) p.mimeType = 'image/png';
      var probe = new Image();
      probe.onload = function() {
        if (probe.naturalWidth < 16 || probe.naturalHeight < 16) { notice('ⓐ ' + L.imgTooSmall2.replace('{w}', probe.naturalWidth).replace('{h}', probe.naturalHeight).replace('{v}', p.name || '')); nextAdi(); return; }
        p.w = probe.naturalWidth; p.h = probe.naturalHeight;
        pushImage(p); // 同一张图重复：pushImage 内按 base64 去重（宿主转发同样去重）
        nextAdi();
      };
      probe.onerror = function() { notice('ⓐ ' + L.imgReadFail + (p.name || '')); nextAdi(); };
      probe.src = 'data:' + p.mimeType + ';base64,' + p.data;
    }
    nextAdi();
  }
  /** 宿主转发的文件清单（资源 URI / 字节通道落盘 / 上传菜单 → 收敛成绝对路径）：
   *  直接在光标处插 token，不再进附件条。 */
  function addFiles(files: any) {
    var list = files || [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      // 无路径条目（旧版纯文本通道）随本次改造废弃，宿主已不再产生；跳过而不是内联，
      // 免得正文里出现一大段没有胶囊标识的内容
      if (!f || !f.path) continue;
      attachPath(String(f.path), String(f.name || f.path));
    }
  }

  return {
    send: send, inputKeydown: inputKeydown, inputPaste: inputPaste,
    normalizeInputWidth: normalizeInputWidth, updateSuggest: updateSuggest, autoSize: autoSize,
    handleFiles: handleFiles, hideSuggest: hideSuggest, applySuggest: applySuggest,
    addImages: addImages, addFiles: addFiles,
    /** 程序化改 value 后手动重画镜像（fillInput / 取回排队 / 回溯等宿主与视图侧调用点） */
    syncMirror: syncMirror,
    /** 视图销毁时收尾：ResizeObserver 不断开则被观察的节点连同监听一起留活 */
    dispose: function () { if (ro) ro.disconnect(); hidePreview(); }
  };
}
