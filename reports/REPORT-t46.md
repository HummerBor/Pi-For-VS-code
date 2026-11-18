# REPORT-t46：webview 拆分第 6 刀 · 子刀 6c-2——视图工厂 + handleMsg（整场收官）

**状态：已完工，可验收。**
**本单 commit：`5a4a456`**（`refactor(webview): 视图工厂 + handleMsg 整块搬进 features/sessionView.ts（第 6 刀 6c-2，主文件 844→368）`）
**回退：`git revert 5a4a456`**（单提交、只碰两个文件：`webview/features/sessionView.ts` 新建 + `webview/main.ts` 手术；无迁移、无协议变更、无 `src/` 改动、无 `harness/` 改动，revert 即回到 844 行原状）
**提交自检：`git show --stat HEAD` = 2 files changed（`sessionView.ts` +624 新建 / `main.ts` +33 −509），无他人文件混入，未 push。**

---

## 一、搬了什么（行号 = `HEAD~1`，即 844 行那版）

| 组 | 内容 | 行 | 备注 |
|---|---|---|---|
| A | `makeSessionView` 头注释（三期整树搬迁六步法） | 70–76 | 整段随工厂进模块（事故 lore 一个字没动） |
| B | 工厂骨架：建视图 + `protoHTML` 注入 + `q()` + 下区元素查询 + `changesPage`/`ctxPop`/`vpost` 装配 | 77–105 | 新增 2 处 getter（原型快照/容器，见第三节） |
| C | 10 个 per-view 模块装配（composer / sticky / toolRows / liveStream / statusBar / outline / messageList / renderQueue）+ 各模块别名 | 106–411 | 装配顺序与 HEAD 逐行一致 |
| D | `handleMsg`（整条 if/else 分派链，**原样搬**：35 个 `m.type` 分支 / 40 行 if-else） | 412–518 | 分支、行序、注释零改动 |
| E | 滚动跟随（`followingEnd`/`suppressScroll`/`scroll`）、队列条（`addQueuedDom`/`addQueued`/`renderNativeQueue`/`removeQueued`/`rebuildQueuebar`）、回溯（`histIdx`/`histDraft`/`histNav`）、`renderCodeChip`、`bindComposerOnce`、`bindViewEvents` | 258–401 | 与 D 交错分布，整块一起走 |
| F | 视图尾部：`try { bindViewEvents() } catch { reportWvError } finally { bindComposerOnce() }` + `return {...}` + `dispose` | 519–559 | R2/R3 命脉，逐字未动 |

搬入块合计 **490 行**，由脚本从 `git show HEAD:webview/main.ts` 机械切段（`scripts/.preview/t46-build.mjs`，
`.preview/` 已 gitignore），只做第三节列出的 8 处换名，**不手抄一行**。

main.ts 保留（派单 §二点名的清单，一个字没删）：IIFE 引导、`vscode`/`vscodeApi` 上行桥、`reportWvError` 红字桥、
`sentHistory`、`initSessionView` 装配（33 行）、`initTabs` 装配、`ICON_PATHS`/`ico`/`esc`/`elIco`/`shorten`/`el`、
`sessionArea`/`protoHTML`、`linkifyEnabled` 总闸 + `initLinkify`/`initMarkdown`、头部元素与绑定、欢迎页/鸭子、
`TIPS`/`pickTip`、凭证页整块（`authLocked`）、`subDock` 实例与 `bind()`、剪贴板/拖放、`webviewReady`。

### 行数账

```
main.ts        844 → 368   （净 −476；diff 实测 +33 / −509）
sessionView.ts 新建 624 行（搬入块 490 + 文件头/deps 接口/注入别名/页面级数据声明/收尾 134）
```

**两张总账：**

**① 第 6 刀（页签 / 视图工厂 + 事件路由）：1136 → 368**

