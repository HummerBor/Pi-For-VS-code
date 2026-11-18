# SCOUT-t34-slim · 老会话帧瘦身脚本上真数据评估（只读侦察 + 临时副本 apply）

> 基线：HEAD = `b706911`。本单只新增本文件，**未改任何项目代码、未删除任何文件、未 commit**。
> 真会话目录（`~/.pi/agent/sessions/`）全程**零写入**：源文件侦察前后 sha256 一致（§1 有前后对照）。
> 所有 `--apply` 只打在 `%TEMP%/slim-probe/` 的副本上。

---

## 〇、结论先行

1. **现在这份脚本绝不能对真会话跑 `--apply`——它会静默删掉会话历史的主体。**
   脚本只删行、**不重接 `parentId`**；而本样本的 13186 行是**一条完整单链**（`parentId` 逐行串联，帧与 delta 流都在链上），
   一删行就成了断链。用 pi 自带的 `SessionManager` 真加载实测：
   **566 条上下文消息 → 21 条**，`thinkingLevel: high → off`，619 条留存里只有 24 条从 leaf 可达（595 条成孤儿）。
   这不是「显示问题」：`buildSessionPath` 从 leaf 沿 `parentId` 上溯，遇缺失即 `undefined` 停走，
   连再续聊的 LLM 上下文也一起塌掉。
2. **瘦身收益本身是真的**：299.92MB → 20.69MB（**-93.1%**），干跑预测值与实际落盘值逐字节吻合
   （预测 20.69MB / 实际 `20690145` 字节）；全库（`~/.pi/agent/sessions` 下 >50MB 的文件）可省 **2830.6MB**。
3. **修一处就能放开**：把被删节点的 `parentId` 沿原件链上溯「压缩」到最近存活祖先即可。我在临时目录做了原型
   （只改写 92 行的 `parentId`，其余字节不动）→ **复原 566 条消息 + `thinkingLevel: high`，618/619 条从 leaf 可达**（剩下 1 条是无 id 的 `session` 头行）。
4. **另有 4 条独立风险**（都与「历史塌掉」无关，但都会咬人）：
   ① 二次 `--apply` 会把唯一的 `.bak` 覆盖成瘦身后的文件（实测，全量原件从此无备份）；
   ② 中途被 kill 留**半截文件**（实测 1,176,117 字节 / 93 行，JSON 全部合法、pi 会照常加载 = 静默丢历史）；
   ③ 某 handle 的最后一帧若 `status: running`，面板那一行会消失（本样本 sa-93 中招）；
   ④ `frames.jsonl` 分支「只留最后一行」没有 running 守卫（本机 12 个胖 frames.jsonl 末行恰好全是 `completed`，是运气）。
   ⑤ 老帧缺 `frameKind` **不是问题**：壳侧根本不消费该字段（piCore 只读 `status`/`detail`），`frameKind` 仅 harness v20+ 写 frames.jsonl 时产出。

一句话给总监：**脚本的「删什么」是对的，「怎么删」少了父子链重接这一刀；体积账已验真，先修 4 处（§7）再上真机。**

---

## 一、样本、副本与「真目录零写入」证据

样本（只读源）：

```
C:\Users\Administrator\.pi\agent\sessions\--d--work-world--\2026-11-17T02-11-31-246Z_01a1e746-112e-737b-8c3b-8e6b83c06054.jsonl
```

| 项 | 侦察前 | 侦察后 | 结论 |
|---|---|---|---|
| size | 299,924,214 | 299,924,214 | 未变 |
| mtime | `2026-11-18T03:34:58.631Z` | `2026-11-18T03:34:58.631Z` | 未变 |
| sha256 | `7506d22e3bb3a3f8ffb7f153f0f705fe401adb12786745f05ebb2cb24431ba3c` | 同左 | 逐字节未动 |
| nlink | 1 | 1 | 副本不是硬链接（不会误伤源） |

副本（全部在 `%TEMP%/slim-probe/`，`C:\Users\ADMINI~1\AppData\Local\Temp\slim-probe`）：

