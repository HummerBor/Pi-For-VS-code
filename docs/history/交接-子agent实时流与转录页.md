# 交接 · 子 agent 实时流转发 + 独立转录页（2026-11-03）

> 自包含。接手前只需要读这一篇 + `AGENTS.md`。
> 一句话：**子 agent 的展示做到了和主会话同口径（delta 逐字流 + 同一份 webview）**，
> 但**「会话关了重开 → 子智能体浮窗消失」还没修完**，埋点已上（0.1.107），等复现取证。

---

## 一、本轮做了什么（已落地，工作区未提交）

### 1. pi 1.4.0 → 1.5.0
- `package.json` devDependencies `^1.5.0`；API 面纯加性（删 0 导出/0 文件，新增 22 导出）。
  唯一 Breaking（工具参数校验切 pi-schema）经全仓扫描零影响。
- `vendor/pi` 内置版本跟着构建走；硬依赖仍只 `jiti` + `@silvia-odwyer/photon-node`。
- `scripts/release/vendor-pi.mjs`：cpSync 前先 `rmSync` 清 `dist/bundle` + `node_modules`，
  拷后核对文件数。修掉 1.4.0 的 38 个死 chunk 造成的包膨胀（4.72MB → 3.53MB）。

### 2. 子 agent **delta 级**逐字流（harness v17）
根本原因：`message_update` 的 delta 流**子进程一直有**，harness 当初只接了
`message_end`（约 746 行），所以子 agent 只能一条一条整段跳。官方口径见
`node_modules/@earendil-works/pi-coding-agent/docs/json.md`：rpc/json 的 `message_update`
就是 delta-only（`text_delta` / `thinking_delta` + `contentIndex`）。

链路（与主会话同构）：

```
子进程  message_update(text_delta)
   → harness 按 kind 攒批 ~120ms（hostWantsStream / pushStreamDelta / flushStream）
   → pi.appendEntry("subagent-async-stream", { handle, kind, text })
   → piCore 消费 custom entry → caps.pushSubagentStream(handle, kind, text)
   → panel → transcriptTab.pushTranscriptStream → webview {newLive|delta|thinking}
   → message_end 先 flushStream、再 emitAsyncProgress（末段不丢）
```

- **只在插件宿主开启**：`src/pi/piSdk.ts` 设 `process.env.PI_HOST = "pi-vscode"`，harness 用
  `hostWantsStream()` 判。原因写进 harness 注释：转发通道是 `appendEntry`，**CLI/TUI 宿主会把它
  落盘**，逐 delta 会把父会话撑到几十 MB；插件里不落盘且转录页要逐字体验。CLI 下仍按条。
- 收尾契约：`message_end` → `flushStream` → 消息级 render 对齐（工具行/折叠块/思考块结构归位）。
  `transcriptTab.pushTranscript` 里把 `liveOpen = false`。

实测（sa-19，父会话落盘统计）：

```
subagent-async-stream  148 条    27.6KB   均 0.2KB/条    ← delta 包
subagent-async          48 条   824.6KB   均 17.2KB/条   ← 消息级帧（每帧重发尾窗 20 条）
```

### 3. 独立转录页（`src/vscode/transcriptTab.ts`，新增文件）
- **不是新造一套 UI**：同一份 `getHtml`（index.html + main.js + style.css/tokens.css）的另一个
  实例，独立 `WebviewPanel`、独立 tabId（tr1/tr2…）。
- 只读实现 = **一层 CSS**，页头/页脚/气泡全部与主会话一致：

```css
#composer { display: none !important; }   /* 只收输入区 */
#hdr-row1, #header { display: none !important; }  /* 用户两轮截图：整行都去掉 */
```

  历史：曾做 `#session{display:none}`（标题重复）→ 用户说「应与主会话一致 + 只读标记去掉」→
  恢复 → 用户又说「多了这些，整行都去掉」→ 最终整行隐藏。（编辑区实例本来也会加
  `editor-panel` class 隐页头，转录页显式写死，别依赖它。）
- 只读标记（「（只读）」后缀 + 只读提示 notice）**已按用户要求全删**。
- 标签图标 = 鸭子：`panel.iconPath = media/source/pi-icon-small.svg`（与主会话编辑器标签同一份），
  `panel.ts` 传 `iconPath`，`ChatPanelProvider.tabIconUri()` 兜底。
