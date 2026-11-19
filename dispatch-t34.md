# dispatch-t34 — 记忆接力一期：压缩后指针注入 + digest 探针

> 派单日 2026-11-19。工单全文见 `DIRECTOR.md`「工单34」。收单即删本文件。

## 一、背景（已由总监取证，不用重查）

- pi 的压缩（`compaction`）**不改 jsonl**：`SessionManager._persist` 是 `appendFileSync`，
  只追加一条 `{type:"compaction", summary, firstKeptEntryId, tokensBefore, details, usage}`；
  上下文变短发生在读取时（`buildContextEntries` 从 `firstKeptEntryId` 起取）。
- 摘要由一次 LLM 调用产出，固定 7 段（Goal / Constraints / Progress / Key Decisions /
  Next Steps / Critical Context），会丢掉「被否决的方案 / 踩过的坑 / 边界禁令」。
- 默认参数 `SETTINGS_DEFAULTS.compaction = {reserveTokens:16384, keepRecentTokens:20000}`。
- **已验证可用**（pi bundle `vendor/pi/dist/bundle/chunks/chunk-44DLKSKE.js`）：
  - `session_before_compact` / `session_compact` 都是公开扩展事件（同 `session_before_fork` 同级）。
  - `session_before_compact` 的入参含 `preparation = { messagesToSummarize, turnPrefixMessages,
    firstKeptEntryId, tokensBefore, previousSummary, fileOps, settings }`
    —— `messagesToSummarize` 正是「即将被丢掉的那批消息」。
  - 扩展 API：`pi.on(event, handler)`；`pi.appendEntry(customType, data)`
    → `appendCustomEntry`（custom 帧，**不进 LLM 上下文**，只落盘 + `entry_appended` 事件）；
  - `pi.sendMessage(message, options)` → `sendCustomMessage`：`{triggerTurn:false}` 且非流式时走
    `_appendCustomMessage` → `appendCustomMessageEntry`（**进上下文**、UI 可见、持久化、
    **不启动新回合**）；流式中会自动入队到 `turn_end` 再落盘，安全。
  - 本机实测：488 个会话 / 4.0GB / **0 条 compaction**，出现的是 `context_edit`
    （pi 的 `_omitRecoveryAttempt` 重试墓碑，与压缩无关）。所以真机验证要**手动触发压缩**。

## 二、范围

1. 新建 `harness/memory/index.ts` + `harness/memory/harness.json`（`{"version":1}`）。
2. `harness/subagent/harness.json` 的 version **不动**（现 27）；`harness/memory` 从 1 起。
3. `src/pi/ensureSubagentHarness.ts` 泛化为多 bundle 同步（建议改 `const BUNDLES = ["subagent","memory"]`
   循环，逐 bundle 独立版本门；`ensureSubagentHarness` 与 `syncSubagentHarness` 的导出名与语义
   **保持不变**，避免动 `extension.ts` 调用点与既有探针）。
4. 钩子一（一期主体）：`pi.on("session_compact", ...)` 注入固定指针。

   文案上限 60 token，不许拼动态内容：
   ```
   上下文已压缩。动手前按需重读：AGENTS.md（铁律与边界）/ PROGRESS.md（当前状态与待办）
   / docs/decisions.md（相关小节）。
   ```
5. 钩子二（探针，不接管）：`pi.on("session_before_compact", ...)` 算 digest，
   **只** `pi.appendEntry("memory-digest", {...})`，绝不 return `{compaction}`。
6. 抽取逻辑放 `harness/memory/digest.ts`（或 `index.ts` 内单独 export 的纯函数），
   **零 pi 依赖**，能被 `node` 直接 import 单测。规则（按不可再生性）：
   - 用户消息：全文；>300 字的取「首 200 + 末 100」加省略号
   - 用户裁决句：user 消息长度 <80 字 且上一条是 assistant → 单独成节
   - 每轮结论行：assistant 纯文本块（忽略 `toolCall`/`thinking`）的最后一段，单条截 200 字
   - 否决清单：assistant 纯文本里含「不采用 / 放弃 / 否决 / 因为不行 / 改成」的句子（单条截 150 字，最多 10 条）
   - **不抽**：toolResult 正文、含「我将要 / 接下来 / 下一步我」的计划句、文件清单（pi 的 `fileOps` 已有）
   - 总量硬上限 **≤4k token**（按 `字符数/3` 粗估即可，超了按上述顺序从尾部截断）

## 三、边界（不许顺手做）

- 不 return `{compaction}`（接管摘要留给二期单）
- 不改 `reserveTokens` / `keepRecentTokens` / 压缩触发时机
- 钩子内：零网络、零 `fs` 写、零 `exec`
- 不动 `webview/**`、`src/core/**`
- 不删不改 `scripts/migrate/slim-subagent-frames.mjs`
- 不碰 `AGENTS.md` / `PROGRESS.md` / `归档.md`（另一单在改，会冲突）
- 不 `git add -A`；提交只用 pathspec 提自己的文件

## 四、验证

1. `npm run compile` 全绿（注意 `tsconfig.json` 只 include `src`，`harness/**` 不进 tsc——所以
   harness 的类型正确性靠 `node --experimental-strip-types` 或 import 单测兜底，别指望 compile 检查它）
2. 新增 `scripts/test-memory-digest.mjs`：从 `~/.pi/agent/sessions/**` 取一个真实 jsonl，
   解析出 `messagesToSummarize` 形状（role + content blocks），喂纯函数，断言：
   - 四节齐全且顺序稳定
   - 估算 token ≤ 4000
   - 输入 0 条消息时返回空结构不抛
   - 含 toolResult 正文的样本**不出现**在输出里
3. 全部既有 `test:*` 跑一遍，基线不降
4. 版本门自查：`node -e` 调 `syncSubagentHarness` 两轮，打印目标目录 version，确认
   `subagent` 仍 27、`memory` 落 1，且第二次调用不覆写
5. 真机（写进回报的待验清单，不催总监）：
   - 手动压缩一次 → 面板出现一条 `memory-pointer` 消息
   - 会话 jsonl 尾部新增 1 条 `custom_message` + 1 条 `custom(memory-digest)`
   - 压缩后下一轮 agent 是否主动读 `PROGRESS.md`

## 五、交接

- 回报写 `.pi/reports/REPORT-t34.md`（不进 git），含：改动文件清单、验收 1-4 的实测输出、
  真机待验清单、遗留债
- commit message 写「为什么」，只提自己文件；commit 后 `git show --stat HEAD` 自检
- 不 push
