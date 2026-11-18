# SCOUT-t34-verify · 真机验收清单 + 「点发送没反应」可判定分支树（只读侦察）

> 基线：本报告行号**定格在 `b706911`**。侦察开始时 `git status --short` 只有未跟踪的 `dispatch-*.md`、
> tracked 文件零改动；侦察全程读的是 `git show HEAD:webview/main.ts`，未读未改工作区文件。
> 本单只写本文件，未改代码、未装包、未重启、未 commit。
>
> **行号迁移提醒**：侦察期间 HEAD 已从 `b706911` 前进到 **`724cc1a`（第 3 刀：子 agent 浮窗整块搬进
> `webview/features/subagentDock.ts`，main.ts 从 2654 行降到 2229 行）**。与浮窗有关的那几条请在
> 新文件里对应看（DOM 类名/结构未变，**§4 的 DevTools 判据与「预期」全部照用**）：
>
> | 本报告旧行号（main.ts@b706911） | 现文件行号（subagentDock.ts@724cc1a） |
> |---|---|
> | 2131 `subRunsByTab` 定义 | 142 |
> | 2157-2161 `SUB_STALE_MS`/`runStale` | 168-171 |
> | 2204-2216 `renderSubDock` 判空 | 214-225（判空 220-225） |
> | 2272-2292 台账并入 + `liveSeen` | 284-303（`liveSeen` 286-294） |
> | 2304-2310 + 2321-2324 封顶 8 行/展开 | 317-319 + 332-333 |
> | 2339 三态徽标、2352-2357 失败原因行 | 350、363-369 |
> | 2364-2376 时间列、2422-2427 秒表 interval、2429-2441 `refreshSubTimes` | 374-380、433-437、440-452 |
> | 2380-2390 失联行 `✕` 手动清除 | 396 附近 |
> | 2605-2619 `subagentUpdate` 截获/closed 壳删除 | 493 附近 |
>
> `bindComposerOnce`/`bindViewEvents`（main.ts:282-337、1734-1740）在拆分刀之前，**行号仍适用**；
> `piCore.ts`/`panel.ts`/`piClient.ts`/`harness/**` 本次未变。旧行号仍可用 `git show b706911:webview/main.ts` 校对。
>
> 日志证据取自 `~/.pi/agent/pi-chat-debug.log`（1.85 MB，**最后一行 `2026-11-18T08:42:53.020Z`**，即本次侦察前
> 没有新会话写入）与 `pi-chat-debug.log.1`（2.37 MB，轮转于 2026-11-18T15:16 本地）。

---

## 0. 结论先行

1. **三项「没验的」里有两项在当前装机状态上验不了：`单表观感` 整项 + `kill 立即落终态` 这一条——但失败原因是包没装，不是代码错。**
   已装扩展 `0.1.50` 的 webview 产物仍是**两表版**，内置/已装 harness 仍是 **v24**（无 v25 kill 终态帧、无 v26 进程退出补帧）。
   证据见 §1。**验收前置 = 从 HEAD 打新 vsix 装进去 + 重载窗口**，否则「浮窗单表 / 跨页签去重 / kill 立即终态」三项
   验的是老代码。
2. **「点发送没反应」在本仓库里可以定成一条 5 段判定链**（#input disabled → bindComposerOnce → wvError 落盘 →
   宿主 `in prompt` → pi 拒收），每段都有代码锚点 + 日志锚点 + DevTools 单行判据，见 §3。
   **静态能确证的两处残余风险**（不是当前故障，是下一次同族故障的入口）：
   - `makeSessionView` 函数体 143–1733 行里任何抛错都**绕过** 1734 的 `try/finally` → 输入框永久 disabled；
   - `bindViewEvents` 内部 `bindComposerOnce()`（main.ts:327）并不在函数最前面（前面还有 `changesPage.bind()`、
     `ctxPop.bind()` 等），命脉实际靠 1738-1740 的 `finally` 兜，而不是注释里说的「最前面」。
3. **新发现（代码可证，未真机验证）**：`subRunsByTab` 从不清理 → 关掉派单页签后，该 handle 的台账行被
   `liveSeen` 永久拦掉，浮窗里那单彻底消失（直到 webview 重载）。详见 §5 已定位条 3 + §4 V5 反向用例。
4. kill 后的行状态在快照层被映射成 **`failed`**（`subagentSnapshot.ts:190`），浮窗显示「失败」而不是「已终止」——
   验收时别把它当 bug 报，先确认这是不是用户要的口径（§5 已定位条 6 + §4 V3）。

---

## 1. 前置门：先确认「跑的是哪份构建」

真机验收前必须先过这一关，否则下面每一条都会得到「失败」假阳性。

