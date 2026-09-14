# BUILDER.md — 工作记录与交接（pi 维护，总监/后任必读）

> AGENTS.md 只写职责；本文件是**活动工作记录**：当前进度、待实测尾巴、待决请示。
> 已完结工单的施工回报、历史决策与教训已随验收归档到 [归档.md](归档.md)「九、施工回报存档」——
> 交接需复盘历史时去归档.md，本文件只留未完结项。不提交进 git（与 DIRECTOR.md 同）。

最后更新：2026-09-11 归档精简（已完结回报迁 归档.md 第九节，本文件只留活动项）

## 工单十三二刀施工回报（选择器零反馈治理，四刀一次提交 ead904d）

**工单十三主体被用户实测打回（点历史长无反馈）后的二刀**：总监基准已证 IO 非瓶颈，
按签工单四刀一次提交落地（panel.ts + i18n.ts，piCore 零改动）：

1. **计时埋点**：panel 新增 dbgLog（与 piCore 共用 ~/.pi/agent/pi-chat-debug.log，不新开
   文件、轮转同策略），pickSession 三段计时可见（占位弹出/列表就绪/内容就绪项数）。若复测
   显示消息到达前已耗秒级 = pi 预热伸延阻塞事件循环，另立账
2. **busy 占位**：showQuickPick → createQuickPick，弹起即放「正在加载会话…」busy 项，
   listSessions 完成后原地替换；选中/取消语义等价；渲染链（switchSession/getMessages/
   refreshState）逐行未动；i18n 新增 loadingSessions（中/英+NATIVE_KEYS）
3. **后台预热**：webviewReady 时 fire-and-forget listSessions()（错误静默）——pi 包提前
   加载 + 页缓存预热，首次点击也毫秒级
4. **换 pi SessionManager.listAll**（用户提出升级）：废弃自研扫描整树主路径，
   collectJsonlFiles/readSessionMeta/splitUtf8 加注释留作回退备胎不预删。薄映射
   （file=path、preview=firstMessage 截 60、mtime=modified.getTime()），samePath 项目过滤，
   mtime 缓存 key=file 外包照旧

**冒烟**：本地真目录 79 会话 listAll 字段/映射全吻合、msgCount=177 白拿。compile 全绿。
**待实测**（需真 vsix）：①点历史立即有占位响应 ②预热后首次点击毫秒级出全列表
③debug.log 三段计时可见（定位剩余延迟归属）。

**刀 5（73764f5，listAll 结果指纹缓存）**：总监实测 listAll 真机 700-917ms/次，原口径
「预热后毫秒级」不成立（mtime 缓存省不了 listAll 自身）——签刀5：模块级 Map<指纹,
上次 listAll 结果>。指纹=复用自研备胎 collectJsonlFiles 做 stat 扫描（79 文件 7-21ms），
路径+mtime 进 FNV-1a 哈希，文件数并入；命中直接复用免 700ms，未命中才 listAll（占位遮盖）。
节点实测：冷缓存 21+574=595ms；热缓存 7-9ms+0ms=**真毫秒级**。稳态命中率近 100%。
compile 全绿，单笔提交只改 panel.ts。

**刀 5 补修（c36054e）**：总监验收打回 73764f5 两个必修缺陷——①Map<指纹,结果> 无限累积
（pi 每发消息必换指纹 → 聊 50 轮滞留 50 份）②listAll 携带 allMessagesText 重串（单次
几十上百 MB）→ OOM 风险。补修：Map→**单槽** {fp,result}（指纹变即作废恒 1 份）+ 只存
**轻量投影**（path/cwd/name/firstMessage/modified 五字段，Pick 标注，弃重串，KB 级）。
node 实测 100 轮指纹变化+2MB 重串/会话：单槽恒 1 份 vs Map 滞留 100 份；热命中仍毫秒级。
compile 全绿，只改缓存声明+listAllCached。

**边界遵守**：switchSession/getMessages/删除守卫/SessionInfo/piCore 全未动；自研备胎未删。

## 请示（待总监裁决，记于回报区）

**工单十五（面板内多标签并行会话）标注「判断型工单，指派主力会话；小模型勿接」**——
当前施工方为小模型，不接。工单区按序轮到的下一张大单即是工单十五，请总监裁决：①由用户先
发 `1` review 完二刀，另指派主力会话施工工单十五；②或本会话仅做工单十三二刀+攒包小刀，
工单十五继续排队。

## 工单九施工回报（后台图输入加固，安全审计机械改动，待用户实测）

**一次改动提交 074ab0c，全在 panel.ts applyHtml，webview/main.ts/CSP/nonce 全未动**：