| 文件 | 大小 | 用途 |
|---|---|---|
| `<样本名>.jsonl` | 299,924,214 | pristine 基线（before 用），sha 与源一致 |
| `<样本名>.apply.jsonl` + `.bak` | 20,690,145 / 299,924,214 | `--apply` 落点（`.bak` sha = 源 sha 完整无误） |
| `<样本名>.apply.relinked.jsonl` | 20,690,145 | 我的**修复原型**（重接 `parentId`，非项目代码） |
| `<样本名>.killtest.jsonl` + `.bak` | 1,176,117 / 299,924,214 | 中途 kill 测试的残骸（证据） |
| `<样本名>.appendtest.jsonl` | 20,690,317 | appendEntry 续接测试副本 |
| `analyze.mjs` / `load-probe.mjs` / `diag-chain.mjs` / `tail-status2.mjs` / `tail-shape.mjs` / `append-probe.mjs` / `dangling-refs.mjs` / `dangling-by-type.mjs` | 小 | 只读探针脚本（在临时目录，不在项目里） |

复制命令与校验（cp 用 `cp`，校验用 node 算 sha256）：

```
time cp "$SRC" "$D/<样本名>.jsonl"     # real 0m0.338s，sha256 与源一致
# 独立副本证据（不是硬链接/CoW 共享 inode）：
{"p":"…--d--work-world--/…jsonl","ino":19140298416366710,"nlink":1,"size":299924214}
{"p":"…Temp/slim-probe/…jsonl","ino":56576470319158200,"nlink":1,"size":299924214}
```

---

## 二、干跑语义（逐条对着代码核 + 实测）

脚本三段式：**A 趟算账**（顺带记每个 handle 最后一帧的行偏移）→ **B 趟算「保留帧字节数」**（只为预测体积）→ `--apply` 时**C 趟**（读 `.bak`、写新文件）。

| 问题 | 事实（代码位置 + 实测） |
|---|---|
| 默认是否写盘 | **不写**。只有 `args.includes("--apply")` 才进写分支。实测干跑后目录里没有 `.bak`、副本 size/mtime 不变。 |
| `.bak` 何时产生 | `fs.renameSync(file, file+".bak")` —— **在写新文件之前**先改名（`slim-subagent-frames.mjs` 的 apply 分支）。所以 `.bak` 一出现，原件就已经被「挪走」而不是「复制」。 |
| 是否原地重写 | **不是原地**：先 rename 成 `.bak`，再用 `createWriteStream(file)` 新建同名文件。**但不是 temp+rename 原子替换**——新文件是「边写边暴露」的。 |
| 中途失败是否留半截 | **会**。实测（§6-R3）：`.bak` 刚出现就 `kill -9`，主文件停在 **1,176,117 字节 / 93 行**，且这 93 行 JSON 全部合法、末尾带换行——pi 加载它不会报错，只会「历史变短」。回滚手段是 `mv .bak` 回去（`.bak` 完整，实测 sha 与原件一致）。 |
| 二次 `--apply` | **幂等但不安全**：第二次跑 `20.7MB → 20.69MB（省 0%）`，**同时把 `.bak` 覆盖成瘦身后的内容**（实测 `.bak` sha 从 `7506d22e…` 变成 `4d95be1e…`）→ 唯一全量备份就此消失。 |
| 扫描范围 | 无显式参数时递归扫 `~/.pi/agent/sessions`，取 `>--min-mb`（默认 20MB）的 `*.jsonl`（含 `frames.jsonl`）。`.bak` 以 `.jsonl.bak` 结尾，不会被二次扫到。 |
| 显式传文件 | `node scripts/migrate/slim-subagent-frames.mjs <file> [more…]`，路径 `path.resolve`，与扫描逻辑二选一。 |
| 计数是否可信 | 干跑预测 `20.69MB` / `行 619`，实际落盘 `20,690,145` 字节 / 619 行，**完全吻合**。 |

---

## 三、逐类体积账（before，独立探针复核，非脚本自报）