| 判据 | 实测值 | 命令 |
|---|---|---|
| 已装扩展版本 / 目录 | `0.1.50`，`~/.vscode/extensions/hummerbor.pi-for-vscode-0.1.50` | `ls ~/.vscode/extensions \| grep hummerbor` |
| 已装 webview 产物指纹 | `md5 = b1e8231f3bfe93d460f1da4cba31f2fc`，与仓内 `pi-for-vscode-0.1.50.vsix` 内的 `extension/dist/webview/main.js` **同一份** | `md5sum` 两处 |
| 已装包内置 harness 版本 | `{"version": 24}` | `cat ~/.vscode/extensions/hummerbor.pi-for-vscode-0.1.50/harness/subagent/harness.json` |
| **已装运行副本** harness 版本 | `{"version": 24}`（= `<agentDir>/extensions/subagent/harness.json`） | 同上，路径 `~/.pi/agent/extensions/subagent/` |
| 已装 webview 是两表版还是单表版 | **两表版**：`smLedgerGroup` 在已装 `main.js` 出现 **3 次**（zh+en 字典 + 1 处 `renderLedgerRow` 使用）；工作区 dist 只 **2 次**（纯字典） | `grep -o smLedgerGroup <file> \| wc -l` |
| 输入区命脉加固（`d660b31` 那笔）是否已在装机版里 | **在**：已装 `main.js` 有幂等门 `bt\|\|(bt=!0,g.addEventListener('click',vr),…,p.disabled=!1)`，与 HEAD 源码 main.ts:282-299 同构 | 见下 |
| 已装 harness 是否含 v25/v26 代码 | **不含**：`grep -c "实测幽灵行" index.ts` = 0、`grep -c "写者必发终态帧"` = 0 | — |

已装 harness（v24）代码证据（`~/.pi/agent/extensions/subagent/index.ts`）：

```ts
// 2022-2025 行：kill 只改内存+台账，不发帧（v25 才补 emitAsyncProgress）
			killAsyncRun(run);
			// 终止也要给主会话一个回复（2026-11-13 用户拍板）：...
			reportBackToMain(pi, run);
```

```ts
// 897-925 行：proc.close 里 emitAsyncProgress 只在 status==="running" 分支内（v26 才改成无条件）
	proc.on("close", (code) => {
		...
		if (run.status === "running") {
			...
			emitAsyncProgress(pi, run);
			opts.onClosed?.();
			reportBackToMain(pi, run);
		}
	});
```

对照 HEAD（bundled v26，`harness/subagent/index.ts`）：kill 分支 2028-2032 补 `emitAsyncProgress(pi, run)`；
proc.close 尾部 924-931 注释「【写者必发终态帧 2026-11-19】…」+ 无条件 `emitAsyncProgress(pi, run)`。

**前置操作（由执行真机验收的会话做，不是本单）**：`npm run package` → 装新 vsix → **重载窗口**（不是 reload webview）。
装机后必须复查三处：`#ver` 底栏文字 = 新版本号、`<agentDir>/extensions/subagent/harness.json` = `{"version":26}`、
浮窗里 `history（台账）` 那个分组标题消失。三处任一不符 = 前置没过，停，别往下验。

---

## 2. 通用探测手法（DevTools / 日志）

### 2.1 打开 webview 控制台

命令面板：`Developer: Open Webview Developer Tools`（**不是 F12**，main.ts:34-36 注释已写明）。
侧栏面板与编辑器页签面板各自一份 webview，认准 `#session-area` 存在的那份。

**注意**：`webview/main.ts` 整体是一个 IIFE（main.ts:22），内部变量**没有**挂到 window，DevTools 里只能靠 DOM 判据 +
宿主日志。下文所有 DevTools 命令都是**只读 DOM 查询**（除了 §3.7 那条明确标了「有副作用」的模拟点击）。

### 2.2 日志位置与读法

```
C:\Users\Administrator\.pi\agent\pi-chat-debug.log       # 正在写
C:\Users\Administrator\.pi\agent\pi-chat-debug.log.1     # 轮转保留一代（2MB 上限，dbgAppend）
```

- 写入实现：`src/core/piCore.ts:3095`（`DBG_LOG_PATH`）、`:3106-3130`（fd 常驻 + 2MB 轮转）。
- 时间戳是 **UTC ISO**，本地 = +8。**先 `date` 对一遍再比对**——本次侦察时日志停在 2026-11-18T08:42Z，
  直接 tail 会看到昨天的内容而不自知。
- 高频流式帧不落盘（`panel.ts:980-981`：`delta/thinking/toolCallDelta` 过滤），事件级帧（`in`/`out`/`boot`/状态）全留。
- PowerShell 读法示例：`Select-String -Path "$env:USERPROFILE\.pi\agent\pi-chat-debug.log" -Pattern "webview ERROR" -Tail 20`

### 2.3 前后端锚点对照表（排查任何「界面没反应」都先认这几个）

