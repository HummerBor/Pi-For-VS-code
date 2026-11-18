# REPORT-t45：webview 拆分第 6 刀 · 子刀 6c-1——状态行 / 页脚 / 横幅

**状态：已完工，可验收。**
**本单 commit：`dd2467d`**（`refactor(webview): 状态行/页脚/横幅搬进 features/statusBar.ts（第 6 刀 6c-1，主文件 1027→844）`）
**回退：`git revert dd2467d`**（单提交、只碰两个文件，无迁移、无协议变更、无 `src/` 改动，revert 即回到 1027 行原状）
**提交自检：`git show --stat HEAD` = 2 files changed（`webview/features/statusBar.ts` +338 新建 / `webview/main.ts` +35 −218），无他人文件混入，未 push。**

---

## 一、搬了什么（行号 = `HEAD~1`，即 1027 行那版）

| 组 | 函数 / 变量 | HEAD 行 | 行数 | 去处 |
|---|---|---|---|---|
| A | `setStatus` + N 刀注释 + `bootTickTimer` / `bootTickStart` | 271–277 | 7 | `features/statusBar.ts`（模块独占） |
| — | `bootPending` 声明 + B 刀注释 | 278–281 | 4 | **留在 main.ts**（写口在 `handleMsg` 的 uiState 分支），注释整段随变量走 |
| B | `startBootTick` / `stopBootTick` / `renderStatus` / `renderBanner` / `renderChanges` / `fmtDur` / `renderBusyUi` / `setBusy` / `setCompacting` | 282–431 | 150 | 同模块（`busyTimer` / `busyStart` / `lastElapsed` / `roundFrozen` 一并独占） |
| C | `fmtSession` + `applyState` | 513–563 | 51 | 同模块 |

搬入代码合计 **208 行**，全部由脚本从 `git show HEAD:webview/main.ts` 机械切段（`scripts/.preview/t45-build.mjs`，
`.preview/` 已 gitignore），只做下面第二节列出的 6 类换名，不手抄一行。

main.ts 保留：`initStatusBar(deps)` 装配（35 行，含注释）+ 10 个别名
（`setStatus / startBootTick / stopBootTick / renderStatus / renderBanner / renderChanges / setBusy / setCompacting / renderBusyUi / applyState`），
`handleMsg` 里 12 处调用点**一个字符都没动**（见第四节自检）。

### 行数账

```
main.ts    1027 → 844   （净 −183；diff 实测 +35 / −218）
statusBar.ts  新建 338 行（搬入块 208 行 + 文件头/deps 接口/装配骨架/独占状态声明 130 行）
```

派单预估「≈870」，实测 844（差 26）。差额来自勘察口径：`handleMsg` 分支里那几行「状态行相关」的
语句（`queueN = …` / `compacting = m.compacting === true` / `renderStatus()` / `setBusy()` …）
**按红线属 6c-2，本单不碰**，而勘察估算时把它们算进了这块；反过来装配块 + 别名比预估多 12 行。
没有为凑数字塞/删任何东西。

### 状态归属（红线四「状态不许复制」的兑现方式）

| 状态 | 唯一持有者 | 理由 / 通道 |
|---|---|---|
| `busyTimer` `busyStart` `lastElapsed` `roundFrozen` `bootTickTimer` `bootTickStart` | **statusBar.ts** | 原先只有本块读写（写口全在 `setBusy` / `renderBusyUi` / `startBootTick` / `dispose`），随块独占 |
| `queueN` `compacting` `modeText` `bootPending` | **main.ts** | 写口在 `handleMsg`（本单不许碰）；模块经 `deps.getQueueN/getCompacting/getModeText/getBooting + setCompactingFlag/setBootingFlag` 读写**同一份内存**，两边零副本（照 6a `getTabsList` / `setFollowingEnd` 先例） |
| `S.busy` | `core/state.ts` 的 ViewState（`deps.state`） | 直接注入同一对象，模块里仍写 `S.busy`（零改名） |

