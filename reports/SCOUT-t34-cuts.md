# SCOUT-t34-cuts：main.ts 第 4/5/6 刀切口勘察（只读）

基准：`git show b706911:webview/main.ts`（2654 行）—— 派单时的 HEAD。

**侦察途中第 3 刀落盘了**（`724cc1a` refactor(webview): 子 agent 浮窗整块搬进
`webview/features/subagentDock.ts`）。`git diff b706911..724cc1a -- webview/main.ts` 的改动**全在
2045 行之后**（另加 566 行一处单行替换、两条 import，净行数零变化），所以：

- **1–2044 行的行号两版完全一致** —— 第 4 刀（≤1555）、第 5 刀（≤1887）的行号照旧可用，验证用
  `git show b706911:webview/main.ts | sed -n 'A,Bp'`；
- **第 6 刀区间一律按现行 HEAD 给号**，带 `@724cc1a` 后缀；两套号并存不是笔误。

---

## 〇、先钉三条结构事实（后面所有判断都建在这上面）

### F1. `makeSessionView` = 143–1762 行，一个闭包装下了本文件的 90%

2654 行里（现行 2229 行，同一闭包、同号），`makeSessionView(id)` 的函数体从 143 行开到大括号在
1762 行收（1763 空行，1764 行才是 `var views`）。
**坑：闭包里有一批机械搬迁留下的 2 空格缩进行**，按缩进判层级会判错：

| 行 | 内容 | 实际归属 |
|---|---|---|
| 171 / 174 / 187 / 260–281 | `toolEls`/`stickyQ`/`stickyIO`/`lastToolGroup`/`liveMsg`/`composerBound` … | **视图级**（在闭包内） |
| 282–334 | `bindComposerOnce` / `bindViewEvents` | **视图级** |
| 338–398 | suggest 状态 / `followingEnd` / 大纲轨道状态 | **视图级** |
| 1450 / 1559–1561 | `histIdx`/`histDraft` / 渲染队列三个 var | **视图级** |

真正的**页面级（模块级）**状态只有这几个（IIFE 顶层，143 行之前或 1764 之后）：
`vscodeApi`(23) `tabId`(27) `vscode`(28) `wvErrSeen`(37) `sentHistory`(59) `views`(1764) `tabsList`(1786)
`tabbarEl`(1787) `sessionArea`(1789) `protoView`(1790) `protoHTML`(1791) `ICON_PATHS`(1794) `FILE_RE`(1830)
`linkifyEnabled`(1853) `SYM_RE`(1881) `sessionEl`(1904) `moreEl`(1905) `subindEl`(1906) `newChatEl`(1907)
`historyEl`(1908) `codeCtx`/`codeOn`(1909) `welcomeEl`/`welcomeHTML`(1918-19) `duckUriNow`(1922) `TIPS`(1936)
`slashCmds`/`workspaceFiles`(1939-40) `authLocked`(1956) `subDock` 实例(2049@724cc1a)
`lastSelText`(2070@724cc1a) `pendingStream`(2092@724cc1a)。子 agent 浮窗那片状态
（SM_ICONS / subdock / subRunsByTab / subLedgerRows / SUB_STALE_MS …）已随第 3 刀搬进
`features/subagentDock.ts`，本文件只剩 `subDock.*` 转调点。

> 推论：**"搬函数"实际是"搬闭包成员"**。凡是被搬走的函数依赖的视图级变量，只有两条路——① 变成
> `init(deps)` 的 deps（外部持有、模块只读）；② 搬进模块当模块内状态（模块成为唯一持有者）。
> 同一份状态**不许两边各留一份**（第 1/2 刀的 `core/state.ts` 头注释已经把这条写成纪律）。

### F2. `handleMsg`(1601–1721) 是唯一消息分派点，横跨所有域

`routeMsg`(1777) → `viewFor(tid).handleMsg` → 121 行 if/else 链，同一个函数里同时改：
消息流（user/delta/thinking/tool*）、composer（fillInput 1671、queuedRetrieved 1682、addImages 1691、
addFiles 1708）、状态行（busy/status/compacting/mode）、页脚（uiState→applyState）、队列、
变更页、`ctxPop`、`tabs`。
**这是第 6 刀真正的难点**：不是"搬视图工厂"，而是把这 121 行拆成分域 dispatch。
在此之前任何一刀都不该动它（动了就把 4/5 两刀的回调面再搅一遍）。

### F3. 事件绑定两层，别混

- **页面级监听（只绑一次，活到 webview 死）**：`window.error/unhandledrejection`(49,52)、
  `document.keydown`→Esc 关浮层/关页(1766)、`document.keydown`→凭证页(2024)、＋菜单的
  `document.click`(337，实际是每视图建一次)、`document.selectionchange/copy`(2071,2075@724cc1a)、
  `window.dragover/drop`(2085,2088@724cc1a)、`window.message`(2190@724cc1a)。
  头部控件：`sessionEl`(2062@724cc1a) `moreEl`(2063) `subDock.bind()`(2066，原 subindEl/subchip
  两条绑定已搬进 subagentDock) `newChatEl`(2084) `historyEl`(1916)。注：`historyEl`(1916) 与 `sessionEl`(2062@724cc1a) 是**两个不同元素**发同一条
  `pickSession`（⏱ 与标题两个入口，刻意的）——搬迁时别误合并成一处，会丢一个入口。
- **视图级监听（每页签一套，随视图克隆）**：全部在 `makeSessionView` 内 —— `root.scroll`(1724 跟随 +
  476 大纲 spy)、`root.click`(1730 关 ctxPop)、`bindComposerOnce`(282)、`bindViewEvents`(301)、
  `document.click` 关 plusmenu(337)、`olRO = ResizeObserver(root)`(478)、各动态节点内联监听
  （toolStart 913、addUser 684/695、renderSuggest 1415-16、renderAttach 1349/1367…）。

---

## 一、函数总表（名 / 行 / 行数 / 依赖 / 调用方 / 事件绑定）

行号口径：无后缀 = `git show b706911:webview/main.ts`（与现行 HEAD 的 1–2044 行完全一致）；
带 `@724cc1a` = 第 3 刀落盘后的现行行号。行数含首尾行（含区间内注释）。"依赖"只列**跨函数/跨闭包**的状态，纯参数函数留空。

### 1.1 渲染基座（markdown / 工具 / linkify）

