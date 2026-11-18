# REPORT-t35：子 agent 状态真值收敛（frames.jsonl 双写移除 + 失联判定改 pid）

工单：`dispatch-t35.md`（对应 `交接-子agent帧瘦身与浮窗收敛.md` 第六节遗留 **2、3**）
日期：2026-11-18

## 一、结论先行

| 项 | 结果 |
|---|---|
| ① `frames.jsonl` 双写 | **已删**（`emitAsyncProgress` 只剩 `appendEntry`），重放收敛到「只读父会话 `custom:subagent-async` 帧」，`replayFramesFromDisk` / `readLastJsonLine` 整段回收 |
| ② 失联判定改 pid | **已接**：宿主读台账做 `process.kill(pid,0)` 探活 → `SubagentLedgerRow.procAlive`；面板侧 `procAlive===false` → **立即**按失败落终态；`SUB_STALE_MS(30min)` 降为最后兜底 |
| ③ 补测试 | 新增 `scripts/test/subagentLiveness.test.mjs`（10 断言）；`subagentReplay.test.mjs` 删掉 frames.jsonl 夹具 + 新增 ⑧「frames.jsonl 不存在时重放仍工作」 |
| `npm run compile` | 全绿（webview tsc → vite → tsc 均无报错） |
| 四个基线套件 | subagent 50 / replay 15→19 / jsonltail 7 / ctx 13（**零回归**，replay +4 是新增用例） |
| harness 单独 tsc | 6 个错误 = 改动前基线，**零新增** |
| 写侧为零 | `grep -rn "frames.jsonl" harness/ src/ scripts/ \| grep -Ei "appendFileSync\|writeFileSync\|createWriteStream\|openSync\(.*w"` → **无输出**（退出码 1） |

## 二、改了什么、为什么

### 1. 删 `frames.jsonl` 双写（`harness/subagent/index.ts`，harness.json 26 → 27）

原 `emitAsyncProgress` 里除 `pi.appendEntry("subagent-async", …)` 还
`fs.appendFileSync(runDir/frames.jsonl, …)`，注释自称「冗余备份，待验证后删」。前提已被
2026-11-17 实测推翻（299MB 父会话里 266.7MB 全是 custom 帧 → pi 确实落盘）。两份真值 =
每单多几十 MB 磁盘 + 两条消费路径各自漂移。本次删掉写侧，原注释改成**禁止回填**的反向记录
（带事故依据），`harness.json` bump 27（不 bump 不覆盖已装副本，版本门只升不降）。

### 2. 重放路径收敛（`src/core/piCore.ts`）

- **删** `replayFramesFromDisk`（按 handle 读 `<sessionDir>/frames.jsonl` 最后一行）+ 两处调用点
  （会话可读后的收口、会话不可读的 ledgers 分支）以及它的专用读函数 `readLastJsonLine`。
  现在帧真值只有一条：`replaySubagentHistoryInner` 扫父会话 `entry_appended` 的
  `custom:subagent-async` 帧（该分支本来就在，`frameKind` 缺省 = 整份快照替换的既有规则没动）。
- **会话文件读不到（幽灵路径 / 0 字节）时不再造快照**：只推台账行（agent/任务/状态/时间全在
  台账磁盘真值里），文件真落盘后下一次 `refreshState` 自然补上帧快照。这是**刻意的行为收窄**，
  已写进注释与用例 ⑦（`ledgerHit` 由 `Map<handle, sessionDir>` 简化为 `Set<handle>`，sessionDir
  只剩台账行展示用）。
- 会话列表扫描里 `f !== "frames.jsonl"` 的过滤**保留**（老安装的历史文件还在磁盘上，别把它们
  当会话文件打开）——这是读侧防御，不是第二真值。

### 3. 失联判定改 pid（真值链：harness 台账 → 宿主探活 → 面板展示）

- `src/core/subagentLedger.ts`：加 `pidAlive()`（与 `harness/subagent/runsLedger.ts` 的
  `pidAlive` 同口径：`process.kill(pid,0)`，`EPERM` = 活）。**只对 `status==="running"` 且台账有
  `pid` 的行**产出 `procAlive`——非 running 的 pid 可能已被系统回收复用，探活没有语义；
  老台账没 pid 时**不给结论**（不许把「不知道」当「死了」）。
