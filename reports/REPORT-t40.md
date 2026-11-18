# REPORT-t40：webview 拆分第 5 刀 · 子刀 5c —— 工具行 → `features/toolRows.ts`

- **代码提交：`e8804ed`**（`refactor(webview): 工具行搬进 features/toolRows.ts（第 5 刀 5c，主文件 1659→1534）`）
- **回退：`git revert e8804ed`**（单提交、纯搬家；回退后 `webview/main.ts` 回到 1659 行，`webview/features/toolRows.ts` 一并删除）
- 基线：`35ba761`（5b live 流式落地，main.ts 1659 行）
- 提交文件集（`git show --stat HEAD` 自检：`2 files changed, 209 insertions(+), 137 deletions(-)`）：
  `webview/features/toolRows.ts`（新建 197 行）+ `webview/main.ts`（+12 / −137）
- 未 push；`dispatch-*.md`、`reports/SCOUT-*.md`、`scripts/.preview/` 一个都没动（本报告文件本身也未提交，按 t38/t39 惯例留给收单会话）

## 一、行数账

| 文件 | 前（`35ba761`） | 后（`e8804ed`） | Δ |
|---|---|---|---|
| `webview/main.ts` | 1659 | **1534** | −125 |
| `webview/features/toolRows.ts` | — | **197** | 新建 |

预估 ≈1540，实际 1534。差额来源：装配块 7 行（原 11 行成组注释 + 1 行声明换成 9 行 装配/别名块）；
`renderAll` 两行 reset 收成一行（−1）；搬走的函数本体 122 行 + 状态 12 行。

## 二、搬了什么（行号 = `HEAD~1`，即搬家前）

| 内容 | 原行号 | 行数 | 说明 |
|---|---|---|---|
| `toolStart` | 695–735 | 41 | 建行（`tool run` / `t-dot` / `t-name` / `t-detail` / `t-arrow` chev / `tool-box` / IN 行）+ 点击开合（含「工单29扩权」全量 OUT 一次性换入）+ 成组判定（start 时挂组/开新组） |
| `toolEnd` | 736–816 | 81 | `start` 缺失兜底建行 + 行/盒重建 + OUT 预览 1000 字 + 全量引用 `ref.full` + 完成即收盒 + 组员并入组头（隐藏自身行/盒、`delete toolEls[id]`、×N 徽标、`hasErr` 整组红）+ 组头收尾徽标重挂 |
| 成组语义注释块 | 197–207 | 11 | 0.1.29 方案 + 0.1.37 重工（乱序完成）事故史，随 `lastToolGroup` 一起搬 |
| `lastToolGroup` 声明 | 208 | 1 | 成组指针（`name/anchor/count/hasErr/tailRow/tailBox`） |
| `toolEls` | 119（同行带 `queuedItems`） | 1 | 工具行索引；`queuedItems` 留在 main.ts |

**DOM 片段全部在函数体内**：`t-detail` / `t-arrow`（chev 走 `ico`）/ `t-count` / `tool-box` / `tb-row` / `tb-tag` / `tb-val` / `tb-full` 的建、查、改都在 `toolStart`/`toolEnd` 正文里，没有留在家里的散句。
（另：SCOUT 3.1 提到的 `abox` 是**在途工具块的参数预览盒**，属 `liveBlock` 的 `kind==='toolCall'` 分支
——5b 已独占在 `features/liveStream.ts:76-83`，按派单边界本单不碰，故不进工具行模块。）

**明确未搬**：`renderAll`（5d）、大纲 `outlineRebuild/olSpy/olScan`（5g）、渲染队列
`scheduleRender/flushRender/deferDuringRender/drainPendingStream`（5f）、`liveBlock` 的
`kind==='toolCall'` 分支（5b，文件一行未碰）。

## 三、装配形状（`initToolRows(deps)`）

位置：原 `lastToolGroup` 声明处（`makeSessionView` 内、`initLiveStream` 之前），每页签一套实例。

