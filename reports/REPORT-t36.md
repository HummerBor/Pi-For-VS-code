# REPORT-t36：webview/main.ts 拆分第 4 刀——输入区 → `webview/features/composer.ts`

工单：`dispatch-t36.md`（勘察依据：`reports/SCOUT-t34-cuts.md` 第二章）
日期：2026-11-18
施工方会话产出；**待总监验收**。

## 〇、结论与回滚（先看这里）

| 项 | 值 |
|---|---|
| 代码提交 | `bcf9ded`（`bcf9ded7d7f3ce80f4f1206ddacdb0b354f860e6`） |
| 回滚命令 | `git revert bcf9ded` —— 一把退回第 3 刀后的状态（`724cc1a` 的 main.ts + 无 composer.ts） |
| 收单报告提交 | 本文件所在提交（纯文档，回滚代码时可保留；要连文档一起退：`git revert <本文件所在提交>`） |
| 文件集自检 | `git show --stat HEAD` = `webview/features/composer.ts`(+433) / `webview/main.ts`(347 改, 321 删) —— **只有这两个文件**，`src/`、`harness/`、`protocol.ts`、`webview/style.css`、`webview/index.html` 零改动 |
| 行数账 | `webview/main.ts` **2229 → 1934（净减 295，门槛 ≥200 ✅）**；`webview/features/composer.ts` 433（含 40 行模块头/接口注释） |
| `npm run compile` | 三段全绿（vendor-pi 冒烟 + typecheck:webview + vite×2 + `tsc -p ./`） |
| 13 组回归 | 逐项**同数**全过（下方 §4 贴原文） |
| `bindComposerOnce` | 归一化 + 带缩进两种口径 **0 字差异** |
| 双绑自检 | 全文件 `addEventListener` 人工过一遍 + 产物 `paste` 绑定仅 1 处（§3.R1） |
| 真机手点 | **待用户**（§6 清单） |

> 注：本单按「代码提交 / 收单报告提交」两次提交，因为报告需要写入代码提交的真实哈希。
> 两次提交的文件集互不重叠（前者 = main.ts + composer.ts，后者 = 本文件）。

## 一、搬了什么

| 组 | 函数 / 状态 | 原位置（HEAD 行号） |
|---|---|---|
| 附件去重 | `normPath` / `isTmpAttach` / `hasImg` / `hasFile` | 348–360 |
| 附件摄入 | `handleFiles` | 1261–1333 |
| 附件条 | `renderAttach` | 1335–1372 |
| 联想菜单 | `hideSuggest` / `updateSuggest` / `renderSuggest` / `nextSel` / `paintSuggest` / `applySuggest` | 1374–1446 |
| 发送链 | `send` | 1468–1481 |
| 键位 / 高度 | `autoSize` / `inputKeydown` | 1484–1521（含 1483 注释） |
| 归一 / 粘贴 | `toHalfWidth` / `normalizeInputWidth` / `filesFromClipboard` / `inputPaste` | 1522–1555（含注释块） |
| **随块搬走的状态** | `pendingImages` / `pendingFiles`(267)、`sgList` / `sgSel` / `sgKind` / `slashMenuOn`(338–341) | 视图闭包成员 → 模块内独占 |
| **handleMsg 两个分支体** | `addImages`（图片预检循环，原内嵌 IIFE）/ `addFiles`（去重合并） | 1691–1708 |

比派单估计的 ≈264 行多搬了 `addImages`/`addFiles` 分支体（≈18 行）：派单 §2.2 的口径是
「保留分支，只把 `pendingImages/pendingFiles` 的读写点换成 `composer.*`」。**若分支体留在 main.ts，
就必须从模块导出 `pendingImages/pendingFiles` 让外部直接 push/concat** —— 那正是 R4/state.ts 头注释
禁止的「同一份状态两边各留一份」。所以取「分支体搬进模块、main.ts 只留一行 `composer.addImages(m.images)`」
这条等价路径：预检/去重/重渲仍在**同一模块同一状态**上执行，行为逐字未变（§4.3 附 diff 说明）。

**明确没搬（按 R1–R6）**：`bindComposerOnce`(282–298)、`bindViewEvents`(301–334)、
`histIdx`/`histDraft`(1450) + `histNav`(1451–1466)、`renderCodeChip`(362–367)、队列条(711–756)。

