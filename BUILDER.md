# BUILDER.md — 工作记录与交接（pi 维护，总监/后任必读）

> AGENTS.md 只写职责；本文件是**活动工作记录**：当前进度、待实测尾巴、待决请示。
> 已完结工单的施工回报、历史决策与教训已随验收归档到 [归档.md](归档.md)「九、施工回报存档」——
> 交接需复盘历史时去归档.md，本文件只留未完结项。随台账入库（与 DIRECTOR.md 同，94ff28d 起）。

最后更新：2026-09-20 交接 5——三期整树搬迁落地（main.ts 每页签一个工厂闭包，compile 绿+27/34/12 全过，待实测）

# 交接 5：三期整树搬迁落地（2026-09-20，接手先读本节）

**改动面（单笔提交，仅 webview/main.ts + scripts/migrate-phase3.mjs）**：按交接 4 六步法机械搬迁——
函数体逐字符不动（scripts/migrate-phase3.mjs 按行区间字节级抽取拼接，每段首/末行断言防错位），
只动壳：
- 每页签一个 `makeSessionView(id)` 工厂闭包（自己的 DOM/状态/定时器/输入框/事件），
  换镜机制（useTab/assignMirrors/saveMirrors/curTabId/bgMode/TabCtx）整体删除——白 Working/
  串会话两类事故的根因（镜像漂移）在结构上不可能。1802→1685 行
- routeMsg 缩成三行直达（fillInput 后台拒收保留）；activateTab/handleTabs/renderTabs/
  applyTabSubState/子agent浮窗簇留页面级，经访问器（handleMsg/renderCodeChip/refreshBusy/
  show/isFollowing/forceScrollToBottom/isBuilt/dispose）访问——闭包原始值不走对象属性
- 语义修改仅六处：①scroll bgMode→id 判定 ②applyState 同 ③上行改 vpost 显式带自己 tabId
  ④scheduleStream/scheduleRender 去换镜舞蹈 ⑤built 直写闭包 ⑥codeCtx 页面级数据 +
  renderCodeChipAll 循环各视图
- 死代码清理：busyLabel/subMonUpdate（grep 零调用）；renderInline/renderPlain/renderTable/
  renderRich 留页面级（无状态纯函数，renderSubDetail 浮窗也要用，不属任何页签）

**施工事故教训（本轮新沉淀）**：①首/末行断言会被「行内含 }」的中间行骗过（inputPaste 实际
到 1486 行，seg 切到 1485 丢了收尾括号，tsc 只报 EOF 不报现场）——切函数必须对到真正的
闭括号行，用旧文件 AST 语句边界核对切割点（tools 已删，方法记档）；②长重构绝不在脑内
整体演练后一次性输出（前三轮 Stream ended 无产出死于此），字节级脚本搬运 + 小步 compile
才是正道；③多重集行 diff 是机械搬运的好验收：被删行逐行核对全部属于死代码，新增行
全部属于胶水/变换，零意外

**验证**：npm run compile 全链绿；27/34/12 用例全过；死标识符 grep 零残留

**⚡ 0.1.20 事故（用户实测抓到）**：消息发不出去——壳胶水漏掉 `bindViewEvents()` 调用
（只有定义没人调，事件零绑定全控件死）+ root 滚动跟随监听同批漏掉。教训：函数定义与
调用点必须成对核对，编译器查不出「合法存在但没人调」；修复 abb482a，0.1.21 已打包。

**待实测（需重载窗口，对齐交接 4 第 6 步）**：①流式中切页签、后台完成切回 ②双页签双模型
③stop 键/Esc 中断落在正确页签 ④0.1.19 遗留实测点（交接 4 的 ①~④）全部适用

**工单队列**：27/28/29 仍未动。

# 交接 4：白 Working / 串会话双事故 + 三期方案（2026-09-20，接手先读本节）

## 用户实测症状与根因（都已实证，别再猜）

1. **白 Working（另一页签挂白字 Working 走秒，会话结束后残留不走但也不清）**：
   busyTicker 闭包（renderBusyUi 里 setInterval）原来写**全局镜像 statusEl**——镜像漂到哪个
   页签就写谁的状态行，且只写文本不动 class（蓝 Working=.busy 类，白字=无类），那个页签
   不 busy 便永远没人写/清它。修复 897ce40：ticker 只写自己页签 ctx 的 statusEl（元素引用
   随 ctx 走，不碰漂移中的全局镜像）+ `!me.streaming` 自愈自杀（clearInterval 只清自己捕获的
   timer id，**别改成清全局 busyTimer**——漂移时那可能是别人的 timer）+ activateTab 切回时
   renderBusyUi() 重渲清残留。
2. **「我切了会话，另外的会话也变成了你好」**：pickSession 的跨标签占用守卫漏了
   「活动标签自己持有 + busy」分支——break 落到 busy 分支 handleTabNew，同一个 jsonl 开进
   第二棵页签（双写者），两个页签同名同内容。修复 b59ee4c：活动持有且 busy → 提示
   sessionOpenHere 即收，绝不开第二棵。busy 中选**其他**会话开进新页签的语义不变。

## 验证与现状

- compile 全链绿 + 27/34/12 用例全过；0.1.19 已打包**已装机待重载实测**
- 实测点：①A 页签跑任务时切到 B 页签看——B 状态行应空（不再白 Working 走秒）；②A 结束后
  B 无残留；③busy 中开历史选当前会话 → 提示「已在本页签打开」不开新页签；④回归：正常
  Working 计时/停止键/切页签各归各
- 本轮罚记：会话尾部上下文将满时硬做 1787 行整树重写，反复读文件绕圈烧上下文——大重构
  必须在会话前段做，尾部只做小刀止血

## 三期整树搬迁方案（用户定调「一个会话一个DOM一个pi后端」，下个会话一次做对）

**目标**：拆掉 main.ts 全套换镜机制（useTab/assignMirrors/saveMirrors/curTabId/bgMode），
每页签一个完全隔离的 SessionView 工厂闭包（自己的 DOM/状态/定时器/输入框），routeMsg 变
`viewFor(tid).handleMsg(m)` 一行直达，串写在结构上不可能。宿主侧已达标不动（cores Map，
一页签一 PiCore 一 pi 进程）。

