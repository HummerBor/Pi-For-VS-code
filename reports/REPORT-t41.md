# REPORT-t41：webview 拆分第 5 刀 · 子刀 5d + 5e —— 整树重绘 + 粘性气泡

- **代码提交：`2e0e07f`**（`refactor(webview): 整树重绘 + 粘性气泡搬进 features/messageList.ts / sticky.ts（第 5 刀 5d+5e，主文件 1534→1244）`）
- **回退：`git revert 2e0e07f`**（单提交、纯搬家；回退后 `webview/main.ts` 回到 1534 行，
  `webview/features/messageList.ts`、`webview/features/sticky.ts` 一并删除）
- 基线：`7d79fd0`（5c 收单文档，main.ts 1534 行）
- 提交文件集（`git show --stat HEAD` 自检：`5 files changed, 536 insertions(+), 342 deletions(-)`）：
  `webview/features/messageList.ts`（新建 348）+ `webview/features/sticky.ts`（新建 136）
  + `webview/main.ts`（+52/−342）+ `webview/features/liveStream.ts`、`webview/features/toolRows.ts`
  （**各 1–2 行注释**，只改「滚动跟随住 main.ts 因为它调 `applySticky(stickyQ)`」这句已失真的契约注释
  → 现为「只经 sticky 的 `pinCheck()`」，见第七节）
- 未 push；`dispatch-t41.md`、`reports/SCOUT-*.md` 一个都没动（报告按 t38/t39/t40 惯例留给收单会话提交）

## 一、行数账

| 文件 | 前（`7d79fd0`） | 后（`2e0e07f`） | Δ |
|---|---|---|---|
| `webview/main.ts` | 1534 | **1244** | −290 |
| `webview/features/messageList.ts` | — | **348** | 新建 |
| `webview/features/sticky.ts` | — | **136** | 新建 |

派单预计 ≈1240，实际 1244。差额来源：装配块 + 两个 accessor 小函数（`setOlSuspend` / `rebuildQueuebar`）
+ `notice`/`clearNotice` 两个转调函数共 33 行，而搬走的实现是 77（sticky）+ 66（imgsOf/addUser）+ 190（notice..renderCompact）= 333 行。

## 二、搬了什么（行号 = 搬家前的 `HEAD`，`git show HEAD:webview/main.ts`）

| 内容 | 原行号 | 行数 | 去处 |
|---|---|---|---|
| `stickyQ` / `stickyIO` + 追加二/三 事故注释块 | 121–135 | 15 | `sticky.ts` |
| `updateStickyChip` / `stickyWants` / `applySticky`（追加四/五注释随行）/ `observeSticky` | 136–197 | 62 | `sticky.ts` |
| `imgsOf` + `addUser`（子 agent 回报卡 / 时间戳 / 缩略图 / 附件提示 / sentinel） | 580–645 | 66 | `messageList.ts` |
| toast 存续注释 + `lastNotice` / `seenCompactions` / `compactBarShownAt` | 693–698 | 6 | `messageList.ts` |
| `notice` / `textOf` / `makeThink` / `makeCompaction` / `renderAll` / `renderCompact` | 699–882 | 184 | `messageList.ts` |

**明确未搬**（派单边界）：`handleMsg` 正文（除第三节那 1 处状态写口）、大纲
`outlineRebuild/outlineResize/olText/olScan/olSpy`（5g）、渲染队列 `scheduleRender/flushRender/
deferDuringRender/drainPendingStream`（5f）、队列条 `addQueuedDom/addQueued/renderNativeQueue/removeQueued`
（5f）、`scroll`（R7 留家）、`fmtSession/applyState`（6c）。

## 三、装配形状

### 3.1 `initSticky(deps)` —— 位置：原 `stickyQ` 声明处（`initToolRows` 之前）

```ts
var sticky = initSticky({ root: root, lang: L });
```

依赖只有两个：`root`（IO 的观察根 + 钉住判据的滚动坐标系）、`lang`（chip 文案）。
出口四个：`updateStickyChip` / `observeSticky` / `adoptSticky` / `pinCheck`。

### 3.2 `initMessageList(deps)` —— 位置：原 `notice`…`renderCompact` 所在处（`removeQueued` 之后）

```ts
var msgList = initMessageList({
  root: root, el: el, ico: ico, esc: esc, linkify: linkify, renderRich: renderRich, lang: L,
  scroll: scroll, post: vpost,
  adoptSticky: sticky.adoptSticky, updateStickyChip: sticky.updateStickyChip, observeSticky: sticky.observeSticky,
  toolStart: toolStart, toolEnd: toolEnd, resetToolRows: resetToolRows, liveReset: liveReset,
  outlineRebuild: outlineRebuild, setOlSuspend: setOlSuspend,
  setLinkifyEnabled: setLinkifyEnabled,
  setFollowingEnd: function (v: boolean) { followingEnd = v; },
  welcomeHTML: welcomeHTML, duckInto: duckInto, pickTip: pickTip,
  rebuildQueuebar: rebuildQueuebar, compactbarEl: compactbarEl
});
var addUser = msgList.addUser; var renderAll = msgList.renderAll;
function notice(text) { msgList.notice(text); }      // 函数声明（提升）：composer 的 deps 在本函数更早处求值
function clearNotice() { msgList.clearNotice(); }
```