## 二、main.ts 侧改了什么

1. 新增 `import { initComposer } from "./features/composer";`（第 4 刀）。
2. `vpost` 之后插入装配块 `var composer = initComposer({...})` + 6 个别名
   （`send`/`inputKeydown`/`inputPaste`/`normalizeInputWidth`/`updateSuggest`/`autoSize`/`handleFiles`）。
   别名存在的唯一理由：`bindComposerOnce` / `bindViewEvents` / `histNav` 的正文**一个字都不用改**。
3. 删掉搬走的整块与两个死元素引用（`attachbarEl`、`suggestEl` 已归模块，main.ts 不再持有）。
4. `handleMsg` 两处换调用：
   ```diff
   -    else if (m.type === 'addImages') { (function() { …nextAdi… })(); }
   -    else if (m.type === 'addFiles') { pendingFiles = pendingFiles.concat(…); renderAttach(); }
   +    // 待发附件归 features/composer.ts 独占：预检/去重/附件条重渲全在模块内（第 4 刀）
   +    else if (m.type === 'addImages') composer.addImages(m.images);
   +    else if (m.type === 'addFiles') composer.addFiles(m.files);
   ```
   `slashList` / `fileList` 分支**未动**（仍写 main.ts 的页面级 `slashCmds`/`workspaceFiles` 再调
   `updateSuggest` 别名）；`fillInput` / `queuedRetrieved` 分支**未动**（仍读写 `histIdx`/`histDraft`/`input`）。

## 三、边界自证（R1–R6，逐条给证据）

### R1 composer.ts 不给 `#input` / `#send` 绑任何事件 ✅
```
$ grep -n "addEventListener" webview/features/composer.ts
212:        x.addEventListener('click', function() { pendingImages.splice(idx, 1); renderAttach(); });
230:        x.addEventListener('click', function() { pendingFiles.splice(idx, 1); renderAttach(); });
280:        d.addEventListener('mousedown', function(e) { e.preventDefault(); applySuggest(rows[idx].item); });
281:        d.addEventListener('mouseenter', function() { sgSel = idx; paintSuggest(); });
```
只剩两个**动态节点**的绑定（附件 chip × 删除、联想行 hover/点击，原实现就在这，逐字照搬）。
`grep -n "#send\|sendBtn" webview/features/composer.ts` → 只命中头注释里的红线说明，**代码零引用**。
产物侧同样只有一处：
```
$ grep -o "addEventListener(.\{0,3\}paste" dist/webview/main.js   → addEventListener(`paste   （1 次）
$ grep -n "sendBtn.addEventListener" webview/main.ts              → 304（唯一）
```

### R2 `try{bindViewEvents}/catch/finally{bindComposerOnce}` 顺序未动 ✅
```
$ diff <(git show HEAD^:webview/main.ts | sed -n '1734,1741p') <(sed -n '1439,1446p' webview/main.ts)
（无输出）
$ grep -n "input.disabled" webview/main.ts
317:    input.disabled = false; // …（在 bindComposerOnce 内，随 R3 零字差异）
```

### R3 `bindComposerOnce` 零字差异；`histIdx/histDraft/histNav` 留家 ✅
```
$ diff <(git show HEAD^:webview/main.ts | sed -n '279,299p' | sed 's/^ *//') \
       <(sed -n '298,318p' webview/main.ts | sed 's/^ *//')          → 无输出
$ diff <(git show HEAD^:webview/main.ts | sed -n '282,298p') \
       <(sed -n '301,317p' webview/main.ts)                          → 无输出（带缩进同口径）
$ diff <(git show HEAD^:webview/main.ts | 抽 '// 回溯状态'…'function send()') \
       <(新 main.ts | 抽同名锚点)                                    → 无输出（histNav 块整体零差异）
