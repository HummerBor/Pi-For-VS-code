# REPORT-t42：webview 拆分第 5 刀 · 子刀 5g —— 消息大纲轨道

- **代码提交：`9283f3f`**（`refactor(webview): 消息大纲轨道搬进 features/outline.ts（第 5 刀 5g，主文件 1244→1164）`）
- **回退：`git revert 9283f3f`**（单提交、纯搬家；回退后 `webview/main.ts` 回到 1244 行，
  `webview/features/outline.ts` 一并删除）
- 基线：`4a3e6ff`（5d+5e 收单文档，main.ts 1244 行）
- 提交文件集（`git show --stat HEAD` 自检：`2 files changed, 172 insertions(+), 96 deletions(-)`）：
  `webview/features/outline.ts`（新建 156）+ `webview/main.ts`（+16/−96）——**只有这两个文件**，
  未动其它模块、未动 `dispatch-t42.md` / `reports/SCOUT-*.md`（报告按 t39/t40/t41 惯例留给收单会话提交）
- 未 push。

## 一、行数账

| 文件 | 前（`4a3e6ff`） | 后（`9283f3f`） | Δ |
|---|---|---|---|
| `webview/main.ts` | 1244 | **1164** | −80 |
| `webview/features/outline.ts` | — | **156** | 新建 |

派单预计 ≈1166，实际 1164（差 2 行：装配注释块写成了 8 行而不是 6 行）。
156 行的构成：模块头注释 26 + `OutlineDeps` 类型 12 + init 别名/装配 7 + **逐字搬入的实现块 94**
+ `dispose` 5 + 出口 9 + 空行。

## 二、搬了什么（行号 = 搬家前 `4a3e6ff`，`git show 4a3e6ff:webview/main.ts | grep -n` 现查）

| 内容 | 原行号 | 行数 | 去处 |
|---|---|---|---|
| 大纲块注释（判定口径 4 行）+ `olAnchors` / `olSpyQueued` / `olSuspend` + `setOlSuspend` | 257–265 | 9 | `outline.ts:47` 起 |
| `outlineRebuild`（含行 click 绑定与闪烁摘类注释） | 266–298 | 33 | `outline.ts` |
| `outlineResize` | 299–304 | 6 | `outline.ts` |
| `olText` | 305–309 | 5 | `outline.ts` |
| `olScan`（含「排队 pill 也进轨道」注释） | 310–321 | 12 | `outline.ts` |
| `olSpy`（含错峰步长/不位移注释） | 322–341 | 20 | `outline.ts` |
| `root.addEventListener('scroll', olSpy, …)` | 343 | 1 | `outline.ts:134` |
| `olRO`（`ResizeObserver` + `observe(root)`） | 344–349 | 6 | `outline.ts:135–140` |
| **合计** | 257–349 | **94** | —— |

**明确未搬**（派单边界）：
- `root.scroll` 上的**跟随贴底**监听（原 793–796，现 `main.ts:712`）——留在原地，未合并、未换序；
- `handleMsg` 正文（一字未动，`addUser`/`renderAll` 仍按原符号名经别名调）；
- 5f 渲染队列（`scheduleRender`/`flushRender`/`deferDuringRender`/`drainPendingStream`）与队列条
  （`addQueuedDom`/`addQueued`/`renderNativeQueue`/`removeQueued`/`rebuildQueuebar`）；
- `scroll`（R7 留家）、`fmtSession`/`applyState`（6c）。

## 三、装配形状

位置：原大纲块所在处（`scroll()` 之后、`setStatus` 之前），`main.ts:257–268`：

```ts
var outline = initOutline({
  root: root, outlineEl: outlineEl, q: q, el: el,
  isActiveView: function () { return id === getActiveTabId(); }
});
```

| dep | 为什么必须注入 / 出处 |
|---|---|
| `root` | RO 的观察对象 + `olSpy` 的滚动坐标系 + scroll spy 挂载点（原闭包成员） |
| `outlineEl` | 本页签的 `#outline`（`q('#outline')`，随视图克隆） |
| `q` | **唯一用途**：`olScan` 只读查队列条 pill（`q('#queuebar').querySelectorAll('.q-item[data-qid]')`）。队列条状态与增删函数全在 main.ts（5f 未搬） |
| `el` | 建 `.ol-row` / `.ol-label` / `.ol-dash`（原闭包工具函数） |
| `isActiveView` | 原 `id !== getActiveTabId()` 两个调用点（`outlineResize` / `olSpy`）的依赖倒置：`id` 是本视图闭包常量，模块看不到，注入 `() => id === getActiveTabId()` |

