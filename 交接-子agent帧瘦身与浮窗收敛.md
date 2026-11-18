# 交接：子 agent 进度帧瘦身 + 浮窗收敛（2026-11-19）

> 自包含。接手只需读本篇 + `AGENTS.md`。8 个提交全部**本地 commit、未 push**（`main` 领先 `origin/main` 8 个）。

---

## 一、为什么要动这块

世界项目一个会话文件 **299 MB / 13186 行**，其中 **266.7 MB（93.2%）** 是 `custom:subagent-async` 帧。
逐行实测结论（别再用「大概」口径）：

| 条目 | 条数 | 体积 | 单条 |
|---|---|---|---|
| `custom:subagent-async`（进度帧） | 1,257 | **266.7 MB** | 中位 223 KB，峰值 **2.0 MB** |
| `type:message`（真对话） | 583 | 16.2 MB | — |
| `custom:subagent-async-stream`（逐字） | 11,320 | 3.0 MB | **0.27 KB** |

根因两条，缺一不可：

1. **每帧重发「尾窗 20 条消息」全文**（含 base64 截图，单张 380–600 KB）→ 同一批内容重复写 **19.1 倍**（去重后唯一内容只有 14 MB；761 个 image part 去重后只有 **42 张 / 8.7 MB**）。
2. **jsonl 只追加、pi 压缩不管 custom 帧** → 永不回收；打开会话要全文读 + 逐行 parse（实测重放 5.3 s）。

通道本身换不了：异步派单后工具的 `onUpdate`（内存事件，官方示例走的就是它）已失效，`appendEntry` 是唯一能递到面板的 API —— 而它定义就是「写盘」。**结论：通道不动，改 payload 形状。**

---

## 二、这一版改成了什么（v22 → v26）

harness 版本门 `harness/subagent/harness.json` 现为 **26**（不 bump 不覆盖已装副本）。

| 版本 | 改动 |
|---|---|
| v22 | 帧 messages 由「尾窗 20 条」改「只带新增」；宿主 `piCore` 的 `mergeSubagentFrame` 拼回累计（后已删） |
| v23 | **帧再砍 `messages`/`usage`**：只剩 handle/agent/status/task/时间/`msgCount`/`frameKind`。转录页改「按字节偏移增量读子会话 jsonl」（新 `src/domain/jsonlTail.ts`） |
| v24 | 句柄换 uuid 派生 `sa-<8 hex>`（老 `sa-12` 全链路继续有效，8 处正则 `/^sa-(?:\d+|[0-9a-f]{8})$/`）；父派单可选 `name`（职务·姓名） |
| v25 | **kill 必须发终态帧**（原来只改内存+台账 → 浮窗永远「处理中」、秒表一直走、主会话 Working 被钉） |
| v26 | **`proc.close` 无条件补终态帧**（跑完/崩了/被 kill/settled 先到都覆盖，幂等 ~200 B） |

体积账：**266.7 MB → 约 0.5 MB**（同一会话按真实数据重算；单帧 423 B）。

### 浮窗收敛（用户拍板）

- 只留 **名称 + 状态 + 父任务 + 时间**；删掉 ctx/花费、活动明细行、`⋯` 下钻按钮 + 整个下钻浮层（协议 `WvSubagentDetailRequestMsg` / `SubagentDetailMsg` 一并退役）
- **只有一张表**：删掉「历史（台账）」分组与 `renderLedgerRow`，台账行按状态并入「已开启 / 完成」，**不再显示 `sa-xxxx`**
- 跨页签 `liveSeen` 去重（原来只比当前页签 → 同一单在 A 页签活行、B 页签台账行各显一次）
- 失败行第二行显示失败原因（snapshot 新增 `error` 字段）

### 输入区命脉加固

`webview/index.html` 的 `#input` 是 `disabled`，摘 `disabled` 的那行在 `bindViewEvents` **末尾** —— 该函数前面任何一行抛错（用量弹层那 100 行接线），输入框就永久 disabled：**点发送没反应、消息死在 webview、日志零留痕**（0.1.20 bindViewEvents 漏调同族）。
现在 `bindComposerOnce()`（幂等）在 `bindViewEvents` 最前面调用，调用点包 `try/catch/finally`，错误经 `wvError` 桥落盘。

---

## 三、踩过的坑（照着别再踩）

1. **`fs.watch` 在这台机器上直接崩**：`Assertion failed: !_wcsnicmp(filename, dir, dirlen), fs-event.c:72` —— 目录监听、文件监听都复现（Windows + Node 24）。**别再用读者监听写者文件**：状态事件必须由写者（harness）发。
2. **不要用定时器兜底状态**（我加过 `setInterval(1s)` 台账对账，被用户当场否掉）。轮询是白干活；覆盖不到的窗口应该由写者补帧（v26 就是这么补的）。
3. **派子 agent 一律 `async: true`**。`async` 只能用于单派，**chain 天然同步**——我拿 chain 表达"两刀串行"，把主会话按在 `Working… 6m50s`。要串行就「单发 async，跑完回传再派下一刀」。
4. **`subagent-async-stream` 不是元凶**：11320 条才 3 MB，别对着它优化。
5. `piCore.fillFrameTask`：帧只在首帧/终态帧带 `task`，中间帧靠宿主缓存回填，否则浮窗任务行变空。
6. `frameKind` 字段（`first`/`delta`/`final`）：老帧没这个字段 → 按「整份快照替换」处理，重放老会话不重复累积。

