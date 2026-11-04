# BUILDER.md — 工作记录与请示（pi 维护，总监/后任必读）

> AGENTS.md 只写职责；本文件是**活动工作记录**：开工必读、待实测尾巴、技术债、待决请示、直令留痕。
> 已完结的施工回报 / 交接 / 活动记录全部在 [归档.md](归档.md)：第九节（工单存档）+ **第十节
> （2026-10-22 BUILDER 瘦身整体迁入：2026-09-15~10-22 的各刀、交接、工单回报，原文原貌）**。
> 复盘历史去归档.md，本文件只留未完结项；✅活 14 的直令/施工留痕仍写本文件，验收完结后随下次瘦身迁归档。
> 随台账入库（与 DIRECTOR.md 同，94ff28d 起）。
>
> 最后更新：2026-10-22 整体瘦身——用户拍板「待用户实测都测试通过了，都可以归档了」，
> 活动记录原 L9–L1637（1612 行）迁 归档.md 十，本文件 1637 行 → 百行内；当前无未完结施工项。

# 开工必读（摘自交接 6/7「关键证据」，全文在归档.md 十 10.1）

- **回归面（每刀固定）**：`npm run compile` + `test:detail / test:subagent / test:revert /
  test:migration / test:linkify`；webview 改动另过 `scripts/test/smoke-boot.mjs` 与
  `scripts/probe/probe-live-merge.mjs`（变更前后输出逐字节 diff）+ **用户实测通过才下一刀**
  （版本号只增不复用，同号覆盖事故不重演）。
- **诊断日志** `~/.pi/agent/pi-chat-debug.log`：三埋点 in/out/boot（`in … core=` /
  `out … [DROP no-view|FAIL]` / `boot start|done|FAIL tab=`，另有 `gate drop: window=…`）。
  判读口诀：**in 有痕 out 无痕 = 断在核心后；in 无痕 = 断 webview/路由**。
  msgBrief 摘要口径：字符串头 60 字+长度、数组条数、嵌套对象键名。
- **state.vscdb 读取**：`%APPDATA%\Code\User\globalStorage\state.vscdb{,-wal,-shm}`
  **三件一起复制**（缺 -wal/-shm，sqlite 读出空库——踩过两次），python sqlite3 读 ItemTable /
  HummerBor.pi-for-vscode（值为 JSON 包 piChat.* 键）。
- **会话文件语义**：文件名=创建时刻 **UTC**（显示一律经 Date 转本地，裸读差 8 小时）；
  内容**首条消息才落盘**；**文件在 ⇔ 有内容**（pi -r 同口径）。
- **探针**：`scripts/probe/probe-boot-timing.mjs`（加载层，判读 `[boot] bench/…`、
  `boot phase=`、`boot done total=`）；`scripts/probe-list-timing.mjs`（列表首批/全量分段计时，
  PI_ROOT 可切包——**量 pi 行为必须拿运行时那个版本量**，devDep 旧版曾致误判）。
- **复盘入口**：归档.md 9.8（关键决策与教训）、直令施工账（bindViewEvents、渲染点计数对账
  两类「编译器不报」事故）、十（本次迁入的全部活动记录）。

## 一、待实测尾巴（合并清单，全部实测通过才可全结）

- **（空）**：2026-09-14 清账（工单六/七/十一/十三含二刀重做/九/十四/附件路径全部结单）之后的
  实测尾巴，已由用户 2026-10-22 拍板全部销账（「待用户实测 都测试通过了 都可以归档了」）——
  10-19~10-22 各刀（列表接管中间区 / 列表点击交互 / 刀6 B webview 列表 / CC 布局 /
  双开守卫 / 列表 22~30s 渐进消费）的活动记录见 归档.md 十。

## 二、技术债（未排期；已排队项在 归档.md「八、后续排队」，不在此重复立账）

**在册（活；自 2026-10-22 迁出段摘出的挂账）**

1. sv* 上行消息（svOpen/svDelete/svNew/svRefresh）未进 protocol.ts（刀6B 遗留）；
   双 webview 协议是否归主 protocol 待总监定口径
2. 会话列表只列当前项目——「浏览全部项目会话」入口在编辑器实例侧已失（10-20 挂账 ⓐ），
   若要保留该能力需挂进列表齿轮菜单
3. 认领/闸逻辑（claimSession/isSessionHeld）无零依赖用例覆盖（宿主胶水需 vscode，
   panel-load 桩缺 TreeItem）——再出双开事故先补桩再上用例（10-22 双开守卫挂账）
