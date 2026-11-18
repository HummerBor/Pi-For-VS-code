# REPORT-t38：webview 拆分第 5 刀子刀 5a——渲染基座（markdown + linkify）

- **本单 commit**：`921e922cc37367563f4082529a9c3f599775097e`（`921e922`）
- **回滚命令**：`git revert 921e922`（纯搬家，无迁移、无协议改动，revert 即回到 t37 状态）
- 提交文件集（`git show --stat HEAD` 自检，4 个文件，无夹带）：

```
 scripts/test/linkify.test.mts |  28 +++++---
 webview/features/linkify.ts   | 112 +++++++++++++++++++++++++++++
 webview/features/markdown.ts  | 106 +++++++++++++++++++++++++++
 webview/main.ts               | 164 +++++-------------------------------------
 4 files changed, 253 insertions(+), 157 deletions(-)
```

## 一、做了什么

| 搬走 | 从 | 到 |
|---|---|---|
| `renderInline` / `renderPlain` / `renderTable` / `renderRich`（含「轻量 Markdown」「围栏必须行首」等事故注释） | `webview/main.ts` 69–143 | `webview/features/markdown.ts`（`initMarkdown(deps)`） |
| `FILE_RE` + 两条扩展名/中文名事故注释、`cleanPath`、`linkify`、`SYM_RE`、`linkifySymbol`、`.fp` 点击委托（`sessionArea` 那段） | `webview/main.ts` 1534–1606 | `webview/features/linkify.ts`（`initLinkify(deps)`） |

`webview/main.ts` 只留装配 + 别名，**全部调用点一字未动**：

```ts
  var linkifyEnabled = true;            // ★ R8：全仓唯一一份
  function getLinkifyEnabled() { return linkifyEnabled; }
  function setLinkifyEnabled(v: boolean) { linkifyEnabled = v; }
  var linkifyMod = initLinkify({
    getLinkifyEnabled: getLinkifyEnabled, setLinkifyEnabled: setLinkifyEnabled,
    sessionArea: sessionArea, post: function (m) { vscode.postMessage(m); }
  });
  var linkify = linkifyMod.linkify;
  var markdown = initMarkdown({ el: el, linkify: linkify });
  var renderRich = markdown.renderRich;
```

装配点选在原 `FILE_RE` 区（`shorten` 之后）：`sessionArea` 这时才被赋值（`main.ts:1494` 的
`document.getElementById('session-area')`），`el`/`ico`/`shorten` 都已在上面就位；markdown 排在
linkify 之后，因为 `renderRich` 收尾要调 `linkify`（模块内无状态，装配顺序即依赖顺序）。
`renderRich` 的 8 处调用全在函数体内（addUser / makeCompaction / appendFinal / setMdTail / renderAll），
模块 init 期间不会被读到，`var` 提升 + 装配靠后不会踩空。

## 二、R8（`linkifyEnabled` 全局总闸）：唯一一份，只经 accessor

- 变量**只有一份**，住在 `webview/main.ts`（`renderAll` 的两个写点 `linkifyEnabled = false/true`
  原样保留，一个字没动 —— 那是大会话重绘卡顿的唯一止血）。
- `webview/features/linkify.ts` **不声明任何同名变量**，只读 `deps.getLinkifyEnabled()`；
  `setLinkifyEnabled` 成对注入（写入者仍是 main.ts 的 renderAll；等 5d 把 renderAll 搬进
  `features/messageList.ts` 时按同一对 accessor 交接，接口不用改）。
- 证据：`grep -rn "linkifyEnabled" webview/` → 变量本身只有 `main.ts:1467` 一处声明（另 2 处是
  `renderAll` 的写点 1003/1025 + 一对 accessor 1468/1469 + 2 行指路注释）；`linkify.ts` 里
  **零声明**，只有 `deps.getLinkifyEnabled()` 调用与 2 行指路注释。
- getter 是闭包读 `main.ts` 的 `var`，`renderAll` 的写入对所有 `linkify()` 调用立即可见（与搬家前同语义）。

## 三、R9（`scripts/test/linkify.test.mts` 同单修改）

改的是**取代码的源文件与标记**，断言函数 `check()`、22 条 `check(...)` 与 `assert.deepStrictEqual`
一个字符都没动。

| 原 grab | 新 grab |
|---|---|
| `main.ts`：`"function renderInline(elm, text)"` → `"function renderRich(parent, text)"`（不含尾） | `markdown.ts`：同标记 |
| `main.ts`：`"function renderRich(parent, text)"` → `"function makeSessionView(id: string)"`（不含尾） | `markdown.ts`：`"function renderRich(parent, text)"` → `"return {"`（不含尾；renderRich 是模块内最后一个函数） |
| `main.ts`：`"var FILE_RE ="` → `"}, true);"`（含尾） | `linkify.ts`：同标记 |
| `grab()` 读单文件全局 `lines` | `grab(lines, …)` 显式传行数组（mdLines / lkLines） |
| `code.slice(0, code.indexOf("  sessionArea.addEventListener"))` | 不变（linkify.ts 里该行仍是 2 空格缩进，切片照旧生效） |
| `new Function("document","NodeFilter","el", …)` | 多传一个 `deps` 垫片：`{ getLinkifyEnabled: () => true, setLinkifyEnabled: () => {} }` —— R8 把总闸挪到 main.ts 后，模块内 `deps.getLinkifyEnabled()` 需要宿主；恒 `true` 复刻搬家前的默认口径（开）。 |