出口三个：

| 出口 | 使用者 |
|---|---|
| `outlineRebuild` | `initMessageList` 的 deps（原同名注入，形状不变） |
| `setOlSuspend` | 同上（`renderAll` / 空会话早退分支逐条 addUser 时挂起，防 O(N²)） |
| `dispose` | `makeSessionView` 返回的 `dispose()`（见第七节） |

**没有注入 `lang`**：派单草案里写了 `lang`，但搬迁块里没有一处用 `L`（⏳ 前缀是硬编码字符，不是 i18n 键），
注入一个用不到的 dep 就是死代码，故省掉。若后续要把 ⏳ / 空态文案走 i18n，再加。

## 四、硬约束逐条对照

1. **`root.scroll` 两条监听分开**：跟随贴底 `main.ts:712`（`suppressScroll` + `followingEnd` 判定）、
   大纲 spy `features/outline.ts:134`（`passive` 的 `olSpy`）。两条各自独立、顺序未变、没有合并
   （spy 在视图创建早期绑定，跟随贴底在 `makeRoot` 尾部的视图尾巴处绑定，与原相对顺序一致）。
2. **`olScan` 只读队列条**：模块内没有 `queuedItems` / `queuebarEl` 任何状态，只有一次
   `q('#queuebar')` 查询再读 `.q-item[data-qid]` 的 DOM；队列条逻辑 4 个函数与 `rebuildQueuebar`
   仍在 main.ts。
3. **`olRO` 随模块走**：唯一创建点 `outline.ts:136`（init 内、每页签一个），`observe(root)`；
   唯一断开点 `dispose()`（`outline.ts:143`）。`grep -rn "new ResizeObserver" webview/` 只剩这一处，
   不存在第二个 RO 实例、也没有重建路径（`outlineRebuild` 只重排 DOM，不碰 RO）。
4. **`handleMsg` 未动**：`git diff` 里 `handleMsg` 段零改动。
5. **5f 渲染队列未动**：同上。
6. **语义零改**：锚点采样步长（`olScan` 先 pill 后 `.bubble.user`）、hover 错峰（`--d = |j-cur|`，
   只错峰不位移）、点击跳转后摘类（1100ms 定时器 + 清旧定时器，非 `animationend`）、
   切页签回来不重放（`ol-jump` 类必摘）——**逐字搬入，见第五节**。

## 五、逐字核对（94 行块，4 处差异，逐条列理由）

方法：`git show 4a3e6ff:webview/main.ts` 与 `webview/features/outline.ts` 各按
`/── 消息大纲轨道（用户直令/, /^  olRO.observe(root);$/p` 抽段（两侧均 94 行、同为 2 空格基准缩进），
`diff -u` 直比（无需前缀归一化）。

```
@@ -5,7 +5,7 @@      注释：olSuspend 属大纲域「住本文件，5g 未搬」→「住本模块」
@@ -42,7 +42,7 @@     outlineResize: id !== getActiveTabId() → !isActiveView()
@@ -55,7 +55,7 @@     olScan: queuebarEl.querySelectorAll(...) → q('#queuebar').querySelectorAll(...)
@@ -65,7 +65,7 @@     olSpy:        id !== getActiveTabId() → !isActiveView()
```

| # | 差异 | 理由 |
|---|---|---|
| 1 | 注释 `（olSuspend 属大纲域、住本文件，5g 未搬）` → `（olSuspend 属大纲域、住本模块）` | 搬家后「5g 未搬」已成为错误陈述，注释随逻辑走 |
| 2 | `if (id !== getActiveTabId()) return;`（`outlineResize`）→ `if (!isActiveView()) return;` | 依赖倒置；判定表达式一字不差（`() => id === getActiveTabId()`），判定语义、时机不变 |
| 3 | `queuebarEl.querySelectorAll('.q-item[data-qid]')` → `q('#queuebar').querySelectorAll('.q-item[data-qid]')` | 队列条状态不搬；`q` 是原闭包的 `view.querySelector`，同一元素、同一次只读查询（每次 `outlineRebuild` 查一次，与原先「缓存引用」等价——队列条容器每视图唯一且从不替换，`rebuildQueuebar` 只清 `innerHTML`） |
| 4 | `if (id !== getActiveTabId()) return;`（`olSpy`）→ `if (!isActiveView()) return;` | 同 #2 |