| 锚点 | 产出位置 | 日志长相 |
|---|---|---|
| webview 脚本开始接线 | `panel.ts:766` | `[装配] attachView wiring`（**此行之后若永无 `in …` = 消息死在 webview→宿主**） |
| webview 抛错落盘 | `panel.ts:842-849` | `webview ERROR [kind] message @file:line` + 6 行栈 |
| 消息进核心 | `piCore.ts:628` | `in prompt tab=p4xx text="…"…87 images=arr(0) files=arr(0) attachCode=false core=p4xx` |
| 核心 promise 分支 | `piCore.ts:1073` | `prompt: images=0 files=0 busy=false` |
| 乐观 busy | `piCore.ts:1521` | `busy=true (prompt_optimistic, wasBusy=false)` |
| 落地到 pi 适配器 | `piClient.ts:485` | `[send] prompt len=42`（steer 时 `[send] prompt (steer) len=…`） |
| pi 真正起跑 | `piCore.ts:2621` | `busy=true (agent_start)` |
| 一轮收尾 | `piCore.ts:2985` | `busy=false (agent_settled, elapsedMs=…)` |
| 宿主发给 webview | `panel.ts:981` | `out <type> tab=p4xx …`；没投递成功另有 `out DROP … [postMessage=false]` / `out … [DROP no-view]` |
| 子 agent 帧 | `piCore.ts:2732-2739` → `panel.ts:981` | `out subagentUpdate tab=p464 id="sa-ef0a128a" snapshot={mode,tasks} final=false startAt=…` |
| 台账推送 | `piCore.ts:769` | `out subagentLedger tab=p464 rows=arr(8)` |

---

## 3. 「点发送没反应」——可判定分支树

判定顺序固定，**每步只回答一个是非题，是就停**（不要跳步猜）。
符号：`$LOG` = `C:\Users\Administrator\.pi\agent\pi-chat-debug.log`。

### 3.0 DevTools 只读探针（先跑这条，一次拿全 6 个字段）

```js
(() => { const v = document.querySelector('.session-view:not(.offview)') || document.querySelector('.session-view');
  return { views: document.querySelectorAll('.session-view').length,
           ver: v ? (v.querySelector('#ver') || {}).textContent : null,
           inputDisabled: v && v.querySelector('#input') ? v.querySelector('#input').disabled : 'no-input',
           inputLen: v && v.querySelector('#input') ? v.querySelector('#input').value.length : -1,
           sendHasIcon: !!(v && v.querySelector('#send') && v.querySelector('#send').innerHTML),
           status: v && v.querySelector('#status') ? v.querySelector('#status').textContent : null }; })()
```

### 3.1 分支 A：`views === 0`（页面里连 `.session-view` 都没有）

- 依据：`sessionArea.innerHTML = ''`（main.ts:1791）会抹掉模板原型，视图只在 `makeSessionView` 里克隆重建
  （main.ts:143-149）。
- 含义：**脚本在 `makeSessionView` 之前就炸了**（模块加载期 / `protoView` 查询 / i18n 缺键等）。
- 判据：`grep "webview ERROR" $LOG` 有 `[error]` 类记录；或 devtools Console 里有红字（此时代码本身没跑起来，
  `reportWvError` 也可能来不及装——它在 main.ts:38-55，属于 IIFE 早期，绝大多数模块级异常能覆盖）。
- 下一步：看栈里第一行是否落在 `main.js` 的视图构造段；若**完全没有**任何日志，往 §3.4（通道/装配）想。

### 3.2 分支 B：`inputDisabled === true`（输入框画出来了但点不动）

这是历史上「点发送没反应、日志零留痕」的那一类（main.ts:273-280 注释自述的事故族）。

代码路径：模板 `webview/index.html:52` 写死 `disabled` → 只有 `bindComposerOnce()` 里的
`input.disabled = false`（main.ts:298）会摘掉它。`bindComposerOnce` 有两个调用点：`bindViewEvents` 内部
（main.ts:327）与视图构建的 `finally`（main.ts:1738-1740）。

- **B-1（有 `webview ERROR [bindViewEvents]`）**：`bindViewEvents` 抛了，`finally` 已把命脉绑上 →
  **输入框此刻应当可用**。若仍 disabled，说明是同一条链里**更早**的抛错（B-2）。
- **B-2（无任何 `webview ERROR`，但 disabled 恒真）**：抛错发生在 `makeSessionView` **143–1733 行**
  （元素查询 `q('#input')` 返回 null、`initChangesPage`/`initCtxPopover` 抛错等）→ 根本没走到 1734 的 `try`。
  **这是静态可证的残余缺口**（见 §5 已定位条 5）。
  但**按理应有 `webview ERROR`**（被 window 'error' 监听接住）——若连这个都没有，怀疑宿主侧
  `onDidReceiveMessage` 还没接线（`panel.ts:767`），webview 的 `wvError` 消息被丢。判据见 §3.4。