**机械搬迁法（本轮已验证可行的路径）**：函数体逐字符不动，只动壳——
1. 把「每页签」全局变量组（toolEls…queuebarEl 约 35 个 + followingEnd/suppressScroll）
   声明挪进 makeSessionView(id) 工厂顶部；全部页签级函数（scroll/setBusy/renderBusyUi/
   setCompacting/renderBanner/renderChanges/addUser/queue 族/live 族/toolStart/End/notice/
   renderAll/fmtSession/applyState/handleFiles/renderAttach/suggest 族/send/autoSize/
   inputKeydown/inputPaste/scheduleStream/scheduleRender/flushRender/applyLiveSync/handleMsg/
   renderCodeChip/bindViewEvents）**原体搬进工厂**——闭包变量与旧全局同名，函数体零改动
2. 函数内只改这些点：①scroll() 的 bgMode 判定 → `id !== activeTabId` return；②applyState
   的 `if (!bgMode)`（页头标题）→ `if (id === activeTabId)`；③视图内 `vscode.postMessage` →
   `vpost(m)`（显式带自己的 tabId，不再借活动页签打标——stopBtn/abort/pickModel/queuedRetrieve/
   banner 按钮/changes 按钮/retryFromLast/attachUri/attachFile/getSlash/getFiles 全在内）；
   ④scheduleStream/scheduleRender 去掉换镜舞蹈（闭包变量天然绑定）；⑤uiState/render 分支
   `tabCtx[curTabId].built` → 自己的 built；⑥codeCtx 分支改「codeCtx 页面级数据 + 循环
   各视图 renderCodeChip」
3. routeMsg 缩成三行（fillInput 后台拒收保留）；activateTab/handleTabs/renderTabs/
   applyTabSubState/子agent浮窗簇留页面级（activateTab 改调 v.renderCodeChip()/v.isFollowing()
   /v.forceScrollToBottom()/v.isBuilt()——闭包原始值不能走对象属性暴露，必须方法访问器）
4. 文档级点击监听（plusmenu 关闭）改每视图一份各关各的；window drop 路由到活动视图的
   handleFiles；dispose() 清三 timer + 摘 DOM
5. 顺手清死代码：busyLabel、subMonUpdate（grep 零调用已实结）；linkifyEnabled 留页面级
   （renderAll 同步执行无交错）；slashCmds/workspaceFiles 留页面级缓存（闭包可写）
6. 每步 compile+27/34/12 用例验证；打包实测重点：流式中切页签、后台完成切回、双页签双
   模型、stop 键/Esc 中断落在正确页签

**工单队列**：27/28/29 仍未动（工单27 的 appendSystemPrompt 注意与新架构的 prompt 组装
无关，宿主侧不受三期影响）。

# 交接 3：二期「下区整棵 DOM」+ 双事故修复（2026-09-20，接手先读本节）

## 本轮做了什么（全部已 commit，未 push）

- `738ca6e` 架构归位二期（用户定调「下区整个一坨应该每页签一整棵 DOM」，逐字执行）：
  #session-area 每页签一棵 `.session-view`（原型 innerHTML 克隆），横幅/变更条/消息流/排队
  条/状态行/输入区/页脚全在内；后台页签整块隐藏但控件活渲染；切页签=换 display O(1)；
  bgMode 守卫族整体拆除；输入草稿/附件随页签走。页面级共享：头部/标签条/子agent浮窗/
  codeCtx 数据（chip 元素在各视图内）
- `889452b` 双事故修复：
  - **停止键消失**（0.1.17）：二期把渲染函数改成读 ctx 字段但 setter 仍写全局镜像——
    setBusy(true) 写全局 streaming，renderBusyUi 读 my.streaming 永远旧值 → 停止键/计时
    全死。修法：确立不变量「**全局镜像=镜像当前指向页签的运行时真相**」，routeMsg 处理完
    saveMirrors() 落账 + useTab 换镜前落账；三个定时器闭包（busyTicker/scheduleStream/
    scheduleRender）触发时先 useTab(stid) 换回发起页签再干活（动态值 queueN/streaming/
    compacting 从 ctx 读唯一真相，busyStart 捕局部）
  - **串项目**（0.1.17）：piChat.tabBar 存 globalState 跨项目共享，A 项目标签长进 B 项目。
    照 lastSessionByWs2 模式分桶 piChat.tabBarByWs（cwdKey 小写），旧 key 按当前工作区
    一次性收编
- 验证：compile 全链绿 + 27/34/12 用例全过，0.1.18 打包并装机；vsix 内新 webview 判据
  （needState/offview）已验

## 未结事项（接手第一优先）

1. **0.1.18 已装待重载实测**：①发消息→Working 计时跳动+停止键出现+点停生效；②多项目
   窗口标签栏不再互串；③切页签各归各（双页签双模型/排队/横幅）；④切历史会话页脚保持
   页签自选模型（上轮 93a96ee 遗留实测）
2. **用户质疑「你这不是一个dom吧?」未定性**：已回复架构清单+问症状，用户未答。若重载后
   仍见 DOM 串写/状态丢：按「镜像漂移」方向查——搜 main.ts 里还有哪些 setTimeout/
   setInterval 闭包读全局镜像没先换回发起页签（pendingStream 路径已修，其他 timer 逐个审）
3. 直令推翻刀5（✅活 6）待总监追认；二期 738ca6e + 修复 889452b 待验收结单
4. 两笔 commit 未 push，等用户指令；工单队列 27/28/29 未动

## 事故罚记（本轮）

- 0.1.17 双真相事故根因：二期重构「半途而废」——渲染读 ctx 但 setter 写镜像，两套真相
  没收敛就打包。教训：改状态架构必须一次性把「谁是真相」定死再动手，编译器查不出
  语义分裂
- tabBar 跨项目事故：restoreTabBar 注释里自己写着「可接受」（当旣陈词可被覆盖），实际
  用户实测不接受。教训：注释里「可接受/容忍」级别的取舍，发版前当未决项过一遍

## 直令修复留痕（✅活 14）：切会话后页签自选模型被顶掉（93a96ee，0.1.16 已装）

用户报「为啥一切会话 下面的模型就变了」：切历史会话后页脚显示该会话存的模型
（Free Models Router），页签自选的 GLM 被顶掉。根因：刀3 每标签模型记忆只在启动/新建
补回，且启动处是与 switchSession 并行的 fire-and-forget（竞态）；pi 的 switchSession
会把模型重置为会话文件里存的值。修法：补回收口 piCore.applyModelMemory，四条链路
（启动恢复/切历史两条/新建/reload）统一在 switchSession **之后**调用。
验证：compile 全链绿 + 27/34/12 用例全过。**实测待用户**：切历史会话后页脚应保持
页签自选的模型（没自选过的页签跟随会话/默认，不变）。