| 子刀 | commit | main.ts |
|---|---|---|
| 6 刀起点（第 5 刀收官） | `13a5304` | 1136 |
| 6a 页签与路由 | `7d8703c` | 1027 |
| 6c-1 状态行/页脚/横幅 | `dd2467d` | 844 |
| **6c-2 视图工厂 + handleMsg（本单）** | **`5a4a456`** | **368** |

第 6 刀净 **−768 行（−67.6%）**，其中本单 −476。

**② 整场拆分：3269 → 368（−2901 行，−88.7%）**

| # | 刀 | commit | main.ts |
|---|---|---|---|
| — | 起点 | `b8d0eca~1` | 3269 |
| 1 | 变更页 → `features/changesPage.ts` | `b8d0eca` | 3116 |
| 2 | 上下文用量弹层 → `features/ctxPopover.ts` | `75d5c3c` | 2685 |
| 3 | 子 agent 浮窗 → `features/subagentDock.ts` | `724cc1a` | 2229 |
| 4 | 输入区 → `features/composer.ts` | `bcf9ded` | 1934 |
| 5a | 渲染基座/路径可点 → `markdown.ts` / `linkify.ts` | `921e922` | 1806 |
| 5b | live 流式 → `features/liveStream.ts` | `35ba761` | 1659 |
| 5c | 工具行 → `features/toolRows.ts` | `e8804ed` | 1534 |
| 5d+5e | 整树重绘 + 粘性气泡 → `messageList.ts` / `sticky.ts` | `2e0e07f` | 1244 |
| 5g | 消息大纲轨道 → `features/outline.ts` | `9283f3f` | 1164 |
| 5f | 渲染队列 → `features/renderQueue.ts` | `13a5304` | 1136 |
| 6a | 页签与路由 → `features/tabs.ts` | `7d8703c` | 1027 |
| 6c-1 | 状态行/页脚/横幅 → `features/statusBar.ts` | `dd2467d` | 844 |
| **6c-2** | **视图工厂 + handleMsg → `features/sessionView.ts`** | **`5a4a456`** | **368** |

### 为什么是 368 而不是派单估的 ≈250（差额账，不含揣测）

派单 §二明确「页面级工具与常量（`el`/`ico`/`esc`/`elIco`/`shorten`、`TIPS`、`slashCmds`、
`authLocked`、`lastSelText` 等）留在 main.ts 经 deps 注入」——这些就是差额的来源，也正是 SCOUT 表里
**6b（页面级 chrome，≈250 行，标注「可跳」）** 的范围：

| 未搬项（属 6b） | 行数 |
|---|---|
| `ICON_PATHS` + `ico` + `esc` + `elIco` + `shorten` | ≈57 |
| 欢迎页/鸭子（`welcomeEl`/`welcomeHTML`/`duckUriNow`/`applyDuck`/`duckInto`/`TIPS`/`pickTip`） | ≈30 |
| 凭证配置页整块（`authLocked`/`applyAuthLock`/`closeAuthPanel`/`renderAuthProviders`/`showAuthPanel` + 绑定 IIFE） | ≈100 |
| 头部元素查询与绑定（`sessionEl`/`moreEl`/`subindEl`/`newChatEl`/`historyEl` + 4 条监听） | ≈20 |
| 剪贴板兜底 / `dragover` / `drop` / `lastSelText` | ≈25 |

即：**6c-2 按派单边界做到位 = 368；要到 ≈250 必须再开 6b（≈230 行）**。派单里的 ≈250 是
SCOUT 4.1 表「main.ts 只剩 IIFE 引导 + import 装配」的乐观口径，漏了同一张表标为「6b 可跳」的那部分。
本单没有为凑数字越界搬任何东西（`git show --stat` 可证只碰两个文件）。

## 二、状态归属（派单红线三的兑现方式）

