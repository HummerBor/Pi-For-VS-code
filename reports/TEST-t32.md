# TEST-t32 · 工单32 独立验收测试报告（测试方，只测不修）

> 测试基线：HEAD=8e5190c（含三刀 964d92c / c5fd56b / 86e67a7 + REPORT-t32）。
> 本报告只写 reports/TEST-t32.md 与补充探针 scripts/probe/test-t32-followunit.mjs，未改任何源文件/文档，未提交。
> 结论先行：**无 P0/P1 阻断以外的未决项**——准确说：**P0 无，P1 一处（⚡菜单 compact 链路可绕锁写文件），
> P2 四处（竞态/闸窗丢失窗口/perf），P3 五处（注释失实/钩子不全等）**。编译与全套回归零回退，探针全过，
> REPORT 声称逐条对上，无虚报。

## 一、声称核对表（REPORT-t32 §一/§二 逐条）

| # | 声称 | 核法 | 结论 |
|---|---|---|---|
| 1 | 刀1 `piChat.openSession {file,name}→{ok,reason}`，file 优先、name 扫 SessionInfo.name 兜底、existsSync 先查、已开走 openOrFocusSession 聚焦 | 读码 extension.ts:131-139 + resolveSessionFile:16-27；openOrFocusSession 为既有 static（panel.ts diff 仅 6 行配置监听，未动它） | ✅ 属实。四态：file 在→`{ok:true}`；file 不在→`{ok:false,reason:"not-found"}`；name 命中→解析 file→existsSync；name 未命中→null→not-found。「返回值只代表已路由」语义与实现一致 |
| 2 | 刀1 `piChat.externalWriting` 登记表，core/externalWriting.ts 纯逻辑叶（宿主写/核心读） | 读码 extension.ts:144-153（name 无条件登记 + file 双写双清）；externalWriting.ts 零 import | ✅ 属实。name/file 双键、writing:false 双清（交棒信号） |
| 3 | sessionCache.listNative 透传 piChat.sessionDir，memo key 带 sessionDir；panel 配置变更 invalidateListMemo + 列表重扫 | 读码 sessionCache.ts:76-78/99（key=`cwd:…|dir:…`）、peekListSessions 同 key 口径；panel.ts:555-558；SDK 签名 session-manager.d.ts:410/413-414 复核 | ✅ 属实。list(cwd, sessionDir, progress)/listAll(sessionDir, progress) 重载匹配 |
| 4 | 刀2 bindSession 单点挂载（boot/切会话/fork 全覆盖） | 读码 piClient.ts:302-317（startFollow 在 bindSession 内）、bindSession:414-419；init:249 与 afterSessionSwap:423（newSession/switchSession/fork/clone 四处调用） | ✅ 属实 |
| 5 | 500ms stat 轮询、`\n` 分帧（半行攒帧/坏行跳过/只滤 message）、externalAppend 上屏 | 常量 piClient.ts:300-301（FOLLOW_TICK_MS=500/FOLLOW_QUIET_MS=10s）；follow-probe.mjs 13/13 独立复跑通过 | ✅ 属实 |
| 6 | 本地写入识别（isStreaming + markOwnWrite 1.5s 窗口 rebase） | 读码 piClient.ts markOwnWrite（1500 常量）+ followTick own 分支；补充探针变体 E 实证（窗口内增长归本地、offset rebase） | ✅ 属实 |
| 7 | getMessages/messagesSync 叠加 followDelta | 读码 piClient.ts messagesSync/getMessages（`base.concat(this.followDelta)`） | ✅ 属实 |
| 8 | 只读锁：registry（path/name 双键，name 30min TTL）**或** delta 非空且 mtime 静默窗内；锁上→徽标+禁发；四处门禁 | externalWriting.ts:14-47（TTL）；followTick active 判定（探针②三分支 A/B/C+B′/B″ 实证）；webview main.ts:1461-1479 setExtLock（#statusline 存在 index.html:43，.ext-badge 脉冲 style.css:1807-1820） | ✅ 属实 |
| 9 | 四处门禁 + 调用方 catch → notice 上屏（panel:1610/1889/1534） | sendPromptCore 门禁 piCore.ts:1081-1084（notice extSendBlocked）；setModel/setThinkingLevel/setSessionName throw piClient.ts:616/631/668（编译产物 3 处文案，探针①断言）；catch：panel.ts:1609-1611（opFail）、1887-1890（settingsFail）、1529-1536（cmdRename 在 run 包裹 try 内） | ✅ 属实，行号与 REPORT 基本一致 |
| 10 | 打开即写堵点：applyModelMemory 活跃/开档可疑时缓写，11s 自愈 | 读码 piCore.ts:1336-1368（isFollowActive \|\| isExternalMtimeFresh → deferModelMemory；11000ms 单定时器自愈循环） | ✅ 属实 |
| 11 | 交棒：switchSession(file, force=true) 绕「已在目标上」短路→重绘→补记忆→解锁；失败保持锁不进重试风暴（extReleasing 不复位，状态变化/新 client 接线复位） | 读码 piClient.ts:651-663（!force 短路）+ 探针①运行时三态实证（force=true 同文件真实重进）；piCore.ts:1388-1410（extReleasing 重入锁 + 失败不复位）、:1373（状态变化复位）、:380（接线复位）；探针③-4 证重入直接返回 | ✅ 属实 |
| 12 | 协议只增不改：ExternalAppendMsg/ExternalStateMsg 追加文末 + HostToWebview 联合增两项；GATE_PASS 增两项（append 走闸直发、state 闸后必重发） | `git diff 588b95e..86e67a7 -- src/core/protocol.ts`：唯一 hunk 是联合尾行追加 + 文末两 interface，纯增量；piCore.ts:2300-2301 GATE_PASS；piCore.ts:656 闸后重发 externalState | ✅ 属实（联合尾行 `UiStateMsg;`→`UiStateMsg | …;` 属语法必然，语义只增） |
| 13 | i18n 中英各 5 键同名同数 | grep：zh i18n.ts:276-280 / en :702-706，键名 extRunning/extRunningTip/extRunningNotice/extSendBlocked/extReleaseFail 一一对应 | ✅ 属实 |
| 14 | 刀3：extension.ts 500ms 文件名指纹轮询（recursive readdir，默认根+sessionDir），变更→invalidateListMemo+refreshNow（不吃 2s debounce） | 读码 extension.ts:85-118（watchRoots/fpOf/fpTimer，fpTimer dispose 挂 subscriptions:108）；sessionsView.ts:45-49 refreshNow（清 debounce timer） | ✅ 属实。不用 mtime（NTFS 粒度）理由成立 |
| 15 | 验证证据：compile 全绿；回归零回退（detail27/subagent46/migration/linkify22/errclass/html）；test:revert 基线红（MODULE_NOT_FOUND）；follow-probe 13/13 | 独立复跑（见 §二） | ✅ 全部复现，数字对上。test:revert 红是 `node_modules/…/diff/libcjs/index.js` 环境依赖路径缺失，patchRevert.test.mts 仅在历史重构提交动过、与本单 12 文件零交集——预存红属实 |
| 16 | 边界自查：protocol 只增、存量 var 未迁移、混入无关文件无 | diff 统计：piCore.ts/main.ts/panel.ts 三文件**零删除行**（纯增量）；总 diff 12 文件全在本单面内（对账 REPORT 表 = 刀1∪刀2∪刀3）；package.json 不在 diff | ✅ 属实 |