## 工单24 架构归位【实测通过，2026-09-18】

用户原话：「非常完美——之前改了那么多都没按我说的方向改正确，一把就改好了。」
压测现场：流式生成中连切页签，切回内容完整、瞬切不卡、后台照常累加。两笔提交：
止血刀 3d6a448（快照语义实证重写）+ 架构刀 4530c5d（每页签一棵 DOM，推翻刀5），
均 compile 全链绿 + 27/34/12 用例全过，0.1.14 装机实测。待总监：①追认直令推翻刀5；
②工单24 修法定稿按「零剥离+窗口丢弃+消费端延后一拍 + 每页签一棵 DOM」口径写；
③工单24 结单迁归档。

## 工单24 第二刀：架构归位（4530c5d，用户直令「推翻这个设计」，✅活 6 待追认）

**直令原话**：用户看穿「切页签机制不对，每次都在重新拉而不是累加」，问「一个会话一个 DOM
容器不好吗？」→ 指令「推翻刀5 切回即重拉的设计」。此为刀5 设计决策的推翻，总监追认时请
连同工单24 首版回放实现的偏差裁定（见下节）一并定。

**实证前置（scripts/probe-inflight.mjs，保留备查）**：pi 探针实测——在途 assistant 消息
在 message_start/update 期间**不在 session.messages**（state 尾条仍是上一条已完成消息），
message_end 才入 state；事件 message 对象全量 in-place 递增。刀5b 注释「message_start 起
就在 state 里」系讹传，是此前一切「剥末条」方案丢内容的总根。

**改动面**（webview/main.ts 主体 + panel.ts 路由 + protocol WvTabSwitch.needState +
style.css .offroot）：
1. 每页签一棵 .msg-root 常驻 #messages，非活动 .offroot(display:none)；切页签=换可见性
   O(1)，滚动位置天然保留；后台页签流式事件写进自己的隐藏树（现场累加，切回即现）
2. TabCtx 记账 + 全局变量组降级为「当前换镜」（useTab 保存/恢复，后台处理完立即换回）；
   页面控件只为活动页签渲染（bgMode 守卫族：setBusy/setCompacting/renderStatus/
   renderBanner/addQueuedDom/removeQueued/renderNativeQueue/applyState/scroll）
3. 定时器 ctx 安全：scheduleStream 换镜到发起页签再 tick；flushRender 按页签各清各的
   待渲染，清完归位活动页签再放行延后队列（pendingStream 走 routeMsg 重路由）
4. 切页签零重拉的唯一例外：webview 未建树页签随 tabSwitch 带 needState 要一次快照
   （webview 重载恢复/重启恢复页签/新页签空态）；webviewReady 给所有已建核心各发快照
5. panel.pipeFromCore 废止「后台不喂」，只挡 notice/status/fillInput；
   handleTabSwitch/handleTabClose 删盲发快照；已关页签的树随手回收

**验证**：compile 全链绿；27/34/12 用例全过；0.1.14 打包并已装（待重载实测）。

**待实测（需重载窗口）**：①快流式生成中连切页签 ≥10 次，切回内容完整（根因已实证，
应彻底治愈）②切页签速度感：O(1) 换根，不再卡几百毫秒 ③后台页签跑完，切回即见全程
现场 ④每页签滚动位置/排队条/横幅/页脚各归各 ⑤关页签/新页签/重启恢复不串台。

**已知取舍（记档）**：①编辑框附件/草稿仍页签共享（刀2 起既状，未扩scope）②页脚数据
靠 applyState 记账，后台页签页脚在切换时按最后一条 state 消息渲染（state 到达频度足够）
③已关页签树随手回收，但跨重载不恢复（与浮窗账本同口径）。

## 工单24 第一刀（止血）：快照语义实证重写（3d6a448，已提交）

**实证**：见上节探针。首版（594bfcb）的「T0 基线+全量回放」两处硬伤：①基线计数按
「在途消息在 state 里」假设推的 stripFrom 全错（剥掉上一条完成消息=整条消失，即用户
报的「啥也丢」）；②20ms yield 被长会话重绘顶穿（回放事件先落地再被 renderAll 冲掉）。
**重写**：历史=session.messages 全量零剥离 + live=在途消息全量深拷贝（同一同步块取，
事件插不进来）→ 不重不漏；窗口内事件丢弃（全部≤快照时刻已被覆盖，gate drop dbg 留
清单）；快照之后的事件由 webview 侧「重绘期延后一拍」兑底（pendingStream，顺序保证
落在消费端）。单飞保留。postUiState 此语义在架构刀后仍服务 webviewReady/压缩/换会话
路径，两刀不冲突。

**⚠ 工单24 首版（594bfcb）与工单字面的偏差报告（随架构刀一并作废，总监验收时请知悉）**：
首版曾按工单字面实现「uiState 后按序重放」，实测丢得更狠（上逑②），已随 3d6a448 推翻。
工单24 的「保序回放」修法以实测证伪告终，最终落地形态是①零剥离+②窗口丢弃+③消费端
延后一拍，请总监在 DIRECTOR.md 定稿时以此为准。

## 工单24 施工回报（594bfcb，首版，已被 3d6a448 实证推翻，存档对照）

**改动面**（全部宿主侧，webview/main.ts 与跨边界消息零改动）：

1. **post 出口闸门**（piCore）：postUiState 入口关闸，窗口内流式/状态事件 FIFO 入队不直发；
   uiState 本身 + notice/status/交互应答类直发（GATE_PASS_TYPES 一处分流，不逐 case 打补丁）；
   所有 this.post 调用点零改动（构造器包一层）
2. **基线冻结**：闸门关闭瞬间读消息条数（新增 piClient.messageCount()）+ 真在途消息深拷贝。
   新增 liveStreaming 标记（message_start 置位 / message_end·agent_start·settled 清除）——
   liveMessage 引用在工具窗口期是 stale 的（指向已完成消息），直接信它会双画；
   protocol 新增 PiMessageEndEvent（pi 在 finalized 消息入史后才发，agent-session.js:454，✅活 2 独立接口）
3. **uiState 按基线截断**：在途消息占基线末位，它与其后窗口内新增消息全部剥离，由
   基线 live + FIFO 回放重建；截断点之前已完成消息不可变，快照取晚也不失真
