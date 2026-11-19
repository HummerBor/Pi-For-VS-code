# 结案 · 子 agent 展示链路 + 面板 boot 疑云（2026-11-02 更新）

> 本文原名「子agent三件候选与boot杀手」，2026-11-02 会话已把两件都结案并落地，
> 旧结论（「9cf636f 三件里有一件杀面板 boot」）已被证伪，故整篇重写。自包含。

## 一、结案：面板「发不出消息」不是代码杀的

**旧结论（已证伪）**：`9cf636f` 三件修复里有一件杀面板 boot，所以回滚。

**真因**：扩展宿主重启（装/更新扩展、重载窗口）后，VS Code 只重新序列化**部分**编辑器
面板——08:13 那次 `p203` 有完整 `deserialize → attachView → webviewReady`，而同窗口的
`p226`（用户正在用的）**零装配日志**。扩展侧 provider 实例丢失，webview 却因
`retainContextWhenHidden` 保活照旧活着：界面在、能打字、消息全进虚空，连点击也全哑
（点击要发消息给宿主）。「同构建两窗口只活一个」也是这个原因。

证据链：`[装配]` 四点埋点（`ff7ed8b`）——`deserialize` / `attachView enter` /
`attachView html set` / `attachView wiring` / `ensureCore` / `PiCore ctor`。

**为什么旧会话误判**：回滚后「正常了」只是那次重启恰好把面板恢复了；`9cf636f` 与 boot
无关（本次树里早已没有它，照样复现过一次）。教训：**「回滚后好转」不等于回滚的就是凶手**。

**已做的处置**（`1c033e8` → **2026-11-02 用户拍板退役**）：
- 当时的做法：webview 每 3s `ping`，宿主 panel 层直回 `pong`（不进 core），12s 无答挂顶部红条
- **为什么退回**：判定是「距上次 pong 的绝对时长 > 12s」且发完 ping 立刻判定——分不清
  「对面死了」和「我自己刚醒」。实测被 webview 自身卡顿刷成假阳性：日志里 webview 侧
  ping 时间戳连跳 19.4s（定时器漏 6 拍，宿主全程正常），用户看到红条只会认为「插件炸了」，
  还会去关标签、可能打断在跑的会话。假阳性代价 > 收益，心跳 + 红条 + i18n + CSS 四件已删，
  类型 `WvPingMsg`/`HvPongMsg` 一并移除（残留说明见 `webview/main.ts` 文件尾）
- 幽灵面板的处置回到**用户手动关标签重开**（会话已落盘不丢）。VS Code **没有**
  「扩展接管孤儿 panel」的 API，自愈这条路是死的，别再试图自愈，也别再把红条加回来。

## 二、本轮落地（bceebc6..67479a7，19 笔）

### 面板/浮窗
| 提交 | 内容 |
|---|---|
| `ff7ed8b` | 装配链四点埋点（下次 boot 疑案直接钉环，不用猜） |
| `1c033e8` | 断连心跳 + 红条（幽灵面板可见化） |
| `bdfe90d` | 双胞胎行 / 疑似失联：冻结壳自带 `exitCode:0` 骗过判壳 → 判壳改吃回执句柄 |
| `19ba632` | 重放改吃 `frames.jsonl`（SDK 宿主下 `pi.appendEntry` 不落盘），重载后子列表不清零 |
| `613d2f5` | 终态行点开 → 会话页签（不再浮窗下钻）；运行中仍下钻（双写者红线） |
| `d47435d` | 用量只留 `ctx + 金额`，名字不再被挤成「研究...」 |

### 子会话命名与身份
| 提交 | 内容 |
|---|---|
| `8441074` | 页签标题用台账 `agent·task`（子会话 jsonl 里 `name` 空，之前只显示 `11-02 11:54`） |
| `2732b2a` | harness 派单带 `--name` 写 `session_info.name`（面板页签 / pi 原生 Resume 列表都认） |
| `f818a78` | 未注册 agent 名按内置 worker 跑但保留原名（子 agent 是独立进程，面板 guard 够不着） |
| `5bf8e5d` | 展示名 = **职务 · 随机代号**（工程师 · 云雀）；颜色按职务取 |
| `51ea4e5` | 同步单也落独立会话 + 台账，行身份统一用句柄 |

