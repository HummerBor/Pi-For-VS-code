# REPORT-t44：webview 拆分第 6 刀 · 子刀 6a——页签与路由

**状态：已完工，可验收。**
**本单 commit：`7d8703c`**（`refactor(webview): 页签与路由搬进 features/tabs.ts（第 6 刀 6a，主文件 1136→1027）`）
**回退：`git revert 7d8703c`**（单提交、只碰两个文件，无迁移、无协议变更，revert 即回到 1136 行原状）
**提交自检：`git show --stat HEAD` = 2 files changed（`webview/features/tabs.ts` +229 / `webview/main.ts` +31 −140），无他人文件混入，未 push。**

---

## 一、搬了什么（行号 = `HEAD~1`，即 1136 行那版）

| 组 | 函数 / 监听 | HEAD 行 | 行数 | main.ts 新位置 |
|---|---|---|---|---|
| A | `var views` 声明 | 742 | 1 | 移入 tabs.ts 模块级（唯一持有者） |
| A | Esc 关页 `document.keydown` | 744–750 | 7 | `initTabs` 内（注册点留在原装配位置） |
| A | `viewFor` | 751 | 1 | 同模块，对外同步返回视图 |
| A | `renderCodeChipAll` | 752–753 | 2 | 同模块 |
| A | `routeMsg` | 755–760 | 6 | 同模块（`tabId` 写点之一） |
| A | `var tabsList` / `var tabbarEl` | 763–764 | 2 | 移入 tabs.ts（`tabbarEl` 在 `initTabs` 里查 `#tabbar`） |
| B | `activateTab`（含 2 行旧文档注释） | 1017–1039 | 25 | 同模块（`tabId` 写点之二） |
| C | `renderTabs` | 1041–1072 | 32 | 同模块 |
| D | `handleTabs` | 1074–1095 | 23 | 同模块（main.ts 只留 `handleTabs` 别名，供 `handleMsg` 里那条不可达的 `tabs` 分支） |
| E | `window.message` 入口（整个监听器） | 1096–1124 | 29 | 同模块 |
| — | `var tabId` | 34 | 1 | 移入 tabs.ts（模块级）+ `getTabTag()` 只读导出 |

main.ts 保留：`initTabs(deps)` 装配 + 别名（`viewFor` / `renderCodeChipAll` / `routeMsg` / `handleTabs`）+ `getTabTag`/`getTabsList` 两个只读导入。

### 行数账（与派单预估的差异）

```
main.ts  1136 → 1027   （净 −109；diff 实测 +31 / −140）
tabs.ts   新建 229 行  （搬入的 128 行代码 + 101 行文件头/依赖接口/装配骨架）
```

派单预估「≈956」偏乐观：勘察表把 6a 面算成「≈180 行」，而真正落在这条子刀边界内的**代码**
只有 128 行（`activateTab/renderTabs/handleTabs` 77 + `window.message` 29 + 视图表/路由/Esc 19 +
三处旧声明 3），剩下的差额是勘察估算时把 `handleMsg` 的 `tabs` 分支、`applyState` 等**不属于 6a**
的行也算了进去。另外装配块（注释 + `initTabs(deps)` 对象 + 别名）本身要 +22 行，所以净值 −109。
没有为凑数字塞/删任何东西。

---

## 二、逐字核对（零差异，附差异清单）

脚本：`node scripts/.preview/t44-verbatim.mjs`（`.preview/` 已被 .gitignore 排除，不进库）
做法：从 `git show HEAD~1:webview/main.ts` 与 `webview/features/tabs.ts` 各切五段，只把**跨文件引用换名**
反向归一化，再逐行比对。

```
✅ A Esc/viewFor/renderCodeChipAll/routeMsg  HEAD 19 行 / tabs 19 行
✅ B activateTab  HEAD 25 行 / tabs 25 行
✅ C renderTabs  HEAD 32 行 / tabs 32 行
✅ D handleTabs  HEAD 23 行 / tabs 23 行
✅ E window.message 入口  HEAD 29 行 / tabs 29 行
✅ 五段逐字零差异（归一化后）
```

归一化只允许下面 6 类换名（跨文件后这些符号必须经 deps 注入，语义/位置/顺序全不动）：

| 归一化替换 | tabs.ts 出现次数 | 理由 |
|---|---|---|
| `vscode.postMessage(` → `post(` | 4 | 上行适配器留在 main.ts（带 `getTabTag()` 打标），模块只拿回调 |
| `sessionEl.textContent` → `getSessionEl().textContent` | 2 | 页头标题元素是页面级、初始化晚于本装配点 → getter |
| `subDock.applyTab(tid)` → `applySubTab(tid)` | 1 | 浮窗实例初始化晚于本装配点 → 转调 |
| `subDock.handleUpdate(m)` → `subagentUpdate(m)` | 1 | 同上；分支仍是一行转调、仍在页签过滤前 |
| `subDock.setLedger(...)` → `subagentLedger(...)` | 1 | 同上 |
| `vscodeApi.setState(` → `setWebviewState(` | 1 | acquireVsCodeApi 句柄留在 main.ts |