4. sessions.js 打包 i18n 字典 37KB、两 bundle 各一份运行时（抠体积时抽共享 chunk；刀6B 挂账）
5. 环境差跳蚤（启动慢残债1）：①③背后共用的间歇性多秒等待未归案，现藏后台预热、共享后只付一次；
   触发判据=启动秒表再现 >5s 即回挖（下钻 SettingsManager/ModelConfig.load 共用 IO）
6. 「启动中发消息被挡」未复测（启动慢残债2；U 刀后启动仅 2s，可能已自然消失）——复发归案 UI/路由守卫
7. G 闸门观察项：debug log 再现 `gate drop types=[render]` 或视图空白复发 → 立即切闸门时序刀
   （开闸移到两跳 await 后）；msgBrief 嵌套标量显值一并排（取证教训）
8. devDep pi 0.85.1 vs 运行时 1.3.0 版本错位（类型参考面落后两个大版本），建议升 devDep（列表定案挂账）
9. 副栏 webview 内部页签栏与编辑器标签两套并行入口，是否退役待产品定夺（CC 布局「未动」）
10. i18n `smClose` 死键、style.css `.submon` 死样式段（子 agent 内联卡片退役残留，顺手清）

**已销（2026-10-22 清账，留证防翻案）**

- ~~renderAll queuebar 重建死循环（工单十六发现、待裁决）~~ → 工单十八补刀3 已修（先清再建幂等；
  现码 main.ts:1059/1498 循环体是 addQueuedDom 不回推，回推只在 addQueued 且不入该循环）
- ~~.vscodeignore 核查收录完整性（0.0.81 事故，test*.txt 清理随 0.0.87 攒包）~~ → 已清理；
  媒体白名单 10-20 改 `media/**` 逐个放行（vsce ls 实测恰 3 个，白名单口径入 AGENTS）
- ~~会话列表「Loading sessions」全量读慢~~ → 22~30s 定案（归档 十 10.2）：全量读是 pi 原生成本
  （305MB 全文解析、零缓存、每次重扫），用户口径「不需要比 pi -r 快」，**别再自研浅读**

## 三、待总监回复的请示（当前无待决，全部裁决完毕；历史存档见 归档.md 9.9）

## 四、给总监的提醒

- ship 由用户手动发：施工/打包会话**别再跑 ship/bump 脚本**（2026-10-20 用户拍板，原话见归档 十 10.1 刀6 B 挂账）
- 发版若 publish 撞 ECONNRESET：`HTTPS_PROXY=http://127.0.0.1:10801 npx @vscode/vsce publish`
  （0.1.0 发版教训，归档「七」账目）


## 五、工单33 让位交接（2026-10-30 直令留痕 ✅活14）

**背景**：用户发「开工」接手工单33 新增段（交接-工单33-runPrompt.md 口径），开工 25 分钟内
发现**并行会话同场施工**（文件 mtime 16:20-16:23 实时写盘 + ddbaad5/9b9693f/039ee7b 连提交，
撞车面=同一批文件），用户拍板「你让位吧先」——本会话停手，剩余段归并行会话。全程按裁决 9
逐 hunk 归属暂存，零互扫（对方提交排除了我的 hunks，我提交只带自己的 2 个文件）。

**已入库（本会话唯一一刀。⚠️ 刀号勿混：本刀「刀1=工具策略」与并行会话「刀1=授权层」
是两套编号）**：
- `5006bb2` 工具策略透传：piClient.ts 加 `ToolPolicy`/`toolPolicyFields()`（纯函数）/
  `setToolPolicy()`，init 的 createAgentSessionFromServices 展开 tools/excludeTools/noTools
  ——runPrompt tools/noTools 的落点（契约 §六能力裁剪硬防线）。
- 验证凭据：compile 全绿；`scripts/probe/tools-probe.mjs` 12/12（白名单裁剪
  active=[read,grep,ls] / noTools:"all" 全关 / createReadOnlyTools=[read,grep,find,ls]，
  四工具全不在 bash/write/edit/powerShell）；全套回归 detail 27/27、subagent 46、
  migration、linkify 22、errclass、html 全过；test:revert 预存红（diff 包被 npm 提升到
  顶层，用例 require pi 树内嵌套路径失效——工单32 已挂账，与本刀无关）。

**交接注记（摸底到函数级，接任直接用勿重查；行号按 a28746a 基线，piCore/panel 未再动）**：
1. settle 桥先例：piCore.ts `onRunStart/onRunSettled` 字段（:229-230）、panel.ts ensureCore
   赋值（:282-283）；`agent_settled` 分支 piCore.ts:2152——注意 onRunSettled 仅
   runChangedFiles 非空调用，新 `onRunEnd` 须**无条件**触发并带 error 归因
   （default 错误分支收 error/errorMessage/reason 记入 runError，agent_start 清空）。
