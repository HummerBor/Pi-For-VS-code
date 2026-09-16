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
> 最后更新：2026-09-16 发版前终验通过（0.0.95 树 → 0.0.96 ship），放行记录见下

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