1. **URL 严格校验**：http(s) 分支 new URL() 解析 + 协议白名单，替代裸正则前缀。
   node 实测：javascript:/data:/ftp: 均可被 new URL 解析但 protocol 非白名单 → 拒；
   https://x</style><script> 在解析层直接 throw（<> 非法）→ 拒。用规范化 u.href
   （危险字符百分号编码）而非原串，注入面再收窄。
2. **HTML 值消毒**：bgImage 注入前补 < > & " 实体转义（原仅单引号 %27）；先转 & 防
   实体二次转义。注释写明这是第一道防线、CSP nonce 是最后防线，不重复依赖。
3. **opacity 钳位**：[0,1]，typeof 非 number/NaN 回默认 0.35，字符串配置无法污染 style。

**node 实测**（验收三况）：合法 http URL 保留；恶意串消毒/拒绝；opacity 1;} 类钳位全对。
compile 全绿。**待实测**：面板背景图正常显示（合法 http URL + 本地路径两路）。

## 工单十三施工回报（会话列表异步化，四小步各独立提交，待用户实测）

**四小步**（全部落在 panel.ts，piCore 零改动；npm run compile 全绿）：

1. **dcab540 全链路异步化**：collectJsonlFiles/listSessions/readSessionMeta 由
   readdirSync/statSync/openSync/readSync 改为 fs.promises，pickSession/deleteSessionPick
   调用点 await。纯同步→异步机械转换，盲读 256KB/parse continue 原样保留，行为等价。
2. **cb6642d 按需续读替代盲读 256KB**：首块 16KB，已凑齐 name+preview 或文件读完即止；
   末段不以 \n 结尾（截断半行）才 16KB 步进续读，硬上限仍 256KB。停止条件按工单定为
   name+preview（原代码 preview+cwd，补标题优先语义）。解析逻辑抽成 parseMetaLine 复用于多块。
3. **423ec89 parse 失败兑底**：JSON.parse 失败行（大附件行被拦腰截断）不再 continue，
   改用正则抓 name/sessionName 字符串值（注意 \\\" 转义还原）写进 state——修标题永远找不到。
   node 实测截断行/转义引号/无 name 字段三况正确。
4. **174fbf8 mtime 缓存**：模块级 Map<file,{mtimeMs,meta}>，stat 后 mtime 未变直接复用，
   省重复读盘+解析。缓存放 panel.ts 模块级（UI 层职责，不进 PiCore）。

**边界遵守**：只动了本单列出的三函数 + 两调用点；pickSession 的 QuickPick 交互结构与
switchSession/getMessages 渲染链未动；会话删除守卫未动；SessionInfo 结构（展示字段）未变。

**待实测**（需真 vsix 环境）：①冷启动后首次打开选择器也要顺滑不卡 ②此前显示裸文件名的
会话标题能出 ③带大附件的会话（如智谱费用明细 xlsx）标题出得来。

**补刀（249429b，骑线 UTF-8 修复）**：总监验收实验发现步 2 的逐块 toString 会把骑在
16K 块边界上的多字节 UTF-8 烤成 \uFFFD（首字节进一块、续字节进下一块）——旧 256KB
整块读无此问题，本单引入的回归。修法：chunk=concat([carry, 块]) 拼上块残留；splitUtf8
从块尾回扫续字节定位多字节序列首字节判期望长度（110→2/1110→3/11110→4），序列不完整
摘尾存 carry 留下一块，完整部分才解码进 acc；文件读完 flush carry（真损坏交步 3 正则兑底）。
只动 readSessionMeta + 新增 splitUtf8，步 3/4 不动。node 实验：中文首字节在 16383 骑线
clean=true（弥散文字完整、无 \uFFFD）。compile 全绿。

## 〇、工单十一施工回报（路径锚定工作区根，待用户实测）

**实现（单点 + 一处 slice，均在 panel.ts，piCore 零改动）**：

1. **归因入口锚定**（handleRunSettled）：工具命中 `f.path` 先 `path.isAbsolute` 检查，非绝对则
   `path.join(root, f.path)` 锚定工作区根，归一化后入 changesDetail/changesFiles——下游
   diff/还原全链路收直（`openPrerunDiff`/`openHeadDiff`/`revertFile` 拿到的都是绝对路径）
2. **症状二同根因一并修**：旧代码 `relOf(f.path)` 对相对路径做 `path.relative(root, 相对路径)`
   按 ext host cwd 解析得垃圾值（实测：cwd=dist 时 `path.relative(root,'package.json')` 得
   `dist\package.json`，`startsWith('..')` 拦不住）→ nowStatus 查不到 → inHead 误判 false →
   错进 prerun 通道。锚定后 rel=`package.json` 查得到，tracked 文件正常走 HEAD ↔ 工作区
