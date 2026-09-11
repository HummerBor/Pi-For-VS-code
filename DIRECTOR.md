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
> **架构铁律（用户拍板）：核心功能不与 VS Code 深度绑定。** 核心逻辑只依赖接口
> （HostCapabilities），不 import vscode；VS Code 特定能力全部住进 adapter/集成模块。
> 一切新功能按此审查。
>
> 本文件由总监维护，是给 pi 的工作指令，**不要合并进 HANDOVER.md**，也不要提交进 git。
> 协作流水：pi 施工 → 用户发 `1`/`111` 给总监 → 总监 review 并更新本文件。
> 已完成工单、验收历史、账目/排队/守则等回顾性内容见 [归档.md](归档.md)（只留施工指令）；
> 角色职责见 [总监.md](总监.md) / [施工方.md](施工方.md)；插件通用约定见 [AGENTS.md](AGENTS.md)。
> 最后更新：2026-09-11 藏身二轮——账目/排队/守则/分工迁入归档.md，全文件只保留工单

## 施工工单（按序执行）

> ⚠️ **状态标记约定**：标题带「✅ 已完成已验收」的工单**禁止重复执行**；
> pi 只施工不带 ✅ 的工单。完成与否以本文件 + 归档.md 验收记录为准，勿信 commit message。
> 已完成工单全文（验收标准/边界/教训）见 [归档.md](归档.md)——做新单前若与其边界
> 相关先查归档，勿凭记忆执行旧单条目。

### 工单九：applyHtml 背景图输入加固 —— ▶️ 待施工（2026-09-10 安全审计裁决）