| 状态 | 唯一持有者 | 通道 |
|---|---|---|
| `histIdx`/`histDraft` | **sessionView.ts**（`makeSessionView` 闭包，per-view） | `bindComposerOnce` 正文里的裸赋值**一字未改**（R3）；composer 经 `deps.resetHist` / `deps.histNav` 转调 |
| `queuedItems`/`nativeQueuePills`、`followingEnd`/`suppressScroll`、`built`、`composerBound`、`queueN`/`compacting`/`modeText`/`banner`/`changes`/`bootPending` | **sessionView.ts**（同一闭包，per-view） | 原先就只有这块代码读写，随块走 |
| `sentHistory` | **main.ts**（页面级，跨页签一份） | `deps.history` 注入**数组引用**，模块只读写同一份数组（不复制），与 4 刀注释口径一致 |
| `codeCtx`/`codeOn`/`slashCmds`/`workspaceFiles` | **sessionView.ts 的 `initSessionView` 闭包**（页面级，唯一一份） | 详见下条 |
| 各 per-view 模块内部状态（busy 秒表、在途气泡、工具行索引、渲染队列定时器…） | 各自模块（6c-1 / 5x 已定） | 本单只搬装配点，模块本身一行没动 |

**为什么 `codeCtx`/`codeOn`/`slashCmds`/`workspaceFiles` 是「搬进模块」而不是「deps 注入」**：
这四个量的写口全在 `handleMsg`（`codeCtx = m.ctx` / `slashCmds = m.commands || []` /
`workspaceFiles = m.files || []`）和 `bindViewEvents`（`codeOn = !codeOn`）。走 deps getter/setter
就必须把这几行改写成 `setCodeCtx(m.ctx)` 之类——直接违反本单最高优先级红线
「`handleMsg` 逐字零差异」（验收门第 3 条）。两者不可兼得时按派单优先级取逐字：
**把「写口所在代码」和「状态」放在同一个文件**（本模块页面级闭包，不是视图副本），
main.ts 不再持有、也没有第二份。若总监认为必须反向（状态留 main.ts、正文改 4 行），
这是一个明确的二选一，请示下后我按新口径重做，改动面就是那 4 行 + 6 个 deps。

## 三、逐字核对（搬入块归一化后**零差异**）

脚本：`node scripts/.preview/t46-verbatim.mjs`（不进库；对照基线默认 `5a4a456~1`，即手术前的 844 行那版）。
做法：把 `sessionView.ts` 里的搬入块（490 行）反向归一化 8 处换名后，与基线的 70–559 行逐行比对。

```
整块核对：HEAD 490 行 / sessionView 搬入块 490 行 / 差异 0 行

单函数核对（HEAD vs 现在，逐行）：
  handleMsg          HEAD  107 行 / 现在  107 行 / 差异 0
  bindComposerOnce   HEAD   18 行 / 现在   18 行 / 差异 0
  bindViewEvents     HEAD   35 行 / 现在   35 行 / 差异 0
  renderCodeChip     HEAD    7 行 / 现在    7 行 / 差异 0
  scroll             HEAD    9 行 / 现在    9 行 / 差异 0
  addQueuedDom       HEAD   18 行 / 现在   18 行 / 差异 0
  addQueued          HEAD    4 行 / 现在    4 行 / 差异 0
  renderNativeQueue  HEAD   12 行 / 现在   12 行 / 差异 0
  removeQueued       HEAD    5 行 / 现在    5 行 / 差异 0
  rebuildQueuebar    HEAD    4 行 / 现在    4 行 / 差异 0
  histNav            HEAD   17 行 / 现在   17 行 / 差异 0
```

归一化只有 8 处（全是「跨文件后必须经 deps 注入的外部引用」，语义/位置/顺序全不动）：

