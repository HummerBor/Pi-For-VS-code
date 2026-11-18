/**
 * 文件路径 / 符号可点（2026-11-23 第 5 刀子刀 5a，从 webview/main.ts 整块拆出）：
 * FILE_RE 三条互斥分支认出路径 → cleanPath 纠偏 → `.fp` span → 点击交宿主 openPath 打开；
 * 行内 code 里的「类.成员」符号（ModelRuntime.create 这类，文件正则认不出扩展名）走
 * linkifySymbol 兜底，由宿主在 pi 包里搜源码。页面级的 `.fp` 点击委托同住本文件。
 *
 * 为什么点击委托跟 linkify 同生共死：`.fp` 是 linkify 现造现插的节点，绑定点（#session-area
 * 捕获阶段，防止触发工具行折叠）若分家，新插的链接点不点得开要两边对表——一个整体。
 *
 * ★ 红线 R8（事故级，5a 唯一的语义风险点）：`linkifyEnabled` 是**全局总闸**，
 *   全仓唯一一份住在 main.ts —— renderAll 先关它让老消息不扫正则（大会话卡顿的唯一止血），
 *   再边循环边对最近 15 条打开。本模块**只经 deps.getLinkifyEnabled() 读**，绝不自己留一份；
 *   两边各留一份必然对不上，「重绘卡顿」会原样回归（见 reports/REPORT-t38.md）。
 *   写入端 setLinkifyEnabled 成对注入：唯一持有者是 main.ts，本模块不写（renderAll 住那边，
 *   等 5d 搬 messageList 时按同一对 accessor 交接，接口不用改）。
 * ★ 状态归属：本模块独占 FILE_RE / SYM_RE —— 带 g 标志的正则 lastIndex 是可变的，
 *   一份代码只该有一份 lastIndex。
 *
 * 行为红线：正则一个字不动（口径钉在 scripts/test/linkify.test.mts 的 22 项用例里）、
 * DOM class（.fp / data-p）、协议（openPath）一律不动；这是纯搬家。
 */

export interface LinkifyDeps {
  /** ★ 全局总闸读取端（唯一一份住 main.ts） */
  getLinkifyEnabled: () => boolean;
  /** ★ 全局总闸写入端（成对注入；写入者仍是 main.ts 的 renderAll） */
  setLinkifyEnabled: (v: boolean) => void;
  /** #session-area：`.fp` 点击委托的容器（页面级，不随页签克隆） */
  sessionArea: HTMLElement;
  /** 上行消息（原 vscode.postMessage：会按活动页签补 tabId，别换成 vscodeApi） */
  post: (m: any) => void;
}