文件：`299,924,214 字节 / 13186 行 / 最长行 3275KB / 末尾换行=true`

| 类别 | 行数 | 体积 | 占比 |
|---|---:|---:|---:|
| `custom:subagent-async`（有 handle，帧） | 1257 | **279.70MB** | **93.26%** |
| `message:toolResult` | 249 | 8.91MB | 2.97% |
| `message:user` | 45 | 7.29MB | 2.43% |
| `custom:subagent-async-stream`（delta 流） | 11320 | 3.19MB | 1.06% |
| `message:assistant` | 287 | 0.79MB | 0.26% |
| `message:system` | 2 | 0.02MB | 0.01% |
| `type:context_edit` | 17 | ~0 | 0.00% |
| `type:model_change` | 6 | ~0 | 0.00% |
| `type:session_info` / `type:session` / `type:thinking_level_change` | 1 / 1 / 1 | ~0 | 0.00% |

帧按 handle 的分布（10 个 handle，1257 帧 / 279.70MB）：

| handle | 帧数 | 帧总计 | 最大单帧 |
|---|---:|---:|---:|
| sa-92 | 118 | 73.13MB | 1676KB |
| sa-97 | 169 | 73.02MB | 1942KB |
| sa-99 | 116 | 47.47MB | 2010KB |
| sa-93 | 185 | 24.73MB | 327KB |
| sa-95 | 95 | 19.57MB | 519KB |
| sa-96 | 177 | 13.43MB | 232KB |
| sa-100 | 95 | 10.48MB | 196KB |
| sa-94 | 88 | 6.15MB | 109KB |
| sa-108 | 130 | 5.97MB | 104KB |
| sa-98 | 84 | 5.77MB | 128KB |

**体积从哪来**（解剖 sa-92 末帧 1,203,779 字节）：`detail.results[0].messages` 共 20 条，其中三条 `read` 工具结果的 `content[]` 里带 `{type:"image"}` 块（截图 base64 在 image 块的 `source.data` 里，不是 data URL 字符串，所以按 `data:image/...` 正则搜不到）——
单条消息 514,535 / 508,259 / 131,152 字节，三条就占 1.15MB；delta 流帧相反，中位仅 233 字节（`data{handle,kind,text}`）。

---

## 四、瘦身后体积

| | before | after | 省 |
|---|---:|---:|---:|
| 本样本 | 299.92MB | **20.69MB**（`20,690,145` 字节） | 279.2MB / **93.1%** |

after 的构成（实测）：`toolResult` 8.91MB(43.1%) + `user` 7.29MB(35.3%) + **保留帧 10 行 3.66MB(17.7%)** + `assistant` 0.79MB(3.8%) + 元数据 ~0.02MB。
注意：**脚本不动帧载荷本身**，每 handle 留的那一帧仍是老格式（带 20 条消息 + 截图），sa-92 那帧就 1.20MB——想再往下压得改帧内容（v20+ 起 harness 已不带 messages），不属本脚本范围。

全库盘点（干跑，`--min-mb 50`，**只读**）：21 个文件，before 合计 **2913.3MB** → after 合计 **82.75MB**，**净省 2830.6MB**；
若全量 `--apply`，`.bak` 需要**额外 2.91GB** 磁盘（当前 `%TEMP%` 所在盘余量 28G，够但要预留）。
其中有 12 个是 `subagents/<handle>/frames.jsonl`（sa-91 一单就 206.0MB → 0.05MB）。

---

## 五、抽样 3 条 before/after 形状（只贴结构，不贴 base64）

### 样本 A：sa-92 首帧 —— **整条被删**

```json
// before（2,718 字节）
{"type":"custom","customType":"subagent-async","id":"fed63858","parentId":"2cc38ad0",
 "timestamp":"2026-11-17T07:56:07.514Z",
 "data":{"handle":"sa-92","status":"running","startedAt":1794902166448,
   "detail":{"mode":"single","agentScope":"…","projectAgentsDir":null,
     "results":[{"agent":"…","handle":"sa-92","task":"…(1204 chars)","exitCode":null,
       "stderr":"","usage":{…},"model":"…","running":true,"status":"running","messages":[]}]}}}
// after：不存在（该 handle 只留最后一帧）
```