2. adopt 不新建 core（单写者铁律）：piCore 构造器 `this.rawPost = post` + 闸门包装
   `this.post`（:254-259）——加 `setPost` 换 rawPost 即重绑（panel.ts:275 构造闭包是现役
   post 桥）；panel 三处对齐：openOrFocusSession(:293)、findHolder(:315)、
   buildCaps.isSessionHeld(:368)；webviewReady 的 pendingSessionFile 分支（:598-631）
   采纳路径**绝不能 switchSession**——那就是双写者（上周事故本源）。
3. 无头 core 记忆劫持坑：refreshState 的 `setSessionForWs`（piCore.ts:1712 附近）按工作区
   写「上次会话」记忆——无头 core 必须跳过，否则 t1 恢复链会盯上无头会话文件，而
   isSessionHeld 看不到无头持有（headlessRuns 不在 panel.cores）→ 双写；tabKey 别留默认
   "t1"（applyModelMemory 按 tabKey 读记忆会串台），建议 `headless:<name>`，adopt 时改
   tabId 并置 headless=false。
4. 命名/复用：`piClient.setSessionName` 已有（→ session.setSessionName）；名字→文件解析
   走会话列表 SessionInfo.name；switchSession 同目标短路返回 {cancelled:false}——比对只
   能比 session.sessionFile，不能比 boot 的 openPath（piClient.switchSession 注释的坑）。
   创建新会话走 SessionManager.create（freshTab 语义同款），复用走 openPath→open 直挂。
5. SDK 证据（勿重查）：tools/excludeTools/noTools 在 agent-session-services.d.ts:53-55；
   断言用 `session.getActiveToolNames()`；createReadOnlyTools(cwd)=[read,grep,find,ls]。
   runPrompt 返回形状以**契约 v2.1** 为准（增 model/onEvent、返回 text——039ee7b 裁决回写）。
6. 探针姿势（scripts/probe/，follow-probe 假对象裸跑风）：
   `PiCore.prototype.onPiEvent.call(fake, {type:"agent_settled"})` 打 settle 桥；
   假 core 工厂打 runPrompt 三态（settle resolve / busy 拒收 / timeout 自动 abort）；
   授权探针打 clientAuth 的 deps 注入面（未注册/令牌错拒收零副作用、重调不静默重发、
   过期续权）。
7. 不变式四条（错一条翻车）：单写者 adopt 不新建 / settle 桥 / 同名拒收 / 会话落盘审计
   红线（--no-session 焊死在 piClient）。验证 gate：compile 全绿 + 全套 test:* 回归 +
   三探针 + 拆除零残留 grep。

## 六、待签发需求（用户直令留痕，等总监立单）

### 需求：气泡级「↺ 回到这里」按钮（2026-11-04 用户原话「在上下文把这段删除」）

- **诉求**：误发/聊茬的消息希望能从上下文里去掉。用户提出「做一个在上下文把这段删除的按钮」。
- **结论（先查 pi 原生 → 不做自研删除）**：不做「删中间一条」，做「从这条分叉」。
  `vendor/pi/dist/bundle` 实查：只有 `runtime.fork(entryId)`，**没有** deleteEntry /
  removeEntry / truncateAfter / rewindTo / editMessage。会话是 append-only 树（entry 带
  parent 链），中间删一条会断开 tool_call ↔ tool_result 配对、破坏回放与审计红线
  （AGENTS.md「会话必须落盘」）。pi 原生 fork 的语义正好是「这点之后从活跃链上丢弃」，
  旧分支仍留在 jsonl 里可审计。
- **现状已通**：`panel.forkToMessage()` = `getForkMessages()` → `client.fork(entryId)` →
  `render` 重绘 + notice 提示；入口只有命令面板 `pi: 从历史消息分叉 (fork)…` / `/fork`
  外加一个 QuickPick。本需求 = 把入口搬到气泡上。
- **实现要点（待施工时核对）**：
  1. webview：user 气泡 hover 出「↺ 回到这里」，确认文案必须写清「将丢弃该条之后的 N 条」；
  2. 气泡→entryId 映射：`getUserMessagesForForking()` 返回顺序与渲染的 user 气泡同序，
     渲染时把 index 存进 dataset，回宿主取同列表 entryId 并比文本防错位；
  3. 新协议 `forkTo{ index }` 三处同步（发送方 / 接收方 / protocol.ts）；
  4. 复用 `panel.forkToMessage()` 的既有链路，仅去掉 QuickPick 分支。
- **注**：DIRECTOR.md 当前是只读（r--r--r--，工单区归总监），故本需求记在此处，待总监立单/裁决。
