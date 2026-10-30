# 交接 · 工单33 runPrompt 驱动契约（下一会话接任入口）

> 2026-10-29 收工交接。接任者先读本文，再读 DIRECTOR.md 工单33 与
> 《交接-ops-panel-驱动接入.md》（契约 v2，两边改动的唯一口径）。

## 一、当前状态（git 为准，勿信记忆）

| commit | 内容 |
|---|---|
| 7a0c7a8 | 契约 v2 文档 + 工单33 签发（含拆除令）；旧《外部会话接入》v1 已删 |
| 5e6cf1f | **拆除完成**：跟随/锁/交棒机制净删 751 行（验收四连：精确命中×1/零残留 grep/全套回归零回退/diff 逐文件核） |
| 901747c~353773e | （工单32 时代的热修三连，随拆除大半失效，勿翻案） |

- 本地包：`pi-for-vscode-0.1.57.vsix`（干净版，可验证原功能复原）；版本号随下次提交入库（AGENTS.md 口径）。
- **保留件**（新架构照用，勿拆）：`piChat.openSession`、sessionCache 的
  `piChat.sessionDir` 透传、extension.ts 会话目录 watcher（fs.watch + 2s 冷却）。
- 工作树应为净（交接文档自身除外）；若见残留改动先 `git status` 对账再动。

## 二、下一步施工：工单33 新增段（runPrompt/abortSession）

**目标**（细节以契约 v2 §二为准）：

0. **授权层（前置）**：`piChat.authorizeClient({extensionId})`——弹窗（取 getExtension
   真实扩展信息+能力清单）→ 同意入信任表（globalState 持久）+发随机 clientToken
   （能力裁剪）；runPrompt/abortSession/openSession 全部携令牌校验，不匹配 →
   `{ok:false, reason:"unauthorized"}`；`piChat.revokeClient` 撤销（弹窗确认）；授权
   必发通知留痕。**无逃生门/无免弹窗配置（用户拍板删）**：静默发杖可被冒名领取；
   无人值守 = 装机后人工点一次注册（一生一次，之后全静默）。**令牌只在首次注册瞬间
   发出一次，重调 authorizeClient 绝不静默重发杖**（重注册=弹窗明示「吊旧杖换新杖」）；
   令牌 90 天过期，到期首次调用弹窗续权。
1. `piChat.runPrompt({ name, prompt, timeoutMs?, tools?, noTools? })` → `Promise<{ ok, reason?, error? }>`
   - 按 `name` 创建/复用**无头会话**（不占页签、进列表、openSession 点开即挂 live）；
   - **settle 时 resolve**（agent_settled / 错误结束 → `{ok:false, error}`）；
   - `timeoutMs` 到点自动 abort → `{ok:false, reason:"timeout"}`；
   - 同名在跑再提交 → `{ok:false, reason:"busy"}`；
   - **`tools`/`noTools` 透传** pi CreateAgentSessionOptions（实证：dist/core/sdk.d.ts:29-45，
     `tools` 白名单、`noTools:"all"` 全关；tools/index 有 createReadOnlyTools）——
     **注入防线（用户拍板）**：含爬取原文的步骤只读工具集（read/grep/ls，禁 bash/写），
     写操作步骤不得含爬取原文（契约 v2 §六四层防线：能力裁剪=硬/结构隔离=软/审校人闸/审计）。
2. `piChat.abortSession({ name })` → `{ok}`（abort 语义）。
3. ops-panel 侧按契约 v2 §三（不在本仓）。

**实现线索**（省摸底时间，坐标已实证过，勿重查）：

**骨架：四处改动点**
1. `src/vscode/extension.ts` activate() 的 `ctx.subscriptions.push(...)`（openSession 注册
   同一段，~行 88-115）：注册 authorizeClient / revokeClient / runPrompt / abortSession。
2. 新模块 `src/vscode/clientAuth.ts`（授权层）：信任表存 `ctx.globalState`（key 建议
   `piChat.clientGrants`：Map<extensionId, {token, caps, grantedAt}>）；token =
   `crypto.randomBytes(32).toString("base64url")`；过期 90 天；弹窗用
   `vscode.window.showWarningMessage(msg, {modal:true}, 按钮)`，msg 里用
   `vscode.extensions.getExtension(id)` 取**真实** displayName/publisher 展示。
3. 新模块 `src/vscode/headlessRuns.ts`（无头会话登记）：Map<name, {core, resolver,
   timeoutTimer}>；runPrompt 在这里建/取 core、发起 send、挂 settle 桥。