## 二、逐字核对（搬走的三块归一化后**零差异**）

脚本：`node scripts/.preview/t45-verbatim.mjs`（不进库）。做法：HEAD 的 271–277 / 282–431 / 513–563
三段拼起来 vs `statusBar.ts` 里搬入块，只把**跨文件引用换名**反向归一化后逐行比对。

```
HEAD 块 208 行 / statusBar 块 208 行 / 差异 0 行
```

归一化只有 6 类（跨文件后这些符号必须经 deps 注入；语义/位置/顺序全不动）：

| 归一化替换 | 处数 | 理由 |
|---|---|---|
| `modeText` → `getModeText()` | 1（`renderStatus`） | 写口在 main.ts `handleMsg`，只读注入 |
| `compacting` → `getCompacting()` / `compacting = v` → `setCompactingFlag(v)` | 5 读 + 1 写 | 同上；写口一在 `handleMsg`、写口二在 `setCompacting` |
| `queueN` → `getQueueN()` | 1 行 2 处 | 写口在 `handleMsg`；**秒表每拍现读**（不是渲染时快照，排队数变了要跟着动） |
| `bootPending` → `getBooting()` / 赋值 → `setBootingFlag(...)` | 3 读 + 1 写 | `applyState` 也要落这个标记（写口二） |
| `vscode.postMessage(` → `postPage(` | 3（横幅 2 + 变更条 1） | 页面级上行打标桥留在 main.ts；**没改成 `vpost`**——两个通道语义不同，不许合并 |
| `sessionEl.` → `getSessionEl().` | 2（`applyState`） | 页头元素页面级、初始化晚于视图构建 → getter（tabs.ts 同款） |

`vpost({type:'showChanges'})` / `changesPage.open()` / `ctxPop.refreshUsage()` / `S.busy` / `id` / `ico` /
`esc` / `L` / `finalizeLive` / `liveReset` / `fmtDur` / `statusEl` / `bannerEl` / `changesBarEl` / `stopBtn`
**全部零改名**（同名注入或同名局部声明），所以 diff 里看不到它们。

## 三、验证

### 1. `npm run compile` 三段全绿

```
vendor-pi（内置 pi 1.5.0 拷入 + 三项冒烟）  → OK
typecheck:webview (tsc -p webview --noEmit)  → 0 error
build:webview (vite ×2)                      → ✓ built（main 120.71 kB / sessions 49.93 kB）
tsc -p ./                                    → 0 error
```

### 2. 全套回归同数（15 组，改动前后逐项一致）

| 组 | 本次 | 基线（改动前实跑） |
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
| html | OK（资源路径正确） | OK |
| migration | 用例全过 | 全过 |
| （附加）revert | 12 项全过 | 12 |

注：`test:html` 打印的 HTML 字节数 154260 → 155250（+990，模块包装 + deps 装配；该用例只校资源路径）。
`scripts/test/smoke-boot.mjs` 的 ②「首帧带快路径历史」在**改动前就是 FAIL**（该冒烟只跑宿主侧
`piCore/panel` 等价流程，不加载任何 webview 代码；本单只碰 `webview/`，文件集 `git show --stat` 可证），本单未引入也未修。

### 3. 真机替代探针（headless Chrome 跑真实 webview，26 项全过 ×3 轮稳定）

`node scripts/.preview/t45-probe-statusbar.mjs`（`.preview/` gitignore，不进库；复用
`scripts/probe/probe-live-merge.mjs` 的 CDP 骨架 + `dist/webview/preview.html` 桩）：