“grab 失败即 throw”的原行为保留（`throw new Error("grab failed: " + startMark)`），所以标记写错会当场炸，
不会静默变成空用例。抽的仍是**真代码 eval**，不是副本测试（SCOUT §六.6 的“副本测试”退化没发生）。

输出原文：

```
$ npm run test:linkify
linkify 口径用例 22 项全部通过
```

## 四、验收证据

### 4.1 `npm run compile`：三段全绿（整体 exit=0）

```
$ npm run compile                    # vendor-pi.mjs && typecheck:webview && build:webview && tsc -p ./
> tsc -p webview --noEmit            ← 零输出（webview 类型门禁，strict:false 下零报错）
dist/webview/main.css   36.28 kB │ gzip:  7.66 kB
dist/webview/main.js   116.28 kB │ gzip: 41.26 kB
✓ built in 160ms                     ← vite main（16 modules，含新 features/markdown.ts|linkify.ts）
dist/webview/sessions.js 49.93 kB │ gzip: 18.82 kB
✓ built in 117ms                     ← vite sessions
$ tsc -p ./                          ← 零输出（宿主侧 tsc）
COMPILE_EXIT=0
```

### 4.2 `test:linkify`：22 项全过

见 §三（本单最重要的一条：断言逻辑与用例数一字未动，输出仍是「22 项全部通过」）。

### 4.3 其余 14 组回归：逐项同数

| 套件 | 基线（REPORT-t35/t36 记录） | 本单 |
|---|---|---|
| `test:html` | HTML **150781** 字节（t36 收单值） | HTML **150828** 字节（+47，见下注） |
| `test:changespage` | changesPage: 10 passed | 10 passed |
| `test:ctx` | ctxBreakdown: 13 passed | 13 passed |
| `test:detail` | 27/27 全过 | 27/27 全过 |
| `test:usage` | usageTotals: 14 passed | 14 passed |
| `test:price` | priceTable: 11 passed | 11 passed |
| `test:errclass` | all passed | all passed |
| `test:diffview` | diffView: 7 passed | 7 passed |
| `test:subagent` | subagentSnapshot: 50 项全过 | 50 项全过 |
| `test:replay` | 19 项全过 | 19 项全过 |
| `test:jsonltail` | 7/7 通过 | 7/7 通过 |
| `test:liveness` | 10/10 通过（t35） | 10/10 通过 |
| `test:docktime` | 7 passed, 0 failed | 7 passed, 0 failed |
| `test:migration` | 用例 1–5 全过 | 全过（用例 5 跨工作区零串扰 ✅） |

全部 exit=0，条数逐项相同，**未改任何其它测试文件**。

> `test:html` 的字节数是 `getHtml` 注入后的 HTML 长度（含内联 JS/CSS 全文），断言只看资源路径（OK）。
> **150781 → 150828（+47）** 来自模块包装（`initLinkify(deps)` / `initMarkdown(deps)` + 两个别名 +
> 导出对象）与压缩后代码的重排，不是行为变化 —— 与 t36 当时 150009 → 150781（+772）同一性质。

### 4.4 逐字核对：与 `git show HEAD:webview/main.ts` 归一化后**零差异**

核对脚本：`scripts/.preview/t38-verify.mjs`（gitignored，`node scripts/.preview/t38-verify.mjs` 可随时复跑；
手术脚本 `scripts/.preview/t38-surgery.mjs` 带行号锚点断言，一次性）。按名称锚点从 HEAD 主文件与新模块各抽一块，
去行首缩进/尾空白后逐行比对；§五 列的两处定向替换在 HEAD 侧先跑掉，再进行比对。

```
✅ 零差异 renderInline+renderPlain+renderTable（HEAD 56 行 / 新 56 行）
✅ 零差异 renderRich（HEAD 18 行 / 新 18 行）
✅ 零差异 FILE_RE + 两条事故注释（HEAD 7 行 / 新 7 行）
✅ 零差异 cleanPath（HEAD 17 行 / 新 17 行）
✅ 零差异 linkify（HEAD 24 行 / 新 24 行）
✅ 零差异 SYM_RE + linkifySymbol（HEAD 8 行 / 新 8 行）
✅ 零差异 .fp 点击委托（sessionArea 段）（HEAD 13 行 / 新 13 行）
```

即：函数体、事故注释、正则字面量、缩进内层结构全部原样；差异只出现在 §五 的装配边界上。

### 4.5 行数账