### 样本 B：sa-92 末帧 —— **保留，且逐字节不变**

```json
// before（1,203,779 字节）  ==  after（1,203,779 字节，sha1 与原件一致）
{"type":"custom","customType":"subagent-async","id":"564870d2","parentId":"52f13a88",
 "timestamp":"2026-11-17T08:11:36.393Z",
 "data":{"handle":"sa-92","status":"completed","startedAt":1794902166448,"endedAt":1794903096391,
   "detail":{"mode":"single","agentScope":"…","projectAgentsDir":null,
     "results":[{"agent":"…","handle":"sa-92","task":"…","exitCode":0,"stderr":"","usage":{…},
       "model":"…","stopReason":"stop","running":false,"status":"completed",
       "messages":[ /* 20 条：10 assistant + 10 toolResult，含 3 张截图 image 块 ≈1.15MB */ ]}]}}}
```

> 实测复核：瘦身后 619 行**全部**能在原件里按 sha1 找到（619/619），0 行 JSON 损坏，末尾仍是 `0x0a`。也就是「留的字节没被重编码」。

### 样本 C：delta 流 —— **整条被删**

```json
// before（233 字节）
{"type":"custom","customType":"subagent-async-stream","id":"ca0f0a08","parentId":"698840b7",
 "timestamp":"…","data":{"handle":"sa-92","kind":"thinking","text":" me search for what's around those occurrences."(47 chars)}}
// after：不存在（11320 条流全删，瘦身后残留 stream 行 = 0）
```

---

## 六、风险清单（按实际后果排序，均带实测证据）

### R1【致命·已实测】删行不重接 `parentId` → 会话历史塌成尾部几条

* 事实：本样本 13186 行是**单链**（从 leaf 上溯 13185 步不断，帧/流都在链上）；瘦身后**存活行里 92 条的 `parentId` 悬空**
  （指向被删的帧 59 条 / 指向被删的 delta 流 33 条；按行类型 = `message:assistant` 53 + `message:toolResult` 23 + `message:user` 6 + 保留帧 10）
  —— 也就是说断链点打进了**真实对话消息**，不只是旁路帧。
* pi 侧语义（`chunk-44DLKSKE.js`）：`buildSessionPath` = `for(;current;) path.push(current), current = current.parentId ? index.get(current.parentId) : undefined`
  ——**缺一个祖先就停**，`buildSessionContext` 拿到的就是「断点 → leaf」这一段。
* 实测（同一个 299MB 文件，原件 vs 瘦身件各自用 `SessionManager.open` 真加载）：

| | 原件 | 瘦身后（脚本原样） | 瘦身后（我重接 parentId 的原型） |
|---|---:|---:|---:|
| 加载条目 | 13186 | 619 | 619 |
| **上下文消息** | **566**（system 2 / user 45 / assistant 270 / toolResult 249） | **21**（user 1 / assistant 11 / toolResult 9） | **566**（同上，逐项相同） |
| thinkingLevel | `high` | **`off`**（`thinking_level_change` 被切在链外） | `high` |
| 从 leaf 可达 | 13185 | **24**（孤儿 595） | 618（= 619 − 无 id 的 `session` 头行） |
| 加载耗时 | 3.2s | 0.6s | 0.6s |

* 断点位置：`custom:subagent-async`(ts `2026-11-18T03:32:20.704Z`) 的 `parentId=7991d2a0` 指向另一条被删的帧。
* 修复可行性（原型已验证）：对每条保留行，把指向已删 id 的 `parentId` 沿**原件链**上溯到最近存活祖先 —— 只改 **92 行 / 0 字节体积差**，
  上下文复原到 566 条、`thinkingLevel` 回 `high`。原型文件与脚本产物**同尺寸**（`20,690,145` 字节）。