| 函数 | 行 | 行数 | 依赖 | 调用方 | 事件绑定 |
|---|---|---|---|---|---|
| `renderInline` | 69–79 | 11 | `document` | renderPlain, renderTable | 否 |
| `renderPlain` | 81–108 | 28 | `el` | renderRich | 否 |
| `renderTable` | 110–123 | 14 | `renderInline` | renderPlain | 否 |
| `renderRich` | 125–141 | 17 | `renderPlain`, `linkify`, `el` | addUser 670, makeCompaction 1065, appendFinal 814, setMdTail 824, renderAll 1133/1149 | 否 |
| `cleanPath` | 1836–1851 | 16 | — | linkify | 否 |
| `linkify` | 1854–1876 | 23 | `FILE_RE`, `linkifyEnabled`(页面级) | renderRich 141, notice 1032, toolStart 901/910, toolEnd 963/972, renderAll 1177（renderSubRow 已搬 features/subagentDock.ts） | 动态挂 `.fp` click |
| `linkifySymbol` | 1882–1887 | 6 | `SYM_RE` | linkify | 否 |
| `ico` | 1814–1816 | 3 | `ICON_PATHS`(页面级) | **全文件 60+ 处** | 否 |
| `el` | 1941–1945 | 5 | — | **全文件 100+ 处** | 否 |
| `esc` | 1818 | 1 | — | 变更页/ctxPop/页头/码片 | 否 |
| `shorten` | 1823–1827 | 5 | — | renderAttach 1352/1358、renderTabs 2550 | 否 |

### 1.2 消息流（live 流式 + 工具行 + 整树重绘）

| 函数 | 行 | 行数 | 依赖（视图级） | 调用方 | 事件绑定 |
|---|---|---|---|---|---|
| `imgsOf` | 647–655 | 9 | — | addUser, renderAll 1123 | 否 |
| `addUser` | 657–709 | 53 | `root`, `stickyQ`, `stickyIO`, `followingEnd`, `ico`, `el`, `L`, `vpost`, `renderRich`, `linkify` | handleMsg 1605, queuedDelivered 1679, renderAll 1124 | bubble click 684, thumb click 695 |
| `liveEnsure` | 759–762 | 4 | `liveDiv`,`liveMsg`,`liveParts`,`root` | liveBlock | 否 |
| `liveBlock` | 764–789 | 26 | 同上 + `pdet` | appendDelta/appendThink/applyLiveSync | tool 行 click 780 |
| `finalizeLive` | 791–805 | 15 | `liveParts` | newLive 1607, toolStart 分支 1614, liveBlock 768, setBusy 631, applyLiveSync 1579 | 否 |
| `liveReset` | 807 | 1 | `liveMsg/liveDiv/pdet/liveParts` | 1607, 1621, 1579, setBusy 631, renderAll 1072 | 否 |
| `appendFinal` | 810–814 | 5 | `renderRich` | finalizeLive, streamTick, applyLiveSync | 否 |
| `setMdTail` | 816–825 | 10 | `renderRich`, `el` | streamTick | 否 |
| `streamTick` | 827–872 | 46 | `appendFinal`,`setMdTail` | appendDelta 884 | 否 |
| `scheduleStream` | 874–880 | 7 | `liveRTimer`,`liveParts`, `scroll` | **无调用方（死代码，只在 66 行注释里被提到）** | setTimeout |
| `appendDelta` | 882–885 | 4 | `liveBlock`, `scroll` | handleMsg 1611 | 否 |
| `appendThink` | 887–895 | 9 | `liveBlock`, `scroll` | handleMsg 1612 | 否 |
| `applyLiveSync` | 1578–1599 | 22 | `live*`, `scroll` | flushRender 1575 | 否 |
| `toolStart` | 897–936 | 40 | `toolEls`(视图), `lastToolGroup`(视图), `ico`,`el`,`linkify` | handleMsg 1621, renderAll 1141 | 行 click 913 |
| `toolEnd` | 938–1017 | 80 | 同上 | handleMsg 1629, renderAll 1144 | 否（复用 start 的 click） |
| `textOf` | 1034–1043 | 10 | — | renderAll 1087/1106/1149 | 否 |
| `makeThink` | 1045–1051 | 7 | `el`,`L` | renderAll 1132 | 否 |
| `makeCompaction` | 1058–1067 | 10 | `el`,`L`,`renderRich` | renderAll 1168 | 否 |
| `notice` | 1025–1032 | 8 | `root`,`lastNotice`,`el`,`linkify`,`scroll` | handleMsg 1670, handleFiles 1300/1305/1320/1324, addImages 1698/1703 | 否 |
| `renderAll` | 1069–1188 | 120 | `root`,`olSuspend`,`toolEls`,`lastToolGroup`,`linkifyEnabled`,`welcomeHTML`,`seenCompactions`,`compactBarShownAt`,`queuebarEl`,`queuedItems`,`lastNotice` | flushRender 1573 | 否 |
| `renderCompact` | 1191–1208 | 18 | `root`,`compactbarEl`,`seenCompactions`,`compactBarShownAt` | renderAll 1188 | 按钮 onclick |
| `addQueuedDom` | 711–727 | 17 | `queuebarEl`,`ico`,`el`,`vpost`,`L` | addQueued 731, renderAll 1175, uiState 1653 | 取回 click 724 |
| `addQueued` | 729–731 | 3 | `queuedItems` | handleMsg 1678 | 否 |
| `renderNativeQueue` | 741–751 | 11 | `nativeQueuePills`,`queuebarEl` | uiState 1654, queue 分支 1668 | 否 |
| `removeQueued` | 753–756 | 4 | `queuedItems`,`queuebarEl` | 1679/1681/1684 | 否 |

### 1.3 粘性气泡 + 消息大纲轨道（跟着 addUser/renderAll/scroll 走）

| 函数 | 行 | 行数 | 依赖 | 调用方 | 事件绑定 |
|---|---|---|---|---|---|
| `updateStickyChip` | 188–193 | 6 | `L` | applySticky 236, addUser 684/698/708 | 否 |
| `stickyWants` | 195–204 | 10 | `root` | applySticky | 否 |
| `applySticky` | 208–236 | 29 | `root`,`updateStickyChip` | scroll 388, IO 回调 243 | 否 |
| `observeSticky` | 238–247 | 10 | `stickyIO`,`root` | addUser 707 | IntersectionObserver |
| `scroll` | 383–390 | 8 | `followingEnd`,`suppressScroll`,`stickyQ`,`id↔getActiveTabId`,`applySticky` | **全文件 30+ 调用点** | 否 |
| `outlineRebuild` | 399–430 | 32 | `olAnchors`,`olSuspend`,`olScan`,`olText`,`outlineEl`,`el`,`id↔activeTab` | addUser 709, renderAll 1078/1180 | 行 click 412 |
| `outlineResize` | 432–436 | 5 | `root`,`outlineEl` | olRO 479, outlineRebuild 428 | 否 |
| `olText` | 438–440 | 3 | — | outlineRebuild | 否 |
| `olScan` | 444–453 | 10 | `queuebarEl`,`root` | outlineRebuild | 否 |
| `olSpy` | 455–474 | 20 | `olAnchors`,`olSpyQueued`,`root`,`id↔activeTab` | root.scroll 476, olRO 480, outlineRebuild 430 | rAF |