- `src/core/protocol.ts`：`SubagentLedgerRow` **只增** `procAlive?: boolean`，既有消息形状零改动。
- `src/domain/subagentSnapshot.ts`：加纯函数 `livenessStatus(status, procAlive)`——
  `("running", false) → "failed"`，其余原样。零 import，宿主与 webview 共用同一口径。
- `src/core/piCore.ts`：`pushLedger` 后有 running 行就挂 **5s 台账心跳**（`syncLedgerPulse`），
  全部落终态自动停表，`dispose()` 里 clear。**为什么必须有**：`procAlive` 是探活快照，
  而 `pushLedger` 只在有帧/有事件时被调——子进程死掉后不会再有帧来触发重推，
  只靠事件驱动的话「pid 死 → 立即终态」只在面板重载那一刻成立（真机事故就是 13h20m 不动）。
- `webview/features/subagentDock.ts`（**只动失联判定相关行**）：
  - 新增 `procDead(handle)`（查台账行的 `procAlive`）+ `runGone(rec, handle)`；
  - `anySubLive` / `renderSubChip` 从 `runStale` 换成 `runGone`（死的行不算「还在跑」）；
  - `renderSubOverview`：进程已死的 running 任务**不再进「已开启」组**；台账行的展示状态
    经 `livenessStatus`（死的 running 行直接进完成/失败组）；
  - `renderSubRow`：两档降级——① `procAlive===false` → `effStatus='failed'`（✗ 图标 / 失败徽标 /
    停表 / 悬停 ✕）；② 只是长时间无帧 → 原「疑似失联」黄标（`SUB_STALE_MS` 兜底原样保留）；
  - `main.ts` **一个字没碰**。

### 4. 测试

- 新增 `scripts/test/subagentLiveness.test.mjs`（node 裸跑，读 `out/` 产物）：
  宿主探活四分支（死 pid → false / 活 pid → true / 无 pid → 不给结论 / 非 running 行不带）+
  展示降级六断言（死 → failed、其余维持、脏载荷不误判）。
- `scripts/test/subagentReplay.test.mjs`：删掉 sa-7 / sa-77 的 `frames.jsonl` 夹具（现在它们本来
  就不该存在）；⑦ 从「从 frames 重放」改成「无父会话 → 不投快照 + 台账行照样推出」；
  ⑥ 的「3 条 update」改回 2 条（sa-7 只剩 entry 一路）；新增 ⑧：台账 sessionDir 是空目录、
  帧只在父会话 `custom:subagent-async` 里 → 快照照样重放且字段正确（`frames.jsonl 不存在时
  重放仍工作` 的主回归口径）。

## 三、验证输出（原文）

```
$ npm run compile
（webview tsc / vite / tsc -p ./ 全绿，无 error 输出）

$ npm run test:subagent
subagentSnapshot: 50 项全过

$ npm run test:replay
subagentReplay 用例：19 项全过 ✅        ← 基线 15，+4 = ⑦+1、⑧+4−1 收敛

$ npm run test:jsonltail
test-jsonltail: 7/7 通过

$ npm run test:ctx
ctxBreakdown: 13 passed

$ node scripts/test/subagentLiveness.test.mjs        ← 新增
subagentLiveness: 10/10 通过 ✅

$ node scripts/test/subagentLedger.test.mjs          ← 既有探针不回退
test-subagent-ledger: 4/4 通过

$ node scripts/test/subagentSync.test.mjs            ← harness 安装/版本门（v27 能同步）
test-subagent-sync: 3/3 通过

$ npx tsc --noEmit --target ES2022 --module commonjs --moduleResolution node --strict \
    --skipLibCheck --types node --allowImportingTsExtensions harness/subagent/index.ts | grep -c "error TS"
6        ← 改动前基线也是 6（1222/1588 AgentScope、1911/1953/1985/2013 工具签名），零新增
```

### pid 判定探针（真死 pid vs 活 pid，走完整 `PiCore` 重放链）