| 文件 | 前 | 后 |
|---|---|---|
| `webview/main.ts` | 1934（t37 后） | **1806**（净减 **128**，派单预估 ≈1816 / 净减 ≈118） |
| `webview/features/markdown.ts` | — | 106（含 22 行头注释 + deps 接口） |
| `webview/features/linkify.ts` | — | 112（含 26 行头注释 + deps 接口） |

主文件多的那 10 行来自 R8 要求的 accessor 对 + 装配注释（设计上必须花，5d 搬 renderAll 时零改动复用）。

## 五、diff 里出现的全部差异（逐条理由）

1. **模块壳**：两块代码多包一层 `export function initXxx(deps: XxxDeps) { … return {...}; }`，
   函数体本身未变（§4.4 已证）。
2. **`el` / `linkify` 由自由变量变 deps 局部别名**：`markdown.ts` 里 `var el = deps.el; var linkify = deps.linkify;`
   —— 这样函数体里 `el(...)`/`linkify(parent)` 一个字都不用改。`el` 留家是既定分工（6b 才可能搬 icons/chrome）。
3. **`!linkifyEnabled` → `!deps.getLinkifyEnabled()`**（R8 唯一一处语义相关的替换，理由见 §二）。
4. **`vscode.postMessage({ type: 'openPath', … })` → `post({ … })`**（点击委托随迁）：deps 传的是
   `function (m) { vscode.postMessage(m); }` 包装，**不是** `vscodeApi.postMessage` —— 保留「按活动页签补
   `tabId`」的既有语义（换成 vscodeApi 会让 openPath 少 tabId）。
5. **`sessionArea` 由模块级变量变 `var sessionArea = deps.sessionArea;`**（点击委托容器注入）。
6. `linkify()` 上方新增一行指路注释「linkifyEnabled 住 main.ts（R8 全局总闸，唯一一份），这里只读」。
7. `main.ts` 的 `renderInline/renderPlain/renderTable` 不再有别名 —— 全文件零调用点（只有 markdown
   模块内部互相调用），留空别名才是死代码。`renderRich` / `linkify` 有外部调用点，别名保留。

## 六、越界自查（逐条对照派单边界）

- **`handleMsg` 正文**：未碰（diff 无该区间）。
- **5b/5c/5d/5g/5f 的函数**：`liveBlock` / `toolStart` / `toolEnd` / `renderAll` / `applySticky` /
  `outlineRebuild` / `flushRender` 等一行未动，全部留在 `main.ts`。
- **渲染语义**：表格阈值（`ri===1` 跳表头分隔行）、围栏行首配对（`/^```/`）、linkify 互斥分支顺序
  （URL 前缀跳过 → `://` 跳过 → 二进制跳过 → `cleanPath`）全部原样（§4.4 零差异即证据）。
- **事件绑定只此一处**：`grep -n "addEventListener" webview/features/linkify.ts webview/features/markdown.ts`
  → 只有 `linkify.ts:100` 的 `sessionArea.addEventListener('click', …, true)`；`main.ts` 侧那条已随块删除，
  没有双绑（R14）。
- **`src/` / `harness/` / 协议 / 模板 / CSS**：零改动（提交文件集只有 4 个 webview+test 文件）。
- **别人的未跟踪文件**（`dispatch-*.md`、`reports/SCOUT-*.md`）：未暂存、未提交。

## 七、交接给 5b（live 流式）

- `features/linkify.ts` 返回 `{ cleanPath, linkify, linkifySymbol, FILE_RE, SYM_RE }`（目前 main.ts 只取
  `linkify`；5b/5c/5d 要用的也是 `linkify`，经 main.ts 别名或直接注入 deps 都行）。
- `features/markdown.ts` 返回 `{ renderInline, renderPlain, renderTable, renderRich }`；5b 的
  `appendFinal/setMdTail` 要 `renderRich`、5c 的行 detail 要 `linkify`。
- **`linkifyEnabled` 的归属不变**：main.ts 独占，`renderAll` 两个写点未动；5d 搬 `renderAll` 时把
  这对 accessor（`getLinkifyEnabled/setLinkifyEnabled`）原样交给 `features/messageList.ts`，
  再把 `initLinkify` 的 deps 指向新持有者 —— 唯一持有者的形状已经留好，不用改 linkify 模块接口。
- 死代码 `scheduleStream`（SCOUT §六.5）仍在 `main.ts`，属 5b 范围，本单按边界只记录不删。

## 八、本单未做的（留给验收方）

- **真机手点**（渲染基座最相关项）：流式正文半截 `**bold` 不抖、表格不劈叉、围栏配对正确、
  `.fp` 路径点开能打开文件（含 `src/piCore.ts:898` 带行号、`ModelRuntime.create` 符号）、
  大会话切历史不卡（R8 的卡顿止血）。本单只做到编译 + 22 项口径用例 + 逐字核对，
  Electron/webview 真跑需总监在扩展里点。
- CI/发布：未 push（派单红线），版本号未碰。
