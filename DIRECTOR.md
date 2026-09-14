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
> 本文件由总监维护，是给 pi 的工作指令，**不要合并进 HANDOVER.md**。git 侧 2026-09-11
> 起经 94ff28d 用户拍板入库（台账同步进版本管理），vsix 仍排除（.vscodeignore）。
> 协作流水：pi 施工 → 用户发 `1`/`111` 给总监 → 总监 review 并更新本文件。
> 已完成工单、验收历史、账目/排队/守则等回顾性内容见 [归档.md](归档.md)（只留施工指令）；
> 角色职责见 [总监.md](总监.md) / [施工方.md](施工方.md)；插件通用约定见 [AGENTS.md](AGENTS.md)。
> 最后更新：2026-09-11 藏身二轮——账目/排队/守则/分工迁入归档.md，全文件只保留工单

## 施工工单（按序执行）

> ⚠️ **状态标记约定**：标题带「✅ 已完成已验收」的工单**禁止重复执行**；
> pi 只施工不带 ✅ 的工单。完成与否以本文件 + 归档.md 验收记录为准，勿信 commit message。
> 已完成工单全文（验收标准/边界/教训）见 [归档.md](归档.md)——做新单前若与其边界
> 相关先查归档，勿凭记忆执行旧单条目。

### 工单十三：会话列表异步化（小模型机械单，四小步）—— 🔴 用户实测打回（09-14：打开长无反馈）；二刀（零反馈治理）已签，二刀+复测后才可结
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

### 工单十三补刀：分块读多字节字符骑线修复 —— 🟡 代码验收通过（2026-09-14 总监实验 8/8 + 循环级复刻骑线 OK=true）；待用户实测

**缺陷实证**（node 实验，总监亲跑）：readSessionMeta 逐块 `buf.toString('utf8')` 会把骑在
16K 块边界上的多字节 UTF-8 字符永久烤成 \uFFFD——首字节在 16383、后两字节进下一块时，
名字变「\uFFFD\uFFFD\uFFFD文名」且无法恢复（实验脚本结论：边界骑线场景 clean=false）。
旧 256KB 整块读无此问题，属步 2 引入的回归类。中文名条目短、骑线概率低，但本单
要治的就是标题病，不留这个口子。**修法（只动 readSessionMeta）**：

1. 读入后先拼 carry：`chunk = Buffer.concat([carry, buf.subarray(0, bytesRead)])`
2. 从 chunk 末尾回扫连续字节（10xxxxxx）找到首字节，按首字节判定期望长度
   （110→2、1110→3、11110→4）；序列不完整则摘出尾部存 carry 留给下一块，
   完整部分才 `toString('utf8')` 进 acc
3. 文件读完（bytesRead=0）时 flush：carry 若非空并入 acc 解析（真损坏尾行交给
   步 3 的正则兑底，行为与旧版一致）

- 验收：node 实验骑线场景 clean=true（同款构造：首字节在 16383 的中文名）；
  compile 全绿；单笔提交，禁顺带
- **边界**：只动 readSessionMeta；步 3 正则兑底与步 4 缓存不动；不重构其他逻辑

### 工单十三二刀：选择器零反馈治理 —— ▶️ 待施工（2026-09-14 用户实测打回，瓶颈另有其人）

**用户实测**：点历史「很长时间无反馈然后打开」——原验收点「打开不卡」不达标，十三主体不能结。
**总监基准已证**（真实目录 79 文件 104MB，新旧实现各 3 轮）：IO 非瓶颈（旧同步 136-295ms，
新异步 153-234ms 同量级）。真嫌疑：① pi 直连跑在 ext host 内，面板刚开时 pi 预热加载包
占住事件循环，pickSession 消息排队等 ② QuickPick 等 listSessions 完才弹，等待期零反馈。
**本单三刀，一或两笔提交均可（计时埋点可并入）**：

1. **计时埋点**：pickSession 消息到达→listSessions 完成→QuickPick 弹出，三段耗时追加进
   `~/.pi/agent/pi-chat-debug.log`（现有诊断日志，别新开文件）。用户复测一次，数字定位
   剩余延迟归属（若消息到达前已耗秒级 = pi 预热阻塞事件循环，另立账）