## 二、独立验证输出（命令+结果）

1. `npm run compile` → **exit=0，tsc 零报错**（typecheck:webview + vite×2 + tsc 三段全绿）。
2. 全套回归：
   - `test:detail` 27/27 ✅；`test:subagent` 46 项 ✅；`test:migration` 全过 ✅；
     `test:linkify` 22 项 ✅；`test:errclass` all passed ✅；`test:html` OK ✅
   - `test:revert` 红（`Cannot find module '…/pi-coding-agent/node_modules/diff/libcjs/index.js'`）——
     与 REPORT 声称的预存基线红一致，失败点在测试脚本 require 依赖路径，与工单32 改动零交集。
3. `node scripts/probe/follow-probe.mjs` → **13/13 过**（分帧/半行/中文🎉多字节/坏行/offset 推进/双键/TTL 全复现）。
4. 测试方补充探针 `node scripts/probe/test-t32-followunit.mjs` → **27/27 过**，覆盖任务书要求三项：
   - ① force 生效双证：编译产物 out/pi/piClient.js 含 `!force &&` 短路条件 + 3 处门禁 throw 文案；
     运行时 prototype.call 三态：force=false 同文件（大小写/斜杠归一）短路不重进 / force=true 同文件
     真实调 runtime.switchSession / force=false 异文件照常切。
   - ② followTick active 三分支 + 变体：A registry 命中锁（delta=0 照锁）；B delta>0+mtime 新鲜锁且
     发 externalAppend；B′ delta>0+mtime 超 10s 窗 → 解锁 + externalRelease；B″ 本地 streaming 不交棒；
     C 双假零事件；D 文件变小+delta → 交棒；E markOwnWrite 1.5s 窗口内增长归本地（不误渲染）。
   - ③ externalState 解锁时序：onExternalState(false) 且 delta>0 → **不发解锁消息**（只复位
     extReleasing）；delta=0 → 即时解锁；active=true → 锁真相+notice；onExternalRelease 在
     extReleasing=true 时重入直接返回（getState 都不调）。

