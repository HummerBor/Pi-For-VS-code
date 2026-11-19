# 架构事实与技术决策档案

> 这里存的是**需要时查**的细节：为什么这么设计、踩过什么坑、不许怎么改。
> `AGENTS.md` 只留每次都要遵守的简短铁律，细节全在本篇。
> 新会话不必通读；改到对应模块时按节查。

---

## 一、pi 内置随插件分发（2026-10-26 用户拍板，废止原「零运行时依赖」条款）

compile 时 `scripts/release/vendor-pi.mjs` 把 pi 的 `dist/bundle`（自包含单文件 bundle，~7.7MB）
拷入 `vendor/pi/` 随 vsix 分发，`piSdk.findPiPackageRoot` 内置层优先——用户装上插件即用，
不需要 node/npm/自装 pi。pi 包仍只在 `devDependencies`（源码不 import，仅拷产物）；
pi 发新版后重新 compile 即跟上（内置版本 = 构建时 node_modules 里的版本）。

## 二、插件就是壳（2026-09-14 用户拍板，原话）

能用 pi 原生能力的就用 pi；任何新功能都要**先查清楚 pi 原本有没有这个能力**（公开 API / TUI 行为 /
扩展生态三处都查），而不是自己造。工单签发前必过此查；壳自研与 pi 原生重复 = 浪费 + 双份维护 +
行为分裂。自研实现一旦发现 pi 有原生能力或失去存在前提，随工单清点回收（先例：会话列表换
`SessionManager.listAll`，工单十三）。

## 三、subagent harness 内置随包分发（2026-10-30 用户拍板）

- 源码归属 `harness/subagent/`（`.vscodeignore` 黑名单制自动进包）。
- 激活时 `ensureSubagentHarness` 按 `harness.json` 的 version 门同步到
  `<agentDir>/extensions/subagent`：**只升不降、不覆写本地修改**。改 harness 必须 bump version。
- **回滚注意**：插件版本回退后，机器上的 harness 副本不会跟着降级（只升不降），需手动把
  `<agentDir>/extensions/subagent` 改名或删掉，旧插件才会重新同步内置版本。
- 落盘红线同样适用：harness 派子进程永不传 `--no-session`（runsLedger 台账 + 每单独立 `--session-dir`）。

### 3.1 送帧真值收敛（2026-11-19）

- `frames.jsonl` 双写已删（`ae66924`，harness v27）：帧真值只有父会话里的
  `custom:subagent-async` 条目，重放路径也只读它。
- 失联判定改 pid 存活（台账 `pid` + `process.kill(pid,0)`），30 分钟无帧只作兜底。
- **不许用定时器兜底状态**：施工方曾加 5s `setInterval(pushLedger)` 被否（`fd268ce`）。
  正常结束/崩溃/被 kill 由写者补终态帧（v25 kill、v26 proc.close 无条件补），SIGKILL 场景
  下次打开面板时重新探活即可。

## 四、进程内直连架构（2026-09-09 用户拍板）

- `piClient` 不再 spawn `pi --mode rpc`，改为经 `src/piSdk.ts` 定位并 import 用户已装的 pi 包
  （前置条件：机器上必须有 pi）。RPC 版整树保留在分支 `rpc-subprocess`。
- 改 `piClient` 前**先读其头注释的「RPC 语义保留对照」**：preflight 验收即回、拒收报错文案与
  steer 自愈正则的匹配是跨模块契约，别动。

## 五、核心/宿主分层（工单四）

- `src/core/piCore.ts`：核心控制器，**禁 import vscode**，宿主能力经 `hostCapabilities.ts` 接口注入。
- `src/vscode/panel.ts`：VS Code adapter（实现 HostCapabilities / UiActions，组装 PiCore）。
- 改核心逻辑（状态机 / prompt 组装 / 事件路由）去 `piCore.ts`；VS Code UI 流程留 `panel.ts`；
  webview 消息路由入口是 `core.onWebviewMessage`。
- 对账基线与漂移清单见 `归档.md` 工单四。

## 六、vsix 瘦身与打包边界

- vsix 包内 `media` 只带 `pi-icon.png` / `pi-logo.svg` / `source/pi-icon-small.svg`
  （`.vscodeignore` 白名单；2026-10-20 起标签图标 / editor-title 按钮用它）。
