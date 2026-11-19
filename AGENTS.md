# AGENTS.md — pi coding agent 的 VS Code 图形界面

进程内直连 pi SDK 的 VS Code 插件。本文件只放**每次都要遵守的东西**；
架构细节、事故经过、历史决策在 `docs/decisions.md`，改到对应模块时按节查。
本文件不进 vsix（`.vscodeignore` 已排除）。

## 角色与协作（新会话接任入口）

> **角色由用户赋予**：新会话先等用户点名再上岗，没被点名就不是任何角色。

- 被点名**总监** → 读 [总监.md](总监.md)（验收/裁决/签工单，不写业务代码）；用户发 `1`/`111` = 触发验收循环
- 被点名**施工方** → 读 [施工方.md](施工方.md)（按工单施工）；用户发 `2`/`222` = 按 [DIRECTOR.md](DIRECTOR.md) 当前工单开发
- 工单队列：[DIRECTOR.md](DIRECTOR.md)；已完结：[归档.md](归档.md)；施工回报：[BUILDER.md](BUILDER.md)
- 战役档案：[docs/history/](docs/history/)（一个战役一份，只读）
- **当前进度：[PROGRESS.md](PROGRESS.md)**（每次接任先读它）

## 铁律（改代码前逐条过，细节见 docs/decisions.md）

1. **能用 pi 原生能力就用 pi**：新功能先查 pi 的公开 API / TUI 行为 / 扩展生态三处，都不行才自己写。（§二）
2. **会话必须落盘**：任何路径禁止 `--no-session` / ephemeral，禁令焊在 `piClient` 入口。（§十一）
3. **还原守卫不许「优化」**：只还原 pi 工具命中的文件；`write` 碰过的未跟踪文件不可还原；
   patch 逆向任一行不符即拒打不落盘。（§七）
4. **两处兜底不许删**：steering 自愈（"already processing" 转 steer）、4s pendingPrompt 兜底。（§八）
5. **改 harness 必须 bump `harness.json` 的 version**（只升不降，不 bump 已装副本不更新）。（§三）
6. **核心禁 import vscode**：核心逻辑进 `piCore.ts`，宿主能力经 `HostCapabilities` 注入。（§五）
7. **协议同步三处**：发送方、接收方、`protocol.ts`。（§九）
8. **模板只放结构**：`index.html` 里不许有 CSS/JS 主体，样式进 `headAssets`；CSP nonce 必须配对。（§九）
9. **webview tsc 零报错**（`strict:false` 也要零，不许 `@ts-nocheck`）。（§九）
10. **版本号口径**：`ship` 跟市场线；本地测试包号跳号/回退不是事故，别排查。（§十二）
11. **pi 内置随包分发**：不要求用户装 node/npm/pi。（§一）
12. **注释文化**：记录事故教训的注释必须随逻辑走，丢注释比丢代码严重。（§八）

## 工作方法：边干边记

**每个会话都要留下可续的进度，不靠记忆、不靠摘要。**

- 每完成一个**可验证的步骤**（一个文件改完 / 一个单收单 / 一个 bug 定位 / 一个决策拍板），
  **立刻**往 [PROGRESS.md](PROGRESS.md) 追加一行：`<时间> ✅ <做了什么> → 下一步：<什么>`。
- **不许攒到会话末尾再写**：压缩、断线、上下文被摘掉时，"打算写"的东西一起没。
- 新会话或压缩后，第一件事：读 `PROGRESS.md` 最后 20 行 + `git log --oneline -10` +
  `git status`，再动手。
- `PROGRESS.md` **只记状态，不记细节**（细节进 commit message 与 `docs/decisions.md`）；
  **滚动窗口**：日志只留最近 25 条，超出就删最旧的（**不归档**——已完成的事实已在 `git log` 里，
  归档只是把膨胀从根目录挪到 `docs/`）。**预算按 token 算不按行算**：整文件 ≤ 1.5k token
  （估法 `字符数 / 2.2`），每条 ≤ 2 行。理由见下节「文档预算」。
- 破坏性操作前先写一行「准备做 X，回滚方式 Y」——中途断了也知道停在哪。

## 压缩后第一件事（上下文被摘掉时）

> 为什么写在这里：AGENTS.md 进的是 **system prompt**，每轮重发、**不参与压缩**。
> 写进对话的内容会被摘要稀释，写在这里不会被摘掉。

- 压缩的代价（pi 实现口径）：只有最近 `20k token` 原文保留，其余变 7 段摘要；
  工具输出每条**只留前 2000 字符**、thinking 全部丢弃。摘要只保证「文件路径、函数名、错误信息」，
  **不保证**保留被否决的方案、踩过的坑、边界禁令。
- 看到上下文突然变短或出现压缩摘要块时，**先重读再动手**：`PROGRESS.md` → 本文件「铁律」→
  当前工单 → 相关 `docs/history/*.md` → `git log --oneline -12` + `git status`。
- 摘要只回答「接到哪一步」，工单与提交记录回答「哪些路不许再走」。
  **不许凭摘要里的记忆做破坏性操作**。

## 工具用法（省上下文）

- **查代码只用 read / grep / find / ls 工具，bash 只跑命令**（构建、测试、git、node 脚本、目录操作）。
  禁止用 bash 里的 `grep`/`sed`/`awk`/`cat`/`head`/`tail` 读源码——每次切片都进上下文，切口各不相同，
  越到后面越拼不出全貌。实测代价：416 轮里 334 次 bash（167 grep + 105 sed），`read` 只用了 3 次。
- 例外：对 bundle / 生成物 / 超大文件（`dist/`、`vendor/`、数百 MB 的 jsonl）做一次性取证，
  用 shell 过滤后仍要收窄输出，并在回复里说明为什么不能走工具。
