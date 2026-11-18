# REPORT-t43：webview 拆分第 5 刀子刀 5f——渲染队列（第 5 刀收尾）

- **本单 commit**：`13a530438c18341cca89cbf957d7e44fd21bbc02`（`13a5304`）
- **回滚命令**：`git revert 13a5304`（纯搬家 + 每视图实例化，无迁移、无协议改动；
  revert 即回到 t42/5g 状态，`webview/features/renderQueue.ts` 随之删除）
- 提交文件集（`git show --stat HEAD` 自检，2 个文件，无夹带）：

```
 webview/features/renderQueue.ts | 114 ++++++++++++++++++++++++++++++++++++++++
 webview/main.ts                 |  68 ++++++-----------------
 2 files changed, 134 insertions(+), 48 deletions(-)
```

## 一、做了什么

| 搬走 | 从（`git show HEAD~1:webview/main.ts`） | 到 `webview/features/renderQueue.ts` |
|---|---|---|
| `renderPending` / `liveSyncPending` / `renderTimer` 声明 + 2 行域注释 | 583–587 | `initRenderQueue` 内（逐字） |
| `scheduleRender`（含「三期④ 换镜舞蹈退役」注释） | 588–594 | 逐字 |
| `flushRender`（render → liveSync → drain 同拍顺序） | 595–602 | 逐字 |
| `pendingStream` 声明 + 上方 3 行「启动渲染窗口期」事故注释 | 1023–1027 | 逐字 |
| `deferDuringRender`（含「粘性回显刀」`'user'` 移出延后名单的全部事故注释） | 1028–1037 | 逐字 |
| `drainPendingStream` | 1038–1042 | 逐字 |

模块行数构成（114 行）：模块头注释 27 + `import` 1 + `RenderQueueDeps` 9 + `initRenderQueue`
装配/别名 5 + **逐字搬入的实现块 40**（块 A 21 + 块 B 19）+ handleMsg 读写口 15 + `return` 13。

## 二、deps 形状与 R10

```ts
export function initRenderQueue(deps: {
  renderAll: (list: SessionMessage[]) => void;      // features/messageList.ts（5d）
  applyLiveSync: (msg: SessionMessage) => void;     // features/liveStream.ts（5b）
  routeMsg: (m: HostToWebviewTagged) => void;       // ★ 留 main.ts（6a 才搬），回调注入
}) { ... }
```

main.ts 装配（`makeSessionView` 内，histNav 之后 / handleMsg 之前）：

```ts
  var renderQ = initRenderQueue({
    renderAll: renderAll, applyLiveSync: applyLiveSync,
    routeMsg: function (m) { routeMsg(m); }
  });
```

**R10 落实**：`renderTimer` 只此一份（模块内 `renderQueue.ts:48`）。`handleMsg` 侧不判字段，
统一走 `renderQ.queueDuringRender(m)`（模块内 `renderTimer !== null && deferDuringRender(m.type)`
→ `pendingStream.push(m)` → `return true`）；`drainPendingStream` 经注入的 `routeMsg` 回灌。
`renderAll` / `applyLiveSync` 也只经 deps 调——两边没有任何一份状态副本。
`routeMsg` / `viewFor` / 页签逻辑、队列条 DOM（`.q-item[data-qid]` 等 5g `olScan` 依赖的结构）
一个字没动。

新实例的装配时机在 `msgList`（第 499 行 `var renderAll = msgList.renderAll`）与 `liveStream`
（第 147 行 `applyLiveSync`）之后，deps 求值时两个函数都已就绪。

## 三、main.ts 改动清单（逐处，共 8 处）

**handleMsg 正文只换被调符号，共 4 处**（派单红线）：

| # | 行（t42 HEAD） | 原文 | 现文 |
|---|---|---|---|
| 1 | 606 | `if (renderTimer !== null && deferDuringRender(m.type)) { pendingStream.push(m); return; }` | `if (renderQ.queueDuringRender(m)) return;` |
| 2 | 647（uiState） | `renderPending = m.messages; liveSyncPending = m.live \|\| null; scheduleRender();` | `renderQ.setRenderPending(m.messages); renderQ.setLiveSyncPending(m.live \|\| null); renderQ.scheduleRender();` |
| 3 | 662（render） | `renderPending = m.messages; scheduleRender();` | `renderQ.setRenderPending(m.messages); renderQ.scheduleRender();` |
| 4 | 663（liveSync） | `liveSyncPending = m.message; scheduleRender();` | `renderQ.setLiveSyncPending(m.message); renderQ.scheduleRender();` |

`handleMsg` 其余分支、注释、`built`/`bootPending`/`clearNotice()` 等一律未动；行首的「工单24：
重绘在途……（见 pendingStream 注释）」仍成立（注释所指的注释块已随 `pendingStream` 进模块）。

**handleMsg 之外的 4 处**：