4. **回放前 yield 20ms**：webview 对 uiState 的重绘本身延后一拍（flushRender setTimeout 0），
   回放 delta 必须等重绘落地，否则被 renderAll 冲掉（基线@T0 不含它们）
5. **postUiState 单飞**：窗口期再入标重跑（最新真相重拉），连切页签重叠快照互冲消失
6. **回放分流**：toolStart 若其 toolCall 已在快照历史（行已绘出）跳过（防重复建行 +
   toolEls 覆盖留僵尸行）；toolEnd 必回放（其 toolResult 必在剥离区，重放恰好把
   renderAll 画出的运行中行收尾）；其余全量保序回放
7. **实证日志**（工单验收要求，修完可留）：`gate replay: window=… buffered=… types=[…]`
   dbg 行，窗口期捕获的事件清单全在这行

**⚠ 一处执行偏差，请总监验收裁定**：工单修法原文「uiState 发出后解除缓冲按原序重放」，
live 字段未指明取哪个时刻。施工推演发现：若 live 取拉快照时刻（T1，原实现取法），
窗口内 delta 已 in-place 进了 liveMessage，回放它们就是同段内容画两遍——正好踩中
工单十八「切页签整段内容×2」回归红线。故改为：**live 基线冻结在闸门关闭瞬间（T0）**，
配套 uiState 按基线计数截断历史（剥离区恰好=窗口事件影响区，回放不重不漏，
逐字满足「FIFO 不得去重合并」）。保序回放语义不变，settled 真相重绘自愈不变
（重放的 settled/render 在快照之后执行）。请总监确认此偏差是否接受。

**验证**：npm run compile 全链绿；toolDetail 27/27、subagentSnapshot 34、patchRevert 12/12；
pi-for-vscode-0.1.13.vsix 已打包。单笔提交 594bfcb（DIRECTOR.md 总监签单 hunk 未混入）。

**待实测（主验收，对齐验收标准）**：快流式模型生成中连切页签 ≥10 次，来回切、
切走再切回，面板内容与 jsonl 对账无缺；空黑条不复发；回归红线：工单十八
「切页签整段内容×2」不复发。dbg 日志开著，实测后可贴 gate replay 行佐证窗口事件被接住。

**顺手发现（记档不混笔）**：①恢复会话（restoringSession）与流式重叠时，旧会话
恢复窗口内的 delta 会回放到新会话渲染上——极窄且是恢复+后台续跑叠加的既存混沌场景，
基线重取逻辑已把损害限制在一次性重绘，未立项；②窗口内触发压缩重建消息数组时
slice 钳位不越界，代价由 settled 全量重绘自愈（代码注释随逻辑走）。

## 直令施工回报（2026-09-18，用户「你直接干」越队，✅活 6 留痕待追认）

**工单25（幽灵行第二轮，piCore.ts 单点）**：tool_execution_end 的 subagent 分支加异步壳
判定——finalSnap.tasks 任一 running 即视为异步派发返回值载荷（扩展 index.ts:909
asyncDetails(run)），发 closed 删行；同步路径零回归。验证：compile 全链绿 + 三个脚本用例
34/12/27 全过；实测待用户（异步派 2 任务 → 已开启清空、同任务单行）。

**工单26（排队回报不可见）**：预查实证 queue_update 事件自带 followUp 文本数组
（agent-session.d.ts:51），piCore 已 post 给 webview 但只被计数。修法纯 webview：
queue 消息命中回报前缀的项在 queuebar 渲染专用 pill（⮑ 子 agent sa-N · 完成 ·
agent名 · 排队中，左缘紫条），i18n 两语。已知取舍：uiState 不带 followUp 数组，
切页签后 pill 短暂消失待下一个 queue_update（计数仍在），注释随代码。**实测通过：
忙时回报排队 → queuebar 紫色 pill，用户实物验证（09-18 截图）。**

**债务④ 历史重放（同日续做，0.0.122）**：postUiState 空闲时按会话文件回放
subagent-async entry 帧（2MB 尾窗、终态帧优先、每文件一次），浮窗重载后回填
「完成·N」列表 + 头部指示按钮。解析器对真会话文件干跑：24 帧→3 运行全对。
已知边界：2MB 尾窗之外的更早运行不回放；busy 时不放（防旧纪元同句柄覆写）。
验证：compile 绿；实测待用户（重载后浮窗应列出本会话历史运行）。

**补同步通道（同日，0.0.123，用户点破）**：subagent-async 帧只盖异步；同步（自然语言
分流默认）正本在 toolResult.details（返回时已跑完，不空壳）。重放两源合并，空壳防御
（results 空或首任务 messages=0 跳过）实捞验证 4 空壳全拦；快照含 running 不投。
干跑：24 异步帧→3 行零误报。验证：compile 绿；实测待用户。

**0.0.125 修正**：SVG 图标显示成源码——el() 是 textContent 安全写入，ico() 标记需走
innerHTML；加 elIco 助手替换三处调用点（排队 pill 原本就是 innerHTML 写法未受影响）。

**0.0.126 修正**：重放去掉 2MB 尾窗改全文件扫描——长会话尾部 2MB 只装得下最后一个
纪元，历史运行被截（用户实测「列表里只有一个调用记录」）。已知取舍：同句柄跨纪元
重用折叠为最新一行（live id 对齐所需，Codex 式逐次列出需重设计 id 命名空间，未做）。

**追加两笔（同日直令，同属本组）**：① 回报卡片实时上屏——回报的 message_start（user）
此前被无视，卡片延迟到 settled 重绘（用户实测「先思考后卡片」倒序）；修：message_start
遇回报前缀 user 消息立即 post（只认前缀防双渲染）。② 紫色 pill 排队语义澄清：插话
优先于 followUp 为 pi 原生语义，pill 使其首次可见，非 bug。验证：compile 全链绿；
0.0.121 已打包，实测待用户。

---

## 历史回报（已完结部分随验收迁 归档.md「九」）

最后更新：2026-09-15 工单二十一施工回报（compactionSummary 折叠块，待用户实测）

## 工单十七施工回报（滚动跟随，一笔提交 fdc32aa，待用户实测）

**改动面（签单边界内，仅 webview/main.ts 14 行）**：

1. **followingEnd 状态 + passive scroll 监听**（滚动根 = .msg-root，工单十五刀2 确认）：
   距底 ≤48px 视为在底。TUI 用 `next === maxScrollTop` 精确等值，DOM 给容差的两个原因
   （内容增长不触发 scroll 事件/程序化拉底像素容差）已注释随逻辑走（签单要求）