### 左侧会话列表
| 提交 | 内容 |
|---|---|
| `7c26789` | 主列表剔除 `subagents/`（A 件重上） |
| `7eaf485` → `b77dce3` | 子会话折叠组落地；**pi 的 `listAll` 不扫 `subagents/`**（实测 407 条 / subs=0），目录发现只能自己扫 + pi 原生 `parseSessionEntries` 解析 |
| `400e001` | 子会话**挂到主会话下**（父子分组）：台账 `parentSession` + 行首 `▸`；无归属老单进「未归属」组；存量行按名字回找文件可点开 |
| `1d74cfe` | 子 agent 终态自动刷新左侧（`onSubagentSettled` 宿主钩子） |
| `67479a7` | 子会话存储**按项目分桶** `subagents/<项目slug>/<handle>/`（slug 与 pi 的 `sessions/<slug>/` 同规则） |

### harness（内置，`~/.pi/agent/extensions/subagent`，源码在 `harness/subagent/`）
版本已到 **v8**，每次改动必须 bump `harness.json` 的 `version`，否则已安装副本不更新。
历次：v2 帧自写 → v3 `--name` → v4 未注册名兜底 → v5 职务·代号 → v6 同步单落盘
→ v7 `parentSession` → v8 项目分桶。

## 三、当前架构现状（改之前先读）

```
~/.pi/agent/sessions/
├── --d--work-docs-xxx--/             主会话（pi 原生）
└── subagents/
    ├── --d--work-docs-xxx--/         子会话按项目分桶（v8+）
    │   └── sa-11/
    │       ├── <ts>_<uuid>.jsonl     子会话转录（session_info.name = 「职务 · 代号：任务」）
    │       └── frames.jsonl          实时帧（浮窗重放数据源）
    ├── sa-1 … sa-10/                 老单（v8 前平铺，**不迁移**，读取仍兼容）
    └── runs/sa-N.json                台账（全局，按 handle 索引；含 parentSession/sessionDir）
```

链路要点：
- **名字**：harness `--name` → `session_info.name` → 面板标题 / pi Resume 列表 / 浮窗行同源
- **父子**：harness 用 `ctx.sessionManager.getSessionFile()` 记台账 `parentSession`
- **浮窗重放**：读 `frames.jsonl`（不赌 `pi.appendEntry`，SDK 宿主下不落盘）
- **左侧嵌套**：`sessionCache.scanSubagentSessions()` 自己扫目录（pi 没有这个能力）+
  `subagentParentMap()` 读台账 → `nestSubs()`
- **打开子会话**：优先台账 `sessionDir`（分桶后不能拼死路径），退回旧平铺

## 四、挂账 / 已知限制

1. **幽灵面板不能自愈**：VS Code 无 API，只能用户手动关标签重开。原有的心跳红条
   **已退役**（误报让用户以为插件炸了，见第一节），不要重新引入。
2. **老数据不可点开的边角**：v6 之前的同步单没有独立会话目录，靠名字前缀回找文件；
   名字被用户 `/name` 改过就找不回（文件仍在项目会话目录里）。
3. **`subagentNames` 台账（显示名两层分离）已不再参与主链路**：显示名改由 harness 生成，
   台账只作历史兜底。`classifyDispatchName`/`rewriteSubagentInput` 纯逻辑与用例保留
   （诊断/旧数据用），但 `subagentNameGuard` 不再归位改写——归位会抹掉用户自取名。
4. **`piChat.sessionDir` 自定义会话库时**，子会话仍落 `getAgentDir()` 下的默认库
   （harness 的 `subagentsBase()` 不看该配置）。需要再统一时改 `runDirFor`。

## 五、纪律（血泪，勿犯）

- 脏树禁 `git add -u`，一律 pathspec 提交（曾把坏代码卷回并重编译，砸用户面板两次）。
- 二分期不动用户正在用的构建：先报用户、点头才 compile；验证 = 用户重载试发。
- **「回滚后好转」不等于回滚的就是凶手**——先看日志指纹再下结论（本次旧结论就是这么错的）。
- 机械对照代替脑子模拟：pi 到底扫不扫某个目录，跑一次 `listAll` 数结果，别推理。
- harness 改文件不热更新：必须重打包/重载 + bump version，派单才走新代码。