### 1.4 输入区（第 4 刀主体）

| 函数 | 行 | 行数 | 依赖 | 调用方 | 事件绑定 |
|---|---|---|---|---|---|
| `bindComposerOnce` | 282–298 | 17 | `composerBound`(视图), `sendBtn`,`input`, `histIdx`,`histDraft`, 6 个函数 | makeSessionView finally 1739、bindViewEvents 327 | **绑 4 个监听**（命脉，见 R1/R3） |
| `bindViewEvents` | 301–334 | 34 | `changesPage`,`ctxPop`,`attachEl`,`pmUpload`,`pmAt`,`modelEl`,`thinkEl`,`modeBadge`,`codechipEl`,`fileInput`,`stopBtn`,`sendBtn`,`vpost`,`codeOn`,`renderCodeChipAll`,`handleFiles`,`ico`,`L` | makeSessionView 1735 | 9 个 addEventListener + 3 次委托（changesPage.bind / ctxPop.bind / bindComposerOnce） |
| `normPath` / `isTmpAttach` / `hasImg` / `hasFile` | 348 / 349 / 350 / 351–360 | 13 | `pendingImages`,`pendingFiles` | handleFiles, addImages/addFiles | 否 |
| `renderCodeChip` | 362–367 | 6 | `codeCtx`/`codeOn`(**页面级**), `codechipEl`,`ico`,`esc` | bindViewEvents 334, viewFor 返回, renderCodeChipAll, applyState? 否 | 否 |
| `handleFiles` | 1261–1333 | 73 | `pendingImages`,`pendingFiles`,`vpost`,`notice`,`renderAttach`,`has*` | fileInput change 329, inputPaste 1555, `window.drop` 2474 | 否（FileReader/Image 回调） |
| `renderAttach` | 1335–1372 | 38 | `attachbarEl`,`pending*`,`el`,`ico`,`esc`,`shorten` | handleFiles 1289/1327, send 1479, addImages 1694, addFiles 1708 | chip × click 1349/1367 |
| `hideSuggest` | 1374 | 1 | `suggestEl`,`slashMenuOn` | updateSuggest, renderSuggest, applySuggest, inputKeydown | 否 |
| `updateSuggest` | 1375–1401 | 27 | `input`,`slashCmds`/`workspaceFiles`(**页面级**),`slashMenuOn`,`sgKind`,`vpost`,`renderSuggest` | bindComposerOnce 294, pmAt 325, applySuggest 1438, handleMsg 1709/1710 | 否 |
| `renderSuggest` | 1403–1421 | 19 | `suggestEl`,`sgList`,`sgSel`,`el`,applySuggest/paintSuggest | updateSuggest | 行 mousedown/mouseenter 1415-16 |
| `nextSel` | 1423–1429 | 7 | `sgSel`,`sgList` | inputKeydown 1494/1495 | 否 |
| `paintSuggest` | 1431–1434 | 4 | `suggestEl`,`sgList`,`sgSel` | renderSuggest, inputKeydown | 否 |
| `applySuggest` | 1436–1446 | 11 | `input`,`sgKind`,`sgList`,`vpost`,`hideSuggest`,`updateSuggest` | 1415, inputKeydown 1495/1501 | 否 |
| `histNav` | 1451–1466 | 16 | `sentHistory`(**页面级**),`histIdx`,`histDraft`,`input`,`autoSize` | inputKeydown 1512 | 否 |
| `send` | 1468–1481 | 14 | `pending*`,`sentHistory`,`codeCtx`/`codeOn`,`histIdx`,`histDraft`,`lastNotice`,`renderAttach`,`autoSize`,`vpost` | bindComposerOnce 285, inputKeydown 1514 | 否 |
| `autoSize` | 1484–1488 | 5 | `input` | bindComposerOnce 294, histNav 1465, send 1478 | 否 |
| `inputKeydown` | 1490–1521 | 32 | `suggestEl`,`sgList`,`sgSel`,`histNav`,`send`,`changesPage` | bindComposerOnce 286 | **是** |
| `toHalfWidth` | 1530–1533 | 4 | — | send 1469, normalizeInputWidth | 否 |
| `normalizeInputWidth` | 1538–1544 | 7 | `input` | bindComposerOnce 291/297 | 否 |
| `filesFromClipboard` | 1546–1551 | 6 | — | inputPaste | 否 |
| `inputPaste` | 1553–1555 | 3 | `handleFiles` | bindComposerOnce 287 | **是** |

### 1.5 状态行 / 页脚 / 横幅（4/5/6 都没点名，但住在闭包里，第 6 刀必须处置）

| 函数 | 行 | 行数 | 依赖 | 调用方 |
|---|---|---|---|---|
| `setStatus` | 483 | 1 | `statusEl`,`S.busy` | handleMsg 1674, applyState 1240 |
| `startBootTick` / `stopBootTick` | 494–502 / 504 | 10 | `statusEl`,`bootTickTimer/Start` | handleMsg 1674, applyState 1239 |
| `renderStatus` | 505–506 | 2 | `modeBadge`,`modeText` | uiState 1647, mode 1677, queue 1662 |
| `renderBanner` | 509–523 | 15 | `bannerEl`,`vscode`,`L` | uiState 1648, banner 1713 |
| `renderChanges` | 528–545 | 18 | `changesBarEl`,`changesPage`,`vpost`,`vscode`,`L` | handleMsg 1715 |
| `fmtDur` | 548–554 | 7 | — | renderBusyUi, startBootTick |
| `renderBusyUi` | 558–617 | 60 | `S.busy`,`statusEl`,`busyTimer`,`busyStart`,`compacting`,`queueN`,`bootPending`,`roundFrozen`,`lastElapsed`,`subDock.runsOf/anyLive`(566@724cc1a) | setBusy 632, viewFor().refreshBusy, activateTab, subagentUpdate |
| `setBusy` | 619–632 | 14 | 同上 + `finalizeLive` | uiState 1646, busy 1658, applyState 1229 |
| `setCompacting` | 637–642 | 6 | `compacting`,`statusEl` | handleMsg 1676 |
| `fmtSession` | 1210–1224 | 15 | `tabsList`,`L` | applyState 1251 |
| `applyState` | 1226–1258 | 33 | `bootPending`,`compacting`,`statusEl`,`modelEl`,`thinkEl`,`sessionEl`,`tabsList`,`ctxPop` | uiState 1655, state 1711 |

