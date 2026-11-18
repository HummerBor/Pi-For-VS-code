# REPORT-t34：webview 拆分第 3 刀——子 agent 浮窗 → features/subagentDock.ts

## 一、改了什么

| 文件 | 变更 |
|---|---|
| `webview/features/subagentDock.ts` | **新增 523 行**（其中 397 行是从 main.ts 逐字搬来的核心块 + 文件头/依赖接口/入口返回） |
| `webview/main.ts` | 2654 → **2229 行**（-425）；`git diff --stat` = 23 insertions / 448 deletions |

搬出去的东西（原 main.ts 2045–2441、2446–2452、2496–2515、2605–2626）：

- 浮窗单例与几何：`subdock` / `subCollapsed` / `dockDragged` / `dockSetCollapsed` / `dockResetPos` / `dockEnsure`（含拖动与「拖动 vs 点击」分离）
- 概览渲染：`SM_ICONS` / `agentColor` / `renderSubDock` / `renderSubOverview` / `renderSubRow`（状态徽标、失败原因行、秒表列、失联降级、封顶 8 条 + 「展开剩余」、台账行并入同一张表 + 跨页签 `liveSeen` 去重）
- 秒表：`setInterval(…,1000)` 重绘循环 + `refreshSubTimes` 就地刷时间列
- 状态：`subRunsByTab` / `SubRunRec` / `subRunsOf` / `anySubRunning` / `anySubLive` / `runStale` / `SUB_STALE_MS` / `updateSubRun` / `subSeenByTab` / `subLedgerRows` / `subShowAllDone` / `subRunning` / `subCollapsedByTab`
- 文案与格式：`fmtElapsed` / `fmtRel`
- 接线：`updateSubInd`（页头 cpu 锚点 + `subind-live` 行）、`renderSubChip`（状态行 chip）、`bind()`（原 2446–2452 的两处页面级点击绑定）、`applyTabSubState`（原样搬，出口名叫 `applyTab`）、消息消费（原 window `message` 里的 `subagentUpdate` / `subagentLedger` 两支，出口叫 `handleUpdate` / `setLedger`）

main.ts 一侧只留实例与转调：

```ts
import { initSubagentDock } from "./features/subagentDock"; // 子 agent 浮窗（原住本文件，第 3 刀）

  var subDock = initSubagentDock({
    lang: L, el: el, elIco: elIco, ico: ico, linkify: linkify,
    post: function (m) { vscode.postMessage(m); },
    getActiveTabId: getActiveTabId,
    sessionArea: sessionArea,
    subindEl: subindEl,
    refreshBusy: function (tid) { viewFor(tid).refreshBusy(); }
  });
```

调用点（都是原位替换，没有挪顺序）：

| 原 | 改 |
|---|---|
| `renderBusyUi` 里的 `subRunsOf(id)` / `anySubLive(r)` | `subDock.runsOf(id)` / `subDock.anyLive(r)` |
| 两段页面级 `addEventListener` | `subDock.bind();`（同位置） |
| `applyTabSubState(tid)` | `subDock.applyTab(tid)`（同位置） |
| `if (m.type === 'subagentUpdate') { …20 行… }` | `subDock.handleUpdate(m)` |
| `if (m.type === 'subagentLedger') { … }` | `subDock.setLedger((m as any).rows \|\| [])` |

顺手清的死代码**只有本刀自己制造的**：`import type { SubagentSnapshot }`（搬空后 main.ts 零引用）。

## 二、为什么这么切

1. **照已验有效的模式**：`initSubagentDock(deps)` + 返回入口，与 `initChangesPage` / `initCtxPopover` 同款。
   浮窗本身是页面级单例（`subdock`/`subCollapsed`/`dockDragged`），但**数据按页签**（`subRunsByTab`/
   `subCollapsedByTab`/`subSeenByTab`）——宿主按 tabId 推帧，后台页签不渲染但必须缓存。所以状态关进
   init 闭包，跨文件只交宿主真需要的 6 个入口（bind / applyTab / handleUpdate / setLedger / runsOf / anyLive）。
2. **消息消费一起搬**：`subagentUpdate` / `subagentLedger` 两支只服务浮窗（截获点、缓存、重绘、状态行重算
   全在浮窗语义里），留 main 只会让「main 里还在写浮窗内部数据」的重影长期存在。`viewFor(tid).refreshBusy()`
   经 deps 注入，main 侧只提供 `viewFor`，浮窗模块不碰视图对象。
3. **不碰的**：`bindComposerOnce` 一个字没动；输入区、消息渲染、页签工厂、`src/`、`protocol.ts`、`harness/`、
   `style.css` 全部零改动；消息协议字符串一个没改。

## 三、逐字核对（4 处，命令可复跑）

基线一律 `git show HEAD:webview/main.ts`。归一化只做**名字转调**，不碰正文/注释/空白/顺序。
全刀只有 3 类转调：