* 另一类引用（本样本未中招，但换文件要查）：`context_edit.targetId` / `compaction.firstKeptEntryId` / `label.targetId` 指向已删 id —— 本样本 **0 / 0 / 0**。

### R2【高·已实测】二次 `--apply` 覆盖唯一 `.bak`，回滚能力消失

第二次跑输出 `20.7MB → 20.69MB（省 0%）`，看起来「幂等无害」，但 `.bak` 已被换成瘦身版：
`sha256 7506d22e…`（原件）→ `4d95be1e…`（瘦身件）。**全量原件从此只剩内存里的历史**。

### R3【高·已实测】中途失败留半截文件，且「半截也合法」

`rename` 先于写新文件，写用 `createWriteStream`（非 temp+rename）。轮询到 `.bak` 刚出现就 `kill -9`：

```
主文件 1,176,117 字节 / 93 行 / 不可解析行 0 / 末尾换行 true
.bak   299,924,214 字节 / sha16 7506d22e3bb3a3f8（完整）
```

pi 加载 93 行文件**不会报错**（`parseSessionEntries` 逐行 try/catch，坏行静默丢），用户只会看到「历史只剩最后几条」。
另有一个更阴的变体：若 kill 恰好落在 `createWriteStream` 刚建文件、还没写内容时，主文件 0 字节 → `_setSessionFile` 判定为「空文件 = 新会话」，
后续 append 直接覆盖写，界面表现是「会话没了」。**回滚只有一条路：`.bak` 挪回去。**

### R4【中·本样本中招】某 handle 最后一帧是 `running` → 面板那一行消失

本样本保留的 10 帧里 **sa-93 是 `status:"running"`（`endedAt` 缺）**。面板重放口径（`piCore.replaySubagentHistoryInner`）：
`if (!prev || frame.final) finals.set(h, frame)` → 老数据里 sa-93 有 185 帧，最后一帧虽 running，但 `finals` 里已存着更早的**终态帧**，所以以前能显示；
瘦身后 sa-93 只剩这一条 running 帧 → `snap.tasks.some(running)` 命中 → **整行被丢**。属于「删帧导致面板历史少一行」的真实回归，不是理论风险。

### R5【中·本次侥幸】`frames.jsonl` 分支「只留最后一行」没有 running 守卫

`replayFramesFromDisk` 只读最后一行、且丢弃 `running` 快照——若某单的 `frames.jsonl` 末行是 running（进程被杀、单没跑完），
瘦身后该 handle 的 detail **永久丢失**（前面的 final 帧已被删）。本机 12 个胖 `frames.jsonl` 末行实测**全是 `completed` + `endedAt`**，
所以这次安全；脚本侧应加守卫（末行非终态时回退保留最后一个终态行），否则迟早踩。

### R6【低·本次 0 命中】`line.includes("subagent-async-stream")` 是纯子串匹配

流分支用整行子串判删（不像帧分支有 `JSON.parse` + `type/customType` 双重校验）。**任何消息只要正文里出现 `subagent-async-stream` 字样就会被当流删掉**
（例如把脚本源码/日志贴进对话、或让 agent 读这个脚本）。本样本实测 **0 命**。

### R7【低·架构性】瘦身是必要的，因为「不瘦身连重放都做不到」

`piCore.replaySubagentHistoryInner` 是 `fs.promises.readFile(file)` + `.toString("utf8")` + `.split("\n")`（全文进内存）。实测 V8 上限：
`'x'.repeat(713e6)` → `RangeError: Invalid string length`；`300e6` → 通过。也就是说 **713.4MB 那份会话今天根本走不到重放逻辑**（异常被 catch 成一行 dbg）。
所以瘦身不只是省盘：它把「可重放」这件事救回来。反过来，这也说明**不要用 `--apply` 之外的更激进手段**去改这些文件。

### R8【观察·非缺陷】`appendEntry` 续接与行序：**不受删行影响**