| # | 位置 | 变化 | 理由 |
|---|---|---|---|
| 5 | 583–602 | 21 行状态+两函数 → 8 行装配块（含 4 行注释说明本视图一套 + R10） | 搬家 |
| 6 | 747（dispose） | `if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }` → `renderQ.dispose();` | 定时器归模块；模块内 `dispose()` 逐字保留原三分句 |
| 7 | 1023–1042 | 19 行（注释+`pendingStream`+两函数）→ 2 行指针注释 | 搬家 |
| 8 | 8 / 22 / 142 / 499 | ①`SessionMessage` 从 import 名单删除（搬走后零引用，死 import 清理）②新增 `initRenderQueue` import ③liveStream 别名注释的调用点清单去掉 `flushRender`（该函数已不在本文件）④`var addUser/renderAll` 上方的别名注释去掉 `flushRender` | 随逻辑走 |

`flushRender` 现在只在 `renderQueue.ts` 内被 `scheduleRender` 的 `setTimeout` 回调调用，
main.ts 不再引用；`handleMsg` 里那句「顺序由 flushRender 保证」的注释仍准确（函数确实存在，只是换了文件）。

## 四、逐字核对（归一化零差异）

方法：`git show HEAD~1:webview/main.ts > $TEMP/head-main.ts`，用临时脚本按标记切片 + 去行首空白
（`sed 's/^ *//'` 同口径）逐行比对，未动仓库任何文件。

```
块 A（重绘/续接排队注释 + 3 个状态 + scheduleRender + flushRender）: HEAD 21 行 / 现模块 21 行 → 零差异
块 B（pendingStream 注释 + 声明 + deferDuringRender + drainPendingStream）: HEAD 19 行 / 现模块 19 行 → 零差异
```

**40 行搬入内容逐字零差异，无一处需要列理由**。块外新增（不计入逐字核对，属接口面）：
模块头注释 27 行 + `RenderQueueDeps` 9 行 + `queueDuringRender`/两个 setter/`dispose` 15 行 +
`return` 13 行 —— 即 `initXxx(deps)` 壳（与 5b/5c/5g 同款形状）。

`queueDuringRender` 是把原 `handleMsg` 首行三个符号（`renderTimer !== null` / `deferDuringRender` /
`pendingStream.push`）收成一个判断口，**判定表达式、短路顺序、入队目标、return 时机一模一样**；
收口的原因就是 R10：main.ts 不允许看一眼 `renderTimer`。

## 五、语义论证：`pendingStream` 从「页面级一条」变「每视图一条」

原实现状态归属是**分裂**的：`renderPending`/`liveSyncPending`/`renderTimer` 住 `makeSessionView`
闭包（每页签一套），而 `pendingStream`/`deferDuringRender`/`drainPendingStream` 住外层 IIFE
（全页面一条）。本单统一成每视图一套。等价性：

1. **入队方 = 出队方**：入队条件用的是**收到消息的那个视图**自己的 `renderTimer`（`routeMsg` →
   `viewFor(tid).handleMsg`），而出队发生在**同一个视图**的 `flushRender`。所以每条排队消息
   天生就属于入队它的那个视图，全页面共用一条队列只是碰巧没有别的视图能读到它。
2. **他视图提前冲刷也无害**：若视图 B 的 timer 先fires、把 A 排的条目经 `routeMsg` 放出来，A 此时
   仍在重绘 → `handleMsg` 会把它重新入队；`drainPendingStream` 是同步循环（无 await/无窗口事件
   插队），重入队顺序与快照顺序相同，不会乱序。改动后这些条目直接留在 A 自己的队列里等 A 冲刷，
   顺序、条数完全一致。
3. 可见性边界不变：只有活动页签可见，跨视图交错时序本来就不可观测。

判据「快照先画、事件后补」仍由 `flushRender` 的 `render → liveSync → drainPendingStream` 三段顺序
保证（逐字未动）；`setTimeout(0)` 单拍合并、两个 pending 只留最后一份的合并口径也未动。

## 六、唯一性自检

```
$ grep -rn "var renderTimer\|var pendingStream\|var renderPending\|var liveSyncPending" webview/
webview/features/renderQueue.ts:46  var renderPending: SessionMessage[] | null = null;
webview/features/renderQueue.ts:47  var liveSyncPending: SessionMessage | null = null;
webview/features/renderQueue.ts:48  var renderTimer: number | null = null;
webview/features/renderQueue.ts:69  var pendingStream: HostToWebviewTagged[] = [];

$ grep -rn "renderTimer" webview/ | grep main.ts
webview/main.ts:585/586  （装配块注释，非声明）
webview/main.ts:736      （dispose 注释，非声明）
```

四个声明各唯一（`initRenderQueue` 闭包内 = 每视图一份）；main.ts 只剩注释里的名字。

## 七、编译与回归

1. **`npm run compile` 三段全绿**：`vendor-pi`（1.5.0 拷贝 + 4 项冒烟）→ `typecheck:webview`
   零报错 → `vite build` ×2（main.js 119.04 kB / sessions.js 49.93 kB）→ `tsc -p ./`；
   整体 `EXIT=0`，日志无 `error`/`失败` 行（全程只跑了 2 次：改动后 1 次 + 取退出码 1 次）。
