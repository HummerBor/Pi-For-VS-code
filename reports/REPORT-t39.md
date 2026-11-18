# REPORT-t39：webview 拆分第 5 刀 · 子刀 5b —— live 流式 → `features/liveStream.ts`

- **代码提交：`35ba761`**（`refactor(webview): live 流式搬进 features/liveStream.ts（第 5 刀 5b，主文件 1806→1659）`）
- **回退：`git revert 35ba761`**（单提交、纯搬家，无依赖其它未提交改动；回退后 `webview/main.ts` 回到 1806 行、`liveStream.ts` 一并消失）
- 基线：`3690ac3`（5a 收单报告，代码基线 `921e922`：main.ts 1806 行 / `features/markdown.ts` + `features/linkify.ts` 已就位）
- 提交文件集（`git show --stat HEAD` 自检一致）：`webview/main.ts`(187 行变更) + `webview/features/liveStream.ts`(新建 244 行)
- 未 push；`dispatch-*.md`、`reports/SCOUT-*.md`、`scripts/.preview/` 均未提交

## 一、行数账

| 文件 | 前 | 后 | Δ |
|---|---|---|---|
| `webview/main.ts` | 1806 | **1659** | −147 |
| `webview/features/liveStream.ts` | — | **244** | 新建 |

预估 ≈1650，实际 1659（差 9 行 = 装配块注释与 5 个状态口函数，见第三、四节）。

## 二、搬了什么（行号 = `HEAD~1`，即搬家前）

| 函数 | 原行号 | 说明 |
|---|---|---|
| `liveEnsure` | 681–685 | 在途 assistant 气泡 + liveMsg/liveParts 建基 |
| `liveBlock` | 686–712 | 按 content 段建 thinking/toolCall/text 块，`pdet` 在此赋值 |
| `finalizeLive` | 713–728 | 收尾：思考块收起 + text 尾巴定型 |
| `liveReset` | 729 | 清四件套（含 `pdet`） |
| `appendFinal` | 732–737 | 行级定型（`renderRich` 一次成块） |
| `setMdTail` | 738–748 | 尾巴区：表格行富文本 / 半截行 textContent |
| `streamTick` | 749–795 | 围栏行首判定 + 表格防劈叉 |
| `scheduleStream` | 796–803 | **存量死代码，未删除（见第七节）** |
| `appendDelta` | 804–808 | 正文增量 |
| `appendThink` | 809–818 | 思考增量（贴底才自动滚） |
| `applyLiveSync` | 1225–1247 | 续接重定基 |
| 状态行 | 208 | `liveMsg / liveDiv / pdet / liveParts / liveRTimer` 五个一行整句搬入模块 |

## 三、装配形状（`initLiveStream(deps)`）

```ts
var liveStream = initLiveStream({ root: root, el: el, renderRich: renderRich, lang: L, scroll: scroll });
```

| dep | 为什么必须注入 |
|---|---|
| `root` | 气泡往本视图消息区挂（每页签一棵树） |
| `el` | 建 DOM（`bubble assistant` / `details.think` / `md-p` / `pre.code`） |
| `renderRich` | 5a 的 `features/markdown.ts` 基座（文本块定型） |
| `lang` | `L.thinkingProcess` / `L.genArgs` |
| `scroll` | **R7 红线**：滚动跟随留 main.ts（它调 `applySticky(stickyQ)`），模块只调不持有；全仓仍只有一份 `stickyQ`（`grep -c stickyQ webview/main.ts` = 7 处，全是原样调用点） |

**与 SCOUT 3.2 的差异（一处）**：scout 写 `{ root, lang, el, ico, ..., scroll }`，实际**不需要 `ico`** —— live 域唯一的图标使用在 `toolStart` 的 `chev` 箭头，那属 5c。不注入不存在的依赖（避免 5c 误以为这里也在用）。

装配位置：原第 208 行（状态行）处，仍在 `makeSessionView` 内 —— 每页签一套实例，与 4 刀 composer 同款。`scroll`/`el` 是函数声明（hoisted），`renderRich` 是页面级 `var`（视图是懒建的，`viewFor` 只在消息/事件到达后调），与既有 `initComposer({ el: el, ico: ico })` 的时机一致。