- README 截图引用 `raw.githubusercontent.com` 仓库 URL——**改截图必须 push 后才在市场生效**。
- `dist/` 只放 webview 产物；探针截图写 `scripts/.preview/`（gitignored）。
- **`media/duck.svg` 禁删（2026-09-24 用户拍板）**：欢迎页鸭子的矢量源稿。初代 duck.svg 从未进 git，
  v0.0.57「media 清理」时连工作区一起清掉、无从追查。任何清理/瘦身一律不许碰它；它不进 vsix
  （白名单不含）不等于可以从仓库删。已知债务：逐像素 rect 描摹导致 3.4MB，如需瘦身可按 16×16
  网格重绘，但文件本身永远保留。

## 七、还原边界（工单七，裁决 11）

- 还原只对「pi 工具命中」的文件提供；git-only 只展示。
- `write` 碰过的未跟踪文件一律不可还原。
- patch 逆向任一行不符即拒打不落盘（`patchRevert.ts`）。
- 破坏性操作红线：**别「优化」掉任何一道守卫**。完整边界与选型溯源见 `归档.md` 工单七 + 裁决 11。

## 八、两处兜底不许删

1. **steering 自愈**（`piCore.ts` prompt 分支）：prompt 被 pi 以 "already processing" 拒收时
   自动转 steer 重发——busy 标志竞态的兜底，不是临时代码。
2. **4 秒 pendingPrompt 兜底**：`/llama` 等命令式应答不触发 `agent_start`，没有它面板 busy 永久卡死。

## 九、本插件特有格式约定

- **会话持久化格式**（`--- 代码上下文: ---`、`--- 附件: ---` 分隔标记）是磁盘格式，不参与 i18n。
- **模板纪律**：`index.html` 只放结构 + 占位符（`{{key}}` / `{{t:key}}`）；CSS/JS 主体绝不写进模板，
  样式注入在 `src/webview-html.ts` 的 `headAssets`。
- **CSP**：nonce 由 `getHtml` 随机生成，script 标签与 CSP 头必须配对；JS 注入须过 `</script` 转义。
- **协议同步**：新增/修改跨边界消息时发送方、接收方、`protocol.ts` 三处同步
  （注：会话列表的 `sv*` 消息走 `sessionsView.ts` 自有消息集，不在 `protocol.ts` 范围）。
- **webview 类型门禁**：`strict:false` 下 tsc 零报错（无 `@ts-nocheck`）；真类型问题用最小断言解决。
- **webview 语法风格不设限**（2026-10-29 用户拍板放宽）：let/const/箭头函数随便用；存量 var
  不必刻意回避，也别为迁移而迁移——大批量风格迁移单独成笔，别混进功能提交。

## 十、子 agent 显示名 / 调用分类两层分离（2026-09-24 用户拍板）

- 展示层显示调用方给的名字（随便取，`subagentNames` 台账）；实际调用归 pi 注册分类
  （`subagentNameGuard` 在 tool_call 归位，默认 worker 优先）——否则老报 Unknown agent。
  pi 内容零改动。
- **编译红线**：`subagentSnapshot` 保持零 import（webview 共享编译无 node 类型 + node 裸跑用例
  相对导入要扩展名）；显示名查表经 `setDisplayNameLookup` 依赖倒置注入（`panel.ts`，与
  `setPiClientDebug` 同款）；`subagentNames` 是纯逻辑叶，别往里 import 东西/加 fs
  （宿主半边在 `subagentNameGuard`）。

## 十一、会话必须落盘（审计红线，2026-09-22 用户拍板）

- 插件任何路径禁止 `--no-session` / ephemeral（`piClient` 遇之显式抛错，禁令焊死在适配器入口）。
- 会话文件是 pi 操作的唯一审计痕迹；「无痕模式」删文件等破坏性操作无从追查。
- `piChat.sessionMode` 只留 `continue` / `new`，旧 settings.json 的 ephemeral 残值归一为 `continue`。

## 十二、版本号口径（2026-09-23 用户拍板）

