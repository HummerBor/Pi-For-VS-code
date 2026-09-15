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
> 最后更新：2026-09-15 事故修复三笔验收通过（压缩标签/版本号自证/preflight 透传，见文末账）；
> 工单二十/二十一仍待装包实测项：二十一的折叠块（恢复 aaaxcx）未报

## 施工工单（按序执行）

> ⚠️ **状态标记约定**：标题带「✅ 已完成已验收」的工单**禁止重复执行**；
> pi 只施工不带 ✅ 的工单。完成与否以本文件 + 归档.md 验收记录为准，勿信 commit message。
> 已完成工单全文（验收标准/边界/教训）见 [归档.md](归档.md)——做新单前若与其边界
> 相关先查归档，勿凭记忆执行旧单条目。

> 工单十五遗留认知（全录见 归档.md 9.10，2026-09-14 用户实测结单）：mode.json 是
> pi 磁盘全局态，mode 按页签隔离是假需求，勿再立项。

### 工单二十：vsix 去注释瘦身（2026-09-15 用户直令）——代码验收通过（总监 09-15），待装包实测后结单

> **总监验收（2026-09-15）**：compile 全绿复跑 ✓；最新构建 12 个产物文件（out/*.js +
> dist/webview/main.js）grep 注释关键词（工单/steering 自愈/兜底）全零命中 ✓；minify:true
> 选型依据成立（esbuild 确无「只去注释不压缩」独立开关，legalComments 只管 legal 类）✓；
> 无混笔 ✓。剩余：用户本地装包过一遍面板行为（发消息/中断/steering/历史/还原）。

**背景**（0.0.93 实测解包留证）：tsconfig.json 未开 `removeComments`，out/*.js 携带全部
源码注释随包分发（piCore.js 84KB / panel.js 99KB，注释占大头，含事故教训与内部路径）；
vite 构建产物 dist/webview/main.js 因 `minify: false` 保留 `//#region` 等注释。源码注释
是资产（注释文化），但编译产物不随包携带。

**改动**：
1. tsconfig.json 加 `"removeComments": true`
2. vite.config.mts：webview 构建去注释。手段授权施工方自选（开 minify 或等效 esbuild
   去注释配置均可），选型结果与依据写进回报；`minify: false` 无注释说明其存在理由，
   若保留需给出理由

**边界**：README_EN.md 按用户裁决（2026-09-15）保留，本工单不动任何文档排除项；
源码注释一律不动。

**验收**：`npm run compile` 全绿 → `npm run package` 打测试包 → 解包 vsix，
out/*.js 与 dist/webview/main.js 中 grep 不到源码注释关键词
（如「工单十六」「steering 自愈」「兜底」）；面板装包实测行为正常（本地 vsix 手动装）。

### 工单二十一：压缩边界可见化——compactionSummary 消息渲染（2026-09-15 用户直令）——代码验收通过（总监 09-15），待用户实测后结单

> **总监验收（2026-09-15）**：compile 全绿 + test:detail 27/27 + test:revert 12/12 复跑 ✓；
> makeCompaction 复刻 makeThink 的 details/summary 折叠、样式走 .think token、ES5 var
> 风格保持（函数体 grep 3 处 var 零 let/const）✓；i18n 中英双语各一份、不硬编码 ✓；
> 协议零改动（stat 仅 i18n.ts+webview/main.ts）✓；字段实证：aaaxcx jsonl 内
> tokensBefore:157889 坐实 ✓；产物含 makeCompaction ✓。剩余：用户装包恢复 aaaxcx
> 会话实测折叠块 + /compact 触发场景。

**背景**（2026-09-14 aaaxcx 会话实测，用户报告「历史里只看到一条继续」）：该会话 11:17
触发过 pi 自动压缩（threshold：glm-5.3-flash 窗口 128k − reserve 16384，估算 157,889 超
阈值），并非消息丢失——jsonl 全量在盘。恢复会话时 pi 按压缩感知重建上下文
（session-manager.js buildContextEntries）：压缩点之前的消息被折叠为一条
`{role:"compactionSummary", summary, tokensBefore, timestamp}` 消息，保留窗之外的用户
消息全部以摘要代替。壳的 webview 渲染循环（main.ts renderAll）只处理 user/assistant/
bashExecution 三种 role，compactionSummary 静默穿落 → 压缩边界在 UI 里完全不可见，
用户视角就是「以前发的消息没了」，且横幅（工单六）只在压缩当下显示一次，重开后无迹。

**pi 原生查重**（工单签发前置查，三处）：pi TUI 原生把 compactionSummary 渲染为可见的
可折叠组件（interactive-mode.js:2934 CompactionSummaryMessageComponent，默认随全局
展开态）。结论：壳应对齐 pi 原生行为渲染该消息，**不是新造能力，也不读原始 jsonl
自建「完整历史」入口**（TUI 没有的不要加，范围锁死）。

**改动**：
1. webview/main.ts renderAll 循环补 `role === 'compactionSummary'` 分支：渲染为一条
   折叠块，收起态文案含 tokensBefore（如「⌄ 上下文已压缩，此前历史已折叠为摘要
   （原 {n} tokens）」），点击展开用 renderRich 渲染 m.summary（markdown）；复用
   makeThink 的折叠交互模式即可，样式走现有 token
2. 文案进 i18n.ts（中英两份），不硬编码
3. 协议零改动：render 消息本就携带全量消息对象快照，compactionSummary 一直在管道里，
   只是渲染端丢弃——不新增跨边界消息，protocol.ts 不动

**边界**：工单六的压缩横幅保留不合并（横幅管「当下发生」，折叠块管「边界在哪」，职责
不同）；webview/main.ts 保持 ES5 var 风格、strict:false 下 tsc 零报错；不碰
patchRevert/steering 自愈等守卫；不读 jsonl、不加「查看完整历史」功能。

**验收**：`npm run compile` 全绿 → 恢复 aaaxcx 那个会话
（sessions/--d--work-docs-aaaxcx--/2026-09-14T08-42-30…jsonl），压缩边界处出现折叠块，
展开可见摘要正文，其前的用户消息仍按 pi 语义不显示（折叠块即边界声明）；新开对话发
长任务触发手动 /compact 后，settled 重绘同样出现折叠块，横幅照旧；
`npm run test:detail` `npm run test:revert` 不回归。

### ~~工单二十二：流式平滑~~ ❌判死（2026-09-15 用户受控实验否决，未开工即废）

> **判死过程存档**：签单时实证链五条——实测三条（短上下文 SSE 细粒度/piCore 即时转发/
> scheduleStream 死代码）+ 推断两条（postMessage 合批每帧一跳/DOM layout 成本随会话涨）。
> **推断全灭**：用户把同一长会话切到终端 TUI，同样蹦段（2×2 受控实验：面板长会话蹦/
> 面板短会话顺/TUI 短会话逐字/**TUI 长会话蹦**）——翻转行为的变量是上下文长度，与客户端
> 无关。真因：**长上下文下智谱侧生成/传输本身突发**（短上下文 SSE 细粒度是实测，但测错了
> 档位就外推了）。壳无罪，drain 治不了 TUI 也有的病，且壳自研平滑=造 TUI 没有的东西
> （违铁律）。**教训入库总监.md：签单前实验必须覆盖出问题的那档条件；机制推断未实测
> 不得签单**。本工单全文保留于此仅作教训载体，禁止施工。

**现象**：同模型（glm-5.3）pi TUI 里慢速快速都逐字流出，插件里一段一段蹦。

**总监实证链（2026-09-15，签单前置查，施工方勿重查）**：
1. **provider 不背锅**：直打智谱 coding 端点（scripts/test-glm-stream.mjs，留存备诊断），
   glm-5.3 流式 55 块全是 1~2 字（均值 1.5），块间隔 0ms——SSE 细粒度；首 token 等
   4.9s（reasoning 阶段），之后 80 字 1.2s 倾泻。DS 慢所以逐 delta 逐帧≈逐字观感；
   GLM 快所以同一机制下每帧积压多字 → 观感差异根源
2. **piCore 不背锅**：message_update 分支每条 delta 即时 post（piCore.ts:1309 起，
   text_delta→delta 无节流）
3. **webview 病灶坐实**：appendDelta（main.ts:524）每条 delta **立即** streamTick+
   scroll——TUI requestRender 同样每事件直渲但终端逐笔 write 所以逐字；webview 的
   postMessage 传输本身有合批（burst 到达的 N 条 delta 同一事件循turn处理完，浏览器
   一帧只画一次）→ GLM burst（实测 gap 178ms 后连发多块）每帧一跳 = 「一段一段」
4. **死代码佐证**：scheduleStream（main.ts:521，100ms 节流 timer）定义了但**全文件零调用**
   ——历史上有人预感到要节流，接线从未发生
5. **会话体量是主因（2026-09-15 用户观察补充修订，总监漏判后补）**：用户实测「只有这个
   会话蹦，别的会话正常，之前一直不卡」——每条 delta 的 scroll() scrollTop 写强制 layout，
   **成本随会话 DOM 树增长**：本会话 jsonl 已 477KB+（数百条消息/上万节点），单次 layout
   毫秒级 → GLM burst 一到就积压；新/短会话 layout 便宜 → 看着正常；TUI 只画视口、
   成本与会话长度无关 → 恒逐字。「越来越卡」是随会话进度，非随版本（今日四笔提交
   均不碰 delta 路径，总监已逐笔核对）
5. **pi 原生查重（三处）**：TUI render 链实查（interactive-mode.js:2799 requestRender
   每事件直调 + tui bundle doRender 同步写终端），**无打字机/无帧平滑层**——壳做平滑
   不是重复 pi 原生，是补偿 webview 传输合批，理由成立

**改动**（仅 webview/main.ts，协议零改动）：
1. text delta 改攒批 drain：appendDelta 只入 buffer（p.buf += t）+ 调度 drain（rAF 或
   ≤33ms timer，选型理由写回报）；drain 每 tick 用现有 streamTick 逻辑从 doneLen 起渲
   预算内字符——预算自适应（如 max(2, ceil(待渲字数/8))）：慢速 DS 每 tick 1~2 字＝
   逐字观感，快速 GLM 也能在数十 ms 内追平不滞留
2. scheduleStream 死代码回收：改造为 drain 调度器或删除（删除则注释留痕「曾为未接线的
   100ms 节流」），别留死代码
3. **收尾必须 flush**：message_end/settled/newLive/applyLiveSync 重定基时把未渲 buffer
   全量渲完或丢弃（重定基丢弃，结束渲完）——别让最后一截字卡在 buffer 里
4. thinking delta（appendThink）同病灶但本单**不动**（范围锁死；若实测思考块也明显蹦
   段再签补刀）

**边界**：不碰 scroll/工单十七 suppressScroll（drain 的 scroll() 调用点照旧走 scroll()）；
不碰 busy 禁整页重绘红线；ES5 var 风格、strict:false 零报错；不碰 piCore/协议；
markdown fence 语义（streamTick 的代码块边界逻辑）零改动——drain 只是改「何时调用它」
不改「它怎么算」。

**验收**：npm run compile 全绿 → 装包实测：①glm-5.3 快速生成观感连续（不再一段一段），
收尾无缺字 ②DS 慢速回归无退化 ③**长会话实测（主验收场）**：本工作区长会话
（jsonl 数百 KB 级）流式观感连续 ④流式中上滑/回底（工单十七现场）不复发 ⑤流式不卡顿
（工单十九现场不复发——drain 每帧 DOM 写次数应≤现状）⑥toolDetail/patchRevert 不回归。

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

> renderAll 死循环隐患已吸收进工单十八（P0 越序），本节销账。

> **观察项（2026-09-15 用户实测报告，待排查）**：当前会话已加载，历史会话 QuickPick
> 仍显示「正在加载会话…」要等一段时间才能打开——会话清单疑似没复用已加载状态或每次
> 全量重扫。工单十三做过 mtime 缓存（panel.ts 模块级 Map），按理冷启动后才慢——本现象
> 是热路径仍慢，先记档，十八/十七结单后排查。

## 排队（未签发，勿提前施工）

> 完整清单见 归档.md「八、后续排队」。大盘子：**多标签并行会话已提签为工单十五**
> （2026-09-11 用户拍板）；子 agent 面板视图为潜在产品线项（pi 本体无子 agent，
> 官方 subagent 扩展示例可直装，暂不立项）。

## 请示裁决（✅活；史条目在 归档.md「六、pi 请示裁决」）

- ✅活 12（09-14 裁决 BUILDER 请示）：**工单十五留主力会话施工**——小模型会话自请不接
  （判断正确，追认）；攒包小刀（README 残留+importSession 上移）小模型可做。开工十五前
  用户需先指定主力会话
- ✅活 13（09-15 追认，两笔回归修复）：①**9594ba7**（十八回归：切页签整段内容×2）——
  stripLive 与 live 下发绑定为原子，机制成立：liveMessage 自 message_start 起就在快照里，
  尾部 toolResult 窗口期不剥则 live 与历史重复，不带 live 后 renderAll 已画全量；
  ②**819a883**（十九回归终版：流式卡顿）——程序化滚动零布局读，优于两版被 revert 的 rAF
  方案（读写交错 layout thrashing）。两笔均待用户实测后随结单迁归档。**流程记档：两笔均无
  BUILDER.md 留痕，违反 ✅活 6「直令需 BUILDER 留痕 + 总监追认」——直令修回归同样须留痕，
  勿三犯**。已知取舍（记录不立项）：suppressScroll 在「已在底时程序化拉底不触发 scroll
  事件」下残留 true，用户首次上滑事件被吞一次（低频：流式中拉底多伴内容增长；若实测
  出现「上滑要滚两次」再立项）
- ✅活 14（09-15 追认，**留痕违规已三犯，升格硬要求**）：892ccbf（关文件后代码上下文胶囊
  滞留）——onDidChangeVisibleTextEditors 监听 + activeTextEditor 可见性守卫，机制成立：
  焦点落非编辑器视图时 activeTextEditor 滞留为已关编辑器且 change 事件不触发，关 tab 必触发
  visibleTextEditors 变化，不在可见列表即清上下文；复用 selTimer 防抖无新定时器；
  守卫修复「下条消息静默附已关文件」的正确性风险，批准。**硬要求（三犯生效）：此后一切
  用户直令修复，提交同时必须在 BUILDER.md 留痕（一句改动面+一句验证即可），总监验收时
  无留痕一律记违规并打回补痕——这不是文牍主义，是验收对账的唯一入口**

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