### 1.6 页签 / 视图工厂 / 路由（第 6 刀主体）

| 函数 | 行 | 行数 | 依赖 | 调用方 | 事件绑定 |
|---|---|---|---|---|---|
| `makeSessionView` | 143–1762 | 1620 | 见 F1 | viewFor | 建视图即绑（见 F3） |
| `viewFor` | 1773 | 1 | `views` | routeMsg 1782, activateTab 2522, window.drop 2474, subagentUpdate 2613/2618, 子 agent 2387 | 否 |
| `renderCodeChipAll` | 1775 | 1 | `views` | handleMsg 1690, bindViewEvents 333 | 否 |
| `routeMsg` | 1777–1782 | 6 | `tabId`,`views`,`getActiveTabId` | window.message 2642, drainPendingStream 2492 | 否 |
| `deferDuringRender` | 2093–2102@724cc1a | 10 | — | handleMsg 1603 | 否 |
| `drainPendingStream` | 2103–2107@724cc1a | 5 | `pendingStream`(2092) | flushRender 1576 | 否 |
| `scheduleRender` | 1562–1567 | 6 | `renderTimer` | handleMsg 1644/1659/1660 | setTimeout |
| `flushRender` | 1569–1576 | 8 | `renderTimer`,`renderPending`,`liveSyncPending` | setTimeout | 否 |
| ~~`applyTabSubState`~~ | 已搬出（`features/subagentDock.ts` 的 `applyTab()`） | — | — | activateTab 2127@724cc1a 一行转调 | 否 |
| `activateTab` | 2113–2132@724cc1a | 20 | `views`,`tabsList`,`sessionEl`,`tabId`,`codeCtx`,`subDock.applyTab`,`renderTabs` | handleTabs 2180, renderTabs 2152 | 否 |
| `renderTabs` | 2135–2165@724cc1a | 31 | `tabbarEl`,`tabsList`,`tabId`,`ico`,`shorten` | handleTabs 2182, activateTab 2114/2128, chip 点击自绑 |
| `handleTabs` | 2168–2189@724cc1a | 22 | `tabsList`,`sessionEl`,`activateTab`,`renderTabs`,`views` | window.message 2196@724cc1a（`handleMsg` 1721 那条**不可达**，见 R15） | 否 |

---

## 二、第 4 刀：输入区 → `webview/features/composer.ts`

### 2.1 搬什么（行号 = HEAD）

| 组 | 函数（行） | 行数 |
|---|---|---|
| 附件去重 | `normPath`(348) `isTmpAttach`(349) `hasImg`(350) `hasFile`(351–360) | 13 |
| 附件摄入 | `handleFiles`(1261–1333) | 73 |
| 附件条 | `renderAttach`(1335–1372) | 38 |
| 联想菜单 | `hideSuggest`(1374) `updateSuggest`(1375–1401) `renderSuggest`(1403–1421) `nextSel`(1423–1429) `paintSuggest`(1431–1434) `applySuggest`(1436–1446) | 69 |
| 发送链 | `send`(1468–1481) | 14 |
| 键位/高度 | `autoSize`(1484–1488) `inputKeydown`(1490–1521) | 37 |
| 归一/粘贴 | `toHalfWidth`(1530–1533) `normalizeInputWidth`(1538–1544) `filesFromClipboard`(1546–1551) `inputPaste`(1553–1555) | 20 |
| **合计** | | **≈264 行** |

**明确不搬（留在 main.ts）**：
- `bindComposerOnce`(282–298) —— 见 R1/R3，字都不许动。
- `bindViewEvents`(301–334) —— 它顺带绑了 stop/model/think/mode/codechip/plusmenu，属于"视图绑定"，
  归第 6 刀；第 4 刀只把它的 `bindComposerOnce()` 调用点原样留着。
- `histIdx`/`histDraft`(1450) + `histNav`(1451–1466) —— 因为 `bindComposerOnce` 正文里有两行
  **裸赋值** `histIdx = -1; histDraft = '';`(292–293)，把这两个变量搬到 composer 后这两行就编译不过，
  只能改正文 = 违反"一个字不许动"。这 17 行留家最省事（代价：第 4 刀净收益少 17 行）。
- `renderCodeChip`(362–367) —— 可选。它读页面级 `codeCtx/codeOn`、写 `codechipEl`，且被
  `renderCodeChipAll`（跨视图）调用。建议**留给第 6 刀**（跟 `codeCtx` 一起处置），别在第 4 刀切一半。
- 队列条 `addQueuedDom/addQueued/renderNativeQueue/removeQueued`(711–756) —— 看着像输入区，实际三向耦合
  （`renderAll` 1167–1170 幂等重建、`handleMsg` 1679–1686、`olScan` 读 queuebar），见 R6。

### 2.2 依赖（`initComposer(deps)` 形状）

```ts
export interface ComposerDeps {
  q: (sel: string) => HTMLElement;   // 视图作用域查询（ID 每视图重复，禁 document.getElementById）
  post: (m: any) => void;            // 原 vpost（带本视图 tabId）
  lang: Record<string, any>;         // L
  el: (tag: string, cls?: string, text?: string) => HTMLElement;
  ico: (name: string, size?: number) => string;
  esc: (s: any) => string;
  shorten: (s: string, n: number) => string;
  notice: (t: string) => void;       // 还在 msglist/第 5 刀 → 用回调
  history: string[];                 // ★ 页面级 sentHistory(59)，跨页签一份，注入不复制
  getCodeCtx: () => any;             // ★ 页面级 codeCtx(1909)
  isCodeOn: () => boolean;
  pages: { hasPage: () => boolean; close: () => void };  // inputKeydown 1499–1500 的 Esc 分支
  slashCmds: () => any; setSlashCmds: (v: any) => void;  // ★ 页面级缓存(1939-40)
  files: () => any; setFiles: (v: any) => void;
}
export function initComposer(deps) {
  return { send, inputKeydown, inputPaste, normalizeInputWidth, updateSuggest, autoSize,
           handleFiles, renderAttach, applySuggest, /* 供 handleMsg 用： */
           addImages(list), addFiles(list), imgCount(), setPendingFromHost(...) };
}
```