- `npm run ship` 跟的是**线上版本线**（从市场版 bump，发布号只增不复用）。
- 本地 `npm run package` 测试包号**随便**，不参与递增纪律。
- 并行发布流（`chore: release` 提交）会按市场线改写 `package.json` 版本——看到本地版本号
  「变小 / 跳号」是发布流正常现象，**不是事故、不要再排查**；施工会话只交代码，版本/发版归
  ship 所在会话管。

## 十三、钱的显示：pi 记账 + 时段估算两行并存（2026-11-17 用户拍板方案 A）

- pi 的 models 目录每模型只有**一套价**（≈厂商高峰价），而 DeepSeek 按时段计价 → 空闲时段干活时
  账单只有 pi 数的一半。
- 所以弹层「合计」保持 pi `getSessionStats().cost` 当**对账锚点**不动，另加一行「时段价估算」按
  `domain/priceTable.ts`（高峰/空闲两档、按 usage 桶的整点时间戳判定）算「与账单同口径」的那份钱。
- 页脚恒美元、显示估算值，pi 记账进 title。价目表在 `<agentDir>/pi-vscode-pricing.json`
  （⚙ 菜单 / 命令 `piChat.openPriceTable`，坏文件逐项回落内置），表里没有的模型**不估价**。
- 换模型加价走内置技能 `harness/skills/pricing-table`（用户截图 → agent 写 JSON），别改代码；
  也别把估算塞进 pi 的 models.json（那是 pi 自己的配置，插件只读它）。
- 对账实测：2026-11-17 08:52–08:58 = 61 次 / 13,207,373 tok → 空闲价 ¥0.601，平台 ¥0.60。

## 十四、登录：TUI 只能由真 node 承载（2026-11-05 沙箱实测）

pi 的 `/login` 是 TUI 专属命令，SDK 里没有、`pi auth` 也只有读/校验（无 login）。内置 pi 只解决
SDK 侧（对话），登录终端必须找**真 node**：`piSdk.findNodeRuntime()`（桌面宿主是 Electron →
扫 PATH 找 node；远端/纯 node 宿主直接用 `process.execPath`）+ 内置
`vendor/pi/dist/bundle/cli.js`，即 `shellPath: node, shellArgs: [cli]`；没有 node 则退 PATH 上的
`pi`；两者都无 → 明确告知并引导装 Node.js（API key 方式始终零安装）。

**三条已死的路（重测一次就是复蹈覆车）**：

1. 终端 `env: {ELECTRON_RUN_AS_NODE:"1"}` 把 Code.exe 当 node —— **VS Code 终端的自定义 env
   传不进 pty**，结果是 GUI 的 Code.exe 被拉起、弹出新窗口（用户实际撞过的症状）。
2. `.cmd` 启动器里自己 set 能跑（`cli.js --version` → 1.5.0），但 Electron 当 node 时
   **stdin 不是 TTY**，TUI 静默退出。
3. `sendText('"exe" "cli"')` 拼引号 —— PowerShell 当字符串表达式报「意外的标记」（cmd/bash 又能过），
   且 node-pty 会把内层引号转义掉。

首屏「pi 可用吗」同理看内置 `bundledPiVersion()`，不看 PATH 探测。

## 十五、其他既定事实

- `npm run package` 会 bump patch 版本且**不动 git**（版本号随下次提交入库）。事故教训：
  同版本号覆盖打包 → 装旧包无法自证（2026-09-15）。
- 会话列表的右键菜单已改为复制 jsonl 路径（`9530019`），原生 cut/copy/paste 在这个列表里无意义。
- 浮窗时间口径（`89946be`）：完成行显示**固定时刻**（`16:47` / 跨天 `11-17 09:40`），
  秒表只在有活行时跑，收尾即 `clearInterval`。

## 十六、文档与流程治理（2026-11-19 用户拍板，一次大清理）

**判断标准：只留唯一事实源；某件事的「第二份副本」一律删。**

保留的六个事实源：

| 载体 | 回答什么 | 增长方式 |
|---|---|---|
| `git log` / commit message | **事实**：改了什么、为什么 | 自然增长 |
| `AGENTS.md` | **约束**：每次都要遵守的 12 条铁律 | 固定（细节进本篇） |
| `PROGRESS.md` | **状态**：在做 / 待办 / 风险 | 滚动窗口，恒定 ≤70 行 |
| `docs/decisions.md`（本篇） | **决策**：为什么这么设计、哪条路不许走 | 按需追加 § |
| `docs/history/` | **战役档案**：一个战役一份 | 每战役 +1 |
| `归档.md` | **工单索引**：工单号 + 结论 + commit | 一单一两行 |