* 事实：`SessionManager._persist` 是 `appendFileSync(this.sessionFile, ...)`（**按路径每次追加**，不持有长期 fd），
  `_appendEntry` 用内存里的 `leafId` 当新行 `parentId`。
* 实测（瘦身后副本）：`SessionManager.open` 得到 `leafId = f8478ca7`（= 原 leaf，被保留），`appendMessage` 新行
  `parentId = f8478ca7`、`+172 字节`、落在末行 —— **链是接上的，行序只追加不改**。
* 前置：**必须先关掉该会话所在窗口/面板再换文件**（脚本头注释也这么写）。否则 pi 内存里还握着全量 `fileEntries`：
  一旦走到 `_rewriteFile()`（fork / 版本迁移），会把**删掉的帧原样写回**（胖文件复活）；而纯 append 是安全的。
  附：`_loadEntries` 只有在 `migrateToCurrentVersion()` 返回 true 时才 `_rewriteFile()`；本样本 `version:3` 已是当前版，
  实测加载后 `fileMutatedByLoad: false`（文件未被改写）。
* `.bak` 不会被会话列表收进来（`sessionCache.ts:232` / `piCore` 都是 `endsWith(".jsonl")` 过滤），不会造成幽灵会话。

### R9【已排除】老帧缺 `frameKind` —— **无影响**

实测：`subagent-async` 帧 **1257/1257 缺 `frameKind`**（`data` 键是 `handle/status/startedAt/detail/endedAt`），
`subagent-async-stream` **11320/11320 缺**（`data` 为 `handle/kind/text`）。
但全仓 `frameKind` 只出现在 `harness/subagent/index.ts`（v20+ 写 `frames.jsonl` 时产出）；**壳侧（src/）零引用**，
piCore 的会话重放读 `data.status` / `data.detail`，`replayFramesFromDisk` 读顶层 `status`。所以留不留 `frameKind` 与重放无关。

### R10【已排除】编码/换行/重编码

留存的 619 行按 sha1 与原件**逐行等价**（619/619），含中文正文；末尾仍 `0x0a`；`badJsonLines: 0`。

---

## 七、能不能在真机跑 `--apply`：**现在不能**；前置条件如下

**结论：以当前代码，`--apply` 属破坏性操作（R1 直接打掉会话历史主体 + R2/R3 让回滚不可靠），禁止上真机。**

放开前的最小改动清单（本单只记录，**未实施**）：

1. **必须：删行时重接 `parentId`**。对每条保留行，若 `parentId` 指向被删 id，沿**原件**链上溯到最近存活 id（并同步处理
   `context_edit.targetId` / `compaction.firstKeptEntryId` / `label.targetId` 的悬空引用）。原型已证：92 行改写、体积不变、566 条消息与 `thinkingLevel` 全复原。
2. **必须：改成 temp + fsync + `rename` 原子替换**（当前先 rename 原文件、再新建同名文件裸写）。至少做到「新文件完整落地后才替换」。
3. **必须：`.bak` 已存在时拒跑**（或显式 `--force`），否则第二次执行就没备份了。
4. **建议：`--apply` 后自检并打印**——「从 leaf 上溯可达条数 == 保留条数」「用 `SessionManager` 加载出的消息数 == 改动前」，
   不等就自动 `.bak` 回滚（就是本单的 `load-probe.mjs` 那两步，可直接复用）。
5. **建议：`frames.jsonl` 分支加终态守卫**（末行非 `completed/failed` 时保留最后一个终态行）。
6. **建议：流分支改成 `JSON.parse` 后按 `type/customType` 判删**，别用整行子串（R6）。

真机操作序列（修好后）：

```
① 关闭该会话所在窗口/面板（避免 _rewriteFile 把删掉的帧写回、避免 reset 时期写指针落空）
② 先 cp 一份全量备份到别处（不要依赖脚本自己的 .bak，它会被二次执行覆盖）
③ 逐个文件 --apply（一次一个，别一把梭，便于出错定位）
④ 立即用 SessionManager 加载自检：contextMessages / thinkingLevel 与改动前一致
⑤ 不相等 → mv .bak 回去；相等 → 重开面板验证浮窗历史行（R4 那种 handle 要单独看）
```

