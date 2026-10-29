# 交接 · ops-panel → pi-vscode 外部会话接入

> 给 ops-panel 侧的施工依据。pi-vscode 侧对应工单32（DIRECTOR.md），本文自包含，
> 可直接带到 ops-panel 项目开工。对齐日期 2026-10-29，pi-vscode 调研基线 0.1.49。
> 背景需求原文：《需求-pi-vscode-实时会话查看.md》（ops-panel 侧提出，已逐条核实）。

## 一、两边怎么接 pi（理解这一节就不会用错）

```
~/.pi/agent/sessions/<项目路径编码>/*.jsonl   ← 唯一真值，会话文件
        ↑ 写                        ↑ 读/写
ops-panel spawn 的                pi-vscode 进程内 import 的
`pi -p` 子进程                     pi SDK runtime
```

- **ops-panel**：spawn `pi -p --name ops-<垂类>-<日期>-<时间戳> "<prompt>"`，管子进程
  生命周期（超时/停止/重跑）——选 spawn 是对的，别改。
- **pi-vscode**：不 spawn，pi SDK 直接 import 进扩展宿主进程跑——长驻交互 UI 才这么接。
- **两边互不通信，共享的唯一契约就是会话文件**。所以 ops-panel **不需要**为了「被查看」
  做任何文件层改造：pi-vscode 的会话列表本来就扫同一个库。

需要 ops-panel 做的只有两件事：**调两个命令**（下面第二节）+ **会话落默认库**（第三节）。

## 二、pi-vscode 提供的两个命令（工单32 施工交付）

> ⚠️ 版本前提：这两个命令随 pi-vscode 工单32 发版后可用。调用方一律 try/catch 探测，
> 命令不存在（未装/旧版）走现有提示分支，不崩面板——这是验收场景 E。

### 2.1 `piChat.openSession` — 打开会话到完整会话页

```js
const r = await vscode.commands.executeCommand("piChat.openSession", { file, name });
// r = { ok: true } | { ok: false, reason: "not-found" }
```

- 参数 `{ file?: string, name?: string }`：`file`（jsonl 绝对路径）优先；`name` 兜底
  （按会话名扫定位，就是 ops-panel spawn 时 `--name` 起的那个名）。
- 行为：打开到完整会话页（工具调用流/思考流/正文全量），与会话列表点击同一路径；
  **已打开则 focus 不重复开**；找不到返回 `{ok:false, reason:"not-found"}`。
- 建议 ops-panel 传 `file`（spawn 时就知道会话名，可先按名扫一次库拿到路径）；
  传 `name` 省一步扫描，两者等价。

### 2.2 `piChat.externalWriting` — 外部写者交棒信号

```js
// spawn 之后立刻：
await vscode.commands.executeCommand("piChat.externalWriting", { file, name, writing: true });
// 进程退出/超时被杀/停止/重跑前（即该 step 生命周期结束时）：
await vscode.commands.executeCommand("piChat.externalWriting", { file, name, writing: false });
```

- `writing: true`：pi-vscode 把该会话标记「外部持有」→ 页面进入**只读跟随**：
  实时渲染外部写入 + 页头「运行中」徽标 + 输入被挡（提示「该会话正由外部进程运行中」）。
- `writing: false`：**交棒**——pi-vscode 重载对齐文件、解锁输入，用户可直接在页面
  继续对话（比如「让他改改稿子」）。
- **信号是精确主路径**；漏发也不致命（pi-vscode 有 mtime 静默 N 秒的启发式兜底自动解锁），
  但会慢一拍，且长思考期间可能误判——所以有管家的写者（ops-panel 就是）**必须发**。
- **重跑 = 再来一轮 true/false**（同一会话复用也一样）。

### 2.3 调用方时序（完整一轮 llm 步）

```
1. spawn:  pi -p --name ops-<垂类>-<ts> "<prompt>"
2. 立刻:   executeCommand("piChat.externalWriting", { name, writing: true })
3. （运行中）用户点「🔎 查看详情」→ executeCommand("piChat.openSession", { name })
           → 页面实时跟随外部写入
4. step 结束（正常退出/超时/停止，放 finally 里保证发到）:
           executeCommand("piChat.externalWriting", { name, writing: false })
5. 用户在 pi-vscode 页面发消息 = 正常接管该会话
```

命令不存在的探测（验收 E）：

```js
try {
  await vscode.commands.executeCommand("piChat.openSession", { name });
} catch {
  // pi-vscode 未装或旧版（工单32 前）：走现有提示分支
}
```

## 三、ops-panel 侧配套改动（随本需求一起做）

1. **llm 步去掉自定义 `--session-dir`**，会话落 pi 默认库（此前已验证过、被撤
   commit a2030bc，本需求拍板后恢复）。理由：pi-vscode 列表扫默认库；配了自定义目录
   则列表永远看不到（pi-vscode 侧 P1-2 透传只解决「用户显式配了 piChat.sessionDir」
   的场景，解决不了 ops-panel 私自换库）。
2. **按钮文案**「🔗 在 pi 打开」→「🔎 查看详情」，语义改为：打开该垂类最近一次 run 的
   会话（无 run 时禁用）。
3. spawn 时记下 `--name` 的会话名（已有），供 2.1/2.2 两个命令用。

## 四、验收场景（对齐需求原文 A-E）

| # | 场景 | 通过标准 | 责任方 |
|---|---|---|---|
| A | 外部起 `pi -p --name t1 …`，跑的过程中 openSession 打开 | 页面出现会话，且随外部写入实时增长 | pi-vscode |
| B | 外部活跃写入期间在页面发消息 | 有明确提示、会话文件不损坏 | pi-vscode |
| C | 外部新建会话 | 会话列表 ≤2s 自动出现 | pi-vscode |
| D | 配置 `piChat.sessionDir` 到自定义目录 | 列表能看到该目录里的会话 | pi-vscode |
| E | 未装 pi-vscode 的环境点「查看详情」 | ops-panel 提示不崩 | **ops-panel** |

## 五、红线（两边都适用）

- pi-vscode 不改既有会话页 UI/交互形态，只加命令与跟随能力；
- ops-panel 六阶段流水线 UI 与流程不因本需求变动；
- **接管聊天必须等外部写完**（step 结束发 `writing:false` 后）：外部进程跑着时你发消息
  = 两个写者交错 append 同一 jsonl → 会话树分叉。只读跟随就是为挡这个。
- 前提：pi-vscode 开在**同一个工作区目录**（会话 cwd 决定工具改哪个项目的文件），
  两边都用默认会话库。

## 六、关键事实（pi-vscode 侧三处查留证摘要，供 ops-panel 侧答疑）

- `SessionManager.open` 本身只读不写；但 pi-vscode 打开会话后会跑模型记忆补回
  （setModel 无条件 append 一条 model-change 到会话文件）——所以「打开即双写」成立，
  外部活跃期的只读态连这条写入一起堵（这是 P1-1 升 P0 的依据）。
- pi 本体不 watch 会话文件（dist 全树仅 git head/reftable 的 watchFile）——
  实时跟随是 pi-vscode 壳侧自研，无 pi 原生能力可搬。
- `SessionManager.listAll(sessionDir, …)` 有目录参数重载——pi-vscode 列表透传
  `piChat.sessionDir` 是纯参数透传，不自研扫描。
