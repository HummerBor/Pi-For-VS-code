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

### 工单十六：排队消息「取回到编辑框」（= pi 原生语义的删除）

**背景**：用户要求对排队中（queuebar）的消息做删除操作。签单三处查留证（2026-09-14
总监亲查，勿重查；**负结论也是证据**）：

1. **pi 公开 API**（node_modules/@earendil-works/pi-coding-agent/dist/core/
   agent-session.d.ts:428-441）：`clearQueue(): {steering: string[]; followUp: string[]}`
   （全清并返回快照）、`getSteeringMessages()` / `getFollowUpMessages()`（只读）、
   `pendingMessageCount`。**没有单条删除 API**。
2. **pi TUI 行为**（dist/modes/interactive/interactive-mode.js:3408 handleDequeue、
   3615 restoreQueuedMessagesToEditor；docs/keybindings.md:166）：`app.message.dequeue`
   （alt+up，Windows alt+q）=「Restore queued messages to editor」——全部排队 clearQueue
   后合入编辑框，删改发生在编辑器里；队列条上无单条删除交互。abort 时同样走
   restore({abort:true})（interactive-mode.js:1406/1577/2255）。
3. **扩展生态**：pi 包内置扩展无队列管理先例；扩展 API 同样只暴露 steer/followUp/
   clearQueue，单条删除在扩展侧也做不了。

**结论**：pi 原生语义 =「取回到编辑器再删」，不存在队列条上的直接删除。插件按壳原则对齐：
排队条每项加「取回」动作 → clearQueue 全清 → 被取回项文本合入 webview 编辑框 → 保留集
按原类型重排队。用户要删就在编辑框里删——与 TUI alt+up 完全同构，不造第二种范式。

**实现要点**：

1. **类型感知**：现 `piCore.ts` queued 数组（:76）不记 steer/followUp 归属。所有入队都经
   插件 prompt 链路（streamingBehavior 自发即知类型），发送时记下归属；queue_update 事件
   带 `{steering, followUp}` 两数组（agent-session.d.ts:49-51）可对账兜底。
2. **重排队保序**：保留集重发时原 steering 走 `steer()`、原 followUp 走 `followUp()`，
   各自内部保序；steering 先于 followUp 送达的语义不变。
3. **竞态**：clearQueue 与重发之间 agent 可能取走消息——重发的是「保留集」，与被取走项
   无交集，天然不重复；重发完成后 post queuedClear+queuedAdd 重建 queuebar（复用
   piCore.ts:397-399「先清后发」同款机制），不做整页重绘（busy 红线）。
4. **clearQueue 后恰好 idle 的边界**：agent 已 idle 时不能对保留集走 steer()——须判 busy，
   idle 则第一项走现有 prompt 链路（含 streamingBehavior 语义）、其余照常排队。判定口径
   以 piClient 现有 busy/steer 自愈逻辑为准，不另造一套。
5. **图片项已知局限**：queued 只存 imageCount 不存原图，取回仅还原文本，图片丢失——
   在实现处留注释记为已知局限，本工单不做附件数据回传。
6. **协议三处同步**：protocol.ts（如 queuedRetrieve{qid} / queuedRestored）+ piCore 发送方
   + webview/main.ts 接收方；i18n 走模板 `{{t:key}}`。

**验收标准**：

- 流式中排队 3 条 → 取回中间 1 条：编辑框出现该文本，另 2 条按原顺序留队列条且原类型
  不变（steering 仍先送达）；期间无整页重绘、流式渲染不闪断
- 取回含图项：文本还原、无报错
- 竞态实测：取回瞬间 agent 正取走一条 → 不重复、不丢、queuebar 与 pi 真相一致
- `npm run compile` 全绿；单笔提交（不含版本 bump）

**不许顺手改**：steer 自愈正则、4s pendingPrompt 兜底、还原边界（patchRevert）、
queue_update 转正逻辑本身、queuedDelivered 现有语义。

## 攒包小刀（随 0.0.89，可与任意工单顺带，不许混笔）

> **两项均已随重做单落地（2026-09-14 总监亲施），本节销账**

- README.md 删 `<!-- 注释性改动示例 -->` 残留（0.0.88 发版混入的测试行，随市场已出，改后需 push 才在市场生效）
- importSession 大小检查上移到 .jsonl 检查旁（工单十遗留）

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