```
`histIdx = -1; histDraft = '';` 在 main.ts 的三处裸赋值（`bindComposerOnce` 内、`fillInput`、`queuedRetrieved`）
一处未动；composer 侧经 `deps.resetHist()` 转调（`send()` 内一处，见 §4.3 允许差异 ③）。

### R4 页面级变量不复制 ✅
```
$ grep -n "var sentHistory\|var codeCtx\|var slashCmds\|var workspaceFiles" webview/main.ts
60:  var sentHistory: string[] = [];
1614:  var codeCtx = null; var codeOn = true;
1644:  var slashCmds = null;
1645:  var workspaceFiles = null;
```
全部只有 main.ts 一处持有；composer 侧：
`sentHistory` = deps 注入的**同一个数组引用**（`history: deps.history`，只 push/shift/读）；
`codeCtx/codeOn` = getter（`deps.getCodeCtx()` / `deps.isCodeOn()`）；
`slashCmds/workspaceFiles` = getter，函数内取一次到局部常量后只读（`var slashCmds = deps.getSlashCmds();`）。
模块里没有第二个 `var sentHistory`/`var slashCmds`/`var codeCtx`（`grep` 只剩注释与 deps 接口声明）。

### R5 `composerBound` 仍在视图闭包内 ✅
```
$ grep -n "composerBound" webview/main.ts
300:  var composerBound = false;
302:    if (composerBound) return;
303:    composerBound = true;
```
300 行在 `makeSessionView`(143–…) 之内，未提模块级、未按 279 行注释「修复」。

### R6 队列条未动 ✅
`git diff -U0 HEAD^ HEAD -- webview/main.ts | grep '^@@'` 的删除区间（旧文件行号）只有这五段：
267（1 行，`pendingImages/pendingFiles` 声明）、338–361（24 行，sg*/slashMenuOn + 去重四函数）、
1261–1447（187 行，handleFiles→applySuggest）、1468–1556（89 行，send→inputPaste）、
1691–1708（18 行，handleMsg 的 addImages/addFiles 分支体），外加 156–157（2 行元素引用）
与 170（+19 行装配块）、15（+1 行 import）。**全部避开 711–756**（`addQueuedDom/addQueued/
renderNativeQueue/removeQueued`）——队列条一个字都没动。

## 四、验收证据

### 4.1 `npm run compile` 三段全绿
```
> node scripts/release/vendor-pi.mjs && npm run typecheck:webview && npm run build:webview && tsc -p ./
[vendor-pi] 已拷贝 pi 1.5.0 → vendor/pi/dist/bundle
[vendor-pi] 冒烟通过：SDK 入口齐全
[vendor-pi] 冒烟通过：用户扩展加载链路（jiti + virtualModules）可用
[vendor-pi] 冒烟通过：photon WASM 可编译
> tsc -p webview --noEmit                    ← 零输出（strict:false 下 tsc 零报错）
dist/webview/main.js   116.25 kB │ gzip: 41.23 kB
✓ built in 183ms   /   ✓ built in 122ms     ← vite 两段（main / sessions）
$ tsc -p ./ --noEmit                        ← 零输出（宿主侧 tsc 段）
（整体 exit=0）
```

### 4.2 13 组回归：逐项同数

| 套件 | 改动前 | 改动后 |
|---|---|---|
| `test:linkify` | linkify 口径用例 22 项全部通过 | 22 项全部通过 |
| `test:html` | getHtml 回归 OK（HTML **150009** 字节） | getHtml 回归 OK（HTML **150781** 字节） |
| `test:changespage` | changesPage: **10** passed | 10 passed |
| `test:ctx` | ctxBreakdown: **13** passed | 13 passed |
| `test:detail` | **27/27** 全过 | 27/27 全过 |
| `test:usage` | usageTotals: **14** passed | 14 passed |
| `test:price` | priceTable: **11** passed | 11 passed |
| `test:errclass` | errorClass.test.mts: all passed | all passed |
| `test:diffview` | diffView: **7** passed | 7 passed |
| `test:subagent` | subagentSnapshot: **50** 项全过 | 50 项全过 |
| `test:replay` | subagentReplay 用例：**19** 项全过 | 19 项全过 |
| `test:jsonltail` | test-jsonltail: **7/7** 通过 | 7/7 通过 |
| `test:migration` | 用例 1–5 全过（modelMemory C 刀口径） | 用例 1–5 全过 |

13 组 **exit=0**，条数逐项相同，无新增/删除用例（本刀未改 `scripts/test/*`）。

> `test:html` 的字节数 **150009 → 150781（+772）**：该数字是 `getHtml` 注入后的 HTML 长度（含内联
> JS/CSS 全文），断言只看资源路径（OK）。+772 来自模块包装与 deps 装配（`initComposer(deps)` +
> 别名 + 导出对象），不是行为变化——同一份逻辑换个文件，产物字节天然会动。

### 4.3 逐字核对：每个搬动块的归一化 diff（`sed 's/^ *//'`，只列差异）

