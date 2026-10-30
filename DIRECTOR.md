# DIRECTOR.md — 总监文档（pi 的施工依据）

> **总目标：让这个插件不断进化。** 每张工单都要服务这个目标——工程债是进化的地基，
> 产品能力是进化的方向，两者交替推进，不允许长期偏科。
>
> **产品论点（一句话）：把 agent 当组件嵌进老应用，让老产品自己长出 agent 能力。**
> 不做平台、不做生态、不当 DSH/skill 市场的插件——小而美，进谁家门都不装修。
>
> **卖点表述（对外）：「让老应用焕发新生」**——不重写、不迁移、不换生态，
> 存量软件直接长出 agent 能力。对老系统的主人卖焕新结果（省掉的重建成本），
> 不卖 agent 技术（没人关心 harness 是什么）。
>
> **插件就是壳（用户拍板 2026-09-14，原话）：能用 pi 原生能力的就用 pi；任何新功能都
> 要先查清楚 pi 原本有没有这个能力，而不是自己造。** 工单签发前必过查：① pi 公开 API
> （SessionManager 等）② pi TUI 已有行为 ③ pi 扩展生态（官方/第三方）——三处都没有
> 才轮到壳自己写。壳自研的东西与 pi 原生能力重复 = 浪费 + 双份维护 + 行为分裂。
> 本条与架构铁律合起来才是完整的壳：不绑 VS Code、不重造 pi。
>
> **架构铁律（用户拍板）：核心功能不与 VS Code 深度绑定。** 核心逻辑只依赖接口
> （HostCapabilities），不 import vscode；VS Code 特定能力全部住进 adapter/集成模块。
> 一切新功能按此审查。
>
> 本文件由总监维护，是给 pi 的工作指令，**不要合并进 HANDOVER.md**。git 侧 2026-09-11
> 起经 94ff28d 用户拍板入库（台账同步进版本管理），vsix 仍排除（.vscodeignore）。
> 协作流水：pi 施工 → 用户发 `1`/`111` 给总监 → 总监 review 并更新本文件。
> 已完成工单、验收历史、账目/排队/守则等回顾性内容见 [归档.md](归档.md)（只留施工指令）；
> 角色职责见 [总监.md](总监.md) / [施工方.md](施工方.md)；插件通用约定见 [AGENTS.md](AGENTS.md)。
> 最后更新：2026-10-29 架构拍板「ops-panel 是 pi-vscode 的扩展」→ 签发工单33（runPrompt 驱动契约 + 拆除工单32 跟随机制，用户令「把那坨垃圾干掉」）；契约 v2 落《交接-ops-panel-驱动接入.md》（v1 文件跟随版已删）。前情：工单32 全链收单（964d92c/c5fd56b/86e67a7/7070a48/热修三连，见工单区注记）；用户拍板放宽 webview/main.ts ES5 var 限制。
> 前情：09-20 验收循环（五）：工单30 拆除验收通过结单（grep 零命中/compile 绿/逐 hunk 归属干净/原生 APPEND_SYSTEM.md 未误伤，纯拆除无实测项）；工单27 回收全链路闭环。

## 施工工单（待施工）

> ⚠️ **状态标记约定**（用户三次纠偏后钉死）：结单工单**全文迁 归档.md，DIRECTOR.md 零残留**——
> 不留指针行、不留 ✅ 标题、不留「待实测」尾巴；判死单同样原样迁归档（工单八/22 先例）。
> 工单区只存在待施工项。已完成与否以 归档.md 为准，勿信 commit message。
> 做新单前若与旧单边界相关先查归档，勿凭记忆执行旧单条目。
> **工单号一律阿拉伯数字**（工单23 起，用户拍板 2026-09-15；存量编号不改）

### 工单33：pi-vscode 会话驱动契约（runPrompt/abortSession）+ 拆除外部写者跟随机制