## 三、问题清单（P0 阻断 / P1 应修 / P2 可记债 / P3 建议）

**P0：无。**

**P1（1 项，应修）**

1. **⚡菜单/compact 链路无外部活跃门禁，可绕锁写会话文件**——src/vscode/panel.ts:421（webview slash `compact`）、:1541（⚡菜单 cmdCompact）→ compactSession:1618 → piClient.compact（piClient.ts，无 followActive 判定，同文件内 setModel/setThinkingLevel/setSessionName 都加了门禁唯独它没有）。外部活跃期输入框虽禁发，⚡菜单按钮仍可达；compact 会向正被外部写入的会话文件 append/重写，与被门禁的 setModel 是同一类双写/树分叉风险。修法建议：piClient.compact 入口加同款 throw（panel 既有 catch → notice 兜住），一行级。

**P2（4 项，可记债）**

1. **交棒收尾无条件解锁的竞态**——src/core/piCore.ts:1401：onExternalRelease 成功路径末尾无条件 `post externalState locked:false`，不复核 `client.isFollowActive()`。若交棒进行中（await switchSession/refreshState 期间）外部写者恢复写入，piClient 已发 externalState(true)（piCore:1375 上锁），交棒收尾的 locked:false 会把它盖掉 → webview 徽标消失、输入解锁假象。宿主门禁（sendPromptCore:1081）兜住真双写，无数据损坏，纯 UI 假象；下一 tick active 恒等于 followActive 不再重发，假象持续到下次状态翻转。修法：:1401 改发 `locked: client.isFollowActive()`。
2. **闸窗内「快照后、flush 前」到达的 externalAppend 会被 render 整页覆盖丢失（显示层）**——postUiState 开闸（piCore.ts:592）→ 快照 getMessages（含当时 delta）→ 闸窗内 append 走 GATE_PASS 直发，webview concat 到 renderedList（main.ts:1574-1579）→ 闸关 flush 的 render 用「快照」整页 renderAll 替换 renderedList——快照取样**之后**长出的那批 append 不在快照里，替换即从 DOM 消失，后续 append 只带更新批次，缺口保留到下次全量 render（交棒重载兜底自愈，最长约一个静默窗+）。REPORT「append 走闸直发，丢失由 uiState 的 delta 快照兜底」只论证了快照**前**的 append，反向窗口未言明。窗口 = postUiState 的 await 段（典型几十 ms，拥堵时秒级），外部活跃时每 500ms tick 都有命中机会。修法选项：render flush 前再 concat 快照后新增 delta（或 render 消息排队时 externalAppend 一并排队）。
3. **⚡菜单 compact 同窗口的 abort/clearQueue 未评估**（与 P1-1 同源，一并修）：活跃期 abort（piClient.abort 无门禁）本地无 run 可中止、无害；clearQueue 清的是本地队列、无文件写入——两者实测无写点，仅 compact 是真写点。列此项是要求修 P1-1 时**顺手核这两个**，不单独构成缺陷。
4. **刀3 watcher 每 500ms 同步 `fs.readdirSync(recursive)` 扫全库根**——src/vscode/extension.ts:97-108：默认根 `~/.pi/agent/sessions` recursive 含全部项目子目录，同步 IO 每秒两拍常驻 extension host；数百文件量级下每拍毫秒级、拥堵/大库下可能十毫秒级周期性阻塞宿主。建议记 perf 债（降频到 2s / 换 fs.watch 目录 + 指纹兑底 / readdir 改 async）。

