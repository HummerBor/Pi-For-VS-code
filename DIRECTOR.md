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
> 最后更新：2026-09-18 验收循环（二）：工单24 实测打回后终版全结——止血刀 3d6a448（快照语义按探针实证重写）+ 架构归位 4530c5d（用户直令推翻刀5，✅活 16 追认），用户实测「非常完美」；版本 0.1.15 随行。全记录迁 归档.md 9.17；待施工 27/28/29 不变，下一单 27。
> 前情：09-18 首轮验收：24 首版代码通过（后被实测证伪，教训入 总监.md 验收方法论 7）、25 直令追认、26 实测通过。0.0.97 已 ship（对账见归档七）。

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

## 工单27：piChat.appendSystemPrompt——面板设置「追加系统提示词」（issue 建议二，无脑版）

> **来源**：issue「一些建议 #1」第二条「可以设置追加系统提示词」，用户拍板做进插件，
> 口径「默认给丫打开」——**不设 enabled 开关**：设置填了内容即生效，空 = 不追加，
> 零认知成本。总监已实测 pi 原生 `.pi/APPEND_SYSTEM.md` 在面板自动生效（0918 探针✓），
> 本单是把同一能力做成 VS Code 设置入口，属于「壳把 pi 原生能力做成无脑桥」，非重复造轮子。

### 选型（总监预查已闭环，施工方勿重查）

- **注入点**：`sdk.createAgentSessionServices({ resourceLoaderOptions: { appendSystemPrompt: [text] } })`。
  `DefaultResourceLoaderOptions.appendSystemPrompt?: string[]` 是 pi 公开选项
  （resource-loader.d.ts:83），与项目/全局 APPEND_SYSTEM.md 文件并列追加，同时生效无冲突
- **生效时机**：services 建会话时装配；AgentSession 无公开中途重建 API
  （`_rebuildSystemPrompt` private，勿碰私有字段）→ **改设置后新开页签生效**，
  进行中会话不动。这是取舍不是缺陷，设置描述里写明即可
- **取数路径**：piCore 经 `this.caps.getConfig("piChat", "appendSystemPrompt", "")` 读
  （hostCapabilities 注入，核心不 import vscode，铁律）→ `client.start` 传给 PiClient

### 施工步骤

1. package.json configuration 加 `piChat.appendSystemPrompt`：string、default ""、
   描述中文（同既有设置风格），写明「追加到 pi 系统提示词，每次对话生效；
   改动后新开页签生效；与 .pi/APPEND_SYSTEM.md 叠加不冲突」
2. piClient.start 增参（cwd, extraArgs, proxyUrl, appendSystemPrompt?: string），
   init() 里非空时给 createAgentSessionServices 传 resourceLoaderOptions；
   注意 createRuntime 闭包在 cwd 切换重建 services 时也要带上（从 startOpts 取，别只算一次丢闭包外）
3. piCore 启动链路（client.start 调用处）读 caps.getConfig 透传
4. i18n：本单纯宿主侧，webview 零改动；无新跨边界消息，protocol 不动

### 边界（不许顺手改）

- 不动提示词逻辑本身、不碰 AgentSession 私有字段（_systemPromptOverride 等是私有，
  走公开 resourceLoaderOptions）
- 不做面板内编辑 UI、不做 /appendSystem 类命令（设置面板是正路，超出即请示）
- 不动 webview/main.ts；不动既有 start 参数映射语义（sessionMode 那套注释契约）

### 验收

- `npm run compile` 全绿；单笔提交
- 总监验：grep 设置声明/透传链三处齐
- 用户实测（主验收）：设置里填一行探针文字（如「回答第一行必须输出：追加提示词生效✓」）
  → 新开页签提问，第一行命中；清空设置 → 新页签恢复正常；与 .pi/APPEND_SYSTEM.md
  同时存在时两条都追加（可选验）

## 工单28：P1 最后一问 sticky 悬浮——滚动出视口时钉在面板顶部（issue 建议三）

> **来源**：issue「一些建议 #1」第三条「用户最后一个问题滚动时，要一直能看见，如果滚动出区域，
> 则悬浮在最上方」。pi 三处查：公开 API 无（agent-session/resource-loader 无 UI 概念）、
> TUI 无此行为、扩展生态无——壳 UI 职责，自研。标杆：Claude 面板同款交互。