- **改完统一编译一次**，不许拿 `npm run compile` 当探针反复跑。
- 大面积搜索先收窄再打（限定目录/后缀/`-l`），禁止无过滤的全仓 `grep -rn`。

### 共享工作树提交纪律（多会话并行时）

- **禁止 `git add -A`**；提交用 pathspec 直提 `git commit -m "..." -- <自己的文件>`——
  index 是共享的，别人同刻 `git add` 的内容会被你的 commit 一起带走。
- 提交后立刻 `git show --stat HEAD` 自检文件集，多一个都算事故。
- 别人的未提交改动一律不碰；文件重叠先停下问用户。

### Windows/git 实操坑

- 本仓 `core.autocrlf=true`：`git checkout --` 会把工作区写成 CRLF；假 ` M` 先 `git update-index --refresh -- <文件>`。
- 未跟踪文件不能靠 pathspec 直提：先 `git add -- <显式路径>`，再 commit。
- git-bash 的 `/tmp` ≠ node 的 `/tmp`（node 解析成 `D:\tmp`）；跨进程传路径用 `$TEMP`。

## 文档纪律

- **仓库只存结论，不存过程**：长期值钱的是决策、边界、当前状态。编译输出、测试数字只在收单那刻有用。
- `REPORT-*` / `TEST-*` / `SCOUT-*` 写**项目内** `.pi/reports/`（已 gitignore、不进 vsix），
  收单时把 1-5 行「决策 / 坑 / 遗留债」抽进 `docs/history/` 或 `DIRECTOR.md` 注记，**归档后即抛**。
  不许写 C 盘 / `%TEMP%`，也不许入库。
- `docs/history/`：**一个战役一份**，战败即归档，不再新增文件名。
- `归档.md`：只写「工单号 + 结论 + commit 哈希」，不存过程。
- 派单任务书**写在 `task` 参数里，不落文件**（2026-11-19 改口径）：`task` 才是施工方真正收到的指令，
  再写一份是重复拷见。只有**重派/换模型**或**施工方会跑很久**（它自己压缩后 `task` 会被稀释）才落
  `.pi/dispatch/`（gitignored，不进仓、不 commit、**不落根目录**）。落到根目录就是垃圾源，
  且「删文件」与「agent 正在读」在赛跑（t34 实测过）。

### 文档预算（三条，机械可判定，不靠自觉）

> 为什么是 token 不是行数：`AGENTS.md` + `PROGRESS.md` 是**压缩后要重读**的东西（记忆接力靠它们
> 恢复环境），体积直接乘进每次恢复成本；而行数上限需要人判断「这条还有用吗」，判断模糊就会放水。
> 教训：`归档.md` 在「只追加、只迁入、不删」规则下长到 3,323 行 / 74k token —— 同一个机制
> 正在 `PROGRESS.md` 上重演。

1. **单文件 token 硬上限**：`PROGRESS.md` ≤ **1.5k**、`AGENTS.md` ≤ **3k**（估法 `字符数 / 2.2`）。
   超了就砍，不讨论。AGENTS.md 是系统提示里**每轮重发**的固定税，所以比 PROGRESS 更贵，
   两个都必须小，但 AGENTS 装的是铁律，给小一点的额度不合理。
2. **`PROGRESS.md` 每条 ≤ 2 行**：待办只说「是什么 + 在哪」，修法/理由/风险一律进 `DIRECTOR.md`
   工单或 `docs/decisions.md`。
3. **每个小节 ≤ 1 屏**：超了说明这个战役还没收官，细节该进 `docs/history/`（只读、不追加）。

配套一条**可重建性**原则：`PROGRESS.md` 的每条内容，唯一事实源都在别处（做完的在 `git log`、
待办的在 `DIRECTOR.md`、决策的在 `docs/decisions.md`）——所以它随时可以重写、可以狂删。
反过来，声称自己是**唯一事实源**的文件谁也不敢删，于是必然膨胀（`归档.md` 就是这么长的）。

## 命令

| 命令 | 用途 |
|---|---|
| `npm run compile` | 完整构建（webview 类型检查 → vite → tsc），提交前必跑 |
| `npm run package` | 本地打测试 vsix（自动 bump patch，不动 git） |
| `npm run ship` | 正式发版一条龙（bump → 构建 → commit → push → publish） |

调试：F5（任务 `watch all`，tsc + vite 双 watch）。测试：`npm run test:<名字>`，全部在 `scripts/test/`。

## 结构

```
src/core/       piCore.ts 核心控制器 / hostCapabilities.ts 宿主接口 / protocol.ts 消息协议 / i18n.ts / subagentLedger.ts
src/pi/         piClient.ts pi 适配器（RPC 语义对照在头注释）/ piSdk.ts pi 包加载 / ensureSubagentHarness.ts
src/domain/     subagentSnapshot.ts / subagentNames.ts / toolDetail.ts / patchRevert.ts / priceTable.ts / usageTotals.ts / jsonlTail.ts
src/vscode/     extension.ts 入口 / panel.ts 适配器 / webview-html.ts 装配 / sessionsView.ts / transcriptTab.ts
harness/        subagent 扩展（随包分发，改必 bump version）/ skills/pricing-table
webview/
  main.ts       368 行：引导 + 装配 + 页面级 chrome
  core/state.ts
  features/     sessionView / subagentDock / composer / messageList / statusBar / liveStream / tabs /
                toolRows / outline / sticky / renderQueue / markdown / linkify / changesPage / ctxPopover
dist/webview/   vite 产物（不进 git，进 vsix）
docs/           decisions.md（架构与决策档案）/ history/（战役档案）
```

**拆分历史**：`webview/main.ts` 3269 → 368 行（12 刀，2026-11-19），总账与回滚见
`docs/history/交接-webview拆分完成.md`。