| 换名 | 处 | 理由 |
|---|---|---|
| `protoHTML` → `getProtoHTML()` | 1（`view.innerHTML`） | 原型快照在 main.ts 的 `protoView.outerHTML` 之后才有值，而本模块装配在 `initTabs` 之前（`initTabs` 要先拿 `makeView`）→ getter |
| `sessionArea` → `getSessionArea()` | 1（`appendChild`） | 同上（同一段启动期一次性快照） |
| `linkify: linkify` → `getLinkify()` | 1（toolRows 装配） | `initLinkify` 晚于本装配点（R18 上游链路），→ getter |
| `renderRich: renderRich` → `getRenderRich()` | 1（liveStream 装配） | `initMarkdown` 晚于本装配点 → getter |
| `esc+linkify+renderRich` → `getLinkify()/getRenderRich()` | 1 行 2 处（messageList 装配） | 同上 |
| `getSessionEl: function () { return sessionEl; }` → `getSessionEl: getSessionEl` | 1（statusBar 装配） | 页头是页面级、初始化更晚；注入方式从「现场包一层 getter」变成「直接用 main.ts 的 getter」，取值语义相同（6a initTabs 同款） |
| `subDock: subDock` → `getSubDock()` | 1（statusBar 装配） | 子 agent 浮窗实例在 main.ts 中段才建 → getter |
| `welcomeHTML: welcomeHTML` → `getWelcomeHTML()` | 1（messageList 装配） | 欢迎页快照在 `protoView` 之后才取 → getter |

`handleMsg` 的 35 个 `m.type` 分支、`bindComposerOnce`（含 `histIdx/histDraft = -1/''` 裸赋值）、
`bindViewEvents` 全文、`try/catch/finally` 顺序、`dispose` 六步顺序 —— **零差异**（上表可证）。

**没有做的事（派单红线五）**：`applyState` 只认 `⏱` 前缀、`roundFrozen` 被 state 帧清掉
这两条 6c-1 记录的既有口径问题，一个字没碰（`git show` 可证 `statusBar.ts` 不在本单 diff 里）。
`handleMsg` 里 `else if (m.type === 'tabs') handleTabs(m)` 这条**不可达分支**（R15）也原样保留——
它是判序契约的一部分，不是死代码清理对象。

## 四、验证

### 1. `npm run compile` 三段全绿（本单跑 3 次全量 compile：模块落地后、main.ts 接线后、提交前；另 2 次 `tsc -p webview` 单点检查）

```
vendor-pi（内置 pi 1.5.0 拷贝 + 三项冒烟）  → OK
typecheck:webview (tsc -p webview --noEmit)  → 0 error
build:webview (vite ×2)                      → ✓ built（main 121.52 kB / sessions 49.93 kB）
tsc -p ./                                    → 0 error（exit 0）
```

### 2. 全套回归同数（16 组，逐项与改动前一致）

| 组 | 本次 | 基线 |
|---|---|---|
| linkify | 22 项全过 | 22 |
| changespage | 10 passed | 10 |
| ctx | 13 passed | 13 |
| detail | 27/27 | 27 |
| usage | 14 passed | 14 |
| price | 11 passed | 11 |
| errclass | all passed | all passed |
| diffview | 7 passed | 7 |
| subagent | 50 项全过 | 50 |
| replay | 19 项全过 | 19 |
| jsonltail | 7/7 | 7 |
| liveness | 10/10 | 10 |
| docktime | 7 passed | 7 |
| html | OK（资源路径正确，156071 字节） | OK（6c-1 时 155250） |
| migration | 用例全过 | 全过 |
| revert | 12 项全过 | 12 |

注：`test:html` 的字节数 = 内联进 HTML 的 `dist/webview/main.js` 大小（该用例只校资源路径），
随模块拆分自然增长（main.js 120.71 kB @6c-1 → 121.52 kB），非口径变化。

### 3. headless 真机替代探针（25 项全过 ×3 轮稳定）

`node scripts/.preview/t46-probe-view.mjs`（`.preview/` gitignore，不进库；复用 `t45-probe-statusbar.mjs`
的 CDP 骨架 + `dist/webview/preview.html` 桩，视图选择器取 `#session-area > .session-view` 顶层）：