**必须由 main.ts 保留的别名**（好让 `bindComposerOnce` 正文零改动）：
`var send = composer.send; var inputKeydown = composer.inputKeydown; var inputPaste = composer.inputPaste;
var normalizeInputWidth = composer.normalizeInputWidth; var updateSuggest = composer.updateSuggest;
var autoSize = composer.autoSize;`
（`inputKeydown` 里调 `histNav` → 把 `histNav` 作为 deps 回调传给 composer，属"必要转调"。）

`handleMsg` 的四处调用改走 composer API：`fillInput`(1671 直接写 `input.value`+focus)、
`queuedRetrieved`(1682–1689)、`addImages`(1691–1707)、`addFiles`(1708) —— 第 4 刀先原样保留这些分支，
只把 `pendingImages/pendingFiles` 的读写点换成 `composer.*`（最小改动面）。

### 2.3 顺序建议

与交接文档一致：**第 4 刀在 5/6 之前**。理由（不是"文档这么写"）：
1. 它是唯一**完全叶子**的域：对外只出 `vpost` 一条上行，对内不依赖任何消息流状态（`notice` 是唯一回调）。
2. 它验证的是"**有 DOM 元素 + 事件绑定 + 跨页签共享变量**的闭包块怎么出文件"——`changesPage`/`ctxPopover`
   两刀都是较纯的"渲染+自持状态"，这一刀才会撞上页面级共享变量（`sentHistory`/`slashCmds`/`codeCtx`），
   早点撞出来，第 5/6 刀的 deps 设计能照着抄。
3. 反过来（5 先于 4）没有任何收益：5 的完成态不改变 4 的依赖面，而 5 更可能引入 bug 干扰 4 的验收基线。

### 2.4 高危点

- **R1 绑定只许一处**：`composer.ts` **不得**给 `#input`/`#send` 绑任何事件。`bindComposerOnce` 已经绑了
  click/keydown/paste/input/compositionend。两边各绑一次 → 一次点击发**两条** `prompt`（真实事故形态）。
- **R2 调用顺序不许动**：`makeSessionView` 1734–1740 的
  `try { bindViewEvents() } catch { reportWvError } finally { bindComposerOnce() }`（1734–1740）
  与 `input.disabled = false`(297) 是「输入框点发送没反应」的止血结构，任何一刀都不许重排。
- **R3 `histIdx/histDraft` 裸赋值**（292–293、1671、1685）：正确姿势是**留在 main.ts**。若坚持搬进 composer，
  必须先把这三处改成方法调用 —— 那是改 `bindComposerOnce` 正文，**需要单独请示，不能顺手做**。
- **R4 页面级变量不许复制**：`sentHistory`(59，注释明说"模块级一份=所有会话/页签通用")、
  `slashCmds/workspaceFiles`(1939-40)、`codeCtx/codeOn`(1909)。搬成 per-view 副本 = 行为变更（每页签一份
  输入历史 / 每页签各自拉一次 getSlash）。
- **R5 `composerBound` 的真实归属**：注释写"提到模块级"(279)，但它实际在视图闭包内（281 在 143–1762）。
  **这是正确行为**（每页签都有自己一份 `#input`，各绑各的），注释是历史残留。别"按注释修复"成模块级——
  那样第二个页签的输入框永远不会被绑（`input.disabled` 永为 true）。
- **R6 别把队列条一起搬**：`renderAll`(1172–1175) 与 uiState 分支(1651–1654) 都在重建 queuebar，
  已有的幂等注释写着"先清再建"。切开后必然出现双写/漏清，等到第 5 刀之后单独一刀。

### 2.5 验收判据（本条全绿才算过）

1. `npm run compile` 三段全绿（typecheck:webview + vite + tsc）。
2. 回归基线一致：`test:linkify` `test:html` `test:changespage` `test:ctx` `test:detail` `test:usage`
   `test:price` `test:errclass` `test:diffview` `test:subagent` `test:replay` `test:jsonltail` `test:migration`
   —— 条数与改动前**逐项**相同（贴输出原文）。
3. **逐字核对**（`bindComposerOnce` 必须 0 字差异）：
   ```
   diff <(git show HEAD:webview/main.ts | sed -n '279,299p' | sed 's/^ *//') \
        <(sed -n '<新位置>'  webview/main.ts | sed 's/^ *//')   # 期望：无输出
   ```
   其余搬动函数用归一化核对：两侧都 `sed 's/^ *//'`，再把 `pendingImages`→`pending.images`、
   `pendingFiles`→`pending.files`、`slashCmds`→`deps.slashCmds()` 这类前缀替换跑掉，
   `diff` 应为空（每处差异在报告里逐条列出理由）。
4. 行数账：`wc -l webview/main.ts webview/features/composer.ts` 前后对比；main.ts 净减 ≥ 200。
5. 真机手点（第 4 刀最不能省的）：打字不 disabled → Enter 发送 → Shift+Enter 换行 → ↑/↓ 回溯 →
   `/` 菜单（含分组标题跳过、Tab 补全）→ `@` 文件搜索 → 粘贴图片 → 拖入图片/文件（含「资源管理器拖入
   只有 URI」路径）→ 附件 chip × 删除 → 全角字母自动转半角 → Esc 中断/关变更页。
6. DevTools console 零报错；`~/.pi/agent/pi-chat-debug.log` 无新增 `wvError`（kind=`bindViewEvents` 尤其要看）。

---

## 三、第 5 刀：消息渲染

**结论先行：交接文档说的"第 5 刀"不能一刀做完 —— 实测体量 ≈800 行，且内部有 5 条交叉依赖
（`scroll`↔`applySticky`、`linkifyEnabled` 总闸、`pdet` 跨 live/tool、渲染队列跨 5/6、`renderAll` 全文件调用）。
必须拆 **7 个子刀**，一子刀一提交。**

### 3.1 建议的子刀切法