2. **busy 占位**：pickSession **立即**弹 QuickPick，先放一条「正在加载会话…」busy 项
   （busy:true），listSessions 完成后原地填充/替换；列表空时给「无会话」项。**原边界
   「不动 pickSession 的 QuickPick 交互结构」就地解禁（总监签发）——本刀只准加占位与
   填充，switchSession/getMessages 渲染链照旧不许碰**
3. **后台预热缓存**：面板 webviewReady 时 fire-and-forget 跑一次 listSessions()（不 await、
   错误静默），填 mtime 缓存——首次点击也能毫秒级出列。这是十三缓存价值的兑现点

- 验收：点历史**立即**有响应（占位项/加载态）；预热后点击毫秒级出全列表；debug.log 三段
  计时可见；compile 全绿
- **边界**：不动 switchSession/getMessages/删除守卫/SessionInfo；不动 piCore；预热只在
  adapter 层；埋点只加不改既有日志行

### 工单九：applyHtml 背景图输入加固 —— 🟡 代码验收通过（2026-09-14）；待用户实测背景图显示

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

### 工单十五：面板内多标签并行会话 —— ▶️ 待施工（2026-09-11 用户提签，实战需求成立）

**动机（用户原话）**：现在并行干活只能「一个在插件、一个在终端」，不是都在插件里。
**方向拍板**：标签栏住面板内（CC 风格），每个标签 = 独立 AgentSession（独立 PiCore 实例），
可同时各自 busy；切换方式定版——①标签栏切标签（并行容器）②历史 QuickPick 照旧，
作用于**当前活动标签** ③编辑器维度不做（会话不塞编辑器标签）。工单四已埋预留：
变更清单按会话域持有，多标签落地直接复用（归档.md 工单四）。
**子 agent 不在本单范围**：pi 本体无子 agent（README:501），官方 subagent 示例扩展 =
独立 pi 子进程方案，插件通用工具渲染已能显示；面板级子 agent 视图另立产品线排队。

**分三刀，每刀独立提交+验收**（判断型工单，指派主力会话；小模型勿接）：

1. **核心多实例 + tabId 路由**：panel adapter 持 `Map<tabId, PiCore>`；HostToWebview
   全消息带 tabId（协议三处同步，tabId 以附加字段进——✅活 2 TS 约定照守）；
   webview 按 tabId 分发。**开工前先冒烟**：同进程建两个 AgentSession 各 prompt 一次，
   验证 pi 包无单例假设（结论写进回报）；若有单例假设，退路 = 标签退回子进程方案
   （分支 rpc-subprocess 的 spawn 模型可参考）
2. **webview 标签栏**：标签条 UI + 每标签独立消息 DOM/busy/排队状态；新标签=新会话；
   关标签确认（进程在跑时）+ dispose 回收；后台标签完成时标签上亮提示
3. **会话语义**：lastSessionByWs 按标签扩展；历史 picker/删除作用于活动标签；
   模型/思考记忆按标签；sessionMode 回退值铁律不变（两处一致）

- 验收：双标签各跑一个任务**互不串流**（事件/流式/工具行/附件全隔离）；切标签不丢
  流式现场；关标签后 pi 会话资源回收实测；compile 全绿 + vsix 实测
- **边界（不许顺手改）**：busy 中的标签禁止切历史会话/删除（防会话文件写冲突，
  同 HANDOVER 双窗口教训）；不动 steering/queue_update 转正语义；不动 patchRevert/
  还原边界；单标签行为必须与现状等价（不借机改现有交互）

## 攒包小刀（随 0.0.89，可与任意工单顺带，不许混笔）

- README.md 删 `<!-- 注释性改动示例 -->` 残留（0.0.88 发版混入的测试行，随市场已出，改后需 push 才在市场生效）
- importSession 大小检查上移到 .jsonl 检查旁（工单十遗留）

## 排队（未签发，勿提前施工）

> 完整清单见 归档.md「八、后续排队」。大盘子：**多标签并行会话已提签为工单十五**
> （2026-09-11 用户拍板）；子 agent 面板视图为潜在产品线项（pi 本体无子 agent，
> 官方 subagent 扩展示例可直装，暂不立项）。

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