export function initLinkify(deps: LinkifyDeps) {
  var sessionArea = deps.sessionArea;
  var post = deps.post;
  // ── 文件路径可点击：识别文本里的路径 → .fp span → openPath 给宿主打开 ──
  var FILE_RE = /([A-Za-z]:[\/][\w.\- \u4e00-\u9fff\/]*[\w.\-\u4e00-\u9fff]\.[A-Za-z0-9]{1,8}(?:\:\d{1,5})?|[\w.\-\u4e00-\u9fff]+(?:[\/][\w.\- \u4e00-\u9fff]+)+\.[A-Za-z0-9]{1,8}(?:\:\d{1,5})?|[\w\u4e00-\u9fff][\w\-\u4e00-\u9fff]*\.(?:tsx|jsx|json|mjs|ts|js|md|txt|html?|css|scss|less|py|java|cpp|hpp|c|h|go|rs|rb|php|sh|bat|ps1|ya?ml|toml|xml|svg|vue|sql|ini|conf|log|png|jpe?g|gif|webp|bmp|ico|avif|pdf)(?![\w\-])(?::\d{1,5})?)/g; // 第三支：光文件名（常见扩展名白名单）也可点，存在性由宿主 openFilePath 校验。
  // 扩展名必须长项前置 + 尾边界 (?![\w\-])：短项前置又无边界时 js 吃掉 json/tsx/jsx、裸 c 吃掉
  // create/cpp/conf——models-store.json→models-store.js、ModelRuntime.create→ModelRuntime.c 的假链
  // 点开必「找不到文件」（2026-09-23 用户实测「这些都点不开」，口径钉在 scripts/linkify.test.mts）。
  // 名字段同理必须放开中文重复：只许开头一个中文字符时「交接-启动慢战役.md」被吃到「役.md」
  // （2026-09-23 第二张截图）；混排吞头由 cleanPath 砍，纯中文过吞由宿主 openFilePath 去头重试兜底
  function cleanPath(p) {
    p = p.replace(/[.,;:!?)}\]⟩】»]+$/, '');
    var parts = p.split(' ');
    while (parts.length > 1 && parts[parts.length - 1].indexOf('/') === -1 && parts[parts.length - 1].indexOf('\\') === -1) parts.pop();
    p = parts.join(' ');
    // 中文混排纠偏（「役.md」事故续）：散文吞头（改main.ts一行 → 改main.ts）时，名里有英数段
    // 就砍掉开头非 ASCII，只留 ASCII 起的真名；纯中文名（交接-启动慢战役.md）不动
    if (p.indexOf('/') === -1 && p.indexOf('\\') === -1) {
      var dm = p.lastIndexOf('.');
      var nm = dm > 0 ? p.slice(0, dm) : p;
      if (/[A-Za-z0-9]/.test(nm) && !/^[\x00-\x7F]/.test(nm)) {
        var cut = nm.replace(/^[^\x00-\x7F]+/, '');
        if (cut) p = cut + p.slice(dm);
      }
    }
    return p;
  }
  // linkifyEnabled 住 main.ts（R8 全局总闸，唯一一份），这里只读
  function linkify(root: HTMLElement | null) {
    if (!root || !deps.getLinkifyEnabled()) return;
    var nodes = [];
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) { var n = w.currentNode as HTMLElement; var par = n.parentNode as HTMLElement; if (par.nodeName !== 'PRE' && par.classList && !par.classList.contains('fp')) nodes.push({ n: n, code: par.nodeName === 'CODE' }); }
    for (var i = 0; i < nodes.length; i++) {
      var n2 = nodes[i].n; var txt = n2.nodeValue; if (!txt) continue;
      FILE_RE.lastIndex = 0; if (!FILE_RE.test(txt)) { linkifySymbol(n2, txt, nodes[i].code); continue; }
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
  // ── 刀3（2026-09-23「这些都点不开」续）：行内 code 里的符号引用（ModelRuntime.create 这类
  // 类.成员，文件正则认不出扩展名）也做成 .fp——点击由宿主 openFilePath 在 pi 包里搜源码打开。
  // 只认「code 整段恰好是一个符号」：散文里的 Node.js/版本号不误伤。口径钉死在 scripts/linkify.test.mts
  var SYM_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
  function linkifySymbol(n, txt, inCode) {
    if (!inCode) return;
    var t = String(txt).trim().replace(/[();,]+$/, '');
    if (!SYM_RE.test(t)) return;
    var sp = document.createElement('span'); sp.className = 'fp'; sp.textContent = t; sp.setAttribute('data-p', t);
    (n.parentNode as HTMLElement).replaceChild(sp, n); // 整段替换：trim 掉的空白仅限 code 首尾，可忽略
  }
  // 点击 .fp → openPath 给宿主打开（捕获阶段，防止触发工具行折叠）
  // 点击 .fp → openPath 给宿主打开（捕获阶段，防止触发工具行折叠）；
  // 工单24 二期：委托到 #session-area（消息流在各页签视图内，都是它的子孙）
  sessionArea.addEventListener('click', function (e) {
    var t = e.target as HTMLElement | null;
    while (t && t !== sessionArea) {
      if (t.classList && t.classList.contains('fp')) {
        e.stopPropagation(); post({ type: 'openPath', path: t.getAttribute('data-p') });
        return;
      }
      t = t.parentNode as HTMLElement | null;
    }
  }, true);

  return { cleanPath: cleanPath, linkify: linkify, linkifySymbol: linkifySymbol, FILE_RE: FILE_RE, SYM_RE: SYM_RE };
}