```ts
var toolRows = initToolRows({
  root: root, el: el, ico: ico, linkify: linkify, lang: L, scroll: scroll
});
var toolStart = toolRows.toolStart; var toolEnd = toolRows.toolEnd;
var resetToolRows = toolRows.resetToolRows;
```

| dep | 为什么必须注入 |
|---|---|
| `root` | 工具行/内容盒往本视图消息区挂 |
| `el` | 建 DOM（`tool run` / `tb-row` / `t-count` …） |
| `ico` | `chev` 折叠箭头（本域唯一的图标使用） |
| `linkify` | IN 摘要与 OUT 文本都要扫路径（`features/linkify.ts` 的基座；与 5b 注入 `renderRich` 同款：页面级 var，视图懒建，赋值早于建视图） |
| `lang` | `L.toolTruncated`（超 1000 字的 tooltip） |
| `scroll` | **R7 红线**：滚动跟随留 main.ts（它调 `applySticky(stickyQ)`），模块只调不持有 |

**R11（pdet）**：`toolStart`/`toolEnd` 正文里**本来就没有** `pdet`（5b 已把它独占在 liveStream），
本模块没有为它开任何口子。全仓 `pdet` 声明唯一仍在 `features/liveStream.ts:53`；
`webview/main.ts` 里 `grep -n "pdet"` 只剩第 218 行注释一处（0 处实际使用）；
`toolRows.ts` 里只出现在文件头红线注释。

**状态缝（新出口 1 个）**：`resetToolRows()` —— `renderAll` 开头原来两句裸赋值
（`toolEls = {};` / `lastToolGroup = null;`）搬进模块出口，外部不再持有这两个变量。

## 四、`handleMsg` 与其它调用点（逐处清单）

**`handleMsg` 正文 0 字改动**（diff 里没有任何 hunk 落在 988–1004 区间）。全部调用点都靠**同名别名**继续调，一个符号都没换：

| 位置（新行号） | 代码 | 变化 |
|---|---|---|
| `main.ts:996` | `liveReset(); toolStart(m.id, m.name, m.detail);` | 无（`toolStart` 现为别名） |
| `main.ts:1004` | `else if (m.type === 'toolEnd') toolEnd(m.id, m.name, m.isError, m.text, m.detail);` | 无（`toolEnd` 现为别名） |
| `main.ts:814` | `toolStart(hid, c.name, det, true);`（renderAll 历史重放） | 无 |
| `main.ts:817` | `if (res) { res.used = true; toolEnd(hid, c.name, …); }` | 无 |
| `main.ts:747` | `resetToolRows(); // 工具行索引作废（重绘后 DOM 全换，见 features/toolRows.ts 的 resetToolRows）` | **唯一调用点替换**：原两句 `toolEls = {}; lastToolGroup = null;`（含原注释）收成一行；原注释逐字搬进模块 `resetToolRows` 体内 |

`main.ts` 全量 diff 恰好 5 个 hunk：`+import` / `toolEls` 声明拆分 / 注释块+声明换装配块 /
删两个函数体 / `renderAll` 两句 reset。没有第六处。

## 五、逐字核对（零差异）

脚本：`%LOCALAPPDATA%/Temp/t40/verbatim.mjs`（不入库，从 `git show HEAD~1:webview/main.ts`
与模块里按「`function 名字(` + 花括号配对」抽正文，归一化=去行首尾空白 + 丢空行，逐字比对）：

```
✔ 零差异 toolStart  (41 行)
✔ 零差异 toolEnd    (81 行)
✔ 零差异 成组注释块
✔ 零差异 lastToolGroup 声明
HEAD 871/872 === 模块 resetToolRows 两句: true
全部零差异 ✅
```

**差异逐条（只有这些，且都不是被搬函数的正文）**：
1. 新文件头注释（红线条目：R11 pdet / 成组语义 / 状态归属 / DOM 与协议零改动）。
2. `var toolEls = {};` → `var toolEls: Record<string, any> = {};`（补类型标注，原行与 `queuedItems` 同行，
   拆开后单列；行为等价，`strict:false` 下也无门禁差异）。