**五段之外**的差异（都属「搬家必然」，逐条列）：

1. `var views` 类型从 `Record<string, ReturnType<typeof makeSessionView>>` 降为 `Record<string, any>`
   —— 工厂现在是注入的 `deps.makeView`，`ReturnType<typeof makeSessionView>` 在模块里没有该符号；
   对外 `viewFor` 仍同步返回视图，调用点（`renderCodeChip/refreshBusy/handleFiles/handleMsg/isBuilt`…）类型全部照旧可用。
2. `views` / `tabsList` / `tabId` 三元组声明从 IIFE 内挪到 tabs.ts 模块级；`tabbarEl` 的
   `document.getElementById('tabbar')` 原句搬进 `initTabs`（`#tabbar` 是页面级元素，不在 `.session-view` 内，不违反 R18）。
3. main.ts `applyState` 里唯一一处 `tabsList` 读取（HEAD 552 行）改成 `var tl = getTabsList();` + 同行循环
   —— `tabsList` 唯一持有者已是 tabs.ts，这里只读一次快照（`applyState` 是同步函数，同一 tick 内不会变）。
4. main.ts `vscode.postMessage` 打标改读 `getTabTag()`（原读本地 `tabId` 变量）；
   `setActiveTabId` / `TabInfo` / `TabsMsg` 三个 import 因搬走而成了未用符号，一并清掉（AGENTS「改动制造的死代码就清理」）。

**未动**（派单红线）：`handleMsg` 正文（含 1075 行 `handleTabs` 那条不可达的 `tabs` 分支，R15 只记录不改）、
`makeSessionView` 骨架与绑定顺序、`subDock.*` 三个入口、协议/模板/CSS/`src/`/`harness/`。

---

## 三、验证

### 1. `npm run compile` 三段全绿

```
typecheck:webview (tsc -p webview --noEmit)  → 0 error
build:webview (vite ×2)                      → ✓ built
tsc -p ./                                    → exit 0
```

### 2. 全套回归同数（15 组，改动前后逐项一致）

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
| html | OK（资源路径正确） | OK |
| migration | 用例全过 | 全过 |

注：`test:html` 打印的 HTML 字节数 153591 → 154258（+667，模块包装 + deps 装配的开销；该用例只校资源路径，不校字节数）。

### 3. 结构判据

- `grep -rn "var views" webview/` → **1 处**，`webview/features/tabs.ts:65`（main.ts 无副本）。
- `window.message` 判序（`grep -o "m.type === '...'"`）：
  `authPanelOpen → authState → tabs → subagentUpdate → subagentLedger → duck → panelInfo → routeMsg(m)`
  —— 与 HEAD 完全一致，`subagentUpdate`/`subagentLedger` 仍是页签过滤前的一行转调。
- 双绑自检：`document.addEventListener('keydown')` 全仓 2 处（tabs.ts 页签 Esc、main.ts 凭证页 Esc，两个不同判定），
  `window.addEventListener('message')` 全仓 1 处（tabs.ts）。无重复绑定。
- **注册顺序**：`initTabs` 装配点刻意留在原 742 行位置（`main.ts` 现 753 行），早于凭证页 IIFE 的 keydown 注册
  （现 950 行）——「Esc 先关浮层 → 再关页签 → 凭证页」的既有相对顺序一字不变。

---

## 四、真机清单（**待用户**，本单无自动化覆盖）

1. 多页签来回切换不串台（每个页签的树只长自己那份）。
2. 后台页签的子 agent 帧回来仍在（切回时浮窗/图标状态恢复，不丢缓存）。
3. Esc 先关浮窗（上下文用量弹层）→ 再关变更页 → 凭证页也照旧能被 Esc 关。
4. 关页签后视图清理干净（DOM 摘除、三个 timer 停、子 agent 浮窗收起）。
5. tab 栏选中态/未读点/busy ×、以及标签条滚动位置保持（宿主 `tabs` 回包重渲后不跳）。

---

## 五、给下一刀（6b/6c）的交接

- `views` 表口径的统一入口现在是 `features/tabs.ts` 的 `viewFor`（同步、懒建）；6c 拆视图工厂时，
  `makeSessionView` 仍在 main.ts，`initTabs({makeView})` 已是注入形态——工厂换文件时只改 import，不用再动 tabs.ts。
- `tabsList` 只读出口 `getTabsList()` 目前唯一调用点是 `applyState` 的页头标题兑底；6c 把 `applyState` 搬进
  `features/statusBar.ts` 时把它一起带走（该函数已在 6c 范围内的 per-view 模块里，直接 import tabs.ts 的导出即可）。
- `tabId` 的两个写点（`activateTab` / `routeMsg`）已同模块，R20 闭合；后续如果动协议打标，只改 `getTabTag()` 一处。
- `handleMsg` 里 `else if (m.type === 'tabs') handleTabs(m);` 仍然是**不可达死分支**（R15）：搬 `handleMsg` 时
  要么原样带走、要么单独立票删，别在重构里"顺手合并"（等于改消息顺序语义）。