2. **scroll() 仅跟随时拉底**：函数体一处收口，节流 tick/气泡/notice/工具详情等全部
   调用点零改动（签单要点 2）；liveRTimer 节流周期/streamTick 未碰（不许顺手改清单）
3. **主动动作回底**（签单要点 3）：addUser 发消息、fillInput 两处置 followingEnd=true；
   第三处是 queuedRetrieved（工单十六取回）——签单行号只点了 fillInput(:1037)，但验收
   标准明写「取回排队消息 → 回底」，取回分支是同性质主动动作，按验收条加上（非顺手改）
4. **不做浮标**（签单要点 4）：TUI 无此 UI，未自研；协议三处不动（纯 webview 内部）；
   ES5 var 风格；busy 不整页重绘红线不受影响（跟随判定只在 scroll 事件与 scroll() 内）

**验证**：npm run compile 全绿；pi-for-vscode-0.0.92.vsix 已重打。

**待实测（对齐验收标准）**：①流式中上滑：停在读历史位置，新 token 不拽人；滚回底部
→ 跟随自动恢复 ②流式中不滚动：与现状一致（钉底跟随，无闪烁/跳动）③发消息/取回排队
消息 → 回底 ④切页签回归（工单十五现场不受影响）。

**一个已知交互边界（记录不立项）**：followingEnd=false 时切走页签再切回，重绘后停在
顶部而非底部（重绘重建 DOM scrollTop 归零，且不强制拉底）——用户上滑读历史切走再回
来，停在顶部反而符合「我在读历史」的意图；若用户实测觉得别扭再立项。

## 工单十六施工回报（排队消息「取回到编辑框」，一笔提交 617baca，已结单）

**实现形态（与签单要点逐条对账）**：

1. **类型感知**：queued 镜像加 `kind: "steer"|"followUp"`——插件链路入队一律
   streamingBehavior:"steer"（发送时即知，sendPromptCore 内注释留痕）；保留集以
   **clearQueue 返回的 pi 快照为准**（镜像可能滞后于 agent 取走），qid/气泡文案从镜像
   找回，镜像没有的项（扩展直入 pi 队列）用原文兑底自建
2. **重排队保序**：busy → session.steer()/followUp() 按原类型直入（steering 先于
   followUp 由 pi 队列结构保证，各队列内部保序）；idle → 第一项走 prompt 链路、其余
   照常排队——**实查 pi 源码：session.steer 对 idle 只入队不下跑**（agent.steer =
   steeringQueue.enqueue，下一轮 run 消费），不会开出第二个 run
3. **抑制窗口（签单外必要新增）**：clearQueue/重排队自己会触发 queue_update，若不抑制
   会被既有「队列变短=已取走」逻辑误判 → 保留集还没重排队就被转正成用户气泡。
   retrieving 标志期间 queue_update 只记账；收口对账由取回事务自己做：pi 队列现状
   （getSteeringMessages/getFollowUpMessages 同步真读）+ 历史比对后 queuedDelivered——
   防 steer 中途被取走后队列条永久残留（steer 送达不触发 agent_start，错过事件无兑底）
4. **竞态（签单第 3/验收条）**：取回目标若已不在 pi 快照 = agent 刚取走 → 不回填编辑框
   （回填=重复发送），发 retrieveTaken 通知，队列条交还既有转正链路收口
5. **idle 首项复用链路**：prompt 发送核心抽成 sendPromptCore（乐观 busy/4s 兖底/steer
   自愈/自动命名逐字符移植，仅 m.images/m.files 换参数），prompt case 只留斜杠拦截与
   附件组装——steer 自愈正则/4s 兑底语义零改动（红线遵守）
6. **协议三处同步**：queuedRetrieve{qid} 上行 / queuedRetrieved{qid,text} 下行；
   webview 合入编辑框（非空时换行追加，不覆盖正在输入的内容）；queuebar 条目加
   取回按钮（back 图标，{{t:queuedRetrieveTitle}} 中英 tooltip）
7. **图片项已知局限**（签单第 5 条）：取回仅还原 sentText（含附件胶囊块——文件附件
   本就拼在文本里所以不丢），图片丢失，注释已在 retrieveQueued 头部留痕

**验证**：npm run compile 全绿；toolDetail 27/27、patchRevert 12/12 过；
pi-for-vscode-0.0.92.vsix 已重打。红线四项（steer 自愈正则/4s 兑底/还原边界/
queue_update 转正本身）零改动——queue_update 仅加抑制分支（本单实现点，非顺手改）。

**施工中发现一笔既有债务（未混笔修，报总监定夺）**：webview/main.ts renderAll 尾部
（709 行）`for (rq < queuedItems.length; rq++) addQueued(queuedItems[rq])` —— addQueued
会 push 回同数组而 for 条件用同一 length：排队项非空时若触发整页重绘（postUiState 的
render 延迟一拍，晚于 queuedAdd）会**死循环 + queuebar 重复 DOM**。远古代码（panel.ts
抽出时就带着），与本单无触发交集（取回流程不发 render），建议另立小刀：该循环删除或
改为 addQueuedDom 前先清 queuebar。

**待实测（需真 vsix，对齐验收标准）**：①流式中排队 3 条 → 取回中间 1 条：文本回编辑
框、另 2 条按原顺序留队列条且 steering 仍先送达；期间无整页重绘、流式不闪断 ②取回含
图项：文本还原、无报错（图丢失为已知局限）③竞态：取回瞬间 agent 正取走一条 → 不重复、
不丢、queuebar 与 pi 真相一致 ④取回时编辑框已有草稿 → 换行追加不覆盖

## 工单十五刀3施工回报（会话语义，一笔提交，待用户实测）

**piCore 新增公共字段 tabKey**（panel ensureCore 创建时赋值，默认 t1）：核心只把它当
持久化键，不感知 UI 标签语义——分层铁律不破（不 import vscode，无 VS Code 类型）。

1. **lastSessionByWs 按标签**：新键 `piChat.lastSessionByWs2`，value
   `{工作区: {tabKey: 会话文件}}`；旧键只读迁移——t1 兑底沿用存量（首条
   switchSession 后 setSessionForWs 自然写入新键），其余标签不抢旧值（避免多标签
   启动互踩同一恢复目标）；旧键不再写，可回滚
