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
> 最后更新：2026-09-14 签工单十六（排队消息取回，三处查留证：pi 原生只有 clearQueue 全清 +
> TUI dequeue 取回编辑器，无单条删除 API）

## 施工工单（按序执行）

> ⚠️ **状态标记约定**：标题带「✅ 已完成已验收」的工单**禁止重复执行**；
> pi 只施工不带 ✅ 的工单。完成与否以本文件 + 归档.md 验收记录为准，勿信 commit message。
> 已完成工单全文（验收标准/边界/教训）见 [归档.md](归档.md)——做新单前若与其边界
> 相关先查归档，勿凭记忆执行旧单条目。

> 工单十五遗留认知（全录见 归档.md 9.10，2026-09-14 用户实测结单）：mode.json 是
> pi 磁盘全局态，mode 按页签隔离是假需求，勿再立项。

### 工单十七：滚动跟随对齐 pi 原生（上滑暂停跟随，回底自动恢复）

**背景（用户原话）**：「会话在工作的时候滚动条一直保持下拉……很难受，优化一下」——
流式中每 100ms tick 无条件拉底（webview/main.ts:222 `scroll()` =
`root.scrollTop = root.scrollHeight`，:491 节流 tick），用户上滑读历史被拽回，实际读不了早期内容。

**签单三处查留证（2026-09-14 总监亲查，勿重查；负结论也是证据）**：

1. **pi 公开 API**：AgentSession 等 core API 无 UI 滚动概念（负结论——UI 是壳的事，
   本该没有）。
2. **pi TUI 行为（原生范式，直接照抄）**：pi-tui 官方 ScrollView 组件
   （node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/
   dist/components/scroll-view.d.ts）有完整 follow 语义：`follow: "end"` 选项 +
   `isFollowingEnd` 状态。语义（scroll-view.js:106/125-131）：**跟随 = 钉在 content end；
   用户滚离底部 → 跟随自动暂停（`followingEnd = followEnd && next === maxScrollTop`）；
   滚回最底 → 自动恢复跟随**。transcript 视口已开启此模式（dist/modes/interactive/
   chat-viewport.js:5 `follow: "end"`）。无「回底浮标」类 UI（终端手势即滚回）。
3. **扩展生态**：扩展 API 无 webview/滚动能力（extensions.md 无先例，负结论）。

**结论**：这不是发明新交互，是把 pi 原生 ScrollView 的 follow 语义映射到 webview DOM。

**实现要点**：

1. `#messages` 容器加 scroll 监听（passive），维护 `followingEnd` 布尔：
   `scrollHeight - scrollTop - clientHeight <= 阈值`（≤48px，DOM 里内容增长不触发
   scroll 事件、程序化赋值后有像素容差，写注释说明与 TUI `next === maxScrollTop`
   精确等值的差异原因）。
2. `scroll()`（:222）改为：仅 `followingEnd` 为真才拉底。所有现有调用点
   （节流 tick/气泡/notice/工具详情）不动，改动面收敛在这一个函数。
3. **用户主动动作强制回底**：addUser（发消息，:379）与 fillInput（取回输入框，:1037）
   置 `followingEnd = true`——主动动作即回底意图。
4. **不做「↓ 回到最新」浮标**：TUI 无此 UI，拖滚动条回底即恢复跟随，壳不自研
   原生没有的东西。
5. 纯 webview 内部改动：协议三处不动（无跨边界消息）；ES5 var 风格；strict:false
   零报错；busy 不整页重绘红线不受影响（跟随判定只在滚动事件与 scroll() 内）。

**验收标准**：

- 流式中上滑：停在用户滚到的位置读历史，新 token 不拽人；滚回底部 → 跟随自动恢复
- 流式中不滚动：行为与现状一致（钉底跟随，无闪烁/跳动）
- 发消息/取回排队消息 → 回底
- `npm run compile` 全绿；单笔提交（不含版本 bump）

**不许顺手改**：liveRTimer 节流周期、streamTick 逻辑、工单十六的排队域、
:222 以外的任何 scroll 调用点语义。

## 攒包小刀（随下一版，可与任意工单顺带，不许混笔）

- **renderAll 死循环隐患（工单十六施工发现，总监已裁决修法）**：webview/main.ts:717
  `for (rq = 0; rq < queuedItems.length; rq++) addQueued(queuedItems[rq])`——addQueued
  push 回同数组而 for 条件用同一 length：排队非空 + renderAll 重入时死循环 + queuebar
  重复 DOM。修法（裁决）：改调 `addQueuedDom(queuedItems[rq])`（纯 DOM，不 push）——
  数组已是真相，push 回去本身即错；不要改成「先清 queuebar」方案（绕远且语义含糊）

## 排队（未签发，勿提前施工）

> 完整清单见 归档.md「八、后续排队」。大盘子：**多标签并行会话已提签为工单十五**
> （2026-09-11 用户拍板）；子 agent 面板视图为潜在产品线项（pi 本体无子 agent，
> 官方 subagent 扩展示例可直装，暂不立项）。

## 请示裁决（✅活；史条目在 归档.md「六、pi 请示裁决」）

- ✅活 12（09-14 裁决 BUILDER 请示）：**工单十五留主力会话施工**——小模型会话自请不接
  （判断正确，追认）；攒包小刀（README 残留+importSession 上移）小模型可做。开工十五前
  用户需先指定主力会话

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