---

## 四、验证状态（诚实账）

**验过的**

| 项 | 结果 |
|---|---|
| `npm run compile` | 0 错误（每次都跑） |
| harness 单独 `tsc` | 6 个 = 改动前基线，本次零新增 |
| `test:subagent` | 50 项过 |
| `test:jsonltail`（新） | 7/7（完整行/半行/坏行/system/无内容） |
| `subagentReplay` | 15 项过 |
| `subagentLedger` | 4/4 |
| `subagentSync` | 3/3 |
| 帧形状/句柄/合并探针 | 通过（含 v21 老帧兼容） |
| webview 沙箱（`dist/webview/main.js` + DOM shim） | 载入无异常；tabs/uiState/subagentLedger（failed+running 两行）/render 无抛错 |

**没验的（接手第一件事）**

1. **真机派一单**：浮窗出不出、秒表/状态到不到位、kill 后是否立刻落终态（v25/v26）
2. 「点发送没反应」的**根因没定死**（只是加固了失败模式；需要时开 DevTools 看有没有 `wvError`）
3. 浮窗合并成一张表后的观感（`4769d0c` 未装机）
4. 老会话（299 MB / 713 MB）体积不变 —— 需要瘦身用 `scripts/migrate/slim-subagent-frames.mjs`（干跑默认；`--apply` 才写，会留 `.bak`）

---

## 五、目录结构重构进度

`webview/main.ts` 曾 3269 行 / 单 IIFE / 148 个函数。按功能切，一刀一提交、一刀一编译：

| 刀 | 产出 | 状态 |
|---|---|---|
| 1 | `webview/core/state.ts` + `webview/features/changesPage.ts` | ✅ `b8d0eca`（main.ts 3269 → 3125） |
| 2 | `webview/features/ctxPopover.ts` | ✅ `75d5c3c` |
| 3 | 子 agent 浮窗（`subagentDock.ts`） | 未做 |
| 4 | 输入区（`composer.ts`） | 未做（注意 `bindComposerOnce` 是命脉） |
| 5 | 消息渲染（`renderAll`/`streamText`/markdown/工具行） | 未做 |
| 6 | 页签/视图工厂 + 事件路由 | 未做 |

派单要点（已验有效）：**单发 async**、照上一刀的模式（`init(deps)` + 返回入口）、`bindComposerOnce` 一个字不许动、**搬动逐字核对**（跟 HEAD 比，归一化前缀后只允许必要转调）。

---

## 六、遗留问题（按优先级）

1. **状态真值的收敛**：现在主路是「harness 发帧」，浮窗还有第二源（台账行）。已做单表合并 + 跨页签去重，但两套数据仍各自到达；彻底收敛需要「帧是唯一事件源，台账只做重放/历史」。
2. **`frames.jsonl` 双写**：`emitAsyncProgress` 里除 `appendEntry` 还 `fs.appendFileSync(runDir/frames.jsonl)`，理由（「SDK 宿主 custom 帧不落盘」）已被 299 MB 实测推翻。重放路径 `piCore.replayFramesFromDisk` 仍读它（只读最后一行）。要删得连重放一起改。
3. **失联判定仍是 `lastFrameAt` > 30 分钟**（webview `SUB_STALE_MS`）。按用户分析应改「pid 存活」，台账里 `pid`/`ownerPid` 现成（`reconcileRuns` 就是按 pid 判死活）。没做。
4. **`frames.jsonl` / 老会话体积**：见四.4。
5. **`L.smLedgerGroup` / `smDetail` / `smBack` 等 i18n key 已无引用**（死键，无害，要清一起清）。

---

## 七、关键文件

```
harness/subagent/index.ts     帧生成（asyncDetails / emitAsyncProgress）、kill、句柄、名字
harness/subagent/harness.json version 门（现 26）
src/domain/jsonlTail.ts       子会话 jsonl 增量读（半行/坏行/无内容 有 7 项用例）
src/core/piCore.ts            entry_appended 消费、fillFrameTask、重放、浮窗快照投递
src/domain/subagentSnapshot.ts details → 展示快照（零 import，webview 共享）
src/vscode/transcriptTab.ts   转录页（历史读文件 + 增量 reloadTranscript）
webview/main.ts               面板主体（正在按功能拆分，见五）
webview/features/*.ts         已拆出的功能块
scripts/test/jsonlTail.test.mjs  增量读用例（npm run test:jsonltail）
```