- 页脚数据补齐（用户截图指出「红框处都有不同」的根因是**数据没喂**，不是样式）：转录页原来只发
  `state`，现在补 `tabs`（页头标题唯一事实源）、`mode`（`Auto`）、`stats`——其中
  `contextPercent = 最后一条 assistant 的 usage.totalTokens ÷ 模型窗口`，窗口从
  `~/.pi/agent/models-store.json` 查一次记忆（`contextWindowOf()`；查不到只显示花费）。
- 打开用 `viewColumn: this.bestViewColumn()`（并列标签，不新开分屏）。

### 4. 顺带修的子 agent 链路（前几轮）
- harness `getPiInvocation` 读 `PI_CLI_ENTRY`（v9，Windows 上用指路契约，此前只写不读 → ENOENT）。
- async 派单 TDZ 修复（v10）；异步单 `run.result` 补 `handle`（v11，否则快照无句柄 → 浮窗一单多行）。
- `projectSlug` 换掉 `\`（v12）→ Windows 建多层嵌套目录、左侧列表扫不到；`scanSubagentSessions`
  改递归（深度护栏 6）。
- 孙 agent 封禁（v14）：`CHILD_EXCLUDE_TOOLS = "subagent,subagent_list,subagent_collect,subagent_steer,subagent_kill"`，
  同步/异步两路都 `--exclude-tools`（**spawn 参数层实现，主会话路径零改动**）。
- 心跳注入删除（v16）——完成回传（`reportBackToMain`）是唯一必要的对话内通知。
- `replaySubagentRuns`/`replaySubagentHistory` 只认 `toolName==="subagent"` 的派单回执
  （list/collect 回执带同形状 details，会把行凭空造出来）。

### 5. 测试模型统一
`~/.pi/agent/agents/{worker,planner,reviewer,scout}.md` 的 model 全改 `openrouter/free`
（原来钉 `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`，109s vs 24s，用户「看着比较卡」的真因）。

---

## 二、已结案：**会话关了重开 → 子智能体浮窗消失**（0.1.110 修复，真机验收通过）

### 现象
某个会话里有子 agent 运行记录，关掉聊天标签页再重开，浮窗（子智能体面板）整块不见了。
左侧列表/台账行照旧。

### 已排除 / 已确认
- 重放逻辑本身**没问题**：`d:/tmp/test-replay.cjs` 直接跑 `PiCore.replaySubagentHistory`
  喂当前会话文件 → 19 条 `subagentUpdate`（sa-11…sa-20）+ `subagentLedger` 10 行。所以是
  **真实 boot 链上某处静默返回**，不是重放算法。
- 日志实证：p275 那次 boot（会话文件已回填、855 条消息）**一条 `subagentUpdate` 都没发**，
  且 `subagentLedger rows=arr(0)`（handle 集为空）→ 说明 `replaySubagentHistory` 提前 return。

### 嫌疑（按可能性排）
1. **守卫占死**：`subagentHistoryReplayedFor = file` 写在干活**之前**；若第一次调用时文件还空
   （`stat.size === 0` / boot 时序），标记已落，之后同一 core 永不再试 → 面板永久空。
2. **时序**：`postUiState` 里调重放时 `lastSessionFile` 还是 null（`refreshState` 未回填）。
3. 会话文件里 `subagent` 回执未被识别（已排除：文件里 11 条 `toolName==="subagent"`，正文句柄齐全）。

### 已做的处置（0.1.107 埋点 → **0.1.108 取证 + 修**）
`src/core/piCore.ts` `replaySubagentHistory` 加了三条 `dbg` 留痕（0.1.107）：

```
[subagent-replay] skip file=有|空 same=true|false handles=N   ← 命中守卫
[subagent-replay] start handles=N                             ← 真开始干活
[subagent-replay] scanned handles=N entryFrames=M             ← 扫完
[subagent-replay] FAIL <err>                                  ← 原来这里是空 catch
```

**证据已取到（2026-11-03 08:22 两次 boot，p278/p279）**：

```
out subagentLedger rows=arr(0)
[subagent-replay] start handles=0        ← 只有 start
   ⋯ 无 scanned、无 FAIL（全日志 0 条）