3. main.ts 装配块 9 行（新增注释 4 行 + `initToolRows` 3 行 + 别名 2 行）替换原 11 行成组注释 + 1 行声明
   （注释块与声明原样搬进了模块）。
4. `renderAll` 的两句 reset → 一行 `resetToolRows()`（模块内正文逐字相同，注释随逻辑搬进模块）。
5. `toolRows.ts` 内 `resetToolRows` 上新增一段 docstring（说明为什么重绘前必须清、以及
   「相邻判定本身也兜底」是第二道守卫）。

## 六、验收

1. **`npm run compile` 三段全绿**（最终态复跑）：`vendor-pi` 冒烟三项 → `typecheck:webview`
   （tsc 零报错）→ `build:webview`（vite 18 modules + sessions 4 modules）→ `tsc -p ./`，`EXIT=0`。
2. **15 组回归同数**（改动前基线 / 改动后一致）：

| 用例 | 结果 |
|---|---|
| `test:linkify` | **22 项全过** |
| `test:html` | OK（`getHtml 回归 OK`，151805 字节；5b 时 151576，+229B = 多一层模块中转，属预期，断言不变） |
| `test:changespage` | 10 passed |
| `test:ctx` | 13 passed |
| `test:detail` | 27/27 |
| `test:usage` | 14 passed |
| `test:price` | 11 passed |
| `test:errclass` | all passed |
| `test:diffview` | 7 passed |
| `test:subagent` | 50 项全过 |
| `test:replay` | 19 项全过 |
| `test:jsonltail` | 7/7 |
| `test:liveness` | 10/10 |
| `test:docktime` | 7 passed |
| `test:migration` | 用例全过 |

3. **逐字核对零差异**：见第五节。
4. **行数账**：见第一节（1659 → 1534，−125；模块 197 行）。
5. `grep -n "pdet" webview/main.ts` = 1 处注释、0 处实际使用；`pdet` 声明全仓唯一在 `liveStream.ts:53`。

## 七、真机清单（**待用户**）

工具行语义零改，但成组是「看起来一样、实际可能散」的典型，装包后逐项看：
- [ ] 并行工具批次 `×N` 成组（4 连 read 应是一行 `read ×4`）
- [ ] 乱序完成仍并入组头（end 序 ≠ 行序，不能散成单行）
- [ ] 点开工具行 → 展开全量 IN/OUT；超 1000 字的 OUT 首次点开换全量且限高滚动
- [ ] 失败工具行红态；组内任一失败 → 整组红（`hasErr`）
- [ ] 切历史会话整页重绘后，工具行仍能成组（`resetToolRows` 生效路径）
- [ ] 流式期间「生成参数 (N 字符)」计数仍随 `toolCallDelta` 走动（R11 未破：`setPDet` 口）

## 八、给下一位的环境提示（非本单改动）

- 本仓 `core.autocrlf=true`：`git show HEAD:<file>` 取到的 blob 仍是纯 LF（已用 node 逐字节确认
  `CR 0 / LF 1534`），`git status` 的假 ` M` 按老办法 `git update-index --refresh -- <文件>` 处理再提交。
- **Windows 路径坑**：git bash 的 `/tmp` 与 node 的 `/tmp` 不是同一个目录（node 会解析成 `D:\tmp`）。
  本单的临时基准/核对脚本都写在 `%LOCALAPPDATA%/Temp/t40/`（`$LOCALAPPDATA/Temp/t40`），别再用 `/tmp`。
- 新建文件走 `git add -- <explicit path>` + `git commit -m "..." -- <files>`（untracked 文件不能直接
  靠 pathspec 提交）；提交后 `git show --stat HEAD` 自检文件集，本单只有 2 个文件。
- 5d（messageList）接手时注意：`renderAll` 现在通过 `resetToolRows()` 触达工具行状态，不再直接持有
  `toolEls/lastToolGroup`；搬 `renderAll` 时把 `resetToolRows` 一并作为 deps 注入即可。