| dep | 为什么必须注入（R12 四个外部耦合点逐个对账） |
|---|---|
| `root` / `el` / `ico` / `esc` / `linkify` / `renderRich` / `lang` / `scroll` / `post` | 原闭包成员同一套（`post` = `vpost`：`openImage` / `retryFromLast`） |
| `adoptSticky` / `updateStickyChip` / `observeSticky` | **R7**：`stickyQ`/`stickyIO` 不进本模块（见第四节） |
| `toolStart` / `toolEnd` / `resetToolRows` | 5c 出口；`renderAll` 历史重放逐工具 start/end + 重绘前 `resetToolRows()`（**没有**把两句 reset 抄回来） |
| `liveReset` | 5b 出口：整树重绘前收起在途树 |
| `outlineRebuild` + `setOlSuspend` | **R12 ③**：`olSuspend` 住大纲域（5g 未搬），main.ts 新增 2 行 `setOlSuspend(v)` accessor；**没有**复制状态 |
| `setLinkifyEnabled` | **R13 / R8**：总闸唯一持有者仍是 main.ts（与 `features/linkify.ts` 的 accessor 成对），模块只写不持有 |
| `setFollowingEnd` | `followingEnd` 是滚动域状态（R7 同族），`addUser` 的「回底意图」经 setter 写回 |
| `welcomeHTML` / `duckInto` / `pickTip` | **R12 ②**：页面级启动快照 + 两个页面级函数；`welcomeHTML` 初始化后永不变化，按值注入无陈旧风险 |
| `rebuildQueuebar` | **R12 ①**：`queuebarEl` / `queuedItems` / `addQueuedDom` 属队列域（5f 未搬）。main.ts 新增 `rebuildQueuebar()`（先清再建，工单十八补刀3 的事故注释随它走）。**不注入 `queuedItems` 数组引用**——`removeQueued` 会 `queuedItems = queuedItems.filter(...)` 重新赋值，引用注入必然读到旧数组（会把刚删掉的排队项重画出来） |
| `compactbarEl` | 本视图元素引用（原闭包成员） |

**R12 ④**（`seenCompactions` / `compactBarShownAt` / `renderCompact` 的首渲立基线语义）：三件整体进
`messageList.ts`，基线判定两行（`if (seenCompactions < 0) … else if (cc > seenCompactions) …`）**一字符未动**
（见第五节），所以「恢复旧会话不弹条 / 同轮重渲不重弹」的语义原样。

## 四、R7（scroll ↔ 钉住气泡只有一条路）

- `scroll` 留在 main.ts，钉住判定处从内联一句 `if (stickyQ && …) applySticky(stickyQ);`
  换成 `sticky.pinCheck();`（`pinCheck` 正文是**原句逐字搬过去**）。
- `addUser` 在 `messageList.ts`，经 deps 拿 `scroll` + sticky 三缝。
- `grep -rn "var stickyQ" webview/` → **只有 `webview/features/sticky.ts:34` 一处**；
  `grep -rn "stickyQ" webview/ --include=*.ts` 在 main.ts 里只剩注释（无代码引用）。
  `stickyIO` 同样只住在 sticky.ts。

## 五、逐字核对（31 行差异，逐条列理由）

方法：从 `git show HEAD:webview/main.ts` 按上述行段抽原文，与新模块同段做「去行首缩进 + 去空行」
归一化后跑 LCS 逐行比对（临时脚本用完已删）。

| 段 | 归一化行数（前→后） | 差异行 |
|---|---|---|
| sticky（121–197） | 77 → 77 | **零差异** |
| `imgsOf` + `addUser`（580–645） | 66 → 60 | 7 行 → 1 行（`stickyQ` 摘态块收成 `adoptSticky(b)`，注释随逻辑进 sticky.ts）；`followingEnd = true;` ×2 → `setFollowingEnd(true);` ×2 |
| `notice`…`renderCompact`（693–882） | 190 → 187 | `olSuspend = true/false` ×3 → `setOlSuspend(...)` ×3；`linkifyEnabled = false/true` ×2 → `setLinkifyEnabled(...)` ×2；队列条 4 行注释 + 2 行代码 → 3 行（注释 + `rebuildQueuebar();`） |

