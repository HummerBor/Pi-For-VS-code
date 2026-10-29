# REPORT-t32 · 工单32 外部会话通用接入（施工回报）

> 施工方式变更记录：原派单 builder（sa-1）45 分钟侦察失速被停（技能 §2 处置），
> 其已完成刀1 并入库（964d92c，代码验收通过后保留）；刀2/刀3 由主会话直施
> （用户直令「那你写吧」，✅活 6 越队列）。本 REPORT 覆盖全部三刀。

## 一、改了什么（三个 commit）

| 刀 | commit | 文件 |
|---|---|---|
| 刀1 | 964d92c（sa-1） | core/externalWriting.ts（新）、vscode/extension.ts、vscode/panel.ts、vscode/sessionCache.ts |
| 刀2 | c5fd56b | pi/piClient.ts、core/piCore.ts、core/protocol.ts、core/i18n.ts、core/externalWriting.ts、vscode/extension.ts、webview/main.ts、webview/style.css、scripts/probe/follow-probe.mjs（新） |
| 刀3 | 86e67a7 | vscode/sessionsView.ts、vscode/extension.ts |

**刀1**：`piChat.openSession {file,name} → {ok,reason}`（file 优先、name 扫 SessionInfo.name
兜底、existsSync 先查、已开走 openOrFocusSession 聚焦不重复开）；`piChat.externalWriting
{file,name,writing}` 登记表（core/externalWriting.ts 纯逻辑叶，宿主写、核心读）；
sessionCache.listNative 透传 piChat.sessionDir（memo key 带 sessionDir）+ panel 配置变更
invalidateListMemo + 列表重扫。

**刀2（数据面主体）**：
- piClient 跟随器：bindSession 单点挂载（boot/切会话/fork 全覆盖），500ms stat 轮询，
  增量读按 `\n` 分帧（半行攒帧、坏行跳过、只滤 type:"message" 条目），externalAppend 事件上屏；
  本地写入识别（isStreaming + markOwnWrite 1.5s 窗口 rebase）防误渲染/误锁；
  `getMessages/messagesSync` 叠加 followDelta（切页签/uiState 重绘不丢外部尾巴）。
- 只读锁：活跃 = registry 命中（path/name 双键，name 键 30min TTL 防僵尸锁）**或**
  delta 非空且 mtime 静默窗（10s）内。锁上 → webview 状态行「运行中」脉冲徽标 +
  输入禁发（externalState 消息）；宿主侧 sendPromptCore/setModel/setThinkingLevel/
  setSessionName 四处门禁（调用方全有 catch → notice 上屏，已核 panel:1610/1889/1534）。
- **打开即写堵点**（三处查实锤 setModel 无条件 append，P1-1 升 P0 落地）：
  applyModelMemory 在活跃或 mtime 新鲜时缓写，11s 自愈定时器补回。
- 交棒：外部静默 → `switchSession(file, force=true)` 同文件重进（绕「已在目标上」短路，
  磁盘真相入内存、delta 清零）→ 重绘 + 补记忆 + 解锁；失败保持锁、不进 500ms 重试风暴
  （extReleasing 不复位，下次状态变化/新 client 接线复位），/reload 可自救。

**刀3**：extension.ts 500ms 轮询文件名指纹（recursive readdir，默认库根 + sessionDir
配置目录），变更 → invalidateListMemo + sessionsView.refreshNow（新增，不吃 2s debounce）。

**协议**：protocol.ts 只增不改——`ExternalAppendMsg`/`ExternalStateMsg` 追加文末 +
HostToWebview 联合增两项；GATE_PASS_TYPES 增两项（append 走闸直发，丢失由 uiState 的
delta 快照兜底；state 闸后必重发）。i18n 中英各 5 键。

## 二、验证证据

1. `npm run compile` 全绿（typecheck:webview + vite×2 + tsc），三刀各自提交前均过。
2. 全套回归零回退：detail 27/27、subagent 46、migration 全过、linkify 22、errclass 全过、
   html OK；`test:revert` **基线即红**（MODULE_NOT_FOUND nested diff，sa-1 立基线时实测），
   与本单无关。
3. 探针 `node scripts/probe/follow-probe.mjs` **13/13 过**（真实输出在会话记录）：
   分帧/半行攒帧/多字节中文🎉不碎/坏行跳过/offset 推进/登记表双键/TTL 31 分钟过期。
4. 门禁调用方 catch 核对：panel.ts:1610、1889（opFail/settingsFail notice）、1534
   （cmdRename 在 run 包裹的 try 内）——门禁拒绝走 notice，无 unhandled rejection。

## 三、边界自查（dispatch-t32 §三逐条）

- openInEditor 语义未动 ✓；steering 自愈/4s pendingPrompt/还原边界未动 ✓
- 会话 jsonl 格式零改动；pi 包/vendor 零改动（未 import 任何新 pi API）✓
- 会话页既有 UI 形态未动（徽标+锁定态是唯一新增）✓
- protocol.ts 只增不改 ✓；存量 var 未做风格迁移 ✓
- 未碰 git 历史、未 push、未 bump 版本 ✓
- 开工前树净核对：588b95e 后仅本单文件 ✓（sa-1 的刀1 commit 单独核过 --stat 恰四文件）