> **来源**：架构拍板（用户 2026-10-29）：「ops-panel 是 pi-vscode 的扩展」——执行也走 pi-vscode 进程内 pi（**唯一写者**），不再 spawn `pi -p`（用户原话「我就是要 ops-panel 执行靠 pi-vscode」，并以多会话并发无故障的实测驳回了进程内负载论）。契约全文：《交接-ops-panel-驱动接入.md》（v2，替代已删的 v1 文件跟随版）；拆除令原话「把之前你写的那坨垃圾干掉」——工单32 的跟随/锁/交棒机制整段拆除。
>
> **范围**：
> 1. **拆除（纯拆除，独立提交）**：piClient 跟随器全套（tick/账本/武装/归因/去重/startFollow）、core/externalWriting.ts 整模块、piCore 的 ext 锁/交棒/缓写/门禁（onExternalState/onExternalRelease/deferModelMemory/sendPromptCore 接管段）、protocol 的 externalAppend/externalState 两消息、i18n 六键（zh/en）、webview 的 setExtLock/合批渲染/renderedList/徽标 + style.css 徽标段、extension.ts 的 externalWriting 命令、panel.ts compactSession 门禁、两个探针文件（follow-probe/test-t32-followunit——测的就是被拆的机制）。
>    **保留**：openSession（刀1）、sessionDir 透传（刀1）、目录 watcher（刀3）、其余一律回到工单32 前行为。
> 2. **新增**：`piChat.runPrompt({name, prompt, timeoutMs?}) → Promise<{ok, reason?, error?}>`——按 name 创建/复用**无头会话**（不占页签、进列表）、settle 时 resolve、timeoutMs 到点自动 abort（reason:"timeout"）、busy 同名拒收（reason:"busy"）；`piChat.abortSession({name}) → {ok}`。用户点开（openSession）即挂现成 live 链路实时渲染，跑完天然续聊。
> 3. 交接文档已落（契约 v2）；ops-panel 侧按其 §三 改（不在本单）。
>
> **验证**：compile 全绿 + 全套 test 回归 + **拆除零残留**（grep `externalWriting|followActive|extBadge|ext-badge|externalAppend|externalState|followDelta` 全库零命中）+ runPrompt 探针（settle resolve / busy 拒收 / timeout 自动 abort 三态）。
> **边界**：不动 pi 包/vendor；不动会话页 UI 形态；会话落盘审计红线不破；protocol 只增不改的唯一例外=拆消息（v1 契约废弃连带，用户拍板）；每步独立提交。
> **验收**：契约文档 §四 A-F（B/C 两条即「随时随地看智能体操作」的产品要求）。

### 工单32：外部会话通用接入——openSession/externalWriting 两命令 + 外部写入实时跟随 + 交棒信号（收单存查；跟随/锁/交棒部分已被工单33 拆除，openSession/sessionDir/watcher 保留）

> **【收单】2026-10-29（di-duck-dispatch 全链：施工→独立测试→返修）**：
> 施工 964d92c（刀1 两命令+sessionDir 透传，sa-1）+ c5fd56b（刀2 跟随/锁/交棒，主会话直施——sa-1 45min 侦察失速被停，用户直令接管）+ 86e67a7（刀3 目录 watcher）；
> 独立测试 2be6380（TEST-t32，sa-2：16 组声称逐条核**全实无虚报**，自写探针 27/27，P0 无）；
> 返修 7070a48（P1 compact 绕锁门禁 + P2-1 交棒解锁发真相 + P3×4 一行级，探针断言同步翻转）。
> 判定：compile 全绿、全套回归零回退（test:revert 预存红与本单无关）、双探针 13/13+27/27、边界 9 项全过。
> **遗留债务（记档不修）**：P2-2 闸窗内快照后 append 显示丢失窗口（交棒重载自愈）；P2-4 watcher 500ms 同步 readdir perf；P3-5 shrink+delta=0 不对齐；PI_AGENT_DIR 不在 watcher 覆盖面；活跃期门禁报英文文案。
> **待用户真机**：REPORT §七 9 项（UI 路径已代码级核可达）。**已裁（2026-10-29 用户拍板 A）**：验收 C 拥堵口径 = 常态 ≤2s、拥堵另计（pi 全量扫描拥堵 22s 属环境极限，记档不修；不做强制条目插入的 B 方案）。设计/11 排期总表本仓不存在，本项不适用。

