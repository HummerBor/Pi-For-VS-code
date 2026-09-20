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
> 最后更新：2026-09-20 验收循环（四）：0.1.22 后直令施工组后半场代码验收全过（工单28/29、压缩三笔、per-tab 化、重试去毁伤、0.1.27~0.1.33 工具组合六连刀，逐笔验证命中见下表）；工单28/29 结单迁归档；0.1.33 双画修复用户实测通过、同名合并方案定稿。下一单 30（拆除 appendSystemPrompt）。
> 前情：09-20 验收循环（三）：直令施工账（09-18~09-20 前半场）代码验收全过；工单27 判回收，拆除单 30 已签。

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

## 直令施工账（2026-09-18~09-20，用户同场指挥三期搬迁与事故修复，非工单流程）——代码验收通过（总监 09-20）

> 主验收 = 用户真机实测（0.1.22 装机包，实测点清单见 BUILDER.md 交接 4/5）；实测通过才可全结迁归档。验收证据为 grep+compile+三用例实证（27/34/12 全过，复核于 09-20），非 commit message。

| commit | 内容 | 验证命中 |
| --- | --- | --- |
| 93a96ee | 切会话后页签自选模型被顶掉：补回收口 piCore.applyModelMemory，启动恢复/切历史×2/新建/reload 四条链路统一在 switchSession **之后**调用（✅活 14 留痕✓） | piCore.ts:1148 定义 + 388/1192/1229/panel.ts:813/828 调用点成对✓；旧 fire-and-forget 竞态 IIFE 已删✓ |
| 738ca6e | 二期：#session-area 每页签一棵 .session-view（横幅/消息流/排队/状态行/输入区/页脚全随页签走），切页签=换 display O(1) | main.ts:112 view.className 构造 + index.html:27 原型 + style.css:37 .offview 三处齐✓ |
| 889452b | 停止键/计时复活（镜像落账）+ 标签栏按工作区分桶（piChat.tabBarByWs 治串项目） | diff 复核：setter 写 ctx 字段统一 + 分桶 key 小写cwdKey✓ |
| b59ee4c | 双写者事故：busy 中点历史选到**当前会话**，占用守卫漏盖 busy 分支→同 jsonl 开进第二棵页签。修法：活动标签自持有且 busy → 提示 sessionOpenHere 即收 | panel.ts:790-798 守卫分支结构实证✓；i18n 中英✓（52/467） |
| 897ce40 | 白 Working：busyTicker 闭包写全局镜像 statusEl（漂移写别的页签且无 .busy 类永不清理）。修法：ticker 只写自己视图闭包 statusEl + !streaming 自愈自杀（清自己捕获的 myTimer） | main.ts:278-294 实证：myTimer 自清、注释含事故背景；statusEl 已是工厂闭包局部（119 行，makeSessionView 内）✓ |
| b872eff | 三期整树搬迁：换镜机制（useTab/assignMirrors/saveMirrors/curTabId/bgMode）整体退役，每页签 makeSessionView 工厂闭包（1802→1685 行），routeMsg 缩三行直达，函数体逐字符机械搬运 | 换镜标识符 grep 零残留（仅存事故背景注释）✓；makeSessionView(110)/viewFor(1180) 齐✓；routeMsg 后台 fillInput 拒收保留✓；死代码 busyLabel/subMonUpdate grep 零残留✓ |
| abb482a | 0.1.20 全控件死：机械搬运漏掉「建视图即调 bindViewEvents()」+ root 滚动跟随监听——函数定义合法存在但没人调，编译器查不出。修复+调用点注释留痕 | main.ts:1162 bindViewEvents() 调用✓ 135 定义成对✓；root scroll passive 监听随根走✓ |
| 537de78 | **工单27**（已判回收）：piChat.appendSystemPrompt 设置入口——代码验收通过但产品层面被用户终审否决，拆除单工单30 已签，存档见 归档.md「工单27 回收」 | package.json:102-105 声明✓ / piClient.ts:57,100-103 resourceLoaderOptions 透传✓ / piCore.ts:351-352 caps.getConfig 读值✓（验收证据保留，历史不抹） |
| 120e324 | 攒包小刀：BUILDER.md 头注释纠偏（「不提交进 git」与 94ff28d 入库事实相反） | 一行 docs 独立笔，攒包清单该项销账✓ |

### 直令施工账（二）：09-20 后半场（0.1.23~0.1.33，用户同场指挥，验收循环四）——代码验收通过（总监 09-20）