3. **headContent slice 疑点修复**：实证结论——`URI.parse` 的 query 是**编码形态**（只拆分
   不解码，%3A 原样保留），`openPrerunDiff` 用 `encodeURIComponent` 拼的 query 恒为编码串，
   旧代码 `slice(7)` 把 `prerun%3A...` 切出半编码残片 `3Ad%3A...`，decode 后带前导垃圾 →
   changesDetail 查不到 → 左侧白屏；裸冒号分支实际永远走不到。改为统一
   `decodeURIComponent(uri.query)` 后再 `startsWith("prerun:")`，按 `"prerun:".length` 截，
   分歧结论已写进代码注释，两种分支之谜了结

**实证记录**（node 模拟，非门禁脚本）：锚定前 cwd≠root 时 relOf 得 `dist\package.json` 垃圾值；
锚定后 rel=正确相对路径；slice 新旧两法 decode 对比 3A 垃圾/干净。compile 全绿（EXIT=0）

**边界遵守**：piCore 归因结构/事件回调零改动（锚定全在 adapter）；git 兑底路径本就是
join(root, r) 已绝对，没动；裁决 11 还原边界没动；协议三处无新增消息

**等待实测**：需真 vsix 环境验证——让 pi 用相对路径 edit 一个未跟踪/忽略文件，变更条 diff
能打开且左侧「改动前」内容非空；还原内容回退（工单验收原文，实测尾巴见 DIRECTOR.md 未结事项）

## 一、待实测尾巴（合并清单，全部实测通过才可全结）

- **工单十三**：①冷启动后首次打开选择器顺滑不卡 ②此前裸文件名会话标题能出
  ③带大附件会话（智谱费用明细 xlsx）标题正常 ④标题恰好跨 16K 块边界的中文会话名
  完整不花屏（补刀验证点：真实会话骑线 UTF-8 无 \uFFFD）
- **工单十三二刀**：①点历史**立即**有占位响应（加载态不黑屏）②预热后首次点击毫秒级出
  全列表 ③debug.log 三段计时可见（占位弹出/listSessions/内容就绪）
- **工单九**：面板背景图正常显示——合法 http(s) URL + 合法本地路径两条路都通，
  恶意配置（</style> 注入 / 非 http 协议 / opacity 字符串）不带崩或带异常
- **工单六**：①长对话触发自动压缩看横幅 ②阈值预警（contextWarnPercent 调低如 5 验证）+ 一键压缩
  ③横幅手动关闭 + webview 重建后不重发
- **工单七**：pi 改多文件 → diff 列表 → 单文件还原 → 内容确实回滚（建议场景：2-3 文件正常编辑
  看出条/清单/diff；还原 tracked 文件；未跟踪新文件 edit 后还原；非 git 目录降级提示）
- **工单十一**：让 pi 用**相对路径** edit 一个未跟踪/忽略文件 → 变更条 diff 能打开且左侧
  「改动前」内容非空 → 还原该文件内容回退（顺带复验工单七变更条含 gitignore 场景）
- **附件路径模式**：用户实测拖拽附件路径（pi 能读到文件 + 5 个/200KB 限制语义确认）

## 二、技术债（未排期，按性价比排序；演化见 归档.md「八、后续排队」）

1. panel.ts 状态机收敛：18 个可变标志 + 4s pendingPrompt timer hack（做之前先读各标志上的事故注释）
2. applyHtml 同步读大图转 base64（listSessions 链已由工单十三/后续异步化）
3. .vscodeignore 核查收录完整性（0.0.81 事故，test*.txt 清理随 0.0.87 攒包）

## 三、待总监回复的请示（当前无待决，全部裁决完毕；历史存档见 归档.md 9.9）

## 四、给总监的提醒

- 下一版 **0.0.87** 发版即 ship 闸门全流程终验（hunk→commit→push→publish + PI_CONFIRM_SHIP=1 快车道）
- 最新验证包：pi-for-vscode-0.0.87.vsix（根目录）；若需手测先跑 `npm run package` 重新打包
## 工单十三重做施工记录（总监亲施，用户直令越队列 2026-09-14）

用户直令「推翻十三全部修改按原则重做」→ 总监按 ✅活 6 执行并在此留痕。一笔改动（含
补修 c36054e 之后的收尾）：自研扫描整树删除（collectJsonlFiles/readSessionMeta/
splitUtf8/parseMetaLine，grep 零残留）；fingerprintSessions 独立实现（readdir+stat+
FNV-1a，不再依赖备胎）；README 残留行删除；importSession 50MB 检查上移到 .jsonl 守卫区。
compile 全绿；listAll 真目录实测 504-515ms（80 会话）。0.0.90 测试包已打。