> **来源**：ops-panel 需求《需求-pi-vscode-实时会话查看.md》（用户 2026-10-29 转来，已读并逐条核实）。用户拍板三点：①「以后这种外部接入的需求会很多，得考虑一种通用接入的方法」；②「可以再给它一个明确的交棒信号」；③本单进 DIRECTOR.md + 给 ops-panel 出交接文档（《交接-ops-panel-外部会话接入.md》，同目录）。
> **通用性口径（本单的设计轴）**：**数据面走文件观测**——任何外部写者（ops-panel 的 `pi -p`、终端 pi、CI）往会话 jsonl 追加，插件零接入即可跟随；**控制面走两条命令**——有管家的写者（ops-panel 管着子进程、准知道什么时候写完）额外发信号，精确交棒不误判；没管家的写者走 mtime 静默启发式兑底。勿为单个调用方做定制。
>
> **pi 三处查留证（总监 2026-10-29 实测，grep 可复验，施工方勿重查）**：
> - ①公开 API：`SessionManager.open`（dist/core/session-manager.d.ts:378，实现 session-manager.js:1326）**本身只读不写**（读文件 + flushed=true，无 append）；`listAll(sessionDir,…)` 有重载（d.ts:413-414）、`list(cwd, sessionDir, …)`（d.ts:409）——P1-2 是透传不是造轮子；runtime `switchSession`（agent-session-runtime.js:128）= open + 重建 runtime。
> - **「打开即双写」实锤，但真凶不在 open 在插件打开链路（P1-1 升 P0 定案）**：(a) createAgentSession 对已有会话若分支缺 thinking entry → appendThinkingLevelChange（dist bundle 内，经 `_appendEntry`→`_persist`）；(b) 打开后必跑 `reapplyModelMemory`（panel.ts:613/1232/1256）→ `setModel`（agent-session.js:2008，**无条件** appendModelChange，无同值检查）→ `_persist`（session-manager.js:794-815，已存在文件 flushed=true 直接 appendFileSync）；`setThinkingLevel` 仅等级真变才 append（agent-session.js:2123-2125，有 isChanging 守卫）。→ 外部活跃期打开 = 打开瞬间双写，只读态必须连打开链路的写点一起堵。
> - ②pi 本体/TUI：dist 全树 grep `fs.watch|createFileSystemWatcher|watchFile` 仅 footer-data-provider.js:303/327 的 git head/reftable——**pi 不 watch 会话文件，负结论**：实时跟随无原生能力可搬，是壳职责。
> - ③扩展生态：未检索（施工方若发现现成能力按「插件就是壳」回收并回报，负结论也回报）。
>
> **现状缺口（行号实证）**：
> - 对外命令只有 `piChat.openInEditor`（extension.ts:69，无参=新会话）；`openOrFocusSession`（panel.ts:294）是 static 内部方法，外部调不到；findHolder + pendingSessionFile 双开守卫（panel.ts:299-316）现成可复用。
> - 打开会话 = switchSession + getMessages 一次性快照（piCore.ts:1569-1584 openSessionFile；panel.ts:605-613 同款），全 src 零会话文件 watcher——外部写入停在打开那一刻（验收 A 缺口）。
> - `sessionCache.listNative`（sessionCache.ts:110-111）`list(cwd, undefined)` / `listAll(progress)` sessionDir 恒 undefined=默认库；而 piCore.ts:352-353 起 pi 时把 `piChat.sessionDir` 传 `--session-dir` → 配了自定义目录 = 新会话写配置目录、列表扫默认库，永不可见（验收 D 缺口）。
> - 列表刷新 = 事件 + debounce 2s（sessionsView.ts:34-37）+ memo 3s（sessionCache.ts:53），无文件系统事件源 → 外部新建会话不会自己上列表（验收 C 缺口）。
>
> **施工三刀，每刀独立提交，编译验证点逐刀过**：
>
> **刀1（小，独立可验）：两条命令 + sessionDir 透传**
> 1. extension.ts 注册 `piChat.openSession`：入参 `{file?, name?}`（file 优先；name 兜底扫 listSessions 的 name 字段——SessionInfo.name 来自 session_info 条目，`--name` 会写它），走 openOrFocusSession，**返回 `{ok, reason}`**（未找到 `{ok:false, reason:"not-found"}`；已开则 focus + ok:true）。`openInEditor` 原样保留。
> 2. 注册 `piChat.externalWriting`：入参 `{file?, name?, writing: boolean}`，维护外部持有登记表（按规范化路径 key；name 场景怎么解析成 file 施工定，写进回报）。
> 3. sessionCache.listNative 透传 `piChat.sessionDir`（空回落 undefined=默认库）；**memo key 带 sessionDir**；panel onDidChangeConfiguration 补 `invalidateListMemo()`（现有 handler 在 panel.ts:549，别漏）。
> - **验证点**：`npm run compile` 全绿；REPL executeCommand 验 openSession 四态（file 在/不在 × name 命中/未命中）返回值 + externalWriting 登记/查询。
>
> **刀2（主体，动 core/panel/webview/protocol 四层）：实时跟随 + 只读态 + 交棒**
> 1. 数据面：打开的会话文件增量读（上次 offset 续读，**JSONL 按 \n 分帧铁律**，半行攒到下帧），新协议消息追加上屏（protocol.ts 三处同步）。fs.watch 或轮询 mtime+size 自选；注意 fs.watch 文件级在 inode 变换后失效（pi 自己 footer-data-provider.js:288 注释的坑）、`_rewriteFile` 会换 inode，必须有兜底。**只读新增行，不重载整页**；上翻历史不打断（停底部才自动跟随，与工单17 滚动语义一致）。
> 2. 只读态：外部活跃 = externalWriting 登记命中 **或** 文件 mtime 近 N 秒（启发式兜底，N 默认 10s，施工实测后定写回报）。活跃期：webview 输入禁发 + 明确提示 + 页头「运行中」徽标（P2，**纯增量，不改既有会话页 UI 形态**）；**同时堵打开链路写点**——活跃期打开不跑 reapplyModelMemory 的 setModel/setThinkingLevel（延迟到交棒后补）。
> 3. 交棒：`writing:false` 或 mtime 静默 N 秒 → 重载对齐（switchSession 重进，复用现有恢复链路）→ 解锁输入，此后用户发消息=正常接管。
> - **验证点**：compile 全绿 + **冒烟必须真跑**：终端起 `pi -p --name t1 "<长任务 prompt>"`，运行中 openSession 打开 → 页面随外部写入增长、上翻不打断；活跃期页面发消息被挡有提示；外部结束后解锁能对话（验收 A/B）。
>
> **刀3（小-中）：会话目录 watcher**
> - 外部新建会话 ≤2s 上列表（验收 C/D 一起验）。watch 目录还是轮询施工定，同样注意 inode。
> - **验证点**：compile 全绿；外部新建 ≤2s 出现在列表；配 piChat.sessionDir 后列表只见该目录。
>
> **边界（不许顺手改）**：不动 openInEditor 语义、steering 自愈、4s pendingPrompt 兜底、还原边界（工单七/裁决11）；不改会话 jsonl 格式、pi 包与 vendor 零改动；会话页 UI 形态不变（徽标+只读提示是唯一新增）；webview/main.ts 风格限制已放宽（AGENTS.md 2026-10-29）但存量 var 不顺手迁移；每刀独立提交。
>
> **验收**：需求验收表 A/B/C/D 四行（E 是 ops-panel 侧回归，交接文档保证）+ compile 全绿 + 各刀验证点。**ops-panel 侧配套改动不在本单**，按《交接-ops-panel-外部会话接入.md》由那边执行。回报写 BUILDER.md（直令留痕 ✅活14）。