| commit | 内容 | 验证命中 |
| --- | --- | --- |
| c48e39c | **工单28**：最后一问 sticky 悬浮（issue 建议三），纯 CSS sticky + addUser class 迁移（0.1.23） | addUser stickyQ 迁移逻辑 + style.css .sticky-q（top:-10px 与 padding 同步，注释留痕）✓；**用户实测三项全过（c8c3a27 留痕）** |
| 441f69f | 压缩 toast 跨重渲存续：lastNotice 按存档重挂、发新消息即清（0.1.24） | notice 写 lastNotice + renderAll 重挂点✓；**混笔记档**：fix 混版本 bump（不返工） |
| d6d642b | 压缩完成后定位+高亮折叠块：.compaction 可寻址类 + 居中定位 + 2s 高亮 | main.ts:710 .think.compaction 类✓ |
| 77849c3 | 压缩浮动条替代自动跳顶（用户拍板交互）：compactBarShownAt 防重弹 + 「查看压缩」定位 | main.ts:682/820-833 条逻辑✓；首渲立基线（恢复旧会话不弹条）✓ |
| 062cb3c | 改动追踪 per-tab 化：changesFiles/Detail/Dismissed/runStartStatusP/lastStateFile 按 tabId 隔离 | panel.ts:71-77 五字段入 per-tab state✓ |
| 014e838 | **工单29**扩权四项（用户直令）：完成即收 / 长 OUT 截断全量 / 思考块限高 / 连续同名成组（0.1.27） | toolEnd 完成即收 + ref.full 只持引用首展才落 DOM✓；.think-body max-height 240px（style.css:107）✓；i18n toolTruncated 中英✓ |
| f900f2c / 91d0e18 / ebc105a | sticky 限两行→0.1.30 pinned/3 行/chip 重设计；空占位 bubble 移除（穿帮+断组同根因） | pinned IO + data-st chip + _fullH 量一次✓；toolStart 空壳移除（零文字无 img 才删）注释留痕✓ |
| bf28a8b | 0.1.31 跨消息合组根因修（探针实锤：pi 每 toolCall 一条独立 assistant 消息） | probe-toolblocks.mjs 留档✓（方案后经 0.1.32 收敛） |
| 094fc84 | **0.1.32 定稿**：0.1.30/31「不分名大折叠块」被用户实测否掉，回归 0.1.29 同名连续合并，留跨消息根因修复 | 组容器标识符（toolGroup/tool-grp/crossRun/endToolGroup/makeToolGroupShell）grep 三文件**零残留**✓；lastToolGroup 同名合并 + t-count ×N 在位✓ |
| 468cd0f | 0.1.33 双画修复：renderAll 旧 think/text 段没删净（0.1.32 多刀 edit 残留，语法合法编译器不报） | makeThink 渲染点 grep=1（1 定义+1 调用）✓；**用户实测通过（fd143fb 留痕，同名合并方案定稿）** |
| 8b495d8 | 思考块两修：贴底才滚（atBottom 容差 30px）+ finalizeLive 收 thinking 时自折 | 在位（0.1.29）✓ |
| 11a6a77 | 错误重试去毁伤：修改后重试不再 fork 回退（用户拍板） | 3 文件小刀独立笔✓ |

**决策链记档（工具组合 UI）**：0.1.30/31 大折叠块方案被用户实测否掉（丑/没状态/整复杂了），
0.1.32 回归同名连续合并为定稿——最终口径以 0.1.32+0.1.33 为准，决策过程留 BUILDER。
**教训（0.1.33，与 bindViewEvents「合法存在但没人调」同族）**：多刀 edit 改 renderAll 这类
长 else-if 链，收尾必须渲染点计数对账，compile 查不出逻辑重复。

**混笔记档（不返工，既定口径）**：897ce40/441f69f fix 提交混入版本号 bump（package.json+lock）；1d0fe28/da3199e 版本号入库随「package 自动 bump」机制，合规。

**三期搬迁账（记档）**：0.1.20 装机包实为坏包（壳胶水漏调用），用户实测抓出——「合法存在但没人调」类缺陷第二次入账（bindViewEvents 先例，AGENTS.md 大文件改造条已收），机械搬迁的验收清单必须逐项核对「定义与调用点成对」。

## 施工工单（按序执行）

> ⚠️ **状态标记约定**（用户三次纠偏后钉死）：结单工单**全文迁 归档.md，DIRECTOR.md 零残留**——
> 不留指针行、不留 ✅ 标题、不留「待实测」尾巴；判死单同样原样迁归档（工单八/22 先例）。
> 工单区只存在待施工项。已完成与否以 归档.md 为准，勿信 commit message。
> 做新单前若与旧单边界相关先查归档，勿凭记忆执行旧单条目。
> **工单号一律阿拉伯数字**（工单23 起，用户拍板 2026-09-15；存量编号不改）

> 工单十五遗留认知（全录见 归档.md 9.10，2026-09-14 用户实测结单）：mode.json 是
> pi 磁盘全局态，mode 按页签隔离是假需求，勿再立项。

## 工单30：回收工单27——拆除 piChat.appendSystemPrompt 设置入口（纯拆除小刀，可插队于 28 前）

> **回收依据**：用户 2026-09-20 终审「完全没必要」。总监实证 pi 系统提示词四层结构
> （system-prompt.js:90 + resource-loader.js:809）：①内置基底 ②APPEND_SYSTEM.md 追加层
> ③AGENTS.md 项目上下文层 ④SYSTEM.md 整体替换层——用户想加规矩，pi 原生入口一条不缺，
> 工单27 只是给②加了个体面设置框，认知负担 > 增益，回收。工单27 全文存 归档.md。

### 施工步骤（逐处对应 537de78 反向拆除）

1. package.json：删 `piChat.appendSystemPrompt` 设置声明（原 102-105 行）
2. src/piClient.ts：删 start 第 4 参 appendSystemPrompt、startOpts 里对应字段、
   init() 里 resourceLoaderOptions 注入及工单27 注释
3. src/piCore.ts：删 ensureClient 里 getConfig 读值与透传（原 351-352 行）
4. 版本号随 package 自动 bump，不手改

### 边界（不许顺手改）

- 只拆上列三处；pi 原生 APPEND_SYSTEM.md 发现逻辑本来就没碰过，确认没误伤即可
- 不动 start 其余参数映射（sessionMode 注释契约）、不碰 webview/protocol/i18n
- 回报按直令规格在 BUILDER.md 留痕

### 验收

- `npm run compile` 全绿；`grep -ri appendSystemPrompt src/ package.json` **零命中**；单笔提交
- 行为对账：默认空 = 无操作，拆除后行为与 0.1.21 完全一致（无设置过渡期风险）

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