2. **模型/思考记忆按标签**：`piChat.lastModel.<tabKey>` / `.lastThinking.<tabKey>`；
   旧全局键只读兑底（没自选过的标签跟随最近一次全局选择）——panel 侧选择时
   每标签键 + 全局影子写双落，helper 收口（lastModelFor/lastThinkingFor），
   ensureClient 恢复与 newSession 补回两处共用
3. **picker/删除守卫（工单边界落地）**：pickSession 头部 busy 守卫（busy 标签禁切
   历史，同 HANDOVER 双窗口教训）；同一会话文件禁止被两个标签同时打开（跨标签
   占用检查，双窗口写冲突等价场景）；deleteSessionPick 守卫从「活动标签」扩到
   「任意标签持有」
4. **sessionMode 回退铁律不变**：piCore ensureClient 与 panel resolveWebviewView
   两处 default 仍同为 "continue"（grep 验证）；其余语义（steering/queue_update、
   patchRevert）未动
5. i18n 新增 tabBusySwitch/sessionOpenInTab（中英）

**边界遵守**：busy 禁删/禁切已落地；单标签行为等价（t1 键值迁移后语义一致）；
新标签未自选模型时跟随全局最近选择（兑底语义明确记录）。

**待实测（需真 vsix）**：①两标签各自切不同历史会话，重启面板各恢复各的 ②t2 换模型
不影响 t1 的模型 ③A 标签 busy 时切历史被拒并有提示 ④B 标签已开的会话在 A 标签
picker 里被拒 ⑤删除被任意标签持有的会话被拒 ⑥单标签回归与刀2 一致。

## 工单十五刀2b施工回报（总监验收两处必修，一笔提交，纯 webview/main.ts）

1. **mode 徽章串显修复**：modeText 迁入每标签记录（R.modeText，newTabRender 兑底
   'Auto'），handleMsg 'mode' 分支写 R，restoreRender 从 R 恢复——A 标签切 Plan
   切到 B 仍显 Plan 的串显根治；无宿主参与，新标签天然兑底
2. **'render' 延迟回调漏守卫修复**：setTimeout 回调内触发时按现状补
   applyingInactive = recR.id !== activeTabId（触发时已切回活动则正常渲染；
   已切后台则排队项不写共享 queuebar）；保存/恢复外层 applyingInactive 不踩嵌套

边界遵守：只动 webview/main.ts（总监工单边界），piCore/panel/steering 未动。

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

1. **webview renderAll 尾部 queuebar 重建死循环隐患（工单十六施工发现，待裁决）**：
   `for (rq < queuedItems.length; rq++) addQueued(queuedItems[rq])` —— addQueued push 回
   同数组而条件用同一 length：排队项非空 + 整页重绘（postUiState 的 render 晚于 queuedAdd
   到达）时死循环 + queuebar 重复 DOM。远古代码，与本单无触发交集；修法：删该循环或改
   addQueuedDom 前先清 queuebar（详见工单十六施工回报）
2. panel.ts 状态机收敛：18 个可变标志 + 4s pendingPrompt timer hack（做之前先读各标志上的事故注释）
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

## 直令留痕（✅活 6，2026-09-15，总监亲施：取回按钮图标换删除图标）

用户直令「撤回按钮语意不清，改成删除图标，功能不变，你直接改」。改动：webview/main.ts
ICON_PATHS 新增 trash（stroke 风格与现有图标一致）、取回按钮 ico('back')→ico('trash')、
back 键删除（唯一调用点已换，避免死数据）；实现处注释留痕「功能不变仍是取回，别改行为」。
compile 全绿。工单十六同日结单（用户实测「可以撤回效果不错」），全录迁归档.md 9.11。

## 工单十九施工回报（80f1d1f，2026-09-15）

**改动**（纯 panel.ts，+93/−34）：
1. **pickSession 秒开快路径**（工单定案照做）：`listAllSlot` 有槽 → 立即用上次结果弹列表
   （无 loading 占位），后台 `listAllCached()` 做指纹校验——命中（返回引用 === 槽内 result）
   即结束；未命中则内部已重算 listAll 入槽，**原地更新同一 picker 的 items**，不重弹不重置
   选中，`activeItems` 保持同 file 项（验收点 3）。无槽真首次 → 占位 busy 路径照旧（验收点 4）。
2. **toSessionInfos 抽函数**：listSessions 的「投影→展示条目」变换（cwd 过滤+mtime 缓存+排序
   +截断）抽成纯函数，秒开快路径与占位慢路径共用——scope 过滤/排序行为由同一份代码保证
   不漂移（工单注意事项逐字落实）。
3. **pickerClosed 守卫**：onDidHide 置位，用户关掉选择器后后台刷新不再碰已 dispose 的 picker；
   后台刷新 catch 吞错维持旧列表（不打扰用户）。keepAlive 监听随 picker 一起收尸。

**边界遵守**：指纹算法（FNV-1a/walk）、mtime 缓存、预热链路、deleteSessionPick、switchSession
渲染链全未动；piCore/webview 零改动（纯 panel.ts）。 dbgLog 加了两条计时点（缓存秒开/后台刷新）。

**compile 全绿**（vite ✓ tsc --noEmit ✓）。单笔提交 80f1d1f，无混笔。

**待实测**（需真 vsix 环境）：
- ①会话已加载状态点历史：列表毫秒级出现，无「正在加载会话…」
- ②新会话产生后再点历史：列表反映最新，已打开的 QuickPick 不闪不重弹
- ③刷新完成前已选中某项：选中保持（activeItems 同 file 项）
- ④冷启动首次点历史：照旧占位→填充

## 工单二十施工回报（287bb04，2026-09-15）