合计 **31 行（20 删 + 11 增）**，**全部是「闭包成员 → deps accessor / 模块内函数」的符号替换**，
没有一处渲染语义、DOM class、i18n 文案、时序或注释内容发生变化。除上表之外：
`textOf` / `makeThink` / `makeCompaction` / `notice` 去重 / `renderCompact` 按钮行为 / `addUser` 时间戳与
缩略图回调 **零差异**。

**R13（`linkifyEnabled` 时序）**：`setLinkifyEnabled(false)` 仍紧跟在 `root.innerHTML=''` + `liveReset()` +
`resetToolRows()` 之后、`var results` 之前；`if (i >= list.length - 15) setLinkifyEnabled(true);` 仍是循环体
第一行。空列表早退分支不碰总闸（与原实现一致）。

**`handleMsg` 正文唯一改动（必须报告）**：`render` 分支的 `lastNotice = '';` → `clearNotice();`（同一行的注释
一字未动）。理由：`lastNotice` 交出给 `messageList.ts` 独占后，本文件不再有可赋值的同名变量；转调与 5b 的
`pdet.textContent = …` → `setPDet(…)` 同款。除此之外 `handleMsg` 的 121 行 if/else 链一个字符没动
（`addUser(...)` / `notice(m.text)` / `renderAll(list)` 全部经同名别名，正文不变）。

## 六、验证

1. **`npm run compile` 三段全绿**（`vendor-pi` → `typecheck:webview` 零报错 → `vite build` ×2 →
   `tsc -p ./` 零报错；exit 0，最后统一跑一次，未当探针反复跑）。
2. **15 组回归同数**：linkify **22** / changespage **10** / ctx **13** / detail **27** / usage **14** /
   price **11** / errclass（all passed）/ diffview **7** / subagent **50** / replay **19** / jsonltail **7** /
   liveness **10** / docktime **7** / html（回归 OK）/ migration（全过）——与派单基线逐项同数。
3. 逐字核对：见第五节（31 行差异逐条列理由）。
4. `stickyQ` 声明唯一：`grep -rn "var stickyQ" webview/` 仅 `features/sticky.ts:34`。
5. 行数账：main.ts **1534 → 1244**；新模块 348 + 136 行。
6. 双绑自检：`addEventListener` 计数 `HEAD 40 = 现 main.ts 37 + messageList.ts 3`（bubble click /
   thumb click / 错误气泡重试 click），无一处新增。

## 七、顺手修的失真注释（2 个外来文件各 1–2 行）

`features/liveStream.ts`（头注释红线二 + `deps.scroll` 注释）与 `features/toolRows.ts`（`deps.scroll` 注释）
都写着「滚动跟随仍住 main.ts（**它调 `applySticky(stickyQ)`**）」——本刀之后 main.ts 只调 `pinCheck()`，
那句话已成错误契约。按「注释随逻辑走」改成「只经 sticky 的 `pinCheck()` 进钉住判定」。
纯注释、不改代码；若不接受，回退这两处不影响任何行为。

## 八、真机清单（**待用户**，本会话无 GUI 环境）

- [ ] 切历史会话整页重绘正确（用户气泡/思考块/工具行/压缩块位置与文字一致）
- [ ] 压缩块 `details` 可展开、摘要含 tokensBefore
- [ ] 错误气泡：余额/配额/鉴权类**不给**「修改后重试」入口，其他类给
- [ ] toast 跨 uiState 重渲不叠挂；切页签回来压缩提示仍有一条（不重复弹）
- [ ] 切页签回来压缩条不重复弹（首渲立基线语义）
- [ ] 超长消息钉住折叠不闪：往下滚不闪、工具收盒不闪（追加三/四/五三条判据逐条复现）
- [ ] 图片气泡的缩略图点击开原图（不触发气泡折叠）
- [ ] 队列条不双份（重绘与 uiState 原子分支谁先谁后都只一份）

## 九、给下一刀（5g / 5f）的接口现状

- 5g 大纲：`olSuspend` 仍住 main.ts，多了两行 accessor `setOlSuspend(v)`（唯一外部使用者是
  `features/messageList.ts` 的 `renderAll`）。5g 搬走时把 `setOlSuspend` 收进 `features/outline.ts`
  出口，messageList 的 deps 改传模块出口即可（接口形状不用动）。
- 5f 渲染队列：`rebuildQueuebar()` 是 main.ts 的新函数（队列条域），5f 若把队列条一起搬走，
  这个函数随 `addQueuedDom` 一起进 `features/renderQueue.ts`（或队列条模块），messageList 的 deps 只换来源。
- 6c 视图工厂：`notice` / `clearNotice` 两个函数声明转调是本刀的临时缝（因为 composer 的 deps 在
  `makeSessionView` 更早处求值）；6c 若把 composer 装配后置，可换回纯 `var` 别名。