```
PASS ① 视图已建（initSessionView 装配没抛）[1]
PASS ① bindComposerOnce 已执行（input disabled=false，命脉绑定没丢）
PASS ① webview 内无未捕获错误回传
PASS ② 点发送 → prompt 上行（bindComposerOnce 命脉活）×2（含 tabId=t1）
PASS ③ user 帧 → .bubble.user
PASS ④ delta 帧进在途气泡 / thinking 帧进思考块
PASS ⑤ toolStart 建工具行 / toolEnd 落成 .tool.ok（同 id 合并）
PASS ⑥ busy 帧 → 状态行进 Working（statusBar 经新装配仍活）
PASS ⑦ 切到 t2 → 第二视图建出来 / t1 转后台 / 页头标题跟宿主清单 / t2 是干净新视图
PASS ⑧ 后台页签（t1）自己收帧，且不串到活动页签（t2）
PASS ⑨ 后台页签 fillInput 被挡（6a 判序契约未变）
PASS ⑩ 切回 t1 可见 / 后台累加的现场切回即现 / 活动页签 fillInput 正常回填
PASS ⑪ queuedAdd → 队列条 pill / queuedRemove → 撤掉
PASS ⑫ 关 t2 → 视图 dispose 摘 DOM / 关页签后活动视图仍能收帧
```

### 4. 结构判据

- **双绑自检（R14）**：`addEventListener` 总数 HEAD 30 → 现状 `main.ts + sessionView.ts` 30（逐条对应，无新增无丢失）；
  `sendBtn`/`input`/`stopBtn`/`fileInput`/`modelEl`/`thinkEl`/`modeBadge`/`codechipEl` 的绑定从 main.ts 整段移出，main.ts 侧无残留。
- **R18 元素查询纪律**：`sessionView.ts` 内 `document.getElementById` **0 处**（视图元素一律走 `q()`）；
  `sessionArea`/`protoHTML` 经 getter 取，模块内不持引用。
- **状态单份**：`grep -rn "var codeCtx\|var codeOn\|var slashCmds\|var workspaceFiles\|var sentHistory\|var histIdx\|var followingEnd" webview/`
  → 这四个页面级量只在 `sessionView.ts`，`sentHistory` 只在 `main.ts`；`composer.ts` 里的是同名**只读局部**
  （`deps.getSlashCmds()` / `deps.getFiles()` 的取值缓存）与 `deps.history` 别名，不是第二份。
- **跨边界协议**：`src/core/protocol.ts` 零改动（本刀纯搬家，无新消息类型）。

## 五、行为差异

**本单零行为差异**（除了下面两条结构性说明）。`handleMsg` / `bindComposerOnce` / `bindViewEvents` /
`scroll` / 队列条 / 回溯 / `renderCodeChip` / `dispose` 全部逐字零差异，探针的 25 项覆盖了
视图创建、四类消息分派、页签切换归属、发送命脉、状态行与关页签回收。

1. **装配位置**：`initSessionView(...)` 落在原 `function makeSessionView(id)` 声明处（IIFE 前段），
   `initTabs({ makeView: sessionView.makeView })` 仍在其后——启动期一次性快照（`sessionArea`/`protoHTML`/
   `linkify`/`renderRich`/`sessionEl`/`subDock`/`welcomeHTML`）全部经 getter / 转发器延迟到「调用时现取」，
   与 6a `initTabs` 的注入口径一致。**首个视图的创建时机不变**（仍是第一条消息/`activateTab` 驱动）。
2. **`tabs` 三件转发**：`routeMsg` / `handleTabs` / `renderCodeChipAll` 由 main.ts 的转发器注入（`tabs` 是
   `var`，装配顺序上必然晚于本模块），调用时现取——语义等价于原 main.ts 里的别名。