| 转调 | 次数 | 原因 |
|---|---|---|
| `vscode.postMessage(` → `post(` | 3 | 模块拿不到 `vscode` 宿主 API，走 deps 注入 |
| `viewFor(getActiveTabId()).refreshBusy()` → `refreshBusy(getActiveTabId())` | 1（删失联行时） | 同上，`viewFor` 只在 main 有 |
| `viewFor(stid).refreshBusy()` → `refreshBusy(stid)` | 2（`subagentUpdate` 两支） | 同上 |

### ① 核心块 397 行：`HEAD[2045-2441]` ≡ `subagentDock.ts[56-452]`

```bash
git show HEAD:webview/main.ts | sed -n '2045,2441p' \
  | sed -e 's/vscode\.postMessage(/post(/g' \
        -e 's/viewFor(getActiveTabId())\.refreshBusy()/refreshBusy(getActiveTabId())/g' > A.txt
awk 'NR>=56 && NR<=452' webview/features/subagentDock.ts > B.txt
diff -u A.txt B.txt && echo IDENTICAL_OK
```
输出原文：

```
IDENTICAL_OK 核心块 HEAD[2045-2441] == subagentDock.ts[56-452]
  397 A.txt
  397 B.txt
```

→ 397 行**零差异**（`diff` 退出码 0），含全部事故注释、阈值、正则 `/^sa-(?:\d+|[0-9a-f]{8})$/`、封顶 8 条。

### ② 页面级绑定：`HEAD[2447-2452]` ≡ `bind()` 体内 6 行（只多 2 空格缩进）

```bash
git show HEAD:webview/main.ts | sed -n '2447,2452p' | sed 's/^  //' > b1.txt   # 前置补 2446 的注释行
sed -n '/^  function bind() {/,/^  }$/p' webview/features/subagentDock.ts | sed -n '2,8p' | sed 's/^    //' > b2.txt
diff -u b1b.txt b2.txt && echo BIND_OK
```
输出：`BIND_OK`（`subindEl` 那条 + `sessionArea` 的 `#subchip` 委托，一行不差；缩进从 IIFE 的 2 空格变 bind 体内的 4 空格）。

### ③ 页签状态：`HEAD[2499-2515]` ≡ `function applyTabSubState`

```bash
git show HEAD:webview/main.ts | sed -n '2499,2515p' > a1.txt
sed -n '/^  function applyTabSubState/,/^  }$/p' webview/features/subagentDock.ts > a2.txt
diff -u a1.txt a2.txt && echo APPLYTAB_OK
```
输出：`APPLYTAB_OK`（函数名故意不改，出口别名叫 `applyTab`；含「不能走 dockSetCollapsed」事故注释）。

### ④ 消息消费：`HEAD[2606-2618]` ≡ `handleUpdate` 体（只差缩进 + 2 处 `refreshBusy`）

```bash
git show HEAD:webview/main.ts | sed -n '2606,2618p' > h1.txt
sed -n '/^  function handleUpdate/,/^  }$/p' webview/features/subagentDock.ts | sed -n '2,14p' | sed 's/^  //' > h2.txt
diff -u h1.txt h2.txt
```
差异**只有两行**（其余逐字一致）：

```diff
-        viewFor(stid).refreshBusy(); // 壳删除也可能翻转「还在跑」判定 → 状态行重算
+    refreshBusy(stid); // 壳删除也可能翻转「还在跑」判定 → 状态行重算
-      viewFor(stid).refreshBusy(); // 子 agent 开跑/收尾翻转「主会话还在干活」：Working 走秒/冻结值接力
+    refreshBusy(stid); // 子 agent 开跑/收尾翻转「主会话还在干活」：Working 走秒/冻结值接力
```

（`setLedger` 是原 `subLedgerRows = (m as any).rows || []; renderSubDock();` 两行，原样。）

## 四、验证（原文）

### `npm run compile`（三段全绿）

```
[vendor-pi] 已拷贝 pi 1.5.0 → vendor/pi/dist/bundle
[vendor-pi] 冒烟通过：SDK 入口齐全
[vendor-pi] 冒烟通过：用户扩展加载链路（jiti + virtualModules）可用
[vendor-pi] 冒烟通过：photon WASM 可编译

> pi-for-vscode@0.1.50 typecheck:webview
> tsc -p webview --noEmit          ← 零报错（strict:false，未加 @ts-nocheck）

> pi-for-vscode@0.1.50 build:webview
✓ 12 modules transformed.           ← 原 11 → 12（新模块）
dist/webview/main.css   36.28 kB │ gzip:  7.66 kB
dist/webview/main.js   115.10 kB │ gzip: 40.59 kB    ← 改前 114.77 kB（+0.33 kB = 拆模块的入口/包装开销）
dist/webview/sessions.css   5.28 kB
dist/webview/sessions.js   49.79 kB
```
（vite 后是 `tsc -p ./`，无输出 = 通过。）