### 选型（总监预查已闭环，施工方勿重查）

- 纯 CSS `position: sticky` 可达：最后一条 user bubble 加 sticky class（top:0 + 不透明背景 +
  z-index），滚出顶部时浏览器自动钉住，零 JS 滚动监听
- **只对最后一条 user 消息生效**：新 user 消息到达时把 class 迁移过去；assistant 回复不影响
  （「最后一个问题」语义 = 最后一条 user 消息，不是最后一条消息）
- 现有滚动跟随（工单十七 scroll()）不动：sticky 与 scrollIntoView 正交，跟随照常

### 施工步骤

1. webview/main.ts：addUser 渲染路径加「最后一条 user bubble」class 迁移逻辑
   （新 user 到 → 旧 class 摘除、新 bubble 挂上；renderAll 历史重绘同样只标最后一条）
2. webview/style.css：sticky 样式（top/背景/z-index，气泡上下留白遮挡处理，避免下方内容透出穿帮）
3. main.ts 保持 ES5 var 风格、strict:false 零报错（门禁约定）

### 边界（不许顺手改）

- 不动 piCore/protocol（无新跨边界消息）；不动 scroll 跟随语义（工单十七口径）
- 不动 busy/settled/重绘时序；sticky 只作用于 user bubble，不碰 assistant/tool 行
- 顺手发现浮层遮挡类问题记 BUILDER.md，不混笔

### 验收

- `npm run compile` 全绿；单笔提交
- 用户实测（主验收）：长会话滚动，最后一条提问滚过顶部后钉在面板顶端、不透明无穿帮；
  新提问到达后钉的是新提问；自动滚动跟随行为不变

## 工单29：P2 工具行长输出自动收起——读文件不刷屏，点开看全量（issue 建议四）

> **来源**：issue「一些建议 #1」第四条「读取文件内容太多时，可以收起，只显示部分，用户可以点开」。
> 现状（总监已实查代码）：历史重绘路径已达标（默认收起 + 80 字摘要，main.ts:993）；
> **流式 live 路径是缺口**——toolStart 盒子默认展开（main.ts:634），toolEnd 后 OUT 已截
> 1000 字但盒子保持展开（main.ts:668-675）→ 流式期间读大文件刷屏，即 issue 作者所见之乱。

### 选型（总监预查已闭环，施工方勿重查）

- toolEnd 时 OUT 文本超过阈值（500 字符）→ 盒子自动收起，行上留「已截断，点击展开」提示；
  点击在 预览（前 1000 字）/ 全量（滚动容器，max-height + overflow:auto）间切换
- 全量数据零新增成本：piCore 已全量下发 text（piCore.ts:1643-1650 既有链路），
  webview 侧只是现在只敢显示 1000 字——展开时吐全量即可，protocol/piCore 零改动

### 施工步骤

1. webview/main.ts toolEnd：长 OUT 收起 + 截断提示（i18n 新 key，中英同步，i18n.ts 两处）
2. 点击展开：tb-val 换全量文本进滚动容器（只对展开态生效，收起态保持 1000 字预览）
3. 历史重绘（renderAll/toolGroupRun）不动——settled 后本来就地收起+短摘要，已达 issue 要求

### 边界（不许顺手改）

- 不动 piCore/protocol（toolEnd 载荷形状不变）；不动 toolStart 运行中展开语义
  （运行时显示 IN 参数是既有行为）
- 不动子 agent 监控卡片、edit/write patch 归档链路
- main.ts ES5 var 风格、strict:false 零报错

### 验收

- `npm run compile` 全绿；单笔提交
- 用户实测（主验收）：让模型读一个大文件（>500 字符），流式期间工具行收起不刷屏、
  有截断提示；点开看全量可滚动；收/展可反复切换；小输出（<500 字符）行为与现在一致

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
>
> - **BUILDER.md 头注释过时（09-18 验收发现，一行 docs 小刀）**：头写「不提交进 git
>   （与 DIRECTOR.md 同）」，实际两文件均随 94ff28d 入库、1b9ca69 又提交一笔——pi 顺手
>   把头注释改成「随台账入库」。可随任意工单顺带，纯 docs 独立一笔亦可

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