```
子进程 pid（已退出）: 18456  本进程 pid（活着）: 4172
重放投出的消息类型: subagentLedger
台账行探活结果:
  sa-dead  status=running procAlive=false
  sa-live  status=running procAlive=true
```

（夹具：台账两条 running 行，`parentSession` 指向一个**不存在**的会话文件——即「幽灵会话 +
没有 frames.jsonl」的最坏情况；面板收到 `procAlive:false` → `livenessStatus('running', false)`
= `'failed'` → 立即落失败终态，不再等 30 分钟。）

### 写侧为零证据

```
$ grep -rn "frames.jsonl" harness/ src/ scripts/ | grep -Ei "appendFileSync|writeFileSync|createWriteStream|openSync\(.*w"
（无输出，退出码 1）

$ grep -rn "frames.jsonl" harness/ src/ scripts/
harness/subagent/index.ts:677    注释（历史体积记录 + 「该文件 v27 已删」）
harness/subagent/index.ts:1106   注释（v27 删除说明，禁止回填）
src/core/piCore.ts:851-852       注释（v27 删除说明）
src/core/piCore.ts:1196/1257     读侧过滤（列表扫会话文件时排除老安装残留的 frames.jsonl）
src/vscode/sessionCache.ts:232   同上（读侧过滤，未改）
scripts/migrate/slim-subagent-frames.mjs:103   迁移脚本（未改）
scripts/probe/probe-transcript-render.mjs:49   探针（未改）
scripts/test/subagentReplay.test.mjs:…         用例（断言对象正是「没有 frames.jsonl」）
```

→ **写侧 0 处**，只剩注释、读侧防御、迁移/探针脚本与用例。

## 四、改动文件

```
harness/subagent/index.ts              删 appendFileSync 双写 + 两处注释改口径
harness/subagent/harness.json          version 26 → 27
src/core/piCore.ts                     删 replayFramesFromDisk/readLastJsonLine + 台账心跳
src/core/protocol.ts                   SubagentLedgerRow 增 procAlive（只增不改）
src/core/subagentLedger.ts             pidAlive + procAlive 探活
src/domain/subagentSnapshot.ts         livenessStatus 纯函数
webview/features/subagentDock.ts       失联判定两档（pid 立即终态 / 30min 兜底）
scripts/test/subagentReplay.test.mjs   删 frames 夹具 + ⑦ 改写 + ⑧ 新增
scripts/test/subagentLiveness.test.mjs 新增（10 断言）
reports/REPORT-t35.md                  本报告
```

**未碰**：`webview/main.ts`（第 4 刀要改）、`src/core/i18n.ts`、`src/vscode/sessionsView.ts`、
`webview/sessions.ts`（别人未提交/已提交的改动一律不碰）。

## 五、边界与风险（请总监裁决/知悉）

1. **行为收窄（刻意）**：会话文件读不到且会话永不落盘（`ghost-only-in-ledger` 那种真幽灵）时，
   浮窗不再有「快照行」（活动流/产出），只剩台账行（名称/状态/任务/时间）。
   台账行的信息量覆盖浮窗现在展示的全部字段（v23 帧只带最小集），可接受；要恢复只能另造帧源，
   与「帧是唯一事件源」相反，故不做。
2. **pid 复用**：探活只能证明「死」不能证明「活」——死进程的 pid 被系统复用时探活为 true，
   这一档自动退回 30 分钟兜底（不会误杀，只会晚一点降级）。
3. **心跳代价**：有 running 行时每 5s 读一次 `runs/` 目录 + 每行一次 `kill(pid,0)`（unref，
   面板 dispose 即清）。无 running 行不空转。
4. **未做（按单子明确不做）**：遗留 1「帧是唯一事件源、台账只做重放/历史」的完整收敛；
   老会话里已有 `frames.jsonl` 的清理（另一单评估）；未装 vsix 实测（本单禁止装包），
   webview 侧只做了 `tsc -p webview --noEmit` + vite 构建验证。
5. **建议沉淀到 AGENTS.md（本单未改该文件）**：「`frames.jsonl` 双写永久删除，帧真值只有父会话
   `custom:subagent-async`；台账 `procAlive` 是展示级探活信号，不写回台账（双写者红线）」。