---

## 八、命令原文与 node 输出原文

### 8.1 干跑（默认，不写盘）

```
$ node scripts/migrate/slim-subagent-frames.mjs "C:\Users\ADMINI~1\AppData\Local\Temp\slim-probe/2026-11-17T02-11-31-246Z_01a1e746-112e-737b-8c3b-8e6b83c06054.jsonl"
[干跑] C:\Users\ADMINI~1\AppData\Local\Temp\slim-probe\2026-11-17T02-11-31-246Z_01a1e746-112e-737b-8c3b-8e6b83c06054.jsonl
        299.9MB → 20.69MB（省 93%） 行 619，丢旧帧 276.0MB / delta 流 3.2MB

合计可省 279.2MB（干跑，未改任何文件；加 --apply 才真改）

real    0m2.708s
```

干跑后目录：只有原副本，**无 `.bak`**，size 仍 299,924,214。

### 8.2 真实 `--apply`（打在副本上）

```
$ node scripts/migrate/slim-subagent-frames.mjs --apply "…\…apply.jsonl"
[改] C:\Users\ADMINI~1\AppData\Local\Temp\slim-probe\2026-11-17T02-11-31-246Z_01a1e746-112e-737b-8c3b-8e6b83c06054.apply.jsonl
        299.9MB → 20.69MB（省 93%） 行 619，丢旧帧 276.0MB / delta 流 3.2MB

合计可省 279.2MB（已写 .bak 备份，确认无误后可自行删除）

real    0m3.253s

$ ls -la
-rw-r--r-- 20690145  …apply.jsonl
-rw-r--r-- 299924214 …apply.jsonl.bak
$ sha256(.bak) = 7506d22e3bb3a3f8ffb7f153f0f705fe401adb12786745f05ebb2cb24431ba3c   ← 与源一致
```

### 8.3 独立逐类账（`analyze.mjs`，只读）

```
总计: 299924214 字节 (299.92MB) / 13186 行 / 最长行 3275KB / 末尾换行=true
 1257 行    279.70MB   93.26%  custom:subagent-async（有 handle）
  249 行      8.91MB    2.97%  message:toolResult
   45 行      7.29MB    2.43%  message:user
11320 行      3.19MB    1.06%  custom:subagent-async-stream
  287 行      0.79MB    0.26%  message:assistant
    2 行      0.02MB    0.01%  message:system
   17 行      0.00MB    0.00%  type:context_edit
    6 行      0.00MB    0.00%  type:model_change
    1 行      0.00MB    0.00%  type:session_info
    1 行      0.00MB    0.00%  type:session
    1 行      0.00MB    0.00%  type:thinking_level_change
subagent-async 行缺 frameKind: 1257 / frameKind 取值: []
subagent-async-stream 行缺 frameKind: 11320
误删风险探针（行内含 "subagent-async-stream" 但非该 customType）: 0 行
```

### 8.4 pi 自带 `SessionManager` 真加载（before / after / 重接原型）

```
$ node load-probe.mjs <pristine 副本>
{ "entries": 13186, "leafId": "f8478ca7", "contextMessages": 566,
  "roles": {"system":2,"user":45,"assistant":270,"toolResult":249},
  "thinkingLevel": "high", "model": {"provider":"deepseek","modelId":"deepseek-flash"},
  "fileMutatedByLoad": false }
real 0m3.244s

$ node load-probe.mjs <apply 后的瘦身副本>
{ "size": 20690145, "entries": 619, "leafId": "f8478ca7", "contextMessages": 21,
  "roles": {"assistant":11,"toolResult":9,"user":1},
  "thinkingLevel": "off", "fileMutatedByLoad": false }
real 0m0.601s        ← 历史塌了

$ node load-probe.mjs <重接 parentId 的原型>
{ "entries": 619, "contextMessages": 566,
  "roles": {"system":2,"user":45,"assistant":270,"toolResult":249},
  "thinkingLevel": "high" }
real 0m0.624s        ← 完全复原
```