```

start 之后到 scanned 之间**唯一能静默返回的地方**就是
`const stat = await fs.promises.stat(file).catch(() => null); if (!stat || stat.size === 0) return;`
——`.catch(()=>null)` 把 ENOENT 吞成 null，而**守卫在干活之前就落了标记**（原 737 行），
所以同一 core 永不再试 → 浮窗永久空。丢证据的是 `catch(()=>null)` 和「先落标记」两处。

**0.1.108 的修法（治本，非症状）**：
- 标记语义改成「**已成功扫完**」：`subagentHistoryReplayedFor` 只在扫完后落；stat 失败/空文件
  **不落标记**，下一拍 `refreshState → postUiState` 自然重试（不新增轮询/心跳）。
- `catch(()=>null)` 拆开：`stat-FAIL <code> file=<全路径>` / `stat-空文件 size=… file=…` /
  `start size=… handles=… file=…` / `done handles=… entryFrames=…`。下次再空，日志直接指路径。
- 真实会话实测（一次性 probe，`d:/tmp/probe-replay.cjs`）：02-48-58 会话（9.1MB）→
  19 条 `subagentUpdate`（sa-11…sa-20）、10 个 handle、台账 2 行。

### 真凶（0.1.109 日志铁证，2026-11-03 08:38，tab=p283 关标签重开）

```
[subagent-replay] stat-FAIL ENOENT
  file=...\2026-11-03T08-38-32-477Z_01a1a08f-....jsonl   ← pi 刚建、根本没写盘的「幽灵会话文件」
  cur =...\2026-11-03T02-48-58-475Z_01a19f4f-....jsonl   ← 真文件（= claimedFile）
  tab=p283