- DevTools 复核：`document.querySelector('.session-view:not(.offview) #send').onclick` 为 `null`（用的是
  `addEventListener`，拿不到句柄，正常也是 null）——所以**这条别靠 onclick 判断**，只认 `disabled`。

### 3.3 分支 C：`inputDisabled === false`，但点了发送输入框内容没被清空

`send()` 第一件事是 `input.value = ''`（main.ts:1477），**清空前只有一行早退**：
`if (!t && !pendingImages.length && !pendingFiles.length) return;`（main.ts:1470）。

- **C-1 内容全是空白**：`t = toHalfWidth(input.value).trim()` 为空 + 无附件 → 静默 return（设计如此）。
  判据：DevTools 看 `input.value` 全是空格/换行；或页面上没有附件胶囊（`#attachbar` 子元素数 = 0）。
- **C-2 内容非空却也没清空** → 事件没进 `send`：键盘走了别的分支。**这是最容易误判的一条**：
  `inputKeydown` 里，斜杠/`@` 联想框开着时 `Enter` 先被联想框吃掉（main.ts:1496-1505）：
  - 有选中项 → `applySuggest` 填建议，**不发消息**；
  - 没选中项 → `hideSuggest()` 后**继续往下走**到 1514 行正常发送。
  判据：`document.querySelector('.session-view:not(.offview) #suggest').style.display` 是否为 `block`；
  以及输入框里是否有 `@` 或 `/` 开头的搜索词。
- 另外 `Esc` 会被当成 abort（main.ts:1515-1519）——用户以为「点了没反应」，实际是先中断了在跑的任务。

### 3.4 分支 D：输入框清空了，但日志里**没有** `in prompt`

即消息死在 `vscodeApi.postMessage` 或宿主监听之前（main.ts:170-171 的 `vpost` → `vscodeApi.postMessage`）。

- 判据 1（时间对齐）：`tail -5 $LOG`，看**发送时刻之后**有没有任何 `in …` 行。若连 `out …` 也没有，
  说明这一侧整体静默。
- 判据 2（通道是否曾经活过）：`grep "attachView wiring" $LOG | tail -1`，然后
  `grep -c "^.* in " $LOG`。面板刚打开就发第一条消息时，若 `attachView wiring` 之后一条 `in` 都没有 →
  命中 panel 注释里写的那种死法（`panel.ts:766`：**「此行之后无『in』= 消息死在 webview→接线之间」**）。
  已知时序风险：`applyHtml()`（`panel.ts:733`）**早于** `onDidReceiveMessage` 接线（`panel.ts:767`），
  所以 webview 脚本在接线完成前发的消息理论上会丢——正常由 `webviewReady` 握手补，见 §3.6。
- 判据 3（webview 侧是否报错）：`grep "webview ERROR" $LOG`。`vpost` 本身不 try/catch，
  若 `postMessage` 抛错会进 window 'error' → 落盘。

### 3.5 分支 E：有 `in prompt`，但**没有** `prompt: images=…`

`in` 由 `piCore.onWebviewMessage` 打（piCore.ts:628，所有消息都打），`prompt:` 在斜杠命令拦截**之后**
（piCore.ts:1073）。所以「有 in 无 prompt:」= 被拦截：

- `nativeSlashCommands()` 命中（piCore.ts:1048-1052）→ 本地执行该命令，webview 会有对应 UI/notice；
- `tuiOnly` 表命中（piCore.ts:1053-1072）→ **只发一条 notice**（`/login`、`/help`、`/copy`、`/quit` 等）；
- 判据：`grep -A2 "in prompt" $LOG | tail -8` 看 `text="/…"` 首 token。
- 若不是斜杠命令却仍无 `prompt:` → `dispatchWebviewMessage` 在它之前抛错，被
  `onWebviewMessage` 的兜底 catch 接住（piCore.ts:632-636）→ 界面出 `opFail + err.message` 的 notice。
  这类**不写日志**，只能看界面上那条红/黄提示。

### 3.6 分支 F：`prompt:` 有了，但界面像「没发出去」

按时间线继续比三段日志，命中哪段就是哪段：