| 子刀 | 内容（行） | 行数 | 输出 |
|---|---|---|---|
| **5a 渲染基座** | `renderInline`(69–79) `renderPlain`(81–108) `renderTable`(110–123) `renderRich`(125–141)；`cleanPath`(1836–1851) `linkify`(1854–1876) `linkifySymbol`(1882–1887) + `FILE_RE`(1830) `SYM_RE`(1881) `linkifyEnabled`(1853) | ≈118 | `features/markdown.ts` + `features/linkify.ts`（**必须同时改 `scripts/test/linkify.test.mts`**，见 R9） |
| **5b live 流式** | `liveEnsure/liveBlock/finalizeLive/liveReset/appendFinal/setMdTail/streamTick/appendDelta/appendThink/applyLiveSync`(759–895, 1578–1599) + `scheduleStream`(874–880，**死代码**，见六.5) + `liveMsg/liveDiv/pdet/liveParts/liveRTimer`(261) | ≈150 | `features/liveStream.ts` |
| **5c 工具行** | `toolStart`(897–936) `toolEnd`(938–1017) + `toolEls`(171) `lastToolGroup`(260) | ≈121 | `features/toolRows.ts`（`liveBlock` 的 `kind==='toolCall'` 分支与 `pdet` 是两域交界，见 R11） |
| **5d 整树重绘** | `imgsOf`(647–655) `addUser`(657–709) `textOf`(1034–1043) `makeThink`(1045–1051) `makeCompaction`(1058–1067) `notice`(1025–1032) `renderAll`(1069–1188) `renderCompact`(1191–1208) + `lastNotice`(1022) `seenCompactions`/`compactBarShownAt`(1023-24) | ≈238 | `features/messageList.ts` |
| **5e 粘性气泡** | `updateStickyChip`(188–193) `stickyWants`(195–204) `applySticky`(208–236) `observeSticky`(238–247) + `stickyQ`(174) `stickyIO`(187) | ≈57 | 可并入 5d（同文件）或独立 `features/sticky.ts`；**与 `scroll` 双向耦合**（R7） |
| **5f 渲染队列** | `deferDuringRender`(2093–2102@724cc1a) `drainPendingStream`(2103–2107@724cc1a) `scheduleRender`(1562–1567) `flushRender`(1569–1576) + `renderPending`/`liveSyncPending`/`renderTimer`(1559–1561) | ≈45 | `features/renderQueue.ts`（**不要**留给第 6 刀，理由见 R10） |
| **5g 大纲轨道** | `outlineRebuild`(399–430) `outlineResize`(432–436) `olText`(438–440) `olScan`(444–453) `olSpy`(455–474) + `olAnchors/olSpyQueued/olSuspend`(396–398) + `olRO`(478–481) + `root.scroll` 476 | ≈78 | `features/outline.ts` |

顺序：**5a → 5b → 5c → 5d(+5e) → 5g → 5f**（5f 放最后：它同时依赖 `renderAll`(5d) 与 `applyLiveSync`(5b)，
两边都落地后再搬，deps 只剩两个函数引用；提前搬就得把两个模块都反向 import main.ts）。

### 3.2 依赖形状

5a：`{ el, esc, lang, getLinkifyEnabled, setLinkifyEnabled }`（`linkifyEnabled` 是**全局总闸**，见 R8）。
5b：`{ root, lang, el, ico, appendFinal→(5a), renderRich→(5a), scroll }`
  —— `liveBlock` 的 toolCall 分支需要 5c 的骨架（`pdet`/`abox`），5b 先搬时保留 `pdet` 在自己模块内，
  5c 搬 `toolStart/toolEnd` 时它俩不碰 `pdet`（`pdet` 只在 liveBlock/toolCallDelta 用）→ 5b 先落安全。
5c：`{ root, el, ico, linkify(5a), lang, scroll }` + 模块内 `toolEls/lastToolGroup`。
5d：`{ root, lang, el, ico, esc, linkify(5a), renderRich(5a), addUser→toolStart/toolEnd(5c), finalizeLive/liveReset(5b),
  imgsOf, makeThink, makeCompaction, textOf, notice, renderCompact, scroll, outlineRebuild(5g), queuebarEl/queuedItems/addQueuedDom, welcomeHTML/duckInto/pickTip, vpost }`
  —— **5d 是最大的一颗依赖汇点**：`renderAll` 几乎调了全文件。这也是为什么 5d 必须排在 5a/5b/5c/5g 之后。
5g：`{ root, outlineEl, el, lang, isActiveView: () => boolean, scroll? 否 }`。
5f：`{ renderAll(5d), applyLiveSync(5b), drain→routeMsg(main), pendingStream }` —— 放最后。

### 3.3 高危点

- **R7 `scroll` ↔ `applySticky` 双向调用**：`scroll`(388) 调 `applySticky(stickyQ)`；`applySticky`(211) 读
  `root.scrollTop`；`addUser`(709) 又调 `scroll`。拆 5e 时**只能有一条路**：`scroll` 留 main.ts，5e 暴露
  `pinCheck()` 给 `scroll` 调；`addUser`(5d) 通过 deps 拿 `scroll`。绝不许两个模块各存一份 `stickyQ`。
- **R8 `linkifyEnabled`(1853) 是全局总闸**：`renderAll`(1081) 关闭它让老消息不 linkify（大会话卡顿的
  唯一止血），`renderAll`(1103) 边循环边对最近 15 条打开。5a 搬走后它必须变成**共享可写状态**（deps 里一对 getter/setter），
  否则重绘卡顿回归——这是 5a 唯一的语义风险点。
- **R9 `test:linkify` 会直接 throw**：`scripts/test/linkify.test.mts:24-38` 用
  `grab("function renderInline(elm, text)", "function renderRich(parent, text)", false)`、
  `grab("function renderRich(parent, text)", "function makeSessionView(id: string)", false)`、
  `grab("var FILE_RE =", "}, true);")` 从 `webview/main.ts` 抽代码（还 `code.slice(0, indexOf("  sessionArea.addEventListener"))`）。
  5a 一搬，三条 grab 全部失败。**5a 必须同步改用例的源路径与三个标记**，并且断言逻辑/用例数不变
  （改测试是 5a 的一部分，不是"顺手"）。
- **R10 渲染队列别让 5b/6 各切一半**：`renderTimer`(1603) 既决定 `handleMsg` 是否排队（5 域），
  又由 `drainPendingStream`(2106@724cc1a) 经 `routeMsg` 回灌（6 域）。切开就会形成 5↔6 的双向依赖。
- **R11 `pdet` 跨 5b/5c**：`pdet` 在 `liveBlock`(777) 赋值、在 `toolCallDelta`(1628) 读、在 `liveReset` 清。
  它属 live 流式，5c 搬工具行时**不要**带走它。