### 8.5 链诊断（`diag-chain.mjs`）

```
瘦身文件条目: 619；从 leaf 向上可达: 24；孤儿(不可达): 595
断链处: custom:subagent-async (2026-11-18T03:32:20.704Z) parentId=7991d2a0 → 找不到
断链之父在原件里是: custom:subagent-async (2026-11-18T03:32:20.689Z)
原件条目 13186，瘦身删掉 12567 条
瘦身后 parentId 悬空的条目: 92
原件从 leaf 向上可达: 13185
原型重接: 改 parentId 92 条 → …apply.relinked.jsonl (20690145 字节 / 20.69MB)
```

### 8.6 千行留存核对 + 全库干跑 + kill 测试 + 二次 apply

```
{slimLines:619, badJsonLines:0, 保留行在原件中找到:619, 原件行数:13186, 末尾字节:"0x0a(有换行)"}
保留帧 status: sa-94/92/95/96/97/98/108 completed, sa-99/100 failed, **sa-93 running**
残留 stream 行: 0

$ node scripts/migrate/slim-subagent-frames.mjs --min-mb 50        # 只读全库扫
… 21 个文件 … 合计可省 2830.4MB（干跑，未改任何文件；加 --apply 才真改）
real 0m24.639s
# 例：713.4MB → 17.02MB（省 98%）；299.9MB → 20.69MB（省 93%）；sa-91/frames.jsonl 206.0MB → 0.05MB

$ node script --apply <副本> & 轮询到 .bak 出现立即 kill -9
在第 43 次轮询（约 430ms）发现 .bak 并 kill
主文件 1,176,117 字节 / 93 行 / 不可解析行 0 / 末尾换行 true
.bak   299,924,214 字节 / sha16 7506d22e3bb3a3f8

$ node script --apply <已瘦身副本>      # 二次执行
        20.7MB → 20.69MB（省 0%） 行 619，丢旧帧 0.0MB / delta 流 0.0MB
二次 apply 前 .bak sha256: 7506d22e3bb3a3f8…
二次 apply 后 .bak sha256: 4d95be1ef748818f…      ← 原件备份被覆盖

$ node -e "try{'x'.repeat(713e6)}catch(e){console.log(e.constructor.name+': '+e.message)}"
RangeError: Invalid string length          （300MB 通过 → 713MB 会话全文读不进 V8 字符串）

$ node append-probe.mjs <瘦身副本>          # appendEntry 续接
{"leafBefore":"f8478ca7","newId":"1947c246","appendedParentId":"f8478ca7","parentOk":true,"grewBy":172}
```

---

## 九、清理情况与遗留

* **真会话目录零写入**：没有任何 `--apply`、没有产生 `.bak`、源文件 sha256/mtime 前后一致（§1）。所有写操作只发生在 `%TEMP%/slim-probe/`。
* 临时目录仍在：`%TEMP%/slim-probe`（**653MB**：pristine 副本 + apply 产物/.bak + 重接原型 + kill 残骸 + append 副本 + 探针脚本）。
  **未删除**（删除属红线，留给总监/用户决定）；里面 `<样本名>.apply.jsonl.bak` 已被二次 apply 污染，**别当原件用**——
  真正的全量基线是 `<样本名>.jsonl`（sha `7506d22e…`）。
* 项目侧：只新增本文件（`reports/SCOUT-t34-slim.md`），`scripts/`、`src/`、`webview/`、`harness/` 一行未动，未 commit。
* 可直接复用的探针（都在临时目录）：`load-probe.mjs`（改动前后上下文条数对比，§7 第 4 条的自检就用它）、
  `diag-chain.mjs`（链可达性 + 悬空 parentId 计数 + 重接原型）、`dangling-by-type.mjs`（悬空行按类型/按父节点类型分账，换文件复核 R1 时用它）、
  `tail-status2.mjs`（判 `frames.jsonl` 末行是否终态，R5 的守卫判据）。