| 现象（日志） | 位置 | 结论与下一步 |
|---|---|---|
| 有 `prompt:`，**没有** `busy=true (prompt_optimistic` | piCore.ts:1508 `ensureClient()` 抛错 | 命中 piCore.ts:632-636 兜底 → 界面 notice；查 `boot FAIL`（piCore.ts:552）/ `pi 未启动`（piClient.ts:394） |
| 有 `busy=true (prompt_optimistic`，**没有** `[send] prompt len=` | `sendPromptCore` 在 `client.prompt()` 之前抛错 | 空窗极小；看 `busy=false (prompt_send_fail: …)`（piCore.ts:1598） |
| 有 `[send] prompt len=`，**4s 后** `busy=false (4s_pendingPrompt_fallback: no agent_start within 4s)` | piCore.ts:1552-1560 + 1521 兜底 | **pi 侧 init 未完成**（`client.ready()` 挂起，piClient.ts:393-396）。消息没丢，等 boot 完成才真发；观感就是「发了没反应 + Working 闪一下就没了」。查 `boot phase=…`（piCore.ts:496）最后停在哪一段 |
| 有 `prompt_send_fail: X` | piCore.ts:1598 | **pi 真拒收**：`compaction is in progress`（压缩中）/ 无模型 / 无 key。界面 notice 已映射成人话（piCore.ts:1601-1603） |
| `steer_resend` / `steer_resend_skipped` | piCore.ts:1578 / 1586 | busy 标志竞态自愈，**属正常路径**（AGENTS.md 明令「steering 自愈别删」） |
| 有 `busy=true (agent_start)` 但界面不画消息 | piCore.ts:2621 之后 | 已不属「没发出去」，转查渲染/页签路由：`out user` / `out delta` 是否带对的 `tab=`；`out DROP … [postMessage=false]` 就是被 webview 丢弃 |

### 3.7 兜底一步：模拟点击（**有副作用**，只在前面全绿时用）

```js
(() => { const v = document.querySelector('.session-view:not(.offview)');
  const i = v.querySelector('#input'); i.value = 'probe-t34-ignore';
  v.querySelector('#send').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { afterLen: i.value.length }; })()
```

判据：`afterLen === 0` = `send()` 跑了（与 §3.4 对齐看日志）；`afterLen > 0` = 事件没绑上（回到 §3.2）。
**副作用**：若 pi 正常，会真的往当前会话发一条 `probe-t34-ignore`。只在确认不影响会话时用。

---

## 4. 真机验收清单（操作路径 → 预期 → 失败时看哪里）

> 「自动」= 仓库内脚本可覆盖的部分（不需要人点）；「半自动」= 需要开 DevTools 粘一行；「人工」= 必须人眼看/人点。
> 所有条目默认已过 §1 前置门。
> DevTools 通用取值命令（下称 `$DOCK`）：
> ```js
> [...document.querySelectorAll('.subdock .sm-row')].map(r => ({
>   cls: r.className,
>   agent: (r.querySelector('.sm-agent')||{}).textContent,
>   st: (r.querySelector('.sm-st')||{}).textContent,
>   task: (r.querySelector('.sm-status')||{}).textContent,
>   time: (r.querySelector('.sm-time')||{}).textContent }))
> ```

### V1 · 派单后浮窗出行（名称/状态/父任务/时间，不露 `sa-xxxx`）

| 项 | 内容 |
|---|---|
| 操作 | 主会话让 agent 派一单 `async: true`（chain 天然同步，别用它） |
| 预期 | ① 页头 `#subind` 亮起（首次派单后**常驻**，main.ts:2080-2089）；② 右上浮窗 `.subdock` 从图标处展开；③ 出现一行 `.sm-row.running`：`agent` = 调用方给的名字（如「工程师 · 云雀」，缺省是随机「职务 · 代号」）、`st` = 「处理中」、`task` = 派单任务首 48 字（去掉 `*_`#`）、`time` = 秒表（`0s` 起）；④ **行内不出现 `sa-` 开头的句柄**（main.ts:2273 注释：不再露句柄） |
| 失败时看哪里 | `grep "out subagentUpdate" $LOG \| tail -5` —— 有 `out` 没行 → webview 侧（`$DOCK` 看是否有 `.sm-row`，或 `webview ERROR`）；没 `out` → 帧没从 pi 出来：查 harness 是否 v26（§1）、`grep "subagent-async" 会话文件`、harness stderr |
| 正常噪声 | `out subagentUpdate … id="call_xxx" … closed=true` 是**同步壳行被删**（main.ts:2609-2614），不是故障；真行 id 是 `sa-xxxxxxxx` |
| 类型 | 人工（结构化断言靠 `$DOCK` 半自动） |

### V2 · 秒表与状态（浮窗行 + 主会话状态行）

| 项 | 内容 |
|---|---|
| 操作 | V1 单在跑时，停在面板上 10s；然后让单跑完 |
| 预期 | ① 浮窗运行行的 `time` **每秒跳**（`setInterval(…,1000)` main.ts:2422-2427）；② 主会话状态行 `#status` 显示 `⠋ Working… Ns` 并走秒（main.ts:583-600，120ms 一跳）；③ 跑完后浮窗行移入「完成」组、`time` 变相对时间（「刚刚/N分钟前」，`fmtRel` main.ts:2173-2180），主会话状态行**冻结成白字总用时**（`.done` 类，main.ts:606-616），**不是归零、也不是消失**；④ 状态行 chip `#subchip` 只显示 `⚙ <agent>`，**不带第二只表**（main.ts:2253-2260） |
| 失败时看哪里 | ①「整块冻住」= `refreshSubTimes` 走空（main.ts:2429-2441，`data-el`/`data-ts` 缺失）；②「Working 永远不落白字」= 宿主 `agent_settled` 没到 / `busy` 帧丢（`grep "busy=false (agent_settled" $LOG`）；③「浮窗说完成但主会话还在跑」= 正常（同步单阻塞回合，`subagentSnapshot.ts:180-186` 注释） |
| 类型 | 半自动（`$DOCK` 隔 1s 采两次比 `time`）+ 人工判白字 |