- **R12 `renderAll` 的 4 个外部耦合点，逐个确认后再动**：
  ①`queuebarEl/queuedItems/addQueuedDom`（1172–1175，与 uiState 分支 1651–1654 双写幂等）；
  ②`welcomeHTML/duckInto/pickTip`（1076，空会话欢迎页，页面级快照）；
  ③`outlineRebuild` + `olSuspend`（1078/1180）；
  ④`seenCompactions/compactBarShownAt/renderCompact`（1185–1188，首渲立基线的语义）。
- **R13 `renderAll` 里 `linkifyEnabled=false` 的时序**：1081 行在 `root.innerHTML=''` 之后、循环之前；
  搬动时"看起来能省一行"的清理一律不做。

### 3.4 验收判据（每子刀都要，缺一不可）

1. `npm run compile` 全绿。
2. 全测试套件基线一致；**5a 额外**：`npm run test:linkify` 全过且输出项目数不变（改源路径后必须仍能
   `grab` 成功——在用例里保留"grab 失败即 throw"的原行为）。
3. 逐字核对：对每个搬走的函数跑归一化 diff（`sed 's/^ *//'` + 前缀替换），差异逐条列理由。
4. 行数账：main.ts 单调下降。现行基线 2229（`724cc1a`，第 3 刀已减 425），目标
   `2229 → 第 4 刀后 ≈1990 → 第 5 刀后 ≈1240 → 第 6 刀后 ≈250`。
5. 真机观察（子刀对应项）：
   - 5b/5c：流式正文不闪、`**bold` 半截不抖、表格不劈叉、代码块围栏正确、工具 `×N` 成组、
     乱序完成的并行工具仍并入组头、点开工具显示全量 OUT。
   - 5d：切历史会话整页重绘正确、压缩块/details、错误气泡（余额类不给「修改后重试」）、
     toast 跨重渲不叠挂、切页签回来压缩条不重复弹。
   - 5e：超长消息钉住折叠不闪（三条振荡修正的历史行为必须逐条复现：往下滚不闪、工具收盒不闪）。
   - 5g：右缘轨道锚点数正确、hover 错峰、点击跳转闪烁后摘类（切页签回来不重放）。
   - 5f：render 与 liveSync 同拍顺序（快照先画、事件后补），重绘窗口期流式事件不丢不乱序。

---

## 四、第 6 刀：页签 / 视图工厂 + 事件路由

### 4.1 现实：这一刀是"把 makeSessionView 拆成宿主"（体量 ≈590 行，拆 3 子刀）

4/5 刀做完后闭包里还剩：建视图+查元素(143–170, 28) + 绑定(281–334, 54) + 状态行/横幅/页脚(483–642, 110)
+ 队列条(711–756, 37) + `fmtSession/applyState`(1210–1258, 50) + `handleMsg`(1601–1721, 121)
+ 视图尾部(1724–1762, 39) ≈ **440 行**；闭包外还有 `viewFor/routeMsg/Esc 监听`(1765–1782, 18)、`defer/drain`(2092–2107@724cc1a, 16)、
`activateTab/renderTabs/handleTabs`(2113–2189@724cc1a, 77)、`window.message`(2190–2218@724cc1a, 29)
≈ **140 行**（第 3 刀已把 subagent 两条截获压成一行转调，6a 的搬运面因此更小）。

| 子刀 | 内容 | 行数 | 输出 |
|---|---|---|---|
| **6a 页签与路由** | `viewFor`(1773) `renderCodeChipAll`(1775) `routeMsg`(1777–1782) Esc 关页监听(1766–1772) `activateTab`(2113–2132@724cc1a) `renderTabs`(2135–2165) `handleTabs`(2168–2189) `window.message` 入口(2190–2218@724cc1a，subagent 两条已是 `subDock.*` 一行转调) | ≈180 | `features/tabs.ts`（`views` 表 + 活动页签 + 路由） |
| **6b 页面级 chrome** | `ico/el/esc/elIco/shorten`（1814–1945）、欢迎页/鸭子(1918–1937)、凭证页(1956–2048)、头部绑定(1904–1916, 2062–2088@724cc1a)、剪贴板兜底(2070–2080@724cc1a) | ≈250 | `features/pageChrome.ts` + `features/icons.ts`（这一刀是"减负"不是"必做"） |
| **6c 视图工厂组装** | `makeSessionView` 剩余骨架（143–170、281–334、1724–1762）+ `handleMsg`(1601–1721) 拆成分域 dispatch + 状态行(483–642)/`applyState`/`fmtSession` 归位 | ≈440 | `features/sessionView.ts` + `features/statusBar.ts`；main.ts 只剩 IIFE 引导 + import 装配 ≈**250 行** |

顺序：**6a → 6b（可跳）→ 6c**。理由：6a 只动闭包**外**的 162 行（`views` 已是模块级），风险最低且能先把
`window.message` 的 5 个"页签过滤前截获"分支（auth/tabs/subagentUpdate/subagentLedger/duck/panelInfo）落定；
6c 必须最后，因为 `makeSessionView` 是**所有 per-view 模块的装配点**，只有 4/5 刀全部搬完后它才是一层薄胶水。

### 4.2 顺序建议（与交接文档的差异，附理由）

交接文档第五节只给了 4→5→6 的粗顺序。勘察后的具体建议：

```
第4刀 composer  →  5a → 5b → 5c → 5d(+5e) → 5g → 5f  →  6a → (6b) → 6c
                    ↑ 必须先于 6；5a 必须最先（markdown/linkify 是 5b/5c/5d 的依赖）
```

- **第 6 刀的「等第 3 刀」已解除**：cut 3 已落盘（`724cc1a`），现行 6a 只需处理
  `window.message`(2190–2218) 与 `activateTab/renderTabs/handleTabs`(2113–2189)，subagent 分支已是
  `subDock.*` 一行转调 —— 冲突面比派单时估计的更小。**4/5 刀的行段与 cut 3 零交集**
  （input 区 1261–1555、消息渲染 69–1188/1562–1599/1830–1887），但都要改 `handleMsg` 的调用行
  （1605–1708）——**约定 4/5 刀不改 `handleMsg` 正文，只在 main.ts 里换被调符号**。
- **5f（渲染队列）不许留到 6**：见 R10。
- **6b 可以跳过**：`ico/el/esc` 被 4/5 刀当 deps 注入，留在 main.ts 完全可用，收益只是行数；
  如果工期紧，6a+6c 之后 main.ts 已 ≈500 行，6b 可以单独立票。

### 4.3 高危点