```
PASS 视图已建（initStatusBar 装配没抛）[2 个视图]
PASS ① status 帧直接上屏 / 启动秒表 1.2s 后走秒 / 秒表态不带 busy 类
PASS ② booting 占位帧不清状态行（B 刀守卫）
PASS ③ busy 帧进 Working / busy 类 / stop 按钮显形
PASS ④ 排队数进状态行（queue 帧 → 「· 排队 2 条」，证明 getQueueN 现读生效）
PASS ⑤ 压缩中标签压过 Working；压缩结束回 Working（优先级未改）
PASS ⑥ 收尾冻结成白字时长 + done 类 + title=本轮耗时
PASS ⑦ 模型 chip / 思考档位 / 页头会话名（getTabsList → getSessionEl 两跳都对）/ 页脚圆环「82% · $0.920」
PASS ⑧ 横幅显示 → 关闭按钮走 postPage → bannerClose 后隐藏
PASS ⑨ 变更条显示 + 主入口 changesPage.open() 注入生效（页内打开）
PASS ⑩ busy 收尾后状态行仍可重渲（ticker 归属模块后不卡死）
```

⑦ 里发现一条**既有口径**（逐字未改，只做记录）：`applyState` 的守卫是
`statusEl.textContent.indexOf('⏱') !== 0` 才 `setStatus('')`，而 `roundFrozen` 是纯时长（`0s` / `1m23s`，
不带 `⏱` 前缀），所以 state 帧会把刚冻结的用时清掉。HEAD 同样如此（搬入块逐字零差异 = 同一条代码路径），
**不是本单引入**，也不在本单范围内改动；若总监认为该修，建议单独立票（涉及"冻结用时该不该被 state 帧清"的产品口径）。

### 4. 结构判据

- **`handleMsg` 逐字未变**：脚本切出 HEAD 与现在的 `handleMsg` 全文 → `HEAD 107 行 / 现在 107 行 / 差异 0 行`
  （下一单 6c-2 的整体搬迁对照基线完好）。
- **状态单份**：`grep -rn "var busyTimer\|var busyStart\|var lastElapsed\|var roundFrozen\|var bootTickTimer\|var bootTickStart" webview/`
  → 只在 `features/statusBar.ts`（5 处声明）；`var queueN|var compacting|var modeText|var bootPending`
  → 只在 `main.ts`（各 1 处）。
- **双绑自检（R14）**：`statusBar.ts` 里 `addEventListener` **0 处**（横幅/变更条的按钮是每次渲染新建的
  节点 + `onclick` 赋值，与 HEAD 同款，节点重建即换代，不存在累积绑定）；`main.ts` 的
  `addEventListener` 集合与 HEAD 逐一对应，无新增无重复。
- **元素查询纪律（R18）**：模块内零 `document.getElementById`，7 个元素全经 `deps.q`（视图内查询）。
  两处重复查询的是 `#model` `#think` `#modebadge` `#stop`（事件绑定仍在 main.ts 的 `bindViewEvents`），
  同一个节点的两份引用，不是两份状态。
- **数据来源未改**：页脚仍只吃宿主 `ctxDetail` 真值帧（`ctxPop.refreshUsage/applyDetail` 调用点原位），
  `usage` 换算仍在 `src/domain/usageTotals.ts` + `ctxPopover.ts`；busy 心跳仍是「state/uiState 帧驱动 +
  tab 激活 `refreshBusy`」，4s pendingPrompt 兜底（`src/core/piCore.ts`）零改动。

## 四、行为差异（本单唯一一处，附理由）

1. **`dispose` 多停一只秒表**：HEAD 的视图 `dispose` 只 `clearInterval(busyTimer)`，**没清 `bootTickTimer`**
   ——启动秒表的 ticker 挂在已摘除的 DOM 上会一直跑到自守卫条件（状态行文本不再以 base 开头）为止，
   实际会永久跑（文本一直是 `base + ' Ns'`）。本单按勘察 R19「谁创建谁清」把两块秒表都交给
   `statusBar.dispose()`（`clearInterval(busyTimer)` + `stopBootTick()`）。**无用户可见变化**（写的是
   已摘除节点），只是堵掉每页签一只的泄漏。