### V3 · kill 后立即落终态（v25 + v26）

| 项 | 内容 |
|---|---|
| 前置 | harness **v26**（§1），否则必失败 |
| 操作 | 让主 agent 对在跑的 `sa-xxxxxxxx` 调 `subagent_kill`（或让它自己决定终止） |
| 预期 | ① **≤1–2s**（不是 30 分钟）内该行从「已开启」移到「完成」组；② 行图标停转（无 `.spin`）；③ `time` 变成相对时间（**不再一秒一跳**）；④ 主会话 `#status` 的 Working **收尾/冻结**（`anySubLive` 不再为真）；⑤ 该单会给主会话回传一条「已终止」消息 |
| 时间列口径提醒（代码可证） | 首帧终止帧**不带 `endedAt`**（`killAsyncRun` 只写台账不写 `run.endedAt`，harness:1154-1160；帧字段取 `run.endedAt`，harness:1096-1098），要等子进程 `close` 补第二帧才有 `endedAt`（harness:898/924-931）。所以**kill 后极短时间内**时间列可能显示「按 startAt 算的相对时间」，若有 5s SIGKILL 兜底，最多差 5s 才纠正 |
| 失败时看哪里 | ① `grep "out subagentUpdate" $LOG \| tail -5`：kill 后应出现 `final=true`（有 `endAt=` 才是 close 帧）。**没有 final=true 帧 = 帧没发（harness 还是 v24）**；② 有 final=true 帧但界面不动 → `$DOCK` 看行的 `cls`（仍 `running` = `updateSubRun` 没被调 / 视图不是活动页签，main.ts:2616-2618）；③ `grep "out toolEnd.*subagent_kill" $LOG` 是 kill 工具回执（宿主侧台账刷新钩子 piCore.ts:2750） |
| 类型 | 人工（日志判据半自动） |

### V4 · 浮窗只有一张表（4769d0c）

| 项 | 内容 |
|---|---|
| 操作 | 派过至少 2 单（一跑完一在跑），展开浮窗 |
| 预期 | ① 只见两个分组标题：`已开启` / `完成`；**没有**「历史（台账）」第三组；② **任何行都不含** `sa-[0-9a-f]{8}` 文本；③ 台账里的存量单按状态**并入**同样两张表（main.ts:2272-2292）；④ 「完成」默认只露 8 行，多出的显示「…还有 N 条」点开全量（main.ts:2304-2310 + 2321-2324）；⑤ 失败行第二行显示**失败原因首行**（`t.error`，main.ts:2352-2357），不显示任务摘要 |
| 失败时看哪里 | 出现「历史（台账）」= 装的是两表版（§1：`smLedgerGroup` 计数 3 vs 2）；行内露句柄 = `renderSubRow` 里有人加了 `t.handle` 输出 |
| 类型 | 半自动：`[...document.querySelectorAll('.subdock .sm-group-title')].map(e=>e.textContent)` 必须只包含 `已开启`/`完成`（不含「历史（台账）」）；`[...document.querySelectorAll('.subdock .sd-body')].some(b=>/sa-[0-9a-f]{8}/.test(b.innerText))` 必须为 `false` |

### V5 · 跨页签去重（liveSeen）

| 项 | 内容 |
|---|---|
| 操作 | 页签 A 派一单（浮窗有活行）→ 切到页签 B（B 也收到过 `subagentLedger`） |
| 预期 | B 的浮窗里**不出现**同一 handle 的台账行（`liveSeen` 跨页签建表，main.ts:2275-2283）；`#subind` 在 B 仍亮（`subLedgerRows.length > 0`，main.ts:2083）；A 的活行照常 |
| 反向用例（**本单新增，重点验**） | 见 §5 条 3：**关掉 A 页签**后切到 B —— 该 handle 的台账行**应该**补出来，但按当前代码**不会**（`subRunsByTab[A]` 残留 → `liveSeen` 恒真） |
| 失败时看哪里 | `grep "out subagentLedger" $LOG \| tail -3` 看 `rows=arr(N)`；B 页签浮窗无行时先确认 `subLedgerRows` 非空（`$DOCK` 空 + `.subdock.hidden` 说明整块被 `!subLedgerRows.length` 判空，main.ts:2209-2214） |
| 类型 | 人工（跨页签，DevTools 只能看当前 webview，多面板则要各开一份） |

### V6 · 失联降级（30 分钟，可选，成本高）