核对脚本（跑完即删，逻辑见 §4.4）：按名称锚点把「旧 main.ts 的块」与「新 composer.ts 的块」各抽一份，
统一去行首缩进后 `diff -u`。

| 块 | 结果 |
|---|---|
| `normPath..hasFile` | **无差异** |
| `handleFiles` | **无差异** |
| `renderAttach` | **无差异** |
| `hideSuggest..applySuggest` | +2 行（见下 ①） |
| `send` | 3 行替换（见下 ②③④） |
| `autoSize` | **无差异** |
| `inputKeydown` | 1 行替换（见下 ⑤） |
| `toHalfWidth..inputPaste` | **无差异** |
| `histNav`（未搬，旧 main.ts vs 新 main.ts） | **无差异** |

**允许差异逐条 + 理由**

① `updateSuggest` 两处页面级缓存改成函数内取一次：
```diff
  if (!slashMenuOn) { slashMenuOn = true; vpost({ type: 'getSlash' }); }
+ var slashCmds = deps.getSlashCmds(); // ★ 页面级缓存只读注入（原闭包裸读，第 4 刀走 deps）
  if (slashCmds === null) { hideSuggest(); return; }
  …
+ var workspaceFiles = deps.getFiles(); // ★ 页面级缓存只读注入（同上）
  if (workspaceFiles === null) { vpost({ type: 'getFiles' }); hideSuggest(); return; }
```
理由：R4 —— 变量本身留在 main.ts（页面级一份），模块只能经 deps 读。取到局部常量后**下文一行未动**，
故差异只有这两行「取值」。请求 `getSlash` 的位置仍在 null 判定之前（顺序不变）。

② `send` 的代码上下文开关：
```diff
- var attachCode = codeCtx && codeOn;
+ var attachCode = deps.getCodeCtx() && deps.isCodeOn(); // ★ 页面级 codeCtx/codeOn 只读注入
```
理由：同上（`codeCtx/codeOn` 是页面级数据，R4）。

③ `send` 的回溯复位（R3 的直接后果）：
```diff
- histIdx = -1; histDraft = ''; // 回溯复位：下次 ↑ 从最新一条重新开始
+ deps.resetHist();             // 回溯复位：下次 ↑ 从最新一条重新开始（histIdx/histDraft 住 main.ts）
```
理由：`histIdx/histDraft` 必须留 main.ts（`bindComposerOnce` 正文裸赋值，R3 不许改），
故这里是**必要转调**；main.ts 侧 `resetHist` 的内容就是这一行原文。

④ `send` 的 toast 边界：
```diff
- lastNotice = ''; // 新回合开始：…
+ deps.resetNotice(); // 新回合开始：…（同一段注释原文保留）
```
理由：`lastNotice` 是消息区（第 5 刀）与 `notice()` 的成员，本刀不搬它；`send` 的「新回合清 toast」
语义经回调保留，main.ts 侧 `resetNotice` = `lastNotice = ''`。

⑤ `inputKeydown` 的 Esc 分支：
```diff
- if (changesPage.hasPage()) changesPage.close();
+ if (pages.hasPage()) pages.close();
```
理由：`changesPage` 是视图内实例，不整块注入（本模块只需要「有没有页 / 关页」两个动作），
按依赖倒置只注入这两个函数（与 `notice` / `histNav` 同款）。

> 未列出的部分 = 逐字相同，包括所有事故教训注释（「拖进输入框没反应」「V 刀消息无声消失」
> 「全角 ｓ ｓ ｓ」「乒乓死循环」「同图不同名」「isComposing 守门」等）整段随函数搬走。

### 4.4 核对脚本做了什么（跑完已删，未入库）
按锚点抽块（`function X` … 下一个锚点）→ 两侧统一 `replace(/^ +/,'')` → `diff -u`；
`bindComposerOnce`/`histNav`/`try-finally` 用 `git show HEAD^:webview/main.ts | sed -n` 直比。
脚本与中间产物（`scripts/tmp-cut4.mjs`、`scripts/tmp-verify4.mjs`、`scripts/.tmp-cut4/`）**已删除，未进提交**。

