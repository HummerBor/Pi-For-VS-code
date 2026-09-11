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

### 工单十四：附件限制删除（用户裁决「不限制」，2026-09-11）—— ▶️ 待施工（小刀，可与十三并行）

**背景**：用户明确拍板附件不限制数量与大小。现状盘点（总监实证）：
- 200KB 大小限制：0.0.82（4987898）附件路径模式改造时已删，代码注释明写「只传路径，
  不读内容，不限大小」；i18n `fileTooBig`/`fileTooBigI` 中英 4 键已是死键（无代码引用）
- 5 个数量上限：还活着（webview/main.ts:701，仅计非图片文件），系读内容模式遗产，
  路径模式下无存在理由（只传路径字符串，宿主开销与个数无关）

**改动**：
1. 删 `webview/main.ts` 中 `pendingFiles.length >= 5` 检查（~701 行）
2. 删 i18n 死键：`maxFiles`、`fileTooBig`、`fileTooBigI`（中英共 5 键；即 0.0.87
   攒包清单里的 fileTooBig×2 死键项，合并处理）
3. 图片胶囊若有同类上限一并核查删除（保持「图片路径化后同权」一致性）

- 验收：`npm run compile` 全绿；拖 6+ 个非图片文件全部入胶囊；i18n 零死键残留（grep 验证）
- **边界**：不动拖拽事件结构与图片判定逻辑；不动 attachUri/宿主 addFiles 链

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