删掉的东西（都是第二/第三份副本，且都不进 git、不参与任何自动化）：

- `reports/` 17 份过程报告（316KB）——结论在 commit message 里；报告写 `.pi/reports/`（gitignored），当次验收后即抛
- 18 个 `dispatch-t<N>.md` 派单令 —— 收单即删
- `ROLLBACK.md` —— 内容已在 `docs/history/` §四 + 本篇 §三
- `archive/` 4 份 vsix（15MB）—— 包能从任意 commit `npm run package` 重建
- `%LOCALAPPDATA%\pi-reports\` 归档目录 —— 不许往 C 盘写

**AGENTS.md 为什么要瘦身**：191 → 121 行。原「不可破坏的约定」90 行 21 条，混着事故经过
（如登录那条写了 5 行三条死路），模型在 90 行里抓不住重点，约束力反而下降。现在只留 12 条
**行为铁律**（每条 1-2 行 + `§N` 指针），细节全在本篇。

**流程制度的教训**：不要依赖 agent 自觉。这轮 12 单「收单写 DIRECTOR 台账」一次都没执行，
因为该动作不在「派单→施工→回报→验收→派下一单」的执行路径上。旁路动作在上下文一长时必被优化掉。
结论：台账制度砍掉，只留 `git commit`（不靠自觉）+ `PROGRESS.md`（滚动窗口，只记状态）。

## 十七、压缩与记忆机制（2026-11-19 结论）

- **压缩不删 jsonl**。`SessionManager._persist` 是 `appendFileSync`；`appendCompaction` 只追加一条
  `{type:"compaction", summary, firstKeptEntryId, tokensBefore, details}`，旧消息一行没删。
- 上下文变短是**读取时过滤**：`buildSessionContext` 从 `firstKeptEntryId` 开始取，之前的跳过。
- 所以 **jsonl 永远是完整原文**（压缩 N 次都在），从 jsonl 提取比 LLM 摘要更保真。
- 实测（4.51MB / 853 条消息的会话）：只提取 user 意图（每条截 120 字）≈ **1.1k token**；
  加最后 5 段 agent 结论 ≈ **1.6k token**。比压缩保留的 20k 原文小 12 倍。
- **摘要内容有定式**（源码 `chunk-44DLKSKE.js`）：system prompt 是「You are a context summarization
  assistant… ONLY output the structured summary」，输出 7 段固定格式 —— Goal / Constraints &
  Preferences / Progress(Done·In Progress·Blocked) / Key Decisions / Next Steps / Critical Context，
  另附 `<read-files>` `<modified-files>`。喂给摘要器的输入本身也被砍：`TOOL_RESULT_MAX_CHARS=2000`
  （工具输出每条只留前 2000 字符）、thinking 全丢。
- **保留量是默认参数不是玄学**：`SETTINGS_DEFAULTS.compaction = {reserveTokens:16384,
  keepRecentTokens:20000}`；判据 `contextTokens > contextWindow - 16384`。
- **另一种「变短」不是压缩（2026-11-19 实测补正）**：本机 488 个会话 / 4.0GB / **0 条 compaction**，
  但出现 `{type:"context_edit", targetId, replacement:null}` —— 源码是 `_omitRecoveryAttempt`：
  某次尝试失败后把该条 assistant 消息及其 toolResult 从上下文摘掉，追加墓碑（原文仍在文件里）。
  别把「上下文变短」一律记成压缩，先看 entry 类型。
- **jsonl 膨胀主因不是对话**：单个 680MB 会话里 `custom` 33646 条、`message` 仅 526 条（子 agent 帧）。
  瘦身要打 `custom` 帧，不是打消息。
- 待做：`scripts/probe/session-digest.mjs` 原型（从 jsonl 提取意图时间线）；插件侧可在压缩后
  注入该摘要，替代不可靠的 LLM 摘要。
- 跨会话仍然要人工维护的只有**待办**（新会话看不到旧会话 jsonl）—— 那就是 `PROGRESS.md` 的用途。