**P3（5 项，建议）**

1. **注释失实**——src/pi/piClient.ts followTick 交棒注释「失败也能下个 tick 重试，不会卡死在一次性标志上」与实际行为矛盾：piCore.ts:1405-1407 失败后 extReleasing 不复位，下个 tick 的 externalRelease 被重入锁吞掉，**不会重试**（REPORT §一与代码一致，错的是注释）。按注释文化口径，失实注释比缺注释坏——随本单订正。
2. **测试钩子不全**——src/core/externalWriting.ts:50-53：`_resetExternalWritingForTest` 只清 holders 不清 holderNames（探针⑤实证：reset 后 name 键仍命中）——后续任何用该钩子的用例会被跨用例残留污染。
3. **extMemTimer 不进 dispose**——src/core/piCore.ts:496-499 dispose 只清 client；extMemTimer 挂起时面板销毁，定时器最多再活一拍（11s），随后 client=undefined 使自愈条件必假而自然停——有界泄漏，补一行 `if (this.extMemTimer) clearTimeout(...)` 即净。
4. **externalWriting 命令 writing 参数缺失静默当 false**——src/vscode/extension.ts:145-146：`args?.writing === true` 强制收敛，漏传 writing 的调用方会**误清登记且拿到 {ok:true}**（派单契约 writing 为必填 boolean）。建议 writing 非 boolean 时返回 `{ok:false, reason:"bad-args"}`。
5. **文件变小且 delta=0 时直接 rebase offset 不请求对齐**——piClient.ts followTick shrink 分支：delta>0 才交棒重载；外部重写（如分支切换换 inode）发生在「无未消费增量」窗口时，内存态停留旧内容。现实触发面窄（本进程内的 rewrite 都走 bindSession），记债即可。

## 四、边界自查结论（dispatch-t32 §三逐条 grep）