**块外新增（不计入逐字核对，属接口面）**：`dispose()` 5 行 + `return {...}` 9 行 + deps 类型 + 模块头注释，
理由见第一/三/七节。DOM class（`ol-row`/`ol-queued`/`ol-label`/`ol-dash`/`cur`/`ol-jump`）、`--d` 变量、
CSS、`_olText`/`_olJumpT` 私有字段、rAF 合顿、1100ms 摘类——**一个字符没动**。

## 六、验证

1. **`npm run compile` 三段全绿**：`vendor-pi` → `typecheck:webview`（零报错）→ `vite build` ×2
   → `tsc -p ./`（零报错），exit 0；全程只跑了 3 次（探针式反复跑禁止），无 `error` 行。
2. **15 组回归同数**：linkify **22** / changespage **10** / ctx **13** / detail **27** / usage **14** /
   price **11** / errclass（all passed）/ diffview **7** / subagent **50** / replay **19** /
   jsonltail **7** / liveness **10** / docktime **7** / html（回归 OK）/ migration（全过）——与派单基线逐项同数。
3. 逐字核对：见第五节（94 行块 4 处差异，全部为符号/依赖替换 + 1 条失真注释订正）。
4. `olRO` 生命周期：创建 1 处、断开 1 处（`dispose`），`grep -rn "new ResizeObserver" webview/` 仅
   `features/outline.ts:136`。
5. 行数账：main.ts **1244 → 1164**；`outline.ts` **156**。
6. 双绑自检：`addEventListener` 计数 `HEAD 37 = 现 main.ts 35 + outline.ts 2`（root scroll spy +
   每条 `ol-row` 的 click），无新增、无丢失。

## 七、唯一非纯搬家项：`dispose()` 里新增 `olRO.disconnect()`

原实现里 `olRO` **从未断开**：页签关闭走 `views[id].dispose()` → `view.remove()`，但 RO 仍持有
`root` 强引用，被摘除的整棵 DOM 树跟着留活（每关一个页签漏一棵）。派单验收要求「`olRO` 不许留孤儿」，
所以本刀在 `makeSessionView` 的 `dispose()` 首行加一句 `outline.dispose()`，模块的 `dispose()` 做
`olRO.disconnect(); olAnchors = [];`。

这是本单**唯一的语义新增**（纯资源释放，不改任何可见行为）；不接受的话回退这一句即回到原状
（RO 泄漏照旧，其它一切不变）。`olAnchors` 清空是给未来可能的「销毁后复用」留的安全线，不影响正常路径。

## 八、真机清单（**待用户**，本会话无 GUI 环境）

- [ ] 右缘轨道锚点数正确：每条 user 消息一根；排队中的消息（queuebar pill）也先占一根，
      发出后换成正式气泡（不重复、不丢）
- [ ] hover 错峰：从当前条向两侧辐射展开文字，不是从上往下流；轨道块始终垂直居中（无位移补偿上飞）
- [ ] 点击轨道条：平滑跳到底部对应消息 + 闪烁一次；连点同一条能重新闪；约 1.1s 后类被摘
- [ ] 点完立刻切到别的页签再切回：旧消息**不重放**闪烁
- [ ] 窗口 resize / 打开关闭横幅 / 输入区高度变化：轨道重算摆位（top 居中、最高 1/3 消息区高）
- [ ] 切页签回来轨道当前条高亮正确（后台不误判，切回由 RO 补算）
- [ ] 超长会话重绘（切历史会话）时轨道一次建好，不逐条抖

## 九、给下一刀（5f / 6c）的接口现状

- 5f 渲染队列：`renderAll` 在 `features/messageList.ts`，其 deps 的 `rebuildQueuebar` 仍是 main.ts
  导出；5f 搬队列条时把它连同 `queuedItems` 一起收进队列模块，messageList 的 dep 只换来源。
  注意 `features/outline.ts` 的 `olScan` 用 `q('#queuebar')` 读 pill——**队列条的 DOM 结构
  （`.q-item[data-qid]` / `.q-text`）是跨模块契约**，5f 改结构必须同步本模块（或改成 inject 一个
  `queuePills()` getter）。
- 6c 视图工厂：`outline` 的装配是一行 `initOutline({...})`，随 `makeSessionView` 走；`dispose()`
  已把 `outline.dispose()` 放在首位，6c 拆视图销毁时照搬这一句即可。
