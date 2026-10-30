# 交接 · ops-panel 驱动 pi-vscode 契约（v2）

> **替代**旧版《交接-ops-panel-外部会话接入.md》（文件跟随架构已废弃，见 §六）。
> 架构拍板（用户 2026-10-29）：**ops-panel 是 pi-vscode 的扩展**——执行也走 pi-vscode
> 的进程内 pi（唯一写者），不再 spawn `pi -p` 子进程。本契约自包含，可直接带去 ops-panel 开工。

## 一、架构（一句话 + 一张图）

每个 LLM 步 = pi-vscode 的一个**会话**：ops-panel 经命令把 prompt 灌给 pi-vscode 进程内的
pi 运行时；会话天然在列表里、随时点开就是**实时渲染**（工具流/思考流/子 agent 全量，
0 延迟），跑完直接续聊。**单一写者**——双写/锁/跟随的一切复杂度失去存在前提。

```
ops-panel ──runPrompt/abortSession/openSession（命令）──► pi-vscode 进程内 pi 运行时
                                                            │
                                                        会话页签（实时流，随时看/随时聊）
```

## 二、pi-vscode 侧改动（工单33，本仓施工）

> **0. 授权层（所有命令的前置，2026-10-29 用户拍板「只有注册过的插件才能接入」）**：
> VS Code 命令默认谁都能调（executeCommand 不带调用方身份）——控制面**零信任默认**：
> 1. 客户端一次性注册：`piChat.authorizeClient({ extensionId })` → 原生确认框（列明能力：发 prompt/中止/打开会话）→ 同意则入信任表（globalState 持久）并返回 `{ ok:true, clientToken }`（随机令牌，每客户端一杖）；拒绝 → `{ok:false}`。
> 2. 以下全部命令一律携带 `{ clientToken }`，表/令牌不匹配 → `{ ok:false, reason:"unauthorized" }`。
> 3. 逃生门：设置 `piChat.trustedClients: string[]` 预授权（免弹窗）；撤销 = 删条目。
> 4. 安全口径（诚实）：防误用/防未授权调用，不承诺防同宿主恶意代码（VS Code 扩展信任域固有上限）。

1. **`piChat.runPrompt({ name, prompt, timeoutMs? })` → `Promise<{ ok, reason?, error? }>`**
   - 按 `name` 创建或复用会话 → 发 prompt → **agent settle（跑完）时 resolve**；
   - `error`：run 以错误结束时的原因文本；`reason:"timeout"`：`timeoutMs` 到点自动
     abort 并 resolve（不算崩）；`reason:"busy"`：该会话在忙（同名重复提交）时拒收；
   - 会话无头创建（不占页签），列表可见；用户点开（openSession）即挂上实时渲染。
2. **`piChat.abortSession({ name })` → `Promise<{ ok }>`**：停当前 run（abort 语义 =
   取消回合 + 杀工具子进程）。
3. **`piChat.openSession({ file?, name? })` → `{ ok, reason? }`**（已有，保留）：查看详情。
4. **保留件**：`piChat.sessionDir` 透传（列表扫配置目录）、会话目录 watcher（外部新建
   ≤2s 上列表）。
5. **拆除件**（「单一写者后无存在前提」）：外部写者跟随/只读锁/交棒重载机制整段拆除
   （piClient 跟随器、externalWriting 登记表、运行中徽标、externalAppend/externalState
   协议、接管对齐等，随工单33 施工移除）。

## 三、ops-panel 侧改动

1. **llm 步不再 spawn `pi -p`**：改为
   `const r = await vscode.commands.executeCommand("piChat.runPrompt", { name, prompt, timeoutMs, clientToken })`
   ——步骤的完成/失败就看 `r.ok / r.error`（替代子进程退出码）。
   **首次使用先注册**：`piChat.authorizeClient({ extensionId: "local.wechat-ops-panel" })`→ 弹窗同意 → 存好 `clientToken`，之后所有调用携带。
2. **会话命名沿用**：`name = ops-<垂类>-<日期>-<时间戳>`（与原 `--name` 同值，继续做定位键）。
3. **「🔎 查看详情」→ `piChat.openSession({ name })`**（无 run 禁用语义不变）。
4. **停止/超时** → `piChat.abortSession({ name })`（替代 `child.kill`）；`runPrompt` 传
   `timeoutMs` 时超时自动 abort，双保险。**极端挂死兜底**（工具进程收不干净）：
   提示用户打开会话 `/reload`，会话文件审计不受影响。
5. **不再调用** `piChat.externalWriting`（命令已随拆除移除）；**不再自管**
   `--session-dir`（会话一律落 pi 默认库/`piChat.sessionDir`）。
6. **依赖 pi-vscode**（产品定位：ops-panel 是 pi-vscode 的扩展）：未装/旧版 →
   `executeCommand` reject → 提示安装，不崩面板；能力探测用
   `vscode.commands.getCommands()` 或 try/catch，勿硬编码版本号。

## 四、验收场景

| # | 场景 | 通过标准 | 责任方 |
|---|---|---|---|
| A | 垂类点「▶开始」 | runPrompt 跑完 resolve；会话出现在列表 | pi-vscode + ops-panel |
| B | 运行中点「查看详情」 | 打开即实时流（工具流/思考流/子 agent），0 延迟 | pi-vscode |
| C | 跑完在页面发消息 | 直接续聊，天然接管（同一会话同一运行时） | pi-vscode |
| D | 超时/手动停止 | abortSession 生效；runPrompt resolve（timeout/false） | 双方 |
| E | 未装 pi-vscode | ops-panel 提示不崩 | ops-panel |
| F | 多垂类并发跑 | 并行互不干扰（pi 原生多会话） | pi-vscode |
| G | 未注册/令牌错的调用 | `{ok:false, reason:"unauthorized"}`，零副作用 | pi-vscode |

## 五、红线（两边）

- ops-panel 六阶段流水线 UI/流程不变；
- pi-vscode 既有会话页 UI/交互形态不变；
- 会话必须落盘（审计红线，一切路径禁 `--no-session`/ephemeral）。

## 六、契约变更记录

**v1（废弃，2026-10-29）**：文件跟随 + `externalWriting` 信号 + ops-panel spawn 子进程。
废弃原因：**双写者模型复杂度失控**（外部写者判定在「自己写/别人写」边界反复误判——
锁闪烁/渲染双份/性能事故三连），且产品定位定为「ops-panel 是 pi-vscode 的扩展」后，
执行走 pi-vscode 即单一写者，文件跟随失去存在前提。v2 一切从简：三个命令，完事。
