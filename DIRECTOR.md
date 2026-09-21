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
> 最后更新：2026-09-20 验收循环（五）：工单30 拆除验收通过结单（grep 零命中/compile 绿/逐 hunk 归属干净/原生 APPEND_SYSTEM.md 未误伤，纯拆除无实测项）；工单27 回收全链路闭环。**工单区已空**，下一单待签（候选见归档「八、后续排队」）。
> 前情：09-20 验收循环（四）：直令施工组后半场代码验收全过（工单28/29、压缩三笔、per-tab 化、重试去毁伤、0.1.27~0.1.33 工具组合六连刀）；工单28/29 结单迁归档，0.1.33 同名合并定稿。

## 施工工单（待施工）

> ⚠️ **状态标记约定**（用户三次纠偏后钉死）：结单工单**全文迁 归档.md，DIRECTOR.md 零残留**——
> 不留指针行、不留 ✅ 标题、不留「待实测」尾巴；判死单同样原样迁归档（工单八/22 先例）。
> 工单区只存在待施工项。已完成与否以 归档.md 为准，勿信 commit message。
> 做新单前若与旧单边界相关先查归档，勿凭记忆执行旧单条目。
> **工单号一律阿拉伯数字**（工单23 起，用户拍板 2026-09-15；存量编号不改）

> **当前无待施工工单**（工单31 已签，见下）。归档「八、后续排队」其余候选另行签发。

## 工单31：用户消息图片缩略图 + 点击放大（原图走 VS Code 内置预览）

> **来源**：用户 2026-09-21 原话「想让我发的图片都能展示出来，以缩率图或者缩小尺寸
> 不变比例的形式展示出来 还能点击放大看原图」。总监调查（本轮会话，用户「先调查」直令）
> + 方案推荐后用户拍板「好的」。
>
> **pi 三处查（总监已实测闭环，施工方勿重查）**：①公开 API——pi-ai `ImageContent`
> `{type:"image", data, mimeType}`，user 消息 content 数组结构化存图，**会话 jsonl 全量落盘
> 原图 base64**（实测 `--D--work-docs-pi test--` 会话 8 张图全量在盘，无裁剪）；②TUI 无图形
> 显示能力（终端）；③扩展生态无。**结论：数据层零造轮子（用 jsonl 现成数据，存储/格式零
> 改动）；显示层 pi 无能力，壳自研缩略图属 pi 留给壳的职责；放大不造 lightbox，借 VS Code
> 内置图片预览器（panel.ts:1030-1037 图片分支 vscode.open 已在，preview 模式自带缩放/原尺寸）**。
>
> **现状缺口（调查实证）**：图片数据已随 render 消息全量到 webview（getMessages→snapshot
> 深拷贝原样带图）但被 `textOf()` 扔掉（main.ts:653 只拼 text 项）；当场发送只显
> 「N 张图片」数字（piCore:934 imageCount）；**历史重绘连数字都丢**——main.ts:773 数
> `m.attachments`，但 pi 落盘 user 消息无 attachments 字段（顶层仅 role/content/timestamp，
> 实测恒 0 死代码）。排队气泡只有计数不存原图（piCore:1018 已知局限，本单不修）。
> CSP `img-src data:` 已放行（index.html:5），data URI 零配置。
>
> **选型四条**：①缩略图 = user 气泡内 `<img src="data:…">`，CSS 限高 + 等比（object-fit），
> 多张横排；②点击放大 = 新消息 openImage → 宿主按 md5 写临时文件（**复用 piCore byteAttachCache
> 同款「同字节同路径」去重语义**，附 20MB 上限一致）→ `ui.openPath(tmp)`（已有能力，panel
> **零改动**）；③当场回显 = WvUserMsg 加 images 可选字段（piCore:934 透传 prompt 已带的
> m.images，webview↔宿主同回合二次传递属本地 postMessage 非网络通道，直白正确优先；
> agent_settled 后整页 render 重绘覆盖，历史路径同样画缩略图，两路一致）；④有缩略图时不再
> 画「N 张图片」胶囊行，胶囊仅在无 images 数据时兜底（排队气泡）。

### 施工步骤

1. protocol.ts：WvUserMsg 加 `images?: { data: string; mimeType: string }[]`；新增
   `WvOpenImageMsg { type: "openImage"; data: string; mimeType: string }`（三处同步：发送方
   webview / 接收方 piCore / 协议本处）
2. piCore.ts：`case "prompt"` 的乐观回显（原 934 行）user 消息透传 `images: m.images`；
   新增 `case "openImage"`——校验 data 非空 + 20MB 上限（与字节通道同口径），mimeType 映射
   扩展名（png/jpe?j/g/webp/bmp，缺省 png），md5 命中 byteAttachCache 复用同路径，未命中
   照 attachFile 分支写 tmp + 入缓存（FIFO 50 兑底不动）→ `await this.ui.openPath(tmp)`
3. webview/main.ts：①render user 分支从 content 数组分离 image 项渲染缩略图（textOf 照旧
   取文本，image 项不再丢弃）；②addUser 支持 images 参数（缩略图行 + 点击 → openImage，
   无 images 数据时才画数字胶囊）；③user 消息处理（1157 行）与 queuedDelivered 兑底行
   按数据有无分支；④删 `m.attachments` 死引用（773 行）
4. webview/style.css：缩略图样式（max-height 钳位、等比、横排 flex、点击态、圆角）；
   注意 agent_settled 整页重绘覆盖后视觉一致（两路同 class）
5. i18n：如需新增提示 key（如打不开原图），中英两处同步；能复用既有 key 则不新增
6. main.ts 保持 ES5 var 风格、strict:false 零报错（门禁约定）

### 边界（不许顺手改）

- **pi 原生数据/会话 jsonl 格式零改动**——本单纯消费现成数据，存储/协议数据面不碰
- 不修排队丢图（piCore:1018 注释局限保留，queued 只存 imageCount 的语义不动）；
  不接 `steer(text, images)`（pi SDK 支持但 piClient 未接，另单议）；不动 lightbox 路线
- 不动 panel.ts（openPath 图片分支已支持 vscode.open）；byteAttachCache 去重语义与
  50 上限兑底照旧，不重构
- render 消息载荷现状已带全量 base64，本单不新增载荷压缩/懒加载（图多卡顿如实测出现
  再立项，不预设）

### 验收

- `npm run compile` 全绿；`grep -n "m.attachments" webview/main.ts` 零命中；单笔提交
- 场景四条：①当场发送 2 图 → 气泡显示两张等比缩略图（不再只有数字）；②点缩略图 →
  VS Code 内置预览打开原图（可缩放）；③重开/重绘同一会话 → 历史气泡同样显示缩略图
  （重开丢数字问题随本单消解）；④重复点击同一图 → 临时文件复用同路径（md5 去重生效，
  不产生副本）
- 回报按直令规格在 BUILDER.md 留痕

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