4. `src/pi/piClient.ts`：工具裁剪透传——`start()/init()` 里 `sdk.createAgentSessionFromServices`
   已透传 `tools/excludeTools/noTools`（dist bundle 实证）；给 PiClient 加一个启动前设置的
   工具策略字段，init 调用处带上即可。

**关键不变式（错一条就翻车）**
- **单写者**：一个会话文件同一时刻只有一个 PiCore/PiClient。**打开已跑着的无头会话 =
  给既有 core 挂视图（adopt），绝不能新建 core 再 switchSession**——那就是双写者，
  上周的事故本源。adopt 需要：piCore 的 post 桥可重绑（现在是构造器闭包
  `new PiCore(caps, ui, (msg) => this.pipeFromCore(msg, tabId), version)`，panel.ts:275
  ——改成 setPost/代理）；panel 的 claimSession/findHolder 双开守卫（panel.ts:299+）
  与 adopt 路径对齐，别破坏。
- **settle 桥**：现成先例 `core.onRunStart/onRunSettled`（panel.ts:285-287 赋值处）——
  同款加 `core.onRunEnd`（onPiEvent 的 agent_settled 分支触发，protocol.ts:699），
  headlessRuns 的 resolver 挂它上面；timeoutTimer 到点调 `client.abort()`（piClient.abort
  已有）后 resolve timeout。
- **同名拒收**：headlessRuns 里 name 在跑 → `{ok:false, reason:"busy"}`；跑完释放登记
  （或保留会话本体，只释放 run 状态）。
- **会话落盘**：无头会话照常走 SessionManager（审计红线，piClient 有 `--no-session`
  焊死拒绝）；列表天然可见（sessionCache 扫文件，不用另做）。
- 授权校验放在命令入口第一行（reject 早于任何副作用）；runPrompt 的 prompt/结果
  天然落会话文件，通知只记「谁何时跑了什么」不记令牌。

**验证点**：compile 全绿 + 全套 `npm run test:*` 回归 + runPrompt 三态探针
（settle resolve / busy 拒收 / timeout 自动 abort，放 scripts/probe/，参照被删的
follow-probe 裸跑姿势：`PiClient.prototype` 调用 + 假对象）+ 授权探针（未注册/令牌错
拒收零副作用、重调不静默重发、过期拒收）+ 注入防线探针（tools 白名单透传生效、
只读步工具集不含 bash/write）。

**施工纪律**（本仓硬约定）：机械批量改动用脚本+「恰好命中 1 次」校验（edit 多行锚点
被 CRLF 卡，已实锤）；每刀独立提交；`npm run compile` 逐刀过；改 protocol 只增不改；
webview 新代码语法不限但存量 var 不迁移；测试段别自己测自己（独立测试另派，di-duck
技能）。

## 三、本周学费（都付过账，别再付）

1. **常驻路径禁重活**：500ms 同步 readdir（46ms×2）曾把 VS Code 整窗钉死——
   watcher 用事件驱动 + 冷却；渲染用合批；重载只在用户动作时付费。
2. **Windows CRLF**：edit 工具多行锚点会被 \r\n 卡死——机械批量改动用**脚本 +
   精确字符串命中恰好 1 次**的校验（`.mjs` 跑完即删）；换行符被搅时用
   `git show <基线>:<file>` 整文件还原，不修 diff 噪音。
3. **范围错误比 bug 贵**：工单32 把「点名跟随」做成「全局监听」，启发式误判连锁
   事故三轮——新功能先问「默认关闭还是常驻」，能点名开启就点名开启。
4. **多会话并发是 pi 的正常态**（用户实测）：进程内跑 agent ≠ 单线程跑重活
   （工具是独立进程、模型在远端），别再拿负载论反对进程内方案。
5. 独立测试段（di-duck-dispatch）抓过 P1（compact 绕锁）——新活照走「施工→独立
   测试→返修」流水线，任务书五段自包含（该技能在 .pi/skills/di-duck-dispatch/）。

## 四、验收（契约 v2 §四 A-G，收单对照）

A 垂类点开始 runPrompt 跑完 resolve、B 运行中打开即 0 延迟实时流、C 跑完页面续聊、
D 超时/停止 abort 生效、E 未装 pi-vscode 提示不崩（ops-panel 侧）、F 多垂类并发互扰、
G 未注册/令牌错调用拒收零副作用。注入防线探针：tools 白名单透传生效、只读步工具集
不含 bash/write。

## 五、口令（本仓惯例）

- 用户发 `2`/`222` → 施工会话按 DIRECTOR.md 工单区开工；`1`/`111` → 总监验收循环。
- 施工回报写 BUILDER.md（直令留痕 ✅活14）；工单里的「三处查留证」勿重查。
- git 只本地 commit，push 等用户明示；禁 amend（并行会话事故先例）。
