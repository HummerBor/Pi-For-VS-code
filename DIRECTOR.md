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
> 最后更新：2026-09-18 **签工单25/26**（子 agent 监控实测双缺陷：幽灵行第二轮 + 排队回报不可见）。
> 前情：工单24 签发中（P0 切页签丢渲染）；工单23 判死迁归档。0.0.97 已 ship（对账见归档七）。

## 发版前终验（总监 2026-09-16，0.0.93 后 30 commit 全量 review）——✅ 放行 ship

- **compile 全链门禁**：typecheck:webview 零报错（无 @ts-nocheck）→ vite → tsc 全绿
- **四笔 fix 逐一 grep 实证**：a872a02（protocol/webview/piCore 三处 compaction 同步✓）、
  df86ec1（piClient preflightOk 透传真因✓）、0b077e6（compaction_end 改 postUiState 整体重拉✓，
  教训注释随逻辑走✓）、20c8947（package 自动 bump ✓）；回归修复 819a883 suppressScroll
  零布局读✓、9594ba7 原子绑定✓；287bb04 双产物去注释（tsconfig removeComments + vite minify）✓
- **vsix 边界**：.vscodeignore 覆盖 scripts/**（含工单二十二实验脚本）与全部内部文档✓
- **混笔记档（不返工）**：0b077e6 fix 提交混入版本号 bump（0.0.93→0.0.95 测试消耗）+
  BUILDER.md 留痕——bump 按既定口径记档；BUILDER 留痕系 ✅活14 硬要求，合规
- **随版内容**：事故修复四笔 + 工单二十/二十一 + 十八/十九回归终版 + README 重写。
  下一版 0.0.96（ship 自动 bump）

## 施工工单（按序执行）

> ⚠️ **状态标记约定**（用户三次纠偏后钉死）：结单工单**全文迁 归档.md，DIRECTOR.md 零残留**——
> 不留指针行、不留 ✅ 标题、不留「待实测」尾巴；判死单同样原样迁归档（工单八/22 先例）。
> 工单区只存在待施工项。已完成与否以 归档.md 为准，勿信 commit message。
> 做新单前若与旧单边界相关先查归档，勿凭记忆执行旧单条目。
> **工单号一律阿拉伯数字**（工单23 起，用户拍板 2026-09-15；存量编号不改）

> 工单十五遗留认知（全录见 归档.md 9.10，2026-09-14 用户实测结单）：mode.json 是
> pi 磁盘全局态，mode 按页签隔离是假需求，勿再立项。

## 工单24：P0 切页签丢渲染内容——快照期流式事件被冲且永不重发（宿主侧保序回放修复）

> **症状（用户 2026-09-17 实测报）**：切页签后面板渲染丢内容，切走再切回/看真会话
> （jsonl）内容完好——丢的是渲染层，不是数据。截图特征：在途 assistant 消息的
> thinking 块句子截断、正文出现空黑条，截断处正是切页签瞬间正在生成的段落。

### 根因（总监预查已闭环，施工方勿重查，直接按此修）

1. 切页签 → panel.handleTabSwitch 置 activeTabId → 新活动 core 调 postUiState()
2. **postUiState 是 async**（piCore.ts:387）：`await getMessages()` +
   `await collectState()` 两跳异步——这就是快照窗口（几十~几百 ms）
3. 窗口内，该 core 的流式事件**绕过快照直接 this.post**（piCore.ts:1324-1331
   message_update 分支：delta/thinking/toolCallStart/toolCallDelta），经
   panel.pipeFromCore（活动页签直通）立即喂到 webview
4. webview 先画了这些 delta（liveBlock/appendDelta 作用于刚 liveReset 的空现场）；
   随后 uiState（快照@T1）抵达 → renderAll(快照) + applyLiveSync(live@T1) 把窗口内
   已画的 delta **全部冲掉**（webview/main.ts:1107-1114 → flushRender）
5. delta 是增量事件，pi 侧永不重发 → **窗口内生成的内容永久丢失**；jsonl 在 pi 侧
   完好 → 与症状完全吻合（空黑条 = 窗口内起的 text 块被冲剩空壳）

> **认知沉淀**：工单十八修的是同一竞态的另一面（双画：剥 live 与下发原子化），
> 但「窗口期事件被快照冲掉且不重发」这面当时没修——双画和丢失是同一竞态的两面，
> 当时只按用户实测到的那面修。本轮补齐。

### 修法（单点，保序回放）

piCore.ts 加**快照期事件闸门**：postUiState 入口（两跳 await 之前）置缓冲态，
活动 core 的流式事件改为入队不直发；uiState 发出后解除缓冲、**按原序重放**队列。
要点：
- 闸门盖住 webview 消费的全部流式事件类型（newLive/delta/thinking/toolStart/
  toolCallStart/toolCallDelta/message_update 派生事件/busy/settled 等）——最稳做法
  是在 core 的 post 出口统一分流（uiState 本身与 notice 等非流式消息不缓冲），
  别在 1324-1331 逐个 case 打补丁（漏一类就是新事故）
- 重放保序 = settled 真相重绘自愈语义不变（若窗口内会话恰好结束，重放的 settled
  在快照之后执行，全量重绘自愈，不会退回旧快照）
- webviewReady 触发的 postUiState（piCore.ts:443）同闸门覆盖——重建窗口同款竞态
- 缓冲上限不设也行（窗口内事件量有限），但队列必须是 FIFO 数组，不得去重合并
  （去重 = 重新发明增量协议，必错）

### 施工与验收

- 先实证再修：回报里贴出窗口期事件被冲的证据（在 postUiState 两跳 await 前后
  打时间戳日志 + 窗口内捕获到的 delta 事件列表，一处 dbg 日志即可，修完可留）
- `npm run compile` 全绿；`npm run test:detail` / `test:revert` 全绿
- 回归红线：工单十八「切页签整段内容×2」不复发（保序回放下快照先画、事件后补，
  不产生重放）
- 用户实测（主验收场）：快流式模型（glm-5.3）生成中连切页签≥10 次，来回切、
  切走再切回，面板内容与 jsonl 对账无缺；空黑条不复发
- 单笔提交，提交信息写清根因

## 工单25：P1 异步壳行幽灵第二轮——end 收到伪装成最终结果的 running 快照，closed 握手条件失效

> **症状（用户 2026-09-18 面板实测）**：异步派 2 个子 agent，跑完后「已开启」组各留一条永转
> 「处理中」（1m34s+），与「完成」组同任务双行并存。0.0.118 已含第一轮幽灵修复（5f1d32a
> subagentEndedCalls 终结账）仍复发——修的条件就不对。

### 根因（总监预查已闭环，施工方勿重查）

1. subagent 扩展 index.ts:909：异步派发的**工具返回值自带** `details: asyncDetails(run)`——
   形状兼容 SubagentDetails（注释原话“面板 subagentSnapshot() 直接可吃”），任务状态 running
2. piCore tool_execution_end 的 subagent 分支：closed 分支条件是 `finalSnap == null`——
   异步返回的 finalSnap **非空**（running 快照）→ 走“正常收尾”分支，post final:true + running
   任务 → webview 行永不收尾（final 行无删除路径）
3. 完成组行来自 entry_appended 帧（句柄 sa-n 键），toolCallId 行来自 end 的 running 快照
   → 同任务双行，与截图完全吻合
4. 教训：5f1d32a 修的是「end 后无收尾」，真因是「end 时收到的 details 就是 running 的」——
   对报修现象的归因停在机制第一层，没验证异步返回值载荷形状

### 修法（单点）

piCore tool_execution_end subagent 分支：`finalSnap.tasks` 任一 `status === "running"` →
判定为异步壳 → 发 `closed: true` 删行（沿用 5f1d32a 协议，webview 已支持）；否则走既有
final 分支。同步调用 end 时不可能有 running 任务，零回归；subagentEndedCalls 终结账保留。

### 边界（不许顺手改）

- 不动扩展（用户侧安装件，.pi/agents 域）；不动 subagentSnapshot 状态判定口径
  （stopReason/toolCall 中间态判定是 0.111 事故沉淀，见该文件头注释）
- 不动概览/下钻渲染；不动队列相关代码（那是工单26）

### 验收

- `npm run compile` + 三个脚本用例全绿
- 用户实测（主验收）：异步派 2 任务 → 跑完后「已开启」清空、每任务恰一行于「完成」组；
  同步 subagent 调用快照行照常出现并正常收尾（回归点）
- 单笔提交

## 工单26：P2 排队回报不可见——“AI 自主感”信息差

> **现象（用户 2026-09-18 实测）**：主会话忙时多个子 agent 回报排队，状态栏“排队 3 条”
> 但面板无处可见是啥在排；回报触发的新回合起点不可见（用户见“两个思考中间什么都没有，
> 然后莫名其妙多出第二个思考”）。

### 背景预查（总监已做，施工方从第二步接着查）

- piCore `this.queued` 只记**用户经面板排队**的消息（queuedAdd 两处：直发排队/对账重建）；
- 扩展 followUp 回报走 **pi 原生队列**，不进 this.queued → queuebar 无它；
- 状态栏计数来自 pi 原生队列信息 → 计数有、内容无，即信息差本体。

### 施工步骤

1. **先实证**（勿跳过）：主会话忙时手动触发一条 followUp 排队，dbg 日志抓 piClient 侧
   queue_update/队列事件帧，确认队尾消息文本是否可辨认（含“[子 agent sa-N”前缀即可命中）
2. 可辨认 → queuebar 对这类排队项渲染专用样式「⮑ 子 agent 回报（排队中）」（i18n 两语同步）
3. 不可辨认 → 负结论记档入 BUILDER.md，本单降级：仅在回报卡片交付时在其头部补
   「（由排队回报触发）」标注（i18n 同步），工单随后可结

### 边界与验收

- 不动扩展投递机制（followUp 语义是 0.0.113 实测沉淀）；单笔提交
- 验收：主会话忙时排队回报在面板有可见踪迹（queuebar 或交付标注二选一，按实证结果）；
  compile + 用例全绿

### 不许顺手改的边界

- 剥 live 原子性（刀5b/工单十八口径）、stripLive 条件、tabId 丢弃逻辑一个不动
- 不动 webview/main.ts（修复完全住宿主侧）；若实证后发现必须动 webview，先请示
- 不动 panel.pipeFromCore 的后台不喂语义；不动 getMessages/collectState 的拉取方式
- 顺手发现的其他疑似竞态记 BUILDER.md，不混笔

## 事故修复账（2026-09-15，用户同场指挥下修复，非工单流程）——代码验收通过（总监 09-15）

> 三笔均为当日本会话修复，验收证据为 grep+compile 实证（非 commit message）：
>
> | commit | 修什么 | 验证命中 |
> | --- | --- | --- |
> | a872a02 | 压缩中标签一等状态化（CompactingMsg 三处同步 + busy:false 不清标签 + uiState 快照恢复） | protocol ×3 / piCore ×8 / panel ×2 / webview ×12；用户实测：压缩期间标签持续可见、切会话后仍显（0915 截图）✓ |
> | 20c8947 | package 自动 bump patch——同版本号覆盖打包致装旧包无法自证（事故：旧 0.0.93 vsix 被覆盖，用户测了数小时旧代码） | package.json:125 ✓ AGENTS.md 命令表已修订 ✓；0.0.94 装包自证可行 |
> | df86ec1 | preflight 拒收透传真实原因（ok=false 等 session.prompt rejection，不再吞成通用文案；压缩中拒收给友好映射） | piClient preflightOk ✓ / i18n 中英 ✓ / piCore 映射 ✓；steer 自愈正则仍命中真错误原文（already processing/streamingBehavior）✓；用户实测：压缩中拒收显示「上下文压缩进行中，等它结束再发」（0915 截图）✓ |
>
> **同场定位结论（留证）**：`Provider finish_reason: error` = OpenRouter 服务端上游故障
> （pi-ai mapStopReason 对 SSE finish_reason:"error" 的直译），TUI 不经插件也报同错——
> 插件无责；多会话同时报错是共享上游的相关性，会话间零因果（独立进程/连接）。
>
> **连带观察（待用户定夺，未签发）**：模型报错自动 fork 回退会在会话列表产生分支副本
> （104→145→151 链，pi 原生 Threaded 展示）——用户困惑「这段会话有两个」。是否要在
> 回退 notice 里说明「已另存分支」或在列表标注分支来源，等产品口径。

## 攒包小刀（随下一版，可与任意工单顺带，不许混笔）

> 本节暂空：QuickPick 热路径慢观察项已销（2026-09-15 用户确认无复现，账目见 归档.md 七）；
> renderAll 死循环隐患已吸收进工单十八（P0 越序）。

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

## 请示裁决（✅活；史条目在 归档.md「六、pi 请示裁决」）

- ✅活 14 **直令修复留痕硬要求**（三犯升格，09-15）：此后一切用户直令修复，提交同时必须在
  BUILDER.md 留痕（一句改动面+一句验证即可），总监验收时无留痕一律记违规并打回补痕——
  这不是文牍主义，是验收对账的唯一入口

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