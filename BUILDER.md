# BUILDER.md — 工作记录与交接（pi 维护，总监/后任必读）

> AGENTS.md 只写职责；本文件是**活动工作记录**：当前进度、待实测尾巴、待决请示。
> 已完结工单的施工回报、历史决策与教训已随验收归档到 [归档.md](归档.md)「九、施工回报存档」——
> 交接需复盘历史时去归档.md，本文件只留未完结项。不提交进 git（与 DIRECTOR.md 同）。

最后更新：2026-09-14 工单十五刀2 施工回报（webview 标签栏，待用户实测）

## 工单十五刀2施工回报（webview 标签栏，一笔提交，待用户实测）

**标签机制（核心思路：换 R 即换上下文，渲染链路零改动）**：每标签一份渲染记录
（消息 DOM 根 .msg-root 整棵换入换出 + 流式/工具/排队/附件/横幅/变更条状态），
渲染函数全部读写 R；后台标签的消息经 withInactive 换上下文吃进各自的隐藏 DOM 树，
切回去现场完整（滚动位置天然保留——每标签自己的滚动根）。

1. protocol.ts：TabsMsg（宿主→webview 全量标签清单，宿主是唯一事实源）+ WvTabSwitch/New/Close
   （panel 级控制消息，不过核心）——三处同步齐
2. panel.ts：tabMeta 记账（标题随核心 state、busy 随核心 busy，变化即重发 tabs）；
   标签生命周期（新=只登记元数据核心懒创建；切=busy 允许切走+页脚按标签同步/清空；
   关=busy 先确认再 abort+dispose，关活动标签转移到剩余最后一个，无剩余补空标签）
3. webview/main.ts：机械变换脚本（scripts/migrate-tab-state.mjs）把单标签全局态
   （toolEls/liveMsg/queuedItems/streaming/busy*/queueN/pendingImages/Files/messages 引用）
   迁入 R.* 记录；标签条渲染（busy 黄点呼吸/未读绿点/× 关闭，busy 中 × 常显）；
   applyingInactive 守卫（共享 DOM 只有活动标签可写）；竞态修复：scheduleStream 定时器
   闭包捕获、renderAll setTimeout 捕获记录、图片探测两处异步捕获 rec 写回原标签；
   activateTab 清容器防静态欢迎页双份
4. i18n：tabUntitled/tabNewTitle/tabCloseTitle/tabCloseBusyAsk/tabCloseYes/tabSwitchFail
   （中英 + 关标签确认进 NATIVE_KEYS 双语，同 nsConfirm 口径）；style.css：标签条 +
   .msg-root 滚动根（#messages 退化纯容器）
5. **piCore.ts 零改动**（延续刀1）

**刀1 验收遗留对照**：宿主→webview 单一 post() 出口不变（tabs/state 兜底也走它带标）。

**边界遵守**：单标签行为等价；steering/queue_update 转正、patchRevert/还原边界未动；
关 busy 标签确认走模态（同 newSession 口径）；历史 QuickPick 仍作用于活动标签（刀3 口径）。

**已知留待（刀3 收）**：tabRenders 里已关标签的记录不主动回收（体积小无泄漏路径，
关闭后宿主不再路由该 id，无泄漏增长）；标签输入草稿（input.value）全局共享不按标签。

**待实测（需真 vsix）**：①双标签各跑一个任务互不串流（事件/流式/工具行/附件全隔离）
②切标签不丢流式现场（计时/排队/滚动位置）③关 busy 标签弹确认、确认后资源回收
④后台标签完成亮绿点 ⑤单标签回归与刀1 一致。

## 工单十五刀1施工回报（核心多实例+tabId 路由铺底，一笔提交 8de6f76，待用户实测）

**开工前置冒烟（工单要求，结论已验证）**：scripts/smoke-multiSession.mjs（零依赖，
node 直跑）——pi 0.85.1 同进程双 AgentSession 并发 prompt：两个 session 对象互异、
各自 agent_settled、答案各归各（A 答 2/B 答 4）、事件流零串流。**pi 无单例假设，
进程内多实例方案成立**，无需退回子进程方案；✅活 8 的 rpc-subprocess 分支保留语义不变。

**一笔改动（compile 全绿，toolDetail/patchRevert 用例过，0.0.90 测试包已打）**：
1. protocol.ts：TabTag 附加字段 + HostToWebviewTagged/WebviewToHostTagged——交叉类型
   附加不并入判别联合成员（✅活 2 照守）；tabId 缺省 = 未标归属，宿主按活动标签兑底路由
2. panel.ts：core 单字段改 Map<tabId, PiCore> + activeTabId（初始 t1，刀1 恒单标签）；
   core 变 getter 返回活动标签核心——既有 50+ 引用点零改动，历史 QuickPick/⚡菜单/设置
   天然作用于活动标签（刀3 口径预埋）；ensureCore 创建即接线（post 桥打标 + 工单七
   run 边界回调）；webview→宿主按 tabId 路由（未标/已关标签兑底回活动标签）；
   dispose 回收全标签核心；变更条清账只认活动标签的 state
3. webview/main.ts：tabId 收发桥——宿主消息首见 tabId 定归属、归属不符丢弃；
   webview→宿主统一带标（postMessage 包装器，24 处调用点零改动）
4. **piCore.ts 零改动**：核心保持标签无关（分层铁律），tabId 住 adapter 层

**边界遵守**：单标签行为与现状等价（标签栏 UI 不在本刀，归刀2）；steering/queue_update
转正语义未动；patchRevert/还原边界未动；单实例代码路径仅把字段访问换成 getter。

**待实测（需真 vsix）**：单标签回归——发消息/流式/工具行/切历史会话/变更条与之前一致
（tabId 标全链路存在但对用户不可见）。

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

（当前无待决；工单十五施工归属已由 ✅活 12 裁决——用户指定主力会话发 `222` 开工）

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

## 一、待实测尾巴（合并清单，全部实测通过才可全结）

- **（空，2026-09-14 清账）**：工单六/七/十一/十三（含二刀重做）/九/十四/附件路径模式全部实测通过结单。历史回报见 归档.md 第九节

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