**改动**（2 文件，+6/−2）：
1. tsconfig.json 加 `"removeComments": true` → out/*.js（宿主侧产物链）不再携带源码注释
2. vite.config.mts `minify: false→true` → dist/webview/main.js（webview 侧产物链）去注释。
   选型依据：esbuild 没有「只去注释、不压缩」的独立开关（legalComments 只管 legal 类，
   源码普通注释在 minify:false 下实测保留）；原 `minify: false` 无注释说明存在理由，
   产物是 CSP nonce 注入的内联脚本且不开 sourcemap，可读性无调试收益——连同注释、
   region 标记与体积一并解决

**中途用户纠偏留痕**：施工中曾自认「minify 超出指令范围」回退为 false，随后实测证伪——
minify:false 时 webview 产物带 12 处真实源码注释（含「工单六/七」内部信息），且
removeComments 管不到 vite 链路；经用户确认「有必要的话可以加上」后恢复 true。

**验证**：
- `npm run compile` 全绿（typecheck ✓ vite ✓ tsc ✓）
- 0.0.93 测试包解包：注释关键词（工单十/steering 自愈/兜底/事故）+ 行首注释语法零命中；
  唯二命中均为误报/工具元数据——`findFiles("**/node_modules/**")` 的 glob 字符串、
  指向 .map 的 `sourceMappingURL`（map 本身被 .vscodeignore 排除不随包，本地 F5 依赖，不动）
- 尺寸：piCore.js 84980→52533、panel.js 99205→72741、main.js 92178→65150；
  vsix 解包总 399075→291645（−27%）
- README_EN.md 在包内（按用户裁决保留，readme.md 引用未断）

**边界遵守**：源码注释一字未动；.vscodeignore 文档排除项未动；单笔提交，DIRECTOR.md
（总监签发 hunk）留在工作区未混入。

**待实测**（需真 vsix 环境）：本地装包开面板——webview 经 minify 后行为应无差异，
重点过一遍：发消息/中断/steering/历史会话/还原按钮。

## 工单二十一施工回报（09dbea2，2026-09-15）

**改动**（2 文件，仅 i18n.ts + webview/main.ts；协议零改动）：
1. **webview/main.ts renderAll 补 `role==='compactionSummary'` 分支** → `makeCompaction(m)`
   折叠块：复刻 makeThink 的 details/summary 原生折叠交互，样式走现有 .think/.think-body token；
   默认收起（details 不带 open），收起态文案含 tokensBefore（toLocaleString 千分位）；点击展开用
   renderRich 渲染 m.summary（markdown，走既有 md 渲染）+ linkify（renderAll 尾部 15 条窗口内生效）。
2. **i18n.ts 新增 compactionSummary 一条，中英各一份**（webview 侧 L.xxx，非原生对话框，不进 NATIVE_KEYS）。
   收起态文案：「⌄ 上下文已压缩，此前历史已折叠为摘要（原 {n} tokens）」/ 英文对应。
3. **pi 原生查重已核**：pi TUI `CompactionSummaryMessageComponent`（interactive-mode.js:2934）就是
   `[compaction]` 标签 + collapsed/expanded 两态，收起态 `Compacted from {tokens} tokens`、展开态含摘要——
   壳对齐该语义，非新造能力；不读 jsonl 不加「完整历史」入口（工单边界照守）。

**字段来源已实测确认**（对账 pi 源码 + aaaxcx 会话 jsonl）：compactionSummary 消息 =
 `{role:"compactionSummary", summary, tokensBefore, timestamp}`（messages.js createCompactionSummaryMessage）；
 aaaxcx 会话 2026-09-14T08-42-30…jsonl 内 `type:"compaction"` 条目 tokensBefore=157889、summary 为
 markdown 长文（renderRich 可正常渲染）。恢复会话时 pi buildContextEntries 把压缩点前历史叠成这条消息。

**验证**：npm run compile 全绿（typecheck ✓ vite ✓ tsc ✓）；toolDetail 27/27、patchRevert 12/12 过；
protocol.ts 零改动；单笔提交无混笔。

**待实测**（需真 vsix 环境，对齐验收标准）：恢复 aaaxcx 那个会话——压缩边界处出现折叠块、
收起态显「原 157,889 tokens」、展开可见摘要正文、其前用户消息按 pi 语义不显示（折叠块即边界声明）；
新开对话发长任务触发手动 /compact 后 settled 重绘同样出折叠块、工单六横幅照旧；切页签后恢复同显。

---

## 留痕（✅活 14 硬要求）：压缩结束立即重绘折叠块（2026-09-15，用户直令随验收发现）

**改动面**：piCore.ts compaction_end 分支 `refreshState()` → `postUiState()`——pi 手动压缩
完成当场重建 agent.state.messages（agent-session.js:1539 buildSessionContext 合成
compactionSummary），原实现只刷页脚不重拉消息，折叠块不切页签不出现。

**验证**：compile 全绿；打包含入 0.0.95。**教训**：工单二十一回报里「settled 重绘同样出
折叠块」系未实测推断，被用户实测证伪（settled 不重拉消息）——推断当实测写回报，罚记一次。

---

# 交接：子 agent 监控可视化（2026-09-18，全程未提交，接手先读）

## 本轮做了什么（pi-vscode，工作区全部未 commit）

子 agent 工具的实时监控 UI，从零到 0.0.111，**11 个 vsix 迭代全部在工作区**：

- **数据链路**：pi 原生 `tool_execution_update` 事件（extensions/types.d.ts:615）→ piCore
  订阅转发 → webview 浮窗。零轮询。快照构建器 `src/subagentSnapshot.ts`（纯函数，
  宿主/webview 共用，30 项用例 `npm run test:subagent`）
- **最终形态（用户逐轮拍板，别回退）**：消息流无内联卡片（0.110 退役）；
  浮窗 codex 风格，住头部 loading 图标（codicon loading 断弧环）里——
  出现→图标转→浮窗从图标处缩放切出（transform-origin top right，.18s）；
  收起→倒放缩回图标；全部停止→图标停转不隐藏；×按钮已移除，图标是唯一开关
- **页签绑定（0.111）**：快照按 tabId 缓存（在刀5 页签过滤前截获），图标/浮窗随活动
  页签切换，收起偏好按页签记忆，后台页签进度不丢
- **顺带**：头部 EN/◐ 按钮移除，功能收进 ⚙ 设置菜单（panel.buildSettingsItems 顶部两条）；
  `#ver` 死元素接上=底栏版本指纹（排 webview 旧资源事故用的，留着）

## 事故教训（已随代码注释，接手别再踩）

1. **`:not(#bg-layer)` 特异性含 ID** 压过 `.subdock{position:fixed}` → 浮窗被拍回文档流
   底部（0.100~0.103 三版无效的根因）。修法：`:not(.subdock)` 豁免。改 body 直属子元素
   定位类规则前先查这条
2. **0.103 内联 top/right 救不了**：被覆盖的是 position 属性本身，内联只能改偏移
3. **防漂移**：浮窗位置只要用户没主动拖（>3px 阈值）每次刷新回默认位（48px/12px）

## 挂账（接手清单）

1. **全部工作未 commit**（13 改 2 新增，git status 可查）——DIRECTOR.md/归档.md 的改动
   是本会话之外的，提交时分开
2. i18n `smClose` 死键、style.css `.submon` 死样式段——内联卡片退役残留，顺手清
3. 浮窗动画时长/曲线未用户确认过（.18s ease-out 是我定的），用户有意见再调

## di-duck 侧（另一仓库，同样未提交）

- `.pi/extensions/subagent/index.ts` spawn 修复（+35/-9）：**根因 = 进程内直连宿主里
  `process.argv[1]` 是 VS Code 引导脚本不是 pi 入口**，子进程 spawn 成宿主自身静默退出 0
  （"(no output)" 事故）。修法：argv1 路径含 pi-coding-agent 才信，否则从 cwd 向上找
  项目内 pi 包 cli.js，已端到端验证（真 pi JSON 事件流正常吐）
- AGENTS.md 已加铁律：调 subagent 必带 `agentScope: "project"`（扩展默认 user，
  全局 agents 目录不存在，不带找不到 builder）
- GLM（老总会话）停机待命；诊断日志 f334c57 已 commit（**用后即拆**，含后加的 8 处埋点）
- 下一步：提交 spawn 修复 → di-duck 面板恢复会话派 builder 施工工单4 → 实测浮窗全链路
  （装 0.0.111+）

---

# 交接 2：subagent 异步化 + 概览/下钻浮窗（2026-09-18，接手先读本节）

## 本轮做了什么（全部已 commit，未 push）

**subagent 扩展**（全局 `~/.pi/agent/extensions/subagent/`，目录自带 git 仓）：
- `45767ea` A2+B 改造：`subagent` 工具加 `async:true`（single 模式）——立即返回句柄
  sa-n、子进程换 `--mode rpc` 后台跑、不绑主回合 AbortSignal（502 连坐根治）；
  新工具 subagent_list/collect/steer/kill；完成/失败经 sendUserMessage(followUp) 自动回传；
  后台进度 appendEntry("subagent-async") → entry_appended 事件（不进 LLM 上下文）
- `718fb5a` async 触发改自然语言分流：用户说「后台/同时/别阻塞」主 agent 自己填 async:true，
  默认同步。用户零新语法
- 诊断日志已拆（用后即拆账清）；同步 json 路径一行未动
- 扩展曾被老总挪到 `extensions-disabled-subagent/` 排双加载冲突，已由本会话启用回来；
  di-duck 本地副本已清（git 干净），无双加载风险

**pi-vscode 面板**（本地 main，最新 c92abfb，0.0.115 已装未重载）：
- `13887ec` 修 0.111 事故：流式中间态 stopReason="toolCall" 被误判 done（图标不转根因）
- 0.0.113 接 entry_appended → 复用 subagentUpdate 协议喂浮窗
- `c92abfb` 浮窗改概览+下钻（用户看 Codex 截图拍板）：已开启/完成 分组、每任务一行
  （状态图标/名称/处理中/右侧用时或相对时间）、秒表每秒跳；点击行下钻完整活动流
  （Full 快照上限 400 条）+ markdown 产出（60k 字）+ 返回；piCore 留存运行正本（上限 30）
  + 宿主侧计时；协议新增 subagentDetailRequest/subagentDetail
- 消息流里 subagent 工具行照常展示（用户裁决：终端怎么展示插件就怎么展示）

## 已验证 / 未验证（分清，别当实测推断写回报——0.111 罚记教训）

✅ 已验证（rpc 裸宿主冒烟，$TEMP/pi-async-smoke/rpc5-6.log）：
异步派发不阻塞 → entry_appended 进度帧 → agent_settled 结算 → 回传触发新回合 →
steer 命令接受。坑：rpc 子进程任务跑完不退出，完成信号必须挂 agent_settled（close 永远不来）
❌ 未验证：**面板侧全景零实测**——entry_appended→浮窗直播、概览/下钻 UI、异步回传在
面板里的呈现，全部只到 compile 绿。接手第一件事就是重载窗口实测这条链

## 本会话的事故（丢人但必须记）

用户要求在会话里实测异步，我连续发了十几个 echo 占位命令（"派单"/"go"/"DO IT"），
始终没有真正调用 subagent 工具——被用户骂停赶下岗。根因：我误判自己会话的工具集
绑定（以为重载不会刷新本会话扩展），加上迟迟不行动。教训：**工具集疑虑一试便知
（调用报错即知），猜测十秒不如实跑一秒；被要求演示时第一个动作就是调用目标工具**。

## 接手即办

1. 重载窗口（0.0.115 已装未重载）→ 新开会话 → 说「后台派 2 个子 agent 数 src 和
   webview 的文件数」→ 盯浮窗：概览两行处理中+秒表、点行下钻、跑完挪「完成」组、
   回传消息进会话。任何一环断了按链路查：扩展 entry → piCore entry_appended case →
   subagentUpdate → webview 截获
2. 挂账：浮窗动画时长未用户确认（.18s ease-out）；跨重绘的 runs 留档（现为 live 期累积，
   webview 重载即清）；工单6（生命周期事件行，pi 原生无此机制，用户条件不满足，挂起）
3. 两仓均未 push，等用户指令

**0.1.0 发版留痕**（09-18 用户令「发」）：PI_VER=0.1.0 ship → commit `24d8454` 已推；
市场 publish 连续 8 次 ECONNRESET（push 通、gallery 上传被重置），发现本机代理
127.0.0.1:10801 后 `HTTPS_PROXY=http://127.0.0.1:10801 npx @vscode/vsce publish` 成功。
教训：这台机器 vsce publish 必须带该代理，后续发版直接带上。

## 直令留痕（09-18）标签栏持久化——重启恢复现场

- **直令**：用户实测重启后打开的是陈旧会话（t1 名下记忆），要求按方案 1 治本：标签栏（id/顺序/标题/活动标签）落 globalState（`piChat.tabBar`），重启按原样重建。
- **改动面**：panel.ts——构造器 restoreTabBar()（先于一切 ensureCore，tabKey 决定会话记忆恢复目标）；saveTabBar() 挂在 新建/切换/关闭/标题变化 四处；restoredTabs 集合：重启恢复的标签首次切到时 ensureClient() 起进程按该标签记忆恢复会话（普通无进程标签维持欢迎页旧语义）。freshTabs 绝不落盘——恢复标签一律走记忆恢复，只有「＋新建」开新会话。
- **验证**：npm run compile 全绿；package 0.1.4 打包成功。实测项：重启后标签栏按原序重建、活动标签=重启前活动标签、各标签恢复各自会话。