## 四、偏离与自裁记录

1. **webview 侧是整页 renderAll 叠加渲染，不是字节级增量 DOM**（对「不重载整页」的偏离）：
   renderAll 是唯一权威渲染器，抽单消息渲染器要重写工具配对/同名成组/跨消息相邻判定
   （工单24/26 沉淀的雷区），风险大于收益。保真补偿：渲染前存 scrollTop、渲染后
   非跟随位恢复 + followingEnd 显式置 false（防 innerHTML 清空触发的滚动事件把跟随
   标志翻真导致「上翻被拉底」）。宿主侧仍严格只读新增行（不整文件重读）。
2. **mtime 启发式只认 delta 非空**：单凭「mtime 新鲜」会把用户自己的刚写入误判为外部
   （打开自己的会话即锁死），故 mtime 必须伴随已观测到的外部增长才成立；registry 路径
   无此约束（精确信号）。
3. **开闸只认 registry 不认 mtime**（startFollow 处）：delta=0 时无法区分自有/外部，
   mtime 可疑统一交给 applyModelMemory 缓写路径堵写点——两层各管一段。
4. name 登记带 30min TTL（僵尸锁逃生阀）：ops-panel 被 -9 杀时 finally 跑不了，
   无 TTL 就是永久锁。**交接文档 2.2 节「漏发走 mtime 兜底」的表述需修正**——见请示。

## 五、遗留问题（债务）

1. **未知写者竞态**：无 registry 的外部写者与本地写入并发时，识别窗口 ≤1 tick（500ms）；
   本地 streaming 期间的增长一律归本地（否则本地流式渲染会双份）——该窗口内外部写入
   会被跳过，显示缺口在下次交棒重载时从磁盘自愈。registry 路径（ops-panel）无此窗口
   （锁着没法本地起 run）。
2. **PI_AGENT_DIR 自定义 agent 目录**不在刀3 watcher 覆盖面（默认根按文档硬编码
   ~/.pi/agent/sessions）；该场景下既有列表行为同样依赖它，非本单回归。
3. **append 到已有会话不刷新列表 mtime 列**（watcher 只看文件名清单，验收面外）。
4. 活跃期 rename/model/思考被 piClient 拒绝——用户会看到英文错误 message（门禁原文），
   如嫌生硬可换 i18n 文案（未列验收，未做）。
5. `test:revert` 基线红（预存，MODULE_NOT_FOUND）——非本单范围，待另行处理。
6. 活跃期若本地 run 正在跑（registry 中途到达），run 的收尾写入与外部写入仍可能交错
   （无法中止已运行的 run，保守取舍：abort 也会产生写入）。

## 六、请示事项

1. **交接文档修正**：《交接-ops-panel-外部会话接入.md》2.2 节写「漏发 writing:false
   走 mtime 静默兜底自动解锁」——实现后口径为：**未登记写者**走 mtime 兜底；
   **已登记（registry）写者**靠 TTL 30 分钟过期（mtime 不覆盖 registry 锁）。是否由
   总监改文档同步 ops-panel？
2. 验收口径确认：C 场景 ≤2s = watcher 500ms + sendItems 首批 partial（pi 最新文件先
   解析，实测 ~19ms 出首批）——拥堵场景（历史实测 22s 全量）下 partial 机制仍在但
   总时长可能超 2s，属既有基建行为，是否接受「常态 ≤2s、拥堵另计」？

## 七、待用户真机清单（subagent 无 VS Code UI，验收场景 A/B/C/D 的 UI 面）

| 操作路径 | 预期 |
|---|---|
| 终端起 `pi -p --name t32test "<需要几十秒的长任务 prompt>"`，运行中在 pi-vscode 打开该会话（列表点击或 REPL `executeCommand('piChat.openSession',{name:'t32test'})`） | 页面出现会话且随外部写入逐条增长；上翻历史不被新内容拉底；回底部恢复跟随 |
| 外部运行中查看状态行 | 「运行中」橙色脉冲徽标；输入框禁发（发送按钮点不动） |
| 外部运行中从 ⚡ 菜单改模型/改名 | notice 提示拒绝（英文 message 或已换文案），会话文件无新行（`Get-Content <file> | Measure-Object -Line` 前后对比） |
| 外部进程退出（等 10s 静默窗） | 自动交棒：徽标消失、输入解锁、页面重绘含外部全部内容；随后发「改改稿子」类消息正常对话 |
| REPL `executeCommand('piChat.openSession',{file:'不存在路径'})` | 返回 `{ok:false, reason:'not-found'}` |
| REPL `executeCommand('piChat.externalWriting',{name:'t32test',writing:true})` 后立即打开会话 | 打开即锁（registry 精确路径，不等 mtime） |
| 外部新建一个会话文件（或跑一个新 `pi -p`），盯左侧会话列表 | ≤2s 出现新条目 |
| 配置 `piChat.sessionDir` 到自定义目录并放入会话文件 | 列表只显示该目录会话；改回默认后恢复 |
| ops-panel 场景 E（回归）：未装 pi-vscode 的环境点「查看详情」 | 调用方提示不崩（ops-panel 侧保证，此栏供联调时对照） |