### 全套回归（改动前后逐项对比，零回退）

| 命令 | 改动前 | 改动后 |
|---|---|---|
| `test:changespage` | `changesPage: 10 passed` | `changesPage: 10 passed` |
| `test:html` | `getHtml 回归 OK（…HTML 149318 字节）` | `getHtml 回归 OK（…HTML 149748 字节）` |
| `test:subagent` | `subagentSnapshot: 50 项全过` | `subagentSnapshot: 50 项全过` |
| `test:replay` | `subagentReplay 用例：15 项全过 ✅` | `subagentReplay 用例：15 项全过 ✅` |
| `test:jsonltail` | `test-jsonltail: 7/7 通过` | `test-jsonltail: 7/7 通过` |
| `test:ctx` | `ctxBreakdown: 13 passed` | `ctxBreakdown: 13 passed` |
| `test:usage` | `usageTotals: 14 passed` | `usageTotals: 14 passed` |
| `test:price` | `priceTable: 11 passed` | `priceTable: 11 passed` |
| `test:detail` | `toolDetail 口径用例：27/27 全过 ✅` | `toolDetail 口径用例：27/27 全过 ✅` |
| `test:revert` | `patchRevert 用例: 12 项全部通过` | `patchRevert 用例: 12 项全部通过` |
| `test:linkify` | `linkify 口径用例 22 项全部通过` | `linkify 口径用例 22 项全部通过` |
| `test:errclass` | `errorClass.test.mts: all passed` | `errorClass.test.mts: all passed` |
| `test:diffview` | `diffView: 7 passed` | `diffView: 7 passed` |
| `test:migration` | `modelMemory（C 刀口径）用例全过 ✅` | `modelMemory（C 刀口径）用例全过 ✅` |

`test:html` 的字节数**不是回归**：它把整个 `dist/webview/main.js` 内联进 HTML（`webview-html.ts` 的 `{{js}}`），
`main.js` 大了 0.33 kB，HTML 跟着大 ~0.4 kB；另外 nonce 是 `Math.random().toString(36)`，长度本身每次浮动 ±2
（连跑三次：149750 / 149748 / 149750）。用例断言的是资源路径，非字节数。

改动后 `test:html` 完整行：`getHtml 回归 OK（资源路径正确，HTML 149748 字节）`

### 行数账

```
改前：webview/main.ts 2654
改后：webview/main.ts 2229   webview/features/subagentDock.ts 523
```
`main.ts` -425；新增模块 523 = 文件头 + deps 接口 43 行 + init 开头与别名 12 行 + **搬出的正文 397 行**
+ `bind` 12 行 + 页签状态（`subCollapsedByTab` + `applyTabSubState`）21 行 + 消息入口（`handleUpdate` +
`setLedger`）23 行 + 返回对象 15 行。

### 构建产物一致性抽查（确认没有搬重复）

```
subagentOpenSession: 1     sm-more-row: 1     subind-live: 1
```
（各只出现一次 → 旧实现没有残留在 main.js 里被二次打包。）

## 五、遗留 / 请示

1. **没补自动化用例，请总监裁决要不要**：本刀是纯 webview DOM 逻辑，`webview` 侧 `tsc --noEmit`（无 out 产物），
   仓库里也没有可复用的 DOM shim（`scripts/test/smoke-*.mjs` 都是真 pi 会话探针）。要覆盖浮窗必须写一整套
   `document/window/acquireVsCodeApi` 桩去跑 `dist/webview/main.js`。第 2 刀（ctxPopover，同为纯 webview）也没有
   用例，所以本刀按「无对应基线则不加」处理——**要不要立一个 `test:webviewdock`（DOM shim + 帧/台账注入）请你定**。
2. **搬过来的注释里有历史残迹**：块头注释仍写「点击下钻」「`subagentDetailRequest` → 宿主留存的全量 details」，
   而 2026-11-19 已删下钻与明细浮层。按「搬动逐字核对」原样保留未改，**只记录不删**（要清理请单开一笔）。
3. **双源仍在**（交接文档六.1）：活行走帧、台账行补历史，`subLedgerRows` 与 `subRunsByTab` 各自到达、`liveSeen` 去重
   只在渲染侧。本刀不改语义。
4. **工作树是共享的**：本单基线（改动前 compile + 14 项测试）跑完后，`src/core/i18n.ts` / `src/vscode/sessionsView.ts` /
   `webview/sessions.ts` 出现了**别的单**的未提交改动（会话列表「复制 jsonl 路径」，纯增量 22 行）。我的改动后
   compile/测试是在含这些改动的树上跑的；两份结果逐项相同，且那三个文件与本刀无交集。提交时只 `git add` 了本单 3 个文件。
5. **没验的**：真机目视（浮窗出不出、秒表跳不跳、kill 后是否落终态、切页签现场是否恢复）。本机没装包、没重启宿主，
   按单子要求只到「编译 + 测试 + 逐字核对」。