> 工单十五遗留认知（全录见 归档.md 9.10，2026-09-14 用户实测结单）：mode.json 是
> pi 磁盘全局态，mode 按页签隔离是假需求，勿再立项。

## 攒包小刀（随下一版，可与任意工单顺带，不许混笔）

> 本节暂空：QuickPick 热路径慢观察项已销（2026-09-15 用户确认无复现，账目见 归档.md 七）；
> renderAll 死循环隐患已吸收进工单十八（P0 越序）。
>
> - ~~BUILDER.md 头注释过时~~ **✅ 已销（120e324，2026-09-20）**

## 排队（未签发，勿提前施工）

> 完整清单见 归档.md「八、后续排队」。子 agent 面板视图为潜在产品线项（pi 本体无子 agent，
> 官方 subagent 扩展示例可直装，暂不立项）；多标签并行会话已结（工单15，归档 9.10），非排队项。

- **子 agent 回报时序 UX（2026-09-18 用户实测反馈，产品线打磨项）**：① 迟到回报卡片无
  「迟到交付」标识，与对话先后关系不可辨；② 每条回报独立触发一回合，收工后仍被单个
  「已知悉」回合追尾——扩展侧评估多条回报合并投递（攒批一次交）的可行性；③ 迟到投递
  的根源是 followUp 只能在回合边界投（pi 原生语义，不改，只做可见性补偿）；④ 浮窗历史
  重放：subRunsByTab 是内存账本只吃实时事件，重载即清（消息流从 jsonl 重放、浮窗不翻旧账），
  修法 = 历史重绘时回填，**数据源是 jsonl 里的 subagent-async 自定义 entry 帧（detail 带全量
  messages/startedAt/endedAt，实测持久）**，不是 toolResult.details——后者在异步场景是空壳
  （工具返回瞬间冻结，messages 0、usage 全 0，2026-09-18 实捞验证）；同步调用的
  toolResult.details 才是全量。含头部指示按钮，Codex 同款「完成·N 小时前」列表依赖此项