## 六、遗留债（**不在本单范围**，请总监决定是否立票）

1. **6b 未做**：main.ts 还留 ≈230 行页面级 chrome（见第一节差额账）。要到派单目标的 ≈250 行，必须开 6b。
2. **注释指代漂移**（`features/*.ts` 的 deps 文档里「住 main.ts」）：本次把 `scroll` / `followingEnd` /
   `histIdx` / `histDraft` / `histNav` / `codeCtx` / `codeOn` / `slashCmds` / `workspaceFiles` 搬进
   `sessionView.ts` 后，下列注释里的「main.ts」应读作「features/sessionView.ts」（本单未扫，避免 commit 溢出）：
   `composer.ts` 10/14–16/20/52/54/62/321、`liveStream.ts` 9/16/42/210、`messageList.ts` 44/59/61、
   `sticky.ts` 10/120、`statusBar.ts` 13/20–21/61/64/67/70/112、`changesPage.ts` 184、`ctxPopover.ts` 468。
   其中 `messageList.ts` 59/61（大纲 5g 已搬）、`liveStream.ts` 210（`flushRender` 5f 已搬）、
   `composer.ts` 62 / `321`（`lastNotice` 5d 已搬）属**本单之前就存在**的漂移，一并列出供一次性清理。
3. `sessionView.ts` 搬入块里两条**到期注释**（按零差异原则原样保留，未改）：
   「handleMsg 整体搬迁是下一单 6c-2 的事」（6c-1 留的，本单已兑现）；
   「routeMsg 留本文件（6a 才搬）」（6a 之后已过期）。
4. 6c-1 记录的两条既有口径（`applyState` 只认 `⏱` 前缀 / `roundFrozen` 被 state 帧清掉）仍待立票。

## 七、真机清单（**待用户**）

1. 发消息 / 回车 / 点发送（`bindComposerOnce` 命脉在模块里，盯「点了没反应」是否再现）。
2. 流式正文 + 思考块 + 工具行（IN/OUT、同名成组、失败态）。
3. 多页签来回切：各自消息树、状态行、页脚、横幅、队列条互不串台；后台页签累加、切回即现。
4. 换模型 / 换思考档位 / 换模式（页脚 chip 与 `pickModel`/`pickThinking`/`pickMode` 上行）。
5. 中止（Esc / stop 按钮）、重试、`↑↓` 输入历史回溯、`@` 引用文件、附件上传。
6. 压缩会话（浮动条 + 状态行压缩标签压过 Working）、切历史会话 / 新建 / 关页签（视图 dispose）。
7. 子 agent 派单全链路（浮窗、状态行 chip、队列回报 pill）。
8. 代码上下文 chip（`codeCtx` 帧 → 三视图全刷、点 chip 开关）。
9. 变更页开关（Esc 先关浮层再关页）+ 本轮变更条。

---

### 施工侧备注（非验收项）

- 本单只交 `webview/` 两个文件 + 本报告；`BUILDER.md` 未改（与 6a/6c-1 一致：细节回报落在 `reports/`）。
- 提交纪律：`git add -- webview/features/sessionView.ts`（新文件显式加）+ `git commit -- <两个路径>`，
  未用 `git add -A`；`git show --stat HEAD` 自检文件集 = 2，无他人文件（工作树里 `dispatch-*.md` /
  `reports/SCOUT-*.md` 是他人的未跟踪件，未暂存）。本报告单独一笔 `docs(t46)` 提交（与 6c-1 的
  `dd2467d` + `dabfe8e` 两笔口径一致），代码回退只需 `git revert 5a4a456`。
- 生成/核对脚本在 `scripts/.preview/`（gitignore，不进库）：`t46-build.mjs`（切段生成）、
  `t46-surgery.mjs`（main.ts 手术）、`t46-verbatim.mjs`（逐字核对）、`t46-probe-view.mjs`（CDP 探针）。