main.ts 保留的别名（**只留真被用到的**，不生造死别名）：
`finalizeLive / liveReset / liveBlock / appendDelta / appendThink / applyLiveSync` + 状态缝 5 个。
未搬别名：`liveEnsure / appendFinal / setMdTail / streamTick / scheduleStream` —— 搬走后 main.ts 已无调用点（`liveEnsure` 仅剩一行历史注释提及）。

## 四、状态缝（新增 5 个函数，全部是 handleMsg/dispose 里原来那半句）

派单要求「`pdet` 不出 liveStream 模块」「`handleMsg` 正文只能换被调符号」，而 `handleMsg`/`dispose` 里各有直接读写闭包状态的一句。处理办法是把那半句整句搬进模块，外部换成函数调用：

| 模块出口 | 内句出处（`HEAD~1`） | 精确性 |
|---|---|---|
| `liveToolPart(ci)` | toolCallDelta 的 `liveMsg && liveMsg.content[m.ci]` | 等价（liveMsg 假值→`null`，同原值） |
| `bindToolPart(ci, p)` | toolCallStart 的 `liveMsg.content[m.ci] = tp;` | 逐字（此处 liveMsg 必已由 `liveBlock` 建好） |
| `setPDet(text)` | toolCallDelta 的 `if (pdet) pdet.textContent = L.genArgs.replace(...)` | 参数化提取，守卫与副作用逐字；**`pdet` 仍只在本模块赋值/清空/读取（R11 达成）** |
| `dropEmptyLive()` | toolStart 分支的 `if (liveDiv && !liveDiv.textContent && !liveDiv.querySelector('img')) liveDiv.parentNode.removeChild(liveDiv);` | 逐字收录（自动比对已验，见第五节） |
| `clearStreamTimer()` | `dispose` 的 `if (liveRTimer) { clearTimeout(liveRTimer); liveRTimer = null; }` | 逐字收录 |

`pdet` 三处（`liveBlock` 赋值 / `liveReset` 清 / `setPDet` 读）全在模块内，main.ts 不再出现该标识符 —— **第 5c 单搬 `toolStart/toolEnd` 时不需要、也不许带走它**；5c 若需读进度节点，继续走本模块出口加口，别在 main.ts 复制一份。

## 五、逐字核对（零差异）

脚本：`scripts/.preview/t39-verbatim.mjs`（不入库），从 `git show HEAD~1:webview/main.ts` 与模块里按「`function 名字(` + 花括号配对」抽正文，归一化（去行首尾空白、丢空行）后逐字比对：

```
✔ 零差异 liveEnsure     ✔ 零差异 liveBlock      ✔ 零差异 finalizeLive   ✔ 零差异 liveReset
✔ 零差异 appendFinal    ✔ 零差异 setMdTail      ✔ 零差异 streamTick     ✔ 零差异 scheduleStream
✔ 零差异 appendDelta    ✔ 零差异 appendThink    ✔ 零差异 applyLiveSync
✔ 零差异 状态行（liveMsg/liveDiv/pdet/liveParts/liveRTimer）
✔ liveMsg 声明唯一（1）
全部零差异 ✅
```

**差异逐条（只有这些，且都不是被搬函数的正文）**：
1. 每个函数前的模块级头注释（新写，说明 deps 与三条红线）；`applyLiveSync` 上新增一行 docstring（原 1204–1205 那段「render/liveSync 同拍」注释仍留在 main.ts 的 `renderPending` 上，属 5f 域，未动）。
2. 搬入函数体内缩进未变（都是闭包内 2 空格），故正文逐字零差异；`import type { SessionMessage }` 是模块新增依赖声明。
3. `handleMsg` 3 处 + `dispose` 1 处的**调用点**替换（不是被搬函数的正文），共 4 行：
   - `if (liveDiv && ...) liveDiv.parentNode.removeChild(liveDiv);` → `dropEmptyLive();`
   - `liveMsg.content[m.ci] = tp;` → `bindToolPart(m.ci, tp);`
   - `var tb = liveMsg && liveMsg.content[m.ci];` → `var tb = liveToolPart(m.ci);`
   - `if (pdet) pdet.textContent = L.genArgs.replace('{n}', tb._len);` → `setPDet(L.genArgs.replace('{n}', tb._len));`
   - `dispose`：`if (liveRTimer) {…}` → `clearStreamTimer();`
   `handleMsg` 的**控制流、分支顺序、其余正文一字未动**（delta/thinking/toolStart/toolCallStart/toolEnd 语句形状与顺序原样）。