- **R14 双绑自检（搬迁期特有）**：全文件里"同元素同事件绑两次"本次勘察**未发现**（`historyEl`(1916)
  与 `sessionEl`(2062@724cc1a) 是两个不同元素，刻意双入口，别合并）。但 4/5/6 刀都是"函数换文件"，只要有一处
  调用点漏删就变成真双绑（`bindComposerOnce` 尤其致命：一次点击发两条 `prompt`）。每刀收尾用
  `grep -n "addEventListener" webview/main.ts webview/features/*.ts` 人工过新旧两侧。
- **R15 死分支（只记录不改）**：`handleMsg` 1721 的 `else if (m.type === 'tabs') handleTabs(m);` **不可达**
  —— `window.message` 2196 行（@724cc1a）已经 `if (m.type === 'tabs') { handleTabs(m); return; }` 提前截获。
  6c 拆 dispatch 时若"顺手合并"，等于改变消息顺序语义，需要单独确认。
- **R16 顺序契约（6a 命门）**：`window.message` 的判序是有意的：
  `authPanelOpen/authState`(2193–2194) → `tabs`(2196) → `subagentUpdate`(2199，**页签过滤前截获**，
  理由：后台页签的流不渲染但必须缓存；现为 `subDock.handleUpdate(m)` 一行) → `subagentLedger`(2201)
  → `duck`(2203) → `panelInfo`(2206–2214) → `routeMsg`(2217)（行号均 @724cc1a）。6a 搬这段时必须逐分支保留顺序与 `return`，**一个都不能重排**。
- **R17 `protoHTML/welcomeHTML/duckUriNow` 的初始化时机**：`protoView`(1790)/`protoHTML`(1791)/`sessionArea.innerHTML=''`(1792)，全在 1–2044 未变区
  是模块 init 期的**一次性快照**；`welcomeHTML`(1919) 也是。6c 把工厂移出后，工厂必须在同一 tick 内
  拿到 `protoHTML`，否则第一个页签空白/欢迎页丢图（鸭子 `applyDuck` 靠 `duckUriNow` 回填）。
- **R18 元素查询纪律**：搬出去的任何模块**禁止** `document.getElementById`（ID 在每个 `.session-view` 内重复，
  只有 `#authpanel` 等页面级覆盖层是唯一）。用 deps 的 `q`。
- **R19 `dispose` 的三只 timer**（1754–1760：`busyTimer/liveRTimer/renderTimer`）：4/5/6 各搬走状态下
  这三个 timer 的归属会漂移。**规则**：谁创建谁清；`makeSessionView.dispose` 只清自己还持有的。
  漏一个 = 切走的页签后台继续跑 ticker（白 Working 同族事故）。
- **R20 `tabId` 双写**：模块级 `tabId`(27) 由 `activateTab`(2115@724cc1a) 和 `routeMsg`(1781) 写，`vscode.postMessage`
  读它打标。6a 搬路由时这**两个写点必须同模块**，否则跨文件双写又出「消息打到别的页签」。

---

## 五、横切清单：4/5/6 三刀都要遵守的约束

1. **协议零新增**：不动 `src/core/protocol.ts`；不新增 webview↔宿主消息类型（这三刀都是纯搬家）。
2. **模板/CSP 零改动**：`webview/index.html` 不加新 ID、不动占位符；`src/vscode/webview-html.ts` 不碰。
3. **样式零改动**：不动 `webview/style.css`（除新文件需要的注释）。class/id 一律原样。
4. **注释随逻辑走**：每个函数的"事故教训"注释必须整段跟着搬（`AGENTS.md` 注释文化条）。
   逐字核对脚本会覆盖这一条（注释在函数体内，diff 会抓到）。
5. **一刀一提交、一刀一编译**：不合并两刀到一个 commit（`git add` 只加本刀文件，禁 `-A`）。
6. **版本号不碰**：本系列不改 `package.json`（发版归 ship 会话）。

---

## 六、还没人认领的债（供总监立票参考，不在本单范围）

1. `applyState`/`renderBusyUi`/`setBusy`/`renderBanner` 这一坨（≈230 行）在任何刀里都只是"被搬的附带"，
   没有独立归属 → 建议 6c 时明确成 `features/statusBar.ts`。
2. `renderCodeChip`(362–367) + `codeCtx/codeOn`(1909) 这组"页面级数据 + 每视图 chip"的怪结构，
   历史上导致 `renderCodeChipAll` 需要遍历所有视图。留着能跑，但它是"页面级状态进视图"的孤例。
3. `nativeQueuePills`(740) 的已知取舍（uiState 重建清空缓存，切页签 pill 短暂消失）写在 738 行注释里，
   搬 queuebar 时要一并带走。
4. `handleMsg` 里 `nextAdi`(1693) 是 IIFE 内嵌的图片预检循环，独立成函数才能随 6c 拆 dispatch。
5. **`scheduleStream`(874–880) 是死代码**：全文件只有定义，唯一提及是 66 行注释（`appendDelta`(882)
   直接调 `streamTick`，不走它）。本单边界是只记录不删；5b 搬 live 流式时**照搬或单独立票删，
   二选一，不许悄悄丢掉**。
6. **`test:linkify` 的"真代码"保证会随 5a 消失**：该用例是靠 grab 从 main.ts 抓源码 eval 的，
   搬进 `features/linkify.ts` 后它验的是新文件（如果改路径）或者直接 throw（如果不改）。
   5a 之后建议改成直接 import 模块 + 同一份 DOM 垫片，否则口径只剩一份"副本测试"。

---

## 七、复核命令（任何人可一键验本报告的行号）

```bash
cd "d:/work/docs/pi test/pi-vscode"
git show b706911:webview/main.ts | wc -l                    # 2654（派单时的基准）
git show HEAD:webview/main.ts | wc -l                       # 2229（724cc1a，第 3 刀后）
git diff -U0 b706911..724cc1a -- webview/main.ts | grep '^@@'   # 改动全在 2045 行之后（+566 一处）
git show HEAD:webview/main.ts | sed -n '143p;1762p;1764p'   # makeSessionView 边界证据（两版同号）
git show HEAD:webview/main.ts | sed -n '282,298p'           # bindComposerOnce 全文（命脉）
git show HEAD:webview/main.ts | sed -n '1734,1740p'         # try/finally 绑定顺序
git show HEAD:webview/main.ts | sed -n '2190,2218p'         # window.message 判序（@724cc1a）
sed -n '2190,2218p' webview/main.ts | grep -n "m.type"            # 截获分支清单（逐条核顺序）
sed -n '24,38p' scripts/test/linkify.test.mts               # 5a 的测试耦合点
```