```

关标签重开（freshTab 链）时 pi 会先建一个新会话文件（只登记路径、不落盘），`switchSession`
之后 `getState().sessionFile` **仍报那个幽灵**；两个路径长度都是 144 字符，所以之前从日志上
根本看不出来。重放只认 `lastSessionFile` → 永远 stat 不到 → 浮窗整块空。
重启 VSC 走恢复链（`getSessionForWs` → `switchSession(旧文件)`），`lastSessionFile` 就是真文件，
所以那条链一直是好的——**“重启有、重开没”的差别就在这**。

**0.1.110 修法**：候选源改成 `[claimedFile, lastSessionFile]` 逐个 stat，取第一个真落盘且非 0 字节的；
标记仍只在扫完才落（0.1.108 的改动保留，失败/空文件会自动重试）。

**回归用例（进仓库，`npm run test:replay`）**：`scripts/test/subagentReplay.test.mjs`——
fixture 在临时目录自造（会话 jsonl／台账 `runs/*.json`／`frames.jsonl`），**只断可观测契约**
（`post()` 出去的 `subagentUpdate` / `subagentLedger`），不断私有标记字段；诊断日志经
`PI_CHAT_DEBUG_LOG` 改到临时目录，不污染用户日志。5 组 11 条：① ENOENT 不投但机会不烧、
回填后同一 core 补投 ② 0 字节同路径长大能补投 ③ 幽灵 lastSessionFile + 认领真文件（p283 现场）
④ 同文件不重复投 ⑤ `subagent_list` 同形状 details 不造行 / 截断半条 JSON 不崩链。
**用例牙口已验**：同一套断言指向已安装的 0.1.109 旧构建 → 精确红在 ③。

### 历史：为何会走到这一步（复盘）
**重启 VS Code → 默认恢复的那个会话有浮窗；关标签再重开 → 浮窗没了。**
两条链不同：恢复链（非 freshTab）恢复前会话文件已落盘且很大 → stat 成功 → 扫得动；
关标签重开是 freshTab 链（跳过 `getSessionForWs`），`getState().sessionFile` 可能只是
「刚登记、还没写盘」的路径（buffered write），stat 不到或 0 字节 → 旧代码静默 return +
标记已落地 → 同一 core 永不重试。0.1.108+ 的「扫完才落标记」正是给这个窗口留的重试口。
`0.1.109` 的 `stat-FAIL/start` 行会把 **全路径 + cur=(claimed 文件) + tab=** 打在日志里，
下一次复现就能直接定性（路径指错人，还是 pure 时序）。

**待用户复验**：装 `pi-for-vscode-0.1.108.vsix` → 关掉聊天标签 → 重开该会话 → 浮窗应回来；
日志里应出现 `[subagent-replay] start size=… file=…` → `scanned` → `done`。若仍是
`stat-FAIL`，那行就是 `lastSessionFile` 指错文件的铁证（路径直接打在日志里）。

---

### 验收（2026-11-03 09:29，0.1.110 真机日志）

三次重开（p287/p288/p289）全部走通，`start → done` **≈310–360ms**，用户口径「几乎秒出」：

```
[subagent-replay] stat-FAIL ENOENT file=<幽灵> cur=<真文件>   ← 幽灵仍在，已无害
[subagent-replay] start size=9165087 file=<真文件>            ← 改用认领的真文件
[subagent-replay] scanned handles=10 entryFrames=10
[subagent-replay] done handles=10 entryFrames=10
```

**同一次验收暴露并已修的新缺陷**：0.1.110 把「落标记」从函数开头挪到扫完之后，顺手丢了它
原本的隐式重入保护 —— `postUiState` 在 4ms 内连发两次，第二次在第一 `await` 期间溜进去，
同一份 9.1MB 文件被扫两遍（日志里 start 两条、scanned/done 成对）。后果轻（多付 ~50ms +
重复 post，webview 按 id 幂等），已加 `subagentReplayInflight` 合并并发，用例第⑥项钉死
（对着 0.1.110 旧构建跑 → `actual 6 / expected 3` 精确红）。

## 三、版本与安装包

| 版本 | 内容 |
|---|---|
| 0.1.96 | 转录 tab 开在当前编辑器组（修分屏） |
| 0.1.97 | READONLY_CSS + 页脚 state + 短标题 |
| 0.1.100 | `#session` 隐藏（标题重复） |
| 0.1.101 | **harness v17 delta 流转发**（PI_HOST 门） |
| 0.1.102→103 | 只读标记全删 + 恢复与主会话一致 + agent 模型换 openrouter/free |
| 0.1.104 | 页脚补齐 tabs/mode/ctx%/cost |
| 0.1.105→106 | 页头整行隐藏 + 标签图标换鸭子 |
| 0.1.107 | replay 埋点（已取到证据：死在那句静默 return） |
| 0.1.108 | replay 守卫改成「扫完才落标记」+ stat 取证留痕 |
| 0.1.109 | stat/start 行带全路径 + `cur=` + `tab=`（**取证成功：真凶是幽灵会话文件**） |
| **0.1.110** | 候选源改「认领文件优先、lastSessionFile 兜底」逐个 stat —— **真机验收通过**（见下） |
| （未打包） | 重入合并：`subagentReplayInflight`，并发两次调用只扫一遍（源码已修+用例，下次打包带上） |

包在仓库根：`pi-for-vscode-0.1.110.vsix`（.107/.108/.109 保留做对照）。

harness 已手动 `cp` 到 `~/.pi/agent/extensions/subagent/`（v17）。**改 harness 必须 bump
`harness.json` 的 version**，否则已安装副本不更新。

---

## 四、红线 / 约定（这一轮踩过的）

- **子 agent 页必须与主会话完全分开**（用户原话「不要公用一套逻辑」「别他妈又写出主会话的
  bug」）：不许在共用路径里加 `isSubagentSession` 这类判断（做过一次，已全回滚）。
- **禁止多余轮询/心跳**；完成回传是唯一必要通知；心跳注入已删（v16）。
- **验证姿势**：派单 → 结束回合 → 等 followUp 回传唤醒 → 再查台账。不许 `sleep`/轮询。
- **测试模型一律 `openrouter/free`**。
- **git 不提交**（提交/发版归 ship 会话）；`webview/main.ts` 的改动是用户自己的（全角归一），别碰。
- `bash` heredoc 会吃反斜杠：含反斜杠的正则/转义**用 edit 工具写**，不走内联命令。
- 文档只放长青约定，一次性用例登记写自己文件头。

---

## 五、关键路径

```
harness/subagent/index.ts        delta 攒批/转发（v17：hostWantsStream/pushStreamDelta/flushStream）、
                                 派单 spawn 参数（--exclude-tools、runDir、--session-dir）
harness/subagent/harness.json    版本门（改代码必须 bump）
src/pi/piSdk.ts                  PI_HOST=pi-vscode（delta 转发的宿主门）
src/core/piCore.ts               subagent-async-stream 消费 / replaySubagentRuns / replaySubagentHistory
src/core/hostCapabilities.ts     pushSubagentStream 接口
src/vscode/panel.ts              pushSubagentStream → pushTranscriptStream；openTranscript 传 iconPath
src/vscode/transcriptTab.ts      转录页（getHtml 复用、只读 CSS、页脚数据、tab icon）
scripts/release/vendor-pi.mjs    内置 pi 拷贝（先清后拷 + 文件数核对）
```

台账与帧（运行期排障）：
- 台账 `~/.pi/agent/sessions/subagents/runs/<handle>.json`
- 子会话 `~/.pi/agent/sessions/subagents/<slug>/<handle>/`
- 帧 `<sessionDir>/frames.jsonl`
- 调试日志 `~/.pi/agent/pi-chat-debug.log`（2MB 轮转一代）

命令：`npm run compile`（vendor + typecheck:webview + build:webview + tsc）／`npm run package`；
用例 `test:{detail,subagent,revert,migration,linkify,errclass,html,replay}` 全绿。
桩件：`d:/tmp/stub/node_modules/vscode/index.js`（stub vscode）、`d:/tmp/test-tab.cjs`（转录页端到端）、
`d:/tmp/test-replay.cjs`（重放端到端）。

---

## 六、下一步（按顺序）

1. ~~取证据~~ → 已完成；~~复验浮窗~~ → 0.1.110 真机通过（见二·验收）。**本 bug 结案。**
2. **启动慢战役（进行中，已量半程）**。离线实测（`scripts/probe/probe-services-split.mjs`、
   `probe-services-queue.mjs`，跑法见各自文件头）：

   | 项 | 实测 |
   |---|---|
   | `createAgentSessionServices` 冷（jiti 现场编译扩展） | 1322ms |
   | 同上热（第 2/3 次） | 200–280ms |
   | 关扩展 / 关技能+上下文 / 全关（地板） | 166 / 104 / 95ms |
   | 空 agentDir（无 harness/secc-api/mcp.json） | 68ms |
   | 串行 3 个 client / 并发 3 个 | 237ms / 219ms |
   | 855 条会话 render payload | 8.10MB JSON，stringify 27ms |
   | 真机日志 `services` 单跳（当前日志 10 次） | 中位 **133ms**、最大 2900ms |
   | 重放本身 | 会话全扫 52ms、`SessionManager.open` 40–60ms、台账过滤 2ms |

   **9.2s 真凶已抓到（0.1.111 `[boot-svc]` 打点 + 离线对照，2026-11-03 10:44）**：

   | 观测 | 值 | 说明 |
   |---|---|---|
   | `[boot-svc] mr=2721ms` | 但离线同参数 `ModelRuntime.create` = **14ms**（vendor bundle）/ 13ms（dist） | 不是 mr 慢 |
   | 同一窗口 `[subagent-replay] start→scanned`（1MB） | **2.6s**（离线十几 ms） | 不是重放慢 |
   | `SessionManager.listAll()`（左侧列表数据源，414 会话/1247MB） | **8.0–9.0s，每次都不缓存** | **宿主线程被它堵住** |
   | `SessionManager.list(cwd)`（项目作用域，237 会话） | 1.6s | 同一 API 的项目口径 |

   pi 为什么这么贵：`SessionInfo` 带 `allMessagesText`（每个会话的全部消息正文），
   吐 414 条列表 = 读完 1247MB；而壳只要 `path/cwd/name/firstMessage/modified`。
   触发点：`panel.ts` 在 webviewReady 里无条件 `void listSessions()`（无 cwd = listAll）当
   「后台预热」→ 8 秒同步解析压在 boot 那一拍，所有 await 的墙钟都被拖长。

   **0.1.112 修法**：预热改成 ① 只预热本 cwd（与 sessionsView 同一 memo key）
   ② 推迟 1500ms 到首帧之后，不跟 boot 抢线程。`services`/排队/共享 services 全部不动
   （共享 services 仍是 2026-10-23 串台红线）。
   待验：重载后 `[boot-svc] 合计` 应回落到 ~1s 量级，`[subagent-replay] start→done` 回到
   300ms 上下（对照 0.110 实测 310–360ms）。
3. **台账换源（正确性，非速度）**：台账 `parentSession` 是 `--d--`（小写）而磁盘是 `--D--`，
   严格 `===` 命中 0/10、忽略大小写 10/10 —— 要按台账过滤必须先规范化路径（`samePath` 先例）。
4. 可选刀 B：转录页 live 追加（现在 live 结束会整页 render 一次，长会话有可见重排）；
   刀 A：`subagent-async` 消息级帧只带新增消息 + 起始下标（824KB → 预计 1/10）。
5. 全部通过后交由 ship 会话提交发版（本工作区改动一律未提交）。