| 项 | 内容 |
|---|---|
| 操作 | 无法真等 30 分钟，**不建议真机验**；只在有真实长静默单时顺带看 |
| 预期 | `lastFrameAt` 超 30 分钟（`SUB_STALE_MS` main.ts:2157-2161）→ 徽标「疑似失联」、停表、图标停转、悬停出 `✕` 可手动清除（main.ts:2331-2335 + 2380-2390） |
| 类型 | 自动（`scripts/test/subagentSnapshot.test.mts` 覆盖快照层；DOM 层无覆盖） |

---

## 5. 已定位（代码/日志可证） vs 待真机验证的假设

### 已定位（有文件:行号或日志原文）

| # | 结论 | 证据 |
|---|---|---|
| 1 | 已装 `0.1.50` 的 webview 仍是**两表版**，内置/已装 harness 仍是 **v24**；「单表 / 跨页签去重新逻辑 / kill 终态」三项在当前装机上无法通过 | 已装 main.js `smLedgerGroup` 计数 3（含 1 处使用）vs 工作区 dist 2；`harness.json` 两处均为 `{"version": 24}`；已装 harness 缺 v25/v26 标记（`grep -c` 均 0） |
| 2 | 输入区命脉加固（`bindComposerOnce` 幂等 + try/finally）**已在** 0.1.50 装机版里 | 已装 main.js 内联 `bt\|\|(bt=!0,g.addEventListener('click',vr),…,p.disabled=!1)` |
| 3 | **`subRunsByTab` 无任何清理路径**：关页签只 `dispose()` 视图（main.ts:1754-1760），`handleTabs` 也只删 `views[id]`（main.ts:2589-2594）；`subRunsByTab` 只在 2131 定义、2196 写入、2276 遍历，**无按页签删除**（2611 只删页签内单条 run，不删页签键） | `grep -n subRunsByTab` 全仓六处：2131/2141/2196/2276/2500/2610 |
| 4 | `bindViewEvents` 内的 `bindComposerOnce()` **不在函数开头**（main.ts:327，前面还有 changesPage.bind/ctxPop.bind/＋菜单），注释「bindViewEvents 前面炸了也照样能发」靠的是调用点 `finally`（1738-1740），不是这一行 | main.ts:301-327 vs 1734-1740 |
| 5 | `makeSessionView` 143–1733 行**不在** try 覆盖范围内：这段里抛错 → `bindComposerOnce` 永不执行 → `#input` 永久 disabled | 143（函数起）…1733（try 之前），1734-1740 才 try |
| 6 | kill 的行状态在快照层映射为 **`failed`**（不是单独的 killed 态）→ 浮窗徽标「失败」 | `src/domain/subagentSnapshot.ts:189-190`；`main.ts:2339`（三态只有 running/failed/else） |
| 7 | kill 首帧**不带 `endedAt`**，要等子进程 close 补第二帧 | `harness/subagent/index.ts:1154-1160`（killAsyncRun 不写 `run.endedAt`）+ `:1096`（帧取 `run.endedAt`）+ `:924-931`（close 补帧） |
| 8 | webview 侧 `send()` 无任何日志；「消息死在 webview」在日志上**只能靠缺席推断** | main.ts:1468-1482 无 `postMessage` 前埋点；对照 panel 侧有 `in`/`out` 双锚点（panel.ts:773/981） |
| 9 | `applyHtml()`（panel.ts:733）先于 `onDidReceiveMessage`（panel.ts:767）；wire 之后才留 `[装配] attachView wiring` 锚点（panel.ts:766）——面板注释已把「wiring 后无 in」定为死链判据 | panel.ts:733/766/767 |
| 10 | `dispatchWebviewMessage` 的兜底 catch **只发 notice、不写日志**（piCore.ts:632-636），所以「有 in、无 prompt:、界面有提示」这类故障在日志里是断档的 | piCore.ts:632-636 |
| 11 | 本次侦察期日志**不含**任何新会话：最后一行 `2026-11-18T08:42:53.020Z`（`out subagentUpdate tab=p464 id="sa-ef0a128a" … final=false`）。故「kill 终态」「单表」在日志里**无实证**，只有昨天的 v24 行为（`final=true` 帧仅出现在正常收尾/壳删除） | `tail -1 $LOG`；样本 `2026-11-18T08:41:57.243Z out subagentUpdate tab=p464 id="sa-601d69ba" … final=true startAt=1794991315703 endAt=1794991317240`；`2026-11-18T08:01:06.236Z out toolEnd … name="subagent_kill" isError=false text="sa-26a43c2e 已结束（completed），无需终止。"`（唯一一例 kill 是「已结束」早退，不构成 v25 验证） |

### 待真机验证的假设（不得当结论用）

