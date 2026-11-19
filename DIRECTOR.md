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
> 最后更新：2026-11-19 **webview/main.ts 拆分战役收官**（3269→368 行，12 单全收；全文已迁 归档.md 同日条目，详表 `docs/history/交接-webview拆分完成.md`）。当前无待施工工单。遗留：真机验收 9 个域待跑；`applyState` 冻结用时口径待立票；6b 页面 chrome 可跳；`slim-subagent-frames.mjs` 修好前禁 `--apply`。
> 前情：2026-11-16 用户拍板「ops-panel 驱动接入这个需求整个砍掉」→ 工单33 判死（全文已迁 归档.md），控制面命令与授权层代码同批删除；契约文档《交接-ops-panel-驱动接入.md》《交接-工单33-runPrompt.md》已删。前情：工单32 全链收单（964d92c/c5fd56b/86e67a7/7070a48/热修三连，见工单区注记）；用户拍板放宽 webview/main.ts ES5 var 限制。
> 前情：09-20 验收循环（五）：工单30 拆除验收通过结单（grep 零命中/compile 绿/逐 hunk 归属干净/原生 APPEND_SYSTEM.md 未误伤，纯拆除无实测项）；工单27 回收全链路闭环。

## 施工工单（待施工）

> ⚠️ **状态标记约定**（用户三次纠偏后钉死）：结单工单**全文迁 归档.md，DIRECTOR.md 零残留**——
> 不留指针行、不留 ✅ 标题、不留「待实测」尾巴；判死单同样原样迁归档（工单八/22 先例）。
> 工单区只存在待施工项。已完成与否以 归档.md 为准，勿信 commit message。
> 做新单前若与旧单边界相关先查归档，勿凭记忆执行旧单条目。
> **工单号一律阿拉伯数字**（工单23 起，用户拍板 2026-09-15；存量编号不改）