2. **装配位置**：`initStatusBar(...)` 落在原「`var busyTimer/busyStart/queueN…` 声明块」的位置
   （`liveStream` 之后、`built` 之前）。该位置的 deps 全部已就绪（`changesPage` 95 行 / `ctxPop` 101 行 /
   `liveStream` 144 行）；`subDock` / `sessionEl` 是页面级、初始化晚于**视图构建**（视图只在消息路由时
   才建），故 `subDock` 直接给引用、`sessionEl` 给 getter——与 6a `initTabs` 的注入口径一致。
3. 除上面两条，**没有任何语义改动**：消息判序、状态行优先级（compacting > busy > 冻结 > boot 占位）、
   Working 秒表与子 agent 累计口径、横幅/变更条的 `postMessage` 通道选择、页头「宿主 tabs 优先、
   `fmtSession` 兑底」的口径全部零改（第三节逐字核对可证）。

## 五、真机清单（**待用户**）

1. 页脚百分比 / 花费实时跟手（干活时数字在动，不是 hover 弹层才动）。
2. 状态行 Working 秒表正常走秒；主回合结束后变白字本轮总用时，不再跳变。
3. 压缩中标签（⏳ 正在压缩上下文…）压过 Working，压缩结束自动回 Working / 收尾。
4. 启动占位期（「pi 后台启动中…」）不被 state/uiState 帧擦掉；启动结束能收表。
5. 4s pendingPrompt 兜底不误报（发消息后面板不永久卡 busy）。
6. 顶端横幅：显示 / 一键压缩 / ✕ 关闭；**切页签后不残留、不串页签**。
7. 本轮变更条：✦ N 个文件 / 查看改动（开变更页）/ 清单（QuickPick）/ ✕；新 run 后清单刷新。
8. 多页签来回切：各自状态行、页脚模型名/思考档位、横幅互不串台；关页签后无残留秒表（CPU 不再空转）。

## 六、给下一单（6c-2）的交接

- `handleMsg` 现在**完全没动**（107 行逐字一致），可直接当 6c-2 的对照基线。
- `statusBar` 在 `makeSessionView` 里的装配对象就是下一刀要挪进 `sessionView.ts` 的那一层薄胶水；
  `initStatusBar(deps)` 的 deps 全是外部引用/回调，工厂搬迁时**只需改 import + 调用点位置**，模块本身不用动。
- 那 4 个「写口在 handleMsg」的量（`queueN` / `compacting` / `modeText` / `bootPending`）在 6c-2 搬完
  `handleMsg` 后可以一并收进模块（届时 `deps.getXxx/setXxxFlag` 六个通道可删一半），但**不要在本单这种
  「handleMsg 不动」的前提下提前收**，否则就是两边各存一份。
- `applyState` 的 `⏱` 前缀守卫是既有口径（见第三节 ④ 的说明），6c-2 别顺手"修"——要修先立票。
- 视图 `dispose` 现在依次是：`outline` → `ctxPop` → `statusBar`（两块秒表）→ `clearStreamTimer` →
  `renderQ` → 摘 DOM。6c-2 搬工厂时保持这个顺序（各自的 timer 归各自的 dispose）。

---

### 施工侧备注（非验收项）

- 本单只交 `webview/` 两个文件 + 本报告；`BUILDER.md` 未改（与 6a 一致：细节回报落在 reports/）。
- 提交纪律：`git add -- webview/features/statusBar.ts`（新文件显式加）+ `git commit -- <两个路径>`，
  未用 `git add -A`；`git show --stat HEAD` 自检文件集 = 2，无他人文件。未 push。
- 生成/核对脚本在 `scripts/.preview/`（gitignore，不进库）：`t45-build.mjs`（切段生成）、
  `t45-surgery.mjs`（main.ts 手术）、`t45-verbatim.mjs`（逐字核对）、`t45-probe-statusbar.mjs`（CDP 探针）。