流式语义零改：`appendDelta` 节流口径、`appendThink` 贴底判定（追加前算）、`finalizeLive` 收尾时机、`streamTick` 围栏行首 + 表格整组退回尾巴 —— 全部逐字搬走（第五节证据）。

## 六、验收

1. **`npm run compile` 三段全绿**：`vendor-pi.mjs` → `typecheck:webview`（tsc 零报错）→ `build:webview`（vite 17 modules + sessions 4 modules）→ `tsc -p ./`。搬家后最终态复跑一次仍绿。
2. **15 组回归同数（改动前基线 / 改动后一致）**：

| 用例 | 结果 |
|---|---|
| `test:linkify` | **22** 项全过 |
| `test:html` | 通过（见下方字节数说明） |
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
| `test:migration` | 全过 |

`test:html` 断言（资源路径）不变，输出字节数 150828 → 151576（+748B）：main.js 多了一个模块中转层，函数从闭包内局部名变成返回对象属性，minifier 不能再跨模块用短名/内联 —— 体积代价换分层，属预期。用例数与断言逻辑未动。
3. **逐字核对零差异**：见第五节。
4. **行数账**：见第一节。
5. `test:linkify` 抓取的仍是 `features/markdown.ts` / `features/linkify.ts`，本单没碰它依赖的 markdown 契约（5a 立的接口原样）。

## 七、存量死代码（显著标注）

**`scheduleStream` = 存量死代码，本单未删除，原样搬进 `liveStream.ts`**（SCOUT-t34-cuts 六.5：全文件只有定义，唯一提及是第 70 行注释；`appendDelta` 直接调 `streamTick`，没人调它）。按 AGENTS.md「存量死代码不动」处理：留在 main.ts 会切碎区间，故随本区间整体搬走，源码里已加注释指明它是死代码、要清走单独立票。`liveRTimer` 因此仍是「只被 `scheduleStream` 赋值、被 `clearStreamTimer` 清理」的原状。

## 八、真机清单（**待用户**）

装机后逐项看（流式域最怕「看起来一样但抖」）：
- [ ] 流式正文不闪（不整气泡重绘）
- [ ] `**bold` 半截不抖（尾巴区走 textContent）
- [ ] 表格不劈叉（边流边出表，分隔行到货后不出现 `--- --- ---`）
- [ ] 代码围栏正确（行首 ``` 起止，块内不误判）
- [ ] 思考块结束自动折叠，手动展开仍可看全文且限高滚动照旧
- [ ] 切页签回来流式续上（`applyLiveSync` 重定基正常，不丢在途段）
- [ ] 工具占位行「生成参数 (N 字符)」计数随 `toolCallDelta` 走动（`setPDet` 口）
- [ ] 纯工具回合结束后空壳 assistant 气泡仍被清掉（`dropEmptyLive` 口）
- [ ] 工具开跑瞬间不出现空圆角色条（2026-09-20 事故形态）

## 九、给下一位的环境提示（非本单改动）

- 本仓 `core.autocrlf=true`：`git checkout -- <文件>` 会把**工作区**文件写成 CRLF（git blob 仍是 LF）。本次中途为了修正一次误删用过 `git checkout --`，随后已把工作区 `main.ts` 转回 LF —— 若你看到 `warning: LF will be replaced by CRLF` 或 `git status` 里莫名 ` M`，先 `git update-index --refresh -- <文件>` 再看，别直接提交（会把整文件行尾刷成 CRLF 造成假 diff）。
- 逐字核对脚本可按需重跑：`node scripts/.preview/t39-verbatim.mjs 35ba761~1`。