## 五、DevTools / 日志（待真机确认）

- DevTools console 零报错、`~/.pi/agent/pi-chat-debug.log` 无新增 `wvError`（`kind=bindViewEvents`
  尤其要看）—— 需要装机后手点才能取证，施工会话无法代跑，**待用户**。
- 本刀的可疑点集中在「绑定」与「装配时序」，静态已自证：绑定只有 `bindComposerOnce` 一处（§3.R1）、
  装配在 `view.innerHTML = protoHTML` 之后（`q('#input')` 命中）、`notice`/`histNav` 是函数声明（提升，
  装配时引用安全）、`sentHistory` 是数组引用（从不重新赋值，注入即同一份）。

## 六、真机手点清单（**待用户**，第 4 刀最不能省的一节）

按顺序点一遍，任何一条不对就是本刀 bug：

1. **打字不 disabled**：打开面板直接能打字（模板 `disabled` 被 `bindComposerOnce` 放开）。
2. **Enter 发送**：发一条纯文字 → 气泡上屏 + 输入框清空 + 高度回落。
3. **Shift+Enter 换行**：不发送，多行高度自适应到 220px 上限后转内部滚动条。
4. **↑ / ↓ 回溯**：发 2 条后按 ↑ 出上一条、再 ↑ 更早、↓ 回到草稿；多行中间光标按 ↑ 只移动光标不回溯。
5. **`/` 菜单**：输入 `/` 出菜单（含分组标题，方向键跳过标题）；继续打字过滤；Tab/Enter 补全；
   Esc 收起菜单（此时不中断任务）。
6. **`@` 文件搜索**：输入 `@` 出文件清单，Enter 插入相对路径；`＋ → 引用文件` 也能插入 `@`。
7. **粘贴图片**：Ctrl+V 图片 → 附件条出现 chip（带尺寸），无输入文字也能发（占位文案 `L.seeImage`）。
8. **拖入附件**：拖图片进输入框 → chip；拖普通文件 → chip（带路径提示）；
   **资源管理器拖入**（部分版本只带 URI）→ 同样出 chip（走 `attachUri`→宿主 `addFiles`）。
9. **chip × 删除**：点 × 只删那一个（图片/文件各试一次），全删后附件条消失。
10. **全角转半角**：输入法切全角打 `ｓｓｓ` → 自动变 `sss`（半角态 Ctrl+Z 行为不受影响）。
11. **Esc**：变更页开着时先关变更页；没开变更页时中断任务；中文输入法取消候选词**不**中断任务。
12. **历史取回/填充**：排队消息「取回」→ 文本合入输入框并退出回溯；宿主 fillInput 同理。
13. **多页签**：开第二个页签，输入框各自能打字、各自能发（R5 的 `composerBound` 每视图一份）；
    第一个页签的 ↑ 历史与第二个页签**共用**同一份 `sentHistory`（R4 的页面级一份，符合原设计）。

## 七、给下一刀的交接

- `composer.ts` 的 deps 形状是第 5/6 刀的样板：**外部持有 + 只读 getter**（页面级）、
  **必要转调回调**（`notice`/`histNav`/`resetHist`/`resetNotice`/`pages`）、**模块独占状态**
  （`pendingImages/pendingFiles/sg*`/`slashMenuOn`）。第 5 刀搬 `notice` 时把 deps 的 `notice`
  换成模块内实现即可（签名不变），`lastNotice` 复位可一并收进 `messageList`。
- 第 6 刀注意：`bindViewEvents` 仍在 main.ts 且尾部调 `bindComposerOnce()`；搬它时**别把
  `bindComposerOnce` 一起搬**（R1/R2 的止血结构），也别重排 `try/finally`。
- 尚未认领的债（勘察 §六）里与输入区相关的两条：`handleFiles` 内的 `textDone`/`fileCount`
  是**搬家前的存量死变量**（本刀按「存量死代码不动」保留，未顺手删）；`addImages` 的
  `nextAdi` 递归已随分支搬进模块，不再卡在 `handleMsg` 里（勘察 §六第 4 条部分消解）。