2. **15 组回归同数**（与派单基线逐项相同）：

| 套件 | 结果 | 套件 | 结果 |
|---|---|---|---|
| linkify | **22** 项全过 | diffview | **7 passed** |
| changespage | **10 passed** | subagent | **50** 项全过 |
| ctx | **13 passed** | replay | **19** 项全过 |
| detail | **27/27** | jsonltail | **7/7** |
| usage | **14 passed** | liveness | **10/10** |
| price | **11 passed** | docktime | **7 passed, 0 failed** |
| errclass | all passed | html | 回归 OK（153587 字节） |
| migration | 用例 1–5 全过 | | |

## 八、行数账与第 5 刀总账

| 文件 | 前（`9283f3f`，5g） | 后（`13a5304`，5f） | Δ |
|---|---|---|---|
| `webview/main.ts` | 1164 | **1136** | −28 |
| `webview/features/renderQueue.ts` | — | **114** | 新建 |

派单预计 ≈1119，实际 1136（差 17 行）：被搬走的实码只有 40 行（scout 预估 ≈45），而本单新增
装配块 8 + import 1 + 远端指针注释 2 = 11 行 —— 净减 = 40 − 11 − 1（dispose/handleMsg 换成
同长度单行）= 28。行数少的 5 行是 `deferDuringRender`/`pendingStream` 的注释块比 scout 估算短。

**第 5 刀总账（1806 = 5a 前基线 → 现在 1136，合计 −670）**

| 子刀 | 内容 | main.ts | Δ | commit / 报告 |
|---|---|---|---|---|
| 5a | 渲染基座 → `markdown.ts` + `linkify.ts` | 1934 → 1806 | −128 | `921e922` / REPORT-t38 |
| 5b | live 流式 → `liveStream.ts` | 1806 → 1659 | −147 | `35ba761` / REPORT-t39 |
| 5c | 工具行 → `toolRows.ts` | 1659 → 1534 | −125 | `e8804ed` / REPORT-t40 |
| 5d+5e | 整树重绘 + 粘性气泡 → `messageList.ts` + `sticky.ts` | 1534 → 1244 | −290 | `2e0e07f` / REPORT-t41 |
| 5g | 消息大纲轨道 → `outline.ts` | 1244 → 1164 | −80 | `9283f3f` / REPORT-t42 |
| 5f | 渲染队列 → `renderQueue.ts` | 1164 → 1136 | −28 | `13a5304` / 本报告 |
| **第 5 刀** | 1806（5a 后基线）→ **1136** | | **−670** | 含 5a 则为 1934 → 1136 = −798 |

第 5 刀新建模块合计 1413 行：markdown 106 + linkify 112 + liveStream 244 + toolRows 197 +
messageList 348 + sticky 136 + outline 156 + renderQueue 114。

## 九、真机清单（**待用户**，本会话无 GUI 环境）

- [ ] 大会话切历史不卡：切到长会话，整页重绘一次成树（renderTimer 单拍合并仍在）
- [ ] 流式期间切页签不丢字：A 页签流式中切到 B 再切回，A 的在途正文/工具行完整、不重复
- [ ] 连续性写入时不重排：长回合里正文持续增长，段落顺序不乱、不闪回旧快照
- [ ] 重绘窗口期（切历史瞬间 + 立即发一条消息）回显气泡照常秒出（`'user'` 仍不在延后名单）
- [ ] 压测：`/compact` 后立刻有流式输出，压缩块与在途消息顺序正常

## 十、给 6a（路由/视图工厂）的接口现状

- `routeMsg` / `viewFor` / `handleTabs` / `activateTab` / `renderTabs` 仍在 `main.ts`，未动。
  6a 搬路由时把 `renderQ` 的 deps 里 `routeMsg: function (m) { routeMsg(m); }` 换成新宿主入口即可，
  模块内不用改一行。
- `renderQueue.ts` 对外只有 5 个口：`scheduleRender` / `queueDuringRender` / `setRenderPending` /
  `setLiveSyncPending` / `dispose`。`flushRender` / `deferDuringRender` / `drainPendingStream` 是模块私有
  （只由 `scheduleRender` 的回调与 `queueDuringRender` 内部调用），别再往 main.ts 暴露。
- `dispose` 顺序：`outline.dispose()` → `ctxPop.dispose()` → `clearInterval(busyTimer)` →
  `clearStreamTimer()` → `renderQ.dispose()` → 摘 DOM。6c 拆视图销毁时照搬这一顺序。
- 队列条 DOM 未动：`rebuildQueuebar` / `addQueuedDom` / `queuedItems` 仍住 `main.ts`
  （5f 只搬渲染队列，不搬队列条），`outline.ts` 的 `olScan` 读 `.q-item[data-qid]` 的结构契约不变。