- **模型报错自动 fork 回退的分支展示（待用户定夺，原事故修复账连带观察迁入）**：回退会在会话
  列表产生分支副本（104→145→151 链，pi 原生 Threaded 展示）——用户困惑「这段会话有两个」。
  是否要在回退 notice 里说明「已另存分支」或在列表标注分支来源，等产品口径。

## 请示裁决（✅活；史条目在 归档.md「六、pi 请示裁决」）

- ✅活 14 **直令修复留痕硬要求**（三犯升格，09-15）：此后一切用户直令修复，提交同时必须在
  BUILDER.md 留痕（一句改动面+一句验证即可），总监验收时无留痕一律记违规并打回补痕——
  这不是文牍主义，是验收对账的唯一入口
- ✅活 15 **工单24 执行偏差裁定（T0 基线冻结，接受，09-18）**：修法原文未指明 live 取
  时刻；T1 取法必双画踩工单十八红线，T0 冻结+基线计数截断使剥离区恰=窗口影响区
  （不重不漏），FIFO 保序逐字满足。同批追认直令工单25/26（7466f9c，✅活 6）。
  **注（09-18 终版追加）：✅活 15 的 T0 剥离口径已被探针实证推翻**——在途消息本就不在
  session.messages，无需剥离；现行为 ✅史，有效口径见 ✅活 16
- ✅活 16 **每页签一棵 DOM 为既定架构 + 快照语义定稿**（09-18 追认用户直令「推翻刀5 切回
  即重拉」，用户实测通过）：切页签=换可见性 O(1) 零重拉，后台页签流式照常累加；**禁止
  退回「单一 root + 切回 postUiState 重拉」设计**（同坑四摔：刀5 丢现场/工单十八×2/
  工单24 丢内容）。快照语义定稿口径：历史=session.messages 零剥离 + live=在途深拷贝
  同步块取 + 窗口内事件丢弃 + 快照后事件消费端延后一拍（pendingStream）。跨页签 UI
  新工单按此对齐

> 机制：pi 请示写在 BUILDER.md → 总监在此裁决 → pi 以此为准执行并从请示区清除。
> 标记：✅活 = 仍约束后续施工；✅史 = 已执行完（存 归档.md）。

- ✅活 2 **PiUnknownEvent 不并入 PiEvent**：`{type: string}` 成员会毒化判别联合的字面量收窄，
  独立接口是正确的 TS 处理——永久 TS 约定，后续消息建型照此办理
- ✅活 4 **未验证的 pi 保证一律保守可选**：跨边界字段不臆测非空（ToolCallStartMsg / args? 先例）
- ✅活 6 **用户直令可越过工单队列**，但需 BUILDER.md 留痕 + 总监追认
- ✅活 7 **scripts/toolDetail.test.mts 不进 tsc 门禁**：tsconfig include src/ 是有意边界
- ✅活 8 **rpc-subprocess 分支保留**：直连版回滚方案，保留至直连稳定一个发布周期再议
- ✅活 9 **git 单写方**：同一工作区同时只允许一个施工方动 git（详见 施工方.md）
- ✅活 11 **还原安全边界**（工单七选型，BUILDER.md 请示 9）：还原只对「工具清单命中」的文件提供；
  git-only 只展示；edit 碰过的未跟踪文件可逆序逆向还原，write 一律不可还原；逆任一步不符即拒打不落盘
  （详见 归档.md 工单七 + AGENTS.md 还原边界）

## 施工守则（要点）

- **开工前重读本文件工单区**——本文件是唯一事实来源，BUILDER.md 请示一旦此处有裁决以裁决为准
- 每张工单独立提交，提交信息写清「改了什么、为什么」；禁止搬运与修 bug 混在一笔
- 改完必须 `npm run compile` 全绿才算完；涉及 webview 行为的改动要构建 vsix 实测
- 事实声明必须可查证——AGENTS.md 里每条不变量都要能逐一 grep 验证
- 铁律继承自 HANDOVER.md：JSONL 只按 \n 分帧；steering 不触发 agent_start（转正靠 queue_update
  队列变短）；message_start 必须 newLive（contentIndex 每条重计）；busy 中严禁整页重绘；
  new_session 会重置模型；sessionMode 回退值必须与 package.json default 一致