| # | 假设 | 怎么证伪 |
|---|---|---|
| 1 | 装机后浮窗能按预期只出一张表、不露句柄 | §4 V4 的 DevTools 两行判据 |
| 2 | v26 让 kill 后 1–2s 内落终态（含子进程 5s SIGKILL 兜底的最坏路径） | §4 V3 的 `final=true` 帧 + `$DOCK` 观感，量 kill→帧的时差 |
| 3 | 关页签后该单从所有浮窗消失（= §5 条 3 的实际用户可见症状） | §4 V5 反向用例，人眼确认，再决定是否要清 `subRunsByTab` |
| 4 | 「点发送没反应」当前是否存在、命中哪一段 | §3 分支树，先跑 3.0 探针 |
| 5 | 已装版（0.1.50）里 `wvError` 桥能否真的落盘（catch 里 `reportWvError` 是 v25 才加的） | 装机后再看 `grep "webview ERROR" $LOG`；0.1.50 有 bindComposerOnce 但 catch/finally 是否同版需装后实测 |

---

## 6. 自动化 vs 人工（这次能拆到哪一步）

**可自动化（现有脚本，无需人点，不改代码即可跑）**

| 覆盖 | 命令 | 说明 |
|---|---|---|
| 快照映射（含 killed→failed、失联、任务摘要） | `npm run test:subagent`（`scripts/test/subagentSnapshot.test.mts`） | 帧形状→浮窗字段的唯一纯逻辑层 |
| 帧重放（老帧兼容/去重/终态） | `npm run test:replay`（`scripts/test/subagentReplay.test.mjs`） | |
| harness 安装/版本门三分支（首装 / 不覆写 / 升级） | `node scripts/test/subagentSync.test.mjs`（需先 `npm run compile`，读 `out/pi/ensureSubagentHarness.js`） | 可直接验「内置 v26 会不会同步、且不覆写本地修改」 |
| 宿主 panel 装配（mock vscode，含 wvError 路由可达性） | `node scripts/test/panel-load.test.mjs` | 需要先 `npm run compile`；能自动验 `in`/`out` 链路接线 |
| 帧体积/形状事实基线 | `node scripts/probe/probe-frame-slim.mjs [会话文件]` | 只读会话文件 |

**半自动（DevTools 粘一行，人读结果）**：§3.0 探针、§4 的 `$DOCK`、V4 的两条断言、V5 的 `rows=arr(N)` 计数。

**必须人工**：浮窗从图标展开的动画观感、白字冻结/秒表「看起来对不对」、点击行跳转子会话、拖拽/收起、
跨页签来回切的实际体感、`#ver` 是否与安装版本一致。

**当前无法自动化的一块**：`webview/main.ts` 是单 IIFE，内部状态不外露，仓库里**没有** webview DOM shim 测试
（`scripts/test/` 全是宿主侧/纯逻辑层）。要自动化 §3 的分支树，得先补一个 `dist/webview/main.js` + 最小 DOM shim
的沙箱（交接-子agent帧瘦身文档 §四提到的那次沙箱是临时手跑的，未入库）。

---

## 7. 给验收会话的最小执行顺序（建议）

1. 过 §1 前置门（装新 vsix + 重载窗口 + 三处版本复查）——**不过就停**。
2. 开 DevTools，跑 §3.0 探针，记录基线（`views`/`disabled`/`#ver`）。
3. 做 §4 V1 → V2（派一单，看行/秒表/白字冻结）。
4. 做 §4 V3（kill 那一单，量 kill 到终态的秒数，抓 `final=true` 帧原文进报告）。
5. 做 §4 V4（单表 + 无句柄，两行断言）。
6. 做 §4 V5（含**新增反向用例**：关页签后该行是否消失 —— 预期它会消失，但**按代码它不该消失**；
   若真消失，§5 条 3 的判断被推翻，回来更新本报告）。
7. 只有出现「点发送没反应」时，才按 §3 分支树走一遍，并把每步命中的日志原文抄进报告。

---

## 附：本单读过的文件

> `webview/main.ts` 全程读 `git show HEAD:webview/main.ts` 的输出（2654 行），未读也未改工作区文件。

- `git show HEAD:webview/main.ts`（2654 行，只读）
- `src/vscode/panel.ts`（2346 行）、`src/vscode/webview-html.ts`（126 行）
- `src/core/piCore.ts`（prompt 链路 / 子 agent 帧 / dbg）、`src/core/protocol.ts`（wvError 定义 181-186）、`src/core/i18n.ts`
- `src/pi/piClient.ts`（prompt/preflight/ready）、`src/pi/ensureSubagentHarness.ts`
- `src/domain/subagentSnapshot.ts`、`harness/subagent/index.ts`、`harness/subagent/harness.json`
- `webview/index.html`
- `~/.pi/agent/pi-chat-debug.log`（tail + 关键 grep）、`~/.pi/agent/extensions/subagent/*`（已装副本）
- `~/.vscode/extensions/hummerbor.pi-for-vscode-0.1.50/**`（已装产物）、仓内 `pi-for-vscode-0.1.50.vsix`（核对指纹）
