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
> 最后更新：2026-09-15 验收循环：工单二十代码验收通过（待用户装包实测）；追认两笔回归修复
> 9594ba7/819a883（✅活 13，BUILDER 留痕缺失记档）。下一单=工单二十一（pi 未开工）

## 施工工单（按序执行）

> ⚠️ **状态标记约定**：标题带「✅ 已完成已验收」的工单**禁止重复执行**；
> pi 只施工不带 ✅ 的工单。完成与否以本文件 + 归档.md 验收记录为准，勿信 commit message。
> 已完成工单全文（验收标准/边界/教训）见 [归档.md](归档.md)——做新单前若与其边界
> 相关先查归档，勿凭记忆执行旧单条目。

> 工单十五遗留认知（全录见 归档.md 9.10，2026-09-14 用户实测结单）：mode.json 是
> pi 磁盘全局态，mode 按页签隔离是假需求，勿再立项。

## 施工工单（按序执行）

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

### 工单二十一：压缩边界可见化——compactionSummary 消息渲染（2026-09-15 用户直令）

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