外部审计报「背景图 URL 可构造 XSS」定为高危。总监实测代码链路后**驳回高危定性**：
两条注入路径均走不通——http(s) 分支有 `/^https?:/i` 白名单（panel.ts:166）、本地分支
只从磁盘读文件且 mime 白名单 image/*（panel.ts:170-176）；注入点 `url('${bgImage}')`
单引号已转义 %27（webview-html.ts:52）；即便构造出 HTML/CSS 污染，CSP nonce 挡住全部
无 nonce script 与内联事件，落不到脚本执行。残余风险仅剩 HTML/CSS 层面的值污染。
本单按**加固**处理，一次机械改动：

1. URL 严格校验：http(s) 分支改 `new URL()` 解析 + 协议白名单（替代裸正则前缀匹配）
2. 转义补齐：bgImage 注入前补 `<` `>` `&` `"` 转义（现有仅 %27）；复用 getHtml 已有的
   script 转义纪律，注释写明为什么（CSP nonce 是最后防线不是第一道）
3. opacity 钳位：backgroundOpacity 配置钳位 [0,1]（现为裸注入，字符串配置可污染 style 属性）
- 验收：`npm run compile` 全绿；手工验证三类输入——合法 http(s) URL、合法本地路径、
  恶意串（`https://x</style><script>`、`1;}...`）均被消毒或钳位；面板正常显示
- **边界（不许顺手改）**：不动 CSP 生成逻辑与 nonce 机制；不改背景图功能语义
  （http(s) 与本地路径两条路都保留）；不动 webview/main.ts

### 工单十一：工具命中路径锚定工作区根（用户实测 2026-09-10）—— ▶️ 已施工待实测（施工回报见 BUILDER.md）

**现象**：pi 改动 gitignore 文件（DIRECTOR.md）后，变更条「查看改动」→ diff 报
「由于找不到该文件，因此无法打开编辑器」。

**根因（总监已实证，勿重查）**：pi 的 edit args.path 原样保留模型传入的相对路径
（本会话事件流实查：`"path":"DIRECTOR.md"`）。相对路径一路进归因清单 →
`openPrerunDiff()` → `vscode.Uri.file("DIRECTOR.md")` 不基于工作区根解析，
落成盘符根 `/DIRECTOR.md` → 文件不存在。**与 .gitignore 无关**：被忽略只是走了
prerun 路由的巧合；tracked 文件 + 相对路径同样会死（Uri.file/`fs.readFileSync`
拿相对路径全链路歪）。之前实测未炸纯属当时模型传了绝对路径。

**第二症状（2026-09-10 晚，工单十二施工会话实证）**：tracked 的 package.json 的
diff 标题错走「本轮改动前 ↔ 工作区」（应为 HEAD ↔ 工作区）——ext host cwd ≠
工作区根时 `relOf` 的 `path.relative(root, 相对路径)` 得到垃圾值 → nowStatus 查不到
→ inHead 误判 false → 路由错进 prerun 通道（本次碰巧 patch 数据在，diff 内容侥幸
显示正确）。同根因，随本单一并修并复验。

1. **归因入口锚定**：panel.ts `handleRunSettled()` 对每个工具命中 `f.path` 先
   `path.isAbsolute` 检查，非绝对则 `path.join(root, f.path)`（root 已在手），
   归一化后入 changesDetail/changesFiles——单点修复，下游 diff/还原全链路收直
2. **顺带核查 headContent 的 slice 疑点**：`prerun%3A` 分支（9 字符前缀）用
   `slice(7)` 截会切出半编码串，decode 后带前导冒号 → changesDetail 查不到 →
   左侧白屏。改成按实际匹配前缀的长度截（或统一先 decodeURIComponent 整个
   query 再 startsWith("prerun:")），并把「uri.query 返回编码还是解码形态」的
   实证结论写进注释，两种 startsWith 分支之谜就此了结
- 验收：`npm run compile` 全绿；让 pi 用**相对路径** edit 一个未跟踪/忽略文件，
  变更条 diff 能打开且左侧「改动前」内容非空；还原该文件内容回退
- **边界（不许顺手改）**：piCore 归因结构不动（核心层不知道 root，锚定属
  adapter 职责）；git 兕底路径（已绝对）不动；不动裁决 11 还原边界
- **状态**：已施工（BUILDER.md 有回报：单点锚定 + slice 修复 + 症状二同修，
  compile 全绿），**待用户装包实测**——实测过了验收记录表加行、本单全结

### 工单十三：会话列表异步化 + 标题提取修复 —— ▶️ 待施工（指派：小模型，用户拍板 2026-09-10）

**用户实测症状**：会话选择器「读不出」标题（部分会话显示裸时间戳文件名）、
「读的慢」（打开卡）。总监已实证根因，施工方照单修，勿重查：

- 全同步 IO 在 extension host：递归 readdirSync + 每文件 statSync + 盲读 256KB +
  逐行 JSON.parse，63 文件全量扫、零缓存，每次打开选择器重来（热缓存实测 53ms，
  冷缓存翻十倍且阻塞事件流）
- 256KB 盲读按整行切，首条 user 消息带大附件时行被拦腰截断 → JSON.parse 必炸 →
  continue 跳过 → 标题永远找不到（实测当前全目录 28 行截断解析失败）
- name 依赖 pi 首轮后的 session_info 条目，没生成的会话掉到 preview/裸文件名兜底

**分四小步，每步独立提交**（小模型护栏：步内不许顺手改别的）：

1. **异步化**：collectJsonlFiles/listSessions/readSessionMeta 全链路 fs.promises
   （readdir/stat/open/read），调用点 pickSession/deleteSessionPick await 化
2. **按需续读替代盲读 256KB**：先读 16KB；若已凑齐 name+preview 或文件读完即止；
   若末行不完整（不以 \n 结尾）且未凑齐 → 续读 16KB 步进，硬上限仍 256KB
3. **parse 失败行兑底**：JSON.parse 失败的截断行用正则抓 `"name":"..."`（注意
   \\" 转义）后继续，不再直接放弃
4. **mtime 缓存**：模块级 `Map<file, {mtimeMs, meta}>`，stat 后 mtime 未变直接用缓存；
   缓存放 panel.ts 模块级（UI 层职责，不进 PiCore）

- 验收：`npm run compile` 全绿；打开选择器不卡（冷启动后首次也要顺滑）；
  此前显示裸文件名的会话标题能出；带大附件的会话（如 智谱费用明细 xlsx）标题正常
- **边界（不许顺手改）**：不动 pickSession 的 QuickPick 交互结构与 switchSession/
  getMessages 渲染链；不动会话删除守卫；不改 SessionInfo 结构（展示字段不变）；
  同步 IO 异步化只限本单列出的函数，其他 readFileSync 不许顺带「优化」

## 请示裁决（✅活；史条目在 归档.md「六、pi 请示裁决」）

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