> **工单34（待施工）——记忆接力一期：压缩后指针注入 + digest 探针**
>
> 背景：压缩（pi `compaction`）后模型不知道「该重读哪些文件」，导致每次压缩都从头摸。实测证据在
> `docs/decisions.md` §十七：jsonl 永完整、摘要丢被否方案、压后可注入。用户 2026-11-19 拍板整体方案
> （常驻层 / 交接卡 / 压缩层 / 档案层 四层），本单只做压缩层一期。
>
> **范围**：新建 `harness/memory/{index.ts,harness.json}`（version:1）；`src/pi/ensureSubagentHarness.ts`
> 泛化为多 bundle 同步（现有 subagent bundle 的版本门行为不许变）。两个钩子：
> ① `pi.on("session_compact")` → 用 `pi.sendMessage({customType:"memory-pointer",content:[...]},
> `{triggerTurn:false})` 注入一条 **≤60 token** 固定指针（重读 AGENTS.md / PROGRESS.md）。
> ② `pi.on("session_before_compact")` → 算 digest 但 **不接管**：仅 `pi.appendEntry("memory-digest",{...})`
> 落盘（custom 帧不进上下文），供真机观察抽取质量。抽取逻辑必须是**纯函数**、可被 node 直接 import。
>
> **边界（不许顺手做）**：不返回 `{compaction}` 接管摘要（二期另立单）；不改 `reserveTokens`/`keepRecentTokens`；
> 不改压缩触发时机；钩子内零网络、零 fs 写；不新增第九个 `pi.on` 之外的钩子；不动 webview 与 `piCore`。
>
> **验收**：① 手动压缩后面板出现一条 memory-pointer 消息，jsonl 新增 1 条 `custom_message` + 1 条
> `custom(memory-digest)`；② `scripts/test-memory-digest.mjs` 用真实 jsonl 喂抽取函数，断言 4 段结构与
> ≤4k token；③ `npm run compile` 全绿 + 全部 `test:*` 基线不降；④ `harness.json` 版本只升不降，
> 已装 `extensions/subagent` 不被误覆写。
>
> **工单35（已结单 2026-11-19，`5781dbf`）——全文已迁 `归档.md`，本区零残留。**

> **工单36（待施工）——`slim-subagent-frames.mjs` 返修（数据红线，修好前禁 `--apply`）**
>
> 背景：脚本只删行、不重接 `parentId`。299MB 样本实测：体积 299.92→20.69MB（-93.1%），但用 pi 自带
> `SessionManager` 加载后**上下文 566→21 条、thinkingLevel high→off、从 leaf 只 24/619 可达**——
> 等于把会话历史洗掉。修法清单见 `docs/history/交接-webview拆分完成.md` §五 第 8 条。
>
> **范围**：只改 `scripts/migrate/slim-subagent-frames.mjs` + `scripts/test/test-migration.mjs`。
> 修法：被删节点的 `parentId` 上溯压缩（只改引用行、体积不变、561→566 条完全复原）+
> temp/fsync/rename 原子替换 + `.bak` 存在即拒跑 + `--apply` 后自检失败自动回滚 +
> `frames.jsonl` 终态守卫 + 流分支改 `JSON.parse` 判类型（不用字符串 include）。
>
> **边界**：严禁对 `~/.pi/agent/sessions/**` 跑 `--apply`（只能用拷贝到临时目录的样本）；
> 不跑 `npm run compile`（`.mjs` 不在构建链里，且另一个单在编译，并发抢 `dist/`）；
> 不动 `src/`、`webview/`、`harness/`、任何 md。
>
> **验收**：① 样本 `--apply` 后 566 条完全复原、体积仍 ≈-93%；② `.bak` 存在时拒跑且退出码 ≠0；
> ③ 断电模拟（中途 kill）不出半成品（temp 不覆盖原文件）；④ `npm run test:migration` 基线不降。

> **工单37（待施工）——`归档.md` 瘦身：3,340 行 → 400-600 行**
>
> 背景：仓库最后一个膨胀源（≈74k token）。“只追加、只迁入、不删”→ 长成现在这样。
> 按新标准（`AGENTS.md` 文档预算）：**每工单 3-5 行** = 工单号 + 标题 + 结论 + commit 哈希。
>
> **保留（一条不许丢）**：所有 commit 哈希；工单号与标题；判死裁决与**理由**；“七、未结账目”
> “八、后续排队”“同批删除清单”三节全文；事故教训里**未被 `docs/decisions.md` 收录**的部分。
> **删**：过程叙述（读过什么文件、跑了几次探针、逐条断言输出、命令回显、中途回合）。
>
> **边界**：只改 `归档.md`，不碰任何其它文件；不合并不同工单；不丢哈希；不跑 `npm run compile`。
> 旧版全文在 git 历史里，但**改完必须自查哈希集合没变小**。
>
> **验收**：行数 400-600；改前所有 7 位以上 hex 哈希在改后全部还在（脚本比对）；
> 工单标题数不变；三节决策全文在位。
>
> **工单38（待施工）——小债两笔：`scheduleStream` 死代码 + 大纲注释口径**
>
> 背景：`webview/features/liveStream.ts:171` 的 `scheduleStream` 是存量死代码（随 5b 搬进来时留的，
> 文件内注释已自认）；`webview/features/outline.ts:50` 注释写“视口上 1/3 线”，代码却用
> `clientHeight / 2` 中线。
>
> **范围**：删 `scheduleStream` 定义与导出（先全仓 grep 确认无调用）；把 outline.ts:50 注释
> 改成与代码一致（**只改注释，不改行为**）。
>
> **边界**：不动滚动判定阈值（改行为需产品拍板）；不碰 `composer.ts` / `messageList.ts` /
> `sessionView.ts` / `style.css` / `index.html` / `piCore.ts` / `i18n.ts` / `protocol.ts` /
> `package.json`（正在被别人未提交改动持有）；不跑 `npm run compile`（用 `npm run typecheck:webview`）。
>
> **验收**：`grep -rn scheduleStream webview/` 只剩历史注释（无定义无调用）；
> `npm run typecheck:webview` 零报错；`git show --stat` 只含两个文件。

> **工单39（待施工）——digest 裁剪优先级重排（工单34 返修）**
>
> 问题：`harness/memory/digest.ts` 的 `enforceBudget()` 从最后一节开始砍，而最后一节是否决清单——
> 最不可再生的信息先被砍掉（实测：61.5MB 会话超预算时 rejections 剩 0 条、user 留 81 条）。
> 改法：另立 `TRIM_PRIORITY`（conclusions → user → decisions → rejections）与展示顺序解耦；
> `stats.dropped` 改为按节计数（保留总数兼容旧断言）。
>
> **边界**：不改展示顺序、不改抽取规则、不改 4000 token 预算、不碰 `index.ts` 钩子行为。
>
> **验收**：新增 2 条断言（超预算时 rejections 一条不少；先砍 conclusions）+ 真实样本打印按节计数。

> **工单40（待施工）——真实会话目录的 `--apply` 加固（工单36 补刀）**
>
> 问题：`slim-subagent-frames.mjs` 不给路径时默认扫 `~/.pi/agent/sessions`，所以
> `--apply` 一条命令就能改写本机 4.1GB / 488 个真实会话（`.bak` 守卫只挡第二次）。
>
> **改法**：`--apply` 且目标落在 `sessionsRoot` 下（或未给路径）→ 必须再带 `--force-real`，
> 否则拒跑（退出码 1 + 危险提示）；干跑（无 `--apply`）不受影响；显式给非 sessions 路径照旧放行。
>
> **验收**：原有 9 组断言不退 + 四条新断言（拒跑/force-real 放行/显式路径放行/干跑不写盘）。

> **工单41（待施工）——digest 抽取侧加宽 + 节内裁剪方向**
>
> 真瓶颈（工单39 实测）：三个真实样本抽出的 `rejections` 只有 10 / 1 / 0 条，信号词只有 5 个。
> 一节常年为空 = 二期拿它接管摘要就是拿空节换 LLM 摘要里的取舍信息。
>
> **改法**：① 信号词按四类加宽（直接否定/对比裁决/原因否定/已知失败）成 `REJECT_SIGNALS` 表，
> 命中但整句 <8 字不收；`REJECT_LIMIT` 10→24、`REJECT_MAX` 150→120。② `conclusions` 节内改从**头部**
> pop（保最新结论），其余节仍尾 pop（保最早调子）。
>
> **边界**：不动 `SECTION_ORDER` / `TRIM_PRIORITY` / 4000 token 预算 / `index.ts` 钩子。
>
> **验收**：原 12 条断言不退 + 至少两个真实样本 rejections ≥5 条（回报要贴样例人眼查噪音）+
> conclusions 裁后保尾 + 短句不入库。

> 历史：工单33 判死、工单32 收单存查（两单全文均已迁 归档.md）。

## 攒包小刀（随下一版，可与任意工单顺带，不许混笔）

> 2026-11-19 攒包：① `slim-subagent-frames.mjs` 干跑默认扫 4.1GB 真实会话根，无进度提示会像卡死 → 加一行进度（已扫 N/M）；
> ② `AGENTS.md` 补一条工作口径「改动一律派单施工，包括文档与流程，总监不自己动手改文件」。

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