| 边界 | 核法 | 结论 |
|---|---|---|
| openInEditor 语义未动 | extension.ts diff：openInEditor 注册原样保留，仅新增两命令 | ✅ |
| steering 自愈 / 4s pendingPrompt / 还原边界 | piCore.ts 全 diff **零删除行**（纯增量）；自愈正则在 piClient.ts:141-143/piCore.ts:1147 原样；patchRevert.ts 不在 12 文件内 | ✅ |
| 会话 jsonl 格式零改动 | 跟随器纯读（readFollowGrowth 只 openSync/readSync）；无格式相关 diff | ✅ |
| pi 包与 vendor/ 零改动 | diff 不含 vendor/、node_modules；piClient 未 import 新 pi API | ✅ |
| 会话页 UI 形态唯一新增（徽标+锁定态） | style.css 仅增 .ext-badge 23 行；main.ts 纯增量（setExtLock/externalAppend 分支） | ✅ |
| protocol.ts 只增不改 | diff 见 §一#12 | ✅ |
| 存量 var 不顺手迁移 | main.ts 零删除行 | ✅ |
| 不碰 git 历史/禁 push/不 bump 版本 | git log 三刀+REPORT 四个 commit 线性；package.json 不在 diff；无 push（remote 状态未动，按纪律未查） | ✅ |
| 树净/混入无关文件 | 三刀总 diff 12 文件全对账 REPORT 表；当前工作区仅 untracked dispatch-t32.md（派单文件，用毕删除不入库）+ 本报告 + 本探针 | ✅ |

## 五、真机清单核对结论（REPORT §七 每条「操作路径」可达性）

| # | 操作路径 | UI/代码路径可达性 | 结论 |
|---|---|---|---|
| 1 | 终端起 `pi -p --name t32test …` → 插件打开（列表点击或 REPL openSession） | 列表点击链路：sessionsView.ts:63 svOpen → openOrFocusSession ✅；REPL：命令已注册（extension.ts:131，不进 contributes 但 executeCommand 可达）✅；实时增长/上翻不拉底 = 跟随器+renderAll 叠加（探针证数据面） | 路径可达；**运行时表现待真机** |
| 2 | 外部运行中看状态行 | #statusline 存在（index.html:43）；setExtLock 挂 .ext-badge 脉冲徽标（style.css:1807-1820）+ 禁 input/sendBtn（main.ts:1465-1466） | 可达；**待真机** |
| 3 | ⚡菜单改模型/改名 | 门禁 throw（piClient:616/668）→ panel catch notice（1609/1534）✅；文件无新行的验证是用户侧 PowerShell 命令 | 代码可达；**待真机** |
| 4 | 外部退出（10s 静默）→ 自动交棒 | onExternalRelease 全链（piCore:1388-1410：force 重进→render→补记忆→refreshState→解锁）+ 探针①②证关键判定 | 代码可达；**交棒时序/接管对话待真机** |
| 5 | REPL openSession 不存在路径 → not-found | 命令入口 existsSync（extension.ts:134-135），分支代码级已证 | 可达；REPL 实跑**待真机** |
| 6 | externalWriting 登记后打开即锁 | startFollow 同步 emitFollowState（piClient:309-310，不等 tick）+ 探针②A 证 registry 精确判定 | 代码可达；**待真机** |
| 7 | 外部新建会话 ≤2s 上列表 | watcher 链：指纹变化（extension.ts:103-107）→ invalidateListMemo + notifySessionsChangedNow → refreshNow（不吃 debounce）→ sendItems | 可达；**实际耗时（含拥堵场景，REPORT 请示 2 的「常态≤2s、拥堵另计」）待真机** |
| 8 | 配置 piChat.sessionDir 到自定义目录 | 透传（sessionCache:76-99 memo key 含 dir）+ watcher root 含配置目录（extension.ts:85-92）+ panel 配置监听（555-558） | 可达；**行为待真机** |
| 9 | ops-panel 场景 E 回归 | 外部依赖（ops-panel 侧），本仓不可验 | 对照栏，**待联调** |

## 六、收单建议

- P1-1（compact 门禁）建议返修补一行；P2 四项可记债入库；P3 五项随下次触碰顺手清。
- REPORT 声称无虚报；请示 2（拥堵场景 ≤2s 口径）与请示 1（交接文档修正）属产品级，留总监裁决。
- 本报告与补充探针（scripts/probe/test-t32-followunit.mjs，27/27）未提交，等主会话收单。
